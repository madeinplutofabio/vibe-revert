// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The selective-restore transaction: the single composed sequence.
//
//   S + HEAD_S -> stabilize -> E -> validate recovery handle -> open oracle
//     -> evidence -> gate -> first verification -> close oracle
//     -> acquire B -> commands -> acquire C -> classify
//
// Everything cli-commands owns arrives as a callback: creating E, publishing the
// attempt marker, running the project's verification commands. This module owns
// the ORDER and the evidence, nothing else.
//
// NO THROW ESCAPES. Every step is caught and becomes an arm of the result. That
// is not stylistic: after the marker exists the repository may be partly
// mutated, and an exception carries no gate result, no progress and no
// verification, which is exactly the evidence a receipt needs. Pre-marker steps
// are caught for symmetry, so a caller never has to handle two failure channels.
// The rule includes the pure predicates evaluated after the oracle closes: a
// throw there would discard a completed mutation's entire record.
//
// NOT exported from `./index.ts` yet; the boundary slice decides that.

import { withCheckpointOracle } from "./checkpoint-oracle.js";
import { getHeadSha } from "./git-cli.js";
import {
  acquireIntegrityObservation,
  type ObservationResolution,
} from "./integrity-observation.js";
import { findMissingEvidence, type OracleEvidenceVerdict } from "./oracle-evidence.js";
import {
  type PlanStabilizationResult,
  stabilizeSelectiveRestorePlan,
} from "./plan-stabilization.js";
import {
  classifyPostCommandIntegrity,
  type PostCommandIntegrity,
} from "./post-command-integrity.js";
import {
  everyCandidateSettled,
  type PostTransplantVerificationResult,
  postTransplantStateConsistent,
  verifyPostTransplantState,
} from "./post-transplant-verification.js";
import {
  captureProtectedDomain,
  type ProtectedDomainCaptureOptions,
  type ProtectedDomainSnapshot,
} from "./protected-domain.js";
import { type RecoveryHandleValidationResult, validateRecoveryHandle } from "./recovery-handle.js";
import type { SelectiveRestorePlan } from "./restore-selective.js";
import {
  type AttemptPublicationBinding,
  type PublishedAttemptEvidence,
  runSelectiveTransplantGate,
  type SelectiveTransplantGateResult,
} from "./selective-transplant-gate.js";

const TEMP_DIR_PREFIX = "viberevert-selective-restore-";

// =============================================================================
// Facts, each derived from the module that owns it
// =============================================================================

export type PlanPreconditionChanged = Extract<
  PlanStabilizationResult,
  { outcome: "precondition_changed" }
>;
export type RecoveryHandleMismatch = Extract<
  RecoveryHandleValidationResult,
  { outcome: "mismatch" }
>;
export type MissingEvidence = Extract<OracleEvidenceVerdict, { outcome: "missing_evidence" }>;
export type GateFencePreconditionChanged = Extract<
  SelectiveTransplantGateResult,
  { outcome: "precondition_changed" }
>;
export type CompletedMutation = Extract<
  SelectiveTransplantGateResult,
  { outcome: "mutation_completed" }
>;
export type FailedMutation = Extract<SelectiveTransplantGateResult, { outcome: "mutation_failed" }>;
export type PostMarkerGateResult = CompletedMutation | FailedMutation;
export type TornObservation = Extract<ObservationResolution, { outcome: "torn" }>;

/** Whether an attempt marker exists. `possibly_published` is never a guess to refine. */
export type MarkerState =
  | { readonly status: "not_published" }
  | { readonly status: "possibly_published" }
  | { readonly status: "published"; readonly gate: PostMarkerGateResult };

/**
 * Phases whose failure carries no cleanup warnings.
 *
 * Named for warning AVAILABILITY rather than for oracle existence, because
 * `validate_recovery_handle` does open an oracle. When it throws, its structured
 * result never returns, so its warnings are unreachable.
 */
