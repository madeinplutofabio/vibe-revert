// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for post-transplant state verification (M 0.8.0 step 11).
//
// Seven sections:
//   A. candidate adjudication   (1-5)
//   B. already_at_before        (6-7)
//   C. synthetic parents        (8-12)
//   D. the domain and HEAD      (13-14)
//   E. topology authorization   (15-19)
//   F. evidence defects         (20, table-driven)
//   G. predicate separation     (21)
//
// TWO REAL REPOSITORIES, unlike the gate suite. Step 11 compares the complete
// `PathState` of a completed candidate against the oracle, index axis included,
// and `readIndexSnapshot` runs `git ls-files --stage` in whatever root it is
// given. A plain directory could not answer that.
//
// Every case follows the real ordering: seed the live tree at its post-session
// state, capture `S` and `HEAD_S`, THEN mutate the tree to imitate what the
// transplant did or failed to do, then verify. Capturing after the mutation
// would test a reconstruction rather than the transaction.
//
// BEHAVIOURAL FIXTURES ARE SCHEDULE-COMPLETE. Contract B says Step 11 receives
// progress derived from the plan's own prepared schedule, so an ordinary case
// must record every obligation its plan implies. A staged file restored across
// both axes schedules a `leaf` AND an `index` obligation; recording only the
// leaf would quietly lean on the very exception that keeps schedule derivation
// out of Step 11. Incoherent evidence is confined to section F, plus one
// labelled exception in case 17.
//
// Progress is always minted through `createTransplantProgress(...).snapshot()`,
// which is the only way to obtain the brand. No case casts one into existence.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { getHeadSha } from "../src/git-cli.js";
import { observePathState, readIndexSnapshot } from "../src/path-state.js";
import {
  everyCandidateSettled,
  type PostTransplantVerificationResult,
  postTransplantStateConsistent,
  type VerifiedCandidate,
  verifyPostTransplantState,
} from "../src/post-transplant-verification.js";
import { captureProtectedDomain, type ProtectedDomainSnapshot } from "../src/protected-domain.js";
import {
  ABSENT_PATH_STATE,
  type SelectiveRestoreClassification,
  type SelectiveRestoreOperation,
  type SelectiveRestorePlan,
} from "../src/restore-selective.js";
import {
  createTransplantProgress,
  type ObligationState,
  type RecordedTransplantProgress,
  type RestoreCandidateRecord,
  type ScheduledObligationBase,
} from "../src/transplant-obligations.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Fixtures
// =============================================================================

const GROUP = `cg_${"0".repeat(63)}1`;
const OTHER_GROUP = `cg_${"0".repeat(63)}2`;

const AFTER = "the session wrote this\n";
const BEFORE = "the pre-session content\n";

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

async function stateOf(root: string, path: string): Promise<PathState> {
  const index = await readIndexSnapshot(root);
  return (await observePathState(root, path, index)).state;
}

interface Fixture {
  readonly repo: string;
  readonly oracle: string;
  readonly cleanup: () => Promise<void>;
}

async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await write(root, ".gitignore", ".viberevert/\n");
  await write(root, "README.md", "# test\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "initial"]);
}

