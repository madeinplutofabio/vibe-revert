// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert rollback <session-id> [--only|--except|--finding|--risk]
//                                   [--apply] [--force] [--json|--markdown]`
// Restores a session's pre-session captured state per M D D59, in whole or in
// part.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
//  1. **D67 rollback lock is acquired before any rollback-state I/O
//     or mutation.** `resolveRepoRoot` and pure argument validation
//     happen before the lock because the lock path depends on
//     repoRoot. Everything that reads rollback-relevant state
//     (config, active-session lock, session+manifest, status/head,
//     existing apply receipt) or mutates anything (emergency
//     checkpoint, restoreCheckpoint, receipt persistence) runs
//     INSIDE the lock. The lock is released only after the receipt
//     is atomically written via writeFileAtomic. ("Atomic" means
//     temp-write + rename, not fsync-durable — writeFileAtomic
//     does NOT fsync per the M B helper definition; a power loss
//     after rename but before flush could lose the just-written
//     receipt. Durability is out of scope for M D and tracked as
//     a separate concern.)
//
//  2. **D75 force-policy scope.** `--force` bypasses ONLY D64
//     head_mismatch, D61b un_ended_session, and D61 dirty_tree.
//     It NEVER bypasses D63 active_session, D70 already_applied,
//     SessionNotFoundError, CheckpointArtifactsMissingError,
//     ApplyReceiptCorruptError, RollbackEmergencyCheckpointError,
//     or post-restore verification failures. The CLI never adds
//     force-bypass holes beyond the three the orchestration
//     enforces in checkRefusals.
//
//  3. **Dry-run is inspection-only.** No D65 emergency checkpoint,
//     no restoreCheckpoint call, no working-tree mutation. Dry-run
//     produces a receipt describing what apply WOULD do (via
//     planRestoreCheckpoint), writes it to the dry-run path per
//     D68, and renders it. The branch is strict on `this.apply` —
//     there is no code path that mutates without --apply.
//
//  4. **D68 receipt path split via named helpers.** Three named
//     accessors compute the canonical paths from (repoRoot,
//     sessionId): `rollbackDryRunReceiptPath`,
//     `rollbackApplyReceiptPath`, `existingApplyReceiptPath`. NO
//     inline `join(repoRoot, ".viberevert", "sessions", sessionId,
//     ...)` for receipt paths anywhere in `execute()` or its
//     helpers. Refactor-safe: if D68 paths ever need to change,
//     exactly three functions need updating.
//
//  5. **Existing apply receipt parsing fails CLOSED.** The only
//     return value of `loadExistingApplyReceipt` that means "no
//     existing apply receipt" is `null` AND that requires the
//     file to be genuinely absent (ENOENT). Every other failure
//     mode — non-ENOENT read failure (EACCES, ENOTDIR, EISDIR,
//     etc.), JSON parse failure, schema-validation failure, wrong
//     mode, null pre_rollback_checkpoint_id, foreign session_id —
//     throws `ApplyReceiptCorruptError`. The CLI never silently
//     treats a corrupted receipt as "go ahead and apply again."
//
//  6. **D17b: temp-dir + rename for the D65 emergency checkpoint.**
//     The CLI creates `.viberevert/checkpoints/.tmp-checkpoint-<random>/`
//     via `randomBytes` (NOT id-bearing — git owns checkpoint
//     identity), calls `createCheckpoint` which generates
//     `cp_<ULID>` internally, then atomically renames to the final
//     `cp_<ID>/` via the CLI's private `renameDirAtomic`. All of
//     this is encapsulated in `createEmergencyCheckpoint(...)`
//     from `../emergency-checkpoint.ts`. The temp+rename logic
//     appears EXACTLY ONCE (inside that helper). It is NEVER
//     inlined inside `execute()`.
//
//  7. **D5b name-collision protection for the D65 emergency
//     checkpoint name.** Emergency checkpoints are named
//     `pre-rollback-<truncated-target-sess>` using the
//     package-internal `truncateSessionIdForCheckpointName` helper
//     in `../emergency-checkpoint.ts` (NOT
//     a display-formatting helper — the name is persisted in
//     manifest.name and surfaced by `viberevert checkpoints`, so
//     the truncation rule must be ASCII-stable and version-stable).
//     `createEmergencyCheckpoint` acquires the nested
//     `checkpoint-name.lock`, calls `safeListCheckpoints` to
//     enumerate existing names, and uses a suffix-counter
//     (`-2`, `-3`, ...) to find a unique name. The collision
//     scan happens inside both the rollback lock AND the
//     checkpoint-name lock — no concurrent named-checkpoint
//     creator can race in between the scan and the
//     createCheckpoint call.
//
//  8. **Nested-lock ordering invariant (deadlock prevention).**
//     Outer: `.viberevert/.locks/rollback.lock`, acquired through
//     `withRollbackLock` from `../rollback-lock.ts`. Inner (around
//     D65 only): `.viberevert/.locks/checkpoint-name.lock`, nested
//     inside it by `createEmergencyCheckpoint`. The
//     order is rollback → checkpoint-name, NEVER the reverse.
//     The only other code path that touches `checkpoint-name.lock`
//     is `CheckpointCommand`, which does NOT acquire
//     `rollback.lock` — so there is no possible cycle. Any future
//     command that needs both locks MUST follow rollback →
//     checkpoint-name order.
//
//  9. **D29 reporter/checks discipline.** This module imports the
//     public `renderReceipt` dispatcher from `@viberevert/reporters`,
//     not any per-format helper. It does NOT import any
//     `@viberevert/checks` symbol — rollback has no findings to
//     evaluate.
//
// 10. **D17c: CLI owns writeFileAtomic + renameDirAtomic + locks.**
//     This module uses the CLI-private helpers from `../atomic.js`
//     and `../locks.js`. It does NOT import core's atomic helpers
//     (which would violate the D17c discipline that keeps CLI
//     orchestration's persistence semantics self-contained).
//
// 11. **D66 exit codes.** 0 = successful rollback (apply clean
//     OR dry-run, regardless of receipt.failures content on
//     dry-run — preflight failures surface in receipt.failures
//     but don't change the dry-run exit code per the rule that
//     dry-run is informational). 1 = refusals, missing/corrupt
//     artifacts, lock contention, post-restore failures (apply
//     with non-empty receipt.failures), validation errors,
//     receipt-write I/O failures, emergency-checkpoint creation
//     failures, internal errors. NO exit 2 from rollback.
//
// 12. **JSON serialization at the CLI seam.** `renderReceipt(input,
//     "json")` returns `unknown` (the underlying ReceiptFile
//     reference per D38 schema-verbatim). The CLI is responsible
//     for `JSON.stringify(rendered, null, 2) + "\n"` before stdout
//     write. Terminal/markdown overloads return `string` and write
//     directly. The format-branch at the render+write step is
//     explicit, NOT a one-liner.
//
// 13. **Timestamp policy (revised in M 0.8.0 step 12).** The
//     pre-lock `resolveNowForCliTimestamp()` sample now feeds ONLY
//     the D22 lock metadata's `started_at`, which is exactly what
//     that field means. Receipts are stamped INSIDE the lock,
//     immediately before each is mapped, because a `written_at`
//     chosen before an unbounded wait describes when the command
//     was typed rather than when its receipt was produced. The
//     legacy full path still samples once per operation, so its
//     emergency checkpoint's `capturedAt` and its receipt's
//     `written_at` remain equal to each other. `resolveNowForCliTimestamp`
//     is the only clock this file reads; no `Date.now()`/`new Date()`
//     appears here or in the locked phase.
//
// 14. **D74 unlock dependency.** Step 7 also updates
//     `commands/start.ts` to remove the "MUST NOT name viberevert
//     rollback" lock and add the `end && rollback` sequencing
//     pairing to its refusal copy. The corresponding assertion
//     in `test/start-end.test.ts:494` flips from `.not.toContain`
//     to `.toContain`. Those changes land in the SAME commit
//     as this file.
//
// 15. **Shared CLI-local helper extracted after Step 9.**
//     `safeListCheckpoints` and `CollisionExitSentinel` live in
//     `packages/cli/src/checkpoint-helpers.ts`, imported here AND
//     by `commands/checkpoint.ts`. The module stays in
//     `packages/cli/src/` — NOT in `@viberevert/core`, `/git`, or
//     `/session-format` — because both helpers are command UX
//     plumbing (clean-stderr handling for the corruption-error
//     classes, plus the typed sentinel for exit-1-cleanly). The
//     module is CLI-internal (no barrel re-export).
//
// 16. **Apply receipt = apply ATTEMPT, not successful mutation.**
//     The apply receipt is written for EVERY --apply invocation
//     that reaches the receipt-build stage, regardless of whether
//     restoreCheckpoint succeeded. Failed apply attempts produce
//     receipts with populated failures[] and empty results[] per
//     D76 conservative semantics. D70's already-applied refusal
//     then fires on the EXISTENCE of an apply receipt, regardless
//     of failure content — because after an apply attempt the
//     tree state is no longer trusted as post-session, and the
//     emergency pre-rollback checkpoint (pre_rollback_checkpoint_id
//     in the receipt) is the recovery path. To retry after a
//     failed apply, the user must recover from the emergency
//     checkpoint first.
//
//     An --apply invocation does NOT produce an apply receipt in
//     these cases (complete enumeration):
//       (a) Pure pre-lock CLI failure — invalid flag combination,
//           repo-root resolution failure, --json/--markdown
//           conflict, malformed session-id, RuntimeEnvInvalidError.
//           No state has been touched; the user can retry cleanly.
//       (b) Outer rollback-lock contention — ConcurrentOperationError
//           on rollback.lock. No mutation. Retry once the holder
//           releases.
//       (c) Inside-lock metadata-load failure — ConfigParseError /
//           ConfigValidationError / SessionNotFoundError /
//           CheckpointArtifactsMissingError /
//           ApplyReceiptCorruptError. No mutation, no emergency CP.
//           Retry after fixing the underlying artifact.
//       (d) Pre-mutation refusal — checkRefusals throws any of the
//           D63/D70/D64/D61b/D61 refusal types (subject to D75
//           force policy). No emergency CP, no mutation.
//       (e) Inner checkpoint-name lock contention —
//           ConcurrentOperationError on the nested lock during D65.
//           No emergency CP, no mutation. Retry once the holder
//           releases.
//       (f) Checkpoint-list corruption during D65 collision scan —
//           CollisionExitSentinel from safeListCheckpoints. No
//           emergency CP, no mutation. Fix the corrupted checkpoint
//           metadata before retry.
//       (g) Emergency-checkpoint create/rename failure —
//           RollbackEmergencyCheckpointError. No emergency CP
//           usable, no restore attempted, no mutation. Retry after
//           fixing the underlying fs/git/permission issue.
//       (h) **Receipt-write failure AFTER restore** —
//           RollbackReceiptWriteError thrown by writeReceiptAtomically
//           AFTER restoreCheckpoint already mutated the working
//           tree. This is the only case where mutation may have
//           occurred without a persisted receipt. The error message
//           MUST surface the emergency checkpoint id and name
//           (the receipt that would have carried
//           pre_rollback_checkpoint_id is missing, so the error
//           message is the only place that surface lives). The
//           user must restore from that emergency checkpoint
//           BEFORE retrying rollback, otherwise the next --apply
//           would layer a partial apply on top of partial state.
//
//     Cases (a)-(g) are clean retry; case (h) requires manual
//     recovery via the emergency checkpoint surfaced in the error
//     message.
//
// 17. **The locked region lives in `../rollback-locked-phase.ts`.**
//     `execute()` performs pure argument validation, acquires the
//     lock EXACTLY ONCE, and renders. Every rollback-state read,
//     the admission decision, and all four operation cells belong
//     to `runLockedRollbackPhase`. Locks #1, #3, #4, #5, #6, #13
//     and #16 are enforced THERE now; they remain stated here
//     because this is the command they constrain. The moved
//     symbols keep their names, so a search for
//     `loadExistingApplyReceipt` or `rollbackApplyReceiptPath`
//     still lands on one definition.
//
// 18. **Refusals arrive as values; only faults throw.** The locked
//     phase returns `decision: "refused"` rather than throwing,
//     because a throw from inside the lock callback discards the
//     result `withRollbackLockCapturingRelease` exists to preserve.
//     Legacy refusals are rendered post-lock through
//     `refusalError`, their single owner, so the copy stays
//     identical to what `checkRefusals` throws.
//
// 19. **A lock-release failure forces exit 1 without hiding the
//     outcome.** The stale lock directory is reported to stderr
//     FIRST, before anything that can re-throw, and the operation's
//     own result is still rendered in full. The two are independent
//     facts: a rollback can succeed exactly as intended and still
//     leave a lock nobody will release, and the next command cannot
//     run until an operator removes it.
//
// 20. **Selectors are validated pre-lock and BOUND to their mode.**
//     `--risk` is checked against the four levels and `--finding`
//     against the full `fnd_<64 hex>` shape before the lock, like
//     the session-id check. `resolveRollbackSelectionMode` then
//     returns a value carrying the selectors on the selective arm
//     and nothing on the full arm, so no downstream caller can pair
//     a mode with selectors that contradict it.

