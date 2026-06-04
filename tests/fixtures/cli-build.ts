// tests/fixtures/cli-build.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Shared build-driving helper for golden-fixture test files. Used by
// BOTH golden-reports.test.ts (M C) and golden-receipts.test.ts (M D).
// Each test file's beforeAll hook calls `ensureCliBuilt()`, which:
//
//   1. Fast-paths if `packages/cli/dist/index.js` already exists as a
//      real regular file.
//   2. Otherwise acquires an mkdir-based exclusive lock and runs the
//      build (one worker only, even when vitest runs multiple test
//      files in parallel).
//   3. Other workers poll for dist to appear OR the lock to be released
//      without dist appearing (which indicates the owner's build
//      failed/crashed) — in the latter case they retry acquisition.
//
// Without this coordination, M D's introduction of a SECOND golden-
// fixture test file would race the existing M C one on clean CI:
// both beforeAll hooks would see dist missing and both would spawn
// `pnpm --filter viberevert... build`, racing for the same outputs
// and running `finalize-bin.mjs` concurrently.
//
// =============================================================================
// Locks (per Step 8 Substep B)
// =============================================================================
//
// 1. **Atomic mkdir-based exclusive lock at BUILD_LOCK_PATH.**
//    `mkdir(BUILD_LOCK_PATH, { recursive: false })` is atomic on every
//    supported filesystem (POSIX + NTFS) — either creates the dir or
//    fails with EEXIST. No native deps, no library dep. Same primitive
//    as `packages/cli/src/locks.ts`'s `withExclusiveLock`, scoped here
//    to the test-build layer.
//
//    The lock path lives at REPO ROOT (NOT under
//    `.viberevert/.locks/`) because this lock isn't part of
//    `.viberevert/` runtime state — it's a test-harness coordination
//    primitive that exists only for the duration of a test run. The
//    repo's `.gitignore` includes `/.viberevert-test-cli-build.lock`
//    (root-anchored leading slash + no trailing slash so the pattern
//    matches both the normal-case dir AND a stale wrong-shape file
//    at the repo-root lock path only) so dev `pnpm test` runs don't
//    surface the lock as untracked.
//
// 2. **Lock removed only by the owner in a finally block.** Waiters
//    MUST NEVER call `rm` on the lock path. If a waiter could remove
//    it, two workers might both believe they own the lock and race
//    to build. The owner's finally guarantees the lock is removed
//    on both success AND throw — but a process-crash before finally
//    runs leaves a stale lock that subsequent waiters surface via
//    the timeout-error path (lock #5).
//
// 3. **Waiters poll for CLI dist existence as the primary success
//    signal; lock-path EXISTENCE (any shape) as the secondary
//    signal.** `lockPathExists()` returns true for ANY entry at the
//    lock path — dir, file, symlink, etc. — because `mkdir` would
//    return EEXIST against any of those. Treating wrong-shape entries
//    as "lock held" prevents a tight retry loop: a stale regular
//    file at the lock path (from some pathological prior state)
//    would otherwise make `mkdir` EEXIST while the waiter sees
//    "lock gone", retry, EEXIST again, ad infinitum. With the
//    existence-check, the waiter eventually surfaces the stale-lock
//    via the timeout path (lock #5) and the user removes it
//    manually.
//
//    The per-cycle dist-existence check happens BEFORE the lock-
//    existence check so a race between dist-appearing and lock-
//    being-removed resolves as the strong "dist-appeared" success
//    signal.
//
// 4. **Retry on lock-gone-dist-missing (bounded by
//    BEFORE_ALL_TIMEOUT_MS).** A crashed owner can release the lock
//    without producing dist. The waiter retries acquisition in that
//    case — the next acquirer attempts the build itself. Bounded by
//    the overall beforeAll deadline (passed through to
//    `waitForDistOrLockGone` so its inner wait is clamped to
//    `min(now + BUILD_LOCK_WAIT_TIMEOUT_MS, overallDeadline)`).
//    Without that clamp, repeated retry cycles could overshoot the
//    overall budget and let vitest's hook timer race the inner
//    timeout. The acquirer's own build failure does NOT retry within
//    the same invocation — it throws immediately so the actual
//    build error (tsc message etc.) reaches the user.
//
// 5. **Stale-lock recovery via timeout error.** If
//    BUILD_LOCK_WAIT_TIMEOUT_MS expires while a waiter is polling
//    AND the lock is still present AND dist is still missing, the
//    owner appears stuck (mid-process death, hung subprocess, stale
//    wrong-shape entry at the lock path, etc.). The error message
//    names BOTH the lock path AND the CLI path AND includes manual
//    cleanup guidance: "Remove .viberevert-test-cli-build.lock if
//    no test/build process is running." Matches the M B lock-
//    recovery contract (manual only; auto-recovery is non-trivial
//    and the lock window is short in normal operation).
//
// 6. **Windows build invocation inherited verbatim from M C Step 11.**
//    `cmd.exe /d /s /c pnpm.cmd ...` rather than `shell: true` or
//    `execFile("pnpm.cmd", ...)`. The historical bug:
//      - `execFile("pnpm", ...)` ENOENTs (Node doesn't auto-resolve
//        the `.cmd` extension on Windows).
//      - `execFile("pnpm.cmd", ...)` fails with `spawn EINVAL`
//        because Node's spawn syscall cannot directly invoke
//        `.cmd`/`.bat` files on Windows — the OS requires a
//        command interpreter to parse batch syntax.
//    The fix uses `cmd.exe` explicitly, avoiding the broad
//    `shell: true` toggle that would alter argument escaping for
//    everything else.
//
// 7. **Timeout budget formula (with DEADLINE_SLOP_MS).**
//      BUILD_TIMEOUT_MS = 120_000              (the build subprocess)
//      BUILD_LOCK_WAIT_TIMEOUT_MS = BUILD_TIMEOUT_MS + 5_000  (wait for owner)
//      HOOK_TIMER_BUFFER_MS = 30_000           (so inner subprocess timeout fires first)
//      DEADLINE_SLOP_MS = 1_000                (clock drift / poll rounding slack)
//      BEFORE_ALL_TIMEOUT_MS = BUILD_TIMEOUT_MS              (own build)
//                              + BUILD_LOCK_WAIT_TIMEOUT_MS   (worst case: full wait)
//                              + HOOK_TIMER_BUFFER_MS         (hook-timer buffer)
//                              + DEADLINE_SLOP_MS             (slack)
//                          ≈ 276_000  (4m36s)
//    Covers the worst safe path: wait full timeout for a crashed
//    owner, retry acquisition, run own build, with HOOK_TIMER_BUFFER_MS
//    so the inner subprocess timeout always fires before vitest's
//    hook-timer, plus DEADLINE_SLOP_MS so clock drift or
//    poll-interval rounding can't eat into the buffer at the worst-
//    case path's edges. The wait helper clamps its own deadline
//    against this overall budget (lock #4) so retry cycles never
//    cumulatively exceed it. The pre-build budget guard (lock #9)
//    enforces a `MIN_PRE_BUILD_BUDGET_MS = BUILD_TIMEOUT_MS +
//    HOOK_TIMER_BUFFER_MS` floor at acquisition time, so the formula
//    is enforced at three layers: outer (BEFORE_ALL_TIMEOUT_MS),
//    waiter (clamped), acquirer (pre-build floor).
//
// 8. **Errno discipline: only swallow ENOENT in existence probes.**
//    `cliDistExists()` and `lockPathExists()` both wrap `lstat()`
//    in try/catch but ONLY treat ENOENT as "not present" — every
//    other errno (EACCES, EISDIR, EIO, EPERM, etc.) propagates. A
//    catch-all would silently treat permission errors as
//    "dist missing" and trigger an unnecessary build that itself
//    would fail with the same permission error, hiding the real
//    underlying problem (a bad filesystem ACL, a mount issue, etc.).
//
// 9. **Pre-build budget guard at acquisition time.** After a waiter
//    loops back from a `lock-gone-dist-missing` outcome and
//    successfully acquires the lock, the remaining `overallDeadline`
//    budget may be insufficient for a full build
//    (`MIN_PRE_BUILD_BUDGET_MS = BUILD_TIMEOUT_MS + HOOK_TIMER_BUFFER_MS`).
//    Starting a build with insufficient budget would let vitest's
//    hook timer fire before the inner subprocess timeout,
//    contradicting lock #7's "inner timeout fires first" promise.
//    The acquirer checks
//    `overallDeadline - Date.now() >= MIN_PRE_BUILD_BUDGET_MS`
//    AFTER the inside-lock dist-existence re-check (so we don't
//    waste time on a build if dist appeared between fast-path and
//    acquisition) and BEFORE invoking `runBuild()`. If insufficient,
//    throws the stale-lock message immediately. The lock is
//    released by the surrounding `finally` so subsequent invocations
//    see a clean state.

