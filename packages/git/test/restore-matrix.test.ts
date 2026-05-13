// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Rollback test matrix — text-file rows (Step 6b).
//
// Per the M B plan acceptance criteria: for every row of the rollback test
// matrix in full_beta_plan §9, the internal `restoreCheckpoint()` produces
// a byte-identical working tree. This file covers the 6 text-file rows; the
// 3 filesystem/git-specific rows (binary, rename, chmod) and the 2
// rollback.exclude symmetry rows land in 6c and 6d respectively, in this
// same file.
//
// =============================================================================
// What this file proves vs what restore.test.ts proves
// =============================================================================
//
// restore.test.ts proves restore MECHANICS — extraction-path cleanup,
// drift detection, conflict surfacing, symlink safety. Answers "is the
// machinery correct?"
//
// This file proves restore SEMANTICS — does what we capture actually
// round-trip the messy working-tree shapes users care about? Answers
// "does what we save actually represent what the user has?"
//
// Both matter. The mechanics tests guard the implementation; the matrix
// tests guard the contract. M B's `viberevert checkpoint` and
// `viberevert start` commands NOW write checkpoints via createCheckpoint;
// shipping those without round-trip proof for these cases means users
// could create checkpoints that won't restore correctly when M D's
// rollback command later runs them.
//
// =============================================================================
// Test pattern
// =============================================================================
//
// Each row follows the same shape:
//   1. setupRepo() — fresh git repo + initial commit + .gitignore (ignoring
//      .viberevert/, defensive even though our checkpoints live outside
//      the repo)
//   2. Apply PRE-SESSION state — git ops + writeFile to set up what the
//      user has when they take the checkpoint
//   3. snapshotPaths(...) + getPorcelain(...) — capture what we expect to
//      see post-restore
//   4. takeCheckpoint(...) — captures state via real createCheckpoint
//   5. Apply DURING-SESSION state — mutate to simulate session work
//   6. restoreCheckpoint(...) — the real function under test
//   7. assertPathsMatch(...) + porcelain comparison — verify byte-equality
//      AND git state equality
//
// Steps 7's two assertions together prove the contract: bytes-equal catches
// content regressions; porcelain-equal catches index/staging regressions
// that bytes alone wouldn't (e.g., file content matches but stage state
// is wrong).

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCheckpoint } from "../src/checkpoint.js";
import { restoreCheckpoint } from "../src/restore.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Helpers (inline; not extracted to a separate file — matches the pattern
// from packages/cli/test/listing.test.ts and friends)
// =============================================================================

