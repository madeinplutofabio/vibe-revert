// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Package-private exclusive-lock helper for the CLI orchestration layer (D22).
//
// NOT exported from any public CLI surface. NOT registered as a command.
// Callers use it to serialize trust-critical invariants. Two of those:
//
//   - `start.lock` — "exactly one active session per repo" (D11). The
//     SHARED SESSION-LIFECYCLE lock: taken by `viberevert start` (always)
//     and, as of M 0.8.0, by the end-session transaction (always), which
//     backs `viberevert end` and the session close inside `viberevert run`
//     and `viberevert shell`.
//
//     End shares this lock rather than taking one of its own because both
//     ends of a session's life mutate `active-session.json`; a separate
//     `end.lock` would let a start and an end interleave on the very file
//     the invariant is about. The name is historical — read it as the
//     lifecycle lock, not a start-only lock.
//
//   - `checkpoint-name.lock` — "checkpoint name unique within a repo"
//     (D5b). Taken by `viberevert checkpoint` ONLY when `--name` is
//     supplied; nameless checkpoints have no uniqueness invariant to
//     protect, so they skip the lock entirely. Unchanged by M 0.8.0.
//
// Why mkdir-based locks (not flock, not an npm package):
//   - `mkdir(lockDir, { recursive: false })` is atomic on every supported
//     filesystem (POSIX + NTFS) — either creates the dir or fails with
//     EEXIST. No native deps. No library dep.
//   - lockfile npm packages typically wrap mkdir or link with extra
//     abstractions we don't need.
//   - Native flock(2) is POSIX-only and has subtle inheritance/forking
//     semantics we don't need.
//
// **`.viberevert/.locks/**` subtree is the ONLY exception to D13's
// temp-write+rename rule.** Locks use a different atomicity model (atomic
// `mkdir` directly — no temp-then-rename), and `lock.json` is advisory
// metadata, not trust-critical persisted state. Specifically:
//   - `.viberevert/.locks/<lock-name>.lock/` is created via direct `mkdir`
//     (atomic; EEXIST = lock held). NOT `.tmp-…` + rename.
//   - `.viberevert/.locks/<lock-name>.lock/lock.json` is written
//     best-effort (no atomic temp+rename); a missing or corrupt
//     `lock.json` is tolerated.
//   - Loaders never trust `lock.json` for correctness — the lock dir's
//     existence IS the lock.
//
// Parent directory creation:
//   - `withExclusiveLock` ensures `.viberevert/.locks/` exists via
//     `mkdir(parent, { recursive: true })` BEFORE the actual lock
//     acquisition. The two steps are NOT collapsed — `mkdir(lockDir,
//     { recursive: true })` would mask EEXIST and silently break the
//     lock. Splitting into "ensure parent (recursive)" then "acquire
//     lock (non-recursive)" is essential.
//
// Stale lock recovery in M B: NONE. Manual recovery only — the refusal
// message that consuming commands print names the lock-dir path and
// the action ("remove this stale lock directory"). A future
// `viberevert gc` (deferred) sweeps locks whose recorded `pid` is no
// longer alive. Auto-recovery is non-trivial (race-free pid-liveness
// check is hard) and the lock window is short (sub-second to a few
// seconds), so manual recovery is M B's contract.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_INFO_FILENAME = "lock.json";

/**
 * Diagnostic metadata written to `<lockDir>/lock.json` by the holder.
 * Purely advisory: lock correctness depends ONLY on the atomic `mkdir`,
 * never on the contents (or presence) of this file. The CLI uses these
 * fields in the human refusal message when a competing invocation runs.
 *
 * Fields:
 *   - `pid`: PID of the holder process (`process.pid`).
 *   - `command`: human-readable command line (e.g.,
 *     `"viberevert start --task 'Add yearly billing'"`). The CLI is
 *     responsible for formatting; the helper does not interpret it.
 *   - `started_at`: ISO 8601 datetime with offset (caller-supplied —
 *     locks.ts never calls `new Date()` internally; tests pass fixed
 *     strings).
 *   - `host`: hostname (e.g., `os.hostname()`); helps diagnose
 *     mistaken cross-machine runs in shared workspaces.
 */
export interface LockInfo {
  readonly pid: number;
  readonly command: string;
  readonly started_at: string;
  readonly host: string;
}