import { execFile } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Path resolution
// =============================================================================

const THIS_FILE = fileURLToPath(import.meta.url);
// tests/fixtures/cli-build.ts → up 2 → repo root.
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");

/**
 * Absolute path to the built CLI binary. Exported so both
 * golden-reports.test.ts and golden-receipts.test.ts can pass it
 * to their respective harness `runFixture` / `runReceiptFixture`
 * calls without re-deriving the path.
 */
export const CLI_BIN_ABS_PATH = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

/**
 * Lock path at repo root. Named `BUILD_LOCK_PATH` (not `_DIR`)
 * because lock-held detection treats ANY entry at this path
 * (dir, file, symlink) as held — see lock #3. In normal
 * operation it's a directory created by `mkdir`.
 */
const BUILD_LOCK_PATH = join(REPO_ROOT, ".viberevert-test-cli-build.lock");

// =============================================================================
// Locked timing constants
// =============================================================================

/**
 * Build-step subprocess timeout passed to `execFile`. CLI's tsc +
 * finalize-bin runs in ~5-10s on typical hardware; 2-min ceiling
 * accommodates slow CI runners AND the dependency-closed build
 * (which builds session-format, git, core, checks, reporters, and
 * cli in topological order).
 */
const BUILD_TIMEOUT_MS = 120_000;

