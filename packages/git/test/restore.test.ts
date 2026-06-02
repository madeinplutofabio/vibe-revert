// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// restore.ts — Step 3d targeted tests (M B locked) + M D Step 3 additions.
//
// =============================================================================
// M B Step 3d locked tests (preserved):
// =============================================================================
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
//
// Also preserved: 3 M B Step 3e RestoreExcludeDriftError tests (tightening
// drift, loosening drift, combined drift with manifest paths affected).
//
// =============================================================================
// M D Step 3 additions (integration coverage for the M D-promoted surface):
// =============================================================================
//
//   - `restoreCheckpoint` allowHeadMismatch coverage (D64): default throws
//     RestoreHeadMismatchError on HEAD mismatch; option `true` skips the
//     pre-check and the restore-correctness chain succeeds entirely on
//     a clean unrelated-commit setup.
//   - `planRestoreCheckpoint` (D76): parity with restoreCheckpoint (modify
//     → predict → apply → bytes match), head_match surfaces honestly,
//     preflight_failures suppression honors A6's force-success contract,
//     exclude drift surfaces unconditionally.
//   - `.viberevert/**` evidence-side rejection: tampered manifest with
//     `.viberevert/...` in ALL THREE rejection points (untracked
//     file_hashes, snapshots file_hashes, snapshots tracked_dirty_paths)
//     is rejected as CheckpointCorruptError. The tracked_dirty_paths
//     case specifically pins the deletion-vector attack (path declared
//     as a tracked deletion has no hash entry and no archive entry, so
//     file_hashes + archive validation BOTH miss it).
//   - `.viberevert/**` patch-header rejection: tampered staged.patch
//     with direct OR C-escaped `.viberevert/**` header is rejected.
//     File 4a tests the predicate; THIS file tests that preflight
//     actually calls it.
//   - `.viberevert/**` mutation-side hard-exclude (deleteUncapturedUntracked
//     + plan deletion enumeration): test setup includes BOTH a `.viberevert/
//     checkpoints/emergency/manifest.json` file (must be preserved) AND a
//     normal `scratch-to-delete.txt` control file (must be deleted by the
//     same pass). Proves both directions: the deletion pass actually runs
//     AND the hard-exclude specifically spares VibeRevert internal paths.
//   - `clearExtractionPathConflicts` tripwire (file header invariant #6
//     call site (c)): direct call with synthetic `.viberevert/**` paths
//     produces structured conflicts non-mutatively. Validates that if
//     preflight ever DRIFTED and let such a path reach cleanup, the
//     tripwire would surface it via RestoreExtractionConflictError
//     rather than silently absorbing it.
//   - `..` path-resolution safety boundary: programmatically probes
//     git apply's behavior on `--- a/foo/../.viberevert/x`, with a
//     control patch (same shape, safe path) validated FIRST so any
//     rejection of the `..` patch is genuinely about the `..` policy
//     and not a malformed-patch artifact. If git rejects (modern
//     behavior), test passes silently — locks the assumption. If a
//     future git accepts, the test routes through the scanner and
//     forces a `..`-normalization update with a loud security message.
//
// Pure unit tests on the policy module itself live in
// restore-internal-path-policy.test.ts.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  CheckpointCorruptError,
  RestoreExcludeDriftError,
  RestoreExtractionConflictError,
  RestoreHeadMismatchError,
  RestoreVerificationError,
} from "../src/errors.js";
import { sha256File } from "../src/hashes.js";
import {
  clearExtractionPathConflicts,
  planRestoreCheckpoint,
  restoreCheckpoint,
} from "../src/restore.js";
import { patchHeaderTargetsVibeRevertInternalPath } from "../src/restore-internal-path-policy.js";

// =============================================================================
// File-scope sha256File mock lifecycle
//
// Hoisted to file scope so ALL tests in this file — both the M B Step 3d
// targeted tests inside the first describe AND the M D Step 3 additions
// below — get a real sha256File implementation by default. Originally
// the lifecycle hooks were scoped inside the first describe, which meant
// the last afterEach there would reset the mock and leave it returning
// undefined for any subsequent file-scope test, silently corrupting
// hash-driven test setups (createCheckpoint, restoreCheckpoint,
// planRestoreCheckpoint all hash captured files). File-scope hooks fire
// for every test in the file regardless of describe nesting.
// =============================================================================

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

