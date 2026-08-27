// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Typed operation backing `viberevert end` (CLI) and the session close in
// `viberevert run` / `viberevert shell`. Owns all domain logic: repo-root
// resolution, the D22 lifecycle lock, the active-lock pre-check, the M 0.8.0
// contribution capture, timestamp resolution, core.endSession hand-off.
//
// Owns NO presentation: never writes to process.stdout / process.stderr,
// never calls console.*, never reads process.cwd() (uses opts.cwd).
//
// =============================================================================
// Architectural locks
// =============================================================================
//
// 1. **D19 — config-blind.** This operation MUST NOT import or call
//    `loadConfig`. It operates purely on persisted `.viberevert/` state
//    (active-session.json + the session dir it references).
//
//    This survives M 0.8.0 step 4c intact, but it is the reason lock #7
//    below exists: the framework-detection inputs a contribution could
//    carry are a CONFIG question, and 4c has no config to answer it with.
//
// 2. **D16/D17c — git invocation through @viberevert/git only.** NO
//    `child_process` imports.
//
//    **Changed in M 0.8.0 step 4c:** this operation no longer calls
//    `getStatusPorcelainText` / `getStatusPorcelainZRaw` itself. Both
//    snapshots now arrive on the `StableContributionCapture` that
//    `captureContribution` hands to `publish` — see lock #6.
//
// 3. **session.ts lock #2 — deterministic timestamps.** core.endSession
//    accepts `endedAt` as a plain string; this operation generates it
//    via `resolveNowForCliTimestamp()` (second-precision ISO 8601 Z;
//    honors VIBEREVERT_TEST_FIXED_NOW per D49). RuntimeEnvInvalidError
//    propagates to the caller.
//
//    **TWO independent samples, and the distinction is load-bearing:**
//      - `lockStartedAt`, taken BEFORE lock acquisition, is D22 lock
//        diagnostic metadata. It timestamps this operation's
//        lock-acquisition attempt and is written into the lock metadata if
//        acquisition succeeds. Taking it first also means a malformed
//        VIBEREVERT_TEST_FIXED_NOW (D49) surfaces as
//        RuntimeEnvInvalidError without ever acquiring the lock.
//      - `endedAt`, taken INSIDE `publish` after a matching fence and
//        immediately before publication, is when the session actually
//        ended. Capture is not cheap: it reconstructs a worktree, hashes
//        every present tracked regular file, writes payloads to the object
//        store, and may re-run the whole acquisition up to the fence
//        retry limit. Reusing the pre-lock sample would record an end time
//        from before all of that, understating it by the full capture
//        duration and by every retry.
//
//    `captureContribution` itself reads no clock, so `captured_at` remains
//    the CHECKPOINT's timestamp and no fence retry can move it. `ended_at`
//    is the one value that SHOULD track the successful terminal capture,
//    and sampling it in `publish` is what makes that true. The pre-lock
//    sample has already validated the environment by then, so the second
//    call is not a new failure mode in practice.
//
// 4. **D17c — plain inputs to core.** core.endSession receives
//    `{repoRoot, endedAt, afterStatusText, afterStatusZRaw,
//    contributionBytes}` only.
//
//    This operation owns the contribution's SERIALIZATION —
//    `JSON.stringify(contribution, null, 2)`, no trailing newline — because
//    core digests the exact bytes it is handed and never re-encodes them
//    (session.ts architectural lock #8). Changing the formatting here
//    changes `contribution_sha256` for every session written afterwards,
//    so it is persisted behavior, not style.
//
// 5. **D22 lock around the WHOLE end transaction (M 0.8.0 step 4c).**
//    Supersedes the pre-0.8.0 "no D22 lock around end" rule, which was
//    correct only while `end` was a cheap three-write operation.
//
//    The lock is `START_LOCK_REL`, imported from `start-session.ts` — the
//    SAME lock `viberevert start` takes, not a second one. That is
//    deliberate: start and end both mutate `active-session.json`, so a
//    separate `end.lock` would let a start and an end interleave on the
//    one file whose whole purpose is "exactly one active session per repo"
//    (D11).
//
//    Two things depend on holding it:
//      - **Cost.** `withExclusiveLock` refuses IMMEDIATELY rather than
//        blocking, so a competing `end` exits with
//        ConcurrentOperationError before reconstructing anything.
//      - **Correctness.** Two unsynchronized ends both write
//        `contribution.json` and `session.json`. Interleaved, the surviving
//        `session.json` can record one invocation's digest while
//        `contribution.json` holds the other's bytes. core cannot detect
//        that from inside a single call, which is why session.ts documents
//        this lock as a hard precondition rather than something its own
//        `active-session.json` read approximates.
//
//    The whole transaction runs inside it, in this order: load active lock,
//    load session, enter the checkpoint oracle, capture / store / fence,
//    publish.
//
// 6. **The capture is the sole end-state authority (M 0.8.0 step 4c).**
//    `after-status.txt`, `after-status.z`, and `contribution.json` all
//    derive from ONE `StableContributionCapture`. Re-reading git status
//    here would reintroduce exactly the incoherence the fence exists to
//    prevent: a snapshot taken after the fence proved the tree stable could
//    disagree with the contribution built from it, and the session would
//    persist two mutually inconsistent descriptions of its own end state.
//
// 7. **The framework observation is snapshot-directed.** Whether an end
//    observation is meaningful depends on the framework mode recorded in
//    the session-start evaluation snapshot (M 0.8.0 step 5), which is
//    persisted session state, NOT live config -- reading it is compatible
//    with lock #1.
//
//      auto     -> observe every declared framework-signature path and
//                  persist `detected_frameworks_at_end`, EVEN WHEN EMPTY.
//      explicit -> omit the field. Detection is not consulted at all, so
//                  an observation would be noise.
//      no snapshot (pre-0.8.0 session) -> omit. The mode is unknowable,
//                  and guessing would be worse than absence.
//
//    Present-but-empty and absent are DIFFERENT facts and must stay that
//    way: `[]` means "observed, found none"; absence means "never
//    observed". A reader that collapsed them would silently treat a
//    frameworkless end state as unobserved, and the distinction cannot be
//    recovered later. `buildContributionFile` preserves it by
//    discriminating on `undefined` rather than on emptiness.
//
//    Absence under `explicit` is a PRODUCER convention enforced here, not
//    a schema constraint. `detected_frameworks_at_end` is a plain optional
//    field, and the contribution schema cannot see the session snapshot,
//    so it is structurally incapable of enforcing mode-dependent absence.
//
//    Passing the signature paths as `additionalObservationPaths` is what
//    makes the observation trustworthy rather than merely present: those
//    paths join the observation set on BOTH sides, so the fence proves the
//    framework evidence belongs to the same stable end state as the
//    contribution itself. Detection then reads that observation set rather
//    than the candidate-only mirror -- which matters because signature
//    files are usually UNCHANGED (Laravel needs composer.json AND artisan),
//    so a candidate-only view would miss them entirely.
//
// =============================================================================
// Callers must catch these typed errors and map to presentation
// =============================================================================
//
// - RepoRootNotFoundError    (from @viberevert/core) → "No git repo..." copy
// - NoActiveSessionError     (from @viberevert/core) → "No active session..."
//   copy. Thrown by the PRE-CHECK when there is nothing to end.
// - ConcurrentOperationError (from ../locks.js)      → D22 concurrent-operation
//   refusal. Propagates unwrapped: it is the same class, carrying the same
//   lockDir and lock metadata, that `viberevert start` already surfaces, and
//   re-wrapping it would force callers to learn a second name for one
//   condition.
// - EndSessionRaceError      (operation-defined)     → see below.
// - RuntimeEnvInvalidError   (from runtime-env.js)   → test-only env
//   override malformed.

