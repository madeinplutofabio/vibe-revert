// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The selective rollback receipt mapper.
//
// PURE, and it NEVER THROWS: it returns `mapped` or `failed`. The contract is
// enforced by a wrapper, not by inspection, because `safeParse` covers only the
// final validation and says nothing about the translators, the normalizers, or
// a future refinement that reaches into a getter.
//
// =============================================================================
// Where each field comes from
// =============================================================================
//
// BINDING fields come only from the published attempt: rollback_id, session_id,
// contribution_sha256, pre_rollback_checkpoint_id, and the selection. The
// attempt is what AUTHORIZED the mutation, so a receipt describing a different
// selection would not describe the operation that ran.
//
// `checkpoint_id` is the one identity the attempt does not carry: it names the
// session checkpoint restored FROM, while the attempt carries the emergency
// checkpoint E. `written_at` is a clock value; the attempt's own `written_at`
// means "when the attempt began", a different fact.
//
// Per-path results come from the post-transplant verification, never from
// obligation progress: `post-transplant-verification.ts` states that rule at
// its `VerifiedCandidate` declaration, and its outcome vocabulary already
// matches the receipt's.
//
// Three inputs are cross-checked rather than trusted, because each is a way for
// two sources to disagree: the plan's change groups against the attempt's
// authorized selection, the recovery handle against the attempt's
// `pre_rollback_checkpoint_id`, and `commandsConfigured` against any execution
// record actually present.
//
// =============================================================================
// Exhaustiveness
// =============================================================================
//
// Every union this module reads closes with a `never` binding: the finalization
// source, command results, command execution, evaluated integrity, violation
// kinds, the torn-observation side, and the transaction outcome. A new member
// upstream is a COMPILE error here rather than a receipt that quietly omits it,
// and no union is dispatched with a ternary whose fallback would absorb one.

import type { SelectiveRestorePlan, SelectiveRestoreTransactionResult } from "@viberevert/git";
import {
  type ApplyPathResult,
  type FirstVerification,
  firstVerificationCompletedCleanly,
  type IntegrityAssessment,
  normalizePathArray,
  type ProjectVerification,
  projectVerificationPassed,
  type PostCommandIntegrity as ReceiptPostCommandIntegrity,
  type VerifyCommandResult as ReceiptVerifyCommandResult,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
  type SelectiveRollbackReceipt,
  SelectiveRollbackReceiptSchema,
  summarizeFailure,
  type VerifyCommandRecord,
} from "@viberevert/session-format";
import type {
  CreatedRecovery,
  DirectReceiptSource,
  ReceiptFinalizationSource,
} from "./selective-apply-result.js";
import { pairKey, sameStringSet } from "./selective-pair-key.js";
import type {
  VerifyCommandResult,
  VerifyCommandRun,
  VerifyCommandsResult,
} from "./verify-commands.js";

type Tx = SelectiveRestoreTransactionResult<VerifyCommandsResult>;
type Settled = Extract<Tx, { readonly outcome: "settled" }>;
type Verification = Settled["verification"];
type ViolationKind = Verification["violations"][number]["kind"];
type CommandPhase = Settled["commandPhase"];
type CommandExecution = CommandPhase["execution"];
type CommandIntegrity = CommandPhase["integrity"];
type EvaluatedGitIntegrity = Extract<
  CommandIntegrity,
  { readonly outcome: "clean" | "basis_changed" | "project_mutated" }
>;
type TornTransaction = Extract<Tx, { readonly outcome: "observation_torn" }>;
type Torn = TornTransaction["torn"];

export type ReceiptMapping =
  | { readonly outcome: "mapped"; readonly receipt: SelectiveRollbackReceipt }
  | { readonly outcome: "failed"; readonly cause: unknown };

