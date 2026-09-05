// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Everything `viberevert rollback` does while holding the rollback lock.
//
// Extracted from `commands/rollback.ts` so the protected region is one named,
// directly testable function rather than a closure inside a command class. The
// command keeps argument validation, one lock acquisition, and rendering; this
// module owns every rollback-state read, the admission decision, and the four
// operation cells.
//
// =============================================================================
// One lock, four cells
// =============================================================================
//
//                   dry run                    apply
//   full      legacy preview receipt      legacy apply receipt
//   selective previewSelectiveRestore     the selective transaction
//
// Full-mode behavior is MOVED, not reinterpreted: the same reads in the same
// order, the same D68 receipt paths, the same D76 refusal semantics, the same
// D65 emergency checkpoint sequence. The only difference is that its refusals
// now leave here as values.
//
// =============================================================================
// Refusals leave as VALUES, never as throws
// =============================================================================
//
// `checkRefusals` throws, and a throw from inside the lock callback destroys
// the one thing `withRollbackLockCapturingRelease` exists to preserve: a result
// produced under a lock whose RELEASE then failed. A refused rollback that also
// stranded a lock directory must report both, so the phase returns
// `decision: "refused"` and the command renders it through `refusalError`, the
// same owner `checkRefusals` throws from.
//
// What still throws is what has always thrown: a missing session, missing
// checkpoint artifacts, a corrupt legacy apply receipt, an unparseable
// contribution. Those are faults, not refusals, and they were never carried as
// values before this extraction either.
//
// =============================================================================
// Timestamps are sampled inside the lock
// =============================================================================
//
// `clock` is injected and called immediately before each receipt is mapped,
// rather than threaded in from a value sampled before the lock was acquired. A
// `written_at` chosen before waiting on a lock describes when the command was
// typed, not when the receipt was produced, and the wait is unbounded from this
// module's point of view.
//
// The legacy full path still samples exactly ONCE per operation, at the top of
// its branch, so its emergency checkpoint's `capturedAt` and its receipt's
// `written_at` remain the same value. That is the half of D13 that is about the
// artifacts agreeing with each other; the half that also tied them to the lock
// metadata's `started_at` does not survive, and should not.
//
// =============================================================================
// Selection mode is BOUND to its selectors
// =============================================================================
//
// `RollbackSelectionMode` carries the selectors on the arm that has them and
// nothing on the arm that does not, so a caller cannot pass `full` beside a
// populated selector set. `resolveSelection` remains the authority deciding
// which arm applies; this module never re-derives it from a length check.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  generateRollbackId,
  loadActiveSessionLock,
  loadConfig,
  publishRollbackAttempt,
  type SessionContributionBinding,
  selectiveDryRunReceiptPath,
} from "@viberevert/core";
import {
  type EndOfSessionSnapshot,
  getHeadSha,
  getStatusPorcelainZ,
  loadEndOfSessionChangedPaths,
  planRestoreCheckpoint,
  previewSelectiveRestore,
  type RestorePlan,
  runSelectiveRestoreTransaction,
  type StatusEntry,
} from "@viberevert/git";
import {
  type ReceiptFile,
  ReceiptFileSchema,
  type RollbackSelection,
  type RollbackSelectors,
  type SelectiveRollbackReceipt,
  type SessionState,
  type VerifyCommand,
} from "@viberevert/session-format";