export type FailureWithoutCleanupWarningsPhase =
  | "capture_expected_state"
  | "stabilize_plan"
  | "create_recovery_checkpoint"
  | "validate_recovery_handle";

/** Phases whose failure has an oracle's warnings in hand. */
export type FailureWithCleanupWarningsPhase =
  | "open_oracle"
  | "oracle_evidence"
  | "gate"
  | "oracle_callback";

// =============================================================================
// The command phase
// =============================================================================

export type CommandExecution<TCommandResult> =
  | { readonly outcome: "not_configured" }
  | { readonly outcome: "skipped"; readonly reason: "transplant_failed" | "transplant_not_clean" }
  | { readonly outcome: "completed"; readonly result: TCommandResult }
  | { readonly outcome: "failed"; readonly cause: unknown };

export type RanCommandExecution<T> = Extract<
  CommandExecution<T>,
  { outcome: "completed" | "failed" }
>;

export type EvaluatedIntegrity =
  | PostCommandIntegrity
  /** The post-command observation could not be taken. */
  | { readonly outcome: "observation_failed"; readonly cause: unknown }
  /** Both observations exist; comparing them threw. */
  | { readonly outcome: "classification_failed"; readonly cause: unknown };

export type NotConfiguredCommandPhase = {
  readonly execution: { readonly outcome: "not_configured" };
  readonly integrity: { readonly outcome: "not_run" };
};
export type SkippedTransplantFailed = {
  readonly execution: { readonly outcome: "skipped"; readonly reason: "transplant_failed" };
  readonly integrity: { readonly outcome: "not_run" };
};
export type SkippedNotClean = {
  readonly execution: { readonly outcome: "skipped"; readonly reason: "transplant_not_clean" };
  readonly integrity: { readonly outcome: "not_run" };
};

export type FailedMutationCommandPhase = NotConfiguredCommandPhase | SkippedTransplantFailed;

export type CompletedMutationCommandPhase<T> =
  | NotConfiguredCommandPhase
  | SkippedNotClean
  | { readonly execution: RanCommandExecution<T>; readonly integrity: EvaluatedIntegrity };

// =============================================================================
// The result
// =============================================================================

export type SelectiveRestoreTransactionResult<TCommandResult> =
  | {
      readonly outcome: "failed";
      readonly phase: FailureWithoutCleanupWarningsPhase;
      readonly cause: unknown;
    }
  | {
      readonly outcome: "failed";
      readonly phase: FailureWithCleanupWarningsPhase;
      readonly marker: MarkerState;
      readonly cause: unknown;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "precondition_changed";
      readonly source: "stabilization";
      readonly differences: PlanPreconditionChanged["differences"];
    }
  /** The mismatch owns its own cleanup warnings; nothing is duplicated here. */
  | { readonly outcome: "recovery_handle_mismatch"; readonly mismatch: RecoveryHandleMismatch }
  | {
      readonly outcome: "missing_evidence";
      readonly evidence: MissingEvidence;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "precondition_changed";
      readonly source: "final_fence";
      readonly fence: GateFencePreconditionChanged;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "verification_failed";
      readonly gate: PostMarkerGateResult;
      readonly cause: unknown;
      readonly cleanupWarnings: readonly string[];
    }
  /**
   * The mutation completed and was verified, and then evaluating that
   * verification threw. Carries both, so the record survives a defect in the
   * predicates themselves.
   */
  | {
      readonly outcome: "post_marker_failed";
      readonly gate: CompletedMutation;
      readonly verification: PostTransplantVerificationResult;
      readonly cause: unknown;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "observation_failed";
      readonly side: "before_commands";
      readonly gate: CompletedMutation;
      readonly verification: PostTransplantVerificationResult;
      readonly cause: unknown;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "observation_torn";
      readonly side: "before_commands";
      readonly gate: CompletedMutation;
      readonly verification: PostTransplantVerificationResult;
      readonly torn: TornObservation;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "observation_torn";
      readonly side: "after_commands";
      readonly gate: CompletedMutation;
      readonly verification: PostTransplantVerificationResult;
      readonly execution: RanCommandExecution<TCommandResult>;
      readonly torn: TornObservation;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "settled";
      readonly gate: FailedMutation;
      readonly verification: PostTransplantVerificationResult;
      readonly commandPhase: FailedMutationCommandPhase;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "settled";
      readonly gate: CompletedMutation;
      readonly verification: PostTransplantVerificationResult;
      readonly commandPhase: CompletedMutationCommandPhase<TCommandResult>;
      readonly cleanupWarnings: readonly string[];
    };