interface RepoFixture {
  /** Absolute path to the test git repo. */
  readonly repoRoot: string;
  /**
   * Absolute path to the parent dir containing both `repo/` and any
   * checkpoint subdirs created via takeCheckpoint(). Cleanup removes this
   * whole tree, so all checkpoint dirs are reaped automatically.
   */
  readonly parentDir: string;
  /** Removes the whole parentDir tree. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Run a git command in `cwd`. Returns the captured stdout/stderr.
 * Duplicated from restore.test.ts (intentional — keeps this file
 * self-contained, matching the inline-helper convention used across
 * the cli/test/* files).
 *
 * The `String(...)` wraps preempt a typecheck issue: `promisify(execFile)`
 * returns `{ stdout: string | Buffer; stderr: string | Buffer }`, so
 * unwrapped the return type would be a type error. With default options
 * the runtime values are strings; `String(...)` is a no-op for strings
 * and converts Buffers to their UTF-8 representation if that ever
 * changes.
 */
async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args as string[], {
    cwd,
    windowsHide: true,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

/**
 * Set up a fresh git repo with an initial commit. Always commits a
 * `.gitignore` ignoring `.viberevert/` — defensive against any future
 * test (or future `restoreCheckpoint` change) that writes to .viberevert/
 * inside the repo, which would pollute `git status` and break the
 * porcelain comparison. Tests that need additional gitignore patterns
 * pass them via `additionalGitignore`; they're committed as part of the
 * same initial commit so they don't appear as a modification.
 */
async function setupRepo(
  opts: { additionalGitignore?: string } = {},
): Promise<RepoFixture> {
  const parentDir = await mkdtemp(
    join(tmpdir(), "viberevert-restore-matrix-"),
  );
  const repoRoot = join(parentDir, "repo");
  await mkdir(repoRoot, { recursive: true });

  await runGit(repoRoot, ["init", "-q", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);

  const gitignoreContent = `.viberevert/\n${opts.additionalGitignore ?? ""}`;
  await writeFile(join(repoRoot, ".gitignore"), gitignoreContent);
  await runGit(repoRoot, ["add", ".gitignore"]);
  await runGit(repoRoot, ["commit", "-q", "-m", "initial"]);

  return {
    repoRoot,
    parentDir,
    cleanup: () => rm(parentDir, { recursive: true, force: true }),
  };
}

/**
 * Stage all changes and commit with the given message. Convenience for
 * test setup that pre-commits files before the pre-session state mutations.
 */
async function commit(repoRoot: string, msg: string): Promise<void> {
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "-q", "-m", msg]);
}

/**
 * Snapshot bytes of the given repo-relative paths. Returns a Map where
 * the value is `null` if the file doesn't exist, or a Buffer of the file
 * contents if it does. Used pre-checkpoint to record the expected
 * post-restore state, then again post-restore to compare.
 *
 * Sequential reads (not Promise.all) — bounds concurrency, simpler error
 * surfacing, and the path counts in matrix tests are tiny.
 */
async function snapshotPaths(
  repoRoot: string,
  paths: readonly string[],
): Promise<Map<string, Buffer | null>> {
  const out = new Map<string, Buffer | null>();
  for (const p of paths) {
    try {
      const buf = await readFile(join(repoRoot, p));
      out.set(p, buf);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        out.set(p, null);
      } else {
        throw err;
      }
    }
  }
  return out;
}

/**
 * Capture `git status --porcelain=v1` text. Used to verify post-restore
 * git state matches pre-checkpoint git state — catches index/staging
 * regressions that pure-bytes comparison wouldn't.
 *
 * v1 porcelain output is deterministic for the same repo state (no
 * locale-sensitive ordering, ASCII-only column layout). Exact-string
 * comparison is sound for the simple ASCII paths used in this file.
 */
async function getPorcelain(repoRoot: string): Promise<string> {
  const { stdout } = await runGit(repoRoot, [
    "status",
    "--porcelain=v1",
  ]);
  return stdout;
}

/**
 * Take a real checkpoint via createCheckpoint. The checkpoint dir is
 * created as a SIBLING of `repoRoot` under the same parentDir, so
 * cleanup of parentDir reaps all checkpoint dirs created by a test.
 *
 * Returns the absolute path to the checkpoint dir, suitable for passing
 * to restoreCheckpoint.
 */
async function takeCheckpoint(opts: {
  repoRoot: string;
  parentDir: string;
  rollbackExcludePatterns?: readonly string[];
}): Promise<string> {
  const checkpointDir = await mkdtemp(join(opts.parentDir, "checkpoint-"));
  await createCheckpoint({
    repoRoot: opts.repoRoot,
    checkpointDir,
    rollbackExcludePatterns: opts.rollbackExcludePatterns ?? [],
  });
  return checkpointDir;
}

/**
 * Verify all paths in `expected` snapshot match current disk state.
 * For each entry: if expected is null, the file should not exist; if
 * expected is a Buffer, the file should exist with byte-identical
 * contents.
 *
 * Iterates sequentially (same reasoning as snapshotPaths).
 */
