// packages/git/test/checkpoint-oracle.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.8.0 step 2 -- the extracted checkpoint oracle.
//
// Most of the oracle's behavior is already covered transitively: every
// getDiffSinceCheckpoint integration test and all nine golden-report fixtures
// run through it. This file exists for the one property nothing else can catch.
//
// The prepareTempRoot hook MUST run before `git worktree add`. That position is
// pure failure-path semantics: if scratch preparation fails today, no worktree
// exists and cleanup only removes the scratch root, whereas after a worktree
// add the same failure engages `worktree remove` and possibly `worktree prune`.
// The successful path is identical either way, so the goldens are blind to it
// and a future edit could move the hook with every existing test staying green.
//
// It is observable without mocking, because the hook can inspect its own world:
// inside prepareTempRoot the worktree directory must not exist yet, and inside
// run it must.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createCheckpoint } from "../src/checkpoint.js";
import { withCheckpointOracle } from "../src/checkpoint-oracle.js";

// =============================================================================
// Test helpers
// =============================================================================

const execFileAsync = promisify(execFile);

/**
 * Scratch prefix for these tests. Deliberately NOT `viberevert-diff-`, which
 * diff.test.ts snapshots by name in its cleanup-proof helpers.
 */
const PREFIX = "viberevert-oracletest-";

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepoWithCheckpoint {
  readonly repoRoot: string;
  readonly checkpointDir: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Temp git repo + a checkpoint captured at the current state. checkpointDir
 * lives OUTSIDE the repo so it does not pollute enumeration, matching the
 * convention in diff.test.ts and restore.test.ts.
 *
 * Deliberately duplicated rather than shared with diff.test.ts: extracting a
 * common helper would edit existing tests, which is scope a behavior-neutral
 * refactor should not take on.
 */
async function setupRepoWithCheckpoint(): Promise<TestRepoWithCheckpoint> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-oraclefixture-"));
  const repoRoot = join(tmp, "repo");
  const checkpointDir = join(tmp, "checkpoint");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await runGit(repoRoot, ["add", ".gitignore", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  await mkdir(checkpointDir, { recursive: true });
  await createCheckpoint({ repoRoot, checkpointDir, rollbackExcludePatterns: [] });
  return {
    repoRoot,
    checkpointDir,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** How many worktrees git currently knows about for this repo. */
async function worktreeCount(repoRoot: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    windowsHide: true,
  });
  return stdout.split("\n").filter((l) => l.startsWith("worktree ")).length;
}

// =============================================================================
// The ordering invariant
// =============================================================================

describe("prepareTempRoot ordering", () => {
  it("runs BEFORE the worktree exists, and run() runs after", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      let prepared = false;
      let worktreeDuringPrepare: boolean | undefined;
      let worktreeDuringRun: boolean | undefined;

      await withCheckpointOracle(repo.repoRoot, repo.checkpointDir, {
        tempDirPrefix: PREFIX,
        prepareTempRoot: async (tempRoot) => {
          prepared = true;
          worktreeDuringPrepare = existsSync(join(tempRoot, "worktree"));
        },
        run: async ({ tempRoot }) => {
          worktreeDuringRun = existsSync(join(tempRoot, "worktree"));
          return null;
        },
      });

      // Guards vacuity: without this, a hook that was never invoked would leave
      // the observation undefined and the failure would be hard to read.
      expect(prepared, "prepareTempRoot must be invoked").toBe(true);

      // The pair is the point. The `true` half proves the worktree really does
      // get created, so the `false` half is about ORDERING rather than about
      // the worktree never existing at all.
      expect(worktreeDuringPrepare, "worktree must NOT exist during prepare").toBe(false);
      expect(worktreeDuringRun, "worktree MUST exist during run").toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("is optional", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      const result = await withCheckpointOracle(repo.repoRoot, repo.checkpointDir, {
        tempDirPrefix: PREFIX,
        run: async () => "ok",
      });
      expect(result.value).toBe("ok");
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Context handed to the consumer
// =============================================================================

describe("oracle context", () => {
  it("honors the caller's tempDirPrefix", async () => {
    // Load-bearing beyond tidiness: the prefix appears verbatim in cleanup
    // warnings, so a shared or ignored prefix would mislabel which consumer's
    // scratch state failed to clean up.
    const repo = await setupRepoWithCheckpoint();
    try {
      let seen = "";
      await withCheckpointOracle(repo.repoRoot, repo.checkpointDir, {
        tempDirPrefix: PREFIX,
        run: async ({ tempRoot }) => {
          seen = basename(tempRoot);
          return null;
        },
      });
      expect(seen.startsWith(PREFIX)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("hands over the loaded manifest and a populated worktree", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repo.repoRoot,
        windowsHide: true,
      });
      const headSha = stdout.trim();

      await withCheckpointOracle(repo.repoRoot, repo.checkpointDir, {
        tempDirPrefix: PREFIX,
        run: async ({ manifest, worktreePath }) => {
          expect(manifest.git.head_sha).toBe(headSha);
          expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
          return null;
        },
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("reports no cleanup warnings on a clean run", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      const { cleanupWarnings } = await withCheckpointOracle(repo.repoRoot, repo.checkpointDir, {
        tempDirPrefix: PREFIX,
        run: async () => null,
      });
      expect(cleanupWarnings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Cleanup
// =============================================================================

describe("cleanup", () => {
  it("removes the scratch root and the worktree after success", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      expect(await worktreeCount(repo.repoRoot)).toBe(1);

      let captured = "";
      await withCheckpointOracle(repo.repoRoot, repo.checkpointDir, {
        tempDirPrefix: PREFIX,
        run: async ({ tempRoot }) => {
          captured = tempRoot;
          expect(await worktreeCount(repo.repoRoot)).toBe(2);
          return null;
        },
      });

      expect(captured.length).toBeGreaterThan(0);
      expect(existsSync(captured)).toBe(false);
      expect(await worktreeCount(repo.repoRoot)).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  it("cleans up when run() throws, and propagates the error", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      let captured = "";
      await expect(
        withCheckpointOracle(repo.repoRoot, repo.checkpointDir, {
          tempDirPrefix: PREFIX,
          run: async ({ tempRoot }) => {
            captured = tempRoot;
            throw new Error("run exploded");
          },
        }),
      ).rejects.toThrow("run exploded");

      expect(existsSync(captured)).toBe(false);
      expect(await worktreeCount(repo.repoRoot)).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  it("cleans up when prepareTempRoot throws, and propagates the error", async () => {
    // The failure path whose ordering this step preserved: no worktree has been
    // created yet, so cleanup has only the scratch root to remove.
    const repo = await setupRepoWithCheckpoint();
    try {
      let captured = "";
      let ranRun = false;
      await expect(
        withCheckpointOracle(repo.repoRoot, repo.checkpointDir, {
          tempDirPrefix: PREFIX,
          prepareTempRoot: async (tempRoot) => {
            captured = tempRoot;
            throw new Error("prepare exploded");
          },
          run: async () => {
            ranRun = true;
            return null;
          },
        }),
      ).rejects.toThrow("prepare exploded");

      expect(ranRun, "run must not be reached when prepare throws").toBe(false);
      expect(existsSync(captured)).toBe(false);
      expect(await worktreeCount(repo.repoRoot)).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });
});
