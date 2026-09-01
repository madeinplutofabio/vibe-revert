// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Producer -> planner contract tests (M 0.8.0 step 10A, section C).
//
// These run the REAL captureContribution and feed its output straight into
// planSelectiveRestore:
//
//     captureContribution -> buildContributionFile -> planSelectiveRestore
//
// Deliberately separate from restore-selective.test.ts, whose 27 cases use
// hand-built contributions so a failure there is attributable to the PLANNER. A
// failure HERE with that file green means the capture/restore contract drifted,
// not that the planner is wrong.
//
// Only three tests, each proving an assumption the planner is built on that the
// hand-built matrix cannot prove:
//
//   1. real captured rename semantics feed the OLD/NEW physical model;
//   2. real capture preserves mixed worktree/index axes without normalizing
//      them away;
//   3. real capture omits git-unrepresented directories, so the planner must
//      derive topology support from what capture actually emits.
//
// They pay the real checkpoint-oracle cost on purpose. Using a cheaper fake
// capture path would defeat the only thing this file exists to check.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SessionContributionFile } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { createCheckpoint } from "../src/checkpoint.js";
import { buildContributionFile, captureContribution } from "../src/contribution.js";
import { planSelectiveRestore } from "../src/restore-selective.js";

const execFileAsync = promisify(execFile);

const SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const ENDED_AT = "2026-05-04T11:00:00Z";

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  readonly checkpointDir: string;
  readonly cleanup: () => Promise<void>;
}

/** Same shape as contribution.test.ts: checkpointDir lives outside the repo. */
async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-capturefixture-"));
  const repoRoot = join(tmp, "repo");
  const checkpointDir = join(tmp, "checkpoint");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  return { repoRoot, checkpointDir, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

async function write(repo: TestRepo, rel: string, content: string): Promise<void> {
  const abs = join(repo.repoRoot, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

async function checkpoint(repo: TestRepo): Promise<void> {
  await mkdir(repo.checkpointDir, { recursive: true });
  await createCheckpoint({
    repoRoot: repo.repoRoot,
    checkpointDir: repo.checkpointDir,
    rollbackExcludePatterns: [],
    sessionId: SESSION_ID,
  });
}

/**
 * The real producer, end to end. Objects are collected rather than stored,
 * because selective restore never dereferences them -- the oracle is the
 * restoration source.
 */
async function captureRealContribution(repo: TestRepo): Promise<SessionContributionFile> {
  const { value } = await captureContribution<SessionContributionFile>(
    repo.repoRoot,
    repo.checkpointDir,
    {
      sessionId: SESSION_ID,
      checkpointId: CHECKPOINT_ID,
      additionalObservationPaths: [],
      storeObject: async () => {
        /* selective restore does not consume the object store */
      },
      publish: async (capture) => buildContributionFile(capture, { endedAt: ENDED_AT }),
    },
  );
  return value;
}

const allGroups = (contribution: SessionContributionFile): readonly string[] => [
  ...new Set(contribution.entries.map((e) => e.change_group_id)),
];

// =============================================================================

/**
 * Per-test budget for genuinely heavy integration work.
 *
 * Each case below performs real repository setup, a commit, a full checkpoint,
 * oracle worktree materialization, and a complete contribution capture. These
 * operations legitimately run close to the package-wide timeout and can cross
 * it under parallel workspace contention.
 *
 * Keep the exception local to these integration cases rather than increasing
 * the package-wide timeout for ordinary tests.
 */
describe("captureContribution -> planSelectiveRestore contract", { timeout: 20_000 }, () => {
  it("1: a real captured rename feeds the OLD/NEW physical model", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "old.ts", "hook\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "seed"]);
      await checkpoint(repo);

      // A genuine accepted rename, at the repo root so no directory topology
      // is involved -- test 3 covers that separately.
      await git(repo.repoRoot, ["mv", "old.ts", "new.ts"]);

      const contribution = await captureRealContribution(repo);

      // The producer semantics the planner's physical model depends on.
      const renamed = contribution.entries.filter((e) => e.operation === "renamed");
      expect(renamed).toHaveLength(1);
      expect(renamed[0]?.path).toBe("new.ts");
      expect(renamed[0]?.previous_path).toBe("old.ts");
      // entry.before is the state of previous_path; entry.after is the state of
      // path. Two DIFFERENT physical paths -- the whole reason for §4.
      expect(renamed[0]?.before.worktree.kind).toBe("regular");
      expect(renamed[0]?.after.worktree.kind).toBe("regular");

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: allGroups(contribution),
      });

      // BOTH endpoints are planned: recreate OLD, remove NEW. A one-candidate
      // model would restore only one of them and silently keep the rename.
      expect(plan.outcome).toBe("eligible");
      expect(plan.operations.map((o) => o.path).sort()).toEqual(["new.ts", "old.ts"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("2: real capture preserves MIXED worktree/index axes", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a/b", "child\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "seed"]);
      await checkpoint(repo);

      // Session replaces the directory with a regular file at `a`, leaving the
      // index entry for `a/b` in place. Probed as representable: git reports
      // " D a/b" / "?? a".
      await rm(join(repo.repoRoot, "a"), { recursive: true, force: true });
      await write(repo, "a", "now a file\n");

      const contribution = await captureRealContribution(repo);

      // The point: capture must NOT normalize the axes together. `a/b` has no
      // worktree node but still occupies the index.
      const child = contribution.entries.find((e) => e.path === "a/b");
      expect(child?.after.worktree.kind).toBe("absent");
      expect(child?.after.index.kind).toBe("entry");

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: allGroups(contribution),
      });

      // C1's per-axis rule must not refuse this coherent state. A full
      // ABSENT_PATH_STATE comparison would have.
      expect(plan.conflicts.filter((c) => c.path === "a/b")).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("3: real capture omits git-unrepresented directories, so the planner derives them", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "foo/bar.txt", "content\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "seed"]);
      await checkpoint(repo);

      // Session deletes the file AND its now-empty parent directory.
      await rm(join(repo.repoRoot, "foo"), { recursive: true, force: true });

      const contribution = await captureRealContribution(repo);

      // Git tracks files, never directories: capture emits an entry for the
      // file and NONE for its parent. That absence is what makes synthetic
      // parents necessary rather than a hand-built-fixture artifact.
      expect(contribution.entries.map((e) => e.path)).toContain("foo/bar.txt");
      expect(contribution.entries.map((e) => e.path)).not.toContain("foo");

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: allGroups(contribution),
      });

      expect(plan.outcome).toBe("eligible");
      const parent = plan.operations.find((o) => o.kind === "create_parent_directory");
      expect(parent?.path).toBe("foo");
      expect(parent?.kind === "create_parent_directory" && parent.requiredBy).toEqual([
        "foo/bar.txt",
      ]);
    } finally {
      await repo.cleanup();
    }
  });
});
