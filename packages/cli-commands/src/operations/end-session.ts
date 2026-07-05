// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Typed operation backing `viberevert end` (CLI) and, in M G2,
// `viberevert run`'s session close. Owns all domain logic: repo-root
// resolution, active-lock pre-check, the two post-session git status
// captures, timestamp resolution, core.endSession hand-off.
//
// Owns NO presentation: never writes to process.stdout / process.stderr,
// never calls console.*, never reads process.cwd() (uses opts.cwd).
//
// =============================================================================
// Architectural locks (carried over from EndCommand verbatim)
// =============================================================================
//
// 1. **D19 — config-blind.** This operation MUST NOT import or call
//    `loadConfig`. It operates purely on persisted `.viberevert/` state
//    (active-session.json + the session dir it references).
//
// 2. **D16/D17c — git invocation through @viberevert/git only.** NO
//    `child_process` imports. Git status is fetched via TWO calls per
//    M D Step 4a: `getStatusPorcelainText` (raw v1 text, D8 audit form,
//    persisted as after-status.txt) and `getStatusPorcelainZRaw` (raw
//    -z BYTES, D8 machine surface, persisted as after-status.z). Two
//    separate invocations are unavoidable: `-z` changes git's output
//    format. Sequential, not Promise.all — keeps snapshot ordering
//    crisp for future audit; no correctness gain from parallelism.
//
// 3. **session.ts lock #2 — deterministic timestamps.** core.endSession
//    accepts `endedAt` as a plain string; this operation generates it
//    via `resolveNowForCliTimestamp()` (second-precision ISO 8601 Z;
//    honors VIBEREVERT_TEST_FIXED_NOW per D49). RuntimeEnvInvalidError
//    propagates to the caller.
//
// 4. **D17c — plain inputs to core.** core.endSession receives
//    `{repoRoot, endedAt, afterStatusText, afterStatusZRaw}` only.
//
// 5. **No D22 lock around end** (per the M B plan: only start and
//    checkpoint --name acquire mkdir locks). Concurrent-end safety
//    relies on core's in-function loadActiveSessionLock re-check; the
//    lost-race case surfaces here as EndSessionRaceError (see below).
//
// =============================================================================
// Callers must catch these typed errors and map to presentation
// =============================================================================
//
// - RepoRootNotFoundError  (from @viberevert/core) → "No git repo..." copy
// - NoActiveSessionError   (from @viberevert/core) → "No active session..."
//   copy. Thrown by the PRE-CHECK when there is nothing to end.
// - EndSessionRaceError    (operation-defined)     → "removed by another
//   `viberevert end`..." copy. Wraps core's NoActiveSessionError when a
//   CONCURRENT end deleted active-session.json between our pre-check
//   and core's re-check — a distinct presentation case from the
//   pre-check refusal, so it gets a distinct class.
// - RuntimeEnvInvalidError (from runtime-env.js)   → test-only env
//   override malformed.

import {
  endSession,
  loadActiveSessionLock,
  NoActiveSessionError,
  resolveRepoRoot,
} from "@viberevert/core";
import { getStatusPorcelainText, getStatusPorcelainZRaw } from "@viberevert/git";

import { resolveNowForCliTimestamp } from "../runtime-env.js";

/**
 * A concurrent `viberevert end` deleted active-session.json between
 * this operation's pre-check and core's re-check. The session IS ended
 * (by the other process) — callers surface this as its own message,
 * not the "no active session" refusal.
 */
export class EndSessionRaceError extends Error {
  constructor(cause?: unknown) {
    super("Active session was removed by a concurrent end between check and end", { cause });
    this.name = "EndSessionRaceError";
  }
}

export type EndSessionOperationOpts = {
  /** Directory to resolve the repo root from. Caller-supplied; the
   *  operation MUST NOT read `process.cwd()`. */
  cwd: string;
};

export type EndSessionOperationResult = {
  sessionId: string; // sess_<ULID>
  startedAt: string; // ISO-8601 (from the active lock)
  endedAt: string; // ISO-8601 UTC (second precision)
  task?: string; // present iff the session carried a task
};

export async function endSessionOperation(
  opts: EndSessionOperationOpts,
): Promise<EndSessionOperationResult> {
  // Step 1: resolve repo root from caller-supplied cwd.
  const repoRoot = resolveRepoRoot(opts.cwd);

  // Step 2: pre-check the active lock — both for the friendly refusal
  // (NoActiveSessionError with nothing started) and for the result data
  // (session_id, started_at, task). core.endSession re-checks
  // internally; the narrow race is mapped to EndSessionRaceError below.
  const lock = await loadActiveSessionLock(repoRoot);
  if (lock === null) {
    throw new NoActiveSessionError();
  }

  // Step 3: fetch the two post-session git status snapshots (lock #2's
  // ordering preserved from the pre-extraction EndCommand: text, then
  // z-bytes, then timestamp).
  const afterStatusText = await getStatusPorcelainText(repoRoot);
  const afterStatusZRaw = await getStatusPorcelainZRaw(repoRoot);

  // Step 4: resolve the timestamp (RuntimeEnvInvalidError propagates).
  const endedAt = resolveNowForCliTimestamp();

  // Step 5: hand off to core for the atomic mutations.
  try {
    await endSession({ repoRoot, endedAt, afterStatusText, afterStatusZRaw });
  } catch (err) {
    if (err instanceof NoActiveSessionError) {
      throw new EndSessionRaceError(err);
    }
    throw err;
  }

  return {
    sessionId: lock.session_id,
    startedAt: lock.started_at,
    endedAt,
    ...(lock.task !== undefined ? { task: lock.task } : {}),
  };
}
