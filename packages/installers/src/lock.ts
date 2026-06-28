// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Atomic mkdir-based installer lock per D101.L.
//
// Per-repo singleton: only one install/uninstall transaction may
// hold the lock at a time. Acquisition uses mkdir, which is atomic
// on both POSIX and NTFS for non-existent directories. If the dir
// already exists (concurrent acquire OR stale from a prior crash),
// mkdir throws EEXIST and we surface IntegrationsLockError with
// best-effort diagnostic info -- but ONLY after lstat-verifying the
// existing lock dir is a real directory (not a symlink, not a file).
// A symlinked or non-directory lockDir surfaces the safety violation
// (SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError)
// instead of a generic lock-held error, because that's the more
// actionable diagnostic.
//
// .viberevert/ parent safety: before any lock-dir mutation, we lstat
// .viberevert/ (NOT stat) to refuse a symlinked parent. Without this
// check, `.viberevert -> /tmp/elsewhere` would leak the lock + all
// subsequent installer writes outside the repo root -- a global-write
// violation per rule 14. repoRoot itself may be symlinked (common in
// CI/monorepo setups, consistent with 2D preflight semantics); only
// .viberevert/ and integrations.lock/ are refused as symlinks.
//
// repoRoot is lexically resolved via path.resolve() at acquireLock
// entry. Lexical only -- never realpath() -- so a symlinked repo dir
// is tolerated, but a relative repoRoot gets normalized against cwd
// up front rather than carried through mutation paths.
//
// Parent-creation race: if our lstat reports ENOENT and we then
// mkdir .viberevert/, another process may have created it between
// those two calls (as a real dir OR as a symlink). EEXIST on our
// mkdir re-runs the lstat guard, which accepts a real dir and
// refuses a symlinked/file kind with the right typed error.
//
// TOCTOU disclaimer: this is a pre-mutation symlink guard, NOT a
// full TOCTOU-proof sandbox. Node's portable fs API does not let us
// mkdirat under an already-open directory fd. A hostile concurrent
// process could swap .viberevert/ between our lstat guard and the
// subsequent mkdir(lockDir). The guard refuses obvious existing
// symlink escapes before any mutation; hostile concurrent swaps are
// out of scope for M G1b.
//
// Lock body: pid.json inside the lock dir, carrying
// { pid, startedAt, command }. This lets the user diagnose "what
// process is holding this lock?" without external tools. Parsing
// pid.json is BEST-EFFORT -- the stale-lock error fires regardless
// of whether we can read or parse the file.
//
// Acquire failure cleanup: if the pid.json write fails AFTER the
// lock-dir mkdir succeeded, we unlink any partial pid.json
// (best-effort) AND rmdir the lock dir (best-effort) before
// re-throwing the original write error. Without the unlink, a
// partial pid.json would cause rmdir to fail ENOTEMPTY, leaving a
// stale lock from a failed acquisition. Both cleanup steps swallow
// their own errors so the original write error is always what
// propagates.
//
// LockHandle is BRANDED with a module-private unique symbol so a
// future caller/test cannot accidentally fabricate one via plain
// object literal. Tests that need a synthetic handle must use
// `as unknown as LockHandle` to make the cast deliberate.
//
// LockHandle carries only `lockDir`. pidPath is derived inside
// releaseLock from `join(lockDir, PID_FILENAME)` rather than carried
// in the handle, so even a deliberately-cast handle cannot redirect
// unlink to an arbitrary file via a wrong pidPath.
//
// Release order: lstat-guard lock dir -> unlink(pid.json) -> rmdir
// (lock dir). The lstat guard is defense-in-depth against an attacker
// swapping the lock dir for a symlink between acquire and release.
// rmdir fails ENOTEMPTY if pid.json is still inside, so order
// matters.
//
// ENOENT on pid.json during release: NOT silently swallowed. If
// pid.json is missing at release time, something corrupted the lock
// state; surface the error rather than pretending release succeeded.
//
// Best-effort cleanup on release failure: releaseLock throws normally
// on any error. The engine (2H) decides whether to swallow -- if the
// surrounding transaction has already committed integrations.json, a
// release failure should print a stderr warning but NOT roll back
// the successful commit. lock.ts itself does not know about commit
// state.
//
// No --force-lock flag in M G1b (per locked rule 15 + deferred to
// M G1b-followup-14). No automatic stale-lock cleanup.
//
// D101.M.7: this module contains the ONLY call sites for
// mkdir(<lockDir>), unlink(<pidPath>), and rmdir(<lockDir>) in
// @viberevert/installers/src/. The mkdir of .viberevert/ (the lock's
// PARENT) is outside the invariant -- it ensures the parent exists
// so the atomic lock-dir mkdir below can succeed or fail meaningfully.