import { writeFileAtomic } from "./atomic.js";
import {
  type BoundSelectionInvalidReason,
  type BoundSelectiveRestore,
  prepareBoundSelectiveRestore,
  type VerifiedSelectionIdentity,
} from "./bound-selective-restore.js";
import { CheckpointListLoadError, CollisionExitSentinel } from "./checkpoint-helpers.js";
import {
  createEmergencyCheckpoint,
  type EmergencyCheckpointResult,
  RollbackEmergencyCheckpointError,
} from "./emergency-checkpoint.js";
import { ReportNotFoundError, resolveReportPaths } from "./report-paths.js";
import {
  deriveRollbackAdmission,
  type RollbackAdmissionRefusal,
  type RollbackAdmissionVerdict,
  type RollbackOperation,
} from "./rollback-admission.js";
import { inspectPublication, scanSelectiveRollbackHistory } from "./rollback-history.js";
import {
  buildReceiptForApply,
  buildReceiptForDryRun,
  type ExistingApplyReceipt,
  resolveSessionAndCheckpoint,
} from "./rollback-orchestration.js";
import {
  resolveSelection,
  type SelectionSelectors,
  selectionRequiresReport,
} from "./selection-resolver.js";
import {
  classifySelectiveApply,
  type RecoveryCheckpointState,
  resolveAfterInspection,
  type SelectiveApplyOutcome,
} from "./selective-apply-result.js";
import {
  mapEmptySelectiveDryRunReceipt,
  mapSelectiveDryRunReceipt,
} from "./selective-dry-run-mapper.js";
import { finalizeSelectiveReceipt } from "./selective-receipt-finalizer.js";
import type { ReceiptMapping } from "./selective-receipt-mapper.js";
import { runVerificationCommands, type VerifyCommandsResult } from "./verify-commands.js";

// =============================================================================
// D68 receipt path helpers (no inline path joins anywhere else)
// =============================================================================

/**
 * Path to the legacy dry-run receipt per D68. Dry run and apply persist to
 * DIFFERENT files so a preview never overwrites the apply audit record.
 */
export function rollbackDryRunReceiptPath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, ".viberevert", "sessions", sessionId, "rollback-dry-run-receipt.json");
}

/** Path to the legacy apply receipt per D68 (WRITE intent). */
export function rollbackApplyReceiptPath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, ".viberevert", "sessions", sessionId, "rollback-receipt.json");
}

/**
 * Same file as `rollbackApplyReceiptPath` — the separate name conveys READ
 * intent (the D70 existence check) rather than WRITE intent.
 */
function existingApplyReceiptPath(repoRoot: string, sessionId: string): string {
  return rollbackApplyReceiptPath(repoRoot, sessionId);
}

// =============================================================================
// Errors
// =============================================================================

/**
 * The legacy apply receipt exists at its D68 path but is unusable for the D70
 * idempotency check. Every malformed mode fails CLOSED: a non-ENOENT read
 * failure, a parse failure, a schema rejection, a non-apply mode, a null
 * `pre_rollback_checkpoint_id`, or a foreign `session_id`. The only value that
 * means "no existing apply receipt" is `null`, and only ENOENT produces it.
 */
export class ApplyReceiptCorruptError extends Error {
  override readonly name = "ApplyReceiptCorruptError";
  constructor(
    readonly receiptPath: string,
    readonly reason: string,
    cause?: unknown,
  ) {
    super(
      `Apply receipt at ${receiptPath} is unusable for D70 idempotency check: ${reason}. ` +
        `Inspect the file or remove it manually if you accept that the prior rollback's audit record is being discarded.`,
      cause === undefined ? undefined : { cause },
    );
  }
}

/**
 * `writeFileAtomic` failed while persisting a legacy receipt.
 *
 * Dual-mode message. With a recovery handle the restore already ran, so the
 * message warns about possible mutation and surfaces the emergency checkpoint,
 * which is the user's ONLY remaining source of `pre_rollback_checkpoint_id`.
 * Without one, dry run mutated nothing and the message says so.
 */
export class RollbackReceiptWriteError extends Error {
  override readonly name = "RollbackReceiptWriteError";
  constructor(
    readonly receiptPath: string,
    cause: unknown,
    readonly recoveryCheckpointId?: string,
    readonly recoveryCheckpointName?: string,
  ) {
    const mutationHint =
      recoveryCheckpointId !== undefined
        ? "The working tree may have been mutated; inspect 'git status'."
        : "No rollback mutation was attempted.";

    const recoveryHint =
      recoveryCheckpointId !== undefined
        ? ` The pre-rollback emergency checkpoint is ${recoveryCheckpointId}` +
          (recoveryCheckpointName !== undefined ? ` (name: ${recoveryCheckpointName})` : "") +
          `. Restore from it BEFORE retrying rollback to avoid layering a partial apply on top of partial state.`
        : "";

    super(
      `Failed to write rollback receipt to ${receiptPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }. ${mutationHint}${recoveryHint}`,
      { cause },
    );
  }
}

