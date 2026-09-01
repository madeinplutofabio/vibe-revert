// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for recovery-handle validation (M 0.8.0 step 10B, §9 revision 13).
//
// Every case runs the REAL oracle: `validateRecoveryHandle` materializes a real
// checkpoint into a real linked worktree and captures its protected state map
// there. A faked oracle would defeat the only thing this module exists to prove,
// which is that E genuinely reproduces S rather than merely claiming to.
//
// Checkpoint directories live OUTSIDE the repository, so they never become
// untracked content that the protected-domain capture would observe.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import { createCheckpoint } from "../src/checkpoint.js";
import { CheckpointNotFoundError } from "../src/errors.js";
import { getHeadSha } from "../src/git-cli.js";
import {
  captureProtectedStateMap,
  type ProtectedStateDifference,
} from "../src/protected-domain.js";
import { type RecoveryHandleDifference, validateRecoveryHandle } from "../src/recovery-handle.js";
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

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const regularState = (content: string): PathState => ({
  worktree: { kind: "regular", content_ref: sha256(content), executable: false },
  index: { kind: "absent" },
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  /** Parent of every checkpoint directory. Outside the repository on purpose. */
  readonly checkpointRoot: string;
  readonly cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-recoveryfixture-"));
  const repoRoot = join(tmp, "repo");
  const checkpointRoot = join(tmp, "checkpoints");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(checkpointRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  return {
    repoRoot,
    checkpointRoot,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

async function write(repo: TestRepo, rel: string, content: string): Promise<void> {
  const abs = join(repo.repoRoot, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** A real checkpoint in its own empty directory, as createCheckpoint requires. */
async function makeCheckpoint(repo: TestRepo, name: string): Promise<string> {
  const dir = join(repo.checkpointRoot, name);
  await mkdir(dir, { recursive: true });
  await createCheckpoint({
    repoRoot: repo.repoRoot,
    checkpointDir: dir,
    rollbackExcludePatterns: [],
  });
  return dir;
}

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

/**
 * A minimal eligible plan over one path.
 *
 * `observed` is ABSENT_PATH_STATE throughout, because these cases never exercise
 * plan stabilization: the plan exists only to define which paths the protected
 * domain covers, and buckets 1 through 4 are pure plan projections identical on
 * both sides of the comparison. Bucket 5, the managed domain, is what actually
 * differs between S and the oracle, and that is where every case below lands.
 */
function planOver(path: string): SelectiveRestorePlan {
  const target = regularState("historical before state\n");
  return {
    outcome: "eligible",
    capabilities: { symlinkCheckout: true },
    selectedChangeGroupIds: [GROUP],
    classifications: [classificationAt(path, ABSENT_PATH_STATE, target)],
    topologyDependencyPaths: [],
    operations: [restoreOp(path, ABSENT_PATH_STATE, target)],
    conflicts: [],
  };
}

const captureS = (repo: TestRepo, plan: SelectiveRestorePlan) =>
  captureProtectedStateMap({
    repoRoot: repo.repoRoot,
    plan,
    rollbackExcludePatterns: [],
  });

/**
 * `expectedHeadSha` defaults to the repository's CURRENT HEAD.
 *
 * The fixtures below do not move HEAD between creating the checkpoint and
 * validating it, so live HEAD is the checkpoint's HEAD there and the default
 * asserts the identity axis also agrees. The two cases that deliberately move
 * HEAD pass it explicitly.
 */
const validate = async (
  repo: TestRepo,
  checkpointDir: string,
  plan: SelectiveRestorePlan,
  protectedStates: ReadonlyMap<string, PathState>,
  expectedHeadSha?: string,
) =>
  validateRecoveryHandle({
    repoRoot: repo.repoRoot,
    checkpointDir,
    plan,
    rollbackExcludePatterns: [],
    protectedStates,
    expectedHeadSha: expectedHeadSha ?? (await getHeadSha(repo.repoRoot)),
  });

function expectDifferences(
  result: Awaited<ReturnType<typeof validate>>,
): readonly RecoveryHandleDifference[] {
  if (result.outcome !== "mismatch") {
    throw new Error(`expected a mismatch, got ${result.outcome}`);
  }
  return result.differences;
}

/**
 * The sole `protected_states` difference.
 *
 * Asserts no HEAD mismatch accompanied it: these fixtures never move HEAD
 * between the checkpoint and validation, so a `head_mismatch` here would be a
 * real defect rather than expected noise.
 */
function expectMismatch(result: Awaited<ReturnType<typeof validate>>): ProtectedStateDifference {
  const differences = expectDifferences(result);
  expect(differences.map((d) => d.kind)).toEqual(["protected_states"]);
  const first = differences[0];
  if (first === undefined || first.kind !== "protected_states") {
    throw new Error("unreachable: the assertion above pins the shape");
  }
  return first.difference;
}

// =============================================================================
// Section A: E reproduces S, or it does not
// =============================================================================

describe("validateRecoveryHandle", () => {
  it("1: an E captured from the same state as S is valid", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "current\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const plan = planOver("a.txt");
      const protectedStates = await captureS(repo, plan);
      const checkpointDir = await makeCheckpoint(repo, "same-state");

      const result = await validate(repo, checkpointDir, plan, protectedStates);
      expect(result.outcome).toBe("valid");
      // A clean oracle run leaves nothing behind; this is the helper's normal
      // contract, not an artifact of this fixture.
      expect(result.cleanupWarnings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("2: 15a -- worktree content differing from S is a state mismatch", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "the state S recorded\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const plan = planOver("a.txt");
      const protectedStates = await captureS(repo, plan);

      // The world moves between S and E: exactly the window the fence cannot
      // see, because it will observe the repository, not the checkpoint.
      await write(repo, "a.txt", "what E actually captured\n");
      const checkpointDir = await makeCheckpoint(repo, "worktree-drift");

      const difference = expectMismatch(await validate(repo, checkpointDir, plan, protectedStates));
      expect(difference.changedPaths).toEqual(["a.txt"]);
      expect(difference.addedPaths).toEqual([]);
      expect(difference.removedPaths).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("3: 15b -- an INDEX-ONLY difference is still a mismatch", async () => {
    const repo = await setupRepo();
    try {
      // Committed baseline, then staged content S records on the index axis.
      await write(repo, "a.txt", "committed\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "baseline"]);
      await write(repo, "a.txt", "staged and on disk\n");
      await git(repo.repoRoot, ["add", "a.txt"]);

      const plan = planOver("a.txt");
      const protectedStates = await captureS(repo, plan);

      // Unstage only. The worktree bytes never change, so a manifest
      // `file_hashes` comparison would see nothing at all; only the index moved.
      await git(repo.repoRoot, ["reset", "a.txt"]);
      const checkpointDir = await makeCheckpoint(repo, "index-drift");

      const difference = expectMismatch(await validate(repo, checkpointDir, plan, protectedStates));
      expect(difference.changedPaths).toEqual(["a.txt"]);
      expect(difference.addedPaths).toEqual([]);
      expect(difference.removedPaths).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("4: 15c -- a protected untracked path E cannot reproduce is a membership mismatch", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "selected\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await write(repo, "someone-elses-work.txt", "not ignored, not excluded\n");

      const plan = planOver("a.txt");
      const protectedStates = await captureS(repo, plan);
      expect(protectedStates.has("someone-elses-work.txt")).toBe(true);

      // Gone before E exists, so E has no record of it. Recovering through this
      // handle would silently destroy it.
      await rm(join(repo.repoRoot, "someone-elses-work.txt"), { force: true });
      const checkpointDir = await makeCheckpoint(repo, "lost-untracked");

      const difference = expectMismatch(await validate(repo, checkpointDir, plan, protectedStates));
      expect(difference.removedPaths).toEqual(["someone-elses-work.txt"]);
      expect(difference.changedPaths).toEqual([]);
      expect(difference.addedPaths).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("5: all three comparator surfaces stay in their own arrays", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "tracked.txt", "the state S recorded\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await write(repo, "removed-untracked.txt", "present at S\n");

      const plan = planOver("tracked.txt");
      const protectedStates = await captureS(repo, plan);

      // One of each, so `membershipDifferences = added ∪ removed` is trustworthy
      // in BOTH directions. An E carrying an extra managed path is no more an
      // exact recovery handle than one that lost a path.
      await write(repo, "tracked.txt", "changed before E\n");
      await rm(join(repo.repoRoot, "removed-untracked.txt"), { force: true });
      await write(repo, "added-untracked.txt", "only E has this\n");
      const checkpointDir = await makeCheckpoint(repo, "all-three");

      const difference = expectMismatch(await validate(repo, checkpointDir, plan, protectedStates));
      expect(difference.changedPaths).toEqual(["tracked.txt"]);
      expect(difference.removedPaths).toEqual(["removed-untracked.txt"]);
      expect(difference.addedPaths).toEqual(["added-untracked.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("6: 15d -- an internally MIXED checkpoint restores cleanly and still mismatches", async () => {
    const repo = await setupRepo();
    try {
      // Same HEAD, same tracked path, no unstaged changes in either state, so
      // B's staged patch is guaranteed to apply against A's HEAD.
      await write(repo, "p.txt", "committed\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "baseline"]);

      // State A: index and worktree both hold A.
      await write(repo, "p.txt", "state A\n");
      await git(repo.repoRoot, ["add", "p.txt"]);
      const checkpointA = await makeCheckpoint(repo, "A");

      const plan = planOver("p.txt");
      const protectedStates = await captureS(repo, plan);

      // State B: index and worktree both hold B, at the SAME HEAD.
      await write(repo, "p.txt", "state B\n");
      await git(repo.repoRoot, ["add", "p.txt"]);
      const checkpointB = await makeCheckpoint(repo, "B");

      const mixed = await assembleMixedCheckpoint(repo, checkpointA, checkpointB, "E-mixed");

      // The restore sequence makes the outcome deterministic:
      //   reset --hard              -> index and worktree at HEAD
      //   staged.patch (--index)    -> index AND worktree advance to B
      //   unstaged.patch            -> empty in A, so no interference
      //   tracked archive rewrite   -> worktree bytes back to A
      // leaving worktree = A, index = B. A's manifest still describes p.txt as
      // tracked-dirty with A's content hash, so parity and hash verification
      // both pass and the oracle materializes successfully.
      const result = await validate(repo, mixed, plan, protectedStates);
      const difference = expectMismatch(result);

      // "Cleanly" is a claim about the oracle, not just about the absence of a
      // throw: materialization succeeded AND cleanup had nothing to report.
      expect(result.cleanupWarnings).toEqual([]);
      expect(difference.changedPaths).toEqual(["p.txt"]);
      expect(difference.addedPaths).toEqual([]);
      expect(difference.removedPaths).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("7: a genuine checkpoint failure throws rather than reporting a mismatch", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "current\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const plan = planOver("a.txt");
      const protectedStates = await captureS(repo, plan);

      // "We could not read the checkpoint" and "the checkpoint disagrees with
      // the snapshot" demand different recovery advice, so they must never
      // collapse into one outcome.
      const missing = join(repo.checkpointRoot, "does-not-exist");
      await expect(validate(repo, missing, plan, protectedStates)).rejects.toBeInstanceOf(
        CheckpointNotFoundError,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("9: E captured at a DIFFERENT HEAD is refused though every state agrees", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "current\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const plan = planOver("a.txt");
      const protectedStates = await captureS(repo, plan);
      const headS = await getHeadSha(repo.repoRoot);

      // Committing moves HEAD while leaving the index entry's mode and oid and
      // the worktree bytes untouched, so every PathState in S still holds. E is
      // therefore captured at a HEAD the transaction never froze.
      await git(repo.repoRoot, ["commit", "-m", "moves HEAD only"]);
      const checkpointDir = await makeCheckpoint(repo, "captured-at-b");

      // And back, so a later fence comparing LIVE HEAD to HEAD_S would pass.
      await git(repo.repoRoot, ["reset", "--soft", "HEAD~1"]);
      expect(await getHeadSha(repo.repoRoot)).toBe(headS);

      const differences = expectDifferences(
        await validate(repo, checkpointDir, plan, protectedStates, headS),
      );
      // States agree completely. Only checkpoint identity disagrees.
      expect(differences).toHaveLength(1);
      const only = differences[0];
      expect(only?.kind).toBe("head_mismatch");
      if (only?.kind !== "head_mismatch") throw new Error("unreachable");
      expect(only.expectedHeadSha).toBe(headS);
      expect(only.observedHeadSha).not.toBe(headS);
    } finally {
      await repo.cleanup();
    }
  });

  it("10: both axes wrong are reported together, states first", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "current\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const plan = planOver("a.txt");
      const protectedStates = await captureS(repo, plan);
      const headS = await getHeadSha(repo.repoRoot);

      // Drift the state AND move HEAD before capturing E.
      await write(repo, "a.txt", "drifted\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "moves HEAD and state"]);
      const checkpointDir = await makeCheckpoint(repo, "wrong-on-both-axes");
      await git(repo.repoRoot, ["reset", "--soft", "HEAD~1"]);

      const differences = expectDifferences(
        await validate(repo, checkpointDir, plan, protectedStates, headS),
      );
      // The array shape exists for exactly this: two independent facts, in the
      // locked order, neither hiding the other.
      expect(differences.map((d) => d.kind)).toEqual(["protected_states", "head_mismatch"]);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Mixed-checkpoint assembly (test-local, deliberately)
// =============================================================================

/**
 * Splice a checkpoint whose worktree-bearing artifacts come from `A` and whose
 * staged artifact comes from `B`.
 *
 * Test-local on purpose. Nothing in production should know how to splice
 * checkpoints, and the artifact names are written out rather than derived so a
 * future format change forces this fixture to be updated consciously instead of
 * silently producing a checkpoint that no longer proves anything.
 */
async function assembleMixedCheckpoint(
  repo: TestRepo,
  checkpointA: string,
  checkpointB: string,
  name: string,
): Promise<string> {
  const dir = join(repo.checkpointRoot, name);

  // Everything from A: manifest.json, rollback/unstaged.patch,
  // rollback/tracked-dirty.tar.gz, rollback/untracked.tar.gz, and A's
  // rollback/staged.patch, which the next step replaces.
  await cp(checkpointA, dir, { recursive: true });

  // The single spliced artifact. A's manifest continues to describe the
  // worktree, so the incoherence is invisible to every per-artifact check.
  await cp(join(checkpointB, "rollback", "staged.patch"), join(dir, "rollback", "staged.patch"));

  return dir;
}

// =============================================================================
// Section B: source invariant
// =============================================================================

describe("source invariant", () => {
  it("8: no whole-domain or topology-watch path enters the module", async () => {
    const source = await readFile(new URL("../src/recovery-handle.ts", import.meta.url), "utf8");

    // Scoped to the IMPORT BLOCK on purpose: the file header discusses
    // `captureProtectedDomain` and `ProtectedDomainSnapshot` by name, precisely
    // to explain why neither is used. A whole-file scan would fail on its own
    // documentation.
    const start = source.indexOf("import type { PathState }");
    const end = source.indexOf("const TEMP_DIR_PREFIX");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const imports = source.slice(start, end);

    for (const forbidden of [
      "captureProtectedDomain",
      "compareProtectedDomainSnapshots",
      "ProtectedDomainSnapshot",
      "protectedDomainUnchanged",
      "./fs-topology.js",
    ]) {
      expect(imports).not.toContain(forbidden);
    }

    // And no call anywhere in the body.
    expect(source).not.toContain("captureProtectedDomain(");
  });
});
