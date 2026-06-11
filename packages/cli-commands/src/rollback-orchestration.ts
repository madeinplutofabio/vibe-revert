// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// CLI rollback orchestration — pure helpers + I/O wrappers consumed
// by `viberevert rollback` (M D Step 7). Per D29 this module owns
// NONE of:
//   - terminal output (no console/stderr/stdout)
//   - CLI command framework (no clipanion imports)
//   - D67 mutex acquisition (the CLI command holds the lock)
//
// It DOES own:
//   - The 6 typed error classes the rollback command emits for
//     refusals and missing-artifact failures.
//   - The TWO-LAYER refusal pipeline: `collectRollbackRefusals`
//     (pure) computes the analysis facts including the D76-ordered
//     refusals list; `checkRefusals` (wrapper) applies mode/force
//     policy and throws or returns the outcome.
//   - `resolveSessionAndCheckpoint` — the I/O helper that loads
//     the session + inner checkpoint manifest, wrapping core's
//     SessionNotFoundError unchanged + mapping git's
//     Checkpoint{Not,Corrupt}Error AND manifest-session-id
//     mismatches into CheckpointArtifactsMissingError.
//   - `classifyRestoreError` — maps the 5 restore.ts error classes
//     into the receipt's RollbackFailure shape with verified
//     per-class field accesses + sorted-unique affected_paths.
//   - `buildReceiptForDryRun` / `buildReceiptForApply` — receipt
//     constructors that synthesize results[] from the RestorePlan
//     and (for apply) call `restoreCheckpoint`.
//
// =============================================================================
// Locked architectural rules
// =============================================================================
//
//   1. **D76 locked refusal order, single source of truth.**
//      `collectRollbackRefusals` is the ONE place that walks the
//      rules in D63 → D70 → D64 → D61b → D61 order. `checkRefusals`
//      walks the resulting list and applies mode/force policy
//      without re-deriving the order.
//
//   2. **`collectRollbackRefusals` is PURE.** No I/O, no
//      Date.now(), no Math.random(). All inputs are pre-loaded
//      artifacts. The CLI orchestration layer (Step 7) does the
//      I/O and feeds the facts in.
//
//   3. **D75 force policy table (locked).**
//        - D63 active_session: NEVER bypassed (state-machine invariant).
//        - D70 already_applied: NEVER bypassed (idempotency).
//        - D64 head_mismatch: bypassable; sets
//          `allowHeadMismatch: true` on the outcome.
//        - D61b un_ended_session: bypassable; sets
//          `un_ended_session_warning: true` /
//          `dirty_tree_check: "skipped_no_after_state"`.
//        - D61 dirty_tree: bypassable; receipt records
//          `forced: true` + populates `forced_unrelated_dirty_paths`.
//
//   4. **N4 narrowed `ExistingApplyReceipt` type.** The collector
//      only treats a receipt as "already applied" if it is an
//      apply-mode receipt with non-null pre_rollback_checkpoint_id.
//      A dry-run receipt at the apply path is CORRUPTION, not
//      "already applied" — the CLI (Step 7) parses the apply
//      path and fails closed if the receipt's mode isn't "apply".
//
//   5. **N5 R/C BOTH-paths rule applied symmetrically.** The
//      current-status path-set derivation uses the same
//      "include previousPath for R/C entries" rule as the
//      persisted-snapshot reader in @viberevert/git. Otherwise
//      rename/copy current dirty state could evade or
//      misclassify the D61 unrelated-dirt check.
//
//   6. **Artifact-consistency guard.** `assertRollbackArtifactConsistency`
//      verifies that session_id values on the SessionState, the
//      checkpoint Manifest, AND the existing apply receipt (when
//      present) all match the targetSessionId. Called at the top
//      of `collectRollbackRefusals` (defends against direct misuse
//      + a corrupted/foreign apply-receipt at the target session
//      path slipping through as a fake "already applied" fact).
//      Also called inside `resolveSessionAndCheckpoint` for the
//      manifest side (wrapped as CheckpointArtifactsMissingError
//      because at that I/O layer a mismatch indicates corrupted
//      on-disk artifacts and should map to the existing typed-error
//      surface). The session-side check inside
//      `resolveSessionAndCheckpoint` is redundant because
//      `loadSession`'s M B architectural-lock #7 already enforces
//      session.session_id === requested-id.
//
//   7. **Conservative apply-error receipt semantics (D76 lock).**
//      On any `restoreCheckpoint` throw, `results[]` is EMPTY
//      unless the restore layer can prove completed paths. Today
//      it cannot, so empty `results[]` + populated `failures[]`
//      is the universal throw shape.
//
//   8. **`mayHaveMutated` is CONSERVATIVE.** The flag defaults to
//      `true` for any unknown error class — an unknown error
//      during/after `restoreCheckpoint` could be post-mutation
//      and treating it as definitely pre-mutation would be unsafe.
//      Only known PRE-mutation refusals (HeadMismatch, ExcludeDrift)
//      get `false`.
//
//   9. **Receipt construction goes through ReceiptFileSchema.parse.**
//      Both builders end with `ReceiptFileSchema.parse(receipt)` so
//      any D69 refine violation fails LOUDLY here.
//
//  10. **`affected_paths` sorted + unique.** All path collections
//      on `RollbackFailure.affected_paths` are sorted ascending
//      and deduplicated. The receipt schema doesn't promise dedup
//      semantically, but byte-stable audit-trail output requires
//      it. The shared `sortedUnique` helper enforces uniformly.
//
//  11. **D17c plain inputs to core / git.** This module never
//      reaches into restore-internals or session-lifecycle
//      internals beyond their public barrel APIs.
//
//  12. **Dry-run preflight propagation.** `buildReceiptForDryRun`
//      maps `plan.preflight_failures[]` into the receipt's
//      `failures[]` per the documented contract in
//      `@viberevert/git` (HEAD/exclude-drift soft failures surface
//      here on the dry-run path, NOT as throws — `planRestoreCheckpoint`
//      never throws on those signals). `affected_paths` normalized
//      via the shared `sortedUnique` helper for byte-stable receipt
//      output, even though `@viberevert/git` already normalizes
//      upstream — defensive symmetry with `classifyRestoreError`
//      locks the receipt-builder seam independently. The apply path
//      does NOT need this propagation: its `preRestorePlan` preflight
//      failures (exclude_drift always, head_mismatch when
//      `allowHeadMismatch: false`) would have caused `restoreCheckpoint`
//      to throw the corresponding typed error BEFORE the success
//      path runs, landing in `classifyRestoreError` instead.

