// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the final fence (M 0.8.0 step 10E, §10).
//
// Five sections:
//   A. the stable path            (1)
//   B. domain drift               (2-5)
//   C. HEAD continuity            (6-7)
//   D. failures propagate         (8-9)
//   E. source invariants          (10)
//
// The repository is REAL, because the fence's whole contract is that it observes
// reality itself rather than being handed an observation. Every drift case
// therefore mutates the repository AFTER `S` is captured and passes the fence
// nothing but the frozen baseline: if the fence trusted its caller instead of
// re-capturing, every one of those cases would return `stable`.
//
// Plans are hand-built typed literals, following protected-domain.test.ts. The
// planner is proven in restore-selective.test.ts; here a plan is INPUT, and the
// only property the fence needs from it is which paths and watches `S` covers.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import {
  type FinalFenceDifference,
  type FinalProtectedDomainFenceResult,
  finalProtectedDomainFence,
} from "../src/final-fence.js";
import { getHeadSha } from "../src/git-cli.js";
import { observePathState, readIndexSnapshot } from "../src/path-state.js";
import {
  captureProtectedDomain,
  type ProtectedDomainDifference,
  type ProtectedDomainSnapshot,
} from "../src/protected-domain.js";
import {
  ABSENT_PATH_STATE,
  type SelectiveRestoreClassification,
  type SelectiveRestoreOperation,
  type SelectiveRestorePlan,
} from "../src/restore-selective.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Fixtures
// =============================================================================

const GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000001";

/** Never a real HEAD. Used only where the throw precedes any comparison. */
const UNUSED_HEAD = "0".repeat(40);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Deliberately leaves the repository UNBORN. Cases commit explicitly, so case 9
 * can exercise a repository that has no HEAD at all without a second fixture.
 */