/**
 * Per-waiter timeout while polling for either dist appearance or
 * lock disappearance. Set slightly larger than BUILD_TIMEOUT_MS so
 * a worker that runs its own build doesn't accidentally signal
 * "stale lock" to other waiters during the final few seconds of
 * its own build's deadline.
 */
const BUILD_LOCK_WAIT_TIMEOUT_MS = BUILD_TIMEOUT_MS + 5_000;

/**
 * Hook-timer buffer: amount by which BEFORE_ALL_TIMEOUT_MS exceeds
 * the inner subprocess timeout, so the inner timeout always fires
 * first (per lock #7) and so the pre-build budget guard (lock #9)
 * has a non-zero margin to enforce against.
 */
const HOOK_TIMER_BUFFER_MS = 30_000;

/**
 * Deadline slack. Added to BEFORE_ALL_TIMEOUT_MS to absorb clock
 * drift, poll-interval rounding (POLL_INTERVAL_MS), and
 * subprocess-start scheduling overhead, so the worst-case "wait
 * full timeout, then acquire and build" path doesn't fail by a
 * few milliseconds. NOT included in MIN_PRE_BUILD_BUDGET_MS — the
 * slack is purely additive at the outer budget, leaving the
 * acquirer's threshold tight to the actual minimum-needed.
 */
const DEADLINE_SLOP_MS = 1_000;

/**
 * Minimum budget required at acquisition time to start a build
 * (per lock #9). Sum of the inner build timeout and the hook-timer
 * buffer — enough to run a full build AND let the inner timeout
 * fire before the outer hook timer if the build hits its ceiling.
 * Does NOT include DEADLINE_SLOP_MS — that slack lives at the
 * outer BEFORE_ALL_TIMEOUT_MS only.
 */
const MIN_PRE_BUILD_BUDGET_MS = BUILD_TIMEOUT_MS + HOOK_TIMER_BUFFER_MS;

/**
 * Vitest `beforeAll` hook timeout. Covers the worst safe path:
 * wait the full BUILD_LOCK_WAIT_TIMEOUT_MS for a crashed owner,
 * THEN acquire and run own build (up to BUILD_TIMEOUT_MS), with
 * HOOK_TIMER_BUFFER_MS buffer for vitest hook-timer overhead and
 * DEADLINE_SLOP_MS slack for clock drift / poll-interval rounding.
 *
 * Exported so both test files use the same value in their
 * `beforeAll(ensureCliBuilt, BEFORE_ALL_TIMEOUT_MS)` calls.
 */
export const BEFORE_ALL_TIMEOUT_MS =
  BUILD_TIMEOUT_MS + BUILD_LOCK_WAIT_TIMEOUT_MS + HOOK_TIMER_BUFFER_MS + DEADLINE_SLOP_MS;

/**
 * Poll interval while waiting for another worker's build. 250ms is
 * responsive without being noisy (4 polls/sec across both waiting
 * workers = ~8 lstat calls/sec total — negligible).
 */
const POLL_INTERVAL_MS = 250;

/**
 * Subprocess buffer cap. Default 1MB is too tight for a multi-package
 * tsc build that may produce substantial stdout under -r mode.
 */