import { join } from "node:path";
import { loadSession } from "@viberevert/core";
import {
  CheckpointCorruptError,
  CheckpointNotFoundError,
  type EndOfSessionSnapshot,
  loadCheckpoint,
  RestoreExcludeDriftError,
  RestoreExtractionConflictError,
  RestoreHeadMismatchError,
  type RestorePlan,
  RestoreTrackedDirtyParityError,
  RestoreVerificationError,
  restoreCheckpoint,
  type StatusEntry,
} from "@viberevert/git";
import {
  type ActiveSessionLock,
  type Manifest,
  RECEIPT_FILE_SCHEMA_VERSION,
  type ReceiptFile,
  ReceiptFileSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  type RollbackFailure,
  type RollbackFileResult,
  type SessionState,
} from "@viberevert/session-format";

// =============================================================================
// Error classes (D75 refusal types + D23 missing-artifacts)
// =============================================================================

export class CheckpointArtifactsMissingError extends Error {
  override readonly name = "CheckpointArtifactsMissingError";
  constructor(
    readonly sessionId: string,
    readonly checkpointDir: string,
    cause?: unknown,
  ) {
    super(
      `Cannot roll back session ${sessionId}: checkpoint artifacts at ${checkpointDir} are missing or corrupt. ` +
        `The session's inner checkpoint must exist and be loadable for rollback to proceed.`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export class RollbackActiveSessionRefusalError extends Error {
  override readonly name = "RollbackActiveSessionRefusalError";
  constructor(readonly sessionId: string) {
    super(
      `Cannot roll back session ${sessionId} while it is still active. ` +
        `Run 'viberevert end' first, then re-run 'viberevert rollback ${sessionId}'.`,
    );
  }
}

export class RollbackAlreadyAppliedError extends Error {
  override readonly name = "RollbackAlreadyAppliedError";
  constructor(
    readonly sessionId: string,
    readonly writtenAt: string,
    readonly preRollbackCheckpointId: string,
  ) {
    super(
      `Session ${sessionId} has already been rolled back at ${writtenAt}. ` +
        `Re-running --apply would restore captured state onto a tree that is no longer the post-session state. ` +
        `Use 'viberevert rollback ${sessionId}' (dry-run) to inspect, or recover via the pre-rollback checkpoint ${preRollbackCheckpointId} ` +
        `(future: 'viberevert rollback --checkpoint <id>' will support this directly).`,
    );
  }
}

export class RollbackHeadMismatchError extends Error {
  override readonly name = "RollbackHeadMismatchError";
  constructor(
    readonly expectedHead: string,
    readonly currentHead: string,
  ) {
    super(
      `Rollback HEAD precondition failed: checkpoint was captured at ${expectedHead}, but HEAD is now ${currentHead}. ` +
        `Re-run with --force to apply rollback onto a different HEAD (best-effort; ` +
        `subsequent restore verification may still fail honestly if the trees are too divergent).`,
    );
  }
}

export class RollbackUnEndedSessionRefusalError extends Error {
  override readonly name = "RollbackUnEndedSessionRefusalError";
  constructor(readonly sessionId: string) {
    super(
      `Session ${sessionId} has no machine-readable after-status snapshot. ` +
        `The dirty-tree safety comparison requires the post-session machine snapshot. ` +
        `Run 'viberevert end' to capture it if the session is still recoverable, then re-run rollback. ` +
        `If the session is unrecoverable or was created before rollback snapshots existed, and you accept the safety-precondition gap, re-run with --apply --force.`,
    );
  }
}

export class RollbackDirtyTreeRefusalError extends Error {
  override readonly name = "RollbackDirtyTreeRefusalError";
  constructor(readonly unrelatedPaths: readonly string[]) {
    const count = unrelatedPaths.length;
    const noun = count === 1 ? "path" : "paths";
    const listing = unrelatedPaths.map((p) => `  - ${p}`).join("\n");
    super(
      `Working tree has ${count} unrelated dirty ${noun} not in the session's expected rollback target. ` +
        `Rollback would interact with these paths in ways the safety check cannot reason about. ` +
        `Commit, stash, or remove them, OR re-run with --force to apply rollback over them ` +
        `(the emergency pre-rollback checkpoint will preserve their current state).\n` +
        `Unrelated paths:\n${listing}`,
    );
  }
}

// =============================================================================
// Types
// =============================================================================

export type ExistingApplyReceipt = ReceiptFile & {
  readonly mode: "apply";
  readonly pre_rollback_checkpoint_id: string;
};

export type RollbackRefusal =
  | { readonly kind: "active_session"; readonly activeSessionId: string }
  | {
      readonly kind: "already_applied";
      readonly writtenAt: string;
      readonly preRollbackCheckpointId: string;
    }
  | {
      readonly kind: "head_mismatch";
      readonly expectedHead: string;
      readonly currentHead: string;
    }
  | { readonly kind: "un_ended_session"; readonly sessionId: string }
  | { readonly kind: "dirty_tree"; readonly unrelatedPaths: readonly string[] };

export interface RollbackRefusalAnalysis {
  readonly activeSessionWarning: boolean;
  readonly unEndedSessionWarning: boolean;
  readonly headMismatch: boolean;
  readonly dirtyTreeCheckOutcome: "performed" | "skipped_no_after_state";
  readonly unrelatedDirtyPaths: readonly string[];
  readonly refusals: readonly RollbackRefusal[];
}

export interface RefusalCheckOutcome {
  readonly activeSessionWarning: boolean;
  readonly unEndedSessionWarning: boolean;
  readonly allowHeadMismatch: boolean;
  readonly dirtyTreeCheckOutcome: "performed" | "skipped_no_after_state";
  readonly unrelatedDirtyPaths: readonly string[];
}

export interface CollectRollbackRefusalsParams {
  readonly targetSessionId: string;
  readonly session: SessionState;
  readonly manifest: Manifest;
  readonly currentHeadSha: string;
  readonly currentStatus: readonly StatusEntry[];
  readonly endOfSessionSnapshot: EndOfSessionSnapshot;
  readonly activeLock: ActiveSessionLock | null;
  readonly existingApplyReceipt: ExistingApplyReceipt | null;
}

export interface CheckRefusalsParams extends CollectRollbackRefusalsParams {
  readonly mode: "dry_run" | "apply";
  readonly force: boolean;
}

export interface BuildReceiptForDryRunParams {
  readonly rollbackId: string;
  readonly writtenAt: string;
  readonly session: SessionState;
  readonly plan: RestorePlan;
  readonly outcome: RefusalCheckOutcome;
}

export interface BuildReceiptForApplyParams {
  readonly rollbackId: string;
  readonly writtenAt: string;
  readonly session: SessionState;
  readonly checkpointDir: string;
  readonly repoRoot: string;
  readonly rollbackExcludePatterns: readonly string[];
  readonly preRollbackCheckpointId: string;
  readonly preRestorePlan: RestorePlan;
  readonly outcome: RefusalCheckOutcome;
  readonly forced: boolean;
}

/**
 * Result of mapping a `restoreCheckpoint` throw to receipt
 * failure shape.
 *
 * `mayHaveMutated` is the CONSERVATIVE safety signal — `true`
 * means "the failure occurred at a point where the working tree
 * MAY have been partially mutated; recovery via the emergency
 * pre-rollback checkpoint may be required." `false` means
 * "the failure is provably pre-mutation; the working tree is
 * unchanged." Unknown error classes default to `true` because
 * we cannot prove pre-mutation status.
 */
export interface ClassifyRestoreErrorResult {
  readonly failures: readonly RollbackFailure[];
  readonly mayHaveMutated: boolean;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Return `paths` deduplicated and sorted ascending. Used uniformly
 * for every `RollbackFailure.affected_paths` collection so the
 * receipt's audit-trail output is byte-stable regardless of
 * whether the upstream error payload happened to be unique.
 *
 * Return type is mutable `string[]` (not `readonly string[]`)
 * because the receipt schema's `affected_paths` field is a zod
 * `z.array(nonBlankString)` which produces a mutable array type.
 * Callers immediately assign the result into the schema-typed
 * shape and don't mutate it further, so the "mutable" nominal
 * type is a structural concession to zod, not an invitation to
 * write into the result.
 */
function sortedUnique(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort();
}

/**
 * Verify that the SessionState, Manifest, and (when present) the
 * existing apply receipt all carry session_id values matching the
 * targetSessionId.
 *
 * Detects:
 *   - Caller passed the wrong SessionState (off-by-one in a
 *     future multi-session refactor).
 *   - Corrupted checkpoint manifest whose internal session_id
 *     doesn't match the directory it was loaded from.
 *   - Corrupted/foreign apply receipt at the target session's
 *     receipt path (would otherwise be trusted as a D70
 *     "already applied" fact for the wrong session).
 *
 * Throws plain Error on mismatch. The collector lets the throw
 * propagate as direct-misuse / corruption. The I/O wrapper
 * `resolveSessionAndCheckpoint` does the equivalent manifest
 * check inline + wraps as `CheckpointArtifactsMissingError` so
 * the CLI's typed-error surface stays single at the I/O boundary.
 */
function assertRollbackArtifactConsistency(params: {
  readonly targetSessionId: string;
  readonly session: SessionState;
  readonly manifest: Manifest;
  readonly existingApplyReceipt?: ExistingApplyReceipt | null;
}): void {
  if (params.session.session_id !== params.targetSessionId) {
    throw new Error(
      `Rollback artifact mismatch: session.session_id ${JSON.stringify(
        params.session.session_id,
      )} does not match target session ${JSON.stringify(params.targetSessionId)}.`,
    );
  }
  if (params.manifest.session_id !== params.targetSessionId) {
    throw new Error(
      `Rollback artifact mismatch: checkpoint manifest session_id ${JSON.stringify(
        params.manifest.session_id,
      )} does not match target session ${JSON.stringify(params.targetSessionId)}.`,
    );
  }
  if (
    params.existingApplyReceipt !== undefined &&
    params.existingApplyReceipt !== null &&
    params.existingApplyReceipt.session_id !== params.targetSessionId
  ) {
    throw new Error(
      `Rollback artifact mismatch: existing apply receipt session_id ${JSON.stringify(
        params.existingApplyReceipt.session_id,
      )} does not match target session ${JSON.stringify(params.targetSessionId)}.`,
    );
  }
}

/**
 * Derive the dirty path set from a current-tree `StatusEntry[]`
 * using the SAME R/C BOTH-paths rule the persisted-snapshot
 * reader (`loadEndOfSessionChangedPaths` in @viberevert/git) uses.
 *
 * Returns paths sorted ascending for byte-stable downstream
 * comparison.
 */
function derivePathSetFromStatusEntries(entries: readonly StatusEntry[]): readonly string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    paths.add(entry.path);
    if (entry.previousPath !== undefined) {
      paths.add(entry.previousPath);
    }
  }
  return [...paths].sort();
}

/**
 * Convert a `RestorePlan` into per-path `RollbackFileResult[]` for
 * the receipt. Each plan bucket maps 1:1 to a `RollbackFileOutcome`.
 * Results are sorted ascending by path for byte-stable goldens.
 *
 * Used by BOTH `buildReceiptForDryRun` AND `buildReceiptForApply`
 * (since restoreCheckpoint doesn't expose per-path progress on
 * success today; the apply path uses the same pre-restore plan
 * the CLI computed via `planRestoreCheckpoint`).
 */
function synthesizeResultsFromPlan(plan: RestorePlan): RollbackFileResult[] {
  const results: RollbackFileResult[] = [];
  for (const path of plan.tracked_restored) {
    results.push({ path, outcome: "tracked_restored" });
  }
  for (const path of plan.untracked_restored) {
    results.push({ path, outcome: "untracked_restored" });
  }
  for (const path of plan.untracked_deleted) {
    results.push({ path, outcome: "untracked_deleted" });
  }
  for (const path of plan.skipped_excluded) {
    results.push({ path, outcome: "skipped_excluded" });
  }
  for (const path of plan.skipped_unchanged) {
    results.push({ path, outcome: "skipped_unchanged" });
  }
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results;
}

// =============================================================================
// collectRollbackRefusals (PURE)
// =============================================================================

/**
 * Walk the D76-ordered rules and return the analysis facts +
 * an ordered refusals list. PURE: no I/O.
 *
 * Asserts artifact consistency (session, manifest, AND apply
 * receipt all match targetSessionId) at the top before any rule
 * evaluation.
 */
export function collectRollbackRefusals(
  params: CollectRollbackRefusalsParams,
): RollbackRefusalAnalysis {
  assertRollbackArtifactConsistency(params);

  const isActive =
    params.activeLock !== null && params.activeLock.session_id === params.targetSessionId;

  const headMismatch = params.currentHeadSha !== params.manifest.git.head_sha;

  const unEnded = params.endOfSessionSnapshot.kind === "missing";

  let dirtyTreeCheckOutcome: "performed" | "skipped_no_after_state";
  let unrelatedDirtyPaths: readonly string[];
  if (unEnded) {
    dirtyTreeCheckOutcome = "skipped_no_after_state";
    unrelatedDirtyPaths = [];
  } else {
    dirtyTreeCheckOutcome = "performed";
    const expected = new Set<string>();
    for (const p of params.manifest.snapshots.tracked_dirty_paths) {
      expected.add(p);
    }
    for (const p of Object.keys(params.manifest.untracked.file_hashes)) {
      expected.add(p);
    }
    for (const p of params.endOfSessionSnapshot.paths) {
      expected.add(p);
    }
    const currentDirty = derivePathSetFromStatusEntries(params.currentStatus);
    const unrelated: string[] = [];
    for (const p of currentDirty) {
      if (!expected.has(p)) {
        unrelated.push(p);
      }
    }
    unrelatedDirtyPaths = unrelated;
  }

  const refusals: RollbackRefusal[] = [];
  if (isActive) {
    refusals.push({ kind: "active_session", activeSessionId: params.targetSessionId });
  }
  if (params.existingApplyReceipt !== null) {
    refusals.push({
      kind: "already_applied",
      writtenAt: params.existingApplyReceipt.written_at,
      preRollbackCheckpointId: params.existingApplyReceipt.pre_rollback_checkpoint_id,
    });
  }
  if (headMismatch) {
    refusals.push({
      kind: "head_mismatch",
      expectedHead: params.manifest.git.head_sha,
      currentHead: params.currentHeadSha,
    });
  }
  if (unEnded) {
    refusals.push({ kind: "un_ended_session", sessionId: params.targetSessionId });
  }
  if (unrelatedDirtyPaths.length > 0) {
    refusals.push({ kind: "dirty_tree", unrelatedPaths: unrelatedDirtyPaths });
  }

  return {
    activeSessionWarning: isActive,
    unEndedSessionWarning: unEnded,
    headMismatch,
    dirtyTreeCheckOutcome,
    unrelatedDirtyPaths,
    refusals,
  };
}

// =============================================================================
// checkRefusals (wraps collectRollbackRefusals; applies mode/force)
// =============================================================================

/**
 * Apply D75 force policy to the collector's analysis and either
 * throw the first applicable refusal (apply mode) or return the
 * outcome with warnings populated (dry-run mode).
 *
 * Dry-run mode never throws policy refusals. Corrupted or
 * mismatched pre-loaded artifacts still throw before policy
 * evaluation, via `collectRollbackRefusals`'s artifact-consistency
 * guard.
 */
export function checkRefusals(params: CheckRefusalsParams): RefusalCheckOutcome {
  const analysis = collectRollbackRefusals(params);

  if (params.mode === "dry_run") {
    return {
      activeSessionWarning: analysis.activeSessionWarning,
      unEndedSessionWarning: analysis.unEndedSessionWarning,
      allowHeadMismatch: false,
      dirtyTreeCheckOutcome: analysis.dirtyTreeCheckOutcome,
      unrelatedDirtyPaths: analysis.unrelatedDirtyPaths,
    };
  }

  for (const refusal of analysis.refusals) {
    switch (refusal.kind) {
      case "active_session":
        throw new RollbackActiveSessionRefusalError(refusal.activeSessionId);
      case "already_applied":
        throw new RollbackAlreadyAppliedError(
          params.targetSessionId,
          refusal.writtenAt,
          refusal.preRollbackCheckpointId,
        );
      case "head_mismatch":
        if (!params.force) {
          throw new RollbackHeadMismatchError(refusal.expectedHead, refusal.currentHead);
        }
        break;
      case "un_ended_session":
        if (!params.force) {
          throw new RollbackUnEndedSessionRefusalError(refusal.sessionId);
        }
        break;
      case "dirty_tree":
        if (!params.force) {
          throw new RollbackDirtyTreeRefusalError(refusal.unrelatedPaths);
        }
        break;
    }
  }

  return {
    activeSessionWarning: analysis.activeSessionWarning,
    unEndedSessionWarning: analysis.unEndedSessionWarning,
    allowHeadMismatch: analysis.headMismatch && params.force,
    dirtyTreeCheckOutcome: analysis.dirtyTreeCheckOutcome,
    unrelatedDirtyPaths: analysis.unrelatedDirtyPaths,
  };
}

// =============================================================================
// resolveSessionAndCheckpoint (I/O wrapper)
// =============================================================================

/**
 * Load the session + its INNER checkpoint manifest per the M D
 * locked storage layout. Re-throws core's `SessionNotFoundError`
 * verbatim; wraps git's `CheckpointNotFoundError` /
 * `CheckpointCorruptError` AND any manifest-session-id mismatch
 * into `CheckpointArtifactsMissingError`.
 *
 * The checkpoint dir is the SESSION-OWNED inner path
 * `.viberevert/sessions/<sess>/checkpoint/`, NOT the global
 * `.viberevert/checkpoints/cp_<ULID>/` store.
 *
 * The manifest-session-id check is defense in depth: a corrupted
 * (or hand-edited) manifest.json with a foreign session_id would
 * otherwise quietly let rollback proceed with the wrong artifacts.
 * The session-id-on-SessionState check is NOT replicated here —
 * `loadSession` per M B's session.ts architectural-lock #7 already
 * throws if the loaded session.json's internal session_id doesn't
 * match the requested id. The existing-apply-receipt check is
 * NOT done here either; it lives inside
 * `collectRollbackRefusals` via the shared
 * `assertRollbackArtifactConsistency` helper because Step 7's CLI
 * loads the apply receipt SEPARATELY (after this function returns).
 */
export async function resolveSessionAndCheckpoint(
  sessionId: string,
  repoRoot: string,
): Promise<{
  readonly session: SessionState;
  readonly manifest: Manifest;
  readonly checkpointDir: string;
}> {
  const session = await loadSession(sessionId, repoRoot);

  const checkpointDir = join(repoRoot, ".viberevert", "sessions", sessionId, "checkpoint");

  let manifest: Manifest;
  try {
    manifest = await loadCheckpoint(checkpointDir);
  } catch (err) {
    if (err instanceof CheckpointNotFoundError || err instanceof CheckpointCorruptError) {
      throw new CheckpointArtifactsMissingError(sessionId, checkpointDir, err);
    }
    throw err;
  }

  if (manifest.session_id !== sessionId) {
    throw new CheckpointArtifactsMissingError(
      sessionId,
      checkpointDir,
      new Error(
        `manifest.session_id ${JSON.stringify(manifest.session_id)} does not match requested session ${JSON.stringify(sessionId)}`,
      ),
    );
  }

  return { session, manifest, checkpointDir };
}

// =============================================================================
// classifyRestoreError
// =============================================================================

/**
 * Map a `restoreCheckpoint` throw to the receipt's
 * `RollbackFailure` shape. Five known restore-error classes map
 * 1:1 to D69 `error_code` values with type-verified per-class
 * field accesses; any unknown error class falls through to
 * `error_code: "internal"`.
 *
 * `mayHaveMutated` is CONSERVATIVE — defaults to `true` for any
 * unknown error class because an unknown error during/after
 * `restoreCheckpoint` could indicate post-mutation state. Only
 * provably pre-mutation refusals get `false`.
 *
 * Per-class `affected_paths` extraction (sorted-unique via
 * `sortedUnique` for every collection):
 *   - HeadMismatch / unknown: empty (no per-path payload).
 *   - ExcludeDrift: `tighteningPaths` (manifest paths the new
 *     pattern would suddenly filter — the user-meaningful subset
 *     of the four pattern-set fields).
 *   - ExtractionConflict: union of `manifestPath` AND
 *     `conflictingPath` for each conflict. Both are surfaced
 *     because the prefix-blocker case (file `a` blocking
 *     `a/b.txt`) puts the actually-conflicting path on
 *     `conflictingPath` while the rollback's intent is on
 *     `manifestPath`. `sortedUnique` collapses the common case
 *     where they're equal.
 *   - TrackedDirtyParity: `issues[].path` (the dirty-set diff).
 *   - Verification: `mismatches[].path` (the SHA-mismatched files).
 */
export function classifyRestoreError(err: unknown): ClassifyRestoreErrorResult {
  if (err instanceof RestoreHeadMismatchError) {
    return {
      failures: [{ error_code: "head_mismatch", message: err.message, affected_paths: [] }],
      mayHaveMutated: false,
    };
  }
  if (err instanceof RestoreExcludeDriftError) {
    return {
      failures: [
        {
          error_code: "exclude_drift",
          message: err.message,
          affected_paths: sortedUnique(err.tighteningPaths),
        },
      ],
      mayHaveMutated: false,
    };
  }
  if (err instanceof RestoreExtractionConflictError) {
    return {
      failures: [
        {
          error_code: "extraction_conflict",
          message: err.message,
          affected_paths: sortedUnique(
            err.conflicts.flatMap((c) => [c.manifestPath, c.conflictingPath]),
          ),
        },
      ],
      mayHaveMutated: true,
    };
  }
  if (err instanceof RestoreTrackedDirtyParityError) {
    return {
      failures: [
        {
          error_code: "tracked_dirty_parity",
          message: err.message,
          affected_paths: sortedUnique(err.issues.map((i) => i.path)),
        },
      ],
      mayHaveMutated: true,
    };
  }
  if (err instanceof RestoreVerificationError) {
    return {
      failures: [
        {
          error_code: "verification",
          message: err.message,
          affected_paths: sortedUnique(err.mismatches.map((m) => m.path)),
        },
      ],
      mayHaveMutated: true,
    };
  }
  return {
    failures: [
      {
        error_code: "internal",
        message: err instanceof Error ? err.message : String(err),
        affected_paths: [],
      },
    ],
    mayHaveMutated: true,
  };
}

// =============================================================================
// buildReceiptForDryRun
// =============================================================================

/**
 * Synthesize a dry-run `ReceiptFile` from a `RestorePlan` plus the
 * `RefusalCheckOutcome` for warning fields and unrelated-dirt
 * classification.
 *
 * Per D69 refine, `skipped_unrelated_dirt` outcome is valid ONLY
 * in dry-run mode; apply records unrelated paths in
 * `forced_unrelated_dirty_paths` instead.
 *
 * **Preflight propagation (locked rule #12):** maps
 * `plan.preflight_failures[]` into the receipt's `failures[]`
 * per the documented `@viberevert/git` contract — HEAD/exclude-drift
 * soft signals surface on the dry-run path as receipt failures,
 * NOT as throws. The 1:1 field shape (`error_code` /  `message` /
 * `affected_paths`) matches `RollbackFailure` exactly; only
 * `affected_paths` gets re-normalized via `sortedUnique` for
 * defensive symmetry with `classifyRestoreError`.
 *
 * Returns `ReceiptFileSchema.parse(receipt)` so D69 refine
 * violations surface here as Errors.
 */
export function buildReceiptForDryRun(params: BuildReceiptForDryRunParams): ReceiptFile {
  const results = synthesizeResultsFromPlan(params.plan);

  if (params.outcome.dirtyTreeCheckOutcome === "performed") {
    for (const path of params.outcome.unrelatedDirtyPaths) {
      results.push({
        path,
        outcome: "skipped_unrelated_dirt",
        reason:
          "Path is not in the session's expected rollback target; --apply would refuse without --force.",
      });
    }
    results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  const failures: RollbackFailure[] = params.plan.preflight_failures.map((failure) => ({
    error_code: failure.error_code,
    message: failure.message,
    affected_paths: sortedUnique(failure.affected_paths),
  }));

  const receipt = {
    schema_version: RECEIPT_FILE_SCHEMA_VERSION,
    rollback_id: params.rollbackId,
    session_id: params.session.session_id,
    checkpoint_id: params.session.checkpoint_id,
    mode: "dry_run" as const,
    forced: false,
    written_at: params.writtenAt,
    pre_rollback_checkpoint_id: null,
    results,
    failures,
    forced_unrelated_dirty_paths: [] as readonly string[],
    dirty_tree_check: params.outcome.dirtyTreeCheckOutcome,
    out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
    ...(params.outcome.activeSessionWarning ? { active_session_warning: true as const } : {}),
    ...(params.outcome.unEndedSessionWarning ? { un_ended_session_warning: true as const } : {}),
  };

  return ReceiptFileSchema.parse(receipt);
}

// =============================================================================
// buildReceiptForApply
// =============================================================================

/**
 * Call `restoreCheckpoint` and synthesize an apply-mode
 * `ReceiptFile`. On success, `results[]` is synthesized from the
 * `preRestorePlan`. On throw, `results[]` is EMPTY per the D76
 * conservative semantics lock; `failures[]` is populated by
 * `classifyRestoreError`.
 *
 * `forced_unrelated_dirty_paths` is populated ONLY when all of:
 *   - `forced === true`
 *   - `outcome.dirtyTreeCheckOutcome === "performed"`
 *   - `outcome.unrelatedDirtyPaths.length > 0`
 * Otherwise empty (D69 audit-field refine).
 *
 * Returns `ReceiptFileSchema.parse(receipt)`.
 */
export async function buildReceiptForApply(
  params: BuildReceiptForApplyParams,
): Promise<ReceiptFile> {
  let results: readonly RollbackFileResult[];
  let failures: readonly RollbackFailure[];

  try {
    await restoreCheckpoint(params.checkpointDir, {
      repoRoot: params.repoRoot,
      rollbackExcludePatterns: params.rollbackExcludePatterns,
      allowHeadMismatch: params.outcome.allowHeadMismatch,
    });
    results = synthesizeResultsFromPlan(params.preRestorePlan);
    failures = [];
  } catch (err) {
    const classified = classifyRestoreError(err);
    results = [];
    failures = classified.failures;
  }

  const forcedUnrelatedDirtyPaths: readonly string[] =
    params.forced &&
    params.outcome.dirtyTreeCheckOutcome === "performed" &&
    params.outcome.unrelatedDirtyPaths.length > 0
      ? params.outcome.unrelatedDirtyPaths
      : [];

  const receipt = {
    schema_version: RECEIPT_FILE_SCHEMA_VERSION,
    rollback_id: params.rollbackId,
    session_id: params.session.session_id,
    checkpoint_id: params.session.checkpoint_id,
    mode: "apply" as const,
    forced: params.forced,
    written_at: params.writtenAt,
    pre_rollback_checkpoint_id: params.preRollbackCheckpointId,
    results,
    failures,
    forced_unrelated_dirty_paths: forcedUnrelatedDirtyPaths,
    dirty_tree_check: params.outcome.dirtyTreeCheckOutcome,
    out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
    ...(params.outcome.unEndedSessionWarning ? { un_ended_session_warning: true as const } : {}),
  };

  return ReceiptFileSchema.parse(receipt);
}