/**
 * Thrown by `withExclusiveLock` when the lock is already held by
 * another process (the atomic `mkdir` failed with EEXIST).
 *
 * Carries the parsed `info` from `<lockDir>/lock.json` for the CLI's
 * human refusal message — OR `null` when:
 *   - the metadata file is missing (the brief race window between the
 *     OTHER holder's successful `mkdir` and its `writeFile(lock.json)`,
 *     OR a previous run that crashed mid-write);
 *   - the metadata file is unreadable, invalid JSON, or has malformed
 *     shape.
 *
 * In ALL of those failure modes the lock is still considered held
 * (the dir's existence IS the lock), and the CLI prints the
 * "lock metadata unavailable" refusal variant per D22.
 *
 * The class stays PRESENTATION-NEUTRAL: it carries structured facts
 * (`lockDir`, `info`) and nothing about how to render them. Rendering
 * lives in `formatConcurrentOperationRefusal` below, so a command can
 * catch this, decide it is not a user-facing condition, and do something
 * else entirely.
 */
export class ConcurrentOperationError extends Error {
  readonly lockDir: string;
  readonly info: LockInfo | null;

  constructor(lockDir: string, info: LockInfo | null, cause?: unknown) {
    super(
      info !== null
        ? `Another viberevert operation is holding lock at ${lockDir} (pid ${info.pid})`
        : `Another viberevert operation is holding lock at ${lockDir} (lock metadata unavailable)`,
      { cause },
    );
    this.name = "ConcurrentOperationError";
    this.lockDir = lockDir;
    this.info = info;
  }
}

/**
 * Render D22's locked concurrent-operation refusal for stderr.
 *
 * Canonical home for this copy. It was previously inlined identically at
 * every command that catches `ConcurrentOperationError`, including a
 * private `concurrentOperationCopy` helper inside `shell-pty.ts` — the same
 * extraction, at the wrong altitude. The refusal describes
 * `ConcurrentOperationError` and `LockInfo`, so it belongs beside them
 * rather than beside whichever command happened to need it first.
 *
 * TWO variants, selected by whether the holder's `lock.json` was readable.
 * Both are byte-for-byte the shipped copy and MUST stay that way: several
 * command tests assert the exact stderr, and the wording is D22-locked.
 * Extracting it is not licence to improve it.
 *
 * `lockPathForMessage` is the path shown to the user, supplied by the
 * caller rather than read off the error, because callers legitimately
 * differ:
 *   - Commands with exactly one lock in play pass their repo-relative
 *     constant (e.g. `START_LOCK_REL`), which is shorter and
 *     platform-neutral — D22 requires forward slashes in this copy.
 *   - `rollback` can contend on either of two locks, so it passes
 *     `err.lockDir` to name the one that actually blocked.
 *
 * As of M 0.8.0 this covers `start.lock` contention arising from an
 * end-session transaction as well as from `start`. No end-specific variant
 * is needed: the holder's own `command` field names the operation, so
 * "command: end-session" already tells the user what is running.
 *
 * @param info Parsed holder metadata, or `null` when unavailable.
 * @param lockPathForMessage Lock path to show in the recovery instruction.
 * @returns The complete stderr block, newline-terminated.
 */
export function formatConcurrentOperationRefusal(
  info: LockInfo | null,
  lockPathForMessage: string,
): string {
  return info !== null
    ? `Another viberevert operation is already running:\n  command:  ${info.command}\n  pid:      ${info.pid}\n  since:    ${info.started_at}\n\nIf you're sure that command isn't running anymore (e.g., crashed),\nremove this stale lock directory manually:\n  ${lockPathForMessage}\n`
    : `Another viberevert operation is already running (lock metadata unavailable).\n\nIf you're sure no other viberevert command is running,\nremove this stale lock directory manually:\n  ${lockPathForMessage}\n`;
}