import { hostname } from "node:os";
import { join } from "node:path";
import {
  detectFrameworksFromObservedStates,
  endSession,
  FRAMEWORK_OBSERVATION_PATHS,
  loadActiveSessionLock,
  loadSession,
  NoActiveSessionError,
  putObject,
  resolveRepoRoot,
} from "@viberevert/core";
import {
  buildContributionFile,
  type ContributionCaptureResult,
  captureContribution,
} from "@viberevert/git";

import { type LockInfo, withExclusiveLock } from "../locks.js";
import { resolveNowForCliTimestamp } from "../runtime-env.js";
import { START_LOCK_REL } from "./start-session.js";

const VIBEREVERT_DIR = ".viberevert";
const SESSIONS_SUBDIR = "sessions";

/**
 * Name of the checkpoint subdir inside a session dir.
 *
 * MUST match what `startSessionOperation` passes as `createCheckpoint`'s
 * `checkpointDir` (`join(tmpSessionDir, "checkpoint")`). The writer and this
 * reader are in different functions in different files, so the agreement is
 * pinned by an architectural invariant rather than by a shared import —
 * start-session.ts owns the write path and has no reason to export a
 * constant for it.
 */
const SESSION_CHECKPOINT_DIRNAME = "checkpoint";

/**
 * D22 lock metadata `command` label.
 *
 * Deliberately NOT a command line. `viberevert end`, `viberevert run`, and
 * `viberevert shell` all close their sessions through this one transaction,
 * and `EndSessionOperationOpts` is held at `{ cwd }` for 4c, so caller
 * identity is not available here. Naming any single front-end command would
 * put a command the user never ran into a D22 refusal message; naming the
 * lifecycle operation is true no matter which one drove it. The shared
 * refusal copy supplies the surrounding context.
 */