export interface MapSelectiveReceiptArgs {
  readonly source: ReceiptFinalizationSource<VerifyCommandsResult>;
  /**
   * The plan whose classifications enumerate the selected paths.
   *
   * Needed because an inspected publication has no gate and therefore no path
   * list anywhere in its evidence, while the receipt still owes one result per
   * selected path.
   */
  readonly plan: SelectiveRestorePlan;
  /** E, cross-checked against the attempt's `pre_rollback_checkpoint_id`. */
  readonly recovery: CreatedRecovery;
  /** The session checkpoint restored FROM. Not carried by the attempt. */
  readonly checkpointId: string;
  readonly writtenAt: string;
  /**
   * Whether the session-start snapshot configured any verification command.
   *
   * The transaction result does not record this on arms that stopped before the
   * command phase, yet `not_configured` and `skipped` are different claims.
   */
  readonly commandsConfigured: boolean;
}

class ReceiptMappingError extends Error {
  override readonly name = "ReceiptMappingError";
}

// ---- Small pure helpers -----------------------------------------------------

/** Ordinal, not locale: receipt ordering must not depend on the host's locale. */
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byPathThenGroup = (a: ApplyPathResult, b: ApplyPathResult): number =>
  ordinal(a.path, b.path) || ordinal(a.change_group_id, b.change_group_id);

// ---- Command results --------------------------------------------------------