import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CommandKind } from "./engine-types.js";
import {
  IntegrationsLockError,
  IntegrationTargetParentNotDirectoryError,
  SymlinkTargetRefusal,
} from "./errors.js";

const VIBEREVERT_DIR_NAME = ".viberevert";
const LOCK_DIR_NAME = "integrations.lock";
const PID_FILENAME = "pid.json";

const LOCK_HANDLE_BRAND: unique symbol = Symbol("viberevert.lockHandle");

/**
 * Opaque handle returned by acquireLock; pass to releaseLock to
 * release. Carries only the lock dir -- the pid.json path is derived
 * inside releaseLock so a malformed handle cannot redirect unlink
 * to an arbitrary file. Branded with a module-private symbol so
 * callers cannot construct one via plain object literal.
 */
export interface LockHandle {
  readonly lockDir: string;
  readonly [LOCK_HANDLE_BRAND]: true;
}

/**
 * Acquire the installer lock for `repoRoot`. Atomic via mkdir of
 * `.viberevert/integrations.lock/`. Throws IntegrationsLockError if
 * the lock dir already exists and is a real directory (concurrent
 * transaction OR stale lock from a prior crash). Throws
 * SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError if
 * `.viberevert/` OR the existing lock dir is a symlink or
 * non-directory.
 *
 * On success, writes `pid.json` inside the lock dir carrying
 * { pid, startedAt, command } for diagnostic. If that write fails,
 * any partial pid.json is unlinked and the lock dir is rmdir'd
 * before the error propagates, so a failed acquisition leaves no
 * stale lock.
 */
export async function acquireLock(repoRoot: string, command: CommandKind): Promise<LockHandle> {
  const repoRootAbs = resolve(repoRoot);
  const viberevertDir = join(repoRootAbs, VIBEREVERT_DIR_NAME);
  const lockDir = join(viberevertDir, LOCK_DIR_NAME);
  const pidPath = join(lockDir, PID_FILENAME);

  await ensureViberevertDir(viberevertDir, lockDir);

  // The actual lock primitive: non-recursive mkdir. EEXIST = lock
  // dir already exists; any other error propagates as-is.
  try {
    await mkdir(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Verify the existing lockDir is a real directory before
      // reading pid.json through it. A symlinked or non-directory
      // lockDir surfaces the safety violation; only a real-directory
      // lockDir becomes an IntegrationsLockError.
      await assertExistingLockDirIsSafe(lockDir, pidPath);
      const existingPid = await tryReadExistingPid(pidPath);
      throw new IntegrationsLockError({ lockDir, pidPath, existingPid });
    }
    throw err;
  }

  // Lock acquired. Write pid.json inside the exclusive dir; no race
  // possible because we just won the mkdir. Plain writeFile is
  // sufficient -- atomicity isn't needed for a best-effort diagnostic.
  // If the write fails (e.g., quota), clean up BOTH any partial
  // pid.json AND the lock dir before propagating. Without the
  // unlink, a partial pid.json would cause rmdir to fail ENOTEMPTY,
  // leaving a stale lock. Both cleanup steps swallow their own
  // errors so the original write error is always what propagates.
  const pidData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command,
  };
  try {
    await writeFile(pidPath, `${JSON.stringify(pidData)}\n`, "utf8");
  } catch (writeErr) {
    try {
      await unlink(pidPath);
    } catch {
      // Best-effort cleanup; pid.json may not have been created.
    }
    try {
      await rmdir(lockDir);
    } catch {
      // Best-effort cleanup; preserve the original pid-write error.
    }
    throw writeErr;
  }

  return { lockDir, [LOCK_HANDLE_BRAND]: true };
}

