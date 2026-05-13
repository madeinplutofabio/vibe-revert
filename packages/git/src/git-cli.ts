// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Thin wrappers around the `git` binary via child_process.execFile.
//
// This file is the SINGLE owner of git subprocess invocation across the entire
// vibe-revert codebase (D16: "git-binary ownership"). No other package — not
// `@viberevert/core`, not `viberevert` (CLI) — ever spawns the git binary
// directly. The CLI's `doctor` command has a narrow carve-out for probing
// non-git diagnostic binaries (pnpm), but ALL git work routes through here
// via the public exports below.
//
// Why execFile (not exec): `exec` runs through a shell, which is an injection
// vector when arguments come from user-controlled inputs (e.g., paths,
// branch names). `execFile` invokes the binary directly with an argv array;
// no shell, no interpolation hazards.
//
// Why --no-pager on every invocation: prevents `less` (or its Windows
// equivalent) from being spawned for outputs that exceed the terminal height,
// which would deadlock our async wrappers awaiting stdout.
//
// Why maxBuffer 100 MB: `git diff --binary` can produce large outputs for
// repositories with sizeable working changes. The default 1 MB is too small
// for real codebases. Per the M B Risks section, this is documented as a
// known cap; truly huge binary changes are M H stretch.
//
// Why detect git availability eagerly (D1): users may run `viberevert
// checkpoint` or `start` without ever running `viberevert doctor` first.
// We detect a missing/unusable git binary the FIRST time any wrapper is
// called and surface `GitNotAvailableError` cleanly, instead of leaking a
// raw ENOENT or a "command not found" stderr fragment.
//
// Public surface vs. internal:
//   - Public: probeGitVersion, getHeadSha, getBranch, getStatusPorcelainText,
//     getStatusPorcelainZ, plus the StatusEntry type.
//   - Internal (re-exported only within this package): gitDiffUnstaged,
//     gitDiffStaged, gitListUntracked, gitListTrackedDirty, gitApply,
//     gitApplyWithIndex, gitResetHardHead.
//   The barrel (./index.ts) re-exports only the public set.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitNotAvailableError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Default maxBuffer for git invocations carrying real data (status, diff,
 * ls-files). 100 MB is enough for typical real-world `git diff --binary`
 * outputs. Truly huge binary changes that exceed this cap will fail with a
 * "stdout maxBuffer length exceeded" error from Node; see M B Risks.
 */
const GIT_MAX_BUFFER = 100 * 1024 * 1024;

/**
 * Smaller maxBuffer for the version probe — `git --version` output is well
 * under 1 KB on every supported git release.
 */
const GIT_PROBE_MAX_BUFFER = 1024 * 1024;

/**
 * Environment passed to every git invocation. `GIT_OPTIONAL_LOCKS=0` tells
 * git to skip its optional index-refresh lock on read-ish commands
 * (`status`, `diff`, etc.). Without this, multiple parallel git invocations
 * against the same repo can race on `.git/index` — POSIX advisory locking
 * masks the race, but on Windows mandatory file locking surfaces it as
 * "fatal: .git/index: index file open failed: Permission denied". Setting
 * the var to `0` is git's own escape hatch for this scenario; correctness
 * of the read commands is not affected (only the index-refresh side effect
 * that updates stat-data timestamps for later optimization).
 */
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

/**
 * One-time availability probe. Resolves to the git version string (the first
 * line of `git --version`) after a successful first call; throws
 * GitNotAvailableError otherwise. Cached for the process lifetime — so the
 * version string is also memoized for `probeGitVersion()`, and every
 * subsequent wrapper call does an O(1) cache hit instead of a fresh
 * subprocess.
 *
 * Stored as a Promise so concurrent first-callers see the SAME probe and
 * race-free await the same result. On failure the cache is cleared so a
 * transient PATH issue can be retried (mostly relevant for tests that
 * mutate PATH).
 */
let availabilityProbe: Promise<string> | null = null;

async function assertGitAvailable(): Promise<string> {
  if (availabilityProbe === null) {
    availabilityProbe = (async () => {
      let stdout: string;
      try {
        const result = await execFileAsync("git", ["--no-pager", "--version"], {
          maxBuffer: GIT_PROBE_MAX_BUFFER,
          windowsHide: true,
          env: GIT_ENV,
        });
        stdout = result.stdout;
      } catch (err) {
        availabilityProbe = null;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new GitNotAvailableError(detail(err), err);
        }
        throw new GitNotAvailableError(`git --version failed: ${detail(err)}`, err);
      }
      const text = stdout.trim();
      const firstLine = text.split("\n")[0]?.trim() ?? "";
      if (firstLine.length === 0) {
        availabilityProbe = null;
        throw new GitNotAvailableError("git --version produced no output");
      }
      return firstLine;
    })();
  }
  return availabilityProbe;
}