/** The live tree, plus an ORACLE repository holding the pre-session content. */
async function setup(): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-verifyfixture-"));
  const repo = join(tmp, "repo");
  const oracle = join(tmp, "oracle");
  await initRepo(repo);
  await initRepo(oracle);
  return { repo, oracle, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

/** Commit in the oracle, so BOTH of its axes are populated. */
async function seedOracle(fx: Fixture, path: string, content: string): Promise<void> {
  await write(fx.oracle, path, content);
  await git(fx.oracle, ["add", "-A"]);
  await git(fx.oracle, ["commit", "-m", `oracle ${path}`]);
}

// ---- Plan construction ------------------------------------------------------

/**
 * All three states describe the scenario, not only the ones Step 11 reads.
 *
 * Step 11 consults `path`, `changeGroupId`, and `outcome` alone, but a fixture
 * claiming plan coherence must not leave the rest as placeholders: an
 * incoherent plan is a section F concern, never an ordinary one.
 */
function classify(
  path: string,
  disposition: "restore_required" | "already_at_before",
  states: {
    readonly expectedBefore: PathState;
    readonly expectedAfter: PathState;
    readonly observed: PathState;
  },
  changeGroupId: string = GROUP,
): SelectiveRestoreClassification {
  return {
    path,
    changeGroupId,
    expectedBefore: states.expectedBefore,
    expectedAfter: states.expectedAfter,
    observed: states.observed,
    outcome: { kind: "planned", disposition },
  };
}

function candidateOp(
  path: string,
  observed: PathState,
  target: PathState,
): SelectiveRestoreOperation {
  return { kind: "restore_candidate", path, changeGroupId: GROUP, target, observed };
}

function parentOp(path: string, requiredBy: readonly string[]): SelectiveRestoreOperation {
  return {
    kind: "create_parent_directory",
    path,
    target: { worktree: { kind: "directory" }, index: { kind: "absent" } },
    observed: ABSENT_PATH_STATE,
    requiredBy: [...requiredBy],
  };
}

function planOf(parts: {
  classifications: readonly SelectiveRestoreClassification[];
  operations?: readonly SelectiveRestoreOperation[];
  topologyDependencyPaths?: readonly string[];
}): SelectiveRestorePlan {
  return {
    outcome: "eligible",
    capabilities: { symlinkCheckout: true },
    selectedChangeGroupIds: [GROUP],
    classifications: parts.classifications,
    topologyDependencyPaths: parts.topologyDependencyPaths ?? [],
    operations: parts.operations ?? [],
    conflicts: [],
  };
}

const capture = (fx: Fixture, plan: SelectiveRestorePlan): Promise<ProtectedDomainSnapshot> =>
  captureProtectedDomain({ repoRoot: fx.repo, plan, rollbackExcludePatterns: [] });

// ---- Progress ---------------------------------------------------------------

const obligation = (
  id: number,
  phase: ScheduledObligationBase["phase"],
  path: string,
  candidatePaths: readonly string[],
): ScheduledObligationBase => ({ id, phase, path, candidatePaths });

const record = (
  path: string,
  obligationIds: readonly number[],
  changeGroupId: string = GROUP,
): RestoreCandidateRecord => ({ path, changeGroupId, obligationIds });

/** Minted through the real accumulator; `states` is applied by id. */
function recorded(
  obligations: readonly ScheduledObligationBase[],
  candidates: readonly RestoreCandidateRecord[],
  states: readonly ObligationState[],
): RecordedTransplantProgress {
  const accumulator = createTransplantProgress(obligations, candidates);
  states.forEach((state, id) => {
    if (state === "attempted") accumulator.markAttempted(id);
    if (state === "completed") accumulator.markCompleted(id);
  });
  return accumulator.snapshot();
}

// ---- The ordinary staged-candidate scenario ---------------------------------

/**
 * A staged file the session rewrote. Restoring it moves BOTH axes, so its
 * schedule is `leaf` + `index`, and every case below records both.
 */
const STAGED_OBLIGATIONS: readonly ScheduledObligationBase[] = [
  obligation(0, "leaf", "a.txt", ["a.txt"]),
  obligation(1, "index", "a.txt", ["a.txt"]),
];
const STAGED_CANDIDATE = record("a.txt", [0, 1]);

const stagedProgress = (leaf: ObligationState, index: ObligationState) =>
  recorded(STAGED_OBLIGATIONS, [STAGED_CANDIDATE], [leaf, index]);

async function stagedScenario(fx: Fixture): Promise<{
  readonly plan: SelectiveRestorePlan;
  readonly frozen: ProtectedDomainSnapshot;
  readonly head: string;
}> {
  await seedOracle(fx, "a.txt", BEFORE);
  await write(fx.repo, "a.txt", AFTER);
  await git(fx.repo, ["add", "a.txt"]);

  const expectedBefore = await stateOf(fx.oracle, "a.txt");
  const observed = await stateOf(fx.repo, "a.txt");
  const plan = planOf({
    classifications: [
      classify("a.txt", "restore_required", { expectedBefore, expectedAfter: observed, observed }),
    ],
    operations: [candidateOp("a.txt", observed, expectedBefore)],
  });
  return { plan, frozen: await capture(fx, plan), head: await getHeadSha(fx.repo) };
}

// ---- Assertions -------------------------------------------------------------

const kinds = (r: PostTransplantVerificationResult): readonly string[] =>
  r.violations.map((v) => v.kind);

function candidateAt(r: PostTransplantVerificationResult, path: string): VerifiedCandidate {
  const found = r.candidates.find((c) => c.path === path);
  if (found === undefined) throw new Error(`fixture: no candidate for ${path}`);
  return found;
}

const hasViolation = (r: PostTransplantVerificationResult, kind: string, path: string): boolean =>
  r.violations.some((v) => v.kind === kind && v.path === path);

const verify = (
  fx: Fixture,
  plan: SelectiveRestorePlan,
  progress: RecordedTransplantProgress,
  frozenSnapshot: ProtectedDomainSnapshot,
  expectedHeadSha: string,
): Promise<PostTransplantVerificationResult> =>
  verifyPostTransplantState({
    repoRoot: fx.repo,
    oracleWorktree: fx.oracle,
    plan,
    progress,
    frozenSnapshot,
    expectedHeadSha,
  });

// =============================================================================
// Section A: candidate adjudication
// =============================================================================

describe("verifyPostTransplantState: candidates", () => {
  it("1: a completed candidate matching the oracle is restored", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await stagedScenario(fx);

      // The transplant: both axes brought back to the oracle's content.
      await write(fx.repo, "a.txt", BEFORE);
      await git(fx.repo, ["add", "a.txt"]);

      const result = await verify(fx, plan, stagedProgress("completed", "completed"), frozen, head);

      expect(result.violations).toEqual([]);
      expect(postTransplantStateConsistent(result)).toBe(true);
      expect(everyCandidateSettled(result)).toBe(true);

      const candidate = candidateAt(result, "a.txt");
      expect(candidate.outcome).toBe("restored");
      if (!("oracleState" in candidate)) throw new Error("expected an oracle comparison");
      expect(candidate.oracleState).toEqual(await stateOf(fx.oracle, "a.txt"));
    } finally {
      await fx.cleanup();
    }
  });

  it("2: an INDEX-ONLY divergence from the oracle is not restored", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await stagedScenario(fx);

      // Worktree bytes match the oracle EXACTLY; the index still holds the
      // session's blob. Evidence claims the index primitive completed, so a
      // content-only comparison would call this restored.
      await write(fx.repo, "a.txt", BEFORE);

      const result = await verify(fx, plan, stagedProgress("completed", "completed"), frozen, head);

      const candidate = candidateAt(result, "a.txt");
      expect(candidate.outcome).toBe("failed");
      expect(kinds(result)).toEqual(["candidate_not_restored"]);
      if (!("oracleState" in candidate)) throw new Error("expected an oracle comparison");
      expect(candidate.observedState.worktree).toEqual(candidate.oracleState.worktree);
      expect(candidate.observedState.index).not.toEqual(candidate.oracleState.index);
    } finally {
      await fx.cleanup();
    }
  });

  it("3: a not_attempted candidate that did not move is clean", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await stagedScenario(fx);

      const result = await verify(fx, plan, stagedProgress("pending", "pending"), frozen, head);

      expect(result.violations).toEqual([]);
      expect(candidateAt(result, "a.txt").outcome).toBe("not_attempted");
      expect(everyCandidateSettled(result)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  it("4: a not_attempted candidate that moved anyway is unattributed drift", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await stagedScenario(fx);

      // Nothing VibeRevert could have done: every obligation stayed pending.
      await write(fx.repo, "a.txt", "something else entirely\n");

      const result = await verify(fx, plan, stagedProgress("pending", "pending"), frozen, head);

      expect(kinds(result)).toEqual(["unattributed_change"]);
      // The execution fact is unchanged: no obligation was entered.
      expect(candidateAt(result, "a.txt").outcome).toBe("not_attempted");
    } finally {
      await fx.cleanup();
    }
  });

  it("5: a failed candidate carries its state and asserts nothing about it", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await stagedScenario(fx);

      // A primitive was entered and left the path partly written. No target
      // state is assertable, so this must NOT produce a violation.
      await write(fx.repo, "a.txt", "half-written\n");

      const result = await verify(fx, plan, stagedProgress("attempted", "pending"), frozen, head);

      expect(result.violations).toEqual([]);
      const candidate = candidateAt(result, "a.txt");
      expect(candidate.outcome).toBe("failed");
      expect("oracleState" in candidate).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section B: already_at_before
// =============================================================================
//
// `already_at_before` schedules nothing, so its coherent progress is empty.

describe("verifyPostTransplantState: already_at_before", () => {
  const settledPlan = async (fx: Fixture): Promise<SelectiveRestorePlan> => {
    const observed = await stateOf(fx.repo, "settled.txt");
    return planOf({
      classifications: [
        classify("settled.txt", "already_at_before", {
          expectedBefore: observed,
          // What the session had contributed before the user reverted it.
          expectedAfter: {
            worktree: { kind: "regular", content_ref: sha256(AFTER), executable: null },
            index: observed.index,
          },
          observed,
        }),
      ],
    });
  };

  it("6: an untouched already_at_before candidate keeps that outcome", async () => {
    const fx = await setup();
    try {
      await write(fx.repo, "settled.txt", BEFORE);
      await git(fx.repo, ["add", "settled.txt"]);

      const plan = await settledPlan(fx);
      const frozen = await capture(fx, plan);
      const head = await getHeadSha(fx.repo);

      const result = await verify(fx, plan, recorded([], [], []), frozen, head);

      expect(result.violations).toEqual([]);
      expect(candidateAt(result, "settled.txt").outcome).toBe("already_at_before");
      expect(everyCandidateSettled(result)).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("7: a drifted already_at_before candidate becomes failed", async () => {
    const fx = await setup();
    try {
      await write(fx.repo, "settled.txt", BEFORE);
      await git(fx.repo, ["add", "settled.txt"]);

      const plan = await settledPlan(fx);
      const frozen = await capture(fx, plan);
      const head = await getHeadSha(fx.repo);

      await write(fx.repo, "settled.txt", "moved after S\n");

      const result = await verify(fx, plan, recorded([], [], []), frozen, head);

      // Saying "already at BEFORE" after verification disproved it would be the
      // wrong answer; the outcome degrades and the drift is reported.
      expect(candidateAt(result, "settled.txt").outcome).toBe("failed");
      expect(kinds(result)).toEqual(["unattributed_change"]);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section C: synthetic parents
// =============================================================================
//
// A synthetic parent is judged against `op.target` rather than a locally
// recreated "directory plus preserved index" rule: the operation already
// carries the exact state the plan intended.
//
// The oracle leaf is written but NOT staged, so its complete state is
// `regular worktree / absent index`, matching the candidate target. Committing
// it would give the oracle an index entry the plan never claimed, and every
// completed case would fail for an unrelated reason.

describe("verifyPostTransplantState: synthetic parents", () => {
  async function parentScenario(fx: Fixture): Promise<{
    readonly plan: SelectiveRestorePlan;
    readonly frozen: ProtectedDomainSnapshot;
    readonly head: string;
  }> {
    await write(fx.oracle, "dir/leaf.txt", BEFORE);
    const target = await stateOf(fx.oracle, "dir/leaf.txt");

    const plan = planOf({
      classifications: [
        classify("dir/leaf.txt", "restore_required", {
          expectedBefore: target,
          expectedAfter: ABSENT_PATH_STATE,
          observed: ABSENT_PATH_STATE,
        }),
      ],
      operations: [
        parentOp("dir", ["dir/leaf.txt"]),
        candidateOp("dir/leaf.txt", ABSENT_PATH_STATE, target),
      ],
    });
    return { plan, frozen: await capture(fx, plan), head: await getHeadSha(fx.repo) };
  }

  // The session deleted the file and its parent, so the schedule is a synthetic
  // directory plus a leaf. Neither axis of the index moves.
  const parentProgress = (directory: ObligationState, leaf: ObligationState) =>
    recorded(
      [
        obligation(0, "directory", "dir", ["dir/leaf.txt"]),
        obligation(1, "leaf", "dir/leaf.txt", ["dir/leaf.txt"]),
      ],
      [record("dir/leaf.txt", [0, 1])],
      [directory, leaf],
    );

  it("8: a completed parent and leaf verify clean", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await parentScenario(fx);

      await mkdir(join(fx.repo, "dir"), { recursive: true });
      await write(fx.repo, "dir/leaf.txt", BEFORE);

      const result = await verify(fx, plan, parentProgress("completed", "completed"), frozen, head);

      expect(result.violations).toEqual([]);
      expect(candidateAt(result, "dir/leaf.txt").outcome).toBe("restored");
    } finally {
      await fx.cleanup();
    }
  });

  it("9: a completed parent that is not its target is a planned effect unverified", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await parentScenario(fx);

      // Marked completed, but the directory does not exist.
      const result = await verify(fx, plan, parentProgress("completed", "pending"), frozen, head);

      expect(kinds(result)).toEqual(["planned_effect_not_verified"]);
      expect(candidateAt(result, "dir/leaf.txt").outcome).toBe("failed");
    } finally {
      await fx.cleanup();
    }
  });

  it("10: a pending parent that did not move is clean", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await parentScenario(fx);

      const result = await verify(fx, plan, parentProgress("pending", "pending"), frozen, head);

      expect(result.violations).toEqual([]);
      expect(candidateAt(result, "dir/leaf.txt").outcome).toBe("not_attempted");
    } finally {
      await fx.cleanup();
    }
  });

  it("11: a pending parent that appeared anyway is unattributed AND unauthorized", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await parentScenario(fx);

      await mkdir(join(fx.repo, "dir"), { recursive: true });

      const result = await verify(fx, plan, parentProgress("pending", "pending"), frozen, head);

      // Two true statements about one directory: its own frozen state moved,
      // and its appearance beneath the repository-root watch was authorized by
      // no obligation that was ever entered.
      expect(hasViolation(result, "unattributed_change", "dir")).toBe(true);
      expect(hasViolation(result, "unauthorized_topology_change", "dir")).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("12: an attempted parent asserts nothing in either direction", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await parentScenario(fx);

      // `mkdir` may have acted before failing, so neither "unchanged" nor
      // "equals target" is assertable, and its appearance IS authorized.
      await mkdir(join(fx.repo, "dir"), { recursive: true });

      const result = await verify(fx, plan, parentProgress("attempted", "pending"), frozen, head);

      expect(result.violations).toEqual([]);
      expect(candidateAt(result, "dir/leaf.txt").outcome).toBe("failed");
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section D: the unselected domain, and HEAD
// =============================================================================

describe("verifyPostTransplantState: domain and HEAD", () => {
  it("13: an unselected protected path that moved is unattributed", async () => {
    const fx = await setup();
    try {
      await seedOracle(fx, "a.txt", BEFORE);
      await write(fx.repo, "a.txt", AFTER);
      await write(fx.repo, "bystander.txt", "not selected\n");
      await git(fx.repo, ["add", "-A"]);

      const expectedBefore = await stateOf(fx.oracle, "a.txt");
      const observed = await stateOf(fx.repo, "a.txt");
      const plan = planOf({
        classifications: [
          classify("a.txt", "restore_required", {
            expectedBefore,
            expectedAfter: observed,
            observed,
          }),
        ],
        operations: [candidateOp("a.txt", observed, expectedBefore)],
      });
      const frozen = await capture(fx, plan);
      const head = await getHeadSha(fx.repo);

      await write(fx.repo, "bystander.txt", "the transplant should not have touched this\n");

      const result = await verify(fx, plan, stagedProgress("pending", "pending"), frozen, head);

      expect(kinds(result)).toEqual(["unattributed_change"]);
      expect(hasViolation(result, "unattributed_change", "bystander.txt")).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("14: HEAD moving is reported, because the transplant never moves HEAD", async () => {
    const fx = await setup();
    try {
      await write(fx.repo, "a.txt", AFTER);
      await git(fx.repo, ["add", "a.txt"]);

      const observed = await stateOf(fx.repo, "a.txt");
      const plan = planOf({
        classifications: [
          classify("a.txt", "already_at_before", {
            expectedBefore: observed,
            expectedAfter: observed,
            observed,
          }),
        ],
      });
      const frozen = await capture(fx, plan);
      const head = await getHeadSha(fx.repo);

      // A commit moves HEAD without disturbing the worktree or the index: the
      // staged blob and mode are identical on both sides of it.
      await git(fx.repo, ["commit", "-m", "a verification command committed"]);

      const result = await verify(fx, plan, recorded([], [], []), frozen, head);

      expect(kinds(result)).toEqual(["head_moved"]);
      expect(result.observedHeadSha).not.toBe(head);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section E: topology authorization
// =============================================================================
//
// Authorization is member-specific and target-sensitive: the plan must permit
// the exact transition at the exact member, AND an obligation of the phase that
// could produce that target must have been entered.
//
// `dir/keep.txt` survives every removal case on purpose. Without it git would
// drop the now-empty `dir`, which is a watch parent frozen in `S`, and its own
// disappearance would drown the assertion under test.

describe("verifyPostTransplantState: topology", () => {
  async function removalScenario(fx: Fixture): Promise<{
    readonly plan: SelectiveRestorePlan;
    readonly frozen: ProtectedDomainSnapshot;
    readonly head: string;
  }> {
    await write(fx.repo, "dir/gone.txt", AFTER);
    await write(fx.repo, "dir/keep.txt", "stays put\n");
    await git(fx.repo, ["add", "-A"]);

    const observed = await stateOf(fx.repo, "dir/gone.txt");
    const plan = planOf({
      classifications: [
        classify("dir/gone.txt", "restore_required", {
          // The session CREATED this file, so its pre-session state is absent.
          expectedBefore: ABSENT_PATH_STATE,
          expectedAfter: observed,
          observed,
        }),
      ],
      operations: [candidateOp("dir/gone.txt", observed, ABSENT_PATH_STATE)],
    });
    return { plan, frozen: await capture(fx, plan), head: await getHeadSha(fx.repo) };
  }

  // Removing a staged file clears both axes, so the schedule is removal+index.
  const removalProgress = (removal: ObligationState, index: ObligationState) =>
    recorded(
      [
        obligation(0, "removal", "dir/gone.txt", ["dir/gone.txt"]),
        obligation(1, "index", "dir/gone.txt", ["dir/gone.txt"]),
      ],
      [record("dir/gone.txt", [0, 1])],
      [removal, index],
    );

  it("15: a removal whose obligations completed authorizes the member vanishing", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await removalScenario(fx);

      await git(fx.repo, ["rm", "-f", "--", "dir/gone.txt"]);

      const result = await verify(
        fx,
        plan,
        removalProgress("completed", "completed"),
        frozen,
        head,
      );

      expect(result.violations).toEqual([]);
      expect(candidateAt(result, "dir/gone.txt").outcome).toBe("restored");
    } finally {
      await fx.cleanup();
    }
  });

  it("16: a planned removal that was never entered does NOT authorize it", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await removalScenario(fx);

      await git(fx.repo, ["rm", "-f", "--", "dir/gone.txt"]);

      // The plan permitted it, but nothing entered the primitive. Intent is not
      // evidence that anything ran.
      const result = await verify(fx, plan, removalProgress("pending", "pending"), frozen, head);

      expect(hasViolation(result, "unattributed_change", "dir/gone.txt")).toBe(true);
      expect(hasViolation(result, "unauthorized_topology_change", "dir/gone.txt")).toBe(true);
      expect(candidateAt(result, "dir/gone.txt").outcome).toBe("not_attempted");
    } finally {
      await fx.cleanup();
    }
  });

  it("17: a directory obligation cannot authorize a LEAF appearing", async () => {
    const fx = await setup();
    try {
      await mkdir(join(fx.repo, "dir"), { recursive: true });
      await write(fx.repo, "dir/keep.txt", "anchor\n");
      await git(fx.repo, ["add", "-A"]);

      // Unstaged on both sides, so the candidate's complete PathState matches
      // and cannot fail for an unrelated reason.
      await write(fx.oracle, "dir/new.txt", BEFORE);
      const target = await stateOf(fx.oracle, "dir/new.txt");

      const plan = planOf({
        classifications: [
          classify("dir/new.txt", "restore_required", {
            expectedBefore: target,
            expectedAfter: ABSENT_PATH_STATE,
            observed: ABSENT_PATH_STATE,
          }),
        ],
        operations: [candidateOp("dir/new.txt", ABSENT_PATH_STATE, target)],
      });
      const frozen = await capture(fx, plan);
      const head = await getHeadSha(fx.repo);

      await write(fx.repo, "dir/new.txt", BEFORE);

      // THE ONE DELIBERATE BEHAVIOURAL INCOHERENCE. Attribution is internally
      // consistent and the final state equals the oracle, but the recorded
      // phase is the wrong primitive family: a `directory` obligation cannot
      // have produced the leaf this plan targets. That isolates target
      // sensitivity from every other check.
      const progress = recorded(
        [obligation(0, "directory", "dir/new.txt", ["dir/new.txt"])],
        [record("dir/new.txt", [0])],
        ["completed"],
      );
      const result = await verify(fx, plan, progress, frozen, head);

      expect(candidateAt(result, "dir/new.txt").outcome).toBe("restored");
      expect(kinds(result)).toEqual(["unauthorized_topology_change"]);
      expect(hasViolation(result, "unauthorized_topology_change", "dir/new.txt")).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("18: an authorized directory-to-leaf kind change is accepted", async () => {
    const fx = await setup();
    try {
      // EMPTY on purpose: a descendant would be reported separately and
      // obscure the member-kind assertion.
      await mkdir(join(fx.repo, "dir", "flips"), { recursive: true });
      await write(fx.repo, "dir/anchor.txt", AFTER);
      await git(fx.repo, ["add", "-A"]);
      const observed = await stateOf(fx.repo, "dir/flips");

      await write(fx.oracle, "dir/flips", BEFORE);
      const target = await stateOf(fx.oracle, "dir/flips");

      const plan = planOf({
        classifications: [
          classify("dir/flips", "restore_required", {
            expectedBefore: target,
            expectedAfter: observed,
            observed,
          }),
        ],
        operations: [candidateOp("dir/flips", observed, target)],
      });
      const frozen = await capture(fx, plan);
      const head = await getHeadSha(fx.repo);

      await rm(join(fx.repo, "dir", "flips"), { recursive: true });
      await write(fx.repo, "dir/flips", BEFORE);

      // Directory to leaf schedules removal then leaf; neither index axis moves.
      const progress = recorded(
        [
          obligation(0, "removal", "dir/flips", ["dir/flips"]),
          obligation(1, "leaf", "dir/flips", ["dir/flips"]),
        ],
        [record("dir/flips", [0, 1])],
        ["completed", "completed"],
      );
      const result = await verify(fx, plan, progress, frozen, head);

      expect(result.violations).toEqual([]);
      expect(candidateAt(result, "dir/flips").outcome).toBe("restored");
    } finally {
      await fx.cleanup();
    }
  });

  it("19: a poisoned member is inconsistent evidence, never unauthorized", async () => {
    const fx = await setup();
    try {
      const { frozen, head } = await removalScenario(fx);
      const observed = frozen.states.get("dir/gone.txt");
      if (observed === undefined) throw new Error("fixture: expected a frozen state");

      // Two operations at one path: authority cannot be RESOLVED, but one of
      // them may well have permitted the transition, so "unauthorized" would be
      // a claim the evidence cannot support.
      const poisonedPlan = planOf({
        classifications: [
          classify("dir/gone.txt", "restore_required", {
            expectedBefore: ABSENT_PATH_STATE,
            expectedAfter: observed,
            observed,
          }),
        ],
        operations: [
          candidateOp("dir/gone.txt", observed, ABSENT_PATH_STATE),
          candidateOp("dir/gone.txt", observed, ABSENT_PATH_STATE),
        ],
      });

      await git(fx.repo, ["rm", "-f", "--", "dir/gone.txt"]);

      const result = await verify(
        fx,
        poisonedPlan,
        removalProgress("completed", "completed"),
        frozen,
        head,
      );

      expect(kinds(result)).toContain("inconsistent_evidence");
      expect(kinds(result)).not.toContain("unauthorized_topology_change");
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section F: evidence defects
// =============================================================================

describe("verifyPostTransplantState: evidence defects", () => {
  it("20: every defect yields the defect arm, one record per classification", async () => {
    const fx = await setup();
    try {
      const { plan: basePlan, frozen: baseSnapshot, head } = await stagedScenario(fx);
      const soundProgress = stagedProgress("completed", "completed");

      const only = basePlan.classifications[0];
      if (only === undefined) throw new Error("fixture: expected one classification");
      const states = {
        expectedBefore: only.expectedBefore,
        expectedAfter: only.expectedAfter,
        observed: only.observed,
      };

      /** `S` genuinely captured, then stripped of the selected KEY. */
      const withoutSelected: ProtectedDomainSnapshot = {
        states: new Map([...baseSnapshot.states].filter(([path]) => path !== "a.txt")),
        topologyWatches: baseSnapshot.topologyWatches,
      };

      const conflicted = planOf({
        classifications: [
          {
            path: "a.txt",
            changeGroupId: GROUP,
            ...states,
            outcome: { kind: "conflict", reason: { code: "MODIFIED_SINCE" } },
          },
        ],
      });

      const rows: readonly [
        string,
        SelectiveRestorePlan,
        RecordedTransplantProgress,
        ProtectedDomainSnapshot,
      ][] = [
        [
          "a duplicated classification",
          planOf({
            classifications: [
              classify("a.txt", "restore_required", states),
              classify("a.txt", "restore_required", states),
            ],
          }),
          soundProgress,
          baseSnapshot,
        ],
        [
          "a duplicated execution record",
          basePlan,
          recorded(
            STAGED_OBLIGATIONS,
            [STAGED_CANDIDATE, STAGED_CANDIDATE],
            ["completed", "completed"],
          ),
          baseSnapshot,
        ],
        [
          "duplicated plan operations",
          planOf({
            classifications: [classify("a.txt", "restore_required", states)],
            operations: [
              candidateOp("a.txt", states.observed, states.expectedBefore),
              candidateOp("a.txt", states.observed, states.expectedBefore),
            ],
          }),
          soundProgress,
          baseSnapshot,
        ],
        [
          "a synthetic parent sharing a classification path",
          planOf({
            classifications: [classify("a.txt", "restore_required", states)],
            operations: [parentOp("a.txt", ["a.txt"])],
          }),
          soundProgress,
          baseSnapshot,
        ],
        ["a conflicted classification", conflicted, soundProgress, baseSnapshot],
        ["a selected path absent from S", basePlan, soundProgress, withoutSelected],
        [
          "no execution record",
          basePlan,
          recorded(STAGED_OBLIGATIONS, [], ["completed", "completed"]),
          baseSnapshot,
        ],
        [
          "a change-group mismatch",
          basePlan,
          recorded(
            STAGED_OBLIGATIONS,
            [record("a.txt", [0, 1], OTHER_GROUP)],
            ["completed", "completed"],
          ),
          baseSnapshot,
        ],
        [
          "self-contradictory attribution",
          basePlan,
          // The record names obligations that do not attribute back to it.
          recorded(
            [
              obligation(0, "leaf", "a.txt", ["somewhere/else.txt"]),
              obligation(1, "index", "a.txt", ["somewhere/else.txt"]),
            ],
            [STAGED_CANDIDATE],
            ["completed", "completed"],
          ),
          baseSnapshot,
        ],
      ];

      for (const [label, plan, progress, snapshot] of rows) {
        const result = await verify(fx, plan, progress, snapshot, head);

        expect(kinds(result), label).toContain("inconsistent_evidence");
        // The invariant step 12 depends on: never fewer records than
        // classifications, so a missing candidate can never be rediscovered.
        expect(result.candidates, label).toHaveLength(plan.classifications.length);
        for (const candidate of result.candidates) {
          expect(candidate.outcome, label).toBe("failed");
          expect("evidenceStatus" in candidate, label).toBe(true);
        }
        expect(everyCandidateSettled(result), label).toBe(false);
      }
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section G: the two predicates are not synonyms
// =============================================================================

describe("verifyPostTransplantState: predicates", () => {
  it("21: a failed candidate with no violations is CONSISTENT but not settled", async () => {
    const fx = await setup();
    try {
      const { plan, frozen, head } = await stagedScenario(fx);

      // Schedule-complete and genuinely mid-failure: the leaf primitive was
      // entered and the index write was never reached.
      const result = await verify(fx, plan, stagedProgress("attempted", "pending"), frozen, head);

      // The primitive failure is already known from progress, and the observed
      // state contradicts nothing. Letting "consistent" mean "succeeded" would
      // report this transaction as a successful rollback.
      expect(candidateAt(result, "a.txt").outcome).toBe("failed");
      expect(postTransplantStateConsistent(result)).toBe(true);
      expect(everyCandidateSettled(result)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });
});