// =============================================================================
// Selection mode, bound to its selectors
// =============================================================================

export type RollbackSelectionMode =
  | { readonly mode: "full" }
  | { readonly mode: "selective"; readonly selectors: SelectionSelectors };

/**
 * Decide full versus selective, PURELY, and carry the selectors on the arm that
 * has them.
 *
 * `resolveSelection` is the authority, reused rather than restated, and it
 * needs no contribution to answer this question. Returning a bound pair is what
 * makes a mode disagreeing with its selectors unconstructible.
 */
export function resolveRollbackSelectionMode(selectors: SelectionSelectors): RollbackSelectionMode {
  return resolveSelection({ selectors }).mode === "full"
    ? { mode: "full" }
    : { mode: "selective", selectors };
}

// =============================================================================
// The phase's result
// =============================================================================

type AdmittedVerdict = Extract<RollbackAdmissionVerdict, { readonly decision: "admitted" }>;

export type SelectiveRollbackOutcome =
  /** The selectors could not be resolved against this session's evidence. */
  | { readonly kind: "selection_invalid"; readonly reason: BoundSelectionInvalidReason }
  /**
   * The selectors resolved to no change group, on an APPLY.
   *
   * A refusal, with no marker and no receipt: there is nothing to authorize.
   * The dry-run half of this case is not here, because it is not a dead end.
   * It records an `empty_selection` receipt and arrives as `previewed`, which
   * is what keeps all four cells symmetric: every selective dry run persists
   * exactly one receipt.
   */
  | { readonly kind: "selection_empty" }
  /**
   * The preview did not produce a persisted receipt.
   *
   * `phase` is carried because the three are different facts: `preview` means
   * the classification never completed, `map_receipt` means it completed and
   * could not be expressed as a receipt, and `write_receipt` means the receipt
   * exists and is not on disk. Only the first leaves the user with nothing to
   * look at.
   */
  | {
      readonly kind: "preview_failed";
      readonly phase: "preview" | "map_receipt" | "write_receipt";
      readonly cause: unknown;
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly kind: "previewed";
      readonly receipt: SelectiveRollbackReceipt;
      readonly receiptPath: string;
      readonly cleanupWarnings: readonly string[];
    }
  | { readonly kind: "applied"; readonly outcome: SelectiveApplyOutcome<VerifyCommandsResult> };

export type LockedRollbackOutcome =
  /** An admission rule said no. Rendered by the command, never thrown here. */
  | {
      readonly kind: "refused";
      readonly primary: RollbackAdmissionRefusal;
      readonly refusals: readonly RollbackAdmissionRefusal[];
    }
  /** No verdict could be reached. NOT a refusal: nothing said no. */
  | {
      readonly kind: "admission_failed";
      readonly phase: "legacy_analysis";
      readonly cause: unknown;
    }
  | { readonly kind: "full"; readonly receipt: ReceiptFile; readonly admission: AdmittedVerdict }
  | {
      readonly kind: "selective";
      readonly outcome: SelectiveRollbackOutcome;
      readonly admission: AdmittedVerdict;
    };

export interface LockedRollbackPhaseInput {
  readonly repoRoot: string;
  readonly sessionId: string;
  readonly mode: "dry_run" | "apply";
  readonly force: boolean;
  /** Resolved PURELY, before the lock. Mode and selectors cannot disagree. */
  readonly selection: RollbackSelectionMode;
  /** Sampled immediately before each receipt is mapped, never before the lock. */
  readonly clock: () => string;
  /** D22 lock metadata copy, reused for the emergency checkpoint's provenance. */
  readonly invocationCommand: string;
  /**
   * Where the emergency checkpoint's collision-scan refusal is written.
   *
   * Taken as a sink so that write keeps happening INSIDE the lock, exactly
   * where it happens today. Moving it after release would reorder it against
   * every other message a concurrent invocation produces.
   */
  readonly stderr: { write(s: string): unknown };
}

// =============================================================================
// I/O helpers
// =============================================================================

/**
 * Read, parse and validate the legacy apply receipt for the D70 check.
 *
 * `null` ONLY on genuine absence. Every other outcome throws
 * `ApplyReceiptCorruptError`: a receipt we cannot trust must never be read as
 * permission to apply again.
 */
