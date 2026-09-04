// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The rollback serialization boundary, with one owner.
//
// `rollback.lock` protects an entire rollback attempt, not merely its mutation.
// The legacy full rollback holds it across refusal evaluation, emergency
// checkpoint creation, the restore itself, and receipt publication, releasing it
// only once the receipt is written.
//
// M 0.8.0 step 10F's selective transaction needs the same boundary for a
// stronger reason. Its protected region spans the protected-domain snapshot `S`,
// the emergency checkpoint `E`, the proof that `E` reproduces `S`, the
// session-start oracle, evidence validation, the final fence, marker
// publication, and the mutation. Releasing the lock anywhere inside that
// sequence would let a second rollback alter the very state `S`, `E`, and the
// fence are reasoning about, invalidating all three at once.
//
// So the literal and its acquisition live here rather than being duplicated at
// each call site. Two callers holding "the same lock" by copying a string is
// exactly how a serialization boundary silently splits in two.
//
// NESTING. `checkpoint-name.lock` is acquired INSIDE this one, only around
// emergency-checkpoint creation, so the D5b name-collision scan is atomic
// against a concurrent `viberevert checkpoint --name`. That constant has its own
// owner in `checkpoint-helpers.ts`; the two boundaries are deliberately separate
// and must not be conflated.
//
// D99.M.19 barrel guard: `withRollbackLock` must not be re-exported from
// `src/index.ts`. Package-internal command/transaction plumbing only.
// `ROLLBACK_LOCK_REL` stays private here so callers cannot bypass the shared
// acquisition helper while still using the same lock path.

import { join } from "node:path";

import { type LockInfo, withExclusiveLock } from "./locks.js";

/** Repo-relative path of the rollback serialization lock. */
const ROLLBACK_LOCK_REL = ".viberevert/.locks/rollback.lock";

/**
 * Run `fn` under the rollback lock.
 *
 * Thin by design: `withExclusiveLock` already owns acquisition, stale-lock
 * refusal, and cleanup semantics, and refuses IMMEDIATELY rather than blocking
 * when the lock is held, so a competing rollback fails with
 * `ConcurrentOperationError` instead of queueing behind a long transaction.
 * This adds only the one thing worth centralizing: which path that lock is.
 */
export function withRollbackLock<T>(
  repoRoot: string,
  info: LockInfo,
  fn: () => Promise<T>,
): Promise<T> {
  return withExclusiveLock(join(repoRoot, ROLLBACK_LOCK_REL), info, fn);
}

/**
 * Whether the lock was released, and where it is if it was not.
 *
 * The path is carried EXPLICITLY rather than recovered from the error, because
 * the D22 remedy is "remove this stale lock directory" and an arbitrary
 * filesystem error is not required to name the directory it failed on.
 */
export type LockReleaseState =
  | { readonly state: "released" }
  | { readonly state: "release_failed"; readonly path: string; readonly cause: unknown };

export interface LockedRun<T> {
  readonly result: T;
  readonly lockRelease: LockReleaseState;
}

/**
 * Run `fn` under the rollback lock, keeping its result even if RELEASE fails.
 *
 * `withExclusiveLock` releases on its success path with an unguarded `rm`, so a
 * release failure throws and `withRollbackLock` loses whatever `fn` produced.
 * For a selective apply that is unacceptable: the receipt is written INSIDE the
 * lock, so by the time release runs the outcome is already durably recorded,
 * and reporting a generic lock error would tell an operator nothing happened
 * when a restore in fact completed. A stale lock directory is a separate,
 * manually recoverable fact.
 *
 * The discrimination is exact. `withExclusiveLock` rethrows a callback failure
 * only AFTER its own cleanup, so `produced` is set exactly when the callback
 * completed; a throw with it set can only have come from the release.
 * Acquisition failures and callback failures still THROW, because in those
 * cases there is no result to preserve.
 *
 * Not re-exported from `src/index.ts`, per the barrel guard above.
 */
export async function withRollbackLockCapturingRelease<T>(
  repoRoot: string,
  info: LockInfo,
  fn: () => Promise<T>,
): Promise<LockedRun<T>> {
  const path = join(repoRoot, ROLLBACK_LOCK_REL);
  let produced: { readonly value: T } | undefined;
  let lockRelease: LockReleaseState = { state: "released" };

  try {
    await withExclusiveLock(path, info, async () => {
      produced = { value: await fn() };
    });
  } catch (cause) {
    if (produced === undefined) throw cause;
    lockRelease = { state: "release_failed", path, cause };
  }

  if (produced === undefined) {
    // Unreachable: `withExclusiveLock` resolved, so the callback completed.
    throw new Error("the rollback lock resolved without invoking its callback");
  }
  return { result: produced.value, lockRelease };
}