/** Extract a short human-readable detail string from an unknown error. */
function detail(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "git binary not found on PATH";
    return err.message.split("\n")[0] ?? err.message;
  }
  return String(err);
}

/**
 * Run `git <args...>` in `repoRoot`. Returns stdout as Buffer (binary-safe).
 *
 * `--no-pager` is always prepended. Calls `assertGitAvailable()` first, so
 * the very first git call in the process performs a one-time `git --version`
 * probe; subsequent calls hit the cache.
 *
 * On ENOENT (git binary missing/unusable), throws `GitNotAvailableError`.
 * On non-zero git exits, propagates the original error from execFileAsync —
 * higher layers decide whether to wrap it in a typed error.
 *
 * The `as { stdout: Buffer; stderr: Buffer }` cast on the result reflects
 * Node's documented behavior for `encoding: "buffer"` (stdout/stderr are
 * Buffers). The cast is necessary because `promisify(execFile)` loses the
 * conditional return-type overloads that the synchronous API surfaces.
 */
async function runGit(
  repoRoot: string,
  args: readonly string[],
  opts: { maxBuffer?: number } = {},
): Promise<Buffer> {
  await assertGitAvailable();
  try {
    const { stdout } = (await execFileAsync("git", ["--no-pager", ...args], {
      cwd: repoRoot,
      maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
      encoding: "buffer",
      windowsHide: true,
      env: GIT_ENV,
    })) as { stdout: Buffer; stderr: Buffer };
    return stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GitNotAvailableError(detail(err), err);
    }
    throw err;
  }
}

/** Run git and return stdout as utf8-decoded string. */
async function runGitText(
  repoRoot: string,
  args: readonly string[],
  opts: { maxBuffer?: number } = {},
): Promise<string> {
  const buf = await runGit(repoRoot, args, opts);
  return buf.toString("utf8");
}

/**
 * Run `git <args...>` in `repoRoot` with `stdinData` piped to git's stdin.
 * Captures stderr and includes it in the thrown Error on non-zero exit, so
 * failed invocations produce diagnosable messages.
 *
 * Used by `gitApply` and `gitApplyWithIndex` for stdin-fed patches; both
 * call sites need identical stdin write + stderr capture + close-event
 * handling, so the logic lives here once.
 *
 * Waits on the `'close'` event (not `'exit'`) so that all stderr chunks
 * have been received before constructing the failure message. The `'exit'`
 * event can fire while stdio is still buffered in the OS pipe, leading to
 * truncated diagnostics; `'close'` fires only after stdio streams are
 * fully drained.
 */
async function runGitWithStdin(
  repoRoot: string,
  args: readonly string[],
  stdinData: Buffer,
): Promise<void> {
  await assertGitAvailable();
  try {
    const child = execFile("git", ["--no-pager", ...args], {
      cwd: repoRoot,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: GIT_ENV,
    });
    if (child.stdin === null) {
      throw new Error(`git ${args.join(" ")}: stdin unavailable`);
    }
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.stdin.end(stdinData);
    await new Promise<void>((resolve, reject) => {
      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new GitNotAvailableError(detail(err), err));
        } else {
          reject(err);
        }
      });
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
          const base = `git ${args.join(" ")} exited with code ${code}${signal ? ` (signal ${signal})` : ""}`;
          reject(new Error(stderrText.length > 0 ? `${base}: ${stderrText}` : base));
        }
      });
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GitNotAvailableError(detail(err), err);
    }
    throw err;
  }
}

// =============================================================================
// Public helpers — called from CLI commands and other packages.
// =============================================================================

/**
 * Probe the git binary by running `git --version` (with no cwd — works
 * outside any repo). Returns the first line of stdout (e.g., "git version
 * 2.42.0"). Throws `GitNotAvailableError` on ENOENT, non-zero exit, or
 * empty output.
 *
 * On second and subsequent calls within a process, returns the cached
 * version string from the initial probe — no extra subprocess spawn.
 *
 * Used by CLI `doctor` to render the "git: <version>" line via this helper
 * INSTEAD of spawning git directly — preserves the git-binary-ownership
 * invariant (D16).
 */
export async function probeGitVersion(): Promise<string> {
  return assertGitAvailable();
}

/** Returns the full SHA of HEAD. */
export async function getHeadSha(repoRoot: string): Promise<string> {
  const text = await runGitText(repoRoot, ["rev-parse", "HEAD"]);
  return text.trim();
}

