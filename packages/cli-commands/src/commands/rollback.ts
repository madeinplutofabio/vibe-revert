// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert rollback <session-id> [--apply] [--force] [--json|--markdown]`
// — restore a session's pre-session captured state per M D D59.
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
//     this is encapsulated in `createEmergencyCheckpoint(...)`.
//     The temp+rename logic appears EXACTLY ONCE in this file
//     (inside that helper). It is NEVER inlined inside `execute()`.
//
//  7. **D5b name-collision protection for the D65 emergency
//     checkpoint name.** Emergency checkpoints are named
//     `pre-rollback-<truncated-target-sess>` using the
//     CLI-LOCAL `truncateSessionIdForCheckpointName` helper (NOT
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
//     Outer: `.viberevert/.locks/rollback.lock`. Inner (around
//     D65 only): `.viberevert/.locks/checkpoint-name.lock`. The
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
// 13. **Single-timestamp policy (M C precedent).** One `now`
//     value is sampled via `resolveNowForCliTimestamp()` BEFORE
//     the lock and threaded into BOTH the lock metadata
//     (`lockInfo.started_at`) AND the receipt's `written_at` AND
//     the emergency checkpoint's `capturedAt`. No subsequent
//     `Date.now()`/`new Date()` calls in this file.
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

import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  generateRollbackId,
  loadActiveSessionLock,
  loadConfig,
  RepoRootNotFoundError,
  resolveRepoRoot,
  SessionNotFoundError,
} from "@viberevert/core";
import {
  createCheckpoint,
  type EndOfSessionSnapshot,
  GitNotAvailableError,
  getHeadSha,
  getStatusPorcelainZ,
  loadEndOfSessionChangedPaths,
  planRestoreCheckpoint,
  type RestorePlan,
  type StatusEntry,
} from "@viberevert/git";
import { type ReceiptRenderInput, renderReceipt } from "@viberevert/reporters";
import {
  type ReceiptFile,
  ReceiptFileSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
} from "@viberevert/session-format";
import { Command, Option } from "clipanion";

import { renameDirAtomic, writeFileAtomic } from "../atomic.js";
import {
  CheckpointListLoadError,
  CollisionExitSentinel,
  safeListCheckpoints,
} from "../checkpoint-helpers.js";
import { ConcurrentOperationError, type LockInfo, withExclusiveLock } from "../locks.js";
import {
  buildReceiptForApply,
  buildReceiptForDryRun,
  CheckpointArtifactsMissingError,
  checkRefusals,
  type ExistingApplyReceipt,
  RollbackActiveSessionRefusalError,
  RollbackAlreadyAppliedError,
  RollbackDirtyTreeRefusalError,
  RollbackHeadMismatchError,
  RollbackUnEndedSessionRefusalError,
  resolveSessionAndCheckpoint,
} from "../rollback-orchestration.js";
import {
  RuntimeEnvInvalidError,
  resolveNowForCliTimestamp,
  resolveProductVersionForReport,
} from "../runtime-env.js";

// =============================================================================
// Constants
// =============================================================================

const ROLLBACK_LOCK_REL = ".viberevert/.locks/rollback.lock";
const CHECKPOINT_NAME_LOCK_REL = ".viberevert/.locks/checkpoint-name.lock";

/**
 * Length of the ULID-prefix kept when truncating a session id for
 * the D65 emergency checkpoint name. 14 chars matches the D5
 * visible-identification convention. Combined with the "sess_"
 * prefix (5 chars), the truncated id is 19 chars; combined with
 * "pre-rollback-" (13 chars), the full checkpoint name is 32 chars
 * — comfortably under any reasonable listing-width budget.
 *
 * **PERSISTED METADATA, NOT A DISPLAY HELPER.** This constant and
 * the helper that uses it MUST stay ASCII-stable and
 * version-stable. Changing the length here renames any existing
 * `pre-rollback-...` checkpoints in user repos on next list.
 */
