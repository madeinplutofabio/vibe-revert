// packages/git/test/find-checkpoint-by-name.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// findCheckpointByName — A.4 targeted tests.
//
// Verifies the D5b name-resolution + D56 name-lookup contract:
//   - returns null on no match (NOT throws);
//   - returns absolute path on unique match;
//   - throws on duplicate names (state-drift signal);
//   - inherits listCheckpoints safety guards (.tmp-* siblings ignored).
//
// Helper mimics the CLI's D17b temp+rename flow: write into a
// .tmp-checkpoint-<n> dir under .viberevert/checkpoints/, then rename to
// the final cp_<id> name. createCheckpoint does NOT enforce D5b name
// uniqueness (that's a CLI invariant), so this helper can be called twice
// with the same name to set up the duplicate scenario.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createCheckpoint, findCheckpointByName, loadCheckpoint } from "../src/checkpoint.js";

// =============================================================================
// Test helpers
// =============================================================================

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-findtest-"));
  const repoRoot = join(tmp, "repo");
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
  return {
    repoRoot,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

// Monotonic per-process counter so back-to-back makeCheckpoint calls within
// a single test never collide on the temp-dir basename.
let tempCounter = 0;

async function makeCheckpoint(
  repoRoot: string,
  opts: { name?: string } = {},
): Promise<{ id: string; absPath: string }> {
  const checkpointsBase = join(repoRoot, ".viberevert", "checkpoints");
  await mkdir(checkpointsBase, { recursive: true });
  tempCounter += 1;
  const tempName = `.tmp-checkpoint-${tempCounter.toString(36)}-${Date.now().toString(36)}`;
  const tempDir = join(checkpointsBase, tempName);
  await mkdir(tempDir);
  const { checkpointId } = await createCheckpoint({
    repoRoot,
    checkpointDir: tempDir,
    rollbackExcludePatterns: [],
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  });
  const finalDir = join(checkpointsBase, checkpointId);
  await rename(tempDir, finalDir);
  return { id: checkpointId, absPath: finalDir };
}

// =============================================================================
// Tests
// =============================================================================

describe("findCheckpointByName", () => {
  describe("returns null on no match", () => {
    it("when checkpoints dir does not exist (fresh repo)", async () => {
      const repo = await setupRepo();
      try {
        const result = await findCheckpointByName(repo.repoRoot, "anything");
        expect(result).toBeNull();
      } finally {
        await repo.cleanup();
      }
    });

    it("when checkpoints dir exists but contains zero checkpoints", async () => {
      const repo = await setupRepo();
      try {
        await mkdir(join(repo.repoRoot, ".viberevert", "checkpoints"), { recursive: true });
        const result = await findCheckpointByName(repo.repoRoot, "anything");
        expect(result).toBeNull();
      } finally {
        await repo.cleanup();
      }
    });

    it("when populated repo has no matching name", async () => {
      const repo = await setupRepo();
      try {
        await makeCheckpoint(repo.repoRoot, { name: "alpha" });
        await makeCheckpoint(repo.repoRoot, { name: "beta" });
        await makeCheckpoint(repo.repoRoot); // unnamed
        const result = await findCheckpointByName(repo.repoRoot, "missing");
        expect(result).toBeNull();
      } finally {
        await repo.cleanup();
      }
    });

    it("does not match unnamed checkpoints (name: null) against empty-string query", async () => {
      const repo = await setupRepo();
      try {
        await makeCheckpoint(repo.repoRoot); // unnamed → name: null in summary
        const result = await findCheckpointByName(repo.repoRoot, "");
        expect(result).toBeNull();
      } finally {
        await repo.cleanup();
      }
    });
  });

  describe("returns absolute path on unique match", () => {
    it("returns the absolute checkpoint dir path", async () => {
      const repo = await setupRepo();
      try {
        const cp = await makeCheckpoint(repo.repoRoot, { name: "baseline" });
        const result = await findCheckpointByName(repo.repoRoot, "baseline");
        expect(result).toBe(cp.absPath);
        if (result === null) throw new Error("unreachable: already asserted equality above");
        expect(isAbsolute(result)).toBe(true);
      } finally {
        await repo.cleanup();
      }
    });

    it("returned path is loadable via loadCheckpoint (round-trip)", async () => {
      const repo = await setupRepo();
      try {
        const cp = await makeCheckpoint(repo.repoRoot, { name: "round-trip" });
        const result = await findCheckpointByName(repo.repoRoot, "round-trip");
        expect(result).toBe(cp.absPath);
        if (result === null) throw new Error("unreachable: already asserted equality above");
        const manifest = await loadCheckpoint(result);
        expect(manifest.name).toBe("round-trip");
        expect(manifest.session_id).toBe(cp.id);
      } finally {
        await repo.cleanup();
      }
    });

    it("finds the right checkpoint when multiple distinct names coexist", async () => {
      const repo = await setupRepo();
      try {
        const alpha = await makeCheckpoint(repo.repoRoot, { name: "alpha" });
        const beta = await makeCheckpoint(repo.repoRoot, { name: "beta" });
        const gamma = await makeCheckpoint(repo.repoRoot, { name: "gamma" });
        expect(await findCheckpointByName(repo.repoRoot, "alpha")).toBe(alpha.absPath);
        expect(await findCheckpointByName(repo.repoRoot, "beta")).toBe(beta.absPath);
        expect(await findCheckpointByName(repo.repoRoot, "gamma")).toBe(gamma.absPath);
      } finally {
        await repo.cleanup();
      }
    });

    it("ignores .tmp-* siblings at iteration time (inherits listCheckpoints D13 guard)", async () => {
      const repo = await setupRepo();
      try {
        const cp = await makeCheckpoint(repo.repoRoot, { name: "stable" });
        // Stale .tmp- dir alongside a valid match. listCheckpoints filters
        // it out (D13 skip rule), which findCheckpointByName inherits via
        // delegation — the valid match still wins.
        const stalePath = join(
          repo.repoRoot,
          ".viberevert",
          "checkpoints",
          ".tmp-checkpoint-stale",
        );
        await mkdir(stalePath);
        const result = await findCheckpointByName(repo.repoRoot, "stable");
        expect(result).toBe(cp.absPath);
      } finally {
        await repo.cleanup();
      }
    });
  });

  describe("throws on duplicate names (D5b invariant violation)", () => {
    it("throws Error mentioning both colliding ids", async () => {
      const repo = await setupRepo();
      try {
        const a = await makeCheckpoint(repo.repoRoot, { name: "duplicate" });
        const b = await makeCheckpoint(repo.repoRoot, { name: "duplicate" });
        let caught: unknown;
        try {
          await findCheckpointByName(repo.repoRoot, "duplicate");
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        const msg = (caught as Error).message;
        expect(msg).toContain("duplicate");
        expect(msg).toContain(a.id);
        expect(msg).toContain(b.id);
        expect(msg).toContain("D5b");
      } finally {
        await repo.cleanup();
      }
    });

    it("throws even when many other distinct-named checkpoints coexist", async () => {
      const repo = await setupRepo();
      try {
        await makeCheckpoint(repo.repoRoot, { name: "alpha" });
        await makeCheckpoint(repo.repoRoot, { name: "beta" });
        const dup1 = await makeCheckpoint(repo.repoRoot, { name: "shared" });
        const dup2 = await makeCheckpoint(repo.repoRoot, { name: "shared" });
        await makeCheckpoint(repo.repoRoot, { name: "gamma" });
        // Distinct-named searches still work — duplicate-detection is per-
        // name, not a global poison.
        expect(await findCheckpointByName(repo.repoRoot, "alpha")).not.toBeNull();
        expect(await findCheckpointByName(repo.repoRoot, "gamma")).not.toBeNull();
        let caught: unknown;
        try {
          await findCheckpointByName(repo.repoRoot, "shared");
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        const msg = (caught as Error).message;
        expect(msg).toContain(dup1.id);
        expect(msg).toContain(dup2.id);
      } finally {
        await repo.cleanup();
      }
    });
  });
});