/**
 * Returns the current branch name, or `null` if HEAD is detached.
 *
 * Uses `git symbolic-ref --quiet --short HEAD`: exits 0 with the short branch
 * name on a normal branch, exits 1 (no stdout) when HEAD is detached.
 */
export async function getBranch(repoRoot: string): Promise<string | null> {
  try {
    const text = await runGitText(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const trimmed = text.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch (err) {
    // exit code 1 with no stdout means detached HEAD; rethrow anything else
    // (e.g., "not a git repository").
    const code = (err as { code?: number }).code;
    if (code === 1) return null;
    throw err;
  }
}

/**
 * Raw `git status --porcelain=v1` text for audit storage (D8).
 *
 * This is the text form preserved verbatim into Manifest.git.porcelain_v1,
 * before-status.txt, and after-status.txt. NEVER parse this text for machine
 * logic — use getStatusPorcelainZ() instead. Empty string on a clean tree.
 */
export async function getStatusPorcelainText(repoRoot: string): Promise<string> {
  return runGitText(repoRoot, ["status", "--porcelain=v1"]);
}

/**
 * One parsed entry from `git status --porcelain=v1 -z`.
 *
 * `statusXY` is the 2-character status code (e.g., " M" = unstaged modified,
 * "A " = staged added, "??" = untracked, "R " = renamed in index).
 *
 * `previousPath` is set only for renames/copies (status code R or C in
 * EITHER position X or Y); the `-z` format follows the rename entry with an
 * extra NUL-separated old-path entry, which the parser consumes into this
 * field.
 */
export type StatusEntry = {
  readonly statusXY: string;
  readonly path: string;
  readonly previousPath?: string;
};

/**
 * Parsed `git status --porcelain=v1 -z` output. Use this — NOT
 * getStatusPorcelainText — for any code that branches on file status (D8).
 *
 * The `-z` format is unambiguous: NUL-separated entries, no quoting, no
 * locale-dependent escapes.
 *
 * Decoding: stdout is decoded as UTF-8. Safe for filenames containing
 * spaces, quotes, and Unicode characters that round-trip through UTF-8 (the
 * standard case for git output on every modern OS). Filenames containing
 * non-UTF-8 byte sequences (extremely rare, mostly on locale-misconfigured
 * Linux systems with `core.quotepath=false` and raw 8-bit pathnames) may be
 * lossy when decoded; that is out of scope for M B.
 *
 * Renames and copies (status code R or C in EITHER position X or Y, since
 * porcelain v1 places index state in X and worktree state in Y) consume an
 * extra NUL-terminated old-path entry per the porcelain v1 -z format.
 *
 * Fails closed on any malformed entry: throws an `Error` rather than
 * silently skipping or partially accepting. Status parsing feeds
 * trust-critical checkpoint/restore code; we need loud failures, not silent
 * corruption.
 *
 * Returns an empty array on a clean tree.
 */
export async function getStatusPorcelainZ(repoRoot: string): Promise<readonly StatusEntry[]> {
  const buf = await runGit(repoRoot, ["status", "--porcelain=v1", "-z"]);
  if (buf.length === 0) return [];
  const text = buf.toString("utf8");
  const tokens = text.split("\0");
  // The trailing NUL after the final entry produces an empty trailing token
  // after split, which we drop. Anything else MUST be a real entry.
  if (tokens[tokens.length - 1] === "") tokens.pop();

  const out: StatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i];
    // Minimum valid entry: 2-char status + space + at-least-one-char path = 4 chars.
    if (raw === undefined || raw.length < 4) {
      throw new Error(
        `git status --porcelain=v1 -z: malformed entry at token index ${i}: ${
          raw === undefined ? "<missing>" : JSON.stringify(raw)
        }`,
      );
    }
    const statusXY = raw.slice(0, 2);
    // raw[2] is the separator space; path starts at index 3.
    const path = raw.slice(3);
    const x = statusXY[0];
    const y = statusXY[1];
    // Per porcelain v1 docs: renames/copies place R/C in either X (index) or
    // Y (worktree); both cases produce an extra old-path entry in -z output.
    const isRenameOrCopy = x === "R" || x === "C" || y === "R" || y === "C";
    if (isRenameOrCopy) {
      const oldPath = tokens[i + 1];
      if (oldPath === undefined) {
        throw new Error(
          `git status --porcelain=v1 -z: rename/copy entry at token index ${i} ` +
            `(statusXY=${JSON.stringify(statusXY)}, path=${JSON.stringify(path)}) ` +
            `is missing its required old-path follower`,
        );
      }
      out.push({ statusXY, path, previousPath: oldPath });
      i += 2;
    } else {
      out.push({ statusXY, path });
      i += 1;
    }
  }
  return out;
}