async function assertPathsMatch(
  repoRoot: string,
  expected: Map<string, Buffer | null>,
): Promise<void> {
  for (const [path, expectedBuf] of expected) {
    const abs = join(repoRoot, path);
    let actualBuf: Buffer | null;
    try {
      actualBuf = await readFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        actualBuf = null;
      } else {
        throw err;
      }
    }
    if (expectedBuf === null) {
      expect(
        actualBuf,
        `expected ${path} to not exist; found ${actualBuf?.length} bytes`,
      ).toBeNull();
    } else {
      expect(
        actualBuf,
        `expected ${path} to exist with ${expectedBuf.length} bytes; found null`,
      ).not.toBeNull();
      // Compare via Buffer.equals for precise byte comparison; toEqual
      // would compare by structural equality which is also correct but
      // slower for large buffers.
      if (actualBuf !== null) {
        expect(
          actualBuf.equals(expectedBuf),
          `bytes mismatch at ${path}: expected ${expectedBuf.length} bytes, got ${actualBuf.length} bytes`,
        ).toBe(true);
      }
    }
  }
}

// =============================================================================
// Test setup/teardown
// =============================================================================

let repo: RepoFixture;

beforeEach(async () => {
  repo = await setupRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

// =============================================================================
// 6b — Text-file matrix rows
// =============================================================================

describe("rollback test matrix — text-file rows (6b)", () => {
  it("Row 1: file modified before session, modified again during session", async () => {
    // Setup: commit foo.txt with content "v0"
    await writeFile(join(repo.repoRoot, "foo.txt"), "v0\n");
    await commit(repo.repoRoot, "add foo");

    // Pre-session: modify foo.txt to "v1" (unstaged)
    await writeFile(join(repo.repoRoot, "foo.txt"), "v1\n");

    const expectedSnapshot = await snapshotPaths(repo.repoRoot, ["foo.txt"]);
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    expect(expectedPorcelain).toBe(" M foo.txt\n");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: modify foo.txt to "v2"
    await writeFile(join(repo.repoRoot, "foo.txt"), "v2\n");

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });

  it("Row 2: file staged before session, modified again during session", async () => {
    // Setup: commit foo.txt with content "v0"
    await writeFile(join(repo.repoRoot, "foo.txt"), "v0\n");
    await commit(repo.repoRoot, "add foo");

    // Pre-session: modify to "v1" and stage
    await writeFile(join(repo.repoRoot, "foo.txt"), "v1\n");
    await runGit(repo.repoRoot, ["add", "foo.txt"]);

    const expectedSnapshot = await snapshotPaths(repo.repoRoot, ["foo.txt"]);
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    // "M  foo.txt" — staged modification, no unstaged changes
    expect(expectedPorcelain).toBe("M  foo.txt\n");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: modify to "v2" (unstaged on top of staged "v1")
    await writeFile(join(repo.repoRoot, "foo.txt"), "v2\n");

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });

  it("Row 3: untracked file existed before session, modified during session", async () => {
    // Setup: only the initial .gitignore commit (no other tracked files)

    // Pre-session: create untracked file
    await writeFile(join(repo.repoRoot, "untracked.txt"), "u1\n");

    const expectedSnapshot = await snapshotPaths(repo.repoRoot, ["untracked.txt"]);
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    expect(expectedPorcelain).toBe("?? untracked.txt\n");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: modify the untracked file
    await writeFile(join(repo.repoRoot, "untracked.txt"), "u2\n");

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });

  it("Row 4: new untracked file created during session (NOT in checkpoint)", async () => {
    // Setup: only the initial .gitignore commit

    // Pre-session: clean tree (no extra files, no modifications)
    const expectedSnapshot = await snapshotPaths(repo.repoRoot, ["new.txt"]);
    expect(expectedSnapshot.get("new.txt")).toBeNull();
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    expect(expectedPorcelain).toBe("");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: create a new untracked file
    await writeFile(join(repo.repoRoot, "new.txt"), "session content\n");

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    // After restore, new.txt should be DELETED (it was not in the
    // captured untracked set — restore.deleteUncapturedUntracked
    // removes it).
    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });

  it("Row 5: tracked file deleted during session", async () => {
    // Setup: commit foo.txt (clean tracked tree at checkpoint time)
    await writeFile(join(repo.repoRoot, "foo.txt"), "v0\n");
    await commit(repo.repoRoot, "add foo");

    // Pre-session: clean tree
    const expectedSnapshot = await snapshotPaths(repo.repoRoot, ["foo.txt"]);
    expect(expectedSnapshot.get("foo.txt")?.toString()).toBe("v0\n");
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    expect(expectedPorcelain).toBe("");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: delete the tracked file
    await rm(join(repo.repoRoot, "foo.txt"));

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    // After restore, foo.txt should be back at its committed state via
    // gitResetHardHead (the captured patches are empty since pre-session
    // was clean; the reset alone restores it).
    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });

  it("Row 6: untracked file deleted during session", async () => {
    // Setup: only the initial .gitignore commit

    // Pre-session: create an untracked file
    await writeFile(join(repo.repoRoot, "untracked.txt"), "u1\n");

    const expectedSnapshot = await snapshotPaths(repo.repoRoot, ["untracked.txt"]);
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    expect(expectedPorcelain).toBe("?? untracked.txt\n");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: delete the untracked file
    await rm(join(repo.repoRoot, "untracked.txt"));

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    // After restore, untracked.txt should be back at "u1" via the
    // captured untracked tarball extraction.
    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });
});

// =============================================================================
// 6c — Filesystem/git-specific matrix rows
// =============================================================================

describe("rollback test matrix — filesystem/git-specific rows (6c)", () => {
  it("Row 7: binary file changed before session, modified again during session", async () => {
    // Setup: commit a binary file (256 bytes, 0x00–0xFF byte pattern).
    // This exercises the binary path in createCheckpoint / restoreCheckpoint —
    // git diff uses --binary to encode binary patches; node-tar handles
    // arbitrary bytes; SHA-256 hashes are byte-precise. Any of those
    // breaking would corrupt the round-trip.
    const binary0 = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binary0[i] = i;
    await writeFile(join(repo.repoRoot, "data.bin"), binary0);
    await commit(repo.repoRoot, "add binary");

    // Pre-session: modify binary content (rotated byte pattern)
    const binary1 = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binary1[i] = (i + 7) % 256;
    await writeFile(join(repo.repoRoot, "data.bin"), binary1);

    const expectedSnapshot = await snapshotPaths(repo.repoRoot, ["data.bin"]);
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    // Hardcoded porcelain serves as the strong setup assertion for
    // Row 7 — proves "specifically an unstaged modification of
    // data.bin, no other dirty state." The byte-precise Buffer.equals
    // comparison in assertPathsMatch covers content correctness.
    expect(expectedPorcelain).toBe(" M data.bin\n");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: yet another binary pattern
    const binary2 = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binary2[i] = (i + 13) % 256;
    await writeFile(join(repo.repoRoot, "data.bin"), binary2);

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });

  it("Row 8: renamed file via git mv + content edit", async () => {
    // Setup: commit oldname.txt
    await writeFile(join(repo.repoRoot, "oldname.txt"), "rename test content\n");
    await commit(repo.repoRoot, "add oldname");

    // Pre-session: stage rename via git mv, then modify content unstaged
    // on top of the staged rename. This exercises the "rename + edit"
    // matrix row — cached diff must contain the staged rename, while
    // working-tree diff must contain an unstaged edit on the new path.
    await runGit(repo.repoRoot, ["mv", "oldname.txt", "newname.txt"]);
    await writeFile(
      join(repo.repoRoot, "newname.txt"),
      "rename test content modified\n",
    );

    const expectedSnapshot = await snapshotPaths(repo.repoRoot, [
      "oldname.txt",
      "newname.txt",
    ]);
    expect(expectedSnapshot.get("oldname.txt")).toBeNull();
    expect(expectedSnapshot.get("newname.txt")?.toString()).toBe(
      "rename test content modified\n",
    );

    const expectedPorcelain = await getPorcelain(repo.repoRoot);

    // Strong setup assertions: prove this is specifically a staged
    // rename plus an unstaged content edit on the renamed path, not
    // merely "some dirty state" that happens to round-trip.
    const expectedCachedNameStatus = (
      await runGit(repo.repoRoot, [
        "diff",
        "--cached",
        "--name-status",
        "-M",
      ])
    ).stdout;
    expect(expectedCachedNameStatus).toContain("oldname.txt");
    expect(expectedCachedNameStatus).toContain("newname.txt");
    expect(expectedCachedNameStatus).toMatch(/^R\d+\s+oldname\.txt\s+newname\.txt/m);

    const expectedUnstagedNames = (
      await runGit(repo.repoRoot, ["diff", "--name-only"])
    ).stdout;
    expect(expectedUnstagedNames).toBe("newname.txt\n");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: further modification to the new path
    await writeFile(
      join(repo.repoRoot, "newname.txt"),
      "during session content\n",
    );

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);

    // Strong post-restore assertions: staged rename and unstaged edit
    // shape must be reconstructed, not just byte content.
    const actualCachedNameStatus = (
      await runGit(repo.repoRoot, [
        "diff",
        "--cached",
        "--name-status",
        "-M",
      ])
    ).stdout;
    expect(actualCachedNameStatus).toBe(expectedCachedNameStatus);

    const actualUnstagedNames = (
      await runGit(repo.repoRoot, ["diff", "--name-only"])
    ).stdout;
    expect(actualUnstagedNames).toBe(expectedUnstagedNames);
  });

  it("Row 9: file mode changed via git update-index --chmod (cross-platform)", async () => {
    // Setup: commit script.sh with mode 0644 (git's default for new
    // files on most platforms; on Windows files have no real unix mode
    // but git tracks them as 0644 by convention).
    await writeFile(
      join(repo.repoRoot, "script.sh"),
      "#!/bin/sh\necho hello\n",
    );
    await commit(repo.repoRoot, "add script");

    // Disable core.fileMode for this test to make it deterministic
    // across platforms. Without this, on Linux/macOS where
    // core.fileMode defaults to true, git would compare the working-
    // tree file's actual mode (0644 from writeFile) against the index
    // mode (0755 after the chmod=+x below) and show an unstaged
    // mode-revert in addition to the staged mode-change — so porcelain
    // would be "MM script.sh" on those platforms vs "M  script.sh" on
    // Windows where core.fileMode defaults to false. Disabling
    // core.fileMode here treats filesystem mode as not-a-signal and
    // matches Windows default behavior across all platforms.
    await runGit(repo.repoRoot, ["config", "core.fileMode", "false"]);

    // Pre-session: change mode via `git update-index --chmod=+x` rather
    // than filesystem chmod. Modifies git's index entry directly with
    // no dependency on filesystem mode support.
    await runGit(repo.repoRoot, [
      "update-index",
      "--chmod=+x",
      "script.sh",
    ]);

    const expectedSnapshot = await snapshotPaths(repo.repoRoot, ["script.sh"]);
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    // Strong setup assertion #1: porcelain shape proves there is no
    // unstaged side-effect and the visible state is exactly one staged
    // change. Deterministic across platforms thanks to the
    // core.fileMode=false config above.
    expect(expectedPorcelain).toBe("M  script.sh\n");

    // Strong setup assertion #2: prove this is specifically a STAGED
    // MODE-ONLY change, not a content change masquerading as one.
    // ls-files --stage shows the index entry as `<mode> <sha> <stage>\t<path>`.
    // After chmod=+x, mode must be 100755 (executable).
    const expectedLsStage = (
      await runGit(repo.repoRoot, ["ls-files", "--stage", "script.sh"])
    ).stdout;
    expect(expectedLsStage).toMatch(/^100755 [0-9a-f]{40} 0\tscript\.sh$/m);

    // Strong setup assertion #3: numstat of cached diff is 0 added /
    // 0 removed lines = mode-only change. Any content delta would
    // show non-zero counts and would mean this test is exercising the
    // wrong scenario.
    const expectedCachedNumstat = (
      await runGit(repo.repoRoot, [
        "diff",
        "--cached",
        "--numstat",
        "script.sh",
      ])
    ).stdout;
    expect(expectedCachedNumstat).toBe("0\t0\tscript.sh\n");

    const checkpointDir = await takeCheckpoint(repo);

    // During session: modify content (mixes content change with the
    // pre-existing staged mode-only change)
    await writeFile(
      join(repo.repoRoot, "script.sh"),
      "#!/bin/sh\necho different\n",
    );

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: [],
    });

    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);

    // Strong post-restore assertions: staged mode 100755 + zero
    // content delta must be reconstructed, not just file content.
    const actualLsStage = (
      await runGit(repo.repoRoot, ["ls-files", "--stage", "script.sh"])
    ).stdout;
    expect(actualLsStage).toBe(expectedLsStage);

    const actualCachedNumstat = (
      await runGit(repo.repoRoot, [
        "diff",
        "--cached",
        "--numstat",
        "script.sh",
      ])
    ).stdout;
    expect(actualCachedNumstat).toBe(expectedCachedNumstat);
  });
});

