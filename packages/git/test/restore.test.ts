// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// restore.ts — Step 3d targeted tests.
//
// Five tests, all locked from the implementation review:
//   1. sha256File ENOENT after a successful lstat → recorded as structured
//      missing-file mismatch (actualSha256: null), NOT a leaked filesystem error.
//   2. Empty directory at a final manifest path is auto-cleared via rmdir.
//   3. Symlink at a final manifest path is auto-cleared via unlink.
//   4. Symlink at an intermediate path component is auto-cleared via unlink.
//   5. Non-empty directory at a final manifest path remains a
//      RestoreExtractionConflict (uses rmdir not rm -r, so non-empty surfaces
//      structurally without destroying contents).
//
// Tests 3 and 4 require symlink-creation capability. On Windows that needs
// admin or developer-mode; we probe synchronously at module load time and
// skip those tests cleanly when the capability is unavailable.
//
// Test 5 uses an empty SUBDIRECTORY (not a regular file) as the blocker
// inside the destination directory — because `deleteUncapturedUntracked`
// runs BEFORE `clearExtractionPathConflicts` and would delete a regular-file
// blocker (leaving the destination empty and rmdir-able). Git does not
// enumerate empty directories via `ls-files --others`, so the empty
// subdirectory survives the delete pass and the destination directory
// remains non-empty when cleanup runs — surfacing the residual conflict
// the test is meant to exercise.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted to the top of the file by vitest. The factory wraps
// the real sha256File so unmodified calls delegate to it; per-test overrides
// (mockImplementation) can replace behavior for specific paths.
vi.mock("../src/hashes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hashes.js")>();
  return {
    ...actual,
    sha256File: vi.fn(actual.sha256File),
  };
});

import { createCheckpoint } from "../src/checkpoint.js";
import {
  RestoreExcludeDriftError,
  RestoreExtractionConflictError,
  RestoreVerificationError,
} from "../src/errors.js";
import { sha256File } from "../src/hashes.js";
import { restoreCheckpoint } from "../src/restore.js";

// =============================================================================
// Symlink-capability probe (module-load time, synchronous)
// =============================================================================

function detectSymlinkCapability(): boolean {
  let probe: string | null = null;
  try {
    probe = mkdtempSync(join(tmpdir(), "viberevert-symlink-probe-"));
    symlinkSync("target", join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    if (probe !== null) {
      try {
        rmSync(probe, { recursive: true, force: true });
      } catch {
        // ignore probe cleanup failures
      }
    }
  }
}

const canSymlink = detectSymlinkCapability();

// =============================================================================
// Test helpers
// =============================================================================

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  readonly checkpointDir: string;
  readonly flatCapturedRel: string;
  readonly nestedDirRel: string;
  readonly nestedCapturedRel: string;
  cleanup: () => Promise<void>;
}

/**
 * Build a temp git repo with a single committed file, two captured untracked
 * files (one flat, one nested), and a freshly-created checkpoint. The
 * checkpoint dir lives OUTSIDE the repo so it doesn't show up in
 * `git ls-files --others` and pollute the captured untracked set.
 */