async function loadExistingApplyReceipt(
  repoRoot: string,
  sessionId: string,
): Promise<ExistingApplyReceipt | null> {
  const receiptPath = existingApplyReceiptPath(repoRoot, sessionId);
  let raw: string;
  try {
    raw = await readFile(receiptPath, "utf8");
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw new ApplyReceiptCorruptError(receiptPath, "failed to read apply receipt", err);
  }

  let parsed: ReceiptFile;
  try {
    const json: unknown = JSON.parse(raw);
    parsed = ReceiptFileSchema.parse(json);
  } catch (err) {
    throw new ApplyReceiptCorruptError(receiptPath, "JSON parse or schema validation failed", err);
  }

  if (parsed.mode !== "apply") {
    throw new ApplyReceiptCorruptError(
      receiptPath,
      `mode is ${JSON.stringify(parsed.mode)} (expected "apply"). The CLI never writes a non-apply receipt to this path; the file is corrupted or hand-edited.`,
    );
  }
  if (parsed.pre_rollback_checkpoint_id === null) {
    throw new ApplyReceiptCorruptError(
      receiptPath,
      "pre_rollback_checkpoint_id is null in apply mode (D69 refine violation)",
    );
  }
  if (parsed.session_id !== sessionId) {
    throw new ApplyReceiptCorruptError(
      receiptPath,
      `session_id ${JSON.stringify(parsed.session_id)} does not match target ${JSON.stringify(sessionId)}`,
    );
  }
  return parsed as ExistingApplyReceipt;
}

/** Two-space JSON with a trailing newline: a persisted format, not a style. */
const serializeReceipt = (receipt: unknown): string => `${JSON.stringify(receipt, null, 2)}\n`;

async function writeReceiptAtomically(
  path: string,
  receipt: ReceiptFile,
  recovery?: {
    readonly recoveryCheckpointId: string;
    readonly recoveryCheckpointName: string;
  },
): Promise<void> {
  try {
    await writeFileAtomic(path, serializeReceipt(receipt));
  } catch (err) {
    throw new RollbackReceiptWriteError(
      path,
      err,
      recovery?.recoveryCheckpointId,
      recovery?.recoveryCheckpointName,
    );
  }
}

/**
 * The session's contribution binding, or `undefined` for a pre-0.8.0 session.
 *
 * Assembled from ONE persisted record so the loader can verify the whole chain.
 * The schema couples `contribution_path` with `contribution_sha256` and permits
 * it only on an ended session, so a present path implies both companions.
 */
function contributionBindingOf(session: SessionState): SessionContributionBinding | undefined {
  const path = session.contribution_path;
  const sha256 = session.contribution_sha256;
  const endedAt = session.ended_at;
  if (path === undefined || sha256 === undefined || endedAt === undefined) return undefined;
  return {
    path,
    sha256,
    expected: {
      sessionId: session.session_id,
      checkpointId: session.checkpoint_id,
      endedAt,
    },
  };
}

/**
 * The session-bound report, when the selectors consult one.
 *
 * A MISSING report becomes `undefined` rather than a throw, because
 * `prepareBoundSelectiveRestore` already owns that refusal as
 * `STALE_OR_MISSING_REPORT` and owns the provenance check that follows it. A
 * report that exists and will not parse still throws: a malformed artifact is
 * not a selector refusal.
 */
async function loadReportArtifact(repoRoot: string, sessionId: string): Promise<unknown> {
  let reportPath: string;
  try {
    reportPath = await resolveReportPaths({ repoRoot, sessionId });
  } catch (err) {
    if (err instanceof ReportNotFoundError) return undefined;
    throw err;
  }
  return JSON.parse(await readFile(reportPath, "utf8"));
}

/**
 * The CLI's selectors in the shape the marker and the receipt persist.
 *
 * Empty families become ABSENT, which is the only on-disk spelling of "this
 * family was not used": the schema rejects an empty array precisely so a marker
 * cannot claim a selector it does not carry. Sets are sorted and deduped, as
 * repeating a flag unions its values.
 */