export interface SelectiveRestoreTransactionOptions<TCommandResult> {
  readonly repoRoot: string;
  readonly plan: SelectiveRestorePlan;
  /** SESSION-START patterns, never live config. */
  readonly rollbackExcludePatterns: readonly string[];
  /** The checkpoint the restore reads FROM. Materialized as the main oracle. */
  readonly sessionCheckpointDir: string;
  readonly sessionId: string;
  readonly contributionSha256: string;
  /** Creates E, the emergency checkpoint that becomes the recovery handle. */
  readonly createRecoveryCheckpoint: () => Promise<{
    readonly checkpointId: string;
    readonly checkpointDir: string;
  }>;
  readonly publishAttempt: (
    binding: AttemptPublicationBinding,
  ) => Promise<PublishedAttemptEvidence>;
  /** Absent means no verification commands are configured. */
  readonly runVerificationCommands?: () => Promise<TCommandResult>;
}

// =============================================================================
// Inside the oracle
// =============================================================================

/**
 * What the oracle callback reports. It NEVER throws: `withCheckpointOracle`
 * assembles cleanup warnings only after cleanup finishes, so a value that
 * escaped as an exception could not carry them.
 */
type OracleOutcome =
  | { readonly kind: "missing_evidence"; readonly evidence: MissingEvidence }
  | { readonly kind: "fence_changed"; readonly fence: GateFencePreconditionChanged }
  | {
      readonly kind: "failed";
      readonly phase: FailureWithCleanupWarningsPhase;
      readonly marker: MarkerState;
      readonly cause: unknown;
    }
  | {
      readonly kind: "verified";
      readonly gate: PostMarkerGateResult;
      readonly verification: PostTransplantVerificationResult;
    }
  | {
      readonly kind: "verification_failed";
      readonly gate: PostMarkerGateResult;
      readonly cause: unknown;
    };

const NOT_CONFIGURED: NotConfiguredCommandPhase = {
  execution: { outcome: "not_configured" },
  integrity: { outcome: "not_run" },
};

/**
 * The transplant is clean enough to run the project's own commands against.
 *
 * BOTH predicates: consistency says the observation does not contradict the
 * evidence, settledness says every candidate actually reached a verified state.
 * Running commands on an unsettled transplant would measure a repository the
 * transaction cannot describe.
 */
function transplantIsClean(verification: PostTransplantVerificationResult): boolean {
  return postTransplantStateConsistent(verification) && everyCandidateSettled(verification);
}