// =============================================================================
// Internal helpers — used by other modules in this package only. NOT
// re-exported from ./index.ts. snapshots.ts, checkpoint.ts, and restore.ts
// import these directly.
// =============================================================================

/** Internal: unstaged binary diff. Returns Buffer (binary-safe). */
export async function gitDiffUnstaged(repoRoot: string): Promise<Buffer> {
  return runGit(repoRoot, ["diff", "--binary"]);
}

/** Internal: staged (index) binary diff. Returns Buffer. */
export async function gitDiffStaged(repoRoot: string): Promise<Buffer> {
  return runGit(repoRoot, ["diff", "--cached", "--binary"]);
}

/**
 * Internal: list untracked, NOT-gitignored files (the candidates for the
 * untracked snapshot before applying rollback.exclude). Uses
 * `--others --exclude-standard` which respects .gitignore + .git/info/exclude
 * + the user's global excludes.
 *
 * Returns repo-relative POSIX paths (git always uses forward slashes).
 */
export async function gitListUntracked(repoRoot: string): Promise<readonly string[]> {
  const buf = await runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return splitNulList(buf);
}

/**
 * Internal: list tracked files that are dirty (unstaged + staged changes,
 * deduped). Returns repo-relative POSIX paths. Used to enumerate the files
 * captured into the tracked-dirty tarball.
 */
export async function gitListTrackedDirty(repoRoot: string): Promise<readonly string[]> {
  const [unstagedBuf, stagedBuf] = await Promise.all([
    runGit(repoRoot, ["diff", "--name-only", "-z"]),
    runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"]),
  ]);
  const set = new Set<string>([...splitNulList(unstagedBuf), ...splitNulList(stagedBuf)]);
  return [...set].sort();
}

/**
 * Internal: apply a binary patch to the working tree only.
 *
 * Used by restoreCheckpoint to replay the unstaged diff captured in a
 * manifest (the working-tree-vs-index delta). For patches that should also
 * land in the index (the staged.patch), use `gitApplyWithIndex` instead.
 *
 * `--whitespace=nowarn` suppresses noise about whitespace differences
 * (which can be present in patches without being errors). The patch is fed
 * to git via stdin (`-` argument).
 *
 * Captures stderr and includes it in the thrown Error on non-zero exit, so
 * restore failures produce diagnosable messages — typical failures look
 * like "patch does not apply" or "binary patch does not apply to '...'".
 */
export async function gitApply(repoRoot: string, patch: Buffer): Promise<void> {
  return runGitWithStdin(repoRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
}

/**
 * Internal: apply a binary patch to BOTH the index and the working tree.
 *
 * Used by restoreCheckpoint to replay the staged diff captured in a
 * manifest (the index-vs-HEAD delta) — `--index` makes git apply the patch
 * to both atomically, restoring the staged state to match what was captured.
 * For patches that should land only in the working tree (the unstaged.patch),
 * use `gitApply` instead.
 *
 * Same flags + stdin + stderr-capture behavior as `gitApply`, plus the
 * `--index` flag.
 */
export async function gitApplyWithIndex(repoRoot: string, patch: Buffer): Promise<void> {
  return runGitWithStdin(
    repoRoot,
    ["apply", "--index", "--binary", "--whitespace=nowarn", "-"],
    patch,
  );
}

/**
 * Internal: hard-reset tracked files and the index to HEAD.
 *
 * Used by restoreCheckpoint as the first step after HEAD verification:
 * wipes ALL tracked-file changes (staged or unstaged) and clears the index
 * back to a clean HEAD state, providing the baseline that the captured
 * staged + unstaged patches are then applied on top of.
 *
 * Does NOT touch untracked files — those are handled separately by
 * restore's enumerate-and-delete step (governed by `rollback.exclude` per
 * D3) followed by tarball extraction.
 *
 * On non-zero exit, propagates the original error from `runGit` with
 * stderr in the message. Most likely failure: "not a git repository" if
 * the caller passed a non-repo path; M B treats this as the caller's
 * problem to surface.
 */
export async function gitResetHardHead(repoRoot: string): Promise<void> {
  await runGit(repoRoot, ["reset", "--hard", "HEAD"]);
}

/**
 * Test-only helper: clears the cached availability probe so the next git
 * invocation re-probes. Mostly relevant for tests that simulate transient
 * PATH manipulation.
 *
 * NOT exported from ./index.ts — consumed by this package's tests only.
 */
export function _resetAvailabilityCacheForTests(): void {
  availabilityProbe = null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function splitNulList(buf: Buffer): readonly string[] {
  if (buf.length === 0) return [];
  const text = buf.toString("utf8");
  const tokens = text.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  return tokens;
}