function persistedSelectorsOf(selectors: SelectionSelectors): RollbackSelectors {
  const set = (values: readonly string[]): string[] => [...new Set(values)].sort();
  return {
    ...(selectors.only.length > 0 ? { only: set(selectors.only) } : {}),
    ...(selectors.except.length > 0 ? { except: set(selectors.except) } : {}),
    ...(selectors.finding.length > 0 ? { finding: set(selectors.finding) } : {}),
    ...(selectors.risk !== undefined ? { risk: selectors.risk } : {}),
  };
}

// =============================================================================
// The four cells
// =============================================================================

interface LegacyContext {
  readonly session: SessionState;
  readonly checkpointDir: string;
  readonly rollbackExcludePatterns: readonly string[];
  readonly plan: RestorePlan;
  /** The D75 outcome, which the caller has already proven exists. */
  readonly outcome: EvaluatedLegacy["outcome"];
}

type EvaluatedLegacy = Extract<AdmittedVerdict["legacy"], { readonly state: "evaluated" }>;

/**
 * The legacy full-session cells, moved verbatim.
 *
 * ONE timestamp for the whole operation, sampled here so the emergency
 * checkpoint and the receipt agree with each other.
 */
async function runFullRollback(
  input: LockedRollbackPhaseInput,
  admission: AdmittedVerdict,
  context: LegacyContext,
): Promise<LockedRollbackOutcome> {
  const { repoRoot, sessionId, mode, force } = input;
  const { session, checkpointDir, rollbackExcludePatterns, plan, outcome } = context;

  const now = input.clock();
  const rollbackId = generateRollbackId();
  let receipt: ReceiptFile;

  if (mode === "apply") {
    let emergency: EmergencyCheckpointResult;
    try {
      emergency = await createEmergencyCheckpoint({
        repoRoot,
        rollbackExcludePatterns,
        targetSessionId: sessionId,
        now,
        invocationCommand: input.invocationCommand,
      });
    } catch (err) {
      // Presentation stays inside the lock, preserving the pre-extraction
      // stderr text and the CollisionExitSentinel exit-1 flow byte for byte.
      if (err instanceof CheckpointListLoadError) {
        input.stderr.write(`Error reading existing checkpoints: ${err.message}\n`);
        throw new CollisionExitSentinel();
      }
      throw err;
    }

    receipt = await buildReceiptForApply({
      rollbackId,
      writtenAt: now,
      session,
      checkpointDir,
      repoRoot,
      rollbackExcludePatterns,
      preRollbackCheckpointId: emergency.checkpointId,
      preRestorePlan: plan,
      outcome,
      forced: force,
    });

    await writeReceiptAtomically(rollbackApplyReceiptPath(repoRoot, sessionId), receipt, {
      recoveryCheckpointId: emergency.checkpointId,
      recoveryCheckpointName: emergency.name,
    });
  } else {
    receipt = buildReceiptForDryRun({ rollbackId, writtenAt: now, session, plan, outcome });
    await writeReceiptAtomically(rollbackDryRunReceiptPath(repoRoot, sessionId), receipt);
  }

  return { kind: "full", receipt, admission };
}

/**
 * Persist a mapped dry-run receipt.
 *
 * Outside `rollbacks/`: a receipt in an invocation directory with no sibling
 * attempt marker is exactly what the history scan reports as inconsistent, and
 * that would block every later apply on a command that mutated nothing.
 */
async function persistPreviewReceipt(
  repoRoot: string,
  sessionId: string,
  mapping: ReceiptMapping,
  cleanupWarnings: readonly string[],
): Promise<SelectiveRollbackOutcome> {
  if (mapping.outcome === "failed") {
    return { kind: "preview_failed", phase: "map_receipt", cause: mapping.cause, cleanupWarnings };
  }
  const receiptPath = selectiveDryRunReceiptPath(repoRoot, sessionId);
  try {
    await writeFileAtomic(receiptPath, serializeReceipt(mapping.receipt));
  } catch (cause) {
    return { kind: "preview_failed", phase: "write_receipt", cause, cleanupWarnings };
  }
  return { kind: "previewed", receipt: mapping.receipt, receiptPath, cleanupWarnings };
}