/**
 * Acquire an exclusive lock at `lockDir`, run `fn`, and release the
 * lock when `fn` completes.
 *
 * Algorithm (locked per D22):
 *   1. Ensure `dirname(lockDir)` exists via `mkdir(parent, {recursive: true})`.
 *      Idempotent — succeeds whether or not the parent already exists.
 *      This is NOT the lock acquisition; the lock is the next step.
 *   2. `mkdir(lockDir, {recursive: false})` — atomic. Either creates
 *      the dir (lock acquired) or throws `EEXIST` (lock held by
 *      another invocation). `recursive: true` here would mask `EEXIST`
 *      and silently break the lock.
 *   3. Best-effort write of `<lockDir>/lock.json` containing `info`.
 *      A failure here does NOT release the lock or affect correctness
 *      — the lock IS the dir; metadata is advisory only.
 *   4. `await fn()`.
 *   5. Cleanup, with two paths:
 *      - **If `fn` threw**: attempt `rm(lockDir, {recursive: true,
 *        force: true})`, swallow any cleanup error, and re-throw the
 *        original `fn` failure. This preserves the real
 *        protected-operation cause for the user. If cleanup also
 *        fails, a stale lock may remain — but it will surface
 *        clearly on the next invocation as a
 *        `ConcurrentOperationError` naming the path and asking for
 *        manual removal per D22's stale-recovery contract.
 *      - **If `fn` succeeded**: perform cleanup unguarded. If
 *        cleanup throws, propagate that error to the caller — the
 *        protected operation completed but a stale lock would block
 *        the next invocation, so the user needs to know now.
 *
 * On `EEXIST` at step 2, throws `ConcurrentOperationError` carrying
 * `lockDir` and the parsed `info` from the existing `lock.json` (or
 * `null` if the metadata file is missing/unreadable/corrupt — see
 * `ConcurrentOperationError` docstring). The original `EEXIST` is
 * attached as `cause`.
 *
 * Other errors at step 2 (permission denied, ENOSPC, etc.) propagate
 * unchanged — they are not lock-contention failures and the caller
 * should surface them as-is.
 *
 * **Concurrency contract:** the lock protects `fn` from any other
 * process that follows this same `withExclusiveLock(lockDir, ...)`
 * convention. Code that mutates the protected resource OUTSIDE
 * `withExclusiveLock` (or under a different lock dir) is NOT
 * synchronized — that's a misuse, not a helper bug.
 */
export async function withExclusiveLock<T>(
  lockDir: string,
  info: LockInfo,
  fn: () => Promise<T>,
): Promise<T> {
  // Step 1: parent dir (idempotent; recursive: true succeeds on existing).
  await mkdir(dirname(lockDir), { recursive: true });

  // Step 2: atomic acquisition. recursive: false is essential — the
  // recursive form would mask EEXIST and break the lock.
  try {
    await mkdir(lockDir, { recursive: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await tryReadLockInfo(lockDir);
      throw new ConcurrentOperationError(lockDir, existing, err);
    }
    throw err;
  }

  // Step 3: best-effort metadata write (advisory; not load-bearing).
  await writeFile(join(lockDir, LOCK_INFO_FILENAME), JSON.stringify(info)).catch(() => {
    // Lock is the dir, not the file. Metadata write failure is OK.
  });

  // Steps 4 + 5: run, then release with the two-path cleanup contract.
  // The naive `try { ... } finally { rm }` would let a cleanup failure
  // silently mask a real fn() failure (JavaScript's finally semantics:
  // a finally throw overrides the try's exception). Splitting into
  // explicit catch + post-success cleanup preserves the right cause
  // on each branch.
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    try {
      await rm(lockDir, { recursive: true, force: true });
    } catch {
      // Preserve the original protected-operation failure. A stale lock
      // may remain and must be removed manually per D22.
    }
    throw err;
  }

  await rm(lockDir, { recursive: true, force: true });
  return result;
}

/**
 * Best-effort read of `<lockDir>/lock.json`. Returns the parsed
 * LockInfo on success, `null` on ANY failure mode (missing file,
 * unreadable, invalid JSON, malformed shape — wrong types, missing
 * keys, etc.).
 *
 * Used ONLY for the diagnostic message in `ConcurrentOperationError`
 * — never for any correctness decision. A `null` return is a normal
 * outcome (e.g., the brief window between the lock-holder's `mkdir`
 * and its `writeFile(lock.json)`), not an error.
 */
async function tryReadLockInfo(lockDir: string): Promise<LockInfo | null> {
  let raw: string;
  try {
    raw = await readFile(join(lockDir, LOCK_INFO_FILENAME), "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as {
    pid?: unknown;
    command?: unknown;
    started_at?: unknown;
    host?: unknown;
  };
  const pid = record.pid;
  const command = record.command;
  const started_at = record.started_at;
  const host = record.host;

  if (
    typeof pid !== "number" ||
    typeof command !== "string" ||
    typeof started_at !== "string" ||
    typeof host !== "string"
  ) {
    return null;
  }

  return { pid, command, started_at, host };
}