const CHECKPOINT_NAME_SESSION_ID_PREFIX_LEN = 14;

// =============================================================================
// Internal error classes (file-local — not exported)
// =============================================================================

/**
 * Thrown by `loadExistingApplyReceipt` when the apply-receipt
 * file exists at the canonical D68 path but is unusable for the
 * D70 idempotency check. Per lock #5, the CLI fails closed on
 * every malformed-receipt mode rather than silently treating it
 * as "no existing apply receipt." Cases covered:
 *   - Non-ENOENT read failure (EACCES, ENOTDIR, EISDIR, ...)
 *   - JSON parse failure
 *   - Schema validation failure (ReceiptFileSchema rejection)
 *   - Receipt mode is not "apply" (the CLI never wrote a
 *     non-apply receipt to this path; presence here means
 *     corruption or hand-edit)
 *   - pre_rollback_checkpoint_id is null (D69 refine should
 *     catch this at parse, but defensive)
 *   - session_id does not match the requested target sessionId
 *     (foreign receipt at this path = corruption)
 */
class ApplyReceiptCorruptError extends Error {
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
 * Thrown by `writeReceiptAtomically` when the underlying
 * writeFileAtomic call fails (disk full, permission denied,
 * EROFS, etc.). Dual-mode message based on whether a recovery
 * handle was supplied:
 *
 *   - APPLY mode (recoveryCheckpointId provided) — lock #16
 *     case (h): the receipt is missing AND restoreCheckpoint
 *     already ran, so mutation MAY have occurred. The message
 *     warns about possible mutation AND surfaces the D65
 *     emergency checkpoint id/name as the recovery handle (the
 *     receipt that would normally carry
 *     pre_rollback_checkpoint_id does not exist, so this error
 *     message is the user's ONLY surface for the recovery handle).
 *   - DRY-RUN mode (no recovery handle): dry-run never mutates,
 *     so the message correctly states no mutation was attempted
 *     and omits any recovery hint.
 */
class RollbackReceiptWriteError extends Error {
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

/**
 * Thrown by `createEmergencyCheckpoint` when the D65 emergency
 * pre-rollback checkpoint fails to create OR rename. Per lock #16
 * case (g), this PREVENTS an apply receipt from being written
 * (no apply receipt = no D70 lock; the user can retry cleanly
 * after fixing the underlying fs/git/config issue). The `stage`
 * field distinguishes the two failure points for diagnostics:
 *   - "create": `createCheckpoint` itself failed (e.g., git error,
 *     disk full during snapshot capture). Temp dir is cleaned up.
 *   - "rename": `renameDirAtomic` failed AFTER `createCheckpoint`
 *     succeeded. The temp dir is left in place (its contents are
 *     valid; D13 tolerates leftover `.tmp-*` entries).
 */
class RollbackEmergencyCheckpointError extends Error {
  override readonly name = "RollbackEmergencyCheckpointError";
  constructor(
    readonly stage: "create" | "rename",
    cause: unknown,
  ) {
    super(
      `Failed to create the pre-rollback emergency checkpoint (${stage} stage): ${
        cause instanceof Error ? cause.message : String(cause)
      }. The rollback was NOT applied; the working tree is unchanged.`,
      { cause },
    );
  }
}

// =============================================================================
// D68 receipt path helpers (lock #4 — no inline path joins)
// =============================================================================

/**
 * Path to the dry-run receipt file per D68. Dry-run and apply
 * persist to DIFFERENT files so dry-run never overwrites the
 * apply audit record (preserves D70 idempotency).
 */
function rollbackDryRunReceiptPath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, ".viberevert", "sessions", sessionId, "rollback-dry-run-receipt.json");
}

/**
 * Path to the apply receipt file per D68 (WRITE intent).
 */
function rollbackApplyReceiptPath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, ".viberevert", "sessions", sessionId, "rollback-receipt.json");
}