const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// =============================================================================
// Build invocation (platform-conditional; inherited from M C Step 11)
// =============================================================================

const PNPM_BUILD_COMMAND = process.platform === "win32" ? "cmd.exe" : "pnpm";
const PNPM_BUILD_ARGS =
  process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm.cmd", "--filter", "viberevert...", "build"]
    : ["--filter", "viberevert...", "build"];

// =============================================================================
// Public entrypoint
// =============================================================================

/**
 * Ensure `packages/cli/dist/index.js` exists as a real regular file
 * before any golden fixture test runs. Coordinates concurrent
 * vitest workers via an mkdir-based exclusive lock at
 * BUILD_LOCK_PATH.
 *
 * Behavior:
 *   - Fast path: if dist already exists, returns immediately.
 *   - Acquirer: re-checks dist inside the lock; checks remaining
 *     budget against MIN_PRE_BUILD_BUDGET_MS (lock #9); builds;
 *     removes lock in `finally`.
 *   - Waiter: polls for dist existence with a deadline clamped
 *     against the overall budget. If the lock disappears without
 *     dist appearing, re-enters acquisition (handles
 *     crashed-owner case).
 *
 * Bounded by BEFORE_ALL_TIMEOUT_MS overall. The wait helper
 * receives `overallDeadline` and clamps its inner wait against it
 * so retry cycles never cumulatively overshoot the outer budget.
 * The pre-build budget guard (lock #9) further protects against
 * starting a build with insufficient time left.
 *
 * On exhaustion of either the per-cycle wait, the overall
 * deadline, or the pre-build budget check, throws with the lock
 * path + CLI path + manual cleanup guidance.
 */