// Per-test cleanup safety net. Tests that hold a TestRepo reference call
// repo.cleanup() in their own try/finally — but reset the mock here too
// in case a test setup throws before the finally clause registers.
afterEach(() => {
  vi.mocked(sha256File).mockReset();
});

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

/**
 * Advance HEAD by one commit so the repo's current HEAD differs from the
 * SHA captured in `manifest.git.head_sha`. Used by M D allowHeadMismatch /
 * planRestoreCheckpoint head-mismatch coverage. Commits an unrelated tracked
 * file so the captured-untracked surface stays clean.
 */
async function advanceHead(repoRoot: string): Promise<void> {
  await writeFile(join(repoRoot, "advance.txt"), "advance HEAD\n");
  await runGit(repoRoot, ["add", "advance.txt"]);
  await runGit(repoRoot, ["commit", "-m", "advance HEAD past checkpoint"]);
}

/**
 * Read and JSON-parse the manifest at `checkpointDir/manifest.json`. Used
 * by the manifest path-policy tampering tests + the patch-header tampering
 * tests (which need to locate the staged.patch/unstaged.patch paths from
 * the manifest's diffs section).
 */
async function readManifest(checkpointDir: string): Promise<{
  diffs: { staged_patch_path: string; unstaged_patch_path: string };
  snapshots: { file_hashes: Record<string, string>; tracked_dirty_paths: string[] };
  untracked: { file_hashes: Record<string, string> };
  [k: string]: unknown;
}> {
  const raw = await readFile(join(checkpointDir, "manifest.json"), "utf8");
  return JSON.parse(raw);
}

/**
 * Tamper the manifest at `checkpointDir/manifest.json` by applying
 * `mutator` to the parsed object then writing it back. Used by the
 * evidence-side rejection tests. NOT atomic (plain writeFile, no
 * temp+rename) — fine for the test surface where the helper's caller
 * is the only writer during the test window.
 */