async function setupRepoWithCheckpoint(
  opts: { rollbackExcludePatterns?: readonly string[] } = {},
): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-restore-test-"));
  const repoRoot = join(tmp, "repo");
  const checkpointDir = join(tmp, "checkpoint");

  await mkdir(repoRoot, { recursive: true });

  // Initialize git repo with quick configs (avoids dependency on global git
  // config and ensures commits work in CI environments without user.email).
  await runGit(repoRoot, ["init", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);

  // Commit a tracked file (so HEAD exists).
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);

  // Create captured untracked content: one flat file + one file inside a
  // nested dir.
  const flatCapturedRel = "captured.txt";
  const nestedDirRel = "nested/dir";
  const nestedCapturedRel = `${nestedDirRel}/inner.txt`;
  await writeFile(join(repoRoot, flatCapturedRel), "flat captured content\n");
  await mkdir(join(repoRoot, nestedDirRel), { recursive: true });
  await writeFile(join(repoRoot, nestedCapturedRel), "nested captured content\n");

  // Create the checkpoint. checkpointDir is OUTSIDE the repo so its contents
  // don't appear in `git ls-files --others`. The captured rollback.exclude
  // patterns are persisted into manifest.untracked.exclude_patterns (M B
  // Step 3e); restore-time drift detection compares them against
  // opts.rollbackExcludePatterns at restore time.
  await mkdir(checkpointDir, { recursive: true });
  await createCheckpoint({
    repoRoot,
    checkpointDir,
    rollbackExcludePatterns: opts.rollbackExcludePatterns ?? [],
  });

  return {
    repoRoot,
    checkpointDir,
    flatCapturedRel,
    nestedDirRel,
    nestedCapturedRel,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("restoreCheckpoint — Step 3d targeted tests", () => {
  // Capture the real sha256File once so per-test overrides can delegate to
  // it for paths they don't want to intercept.
  let realSha256File: typeof import("../src/hashes.js").sha256File;

  beforeAll(async () => {
    const real = await vi.importActual<typeof import("../src/hashes.js")>("../src/hashes.js");
    realSha256File = real.sha256File;
  });

  // Re-establish default delegation before each test. mockReset clears both
  // call history AND implementation; we then re-bind to realSha256File so
  // tests that don't override get the real behavior.
  beforeEach(() => {
    vi.mocked(sha256File).mockReset();
    vi.mocked(sha256File).mockImplementation((p: string) => realSha256File(p));
  });

  // Per-test cleanup safety net. Each test holds a TestRepo reference and
  // calls repo.cleanup() in its own try/finally — but reset the mock here
  // too in case a test setup throws before the finally clause registers.
  afterEach(() => {
    vi.mocked(sha256File).mockReset();
  });

  describe("hash verification race guard (TOCTOU between lstat and sha256File)", () => {
    it("treats sha256File ENOENT as structured missing-file mismatch (actualSha256 = null)", async () => {
      const repo = await setupRepoWithCheckpoint();
      try {
        // Path-targeted override: throw ENOENT only when sha256File is called
        // with the captured flat file's absolute path. All other paths
        // delegate to the real sha256File.
        const targetedAbs = join(repo.repoRoot, repo.flatCapturedRel);
        vi.mocked(sha256File).mockImplementation(async (p: string) => {
          if (p === targetedAbs) {
            const err = new Error(
              "ENOENT: file vanished mid-verification (test injection)",
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          }
          return realSha256File(p);
        });

        let caught: unknown;
        try {
          await restoreCheckpoint(repo.checkpointDir, {
            repoRoot: repo.repoRoot,
            rollbackExcludePatterns: [],
          });
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(RestoreVerificationError);
        const err = caught as RestoreVerificationError;
        const flatMismatch = err.mismatches.find((m) => m.path === repo.flatCapturedRel);
        expect(flatMismatch).toBeDefined();
        expect(flatMismatch?.actualSha256).toBeNull();
        expect(flatMismatch?.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await repo.cleanup();
      }
    });
  });

  describe("clearExtractionPathConflicts auto-clear", () => {
    it("auto-clears empty directory at a final manifest path via rmdir", async () => {
      const repo = await setupRepoWithCheckpoint();
      try {
        // Replace the captured flat file with an empty directory at the
        // same path. The cleanup helper should rmdir the empty directory
        // and let extract write the regular file.
        const flatAbs = join(repo.repoRoot, repo.flatCapturedRel);
        await rm(flatAbs);
        await mkdir(flatAbs);

        await restoreCheckpoint(repo.checkpointDir, {
          repoRoot: repo.repoRoot,
          rollbackExcludePatterns: [],
        });

        const st = await lstat(flatAbs);
        expect(st.isFile()).toBe(true);
        expect(st.isDirectory()).toBe(false);
      } finally {
        await repo.cleanup();
      }
    });

    describe.skipIf(!canSymlink)("symlink cleanup (requires symlink capability)", () => {
      it("auto-clears symlink at a final manifest path via unlink", async () => {
        const repo = await setupRepoWithCheckpoint();
        try {
          // Replace the captured flat file with a symlink at the same path.
          // The cleanup helper should unlink the symlink and let extract
          // write the regular file.
          const flatAbs = join(repo.repoRoot, repo.flatCapturedRel);
          await rm(flatAbs);
          await writeFile(join(repo.repoRoot, "elsewhere.txt"), "elsewhere\n");
          await symlink("elsewhere.txt", flatAbs);

          await restoreCheckpoint(repo.checkpointDir, {
            repoRoot: repo.repoRoot,
            rollbackExcludePatterns: [],
          });

          const st = await lstat(flatAbs);
          expect(st.isFile()).toBe(true);
          expect(st.isSymbolicLink()).toBe(false);
        } finally {
          await repo.cleanup();
        }
      });

      it("auto-clears symlink at an intermediate path component via unlink", async () => {
        const repo = await setupRepoWithCheckpoint();
        try {
          // Remove the nested dir + its contents; replace the dir path with
          // a symlink pointing elsewhere. The cleanup helper should unlink
          // the intermediate symlink and let extract create the real
          // directory at this path.
          const nestedDirAbs = join(repo.repoRoot, repo.nestedDirRel);
          await rm(nestedDirAbs, { recursive: true, force: true });
          // The parent of nested/dir (= "nested/") still needs to exist as
          // a real dir; we removed only "nested/dir/". Create an "elsewhere"
          // dir to be the symlink target.
          await mkdir(join(repo.repoRoot, "elsewhere"));
          await symlink(join(repo.repoRoot, "elsewhere"), nestedDirAbs);

          await restoreCheckpoint(repo.checkpointDir, {
            repoRoot: repo.repoRoot,
            rollbackExcludePatterns: [],
          });

          // Intermediate symlink unlinked, real directory created by extract.
          const dirSt = await lstat(nestedDirAbs);
          expect(dirSt.isDirectory()).toBe(true);
          expect(dirSt.isSymbolicLink()).toBe(false);
          // Captured nested file is present as a regular file.
          const fileSt = await lstat(join(repo.repoRoot, repo.nestedCapturedRel));
          expect(fileSt.isFile()).toBe(true);
        } finally {
          await repo.cleanup();
        }
      });
    });
  });

  describe("RestoreExcludeDriftError (M B Step 3e — bidirectional drift detection)", () => {
    it("throws on pure tightening drift (patterns added since checkpoint, no manifest paths affected yet)", async () => {
      // Capture with empty patterns; restore with ["build/**"]. No captured
      // file matches build/**, so tighteningPaths is empty — but the pattern-
      // set drift alone is enough to refuse. Demonstrates that the error
      // fires on policy mismatch even when no immediate damage would happen.
      const repo = await setupRepoWithCheckpoint({ rollbackExcludePatterns: [] });
      try {
        let caught: unknown;
        try {
          await restoreCheckpoint(repo.checkpointDir, {
            repoRoot: repo.repoRoot,
            rollbackExcludePatterns: ["build/**"],
          });
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(RestoreExcludeDriftError);
        const err = caught as RestoreExcludeDriftError;
        expect(err.capturedPatterns).toEqual([]);
        expect(err.currentPatterns).toEqual(["build/**"]);
        expect(err.tighteningPatterns).toEqual(["build/**"]);
        expect(err.looseningPatterns).toEqual([]);
        // No captured manifest path matches build/**, so no immediate
        // damage signal — but the drift still throws.
        expect(err.tighteningPaths).toEqual([]);
      } finally {
        await repo.cleanup();
      }
    });

    it("throws on pure loosening drift (patterns removed since checkpoint)", async () => {
      // Capture with ["build/**"]; restore with []. Captured patterns are no
      // longer enforced at restore time. tighteningPaths is meaningless on
      // the loosening side (the current matcher matches nothing); we refuse
      // because the working tree may contain pre-existing files that
      // capture-time exclusion preserved but restore-time would now
      // consider deletable.
      const repo = await setupRepoWithCheckpoint({
        rollbackExcludePatterns: ["build/**"],
      });
      try {
        let caught: unknown;
        try {
          await restoreCheckpoint(repo.checkpointDir, {
            repoRoot: repo.repoRoot,
            rollbackExcludePatterns: [],
          });
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(RestoreExcludeDriftError);
        const err = caught as RestoreExcludeDriftError;
        expect(err.capturedPatterns).toEqual(["build/**"]);
        expect(err.currentPatterns).toEqual([]);
        expect(err.tighteningPatterns).toEqual([]);
        expect(err.looseningPatterns).toEqual(["build/**"]);
        expect(err.tighteningPaths).toEqual([]);
      } finally {
        await repo.cleanup();
      }
    });

    it("throws on combined drift with manifest paths immediately affected (most user-relevant scenario)", async () => {
      // Capture with ["build/**"]; restore with ["captured.txt", "nested/**"].
      // - tighteningPatterns = ["captured.txt", "nested/**"] (both new vs captured)
      // - looseningPatterns = ["build/**"] (captured had it, restore doesn't)
      // - tighteningPaths = ["captured.txt", "nested/dir/inner.txt"] — the
      //   current restore-time matcher hits BOTH captured manifest paths,
      //   so the drift would immediately damage this restore. The most
      //   user-actionable signal: names exactly which captured files are
      //   affected.
      const repo = await setupRepoWithCheckpoint({
        rollbackExcludePatterns: ["build/**"],
      });
      try {
        let caught: unknown;
        try {
          await restoreCheckpoint(repo.checkpointDir, {
            repoRoot: repo.repoRoot,
            rollbackExcludePatterns: ["captured.txt", "nested/**"],
          });
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(RestoreExcludeDriftError);
        const err = caught as RestoreExcludeDriftError;
        expect(err.capturedPatterns).toEqual(["build/**"]);
        expect(err.currentPatterns).toEqual(["captured.txt", "nested/**"]);
        expect(err.tighteningPatterns).toEqual(["captured.txt", "nested/**"]);
        expect(err.looseningPatterns).toEqual(["build/**"]);
        expect(err.tighteningPaths).toEqual([repo.flatCapturedRel, repo.nestedCapturedRel]);
      } finally {
        await repo.cleanup();
      }
    });
  });

  describe("RestoreExtractionConflictError (residual blockers post-cleanup)", () => {
    it("surfaces non-empty directory at a final manifest path as a structured conflict", async () => {
      const repo = await setupRepoWithCheckpoint();
      try {
        // Replace the captured flat file with a directory containing an
        // EMPTY SUBDIRECTORY (not a regular file). Why empty subdir, not a
        // regular-file blocker:
        //   - `deleteUncapturedUntracked` runs BEFORE the cleanup pass and
        //     would delete a regular-file blocker (since git enumerates it
        //     as untracked), leaving the destination empty and rmdir-able.
        //   - Git does NOT enumerate empty directories via `ls-files
        //     --others`, so an empty subdirectory survives the delete pass.
        //   - `captured.txt/` therefore remains non-empty when
        //     `clearExtractionPathConflicts` runs, and `rmdir` fails with
        //     ENOTEMPTY → structured conflict surfaces, contents preserved.
        const flatAbs = join(repo.repoRoot, repo.flatCapturedRel);
        await rm(flatAbs);
        await mkdir(flatAbs);
        const blockerAbs = join(flatAbs, "blocker-dir");
        await mkdir(blockerAbs);

        let caught: unknown;
        try {
          await restoreCheckpoint(repo.checkpointDir, {
            repoRoot: repo.repoRoot,
            rollbackExcludePatterns: [],
          });
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(RestoreExtractionConflictError);
        const err = caught as RestoreExtractionConflictError;
        const flatConflict = err.conflicts.find((c) => c.manifestPath === repo.flatCapturedRel);
        expect(flatConflict).toBeDefined();
        expect(flatConflict?.reason).toMatch(/directory/i);
        expect(flatConflict?.reason).toMatch(/could not be removed/i);

        // Critical: blocker subdirectory was preserved (cleanup did NOT do
        // rm -r). This is the locked safety property — non-empty dirs
        // surface structurally without destroying contents.
        const blockerSt = await lstat(blockerAbs);
        expect(blockerSt.isDirectory()).toBe(true);
      } finally {
        await repo.cleanup();
      }
    });
  });
});