import { hostname } from "node:os";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  RepoRootNotFoundError,
  resolveRepoRoot,
  SessionNotFoundError,
} from "@viberevert/core";
import { GitNotAvailableError } from "@viberevert/git";
import {
  type ReceiptRenderInput,
  renderReceipt,
  renderSelectiveReceipt,
  type SelectiveReceiptRenderInput,
} from "@viberevert/reporters";
import {
  type RiskLevel,
  RiskLevelSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  type SelectiveRollbackReceipt,
} from "@viberevert/session-format";
import { Command, Option } from "clipanion";

import type { BoundSelectionInvalidReason } from "../bound-selective-restore.js";
import { CollisionExitSentinel } from "../checkpoint-helpers.js";
import { RollbackEmergencyCheckpointError } from "../emergency-checkpoint.js";
import { ConcurrentOperationError, type LockInfo } from "../locks.js";
import type { RollbackAdmissionRefusal } from "../rollback-admission.js";
import { withRollbackLockCapturingRelease } from "../rollback-lock.js";
import {
  ApplyReceiptCorruptError,
  type LockedRollbackOutcome,
  RollbackReceiptWriteError,
  type RollbackSelectionMode,
  resolveRollbackSelectionMode,
  runLockedRollbackPhase,
  type SelectiveRollbackOutcome,
} from "../rollback-locked-phase.js";
import {
  CheckpointArtifactsMissingError,
  RollbackActiveSessionRefusalError,
  RollbackAlreadyAppliedError,
  RollbackDirtyTreeRefusalError,
  RollbackHeadMismatchError,
  RollbackUnEndedSessionRefusalError,
  refusalError,
} from "../rollback-orchestration.js";
import {
  RuntimeEnvInvalidError,
  resolveNowForCliTimestamp,
  resolveProductVersionForReport,
} from "../runtime-env.js";
import type { SelectionSelectors } from "../selection-resolver.js";
import type { SelectiveApplyOutcome } from "../selective-apply-result.js";
import type { VerifyCommandsResult } from "../verify-commands.js";