/**
 * Same file as `rollbackApplyReceiptPath` — separate name conveys
 * READ intent (existence-check + parse via `loadExistingApplyReceipt`)
 * vs WRITE intent. The duplication is intentional for call-site
 * readability and so a future D68 path change updates BOTH the
 * read site AND the write site via one helper each.
 */
function existingApplyReceiptPath(repoRoot: string, sessionId: string): string {
  return rollbackApplyReceiptPath(repoRoot, sessionId);
}

// =============================================================================
// Pure helpers
// =============================================================================

/**
 * Truncate a validated session id for use in the D65 emergency
 * checkpoint name. **PERSISTED METADATA helper, NOT a display
 * formatter** — the result is stored verbatim in `manifest.name`
 * and surfaced by `viberevert checkpoints`, so the truncation
 * rule MUST be stable across CLI versions. ASCII-only, no
 * ellipsis, no Unicode. Length is `5 + CHECKPOINT_NAME_SESSION_ID_PREFIX_LEN`
 * (e.g., `sess_01JV8Z0N6E7ABC` = 19 chars).
 *
 * Precondition: `sessionId` matches `/^sess_[26 chars]$/`
 * (validated upstream in execute()). The slice is always safe.
 */
function truncateSessionIdForCheckpointName(sessionId: string): string {
  return sessionId.slice(0, "sess_".length + CHECKPOINT_NAME_SESSION_ID_PREFIX_LEN);
}

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
}): string {
  const parts = [`viberevert rollback ${args.session}`];
  if (args.apply) parts.push("--apply");
  if (args.force) parts.push("--force");
  if (args.format === "json") parts.push("--json");
  else if (args.format === "markdown") parts.push("--markdown");
  return parts.join(" ");
}

// =============================================================================
// I/O helpers
// =============================================================================

/**
 * Read+parse+validate the existing apply receipt for the D70
 * idempotency check. Returns `null` ONLY when the file is
 * genuinely absent (ENOENT). All other failure modes — non-ENOENT
 * read errors AND parse / shape / mode / session-id mismatches —
 * throw `ApplyReceiptCorruptError` per lock #5 fail-closed
 * discipline.
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
    // Any non-ENOENT read failure (EACCES, ENOTDIR, EISDIR, EIO,
    // etc.) is treated as corruption-equivalent for the purpose
    // of clean exit. We cannot trust the file's contents enough
    // to skip the D70 check, and we cannot read it to enforce
    // the check — fail closed.
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

/**
 * Write a receipt file atomically via the CLI's private
 * `writeFileAtomic`. Receipt JSON is serialized with `null, 2`
 * indentation for human-readable on-disk audit trail (the
 * stdout JSON renderer uses the same indentation per lock #12).
 * I/O failures wrap as `RollbackReceiptWriteError` so the CLI
 * surfaces a clean stderr message instead of letting a raw
 * fs error propagate to Clipanion's crash surface.
 *
 * The optional `recovery` arg threads the D65 emergency
 * checkpoint id+name through to `RollbackReceiptWriteError`
 * so apply-mode receipt-write failures surface the recovery
 * handle to the user (the missing receipt was the user's only
 * other source of pre_rollback_checkpoint_id — per lock #16
 * case (h)). Dry-run callers omit `recovery` (no emergency CP),
 * and the error message branches accordingly to avoid claiming
 * a non-existent mutation.
 */