/**
 * Release the installer lock. Order: lstat-guard the lock dir ->
 * unlink pid.json (path derived from lockDir) -> rmdir the lock dir.
 * The lstat guard is defense-in-depth (rejects a lock dir that was
 * swapped to a symlink between acquire and release).
 *
 * Throws on any I/O failure including ENOENT on pid.json -- missing
 * pid.json indicates corruption that should surface, not be silently
 * swallowed.
 *
 * The caller (engine in 2H) decides whether to swallow release
 * errors: if the surrounding transaction already committed
 * integrations.json, a release failure should be logged to stderr as
 * a warning, NOT rolled back. lock.ts cannot make that decision; it
 * just reports.
 */
export async function releaseLock(handle: LockHandle): Promise<void> {
  const pidPath = join(handle.lockDir, PID_FILENAME);
  await assertExistingLockDirIsSafe(handle.lockDir, pidPath);
  await unlink(pidPath);
  await rmdir(handle.lockDir);
}

/**
 * Ensure `.viberevert/` exists as a regular directory. lstat-check:
 * refuse if symlink, refuse if non-directory, return if directory,
 * create (non-recursive mkdir) if ENOENT. mkdir EEXIST (another
 * process created the dir between our lstat and mkdir) re-runs the
 * guard, which accepts a real dir and rejects a symlink/file.
 *
 * `lockDir` is passed in only to populate the targetPath field on
 * the SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError
 * so the diagnostic names the eventual mutation target, not just the
 * intermediate parent.
 */
async function ensureViberevertDir(viberevertDir: string, lockDir: string): Promise<void> {
  try {
    const st = await lstat(viberevertDir);
    if (st.isSymbolicLink()) {
      throw new SymlinkTargetRefusal({
        targetPath: lockDir,
        symlinkedComponentPath: viberevertDir,
      });
    }
    if (!st.isDirectory()) {
      throw new IntegrationTargetParentNotDirectoryError({
        targetPath: lockDir,
        parentPath: viberevertDir,
      });
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // .viberevert/ does not exist as of the lstat check -- create it.
  // Race: another process may have created it (as dir, symlink, or
  // file) between our lstat and our mkdir. Handle EEXIST by
  // re-running the guard, which accepts a real dir and rejects a
  // symlink/file with the right typed refusal.
  try {
    await mkdir(viberevertDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      await ensureViberevertDir(viberevertDir, lockDir);
      return;
    }
    throw err;
  }
}

/**
 * Verify an existing lock dir is a real directory before reading
 * through it or mutating its contents. Used by both acquireLock (on
 * EEXIST, before pid.json read) and releaseLock (before unlink +
 * rmdir). Throws SymlinkTargetRefusal /
 * IntegrationTargetParentNotDirectoryError on mismatch.
 */
async function assertExistingLockDirIsSafe(lockDir: string, pidPath: string): Promise<void> {
  const st = await lstat(lockDir);
  if (st.isSymbolicLink()) {
    throw new SymlinkTargetRefusal({
      targetPath: pidPath,
      symlinkedComponentPath: lockDir,
    });
  }
  if (!st.isDirectory()) {
    throw new IntegrationTargetParentNotDirectoryError({
      targetPath: pidPath,
      parentPath: lockDir,
    });
  }
}

/**
 * Best-effort: read pid.json + parse + extract a positive-integer
 * pid. Returns undefined on any failure (missing file, malformed
 * JSON, missing pid field, non-number/non-integer/non-positive pid).
 * Used ONLY for the diagnostic in IntegrationsLockError -- never
 * load-bearing. Caller is expected to have lstat-verified the lock
 * dir is a real directory before invoking this.
 */
async function tryReadExistingPid(pidPath: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(pidPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  // Cast to a known optional-property type rather than Record<string, unknown>
  // (an index signature). The known-property form allows .pid access without
  // tripping noPropertyAccessFromIndexSignature OR Biome's useLiteralKeys.
  const candidate = (parsed as { pid?: unknown }).pid;
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 0) {
    return undefined;
  }
  return candidate;
}