// =============================================================================
// Constants
// =============================================================================

// The D65 emergency checkpoint's lock path, name-length constant, and
// truncation helper now live in `../emergency-checkpoint.ts` alongside the
// creation sequence they serve. `rollback.lock` is owned by
// `../rollback-lock.ts`.

// =============================================================================
// Moved to `../rollback-locked-phase.ts`
// =============================================================================
//
// `ApplyReceiptCorruptError`, `RollbackReceiptWriteError`, the three D68 path
// helpers, `loadExistingApplyReceipt` and `writeReceiptAtomically` all moved
// with the locked phase that uses them. They are imported back here only so
// `handleKnownError` can keep surfacing their locked copy verbatim.

// =============================================================================
// Pure helpers
// =============================================================================

/**
 * Build the human-readable invocation command string for D22
 * lock metadata. Surfaced verbatim in `ConcurrentOperationError`'s
 * refusal copy so a competing invocation's stderr clearly
 * identifies what the lock-holder is doing.
 */
function buildInvocationCommandString(args: {
  readonly session: string;
  readonly apply: boolean;
  readonly force: boolean;
  readonly format: "terminal" | "markdown" | "json";
  readonly selectors: SelectionSelectors;
}): string {
  const parts = [`viberevert rollback ${args.session}`];
  // Selectors first, in the order they are declared, and repeated once per
  // supplied value. A competing invocation's refusal copy shows this string
  // verbatim, and "another rollback is running" is far less useful when it
  // omits WHICH changes that rollback is touching.
  for (const value of args.selectors.only) parts.push(`--only ${value}`);
  for (const value of args.selectors.except) parts.push(`--except ${value}`);
  for (const value of args.selectors.finding) parts.push(`--finding ${value}`);
  if (args.selectors.risk !== undefined) parts.push(`--risk ${args.selectors.risk}`);
  if (args.apply) parts.push("--apply");
  if (args.force) parts.push("--force");
  if (args.format === "json") parts.push("--json");
  else if (args.format === "markdown") parts.push("--markdown");
  return parts.join(" ");
}

/**
 * One line per admission refusal this command must render itself.
 *
 * The LEGACY refusals are not here: they go through `refusalError`, which is
 * their single owner and carries the locked copy `checkRefusals` throws. Only
 * the selective-history dimension, which produces values and never errors,
 * needs its own rendering.
 */