async function tamperManifest(
  checkpointDir: string,
  mutator: (m: Awaited<ReturnType<typeof readManifest>>) => void,
): Promise<void> {
  const manifest = await readManifest(checkpointDir);
  mutator(manifest);
  await writeFile(join(checkpointDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

// =============================================================================
// Tests
// =============================================================================

describe("restoreCheckpoint — Step 3d targeted tests", () => {
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

// =============================================================================
// M D Step 3 — restoreCheckpoint.allowHeadMismatch (D64)
// =============================================================================

describe("restoreCheckpoint — M D allowHeadMismatch (D64)", () => {
  it("default (allowHeadMismatch unset) throws RestoreHeadMismatchError when HEAD has advanced past the checkpoint", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      // Advance HEAD past the captured SHA.
      await advanceHead(repo.repoRoot);

      let caught: unknown;
      try {
        await restoreCheckpoint(repo.checkpointDir, {
          repoRoot: repo.repoRoot,
          rollbackExcludePatterns: [],
          // allowHeadMismatch unset (defaults to false)
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(RestoreHeadMismatchError);
    } finally {
      await repo.cleanup();
    }
  });

  it("allowHeadMismatch: true skips the HEAD pre-check AND the full restore succeeds on a clean unrelated-commit setup", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await advanceHead(repo.repoRoot);

      // With allowHeadMismatch: true the HEAD pre-check is skipped.
      // Setup specifics that make this test asserting full success
      // (not just "didn't throw RestoreHeadMismatchError"):
      //   - Captured patches are empty (tracked tree was clean at
      //     checkpoint time; only untracked files captured).
      //   - advanceHead adds an UNRELATED tracked file (advance.txt)
      //     that doesn't overlap any captured path.
      //   - gitResetHardHead resets tracked side to NEW HEAD (preserves
      //     advance.txt as a clean tracked file; preserves captured.txt
      //     and nested/dir/inner.txt as untracked).
      //   - Empty patch replay = no-op.
      //   - deleteUncapturedUntracked: captured files are in capturedSet
      //     so they're preserved; no other untracked exists.
      //   - extractUntrackedTarball overwrites with captured bytes.
      //   - Post-mutation: tracked-dirty = [] matches manifest's []
      //     (advance.txt at HEAD = HEAD content, not dirty). Hash
      //     verification passes for untracked file_hashes.
      //
      // So a successful restore is the EXPECTED outcome here, not just
      // "absence of HEAD-mismatch error". Strengthened assertion locks
      // that future parity/hash regressions don't slip through as
      // "different non-HEAD error".
      let caught: unknown;
      try {
        await restoreCheckpoint(repo.checkpointDir, {
          repoRoot: repo.repoRoot,
          rollbackExcludePatterns: [],
          allowHeadMismatch: true,
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// M D Step 3 — planRestoreCheckpoint dry-run sibling (D76)
// =============================================================================

describe("planRestoreCheckpoint — M D dry-run sibling (D76)", () => {
  it("returns head_match: false WITHOUT throwing when HEAD has advanced (info-not-throws per A6)", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await advanceHead(repo.repoRoot);

      // planRestoreCheckpoint never throws on HEAD mismatch — it surfaces
      // it as head_match: false + a preflight_failures[] entry. The CLI
      // is responsible for deciding whether to refuse (apply) or report
      // (dry-run receipt).
      const plan = await planRestoreCheckpoint(repo.checkpointDir, {
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: [],
      });

      expect(plan.head_match).toBe(false);
      // Default allowHeadMismatch (false/unset) means head_mismatch
      // SHOULD appear in preflight_failures.
      const headMismatchEntry = plan.preflight_failures.find(
        (f) => f.error_code === "head_mismatch",
      );
      expect(headMismatchEntry).toBeDefined();
      expect(headMismatchEntry?.message).toMatch(/HEAD/i);
    } finally {
      await repo.cleanup();
    }
  });

  it("on a clean unchanged tree, plan classifies all captured paths as skipped_unchanged with empty mutation buckets", async () => {
    // Parity test in the trivial direction: no modifications between
    // checkpoint creation and planning. Restore would be a complete no-op
    // (every captured file's current bytes match), so plan should classify
    // everything that way.
    const repo = await setupRepoWithCheckpoint();
    try {
      const plan = await planRestoreCheckpoint(repo.checkpointDir, {
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: [],
      });

      expect(plan.head_match).toBe(true);
      expect(plan.preflight_failures).toEqual([]);
      // Both captured untracked files should be classified as unchanged
      // (their on-disk bytes still match the captured hashes).
      expect(plan.skipped_unchanged).toContain(repo.flatCapturedRel);
      expect(plan.skipped_unchanged).toContain(repo.nestedCapturedRel);
      // No tracked-dirty paths were captured; no extraction would happen.
      expect(plan.tracked_restored).toEqual([]);
      expect(plan.untracked_restored).toEqual([]);
      expect(plan.untracked_deleted).toEqual([]);
      expect(plan.skipped_excluded).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("plan/apply parity: modified captured file appears in plan.untracked_restored AND apply restores bytes to captured", async () => {
    // Semantic parity test: the plan PREDICTS what apply will do, and
    // apply confirms that prediction. If the prediction is right
    // syntactically but wrong semantically (e.g., apply restores
    // different bytes), this test catches it.
    const repo = await setupRepoWithCheckpoint();
    try {
      // Modify the captured flat file so its current bytes diverge from
      // captured. Plan should predict untracked_restored; apply should
      // restore to the captured bytes.
      const flatAbs = join(repo.repoRoot, repo.flatCapturedRel);
      await writeFile(flatAbs, "MODIFIED content\n");

      // Plan prediction.
      const plan = await planRestoreCheckpoint(repo.checkpointDir, {
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: [],
      });
      expect(plan.untracked_restored).toContain(repo.flatCapturedRel);
      // The unchanged file is correctly classified as unchanged.
      expect(plan.skipped_unchanged).toContain(repo.nestedCapturedRel);
      expect(plan.untracked_restored).not.toContain(repo.nestedCapturedRel);

      // Apply, then verify the prediction held semantically.
      await restoreCheckpoint(repo.checkpointDir, {
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: [],
      });

      // Captured bytes are restored (the prediction was correct).
      const restoredBytes = await readFile(flatAbs, "utf8");
      expect(restoredBytes).toBe("flat captured content\n");
    } finally {
      await repo.cleanup();
    }
  });

  it("allowHeadMismatch: true SUPPRESSES the head_mismatch preflight_failures entry while still reporting head_match: false (A6 contract)", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await advanceHead(repo.repoRoot);

      const plan = await planRestoreCheckpoint(repo.checkpointDir, {
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: [],
        allowHeadMismatch: true,
      });

      // head_match still reports the ACTUAL state (false) — suppression
      // only affects whether it surfaces as a preflight failure.
      expect(plan.head_match).toBe(false);
      // head_mismatch entry MUST be suppressed per A6 — receipt has
      // `failures: []` on force-success.
      const headMismatchEntry = plan.preflight_failures.find(
        (f) => f.error_code === "head_mismatch",
      );
      expect(headMismatchEntry).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("exclude_drift surfaces via preflight_failures regardless of allowHeadMismatch (D75 — --force does NOT bypass drift)", async () => {
    const repo = await setupRepoWithCheckpoint({ rollbackExcludePatterns: [] });
    try {
      // Even with allowHeadMismatch: true, exclude_drift must still
      // appear in preflight_failures — the M D D75 lock says force does
      // NOT bypass exclude drift, and planRestoreCheckpoint is consistent
      // with that contract (the CLI applies the same rule on apply).
      const plan = await planRestoreCheckpoint(repo.checkpointDir, {
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: ["build/**"],
        allowHeadMismatch: true,
      });

      const excludeDriftEntry = plan.preflight_failures.find(
        (f) => f.error_code === "exclude_drift",
      );
      expect(excludeDriftEntry).toBeDefined();
      expect(excludeDriftEntry?.message).toMatch(/rollback\.exclude/);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// M D Step 3 — .viberevert/** evidence-side rejection (manifest path-policy)
//
// Three tests covering all THREE rejection points in the manifest path-
// policy block of loadRestorePreflight (step 2):
//   - manifest.untracked.file_hashes keys (untracked-side declaration)
//   - manifest.snapshots.file_hashes keys (tracked regular-file declaration)
//   - manifest.snapshots.tracked_dirty_paths entries (SUPERSET surface;
//     the only check that catches the deletion-vector attack)
// =============================================================================

describe(".viberevert/** evidence-side rejection — manifest (M D Step 3 Blocker 2)", () => {
  it("rejects .viberevert/... in manifest.untracked.file_hashes as CheckpointCorruptError", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await tamperManifest(repo.checkpointDir, (m) => {
        m.untracked.file_hashes[".viberevert/sessions/X/data.json"] = "a".repeat(64);
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

      expect(caught).toBeInstanceOf(CheckpointCorruptError);
      expect((caught as CheckpointCorruptError).message).toMatch(/untracked\.file_hashes/);
      expect((caught as CheckpointCorruptError).message).toMatch(
        /\.viberevert\/sessions\/X\/data\.json/,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects .viberevert/... in manifest.snapshots.file_hashes as CheckpointCorruptError", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await tamperManifest(repo.checkpointDir, (m) => {
        m.snapshots.file_hashes[".viberevert/sessions/X/manifest.json"] = "b".repeat(64);
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

      expect(caught).toBeInstanceOf(CheckpointCorruptError);
      expect((caught as CheckpointCorruptError).message).toMatch(/snapshots\.file_hashes/);
      expect((caught as CheckpointCorruptError).message).toMatch(
        /\.viberevert\/sessions\/X\/manifest\.json/,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects .viberevert/... in manifest.snapshots.tracked_dirty_paths as CheckpointCorruptError (deletion-vector attack — bypasses file_hashes + archive)", async () => {
    // This is the SUPERSET surface. A path declared here as a tracked
    // deletion has NO file_hashes entry and NO archive entry, so the
    // file_hashes + archive validation BOTH miss it. The manifest
    // path-policy check is the only thing that catches it. Without
    // this rejection, the patch-replay phase would execute the captured
    // staged.patch / unstaged.patch which could include a delete-file
    // header targeting `.viberevert/checkpoints/cp_<emergency>/manifest.json`,
    // wiping the emergency pre-rollback checkpoint between checkpoint
    // creation and restore.
    const repo = await setupRepoWithCheckpoint();
    try {
      await tamperManifest(repo.checkpointDir, (m) => {
        m.snapshots.tracked_dirty_paths = [".viberevert/sessions/X/manifest.json"];
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

      expect(caught).toBeInstanceOf(CheckpointCorruptError);
      expect((caught as CheckpointCorruptError).message).toMatch(/tracked_dirty_paths/);
      expect((caught as CheckpointCorruptError).message).toMatch(
        /\.viberevert\/sessions\/X\/manifest\.json/,
      );
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// M D Step 3 — .viberevert/** evidence-side rejection (patch headers)
//
// File 4a proves the predicate; this block proves preflight actually
// CALLS the predicate. Two tests via it.each cover direct + C-escaped
// forms (the two most likely tampering vectors).
// =============================================================================

describe(".viberevert/** evidence-side rejection — patch headers (M D Step 3 Blocker 2)", () => {
  it.each([
    [
      "direct .viberevert/** header in staged.patch",
      "staged.patch",
      "--- a/.viberevert/sessions/X/foo.json\n+++ b/.viberevert/sessions/X/foo.json\n",
    ],
    [
      "C-escaped .viberevert/** header in unstaged.patch",
      "unstaged.patch",
      '--- "a/\\056viberevert/sessions/X/foo.json"\n+++ "b/\\056viberevert/sessions/X/foo.json"\n',
    ],
  ])("rejects tampered patch with %s as CheckpointCorruptError", async (_label, whichPatch, tamperedContent) => {
    const repo = await setupRepoWithCheckpoint();
    try {
      // Locate the target patch path from the manifest, then overwrite
      // it with the tampered content. The scanner runs over raw patch
      // bytes; it does not require the content to be a valid git diff
      // beyond the header lines being scanned.
      const manifest = await readManifest(repo.checkpointDir);
      const patchRel =
        whichPatch === "staged.patch"
          ? manifest.diffs.staged_patch_path
          : manifest.diffs.unstaged_patch_path;
      await writeFile(join(repo.checkpointDir, patchRel), tamperedContent);

      let caught: unknown;
      try {
        await restoreCheckpoint(repo.checkpointDir, {
          repoRoot: repo.repoRoot,
          rollbackExcludePatterns: [],
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(CheckpointCorruptError);
      const msg = (caught as CheckpointCorruptError).message;
      expect(msg).toMatch(new RegExp(whichPatch.replace(".", "\\.")));
      expect(msg).toMatch(/VibeRevert internal storage path/);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// M D Step 3 — .viberevert/** mutation-side hard-exclude
//
// Proves the deletion-side hard-exclude (file header invariant #6 call
// sites (a) + (b)) protects the emergency pre-rollback checkpoint in
// the REAL deletion path, not only in pure policy tests. Each test sets
// up BOTH:
//   - .viberevert/checkpoints/emergency/manifest.json (must be PRESERVED)
//   - scratch-to-delete.txt (CONTROL: must be DELETED by the same pass)
// so both directions are proven: the deletion pass actually runs AND
// the hard-exclude specifically spares VibeRevert internal paths.
//
// The harness repo doesn't gitignore .viberevert/, so git enumerates
// the emergency manifest as untracked — exactly the scenario where the
// hard-exclude in deleteUncapturedUntracked must fire to preserve the
// user's safety net.
// =============================================================================

describe(".viberevert/** mutation-side hard-exclude (M D file header invariant #6)", () => {
  it("deleteUncapturedUntracked PRESERVES .viberevert/** paths AND deletes normal uncaptured untracked (proves both directions)", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      // Setup: the protected file + a control scratch file. Both are
      // untracked-uncaptured after the checkpoint was made; only the
      // .viberevert/** one should survive deletion.
      const emergencyCpDir = join(repo.repoRoot, ".viberevert", "checkpoints", "emergency");
      const emergencyManifestPath = join(emergencyCpDir, "manifest.json");
      await mkdir(emergencyCpDir, { recursive: true });
      await writeFile(emergencyManifestPath, '{"schema_version":"1.0","note":"emergency"}\n');

      const scratchPath = join(repo.repoRoot, "scratch-to-delete.txt");
      await writeFile(scratchPath, "delete me\n");

      await restoreCheckpoint(repo.checkpointDir, {
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: [],
      });

      // CONTROL assertion: the deletion pass actually ran (scratch file
      // is gone). If this fails, the test isn't proving the hard-exclude
      // — it's just showing nothing was deleted.
      await expect(lstat(scratchPath)).rejects.toMatchObject({ code: "ENOENT" });

      // PROTECTED assertion: emergency manifest survives (hard-exclude
      // fired). Contents also preserved (no rmdir of parent dirs).
      const st = await lstat(emergencyManifestPath);
      expect(st.isFile()).toBe(true);
      const bytes = await readFile(emergencyManifestPath, "utf8");
      expect(bytes).toBe('{"schema_version":"1.0","note":"emergency"}\n');
    } finally {
      await repo.cleanup();
    }
  });

  it("planRestoreCheckpoint deletion enumeration DOES list normal untracked AND DOES NOT list .viberevert/** (parity with apply)", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      // Same setup as the apply test — control file + protected file.
      const emergencyCpDir = join(repo.repoRoot, ".viberevert", "checkpoints", "emergency");
      const emergencyManifestPath = join(emergencyCpDir, "manifest.json");
      await mkdir(emergencyCpDir, { recursive: true });
      await writeFile(emergencyManifestPath, '{"schema_version":"1.0","note":"emergency"}\n');

      const scratchPath = join(repo.repoRoot, "scratch-to-delete.txt");
      await writeFile(scratchPath, "delete me\n");

      const plan = await planRestoreCheckpoint(repo.checkpointDir, {
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: [],
      });

      // CONTROL: scratch file IS in the deletion list (proves enumeration
      // is happening and finds normal untracked-uncaptured files).
      expect(plan.untracked_deleted).toContain("scratch-to-delete.txt");

      // PROTECTED: .viberevert/** path is NOT in the deletion list.
      expect(plan.untracked_deleted).not.toContain(
        ".viberevert/checkpoints/emergency/manifest.json",
      );
      // And not in skipped_excluded either — the policy module's hard-
      // exclude is a SEPARATE filter that fires BEFORE the exclude-
      // matcher check, so the path is not classified as "excluded".
      expect(plan.skipped_excluded).not.toContain(
        ".viberevert/checkpoints/emergency/manifest.json",
      );
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// M D Step 3 — clearExtractionPathConflicts .viberevert/** tripwire
//
// File header invariant #6 call site (c). Direct calls to the helper
// (imported from `../src/restore.js` per the test-surface concession;
// see restore.ts JSDoc on the export). No fs setup needed — the tripwire
// fires in the `allPaths`-building loop BEFORE any lstat call, so the
// paths don't need to exist on disk.
// =============================================================================

describe("clearExtractionPathConflicts — .viberevert/** tripwire (M D file header invariant #6 call site c)", () => {
  // Locked reason text per restore.ts. Tests assert exact match.
  const TRIPWIRE_REASON =
    "restore refused to clean extraction path under VibeRevert internal storage (.viberevert/**)";

  it("pushes a structured tripwire conflict when .viberevert/... appears in expectedPaths (non-mutating)", async () => {
    // No real repo needed — the tripwire fires before lstat. Pass a
    // never-touched path as repoRoot; the helper won't access it for
    // .viberevert/** paths (they hit `continue` BEFORE the ancestor
    // walk that would compute abs paths).
    const repoRoot = await mkdtemp(join(tmpdir(), "viberevert-tripwire-test-"));
    try {
      const conflicts = await clearExtractionPathConflicts(
        repoRoot,
        [".viberevert/sessions/X/foo.json"],
        () => false,
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.manifestPath).toBe(".viberevert/sessions/X/foo.json");
      expect(conflicts[0]?.conflictingPath).toBe(".viberevert/sessions/X/foo.json");
      expect(conflicts[0]?.reason).toBe(TRIPWIRE_REASON);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("catches case-variant + backslash + dot-segment .viberevert/** forms via the centralized predicate", async () => {
    // Three forms that the policy module normalizes to .viberevert/...
    // All three should surface tripwire conflicts.
    const repoRoot = await mkdtemp(join(tmpdir(), "viberevert-tripwire-test-"));
    try {
      const conflicts = await clearExtractionPathConflicts(
        repoRoot,
        [
          ".VIBEREVERT/sessions/X/case.json",
          ".viberevert\\sessions\\X\\backslash.json",
          "./.viberevert/sessions/X/dotseg.json",
        ],
        () => false,
      );

      expect(conflicts).toHaveLength(3);
      // All three reasons identical — tripwire text is path-independent.
      for (const c of conflicts) {
        expect(c.reason).toBe(TRIPWIRE_REASON);
      }
      // Manifest paths preserve the original (pre-normalization) form —
      // useful for the user to find the source in their input.
      const paths = conflicts.map((c) => c.manifestPath).sort();
      expect(paths).toEqual([
        "./.viberevert/sessions/X/dotseg.json",
        ".VIBEREVERT/sessions/X/case.json",
        ".viberevert\\sessions\\X\\backslash.json",
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("non-VibeRevert paths in expectedPaths walk normally; tripwire conflicts are separate from regular conflicts", async () => {
    // Mixed input: one .viberevert/** tripwire + one legitimate path that
    // doesn't exist on disk (lstat ENOENT → continue, no conflict for it).
    // Result: exactly one conflict, the tripwire.
    const repoRoot = await mkdtemp(join(tmpdir(), "viberevert-tripwire-test-"));
    try {
      const conflicts = await clearExtractionPathConflicts(
        repoRoot,
        [".viberevert/internal.json", "regular/file.txt"],
        () => false,
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.manifestPath).toBe(".viberevert/internal.json");
      expect(conflicts[0]?.reason).toBe(TRIPWIRE_REASON);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// M D Step 3 — `..` path-resolution safety boundary
//
// The patch-header scanner's regex requires `.viberevert` at a true
// path-root position (token-start gate + optional a//b/ + optional ./).
// Paths with `..` segments like `foo/../.viberevert/x` are NOT caught
// by the regex because the char before `.viberevert` is `/` (the / in
// `../`), failing the token-start gate.
//
// The scanner's safety against `..` paths relies on git apply REJECTING
// them — which it does at the time of writing. This test PROGRAMMATICALLY
// probes git's behavior, with a CONTROL patch checked first so any
// rejection of the `..` patch is genuinely about the `..` policy and
// not a malformed-patch artifact:
//
//   - First, run `git apply --check` on a SAFE patch (same shape, no
//     `..` segment) — UNGUARDED. If git rejects this, the test throws
//     immediately with git's error and the dotdot probe never runs.
//     This proves the patch format is valid.
//
//   - Then, probe git's behavior on the dotdot patch. If git rejects
//     (current behavior on modern git): test passes silently;
//     assumption is locked, scanner is safe.
//
//   - If git accepts the dotdot patch (e.g., future canonicalization
//     behavior): SECURITY GAP. The assertion routes through the
//     scanner with a loud failure message demanding the policy module
//     be extended with `..` resolution OR a real path parser.
//
// Test repo pre-creates `foo/` (with its own tracked file) so a
// rejection cannot be explained away by "git couldn't find foo/" or
// other repo-shape artifacts — the probe is specifically about git's
// `..` policy.
// =============================================================================

describe("`..` path-resolution safety boundary (M D Step 3 future-proofing)", () => {
  it("locks the assumption that git apply rejects foo/../.viberevert/x patches; fires loudly if a future git accepts them", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "viberevert-dotdot-test-"));
    try {
      // Build a minimal git repo. Pre-create `foo/` as a real tracked
      // directory (with its own seed file) so the probe's outcome
      // depends on git's `..` policy specifically — not on a missing
      // path component artifact.
      await runGit(tmp, ["init", "-b", "main"]);
      await runGit(tmp, ["config", "user.email", "test@example.com"]);
      await runGit(tmp, ["config", "user.name", "Test User"]);
      await runGit(tmp, ["config", "commit.gpgsign", "false"]);
      await writeFile(join(tmp, "seed.txt"), "seed\n");
      await mkdir(join(tmp, "foo"));
      await writeFile(join(tmp, "foo", "seed.txt"), "foo seed\n");
      await runGit(tmp, ["add", "seed.txt", "foo/seed.txt"]);
      await runGit(tmp, ["commit", "-m", "seed"]);

      // CONTROL patch: same shape (new-file creation under foo/, no
      // index line, simple hunk), but SAFE path (no `..`). Validates
      // that the patch FORMAT is acceptable to git. UNGUARDED — if git
      // rejects this, the test throws immediately with git's error,
      // surfacing the format bug instead of silently passing the
      // dotdot probe for the wrong reason.
      const safePatchPath = join(tmp, "safe.patch");
      const safePatchContent =
        "diff --git a/foo/safe-created.txt b/foo/safe-created.txt\n" +
        "new file mode 100644\n" +
        "--- /dev/null\n" +
        "+++ b/foo/safe-created.txt\n" +
        "@@ -0,0 +1 @@\n" +
        "+hello\n";
      await writeFile(safePatchPath, safePatchContent);
      await execFileAsync("git", ["apply", "--check", safePatchPath], {
        cwd: tmp,
        windowsHide: true,
      });

      // PROBE patch: identical shape, but with the `..` segment. The
      // ONLY difference between this and the control is the `..` path,
      // so any rejection is genuinely about git's `..` policy.
      const patchPath = join(tmp, "dotdot.patch");
      const patchContent =
        "diff --git a/foo/../.viberevert/x b/foo/../.viberevert/x\n" +
        "new file mode 100644\n" +
        "--- /dev/null\n" +
        "+++ b/foo/../.viberevert/x\n" +
        "@@ -0,0 +1 @@\n" +
        "+hello\n";
      await writeFile(patchPath, patchContent);

      // Probe git's behavior. `git apply --check` returns 0 iff the
      // patch would apply cleanly. Any non-zero exit is rejection.
      let gitAccepts = false;
      try {
        await execFileAsync("git", ["apply", "--check", patchPath], {
          cwd: tmp,
          windowsHide: true,
        });
        gitAccepts = true;
      } catch {
        gitAccepts = false;
      }

      if (gitAccepts) {
        // SECURITY GAP path: git accepts `..`-targeting paths, and the
        // scanner doesn't catch the corresponding `--- a/foo/../...`
        // header. If the assertion below fails, the policy module
        // needs a normalization step OR a real path parser BEFORE the
        // regex test in patchHeaderTargetsVibeRevertInternalPath. See
        // restore-internal-path-policy.ts.
        const headerLine = "--- a/foo/../.viberevert/x";
        expect(
          patchHeaderTargetsVibeRevertInternalPath(headerLine),
          "SECURITY GAP: git apply now accepts `..`-targeting paths but the " +
            "patch-header scanner does not catch them. The policy module needs " +
            "either a `..`-resolution normalization step (path.posix.normalize) " +
            "or a real Git path parser. See restore-internal-path-policy.ts.",
        ).toBe(true);
      } else {
        // EXPECTED branch on modern git: git rejects the patch. Scanner
        // is safe by virtue of git's pre-apply validation. If a future
        // git version changes this behavior, the upper branch fires.
        // The control patch above confirmed the format is valid, so
        // this rejection IS about the `..` segment.
        expect(gitAccepts).toBe(false);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