export async function runSelectiveRestoreTransaction<TCommandResult>(
  opts: SelectiveRestoreTransactionOptions<TCommandResult>,
): Promise<SelectiveRestoreTransactionResult<TCommandResult>> {
  const { repoRoot, plan, rollbackExcludePatterns } = opts;
  // ONE options object, reused for `S` and for both integrity acquisitions, so
  // every comparison in this transaction measures the same domain by
  // construction rather than by convention.
  const captureOptions: ProtectedDomainCaptureOptions = {
    repoRoot,
    plan,
    rollbackExcludePatterns,
  };

  let frozenSnapshot: ProtectedDomainSnapshot;
  let expectedHeadSha: string;
  try {
    frozenSnapshot = await captureProtectedDomain(captureOptions);
    expectedHeadSha = await getHeadSha(repoRoot);
  } catch (cause) {
    return { outcome: "failed", phase: "capture_expected_state", cause };
  }

  let stabilization: PlanStabilizationResult;
  try {
    stabilization = stabilizeSelectiveRestorePlan(plan, frozenSnapshot);
  } catch (cause) {
    return { outcome: "failed", phase: "stabilize_plan", cause };
  }
  if (stabilization.outcome === "precondition_changed") {
    return {
      outcome: "precondition_changed",
      source: "stabilization",
      differences: stabilization.differences,
    };
  }

  let recovery: { readonly checkpointId: string; readonly checkpointDir: string };
  try {
    recovery = await opts.createRecoveryCheckpoint();
  } catch (cause) {
    return { outcome: "failed", phase: "create_recovery_checkpoint", cause };
  }

  let validation: RecoveryHandleValidationResult;
  try {
    validation = await validateRecoveryHandle({
      repoRoot,
      checkpointDir: recovery.checkpointDir,
      plan,
      rollbackExcludePatterns,
      protectedStates: frozenSnapshot.states,
      expectedHeadSha,
    });
  } catch (cause) {
    // Its structured result never returned, so its warnings are unavailable.
    return { outcome: "failed", phase: "validate_recovery_handle", cause };
  }
  if (validation.outcome === "mismatch") {
    return { outcome: "recovery_handle_mismatch", mismatch: validation };
  }
  const handleWarnings = validation.cleanupWarnings;

  // The main oracle materializes the SESSION-START checkpoint, the state being
  // restored FROM. E is only the recovery handle and is never read here.
  let oracleValue: OracleOutcome;
  let oracleWarnings: readonly string[];
  try {
    const oracle = await withCheckpointOracle<OracleOutcome>(repoRoot, opts.sessionCheckpointDir, {
      tempDirPrefix: TEMP_DIR_PREFIX,
      run: async ({ worktreePath }): Promise<OracleOutcome> => {
        // Tracked as the callback progresses, so the backstop can state the
        // marker's status instead of assuming one.
        let marker: MarkerState = { status: "not_published" };
        try {
          let verdict: OracleEvidenceVerdict;
          try {
            verdict = await findMissingEvidence(worktreePath, plan);
          } catch (cause) {
            return { kind: "failed", phase: "oracle_evidence", marker, cause };
          }
          if (verdict.outcome === "missing_evidence") {
            return { kind: "missing_evidence", evidence: verdict };
          }

          let gate: SelectiveTransplantGateResult;
          // Publication may persist before a throw, and nothing distinguishes
          // that from a throw before it. Conservative by construction.
          marker = { status: "possibly_published" };
          try {
            gate = await runSelectiveTransplantGate({
              repoRoot,
              oracleWorktree: worktreePath,
              plan,
              rollbackExcludePatterns,
              frozenSnapshot,
              expectedHeadSha,
              sessionId: opts.sessionId,
              contributionSha256: opts.contributionSha256,
              preRollbackCheckpointId: recovery.checkpointId,
              publishAttempt: opts.publishAttempt,
            });
          } catch (cause) {
            return { kind: "failed", phase: "gate", marker, cause };
          }
          if (gate.outcome === "precondition_changed") {
            // The fence refused BEFORE publishing.
            return { kind: "fence_changed", fence: gate };
          }
          marker = { status: "published", gate };

          try {
            const verification = await verifyPostTransplantState({
              repoRoot,
              oracleWorktree: worktreePath,
              plan,
              progress: gate.progress,
              frozenSnapshot,
              expectedHeadSha,
            });
            return { kind: "verified", gate, verification };
          } catch (cause) {
            return { kind: "verification_failed", gate, cause };
          }
        } catch (cause) {
          return { kind: "failed", phase: "oracle_callback", marker, cause };
        }
      },
    });
    oracleValue = oracle.value;
    oracleWarnings = oracle.cleanupWarnings;
  } catch (cause) {
    return {
      outcome: "failed",
      phase: "open_oracle",
      marker: { status: "not_published" },
      cause,
      cleanupWarnings: handleWarnings,
    };
  }

  const cleanupWarnings = [...handleWarnings, ...oracleWarnings];

  switch (oracleValue.kind) {
    case "missing_evidence":
      return { outcome: "missing_evidence", evidence: oracleValue.evidence, cleanupWarnings };
    case "fence_changed":
      return {
        outcome: "precondition_changed",
        source: "final_fence",
        fence: oracleValue.fence,
        cleanupWarnings,
      };
    case "failed":
      return {
        outcome: "failed",
        phase: oracleValue.phase,
        marker: oracleValue.marker,
        cause: oracleValue.cause,
        cleanupWarnings,
      };
    case "verification_failed":
      return {
        outcome: "verification_failed",
        gate: oracleValue.gate,
        cause: oracleValue.cause,
        cleanupWarnings,
      };
    default:
      break;
  }

  const { gate, verification } = oracleValue;
  const commandsConfigured = opts.runVerificationCommands !== undefined;

  if (gate.outcome === "mutation_failed") {
    return {
      outcome: "settled",
      gate,
      verification,
      commandPhase: commandsConfigured
        ? {
            execution: { outcome: "skipped", reason: "transplant_failed" },
            integrity: { outcome: "not_run" },
          }
        : NOT_CONFIGURED,
      cleanupWarnings,
    };
  }

  let clean: boolean;
  try {
    clean = transplantIsClean(verification);
  } catch (cause) {
    return { outcome: "post_marker_failed", gate, verification, cause, cleanupWarnings };
  }
  if (!clean) {
    return {
      outcome: "settled",
      gate,
      verification,
      commandPhase: commandsConfigured
        ? {
            execution: { outcome: "skipped", reason: "transplant_not_clean" },
            integrity: { outcome: "not_run" },
          }
        : NOT_CONFIGURED,
      cleanupWarnings,
    };
  }

  const runCommands = opts.runVerificationCommands;
  if (runCommands === undefined) {
    return {
      outcome: "settled",
      gate,
      verification,
      commandPhase: NOT_CONFIGURED,
      cleanupWarnings,
    };
  }

  let before: ObservationResolution;
  try {
    before = await acquireIntegrityObservation(captureOptions);
  } catch (cause) {
    return {
      outcome: "observation_failed",
      side: "before_commands",
      gate,
      verification,
      cause,
      cleanupWarnings,
    };
  }
  if (before.outcome === "torn") {
    return {
      outcome: "observation_torn",
      side: "before_commands",
      gate,
      verification,
      torn: before,
      cleanupWarnings,
    };
  }

  // A thrown command is DATA, not a failure of the transaction: the commands are
  // the project's, and their failure is a result the receipt reports.
  let execution: RanCommandExecution<TCommandResult>;
  try {
    execution = { outcome: "completed", result: await runCommands() };
  } catch (cause) {
    execution = { outcome: "failed", cause };
  }

  // C is acquired whether the commands succeeded or threw. What they did to the
  // repository is the question; whether they exited zero is a different one.
  let after: ObservationResolution;
  try {
    after = await acquireIntegrityObservation(captureOptions);
  } catch (cause) {
    return {
      outcome: "settled",
      gate,
      verification,
      commandPhase: { execution, integrity: { outcome: "observation_failed", cause } },
      cleanupWarnings,
    };
  }
  if (after.outcome === "torn") {
    return {
      outcome: "observation_torn",
      side: "after_commands",
      gate,
      verification,
      execution,
      torn: after,
      cleanupWarnings,
    };
  }

  let integrity: EvaluatedIntegrity;
  try {
    integrity = classifyPostCommandIntegrity(before.observation, after.observation);
  } catch (cause) {
    // Both observations were coherent; only the comparison failed. Recording it
    // here keeps `execution` and the whole post-marker record intact.
    integrity = { outcome: "classification_failed", cause };
  }

  return {
    outcome: "settled",
    gate,
    verification,
    commandPhase: { execution, integrity },
    cleanupWarnings,
  };
}
