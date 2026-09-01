// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Contract test for the command-neutral D65 emergency checkpoint.
//
// The behaviour of the creation sequence itself is already covered by the
// rollback command's suite, which exercised it before the extraction. This file
// covers the one thing that suite cannot: the correspondence the helper now
// OWNS between the checkpoint's identity and its final directory.
//
// That matters because two consumers read different halves of it. The attempt
// marker records `checkpointId`, while `validateRecoveryHandle` materializes
// `checkpointDir`. If they ever named different checkpoints, the recovery handle
// the operator is told to trust would not be the one that was validated.

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { safeListCheckpoints } from "../src/checkpoint-helpers.js";
import { createEmergencyCheckpoint } from "../src/emergency-checkpoint.js";

const execFileAsync = promisify(execFile);

const SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const NOW = "2026-09-01T00:00:00Z";

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  readonly checkpointsDir: string;
  readonly cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-emergencyfixture-"));
  const repoRoot = join(tmp, "repo");
  const checkpointsDir = join(repoRoot, ".viberevert", "checkpoints");
  await mkdir(checkpointsDir, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n", "utf8");
  await writeFile(join(repoRoot, "a.txt"), "content\n", "utf8");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  return { repoRoot, checkpointsDir, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

describe("createEmergencyCheckpoint", () => {
  it("1: returns the FINAL cp_<id> directory, matching the id it reports", async () => {
    const repo = await setupRepo();
    try {
      const result = await createEmergencyCheckpoint({
        repoRoot: repo.repoRoot,
        rollbackExcludePatterns: [],
        targetSessionId: SESSION_ID,
        now: NOW,
        invocationCommand: "viberevert rollback --apply",
      });

      // The correspondence this helper exists to own: one recovery handle, two
      // views of it.
      expect(basename(result.checkpointDir)).toBe(result.checkpointId);
      expect(result.checkpointDir).toBe(join(repo.checkpointsDir, result.checkpointId));

      // The rename really happened: not a temp path, and the directory is real.
      expect(result.checkpointDir).not.toContain(".tmp-checkpoint-");
      expect((await lstat(result.checkpointDir)).isDirectory()).toBe(true);

      // A successful run leaves no temp sibling behind.
      const entries = await readdir(repo.checkpointsDir);
      expect(entries.filter((e) => e.startsWith(".tmp-checkpoint-"))).toEqual([]);

      // And the directory is a genuinely published checkpoint, discoverable by
      // the same lister the collision scan uses.
      const listed = await safeListCheckpoints(repo.repoRoot);
      expect(listed.map((c) => c.name)).toEqual([result.name]);

      // The persisted D65 naming rule, pinned because it is stored verbatim in
      // manifest.name and must not drift across CLI versions.
      expect(result.name).toBe("pre-rollback-sess_01JV8Y7W2M7AAB");
    } finally {
      await repo.cleanup();
    }
  });
});