export async function ensureCliBuilt(): Promise<void> {
  const overallDeadline = Date.now() + BEFORE_ALL_TIMEOUT_MS;

  while (Date.now() < overallDeadline) {
    // Fast path / start-of-cycle check.
    if (await cliDistExists()) return;

    // Try to acquire the build lock atomically. EEXIST = held by
    // another worker; any other error propagates.
    let acquired = false;
    try {
      await mkdir(BUILD_LOCK_PATH, { recursive: false });
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    if (acquired) {
      try {
        // Re-check inside the lock: another worker may have built
        // between our fast-path check and our acquisition (rare
        // but possible due to scheduler interleaving).
        if (await cliDistExists()) return;

        // Pre-build budget guard (lock #9). Ensure enough time
        // remains for a full build (BUILD_TIMEOUT_MS) plus the
        // hook-timer buffer (HOOK_TIMER_BUFFER_MS) so the inner
        // subprocess timeout always fires before vitest's hook
        // timer. Without this, a waiter that loops back near the
        // deadline could acquire and start a 120s build with
        // seconds left, letting vitest's hook timer race the
        // inner timeout. DEADLINE_SLOP_MS is intentionally NOT
        // part of this threshold — it lives only at the outer
        // budget.
        const remainingBudgetMs = overallDeadline - Date.now();
        if (remainingBudgetMs < MIN_PRE_BUILD_BUDGET_MS) {
          throw new Error(buildStaleLockMessage());
        }

        await runBuild();
        await assertCliDistShape();
        return;
      } finally {
        // Owner-only cleanup. Swallow cleanup errors so the build's
        // success/failure (or the budget-guard throw) surfaces
        // unobscured. A failed cleanup leaves a stale lock that
        // subsequent invocations surface via the timeout path.
        await rm(BUILD_LOCK_PATH, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Lock not acquired — poll-wait. Three outcomes: dist appears
    // (we're done), lock disappears without dist (retry
    // acquisition), or timeout (stale lock). Pass the overall
    // deadline so the inner wait is clamped against it.
    const outcome = await waitForDistOrLockGone(overallDeadline);
    if (outcome === "dist-appeared") return;
    if (outcome === "timeout") {
      throw new Error(buildStaleLockMessage());
    }
    // outcome === "lock-gone-dist-missing" — loop back to retry
    // acquisition. The overall deadline check at the top of the
    // loop bounds the retry count; the pre-build budget guard
    // catches near-deadline retries from starting doomed builds.
  }

  // Overall deadline expired across retries. Unlikely in normal
  // operation but defensive against pathological repeat-fail loops.
  throw new Error(buildStaleLockMessage());
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Check that `packages/cli/dist/index.js` exists as a real regular
 * file. `lstat` (not `stat`) is symlink-strict: a symlinked-FIFO at
 * that path would NOT pass. Per lock #8, only ENOENT is swallowed
 * as "not present" — every other errno propagates so real FS
 * problems (EACCES, EIO, etc.) surface instead of being silently
 * treated as "dist missing".
 */
async function cliDistExists(): Promise<boolean> {
  try {
    const st = await lstat(CLI_BIN_ABS_PATH);
    return st.isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Check whether ANY entry exists at BUILD_LOCK_PATH (dir, file,
 * symlink, etc.). Returns true for any existing path — see
 * lock #3 for why wrong-shape detection matters (prevents a
 * tight mkdir-EEXIST + isDirectory-false retry loop). Per
 * lock #8, only ENOENT is swallowed.
 */
async function lockPathExists(): Promise<boolean> {
  try {
    await lstat(BUILD_LOCK_PATH);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Post-build sanity check. Asserts dist exists as a real regular
 * file, with a clean error message for the two failure modes:
 *   - lstat throws ENOENT (build exited 0 but produced no file
 *     at the expected path — tsconfig misemit, wrong outDir, etc.)
 *   - lstat succeeds but isFile() is false (path is a dir, symlink,
 *     FIFO, etc.)
 */
async function assertCliDistShape(): Promise<void> {
  try {
    const st = await lstat(CLI_BIN_ABS_PATH);
    if (!st.isFile()) {
      throw new Error(
        `CLI build did not produce a regular file at ${CLI_BIN_ABS_PATH}. ` +
          `Check the build output for errors.`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `CLI build did not produce a regular file at ${CLI_BIN_ABS_PATH}. ` +
          `Check the build output for errors.`,
      );
    }
    throw err;
  }
}

/**
 * Run `pnpm --filter viberevert... build` from REPO_ROOT.
 * Dependency-closed (the `...` suffix) so all transitive workspace
 * deps build in topological order. Wraps execFile failures with
 * stdout + stderr so a CI build failure says exactly what tsc
 * complained about.
 */
async function runBuild(): Promise<void> {
  try {
    await execFileAsync(PNPM_BUILD_COMMAND, PNPM_BUILD_ARGS, {
      cwd: REPO_ROOT,
      windowsHide: true,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    throw new Error(
      `Failed to auto-build CLI for golden fixture tests.\n` +
        `Command: ${PNPM_BUILD_COMMAND} ${PNPM_BUILD_ARGS.join(" ")}\n` +
        `stdout:\n${String(e.stdout ?? "")}\n` +
        `stderr:\n${String(e.stderr ?? e.message ?? "")}`,
    );
  }
}

type WaitOutcome = "dist-appeared" | "lock-gone-dist-missing" | "timeout";

/**
 * Poll-wait for either of:
 *   - CLI dist appears → "dist-appeared" (waiter is done)
 *   - Lock path disappears AND dist still missing →
 *     "lock-gone-dist-missing" (caller retries acquisition)
 *   - The clamped wait deadline elapses → "timeout"
 *
 * The wait deadline is clamped to
 * `min(now + BUILD_LOCK_WAIT_TIMEOUT_MS, overallDeadline)` per
 * lock #4, so this helper never overshoots the outer budget across
 * multiple retry cycles.
 *
 * dist-existence check is FIRST per cycle so a race between dist
 * appearing and the lock being removed resolves as
 * "dist-appeared" (the strong success signal per lock #3).
 */
async function waitForDistOrLockGone(overallDeadline: number): Promise<WaitOutcome> {
  const waitDeadline = Math.min(Date.now() + BUILD_LOCK_WAIT_TIMEOUT_MS, overallDeadline);
  while (Date.now() < waitDeadline) {
    if (await cliDistExists()) return "dist-appeared";
    if (!(await lockPathExists())) return "lock-gone-dist-missing";
    await delay(POLL_INTERVAL_MS);
  }
  // Final check after timeout — race window where lock was just
  // removed or dist just appeared right at the deadline.
  if (await cliDistExists()) return "dist-appeared";
  if (!(await lockPathExists())) return "lock-gone-dist-missing";
  return "timeout";
}

/**
 * Sleep for `ms` milliseconds. Promise-wrapped setTimeout.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the stale-lock timeout error message. Includes the locked
 * recovery instruction (per lock #5).
 */
function buildStaleLockMessage(): string {
  return (
    `Timed out waiting for another vitest worker to build CLI dist at ${CLI_BIN_ABS_PATH}.\n` +
    `Remove .viberevert-test-cli-build.lock if no test/build process is running.\n` +
    `Lock path: ${BUILD_LOCK_PATH}`
  );
}