/**
 * Record a selection that resolved to no change group.
 *
 * No oracle is opened, because there is nothing to classify, so there are no
 * cleanup warnings and the `preview` failure phase is unreachable here. The
 * receipt is still written: `empty_selection` is a result the schema has a
 * spelling for, and a dry run that persisted nothing would make the user infer
 * it from an absent file.
 */
async function recordEmptySelectivePreview(
  input: LockedRollbackPhaseInput,
  identity: VerifiedSelectionIdentity,
): Promise<SelectiveRollbackOutcome> {
  return persistPreviewReceipt(
    input.repoRoot,
    input.sessionId,
    mapEmptySelectiveDryRunReceipt({
      sessionId: identity.sessionId,
      checkpointId: identity.checkpointId,
      contributionSha256: identity.contributionSha256,
      selectors: persistedSelectorsOf(identity.selectors),
      rollbackId: generateRollbackId(),
      writtenAt: input.clock(),
    }),
    [],
  );
}

/** Classify every selected path without touching the project, then persist it. */
async function runSelectivePreview(
  input: LockedRollbackPhaseInput,
  bound: BoundSelectiveRestore,
  checkpointDir: string,
): Promise<SelectiveRollbackOutcome> {
  const { repoRoot, sessionId } = input;

  const preview = await previewSelectiveRestore({
    repoRoot,
    sessionCheckpointDir: checkpointDir,
    plan: bound.plan,
  });
  if (preview.outcome === "failed") {
    return {
      kind: "preview_failed",
      phase: "preview",
      cause: preview.cause,
      cleanupWarnings: preview.cleanupWarnings,
    };
  }
  // A dry run publishes no marker and reserves no invocation, so this id names
  // this preview alone. Sampled beside it, immediately before mapping.
  return persistPreviewReceipt(
    repoRoot,
    sessionId,
    mapSelectiveDryRunReceipt({
      preview,
      plan: bound.plan,
      sessionId: bound.sessionId,
      checkpointId: bound.checkpointId,
      contributionSha256: bound.contributionSha256,
      selectors: persistedSelectorsOf(bound.selectors),
      rollbackId: generateRollbackId(),
      writtenAt: input.clock(),
    }),
    preview.cleanupWarnings,
  );
}

/**
 * The selective apply.
 *
 * The recovery checkpoint's state is OBSERVED as the callback runs rather than
 * inferred from where the transaction stopped, which is what
 * `classifySelectiveApply` requires in order to check the two against each
 * other instead of resolving a disagreement by assumption.
 */