async function writeReceiptAtomically(
  path: string,
  receipt: ReceiptFile,
  recovery?: {
    readonly recoveryCheckpointId: string;
    readonly recoveryCheckpointName: string;
  },
): Promise<void> {
  try {
    await writeFileAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (err) {
    throw new RollbackReceiptWriteError(
      path,
      err,
      recovery?.recoveryCheckpointId,
      recovery?.recoveryCheckpointName,
    );
  }
}

// =============================================================================
// D65 emergency checkpoint creation
// =============================================================================

/**
 * Create the D65 emergency pre-rollback checkpoint. Acquires
 * the nested `checkpoint-name.lock` (inside the already-held
 * outer `rollback.lock`) per lock #8 so the D5b name-collision
 * scan + createCheckpoint call run atomically against concurrent
 * `CheckpointCommand --name` invocations.
 *
 * Returns the generated `checkpointId` (with `cp_` prefix per
 * D5 / lock #6) and the final unique `name` actually used (base
 * name OR suffixed `-2`/`-3`/... per D5b). The returned pair is
 * threaded into `writeReceiptAtomically`'s `recovery` arg so
 * receipt-write failures (lock #16 case (h)) can surface the
 * recovery handle in their error message.
 *
 * Throws:
 *   - `CollisionExitSentinel` if `safeListCheckpoints` surfaced
 *     a corruption error (already written to stderr).
 *   - `ConcurrentOperationError` if the inner lock is contended.
 *   - `RollbackEmergencyCheckpointError("create", ...)` if
 *     `createCheckpoint` itself fails (temp dir cleaned up).
 *   - `RollbackEmergencyCheckpointError("rename", ...)` if
 *     `renameDirAtomic` fails after a successful createCheckpoint
 *     (temp dir left in place per D13 tolerance).
 *
 * The temp-dir + `renameDirAtomic` pattern is encapsulated here
 * (per lock #6 — never inlined into `execute()`). Mirrors
 * checkpoint.ts:210-251.
 */
async function createEmergencyCheckpoint(args: {
  readonly repoRoot: string;
  readonly rollbackExcludePatterns: readonly string[];
  readonly targetSessionId: string;
  readonly now: string;
  readonly invocationCommand: string;
  readonly cmd: { context: { stderr: { write(s: string): unknown } } };
}): Promise<{ checkpointId: string; name: string }> {
  const baseName = `pre-rollback-${truncateSessionIdForCheckpointName(args.targetSessionId)}`;

  const lockDir = join(args.repoRoot, CHECKPOINT_NAME_LOCK_REL);
  const lockInfo: LockInfo = {
    pid: process.pid,
    command: args.invocationCommand,
    started_at: args.now,
    host: hostname(),
  };

  return await withExclusiveLock(lockDir, lockInfo, async () => {
    // D5b name-collision scan + suffix-counter to find unique name.
    // Post M G1a Step 1: safeListCheckpoints now throws
    // CheckpointListLoadError instead of writing stderr + returning null.
    // We catch it, write the same stderr the helper used to write, and
    // throw CollisionExitSentinel — preserves the pre-refactor exit-1
    // flow byte-identically.
    let existing: Awaited<ReturnType<typeof safeListCheckpoints>>;
    try {
      existing = await safeListCheckpoints(args.repoRoot);
    } catch (err) {
      if (err instanceof CheckpointListLoadError) {
        args.cmd.context.stderr.write(`Error reading existing checkpoints: ${err.message}\n`);
        throw new CollisionExitSentinel();
      }
      throw err;
    }
    const existingNames = new Set(
      existing.map((c) => c.name).filter((n): n is string => n != null),
    );
    let name = baseName;
    let suffix = 2;
    while (existingNames.has(name)) {
      name = `${baseName}-${suffix}`;
      suffix += 1;
    }

    // D17b: CLI creates a generic random temp dir name; git
    // generates the cp_<ULID> internally; CLI does its own
    // renameDirAtomic to the final ID-based path.
    const tmpName = `.tmp-checkpoint-${randomBytes(8).toString("hex")}`;
    const tmpDirAbs = join(args.repoRoot, ".viberevert", "checkpoints", tmpName);

    let result: { checkpointId: string };
    try {
      result = await createCheckpoint({
        repoRoot: args.repoRoot,
        checkpointDir: tmpDirAbs,
        rollbackExcludePatterns: args.rollbackExcludePatterns,
        name,
        capturedAt: args.now,
      });
    } catch (err) {
      // Cleanup the temp dir on failure to avoid leaking stale
      // `.tmp-checkpoint-<hex>/` siblings. Cleanup errors swallowed.
      // The original createCheckpoint error is wrapped as a typed
      // RollbackEmergencyCheckpointError so handleKnownError can
      // surface a clean stderr message (vs Clipanion's crash).
      await rm(tmpDirAbs, { recursive: true, force: true }).catch(() => {});
      throw new RollbackEmergencyCheckpointError("create", err);
    }

    const finalDirAbs = join(args.repoRoot, ".viberevert", "checkpoints", result.checkpointId);
    try {
      await renameDirAtomic(tmpDirAbs, finalDirAbs);
    } catch (err) {
      // Rename failure leaves the temp dir in place per D13
      // tolerance (its contents are valid; loaders skip .tmp-*).
      // Wrap as RollbackEmergencyCheckpointError for clean stderr.
      throw new RollbackEmergencyCheckpointError("rename", err);
    }

    return { checkpointId: result.checkpointId, name };
  });
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

    // Step D: resolve the wall-clock timestamp ONCE for this command
    // (D13 single-timestamp policy per lock #13). Threaded into
    // lockInfo, the receipt's written_at, and the emergency
    // checkpoint's capturedAt. RuntimeEnvInvalidError (test-only
    // failure mode for a malformed env override) surfaces here
    // before lock acquisition.
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
    });

    const lockDir = join(repoRoot, ROLLBACK_LOCK_REL);
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

    let protectedResult: { readonly receipt: ReceiptFile };
    try {
      protectedResult = await withExclusiveLock(lockDir, lockInfo, async () => {
        // 1. loadConfig — INSIDE the lock so rollback uses the config
        //    snapshot in effect at lock-acquisition time (lock #1).
        const config = await loadConfig(repoRoot);
        const rollbackExcludePatterns = config.rollback?.exclude ?? [];

        // 2. loadActiveSessionLock — may return null.
        const activeLock = await loadActiveSessionLock(repoRoot);

        // 3. resolveSessionAndCheckpoint — throws SessionNotFoundError
        //    or CheckpointArtifactsMissingError.
        const { session, manifest, checkpointDir } = await resolveSessionAndCheckpoint(
          sessionId,
          repoRoot,
        );

        // 4. loadEndOfSessionChangedPaths — discriminated union
        //    (present|missing) per Step 4 lock.
        const endOfSessionSnapshot: EndOfSessionSnapshot = await loadEndOfSessionChangedPaths(
          session,
          repoRoot,
        );

        // 5. getStatusPorcelainZ — parsed StatusEntry[] for the
        //    current dirty-tree comparison (D61).
        const currentStatus: readonly StatusEntry[] = await getStatusPorcelainZ(repoRoot);

        // 6. getHeadSha — current HEAD sha for the D64 check.
        const currentHeadSha = await getHeadSha(repoRoot);

        // 7. loadExistingApplyReceipt — fail-closed per lock #5.
        //    null only on genuine absence; throws on any corruption.
        const existingApplyReceipt = await loadExistingApplyReceipt(repoRoot, sessionId);

        // 8. checkRefusals — applies the D75 force policy;
        //    throws the first applicable refusal in apply mode;
        //    returns the outcome (with warnings populated) in
        //    dry-run mode.
        const outcome = checkRefusals({
          targetSessionId: sessionId,
          session,
          manifest,
          currentHeadSha,
          currentStatus,
          endOfSessionSnapshot,
          activeLock,
          existingApplyReceipt,
          mode,
          force,
        });

        // 9. planRestoreCheckpoint — ALWAYS computed. Dry-run uses
        //    it as the basis for receipt.results[]; apply uses it
        //    as preRestorePlan for both preflight-failure
        //    propagation (rule #12 in orchestration) AND post-restore
        //    per-path results synthesis.
        const plan: RestorePlan = await planRestoreCheckpoint(checkpointDir, {
          repoRoot,
          rollbackExcludePatterns,
          allowHeadMismatch: outcome.allowHeadMismatch,
        });

        const rollbackId = generateRollbackId();
        let receipt: ReceiptFile;

        if (mode === "apply") {
          // 10a. D65 emergency pre-rollback checkpoint. Dry-run
          //      NEVER reaches this branch per lock #3.
          //      RollbackEmergencyCheckpointError on failure
          //      PREVENTS the apply receipt from being written
          //      (per lock #16 case (g) — no apply receipt = no
          //      D70 lock; clean retry).
          const emergency = await createEmergencyCheckpoint({
            repoRoot,
            rollbackExcludePatterns,
            targetSessionId: sessionId,
            now,
            invocationCommand,
            cmd: this,
          });

          // 11a. Build the apply receipt. buildReceiptForApply
          //      calls restoreCheckpoint internally; on throw it
          //      populates receipt.failures via classifyRestoreError
          //      and leaves receipt.results empty per D76
          //      conservative semantics. Per lock #16, the receipt
          //      IS written regardless of restore success/failure
          //      because the emergency CP already exists and the
          //      tree state is no longer trusted as post-session.
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

          // 12a. Persist the apply receipt atomically to its
          //      D68 path. Writes for every apply attempt that
          //      reached this stage (lock #16). The emergency CP
          //      handle is threaded into writeReceiptAtomically's
          //      `recovery` arg so RollbackReceiptWriteError
          //      (lock #16 case (h)) surfaces the recovery handle
          //      in stderr — the missing receipt was the user's
          //      only other source of pre_rollback_checkpoint_id.
          await writeReceiptAtomically(rollbackApplyReceiptPath(repoRoot, sessionId), receipt, {
            recoveryCheckpointId: emergency.checkpointId,
            recoveryCheckpointName: emergency.name,
          });
        } else {
          // 10b. Dry-run: skip emergency checkpoint (lock #3).
          //      Build the dry-run receipt — pure synthesis from
          //      plan + outcome, including rule-#12 preflight
          //      propagation from plan.preflight_failures.
          receipt = buildReceiptForDryRun({
            rollbackId,
            writtenAt: now,
            session,
            plan,
            outcome,
          });

          // 11b. Persist the dry-run receipt atomically to its
          //      D68 path. Overwrites any prior dry-run receipt
          //      freely; never touches the apply receipt path.
          //      No `recovery` arg — dry-run has no emergency CP
          //      to recover from, and RollbackReceiptWriteError's
          //      message branches accordingly to avoid claiming a
          //      non-existent mutation.
          await writeReceiptAtomically(rollbackDryRunReceiptPath(repoRoot, sessionId), receipt);
        }

        return { receipt };
      });
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // -------------------------------------------------------------------------
    // POST-LOCK PHASE: render the receipt to stdout. Lock has been
    // released; only stdout writes happen here.
    // -------------------------------------------------------------------------

    const renderInput: ReceiptRenderInput = {
      file: protectedResult.receipt,
      productVersion,
    };
    // Per lock #12: JSON renderer returns `unknown` (the ReceiptFile
    // reference per D38); CLI must serialize via JSON.stringify.
    // Terminal/markdown overloads return `string` and write directly.
    if (format === "json") {
      const rendered = renderReceipt(renderInput, "json");
      this.context.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
    } else if (format === "markdown") {
      this.context.stdout.write(renderReceipt(renderInput, "markdown"));
    } else {
      this.context.stdout.write(renderReceipt(renderInput, "terminal"));
    }

    // Exit code per D66:
    //   - dry-run: always 0 (informational; preflight failures
    //     surface in receipt.failures but don't change exit code).
    //   - apply: 0 if receipt.failures is empty; 1 otherwise.
    if (mode === "dry_run") {
      return 0;
    }
    return protectedResult.receipt.failures.length === 0 ? 0 : 1;
  }
}