function describeSelectiveHistoryRefusal(
  refusal: Extract<RollbackAdmissionRefusal, { readonly source: "selective_history" }>["refusal"],
): string {
  switch (refusal.kind) {
    case "history_fault":
      return (
        `Cannot proceed: this session's selective rollback history could not be established ` +
        `(${refusal.fault.outcome} at ${refusal.fault.path}: ${refusal.fault.detail}).\n` +
        `A rollback that cannot read its own history cannot tell whether a prior apply left the tree partly restored.\n` +
        `Re-run without --apply to inspect the session; fix or remove the artifact above before applying.\n`
      );
    case "prior_apply_incomplete":
      return (
        `Cannot proceed: a prior selective rollback (${refusal.blocker.rollbackId}, ${refusal.blocker.writtenAt}) ` +
        `did not finalize, so the working tree may be partly restored.\n` +
        `Restore from its pre-rollback checkpoint ${refusal.blocker.preRollbackCheckpointId} first:\n` +
        `  viberevert rollback --checkpoint ${refusal.blocker.preRollbackCheckpointId}\n` +
        (refusal.allBlockers.length > 1
          ? `${refusal.allBlockers.length} invocations are blocking; the one above is the earliest, and its checkpoint is the last state before any damage.\n`
          : "")
      );
    case "selective_apply_already_applied":
      return (
        `Cannot proceed: surgical recovery has already begun on this session ` +
        `(${refusal.appliedInvocations.join(", ")}), and a whole-session rollback has no way to reason about a tree ` +
        `already modified by selective operations.\n` +
        `To finish restoring the rest of the contribution, use the selective engine:\n` +
        `  viberevert rollback <session> --only '**' --apply\n`
      );
    default: {
      const unhandled: never = refusal;
      return unhandled;
    }
  }
}