async function setupRepo(gitignore = ".viberevert/\n"): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-fencefixture-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), gitignore);
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  return { repoRoot, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

async function write(repo: TestRepo, rel: string, content: string): Promise<void> {
  const abs = join(repo.repoRoot, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const remove = (repo: TestRepo, rel: string): Promise<void> =>
  rm(join(repo.repoRoot, ...rel.split("/")));

async function commitAll(repo: TestRepo, message: string): Promise<void> {
  await git(repo.repoRoot, ["add", "-A"]);
  await git(repo.repoRoot, ["commit", "-m", message]);
}

async function currentState(repoRoot: string, path: string): Promise<PathState> {
  const index = await readIndexSnapshot(repoRoot);
  return (await observePathState(repoRoot, path, index)).state;
}

// ---- Plan construction ------------------------------------------------------

function classificationAt(
  path: string,
  observed: PathState,
  expectedBefore: PathState,
): SelectiveRestoreClassification {
  return {
    path,
    changeGroupId: GROUP,
    expectedBefore,
    expectedAfter: observed,
    observed,
    outcome: { kind: "planned", disposition: "restore_required" },
  };
}

function restoreOp(
  path: string,
  observed: PathState,
  target: PathState,
): SelectiveRestoreOperation {
  return { kind: "restore_candidate", path, changeGroupId: GROUP, target, observed };
}

function eligiblePlan(parts: {
  classifications?: readonly SelectiveRestoreClassification[];
  operations?: readonly SelectiveRestoreOperation[];
}): SelectiveRestorePlan {
  return {
    outcome: "eligible",
    capabilities: { symlinkCheckout: true },
    selectedChangeGroupIds: [GROUP],
    classifications: parts.classifications ?? [],
    topologyDependencyPaths: [],
    operations: parts.operations ?? [],
    conflicts: [],
  };
}

/**
 * One `restore_candidate` removing `src/a.ts`.
 *
 * The target's worktree differs from the observed one, so the operation affects
 * the worktree and `src` acquires an IMMEDIATE topology watch. That watch is
 * what case 5 needs; nothing else about the plan matters to the fence.
 */
async function planForSrcA(repo: TestRepo): Promise<SelectiveRestorePlan> {
  const observed = await currentState(repo.repoRoot, "src/a.ts");
  return eligiblePlan({
    classifications: [classificationAt("src/a.ts", observed, ABSENT_PATH_STATE)],
    operations: [restoreOp("src/a.ts", observed, ABSENT_PATH_STATE)],
  });
}

// ---- Invoking the fence -----------------------------------------------------

const captureS = (repo: TestRepo, plan: SelectiveRestorePlan): Promise<ProtectedDomainSnapshot> =>
  captureProtectedDomain({ repoRoot: repo.repoRoot, plan, rollbackExcludePatterns: [] });

const fence = (
  repo: TestRepo,
  plan: SelectiveRestorePlan,
  frozenSnapshot: ProtectedDomainSnapshot,
  expectedHeadSha: string,
): Promise<FinalProtectedDomainFenceResult> =>
  finalProtectedDomainFence({
    repoRoot: repo.repoRoot,
    plan,
    rollbackExcludePatterns: [],
    frozenSnapshot,
    expectedHeadSha,
  });

function differencesOf(result: FinalProtectedDomainFenceResult): readonly FinalFenceDifference[] {
  if (result.outcome !== "precondition_changed") {
    throw new Error(`expected precondition_changed, received ${result.outcome}`);
  }
  return result.differences;
}

function domainDifferenceOf(
  differences: readonly FinalFenceDifference[],
): ProtectedDomainDifference {
  const found = differences.find(
    (d): d is Extract<FinalFenceDifference, { kind: "protected_domain" }> =>
      d.kind === "protected_domain",
  );
  if (found === undefined) throw new Error("no protected_domain difference was reported");
  return found.difference;
}

// =============================================================================
// Section A: the stable path
// =============================================================================

describe("finalProtectedDomainFence: stable", () => {
  it("1: an untouched repository at the expected HEAD is stable", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      await commitAll(repo, "initial");
      const plan = await planForSrcA(repo);
      const snapshot = await captureS(repo, plan);
      const head = await getHeadSha(repo.repoRoot);

      // toEqual, not a property check: `stable` carries nothing else, and a
      // future field smuggled onto the success case should fail here.
      expect(await fence(repo, plan, snapshot, head)).toEqual({ outcome: "stable" });
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section B: domain drift
// =============================================================================

describe("finalProtectedDomainFence: domain drift", () => {
  it("2: an unselected protected file edited after S is refused", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      await write(repo, "src/other.ts", "other\n");
      await commitAll(repo, "initial");
      const plan = await planForSrcA(repo);
      const snapshot = await captureS(repo, plan);
      const head = await getHeadSha(repo.repoRoot);

      // The fence is handed ONLY the frozen baseline. It finds this on its own.
      await write(repo, "src/other.ts", "edited\n");

      const differences = differencesOf(await fence(repo, plan, snapshot, head));
      expect(differences).toHaveLength(1);
      const difference = domainDifferenceOf(differences);
      expect(difference.changedPaths).toEqual(["src/other.ts"]);
      expect(difference.addedPaths).toEqual([]);
      expect(difference.removedPaths).toEqual([]);
      // Content changed; membership did not.
      expect(difference.topologyWatchDifferences).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("3: a protected path appearing after S is refused", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      await commitAll(repo, "initial");
      const plan = await planForSrcA(repo);
      const snapshot = await captureS(repo, plan);
      const head = await getHeadSha(repo.repoRoot);

      // Outside the watched `src`, so this isolates the membership direction
      // `addedPaths` from any topology-watch effect.
      await write(repo, "docs/new.ts", "new\n");

      const difference = domainDifferenceOf(differencesOf(await fence(repo, plan, snapshot, head)));
      expect(difference.addedPaths).toEqual(["docs/new.ts"]);
      expect(difference.removedPaths).toEqual([]);
      expect(difference.changedPaths).toEqual([]);
      expect(difference.topologyWatchDifferences).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("4: a protected path vanishing after S is refused", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      await commitAll(repo, "initial");
      // Untracked and unignored, so it is a `states` member that can genuinely
      // LEAVE the protected set. Deleting a TRACKED file would keep its index
      // entry and report as `changedPaths`, which is a different direction.
      await write(repo, "docs/scratch.txt", "scratch\n");
      const plan = await planForSrcA(repo);
      const snapshot = await captureS(repo, plan);
      const head = await getHeadSha(repo.repoRoot);

      await remove(repo, "docs/scratch.txt");

      const difference = domainDifferenceOf(differencesOf(await fence(repo, plan, snapshot, head)));
      expect(difference.removedPaths).toEqual(["docs/scratch.txt"]);
      expect(difference.addedPaths).toEqual([]);
      expect(difference.changedPaths).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("5: a GITIGNORED file appearing in a watched parent is refused", async () => {
    const repo = await setupRepo(".viberevert/\n*.log\n");
    try {
      await write(repo, "src/a.ts", "a\n");
      await commitAll(repo, "initial");
      const plan = await planForSrcA(repo);
      const snapshot = await captureS(repo, plan);
      const head = await getHeadSha(repo.repoRoot);

      // The case that pins the WHOLE-DOMAIN comparator. An ignored file is not
      // a `states` member, so every state map is identical and
      // `compareProtectedStateMaps` would report nothing. Only the raw topology
      // watch on `src` sees it. Substituting the recovery path's state-only
      // comparator returns `stable` here and fails this test alone.
      await write(repo, "src/debug.log", "noise\n");

      const difference = domainDifferenceOf(differencesOf(await fence(repo, plan, snapshot, head)));
      expect(difference.addedPaths).toEqual([]);
      expect(difference.removedPaths).toEqual([]);
      expect(difference.changedPaths).toEqual([]);
      expect(difference.topologyWatchDifferences).toHaveLength(1);
      expect(difference.topologyWatchDifferences[0]).toEqual({
        path: "src",
        reason: "membership_changed",
        addedMembers: ["src/debug.log"],
        removedMembers: [],
        changedMembers: [],
      });
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section C: HEAD continuity
// =============================================================================

describe("finalProtectedDomainFence: HEAD continuity", () => {
  it("6: a commit that leaves the domain identical is still refused", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      await commitAll(repo, "initial");
      // Stage a change, so committing it moves HEAD while leaving the index
      // entry's mode and oid and the worktree bytes exactly as captured.
      await write(repo, "src/a.ts", "edited\n");
      await git(repo.repoRoot, ["add", "src/a.ts"]);

      const plan = await planForSrcA(repo);
      const snapshot = await captureS(repo, plan);
      const head = await getHeadSha(repo.repoRoot);

      await git(repo.repoRoot, ["commit", "-m", "two"]);
      const moved = await getHeadSha(repo.repoRoot);
      expect(moved).not.toBe(head);

      // The whole reason this module exists beyond the domain comparator: the
      // protected domain is byte-for-byte unchanged and this must still refuse.
      const differences = differencesOf(await fence(repo, plan, snapshot, head));
      expect(differences).toEqual([
        { kind: "head_moved", expectedHeadSha: head, observedHeadSha: moved },
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it("7: domain drift and HEAD movement are BOTH reported, in fixed order", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      await commitAll(repo, "initial");
      await write(repo, "src/a.ts", "edited\n");
      await git(repo.repoRoot, ["add", "src/a.ts"]);

      const plan = await planForSrcA(repo);
      const snapshot = await captureS(repo, plan);
      const head = await getHeadSha(repo.repoRoot);

      // Untracked, so `git commit` does not sweep it into the commit.
      await write(repo, "docs/new.ts", "new\n");
      await git(repo.repoRoot, ["commit", "-m", "two"]);

      const differences = differencesOf(await fence(repo, plan, snapshot, head));
      // Not short-circuited after the first, and deterministically ordered.
      expect(differences.map((d) => d.kind)).toEqual(["protected_domain", "head_moved"]);
      expect(domainDifferenceOf(differences).addedPaths).toEqual(["docs/new.ts"]);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section D: failures propagate
// =============================================================================
//
// A failure is not a mismatch. Both cases below would be far more damaging as a
// `precondition_changed` result: that tells an operator the repository moved,
// when the truth is that we never managed to observe it.

describe("finalProtectedDomainFence: failures propagate", () => {
  it("8: a non-eligible plan throws rather than refusing", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      await commitAll(repo, "initial");
      const eligible = await planForSrcA(repo);
      const snapshot = await captureS(repo, eligible);
      const head = await getHeadSha(repo.repoRoot);

      const noop: SelectiveRestorePlan = {
        outcome: "noop",
        capabilities: { symlinkCheckout: true },
        selectedChangeGroupIds: [GROUP],
        classifications: [],
        topologyDependencyPaths: [],
        operations: [],
        conflicts: [],
      };

      await expect(fence(repo, noop, snapshot, head)).rejects.toThrow(/requires an eligible plan/);
    } finally {
      await repo.cleanup();
    }
  });

  it("9: an unborn HEAD throws, AFTER the domain capture has succeeded", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      // No commit: the repository has no HEAD at all.
      const plan = await planForSrcA(repo);

      // The capture itself succeeds on an unborn repository, so this also
      // demonstrates the ordering: the domain is observed, and only then does
      // reading HEAD fail.
      const snapshot = await captureS(repo, plan);
      expect(snapshot.states.has("src/a.ts")).toBe(true);

      await expect(fence(repo, plan, snapshot, UNUSED_HEAD)).rejects.toThrow();
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section E: source invariants
// =============================================================================
//
// Two properties no runtime test in this file can reach. Forcing a commit to
// land midway through the capture pass would need an injection seam the module
// deliberately does not have, and an absent import cannot be observed by calling
// the function.

describe("source invariants", () => {
  it("10: the domain is captured before HEAD, with no mutation import or barrel export", async () => {
    const source = await readFile(new URL("../src/final-fence.ts", import.meta.url), "utf8");

    const captureAt = source.indexOf("await captureProtectedDomain(");
    const headAt = source.indexOf("await getHeadSha(");
    expect(captureAt).toBeGreaterThan(-1);
    expect(headAt).toBeGreaterThan(-1);
    // Reading HEAD first would let a commit landing during the repository-scale
    // capture pass through, precisely because it changes neither PathState axis.
    expect(captureAt).toBeLessThan(headAt);

    // Matched as IMPORTS, not as text: the module's own header names both files
    // in prose, so a `toContain` check here would assert against documentation
    // rather than against a dependency.
    //
    // This fence remains read-only and does not acquire either mutation
    // primitive. The existing 10C#36 and 10D#20 source invariants continue to
    // prove that the mutation modules have zero production callers anywhere
    // until 10F; that global claim is theirs, not this test's.
    expect(source).not.toMatch(/from\s+["']\.\/worktree-materialize\.js["']/);
    expect(source).not.toMatch(/from\s+["']\.\/index-transplant\.js["']/);

    const barrel = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(barrel).not.toContain("final-fence");
  });
});