async function runSelectiveApply(
  input: LockedRollbackPhaseInput,
  bound: BoundSelectiveRestore,
  context: { readonly checkpointDir: string; readonly rollbackExcludePatterns: readonly string[] },
  verifyCommands: readonly VerifyCommand[],
): Promise<SelectiveRollbackOutcome> {
  const { repoRoot, sessionId } = input;
  const { checkpointDir, rollbackExcludePatterns } = context;

  const rollbackId = generateRollbackId();
  const selection: RollbackSelection = {
    selectors: persistedSelectorsOf(bound.selectors),
    resolved_change_group_ids: [...bound.plan.selectedChangeGroupIds],
  };

  let recovery: RecoveryCheckpointState = { status: "not_created" };

  const transaction = await runSelectiveRestoreTransaction<VerifyCommandsResult>({
    repoRoot,
    plan: bound.plan,
    rollbackExcludePatterns,
    sessionCheckpointDir: checkpointDir,
    sessionId: bound.sessionId,
    contributionSha256: bound.contributionSha256,
    createRecoveryCheckpoint: async () => {
      try {
        const emergency = await createEmergencyCheckpoint({
          repoRoot,
          rollbackExcludePatterns,
          targetSessionId: sessionId,
          now: input.clock(),
          invocationCommand: input.invocationCommand,
        });
        recovery = {
          status: "created",
          checkpointId: emergency.checkpointId,
          checkpointDir: emergency.checkpointDir,
        };
        return { checkpointId: emergency.checkpointId, checkpointDir: emergency.checkpointDir };
      } catch (err) {
        if (err instanceof CheckpointListLoadError) {
          input.stderr.write(`Error reading existing checkpoints: ${err.message}\n`);
          // No checkpoint was created, and the scan is what failed. `failed`
          // needs a stage this error does not have, so the honest state is
          // that no usable handle exists and we cannot name a stage.
          recovery = { status: "indeterminate" };
          throw err;
        }
        recovery =
          err instanceof RollbackEmergencyCheckpointError
            ? { status: "failed", stage: err.stage }
            : { status: "indeterminate" };
        throw err;
      }
    },
    publishAttempt: async (binding) =>
      publishRollbackAttempt({
        repoRoot,
        sessionId: binding.sessionId,
        rollbackId,
        contributionSha256: binding.contributionSha256,
        preRollbackCheckpointId: binding.preRollbackCheckpointId,
        selection: {
          selectors: selection.selectors,
          resolved_change_group_ids: [...binding.resolvedChangeGroupIds],
        },
      }),
    ...(verifyCommands.length > 0
      ? {
          runVerificationCommands: () =>
            runVerificationCommands({ commands: verifyCommands, cwd: repoRoot }),
        }
      : {}),
  });

  const initial = classifySelectiveApply<VerifyCommandsResult>({ transaction, recovery });
  const classification =
    initial.step === "inspect_publication"
      ? resolveAfterInspection<VerifyCommandsResult>({
          transaction: initial.transaction,
          recovery: initial.recovery,
          // Only the PREALLOCATED invocation is inspected, and only against
          // the binding this attempt published with.
          inspection: await inspectPublication(repoRoot, rollbackId, {
            sessionId: bound.sessionId,
            contributionSha256: bound.contributionSha256,
            preRollbackCheckpointId: initial.recovery.checkpointId,
            selection,
          }),
        })
      : initial;

  if (classification.step === "settled") {
    return { kind: "applied", outcome: classification.outcome };
  }
  if (classification.step === "inspect_publication") {
    // Unreachable: `resolveAfterInspection` routes every inspection outcome to
    // a settled or finalizing step, and the branch above consumed the only
    // value that could have asked for an inspection. The declared union does
    // not narrow that on its own, so it fails CLOSED rather than looping.
    return {
      kind: "applied",
      outcome: {
        kind: "internal_mapping_failure",
        transaction: classification.transaction,
        recovery: classification.recovery,
        detail: "inspecting the publication asked for the publication to be inspected again",
      },
    };
  }

  return {
    kind: "applied",
    outcome: await finalizeSelectiveReceipt({
      repoRoot,
      sessionId: bound.sessionId,
      rollbackId,
      source: classification.source,
      recovery: classification.recovery,
      plan: bound.plan,
      checkpointId: bound.checkpointId,
      writtenAt: input.clock(),
      commandsConfigured: verifyCommands.length > 0,
    }),
  };
}

// =============================================================================
// The phase
// =============================================================================

/**
 * Everything that happens while the rollback lock is held.
 *
 * Returns a value for every REFUSAL and every operation outcome. Throws only
 * for the faults that have always thrown from inside this region: a missing
 * session, missing checkpoint artifacts, a corrupt legacy apply receipt, an
 * unverifiable contribution, an unparseable report.
 */