// =============================================================================
// 6d — rollback.exclude symmetry rows
// =============================================================================

describe("rollback test matrix — rollback.exclude symmetry rows (6d)", () => {
  // D3 contract: anything matched by rollback.exclude is invisible to
  // vibe-revert's safety net. Capture-time: never snapshotted.
  // Restore-time: never deleted, modified, or overwritten. Both rows
  // here verify the predictable promise from D3 — during-session changes
  // inside excluded paths PERSIST after rollback, exactly because
  // rollback never touches them.
  //
  // These rows are especially important now that M B's checkpoint and
  // start commands load rollback.exclude from .viberevert.yml. If
  // exclude behavior is wrong here, users will create checkpoints whose
  // rollback semantics don't match the documented contract.
  //
  // Note on the assertion shift vs 6b/6c: those rows verify that
  // restore reconstructs the PRE-SESSION state. These rows verify
  // that restore preserves the DURING-SESSION state inside excluded
  // paths. The captured snapshot is taken AFTER the during-session
  // mutation, then compared against post-restore — proving the
  // during-session change persists, not the pre-session one.
  //
  // Note on porcelain output: `git status --porcelain=v1` defaults to
  // `--untracked-files=normal`, which collapses untracked directories
  // into a single `?? excluded-dir/` entry rather than enumerating
  // each file inside. The porcelain assertions below reflect this
  // behavior. The file-level state is verified separately by the
  // byte-precise `assertPathsMatch` calls.

  it("Row 10: new file added inside rollback.exclude path during session — persists after rollback", async () => {
    // Pre-session: clean tree, no untracked files, no excluded-dir/.
    // Strong setup assertion: prove the excluded path is genuinely
    // empty before the during-session creation. Without this, a stray
    // file pre-existing in excluded-dir/ would silently make the test
    // pass for the wrong reason.
    const preSnapshot = await snapshotPaths(repo.repoRoot, [
      "excluded-dir/new.txt",
    ]);
    expect(preSnapshot.get("excluded-dir/new.txt")).toBeNull();
    expect(await getPorcelain(repo.repoRoot)).toBe("");

    const checkpointDir = await takeCheckpoint({
      repoRoot: repo.repoRoot,
      parentDir: repo.parentDir,
      rollbackExcludePatterns: ["excluded-dir/**"],
    });

    // During session: create a new file inside the excluded path.
    // The path is NOT gitignored (so git sees it as untracked); it's
    // only filtered by rollback.exclude. This is what exercises the
    // rollback.exclude code path specifically (rather than gitignore,
    // which is git's own filter).
    await mkdir(join(repo.repoRoot, "excluded-dir"), { recursive: true });
    await writeFile(
      join(repo.repoRoot, "excluded-dir", "new.txt"),
      "session content\n",
    );

    // Snapshot the during-session state — D3 says THIS is what must
    // persist post-restore (NOT the pre-session state, since restore
    // doesn't touch excluded paths).
    const expectedSnapshot = await snapshotPaths(repo.repoRoot, [
      "excluded-dir/new.txt",
    ]);
    expect(expectedSnapshot.get("excluded-dir/new.txt")?.toString()).toBe(
      "session content\n",
    );
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    // git's default --untracked-files=normal collapses untracked dir
    // contents into a single `?? excluded-dir/` entry. The byte
    // assertion below covers the file-level state.
    expect(expectedPorcelain).toBe("?? excluded-dir/\n");

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: ["excluded-dir/**"],
    });

    // Per D3: excluded paths are never touched by restore. The
    // during-session created file MUST persist with its session
    // content; restore must NOT delete it (which is the
    // deleteUncapturedUntracked default for any normally-untracked
    // file not in the captured set).
    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });

  it("Row 11: pre-existing file inside rollback.exclude path modified during session — modification persists after rollback", async () => {
    // Pre-session: file exists inside excluded-dir/ with content "v0".
    // Strong setup assertion: prove the file is at "v0" before the
    // during-session modification. Without this, a setup bug could
    // produce a file at a different content and the test would still
    // round-trip its current state.
    await mkdir(join(repo.repoRoot, "excluded-dir"), { recursive: true });
    await writeFile(join(repo.repoRoot, "excluded-dir", "lib.txt"), "v0\n");

    const preSnapshot = await snapshotPaths(repo.repoRoot, [
      "excluded-dir/lib.txt",
    ]);
    expect(preSnapshot.get("excluded-dir/lib.txt")?.toString()).toBe("v0\n");

    const checkpointDir = await takeCheckpoint({
      repoRoot: repo.repoRoot,
      parentDir: repo.parentDir,
      rollbackExcludePatterns: ["excluded-dir/**"],
    });

    // During session: modify the excluded file to "v1"
    await writeFile(join(repo.repoRoot, "excluded-dir", "lib.txt"), "v1\n");

    // Snapshot the during-session state — D3 says THIS ("v1") is what
    // must persist post-restore, NOT the pre-session state ("v0").
    const expectedSnapshot = await snapshotPaths(repo.repoRoot, [
      "excluded-dir/lib.txt",
    ]);
    expect(expectedSnapshot.get("excluded-dir/lib.txt")?.toString()).toBe(
      "v1\n",
    );
    const expectedPorcelain = await getPorcelain(repo.repoRoot);
    // git collapses untracked dir contents (`--untracked-files=normal`)
    // into `?? excluded-dir/`. Both pre-session and during-session
    // porcelain are identical for this row (the dir was already
    // untracked from the pre-session writeFile). The byte-precise
    // assertPathsMatch below is what distinguishes "v0 preserved"
    // from "v1 preserved" — porcelain alone can't see content. The
    // porcelain assertion locks "only the excluded dir is dirty,
    // no other side-effects."
    expect(expectedPorcelain).toBe("?? excluded-dir/\n");

    await restoreCheckpoint(checkpointDir, {
      repoRoot: repo.repoRoot,
      rollbackExcludePatterns: ["excluded-dir/**"],
    });

    // Per D3: excluded paths are never modified by restore. The
    // during-session modification ("v1") MUST persist; restore must
    // NOT roll it back to "v0" (which it would for a NON-excluded
    // file via captured tarball extraction).
    await assertPathsMatch(repo.repoRoot, expectedSnapshot);
    expect(await getPorcelain(repo.repoRoot)).toBe(expectedPorcelain);
  });
});
