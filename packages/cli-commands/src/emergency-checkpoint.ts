// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The D65 emergency pre-rollback checkpoint, command-neutral.
//
// Extracted from `commands/rollback.ts` unchanged in behaviour. It moved
// because a SECOND caller now needs it: M 0.8.0 step 10F's selective rollback
// transaction creates the same recovery handle, and `validateRecoveryHandle`
// then proves that handle reproduces the protected snapshot `S`.
//
// The only thing left behind is presentation. The original caught
// `CheckpointListLoadError`, wrote a line to the command's stderr, and threw
// `CollisionExitSentinel` to drive Clipanion's exit-1 flow. None of that belongs
// in transaction infrastructure, so the typed error simply propagates here and
// `commands/rollback.ts` maps it at its call site, preserving that stderr text
// and exit path byte-for-byte. `operations/create-checkpoint.ts` already splits
// the same seam the same way.
//
// LOCKING. The caller must already hold the outer `rollback.lock`; this function
// does not acquire it, because the serialization boundary spans far more than
// checkpoint creation. It DOES acquire the nested `checkpoint-name.lock` (lock
// #8) so the D5b name-collision scan and the creation run atomically against a
// concurrent `viberevert checkpoint --name`. That lock-path constant remains
// owned by `operations/create-checkpoint.ts` under D99.M.21c, which deliberately
// makes the operation file the source of truth for the checkpoint-name
// serialization boundary, so this module imports it rather than relocating or
// redefining it.
//
// FAILURE CONTRACT, unchanged:
//
//     create stage   `createCheckpoint` failed. The temp dir is removed, and
//                    cleanup errors are swallowed so the original cause
//                    survives.
//     rename stage   `renameDirAtomic` failed after a successful capture. The
//                    temp dir is LEFT IN PLACE: its contents are valid and D13
//                    tolerates leftover `.tmp-*` siblings, which loaders skip.
//
// Both failures propagate before this helper returns a recovery handle. The
// caller must not proceed to marker publication or restore mutation after
// either failure.

import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { createCheckpoint } from "@viberevert/git";

import { renameDirAtomic } from "./atomic.js";
import { safeListCheckpoints } from "./checkpoint-helpers.js";
import { type LockInfo, withExclusiveLock } from "./locks.js";
import { CHECKPOINT_NAME_LOCK_REL } from "./operations/create-checkpoint.js";

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
 * version-stable. Changing the length here changes the persisted names
 * assigned to newly created `pre-rollback-...` checkpoints, so the naming
 * rule would drift across CLI versions.
 */
const CHECKPOINT_NAME_SESSION_ID_PREFIX_LEN = 14;

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
 * (validated upstream by the caller). The slice is always safe.
 */
function truncateSessionIdForCheckpointName(sessionId: string): string {
  return sessionId.slice(0, "sess_".length + CHECKPOINT_NAME_SESSION_ID_PREFIX_LEN);
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
export class RollbackEmergencyCheckpointError extends Error {
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

/**
 * Create the D65 emergency pre-rollback checkpoint. Acquires
 * the nested `checkpoint-name.lock` (inside the already-held
 * outer `rollback.lock`) per lock #8 so the D5b name-collision
 * scan + createCheckpoint call run atomically against concurrent
 * `CheckpointCommand --name` invocations.
 *
 * Returns the generated `checkpointId` (with `cp_` prefix per
 * D5 / lock #6) and the final unique `name` actually used (base
 * name OR suffixed `-2`/`-3`/... per D5b).
 *
 * The returned id names a checkpoint directory at
 * `.viberevert/checkpoints/<checkpointId>`; this function deliberately returns
 * the identity rather than the path, matching what the legacy receipt records.
 *
 * Throws:
 *   - `CheckpointListLoadError` if the name-collision scan could not read
 *     existing checkpoints. Presentation of that failure belongs to the caller.
 *   - `ConcurrentOperationError` if the inner lock is contended.
 *   - `RollbackEmergencyCheckpointError("create", ...)` if
 *     `createCheckpoint` itself fails (temp dir cleaned up).
 *   - `RollbackEmergencyCheckpointError("rename", ...)` if
 *     `renameDirAtomic` fails after a successful createCheckpoint
 *     (temp dir left in place per D13 tolerance).
 *
 * The temp-dir + `renameDirAtomic` pattern is encapsulated here
 * (per lock #6 — never inlined into a caller). Mirrors
 * checkpoint.ts:210-251.
 */
export async function createEmergencyCheckpoint(args: {
  readonly repoRoot: string;
  readonly rollbackExcludePatterns: readonly string[];
  readonly targetSessionId: string;
  readonly now: string;
  readonly invocationCommand: string;
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
    // `CheckpointListLoadError` propagates: whether it becomes stderr plus an
    // exit sentinel, or something else, is the caller's decision.
    const existing = await safeListCheckpoints(args.repoRoot);
    const existingNames = new Set(
      existing.map((c) => c.name).filter((n): n is string => n != null),
    );
    let name = baseName;
    let suffix = 2;
    while (existingNames.has(name)) {
      name = `${baseName}-${suffix}`;
      suffix += 1;
    }

    // D17b: the caller creates a generic random temp dir name; git
    // generates the cp_<ULID> internally; we do our own
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