/** Cleanup warnings are advisory: they never change the exit status. */
function writeCleanupWarnings(
  stderr: { write(s: string): unknown },
  warnings: readonly string[],
): void {
  for (const warning of warnings) {
    stderr.write(`  cleanup: ${warning}\n`);
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Why the selectors could not be resolved.
 *
 * Exhaustive over the resolver's reasons plus the one the composer owns. Each
 * says what to do next, because every member here is a user-fixable condition
 * rather than a repository fault.
 */
function describeSelectionInvalid(reason: BoundSelectionInvalidReason): string {
  switch (reason.code) {
    case "CONTRIBUTION_REQUIRED":
      return (
        "This session has no durable contribution, so there is nothing to select from.\n" +
        "Only sessions ended by VibeRevert 0.8.0 or later record one; an earlier session's\n" +
        "after-state is physically gone and cannot be reconstructed.\n" +
        "Whole-session rollback still works: re-run without any selector.\n"
      );
    case "REPORT_REQUIRED":
      return (
        "--risk and --finding are resolved against a session report, and none was supplied.\n" +
        "Run `viberevert check --since <session>` first, then re-run this rollback.\n"
      );
    case "FINDING_NOT_FOUND":
      return (
        `No finding in this session's report has the id ${JSON.stringify(reason.selector)}.\n` +
        "List the available ids with `viberevert check --since <session> --json`.\n"
      );
    case "FINDING_PREFIX_AMBIGUOUS":
      return (
        `The finding id ${JSON.stringify(reason.selector)} matches more than one finding:\n` +
        `${reason.matches.map((id) => `  ${id}\n`).join("")}` +
        "Supply the full id.\n"
      );
    case "FINDING_HAS_NO_RESTORABLE_PATH":
      return (
        `Finding ${reason.findingId} names no changed file, so it selects nothing to restore.\n` +
        "Advisory findings, such as a suggestion to add a test, have no path to roll back.\n"
      );
    case "STALE_OR_MISSING_REPORT":
      return (
        `The report cannot be used for this session: ${reason.detail}\n` +
        "Re-run `viberevert check --since <session>` to produce one bound to the current\n" +
        "contribution, then re-run this rollback.\n"
      );
    default: {
      const unhandled: never = reason;
      return unhandled;
    }
  }
}

/**
 * Why the preview produced no receipt.
 *
 * The three phases are different facts and get different copy. Only `preview`
 * means the classification never completed; the other two mean the answer
 * exists and could not be recorded, which is a strictly smaller problem.
 */
function describePreviewFailure(
  phase: "preview" | "map_receipt" | "write_receipt",
  cause: unknown,
): string {
  const detail = messageOf(cause);
  switch (phase) {
    case "preview":
      return (
        `The selective preview could not classify this session's selected paths: ${detail}\n` +
        "Nothing was mutated. The session checkpoint is materialized in a scratch worktree\n" +
        "to answer this, so a failure here usually means that checkpoint is unreadable.\n"
      );
    case "map_receipt":
      return (
        `The preview completed, but its result cannot be expressed as a receipt: ${detail}\n` +
        "Nothing was mutated. This is a defect rather than a repository problem; the\n" +
        "message above states which invariant the result violated.\n"
      );
    case "write_receipt":
      return (
        `The preview completed, but its receipt could not be written: ${detail}\n` +
        "Nothing was mutated. Fix the underlying filesystem problem and re-run.\n"
      );
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

/**
 * An apply that produced no receipt.
 *
 * Exhaustive over every non-finalized arm, and the ordering principle is what
 * the reader must DO. Arms that prove nothing was authorized say so plainly;
 * arms that cannot prove it say that instead and surface the recovery handle.
 * Collapsing the two would either strand a user beside a half-restored tree or
 * send them recovering from a rollback that never began.
 */
function describeUnfinishedApply(outcome: SelectiveApplyOutcome<VerifyCommandsResult>): string {
  const recoveryHint = (checkpointId: string): string =>
    `The pre-rollback emergency checkpoint is ${checkpointId}.\n` +
    `Restore from it BEFORE any further rollback, or the next apply layers on top of\n` +
    `a tree whose state is not known.\n`;

  switch (outcome.kind) {
    case "not_attempted":
      return outcome.stage === "before_recovery_checkpoint"
        ? `The selective rollback stopped before it began, at the ${outcome.transaction.outcome} stage.\n` +
            "No emergency checkpoint was created and nothing was mutated. Retry is safe.\n"
        : `The selective rollback stopped after its emergency checkpoint was created but\n` +
            `before any mutation was authorized (established by ${outcome.source}).\n` +
            "Nothing was mutated. Retry is safe; the unused checkpoint " +
            `${outcome.recovery.checkpointId} can be deleted.\n`;

    case "recovery_checkpoint_unavailable":
      return (
        "The pre-rollback emergency checkpoint could not be created, so the rollback was\n" +
        `not authorized to mutate anything (${outcome.recovery.status}).\n` +
        "Nothing was mutated. Fix the underlying problem and retry.\n"
      );

    case "publication_indeterminate":
      // The one arm where the tree may genuinely be half-restored.
      return (
        "The selective rollback may have started mutating and cannot prove whether it did.\n" +
        `Inspecting its invocation directory was inconclusive: ${outcome.inspection.detail}\n` +
        "Treat the working tree as untrusted.\n" +
        recoveryHint(outcome.recovery.checkpointId)
      );

    case "finalization_failed":
      return outcome.failure.phase === "map_receipt"
        ? "The selective rollback ran, and its receipt could not be assembled:\n" +
            `  ${messageOf(outcome.failure.cause)}\n` +
            "No receipt exists, so the next apply will fail closed on the attempt marker.\n" +
            recoveryHint(outcome.recovery.checkpointId)
        : `The selective rollback ran, and its receipt could not be published ` +
            `(${outcome.failure.reason}):\n` +
            `  ${messageOf(outcome.failure.cause)}\n` +
            "No receipt exists, so the next apply will fail closed on the attempt marker.\n" +
            recoveryHint(outcome.recovery.checkpointId);

    case "internal_mapping_failure":
      return (
        `The rollback reached a state its own bookkeeping cannot describe: ${outcome.detail}\n` +
        "This is a defect. Whether the tree was mutated is unknown.\n" +
        (outcome.recovery.status === "created"
          ? recoveryHint(outcome.recovery.checkpointId)
          : `No emergency checkpoint was recorded (${outcome.recovery.status}).\n`)
      );

    case "finalized":
      // Handled by the caller, which has the receipt to render. Reached only
      // if that branch is ever removed, and saying so beats a blank line.
      return "The selective rollback finalized, but its receipt was not rendered.\n";

    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

// =============================================================================
// Centralized typed-error → stderr mapping
// =============================================================================

/**
 * Map typed errors to clean stderr + exit 1. Mirrors check.ts's
 * `handleKnownError` pattern. Unknown errors re-throw so
 * Clipanion surfaces them as a crash with stack trace.
 *
 * The 6 orchestration error classes (CheckpointArtifactsMissingError,
 * RollbackActiveSessionRefusalError, RollbackAlreadyAppliedError,
 * RollbackHeadMismatchError, RollbackUnEndedSessionRefusalError,
 * RollbackDirtyTreeRefusalError) carry user-friendly messages
 * per Step 6's locked error-class designs. Surface them verbatim.
 *
 * ApplyReceiptCorruptError, RollbackReceiptWriteError, and
 * RollbackEmergencyCheckpointError are CLI-internal classes
 * (defined above) and similarly carry locked copy.
 * RollbackReceiptWriteError additionally carries the D65
 * emergency checkpoint id/name in its message body (per lock #16
 * case (h)) — surfacing the recovery handle to the user when the
 * receipt itself failed to persist.
 *
 * CollisionExitSentinel is recognized as a refusal-already-printed
 * signal — no additional stderr write.
 */
function handleKnownError(stderr: { write(s: string): unknown }, err: unknown): number {
  if (err instanceof CollisionExitSentinel) {
    // safeListCheckpoints already wrote the refusal message.
    return 1;
  }
  if (err instanceof RepoRootNotFoundError) {
    stderr.write(
      "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
    );
    stderr.write("Run `viberevert init` to create a project here.\n");
    return 1;
  }
  if (err instanceof ConfigNotFoundError) {
    stderr.write("No .viberevert.yml found in this repo.\n");
    stderr.write("Run:\n");
    stderr.write("  viberevert init\n\n");
    stderr.write("to create one.\n");
    return 1;
  }
  if (err instanceof ConfigParseError || err instanceof ConfigValidationError) {
    stderr.write(`Invalid .viberevert.yml: ${err.message}\n`);
    stderr.write("Fix the file, or re-run:\n");
    stderr.write("  viberevert init\n\n");
    stderr.write("to start fresh.\n");
    return 1;
  }
  if (
    err instanceof SessionNotFoundError ||
    err instanceof CheckpointArtifactsMissingError ||
    err instanceof ApplyReceiptCorruptError ||
    err instanceof RollbackActiveSessionRefusalError ||
    err instanceof RollbackAlreadyAppliedError ||
    err instanceof RollbackHeadMismatchError ||
    err instanceof RollbackUnEndedSessionRefusalError ||
    err instanceof RollbackDirtyTreeRefusalError ||
    err instanceof RollbackReceiptWriteError ||
    err instanceof RollbackEmergencyCheckpointError ||
    err instanceof RuntimeEnvInvalidError
  ) {
    // These error classes carry locked, user-friendly messages.
    // Surface them verbatim.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  if (err instanceof GitNotAvailableError) {
    stderr.write(`git is not available: ${err.message}\n`);
    return 1;
  }
  if (err instanceof ConcurrentOperationError) {
    // D22 locked refusal copy with TWO variants depending on
    // whether lock.json was readable. The lock dir path surfaces
    // verbatim from the error so the user can remove it manually
    // if it's stale (the path differs depending on which lock
    // contended — outer rollback.lock or inner checkpoint-name.lock).
    stderr.write(
      err.info !== null
        ? `Another viberevert operation is already running:\n  command:  ${err.info.command}\n  pid:      ${err.info.pid}\n  since:    ${err.info.started_at}\n\nIf you're sure that command isn't running anymore (e.g., crashed),\nremove this stale lock directory manually:\n  ${err.lockDir}\n`
        : `Another viberevert operation is already running (lock metadata unavailable).\n\nIf you're sure no other viberevert command is running,\nremove this stale lock directory manually:\n  ${err.lockDir}\n`,
    );
    return 1;
  }
  // Unknown error — re-throw so Clipanion surfaces it.
  throw err;
}

// =============================================================================
// Command class
// =============================================================================

export class RollbackCommand extends Command {
  static override paths = [["rollback"]];

  static override usage = Command.Usage({
    description: "Restore a session's pre-session captured state (dry-run by default)",
    details: `
Restores the working tree, index, and untracked files to the state captured at the
start of <session-id>. Default behavior is dry-run: produces a receipt describing
what apply WOULD do, without mutating anything. Use --apply for actual restoration.

Safety preconditions checked before mutation:
- Active-session: cannot roll back a still-active session (run 'viberevert end' first).
- Already-applied: cannot re-apply rollback to an already-rolled-back session.
- HEAD-mismatch: refuses if current HEAD differs from the checkpoint's captured HEAD;
  --force overrides (best-effort restore onto a different HEAD).
- Un-ended-session: refuses if the session has no machine-readable after-status
  snapshot; --force overrides.
- Dirty-tree: refuses if the working tree has unrelated dirty paths outside the
  session's expected rollback target; --force overrides.

--force NEVER bypasses: active-session refusal, already-applied refusal, missing or
corrupt checkpoint artifacts, post-restore verification failures.

Apply mode creates an EMERGENCY pre-rollback checkpoint of the current working tree
BEFORE the restore mutation, named "pre-rollback-<truncated-sess-id>". The receipt
records its ID for recovery.

SELECTIVE ROLLBACK. With no selector this restores the whole session, exactly as it
always has. Supplying ANY selector, including --except on its own, restores only the
change groups it resolves to, and leaves every other managed path untouched:

- --only / --except take path globs and match a renamed file through its whole alias
  set, so --only 'payments/**' still matches a file renamed out of payments/.
- --risk <level> is an AT-OR-ABOVE threshold, so --risk high covers high and critical.
- --finding <id> takes finding ids from \`viberevert check --since <session>\`.
- Different positive families INTERSECT; --except is subtracted last; exclusion is
  group-atomic, so excluding any path in a rename group excludes the group.

Selective rollback needs the session's durable contribution, which sessions ended
before 0.8.0 do not have. It refuses rather than guessing when the world moved on.

${ROLLBACK_OUT_OF_SCOPE_NOTICE}
    `,
    examples: [
      ["Dry-run: see what rollback would do", "$0 rollback sess_01JV8Z0N6E7ABCDEFGHJKMNPQR"],
      ["Apply rollback", "$0 rollback sess_01JV8Z0N6E7ABCDEFGHJKMNPQR --apply"],
      [
        "Force apply over dirty/HEAD-mismatch state",
        "$0 rollback sess_01JV8Z0N6E7ABCDEFGHJKMNPQR --apply --force",
      ],
      ["Emit machine-readable JSON receipt", "$0 rollback sess_01JV8Z0N6E7ABCDEFGHJKMNPQR --json"],
      [
        "Preview restoring only the payments changes",
        "$0 rollback sess_01JV8Z0N6E7ABCDEFGHJKMNPQR --only 'payments/**'",
      ],
      [
        "Restore every high-and-above change, keeping tests",
        "$0 rollback sess_01JV8Z0N6E7ABCDEFGHJKMNPQR --risk high --except 'tests/**' --apply",
      ],
    ],
  });

  session = Option.String();

  apply = Option.Boolean("--apply", false, {
    description: "Actually apply the rollback (mutates the working tree). Default is dry-run.",
  });

  force = Option.Boolean("--force", false, {
    description:
      "Bypass D64/D61b/D61 safety preconditions. Requires --apply. NEVER bypasses state-machine invariants or post-restore verification.",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the receipt as JSON to stdout. Mutually exclusive with --markdown.",
  });

  markdown = Option.Boolean("--markdown", false, {
    description:
      "Emit the receipt as CommonMark markdown to stdout. Mutually exclusive with --json.",
  });

  // ---------------------------------------------------------------------------
  // Selectors. ANY of them, including --except alone, enters selective mode.
  // ---------------------------------------------------------------------------

  only = Option.Array("--only", [], {
    description:
      "Restore only change groups matching this glob. Repeatable (union). Matches renamed paths through their whole alias set.",
  });

  except = Option.Array("--except", [], {
    description:
      "Exclude change groups matching this glob. Repeatable (union), subtracted last, and group-atomic.",
  });

  finding = Option.Array("--finding", [], {
    description:
      "Restore the change groups a finding applies to. Repeatable (union). Requires a report from `viberevert check --since`.",
  });

  risk = Option.String("--risk", {
    description:
      "Restore change groups at or above this risk level (low|medium|high|critical). A threshold, not an exact match.",
  });

  override async execute(): Promise<number> {
    // -------------------------------------------------------------------------
    // PRE-LOCK PHASE (lock #1 honors: only repoRoot resolution and pure
    // argument validation here; everything that reads rollback-relevant
    // state runs inside the lock).
    // -------------------------------------------------------------------------

    // Step A: resolve repo root. Needed for the lock path itself.
    let repoRoot: string;
    try {
      repoRoot = resolveRepoRoot();
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // Step B: pure flag-combination validation.
    //   - --force without --apply is invalid (per D61b lock).
    //   - --json and --markdown are mutually exclusive (per D20/D45).
    if (this.force && !this.apply) {
      this.context.stderr.write(
        "--force has no effect without --apply. Use 'viberevert rollback <sess>' for dry-run or 'viberevert rollback <sess> --apply --force' to force-apply.\n",
      );
      return 1;
    }
    if (this.json && this.markdown) {
      this.context.stderr.write("--json and --markdown are mutually exclusive.\n");
      return 1;
    }

    // Step C: validate session-id shape (D5 ULID format). Catches
    // typos before the lock so refusal is fast.
    if (!/^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(this.session)) {
      this.context.stderr.write(
        `Invalid session id ${JSON.stringify(this.session)}. ` +
          `Expected the form sess_<26-character Crockford ULID>.\n`,
      );
      return 1;
    }
    const sessionId = this.session;

    // Step C2: validate --risk before the lock, like every other pure
    // argument check. Clipanion accepts any string, and a typo must not
    // survive as far as a selection that silently matches nothing.
    let risk: RiskLevel | undefined;
    if (this.risk !== undefined) {
      const parsed = RiskLevelSchema.safeParse(this.risk);
      if (!parsed.success) {
        this.context.stderr.write(
          `Invalid --risk ${JSON.stringify(this.risk)}. ` +
            `Expected one of: ${RiskLevelSchema.options.join(", ")}.\n`,
        );
        return 1;
      }
      risk = parsed.data;
    }

    // Step C3: --finding takes FULL finding ids. The locked selection
    // semantics allow an unambiguous short prefix, and resolving one to the
    // full id the attempt marker must persist needs the resolver to report
    // which id it matched. Until it does, a prefix is refused here rather
    // than persisted as itself, which would make the marker unreadable after
    // a crash, which is the one thing that artifact exists to survive.
    const badFinding = this.finding.find((value) => !/^fnd_[0-9a-f]{64}$/.test(value));
    if (badFinding !== undefined) {
      this.context.stderr.write(
        `Invalid --finding ${JSON.stringify(badFinding)}. ` +
          `Expected a full finding id of the form fnd_<64 lowercase hex>, ` +
          `as printed by \`viberevert check --since <session> --json\`. ` +
          `Short prefixes are not accepted yet.\n`,
      );
      return 1;
    }

    const selectors: SelectionSelectors = {
      only: this.only,
      except: this.except,
      finding: this.finding,
      ...(risk !== undefined ? { risk } : {}),
    };
    // PURE, and it binds the mode to the selectors that produced it, so the
    // locked phase cannot be handed a mode its selectors disagree with.
    const selection: RollbackSelectionMode = resolveRollbackSelectionMode(selectors);

    // Step D: resolve the wall-clock timestamp for the D22 lock metadata.
    // The RECEIPTS no longer read this value: they are stamped inside the
    // lock, immediately before each one is mapped, because a `written_at`
    // sampled here would describe when the command was typed rather than
    // when its receipt was produced. `started_at` is exactly the field that
    // should still be sampled before acquisition. RuntimeEnvInvalidError
    // (a malformed env override) surfaces here, before the lock.
    let now: string;
    try {
      now = resolveNowForCliTimestamp();
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // Step E: resolve product version (used by markdown receipt
    // footer per Step 5 ReceiptRenderInput contract). Resolution
    // can run pre-lock — it doesn't depend on rollback state.
    let productVersion: string;
    try {
      productVersion = resolveProductVersionForReport();
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // Step F: derive mode/force/format from flags and construct
    // lock metadata.
    const mode: "dry_run" | "apply" = this.apply ? "apply" : "dry_run";
    const force = this.force;
    const format: "terminal" | "markdown" | "json" = this.json
      ? "json"
      : this.markdown
        ? "markdown"
        : "terminal";

    const invocationCommand = buildInvocationCommandString({
      session: sessionId,
      apply: this.apply,
      force,
      format,
      selectors,
    });

    const lockInfo: LockInfo = {
      pid: process.pid,
      command: invocationCommand,
      started_at: now,
      host: hostname(),
    };

    // -------------------------------------------------------------------------
    // LOCKED PHASE (per lock #1: ALL rollback-state I/O + mutation here).
    // Locked refusal/mutation order per D76:
    //   D63 active → D70 applied → D64 head → D61b un_ended → D61 dirty
    // -------------------------------------------------------------------------

    let locked: Awaited<ReturnType<typeof withRollbackLockCapturingRelease<LockedRollbackOutcome>>>;
    try {
      locked = await withRollbackLockCapturingRelease(repoRoot, lockInfo, () =>
        runLockedRollbackPhase({
          repoRoot,
          sessionId,
          mode,
          force,
          selection,
          clock: resolveNowForCliTimestamp,
          invocationCommand,
          stderr: this.context.stderr,
        }),
      );
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }
    const outcome = locked.result;

    // -------------------------------------------------------------------------
    // POST-LOCK PHASE: rendering and exit status only. No I/O against
    // rollback state happens below this line.
    // -------------------------------------------------------------------------

    // Written FIRST, and before anything that can re-throw, so a stranded lock
    // directory is reported even when rendering the outcome exits non-locally.
    // The two facts are independent: an operation can have completed exactly as
    // intended and still have left a lock nobody will release.
    if (locked.lockRelease.state === "release_failed") {
      this.context.stderr.write(
        `The rollback completed, but its lock could not be released: ${
          locked.lockRelease.cause instanceof Error
            ? locked.lockRelease.cause.message
            : String(locked.lockRelease.cause)
        }\n` +
          `Remove this stale lock directory before the next viberevert command:\n  ${locked.lockRelease.path}\n`,
      );
    }

    const operationExit = this.renderOutcome(outcome, {
      sessionId,
      mode,
      format,
      productVersion,
    });

    // A stale lock requires operator action, so it forces exit 1 while the
    // outcome above is still reported in full. Reporting success here would
    // let an automated caller move on from a repository the next command
    // cannot operate on.
    return locked.lockRelease.state === "release_failed" ? 1 : operationExit;
  }

  /**
   * Render one locked-phase outcome and return its exit status.
   *
   * Exhaustive over `LockedRollbackOutcome`, so a new arm is a compile error
   * rather than a silent exit 0.
   */
  private renderOutcome(
    outcome: LockedRollbackOutcome,
    context: {
      readonly sessionId: string;
      readonly mode: "dry_run" | "apply";
      readonly format: "terminal" | "markdown" | "json";
      readonly productVersion: string;
    },
  ): number {
    const { stderr, stdout } = this.context;

    switch (outcome.kind) {
      case "refused": {
        // Legacy refusals go through their single owner, so the copy is the
        // same one `checkRefusals` throws and cannot drift from it.
        if (outcome.primary.source === "legacy") {
          return handleKnownError(stderr, refusalError(context.sessionId, outcome.primary.refusal));
        }
        stderr.write(describeSelectiveHistoryRefusal(outcome.primary.refusal));
        return 1;
      }

      case "admission_failed":
        // NOT a refusal: no rule said no, the gate could not ask. Surfaced
        // through the same mapping the cause would have taken had it been
        // thrown, which is exactly what it did before the gate existed.
        return handleKnownError(stderr, outcome.cause);

      case "full": {
        const renderInput: ReceiptRenderInput = {
          file: outcome.receipt,
          productVersion: context.productVersion,
        };
        // Per lock #12: the JSON renderer returns `unknown` (the ReceiptFile
        // reference per D38) and the CLI serializes it; the terminal and
        // markdown overloads return `string` and are written directly.
        if (context.format === "json") {
          stdout.write(`${JSON.stringify(renderReceipt(renderInput, "json"), null, 2)}\n`);
        } else if (context.format === "markdown") {
          stdout.write(renderReceipt(renderInput, "markdown"));
        } else {
          stdout.write(renderReceipt(renderInput, "terminal"));
        }
        // D66: dry run is informational and always 0; apply is 0 only with an
        // empty failure list.
        return context.mode === "dry_run" ? 0 : outcome.receipt.failures.length === 0 ? 0 : 1;
      }

      case "selective":
        return this.renderSelective(outcome.outcome, context);

      default: {
        const unhandled: never = outcome;
        return unhandled;
      }
    }
  }

  /**
   * Render a selective outcome.
   *
   * Follows the split the legacy path already established and the
   * `dirty-refuse-fresh-session` golden asserts: an outcome that produced a
   * RECEIPT goes to stdout through the requested format renderer, and an
   * outcome that produced none is plain diagnostic text on stderr with stdout
   * left empty. Format flags describe how to render an artifact; they do not
   * turn a refusal into one.
   *
   * Exhaustive, with a `never` binding, because several arms exist to say the
   * result could not be determined. Rendering one of those as a bare kind name
   * would leave a user who may have a half-restored tree with no instruction.
   */
  private renderSelective(
    outcome: SelectiveRollbackOutcome,
    context: {
      readonly format: "terminal" | "markdown" | "json";
      readonly productVersion: string;
    },
  ): number {
    const { stderr } = this.context;

    switch (outcome.kind) {
      case "selection_invalid":
        stderr.write(describeSelectionInvalid(outcome.reason));
        return 1;

      case "selection_empty":
        // APPLY only. The dry-run half of an empty resolution is a written
        // `empty_selection` receipt and arrives as `previewed`.
        stderr.write(
          "The selectors matched no change group in this session's contribution, so there is nothing to apply.\n" +
            "Re-run without --apply to record what the selectors resolved to.\n",
        );
        return 1;

      case "preview_failed":
        stderr.write(describePreviewFailure(outcome.phase, outcome.cause));
        writeCleanupWarnings(stderr, outcome.cleanupWarnings);
        return 1;

      case "previewed":
        this.emitSelectiveReceipt(outcome.receipt, context);
        writeCleanupWarnings(stderr, outcome.cleanupWarnings);
        // Informational, exactly as the legacy dry run is: an ineligible
        // preview is a finding to read, not a command failure.
        return 0;

      case "applied": {
        const applied = outcome.outcome;
        if (applied.kind === "finalized") {
          this.emitSelectiveReceipt(applied.receipt, context);
          if (applied.how === "already_identical") {
            stderr.write(
              "This exact receipt was already published for this invocation; it was not rewritten.\n",
            );
          }
          // Success is the CONJUNCTION, not either half. A finalized receipt
          // recording a failed restore is a successfully recorded failure.
          // The `mode` narrowing is what the compiler requires to reach
          // `outcome`, and finalization only ever maps an apply receipt.
          return applied.receipt.mode === "apply" && applied.receipt.outcome === "succeeded"
            ? 0
            : 1;
        }
        stderr.write(describeUnfinishedApply(applied));
        return 1;
      }

      default: {
        const unhandled: never = outcome;
        return unhandled;
      }
    }
  }

  /** One receipt, in the requested format, on stdout. */
  private emitSelectiveReceipt(
    receipt: SelectiveRollbackReceipt,
    context: {
      readonly format: "terminal" | "markdown" | "json";
      readonly productVersion: string;
    },
  ): void {
    const input: SelectiveReceiptRenderInput = {
      file: receipt,
      productVersion: context.productVersion,
    };
    // The JSON renderer returns the schema-verbatim value and the CLI
    // serializes it, so stdout is byte-identical to the persisted artifact.
    if (context.format === "json") {
      this.context.stdout.write(
        `${JSON.stringify(renderSelectiveReceipt(input, "json"), null, 2)}\n`,
      );
    } else if (context.format === "markdown") {
      this.context.stdout.write(renderSelectiveReceipt(input, "markdown"));
    } else {
      this.context.stdout.write(renderSelectiveReceipt(input, "terminal"));
    }
  }
}