export async function runLockedRollbackPhase(
  input: LockedRollbackPhaseInput,
): Promise<LockedRollbackOutcome> {
  const { repoRoot, sessionId, mode, force, selection } = input;

  const operation: RollbackOperation =
    mode === "dry_run"
      ? "dry_run"
      : selection.mode === "selective"
        ? "selective_apply"
        : "full_apply";

  // ---- Rollback-state reads, in the order they have always run -------------
  const config = await loadConfig(repoRoot);
  const activeLock = await loadActiveSessionLock(repoRoot);
  const { session, manifest, checkpointDir } = await resolveSessionAndCheckpoint(
    sessionId,
    repoRoot,
  );
  const endOfSessionSnapshot: EndOfSessionSnapshot = await loadEndOfSessionChangedPaths(
    session,
    repoRoot,
  );
  const currentStatus: readonly StatusEntry[] = await getStatusPorcelainZ(repoRoot);
  const currentHeadSha = await getHeadSha(repoRoot);
  const existingApplyReceipt = await loadExistingApplyReceipt(repoRoot, sessionId);

  // ---- Admission ------------------------------------------------------------
  const scan = await scanSelectiveRollbackHistory(repoRoot, sessionId);
  const admission = deriveRollbackAdmission({
    operation,
    scan,
    legacy: {
      state: "loaded",
      params: {
        targetSessionId: sessionId,
        session,
        manifest,
        currentHeadSha,
        currentStatus,
        endOfSessionSnapshot,
        activeLock,
        existingApplyReceipt,
      },
    },
    force,
  });

  if (admission.decision === "refused") {
    return { kind: "refused", primary: admission.primary, refusals: admission.refusals };
  }
  if (admission.decision === "failed") {
    return { kind: "admission_failed", phase: admission.phase, cause: admission.cause };
  }

  if (admission.legacy.state === "faulted") {
    // Reachable for a dry run only: the gate CARRIES a legacy fault rather than
    // refusing, so the dry-run guarantee holds through a corrupt legacy layer.
    // There is no `RefusalCheckOutcome` on that arm, so no receipt of either
    // kind can be built, and the command surfaces the fault exactly as it did
    // before this extraction. The union is what forces this to be confronted
    // rather than reached for as a field that is not there.
    return { kind: "admission_failed", phase: "legacy_analysis", cause: admission.legacy.cause };
  }
  const legacyOutcome = admission.legacy.outcome;

  // ---- Full-session cells ---------------------------------------------------
  if (selection.mode === "full") {
    // LIVE config, unchanged: the legacy path has always read it, and 0.8.0
    // does not retrofit the session-start snapshot onto it.
    const rollbackExcludePatterns = config.rollback?.exclude ?? [];
    const plan: RestorePlan = await planRestoreCheckpoint(checkpointDir, {
      repoRoot,
      rollbackExcludePatterns,
      allowHeadMismatch: legacyOutcome.allowHeadMismatch,
    });
    return runFullRollback(input, admission, {
      session,
      checkpointDir,
      rollbackExcludePatterns,
      plan,
      outcome: legacyOutcome,
    });
  }

  // ---- Selective cells ------------------------------------------------------
  const selectors = selection.selectors;
  const contributionBinding = contributionBindingOf(session);
  const prepared = await prepareBoundSelectiveRestore({
    repoRoot,
    ...(contributionBinding !== undefined ? { contributionBinding } : {}),
    selectors,
    ...(selectionRequiresReport(selectors)
      ? { report: await loadReportArtifact(repoRoot, sessionId) }
      : {}),
  });

  if (prepared.mode === "full") {
    // Unreachable: the same pure resolution over the same immutable selectors
    // already chose selective. Falling through to the legacy engine here would
    // widen the authorization from selected groups to the whole session.
    throw new Error("selection resolution changed from selective to full inside the rollback lock");
  }
  if (prepared.outcome === "invalid") {
    return {
      kind: "selective",
      outcome: { kind: "selection_invalid", reason: prepared.reason },
      admission,
    };
  }
  if (prepared.outcome === "empty") {
    // Asymmetric on purpose, and only here. A dry run RECORDS the empty
    // resolution; an apply refuses it, because there is nothing to authorize
    // and a marker naming no change group is unrepresentable.
    return {
      kind: "selective",
      outcome:
        mode === "dry_run"
          ? await recordEmptySelectivePreview(input, prepared.identity)
          : { kind: "selection_empty" },
      admission,
    };
  }

  if (mode === "dry_run") {
    return {
      kind: "selective",
      outcome: await runSelectivePreview(input, prepared.bound, checkpointDir),
      admission,
    };
  }

  // SESSION-START policy, never live config: `.viberevert.yml` is a file the
  // agent could have rewritten during the session it is being rolled back from.
  // A pre-0.8.0 session has no snapshot, so its own checkpoint's captured
  // exclude list is the defined fallback, and it configures no commands.
  const snapshot = session.evaluation_snapshot;
  const rollbackExcludePatterns = snapshot?.rollback_exclude ?? manifest.untracked.exclude_patterns;
  const verifyCommands = snapshot?.verify_commands ?? [];

  return {
    kind: "selective",
    outcome: await runSelectiveApply(
      input,
      prepared.bound,
      { checkpointDir, rollbackExcludePatterns },
      verifyCommands,
    ),
    admission,
  };
}