const END_LOCK_COMMAND = "end-session";

/**
 * `active-session.json` disappeared between this operation's pre-check and
 * core's re-check, INSIDE the D22 lock.
 *
 * Reframed in M 0.8.0 step 4c. Before the lock existed this was the ordinary
 * lost-race outcome of two concurrent `viberevert end` invocations. It no
 * longer is: a competing end is now refused at lock acquisition with
 * ConcurrentOperationError, having done no work. What remains is the
 * out-of-band case — the file deleted by hand, by a script, or by a tool that
 * does not honor the lock — so the condition is rarer and means something
 * different, but it is still reachable and still distinct from the pre-check
 * refusal, which is why it keeps its own class.
 */
export class EndSessionRaceError extends Error {
  constructor(cause?: unknown) {
    super("Active session was removed out of band between check and end", { cause });
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
  /**
   * Best-effort cleanup diagnostics from the capture oracle's disposable
   * worktree (M 0.8.0). NONFATAL: the session is fully ended whether or not
   * the temp tree was reclaimed, and a non-empty list never changes a
   * caller's success exit code.
   *
   * Callers MUST NOT silently discard a non-empty list. Every end call site
   * surfaces it through the presentation channel it already owns — the CLI's
   * stderr warnings channel per D13/D20, the same channel `listSessions`
   * warnings use. A leaked worktree under the system temp dir is the kind of
   * thing that stays invisible until a disk fills, so "ended successfully,
   * and here is what could not be cleaned up" is the honest report. Slice C
   * wires the five call sites.
   *
   * Additive: existing callers that destructure only the first four fields
   * keep compiling.
   */
  cleanupWarnings: readonly string[];
};

export async function endSessionOperation(
  opts: EndSessionOperationOpts,
): Promise<EndSessionOperationResult> {
  // Step 1: resolve repo root from caller-supplied cwd.
  const repoRoot = resolveRepoRoot(opts.cwd);

  // Step 2: first of the two clock samples (lock #3). Lock-acquisition
  // attempt time, and the early environment validation that keeps a malformed
  // VIBEREVERT_TEST_FIXED_NOW from ever taking the lock.
  const lockStartedAt = resolveNowForCliTimestamp();

  const protectedFlow = async (): Promise<EndSessionOperationResult> => {
    // Step 3: pre-check the active lock — both for the friendly refusal and
    // for the result data (session_id, started_at, task). Cheap-refusal-first
    // matters more than it used to: everything after this point reconstructs a
    // worktree and hashes the tree.
    const lock = await loadActiveSessionLock(repoRoot);
    if (lock === null) {
      throw new NoActiveSessionError();
    }

    // Step 4: load the session the lock names. `loadSession` validates the
    // schema and verifies the internal session_id against the requested one
    // (core architectural lock #7), so corrupt or missing session state
    // refuses HERE — before the oracle reconstructs a worktree and before the
    // object store receives payloads no contribution would ever reference.
    const session = await loadSession(lock.session_id, repoRoot);

    // Lock #7: the framework mode comes from the persisted session-start
    // snapshot, never from live config. A pre-0.8.0 session has no snapshot,
    // which has the same producer ACTION as `explicit` here: make no
    // observation, without treating the unknown mode as explicit.
    const isAutoFrameworkMode = session.evaluation_snapshot?.frameworks.mode === "auto";

    const checkpointDir = join(
      repoRoot,
      VIBEREVERT_DIR,
      SESSIONS_SUBDIR,
      lock.session_id,
      SESSION_CHECKPOINT_DIRNAME,
    );

    // Step 5: capture the contribution and publish the whole terminal state
    // from inside the oracle, immediately after a matching fence. `publish`
    // returns the `ended_at` it sampled, so the result reports the value that
    // was actually persisted rather than a second guess at it.
    //
    // The loaded session is the checkpoint-id authority for the contribution.
    // The active lock supplies session_id, started_at, and task; it is not
    // consulted for checkpoint identity.
    let captured: ContributionCaptureResult<string>;
    try {
      captured = await captureContribution<string>(repoRoot, checkpointDir, {
        sessionId: lock.session_id,
        checkpointId: session.checkpoint_id,
        // Lock #7: the signature paths join the observation set on BOTH
        // sides under `auto`, so the fence proves the framework evidence
        // belongs to the same stable end state as the contribution. Under
        // `explicit`, and for a pre-0.8.0 session with no snapshot, no
        // observation is made, so there is nothing to fence.
        additionalObservationPaths: isAutoFrameworkMode ? [...FRAMEWORK_OBSERVATION_PATHS] : [],
        storeObject: async (object) => {
          // Git derived `object.digest` from these bytes; core re-derives it
          // independently inside putObject and returns what IT computed.
          // Asserting equality is what closes the seam between the two
          // packages: they agree on the address, or capture fails before the
          // contribution can reference a payload that is not where it says it
          // is. putObject separately refuses to overwrite a hash path holding
          // different content, so a real collision surfaces as
          // ObjectCorruptionError rather than silent replacement.
          const storedDigest = await putObject(repoRoot, object.data);
          if (storedDigest !== object.digest) {
            throw new Error(
              `object store digest mismatch: @viberevert/git expected ${object.digest}, putObject derived ${storedDigest}`,
            );
          }
        },
        publish: async (stable) => {
          // Second clock sample (lock #3): the moment the session ends, after
          // the fence has proven the end state stable and before anything is
          // written.
          const endedAt = resolveNowForCliTimestamp();

          const contribution = buildContributionFile(stable, {
            endedAt,
            // Lock #7: `[]` is a real result (observed, found none) and is
            // persisted as such. Only a non-auto session omits the field.
            ...(isAutoFrameworkMode
              ? {
                  detectedFrameworksAtEnd: detectFrameworksFromObservedStates(
                    stable.endWorktreeStates,
                  ),
                }
              : {}),
          });
          // Lock #4: THESE bytes are what core digests and writes verbatim.
          const contributionBytes = Buffer.from(JSON.stringify(contribution, null, 2), "utf8");

          await endSession({
            repoRoot,
            endedAt,
            // Lock #6: both snapshots come off the capture, not a fresh read.
            afterStatusText: stable.afterStatusText,
            afterStatusZRaw: stable.afterStatusZRaw,
            contributionBytes,
          });

          return endedAt;
        },
      });
    } catch (err) {
      // Only core's re-check can raise this here; the pre-check above already
      // returned. Under the D22 lock it means out-of-band deletion.
      if (err instanceof NoActiveSessionError) {
        throw new EndSessionRaceError(err);
      }
      throw err;
    }

    return {
      sessionId: lock.session_id,
      startedAt: lock.started_at,
      endedAt: captured.value,
      ...(lock.task !== undefined ? { task: lock.task } : {}),
      cleanupWarnings: captured.cleanupWarnings,
    };
  };

  const lockInfo: LockInfo = {
    pid: process.pid,
    command: END_LOCK_COMMAND,
    started_at: lockStartedAt,
    host: hostname(),
  };

  return withExclusiveLock(join(repoRoot, START_LOCK_REL), lockInfo, protectedFlow);
}