/** camelCase runner surface to the receipt's snake_case one. */
function mapVerifyCommandResult(result: VerifyCommandResult): ReceiptVerifyCommandResult {
  switch (result.outcome) {
    case "exited":
      return { outcome: "exited", exit_code: result.exitCode };
    case "signalled":
      return { outcome: "signalled", signal: result.signal };
    case "unresolved":
      return { outcome: "unresolved" };
    case "unsupported_target":
      return {
        outcome: "unsupported_target",
        resolved_target: result.resolvedTarget,
        kind: result.kind,
      };
    case "not_run":
      return { outcome: "not_run", reason: result.reason };
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

const mapCommandRecord = (run: VerifyCommandRun): VerifyCommandRecord => ({
  command: run.command.command,
  args: [...run.command.args],
  result: mapVerifyCommandResult(run.result),
});

function mapProjectVerification(execution: CommandExecution): ProjectVerification {
  switch (execution.outcome) {
    case "not_configured":
      return { state: "not_configured" };
    case "skipped":
      return { state: "skipped", reason: execution.reason };
    case "completed":
      return { state: "completed", commands: execution.result.runs.map(mapCommandRecord) };
    case "failed":
      // The RUNNER faulted. A command reporting failure is an ordinary
      // `completed` record carrying a non-zero exit.
      return { state: "runner_failed", failure: summarizeFailure(execution.cause) };
    default: {
      const unhandled: never = execution;
      return unhandled;
    }
  }
}

/** Only the three states the git classifier produces; the caller owns the rest. */
function mapEvaluatedIntegrity(integrity: EvaluatedGitIntegrity): ReceiptPostCommandIntegrity {
  switch (integrity.outcome) {
    case "clean":
      return { state: "clean" };
    case "basis_changed":
      // No domain claim: a comparison across a moved basis is uninterpretable.
      return { state: "basis_changed" };
    case "project_mutated":
      return {
        state: "project_mutated",
        added_paths: normalizePathArray(integrity.differences.addedPaths),
        removed_paths: normalizePathArray(integrity.differences.removedPaths),
        changed_paths: normalizePathArray(integrity.differences.changedPaths),
        topology_changed_roots: normalizePathArray(
          integrity.differences.topologyWatchDifferences.map((d) => d.path),
        ),
        head_moved: integrity.headMoved,
      };
    default: {
      const unhandled: never = integrity;
      return unhandled;
    }
  }
}

const mapTorn = (
  torn: Torn,
  side: "before_commands" | "after_commands",
): ReceiptPostCommandIntegrity => ({
  state: "observation_torn",
  side,
  basis_moved: torn.basisMoved,
  head_moved: torn.headMoved,
  domain_status: torn.domainStatus,
});

// ---- Verification projection ------------------------------------------------

/**
 * Which side of the selection a violation belongs to.
 *
 * Exhaustive over the kind, and PATH-SCOPED for the three damage kinds, because
 * kind alone does not decide the side. Pass 1 raises `unattributed_change` for
 * a SELECTED `already_at_before` candidate that moved after `S` was frozen, so
 * filing that kind as unselected would put a selected path in the wrong list.
 *
 * Nothing may fall through silently. A violation that makes
 * `postTransplantStateConsistent` false while appearing in neither the candidate
 * results nor `unselected_violations` would leave a receipt saying "failed" with
 * no visible reason.
 */
function violationScope(
  kind: ViolationKind,
  path: string,
  planPaths: ReadonlySet<string>,
): "selected" | "unselected" | "head" {
  switch (kind) {
    case "head_moved":
      return "head";
    /** By definition about a selected candidate. */
    case "candidate_not_restored":
      return "selected";
    /** By definition about a NON-candidate operation, i.e. a synthetic parent. */
    case "planned_effect_not_verified":
      return "unselected";
    case "unattributed_change":
    case "unauthorized_topology_change":
    case "inconsistent_evidence":
      return planPaths.has(path) ? "selected" : "unselected";
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** Every selected path reached a terminal, non-failing outcome. */
const allSettled = (results: readonly ApplyPathResult[]): boolean =>
  results.every((r) => r.outcome === "restored" || r.outcome === "already_at_before");

interface ScopedViolations {
  readonly unselectedPaths: readonly string[];
  readonly headMoved: boolean;
  /** Any violation at all: the observed state contradicts the evidence. */
  readonly anyViolation: boolean;
}

/**
 * ONE exhaustive pass over the violations, producing every fact drawn from them.
 *
 * `anyViolation` is derived HERE rather than by importing the verifier's
 * `postTransplantStateConsistent`. `post-transplant-verification` is one of the
 * twelve modules the git package's sole-entry-point invariant keeps internal,
 * and the transaction result already hands this layer the violations. Deriving
 * a fact from evidence it was given is not reinterpreting git's state.
 */
function scopeViolations(
  verification: Verification,
  planPaths: ReadonlySet<string>,
): ScopedViolations {
  const unselectedPaths: string[] = [];
  let headMoved = false;
  let count = 0;
  for (const violation of verification.violations) {
    count += 1;
    switch (violationScope(violation.kind, violation.path, planPaths)) {
      case "unselected":
        unselectedPaths.push(violation.path);
        break;
      case "head":
        headMoved = true;
        break;
      case "selected":
        // Reaches the receipt through the candidate's own outcome and through
        // `selected_verified`.
        break;
    }
  }
  return { unselectedPaths, headMoved, anyViolation: count > 0 };
}

/**
 * `selected_verified` comes from the RESULTS this receipt carries, not from the
 * candidates behind them.
 *
 * The projection is 1:1 and outcome-preserving, so the two agree by
 * construction; taking it from the results means the field can never contradict
 * the list printed beside it in the same artifact.
 */
const assessmentFrom = (
  verification: Verification,
  results: readonly ApplyPathResult[],
  scoped: ScopedViolations,
): IntegrityAssessment => ({
  selected_verified: allSettled(results),
  unselected_checked_count: verification.unselectedCheckedCount,
  unselected_violations: normalizePathArray(scoped.unselectedPaths),
  head_unchanged: !scoped.headMoved,
});

// ---- Parts ------------------------------------------------------------------

interface ReceiptParts {
  readonly results: readonly ApplyPathResult[];
  readonly firstVerification: FirstVerification;
  readonly projectVerification: ProjectVerification;
  readonly postCommandIntegrity: ReceiptPostCommandIntegrity;
  /**
   * Whether the observed state contradicted the evidence. Carried on the parts
   * because it is derived from the verification during mapping, and the success
   * decision must not go back to the transaction to re-derive it.
   */
  readonly stateConsistent: boolean;
}

type PartsResult =
  | { readonly ok: true; readonly parts: ReceiptParts }
  | { readonly ok: false; readonly message: string };

const bad = (message: string): PartsResult => ({ ok: false, message });

/** One `indeterminate` result per selected path. */
const indeterminateResults = (plan: SelectiveRestorePlan): readonly ApplyPathResult[] =>
  plan.classifications
    .map(
      (c): ApplyPathResult => ({
        path: c.path,
        change_group_id: c.changeGroupId,
        outcome: "indeterminate",
      }),
    )
    .sort(byPathThenGroup);

/**
 * Project candidates 1:1, but only after EXACT pair-set equality with the plan.
 *
 * The receipt schema checks group coverage and duplicate paths. Neither catches
 * a path missing from, or substituted within, the same change group, which is
 * precisely the shape a projection bug would take.
 */
function projectedResults(
  verification: Verification,
  planPairs: ReadonlySet<string>,
): readonly ApplyPathResult[] | { readonly message: string } {
  const observed = new Set<string>();
  const results: ApplyPathResult[] = [];
  for (const candidate of verification.candidates) {
    const key = pairKey(candidate.path, candidate.changeGroupId);
    if (observed.has(key)) {
      return { message: `the verification reported ${candidate.path} more than once` };
    }
    observed.add(key);
    results.push({
      path: candidate.path,
      change_group_id: candidate.changeGroupId,
      outcome: candidate.outcome,
    });
  }
  if (!sameStringSet(observed, planPairs)) {
    return {
      message:
        "the verification's (path, change group) pairs differ from the plan's classifications",
    };
  }
  return results.sort(byPathThenGroup);
}

/** `not_configured` iff no command was configured. */
const executionAgrees = (execution: CommandExecution, configured: boolean): boolean =>
  (execution.outcome === "not_configured") === !configured;

interface CommandStages {
  readonly projectVerification: ProjectVerification;
  readonly postCommandIntegrity: ReceiptPostCommandIntegrity;
}

/** The command phase as recorded when an EARLIER stage stopped it. */
function stageStopped(
  configured: boolean,
  reason: "first_verification_failed" | "gate_result_unavailable",
): CommandStages {
  return configured
    ? {
        projectVerification: { state: "skipped", reason },
        postCommandIntegrity: { state: "not_run", reason },
      }
    : {
        projectVerification: { state: "not_configured" },
        postCommandIntegrity: { state: "not_run", reason: "commands_not_configured" },
      };
}

function mapCommandPhase(
  phase: CommandPhase,
  configured: boolean,
): CommandStages | { readonly message: string } {
  if (!executionAgrees(phase.execution, configured)) {
    return {
      message: "the command execution record disagrees with whether commands were configured",
    };
  }
  const projectVerification = mapProjectVerification(phase.execution);
  const integrity = phase.integrity;
  switch (integrity.outcome) {
    case "not_run": {
      const execution = phase.execution;
      if (execution.outcome === "not_configured") {
        return {
          projectVerification,
          postCommandIntegrity: { state: "not_run", reason: "commands_not_configured" },
        };
      }
      if (execution.outcome === "skipped") {
        return {
          projectVerification,
          postCommandIntegrity: { state: "not_run", reason: execution.reason },
        };
      }
      return { message: "integrity reports not_run although the commands were reached" };
    }
    case "observation_failed":
      // Within the command phase the only observation that can fail is the one
      // taken AFTER the commands: an unusable pre-command observation stops the
      // phase earlier, on its own transaction arm.
      return {
        projectVerification,
        postCommandIntegrity: {
          state: "observation_failed",
          side: "after_commands",
          failure: summarizeFailure(integrity.cause),
        },
      };
    case "classification_failed":
      return {
        projectVerification,
        postCommandIntegrity: {
          state: "classification_failed",
          failure: summarizeFailure(integrity.cause),
        },
      };
    default:
      return { projectVerification, postCommandIntegrity: mapEvaluatedIntegrity(integrity) };
  }
}

// ---- The exhaustive transaction switch --------------------------------------

/**
 * `DirectReceiptSource`, not the whole transaction union.
 *
 * The narrower type is what makes the exhaustiveness check meaningful: the
 * outcomes that cannot reach finalization (`precondition_changed`,
 * `recovery_handle_mismatch`, `missing_evidence`) are excluded by the type
 * rather than by a branch that would have to guess what to do with them.
 */
function describeFromTransaction(
  transaction: DirectReceiptSource<VerifyCommandsResult>,
  plan: SelectiveRestorePlan,
  planPaths: ReadonlySet<string>,
  planPairs: ReadonlySet<string>,
  commandsConfigured: boolean,
): PartsResult {
  const withVerification = (verification: Verification, stages: CommandStages): PartsResult => {
    const results = projectedResults(verification, planPairs);
    if ("message" in results) return bad(results.message);
    const scoped = scopeViolations(verification, planPaths);
    return {
      ok: true,
      parts: {
        results,
        firstVerification: {
          state: "completed",
          assessment: assessmentFrom(verification, results, scoped),
        },
        stateConsistent: !scoped.anyViolation,
        ...stages,
      },
    };
  };

  /** No per-path facts exist; the first verification did not complete. */
  const withoutFacts = (
    firstVerification: FirstVerification,
    stages: CommandStages,
  ): PartsResult => ({
    ok: true,
    parts: {
      results: indeterminateResults(plan),
      firstVerification,
      // No completed verification, so no consistency claim is available. False
      // is the honest value: it asserts nothing was proven, not that something
      // was found wrong.
      stateConsistent: false,
      ...stages,
    },
  });

  switch (transaction.outcome) {
    case "failed":
      // A marker-bearing failure reporting `published`. The type permits it and
      // the implementation cannot produce it; see the note in
      // `selective-apply-result.ts`. It has a gate but no verification, and no
      // honest `first_verification` value describes that, so refuse rather than
      // mint one.
      return bad(
        "a published-marker failure carries a gate result with no verification, which no receipt state describes",
      );

    case "verification_failed":
      // The gate ran; the verification threw, so there are no per-path facts.
      return withoutFacts(
        { state: "failed", failure: summarizeFailure(transaction.cause) },
        stageStopped(commandsConfigured, "first_verification_failed"),
      );

    case "post_marker_failed":
      // A verification result exists, but EVALUATING it threw. Deriving an
      // assessment would call the same predicates that just faulted, so the
      // receipt reports no per-path facts rather than facts it cannot trust.
      return withoutFacts(
        { state: "failed", failure: summarizeFailure(transaction.cause) },
        stageStopped(commandsConfigured, "first_verification_failed"),
      );

    case "observation_failed":
      // The PRE-command observation was unusable, so the commands never started
      // but there is an observation to report.
      if (!commandsConfigured) {
        return bad("a pre-command observation was taken although no commands were configured");
      }
      return withVerification(transaction.verification, {
        projectVerification: { state: "skipped", reason: "pre_command_observation_unusable" },
        postCommandIntegrity: {
          state: "observation_failed",
          side: transaction.side,
          failure: summarizeFailure(transaction.cause),
        },
      });

    case "observation_torn":
      switch (transaction.side) {
        case "before_commands":
          if (!commandsConfigured) {
            return bad("a pre-command observation was taken although no commands were configured");
          }
          return withVerification(transaction.verification, {
            projectVerification: { state: "skipped", reason: "pre_command_observation_unusable" },
            postCommandIntegrity: mapTorn(transaction.torn, "before_commands"),
          });
        case "after_commands":
          if (!executionAgrees(transaction.execution, commandsConfigured)) {
            return bad(
              "the command execution record disagrees with whether commands were configured",
            );
          }
          return withVerification(transaction.verification, {
            projectVerification: mapProjectVerification(transaction.execution),
            postCommandIntegrity: mapTorn(transaction.torn, "after_commands"),
          });
        default: {
          const unhandled: never = transaction;
          return bad(`unclassified torn-observation side: ${String(unhandled)}`);
        }
      }

    case "settled": {
      const stages = mapCommandPhase(transaction.commandPhase, commandsConfigured);
      if ("message" in stages) return bad(stages.message);
      return withVerification(transaction.verification, stages);
    }

    default: {
      const unhandled: never = transaction;
      return bad(`unclassified transaction outcome: ${String(unhandled)}`);
    }
  }
}

function describeParts(
  args: MapSelectiveReceiptArgs,
  planPaths: ReadonlySet<string>,
  planPairs: ReadonlySet<string>,
): PartsResult {
  const { source, plan, commandsConfigured } = args;
  switch (source.kind) {
    case "inspected_publication":
      // Publication is proven and no gate exists, so nothing recorded what any
      // path did. `gate_result_unavailable` is the stage that stopped it all.
      return {
        ok: true,
        parts: {
          results: indeterminateResults(plan),
          firstVerification: { state: "not_run", reason: "gate_result_unavailable" },
          // No verification ran at all, so no consistency claim is available.
          stateConsistent: false,
          ...stageStopped(commandsConfigured, "gate_result_unavailable"),
        },
      };
    case "gate_result":
      return describeFromTransaction(
        source.transaction,
        plan,
        planPaths,
        planPairs,
        commandsConfigured,
      );
    default: {
      const unhandled: never = source;
      return bad(`unclassified finalization source: ${String(unhandled)}`);
    }
  }
}

// ---- Entry point ------------------------------------------------------------

const mappingFailure = (message: string): ReceiptMapping => ({
  outcome: "failed",
  cause: new ReceiptMappingError(message),
});

function mapInternal(args: MapSelectiveReceiptArgs): ReceiptMapping {
  const { source, plan, recovery, checkpointId, writtenAt } = args;

  const planPaths = new Set<string>();
  const planPairs = new Set<string>();
  for (const c of plan.classifications) {
    if (planPaths.has(c.path)) {
      return mappingFailure(
        "the plan carries a duplicated classification path, which a receipt cannot express",
      );
    }
    planPaths.add(c.path);
    planPairs.add(pairKey(c.path, c.changeGroupId));
  }

  const attempt =
    source.kind === "inspected_publication"
      ? source.inspection.attempt
      : "gate" in source.transaction
        ? source.transaction.gate.attempt
        : source.transaction.marker.gate.attempt;

  if (attempt.pre_rollback_checkpoint_id !== recovery.checkpointId) {
    return mappingFailure(
      "the attempt marker names a different recovery checkpoint than the one this invocation created",
    );
  }

  const planGroups = new Set(plan.classifications.map((c) => c.changeGroupId));
  if (!sameStringSet(new Set(attempt.selection.resolved_change_group_ids), planGroups)) {
    return mappingFailure(
      "the plan's change groups differ from the selection the attempt marker authorized",
    );
  }

  const described = describeParts(args, planPaths, planPairs);
  if (!described.ok) return mappingFailure(described.message);
  const parts = described.parts;

  // Every conjunct is a fact ALREADY derived while building the parts. Nothing
  // here goes back to the transaction, so `post_marker_failed` cannot re-enter
  // the predicates whose fault produced it, and no verification internal is
  // consulted a second time.
  const succeeded =
    firstVerificationCompletedCleanly(parts.firstVerification) &&
    parts.stateConsistent &&
    allSettled(parts.results) &&
    (parts.projectVerification.state === "not_configured" ||
      projectVerificationPassed(parts.projectVerification)) &&
    (parts.postCommandIntegrity.state === "clean" ||
      parts.postCommandIntegrity.state === "not_run");

  const candidate = {
    schema_version: SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
    mode: "apply",
    rollback_id: attempt.rollback_id,
    session_id: attempt.session_id,
    checkpoint_id: checkpointId,
    contribution_sha256: attempt.contribution_sha256,
    pre_rollback_checkpoint_id: attempt.pre_rollback_checkpoint_id,
    selectors: attempt.selection.selectors,
    resolved_change_group_ids: [...attempt.selection.resolved_change_group_ids],
    results: parts.results,
    outcome: succeeded ? "succeeded" : "failed",
    first_verification: parts.firstVerification,
    project_verification: parts.projectVerification,
    post_command_integrity: parts.postCommandIntegrity,
    written_at: writtenAt,
    out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
  };

  // The schema is the last word: every cross-field rule it enforces is one this
  // mapper could otherwise violate silently.
  const parsed = SelectiveRollbackReceiptSchema.safeParse(candidate);
  return parsed.success
    ? { outcome: "mapped", receipt: parsed.data }
    : { outcome: "failed", cause: parsed.error };
}

/**
 * Map a finalization source into a receipt.
 *
 * The wrapper is what makes NEVER THROWS true rather than aspirational: a
 * getter, a normalizer, or a future refinement can throw, and finalization must
 * still get a value it can record.
 */
export function mapSelectiveRollbackReceipt(args: MapSelectiveReceiptArgs): ReceiptMapping {
  try {
    return mapInternal(args);
  } catch (cause) {
    return { outcome: "failed", cause };
  }
}
