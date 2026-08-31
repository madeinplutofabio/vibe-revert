// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for plan stabilization (M 0.8.0 step 10B, §10).
//
// Four sections:
//   A. against a REAL repository and a real captured S   (cases 1-6)
//   B. projection and deterministic output, pure         (cases 7-13)
//   C. refusals and lookup guards                        (cases 14-16)
//   D. source invariant                                  (case 17)
//
// Section A captures S with the real `captureProtectedDomain`, because the
// interesting stabilization failures are about what the repository did between
// planning and S. Section B hand-builds snapshots so operation-identity and
// ordering rules can be exercised in shapes a real capture would not produce.
//
// One limit stated rather than implied: 14a's full requirement is "no emergency
// checkpoint, oracle, or marker, and the human's edit survives". Only the
// REFUSAL half is testable here, because `stabilizeSelectiveRestorePlan` is pure
// and owns none of that sequence. The sequencing half belongs to the slice that
// builds the caller.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import { observePathState, readIndexSnapshot } from "../src/path-state.js";
import {
  type PlanStabilizationDifference,
  stabilizeSelectiveRestorePlan,
} from "../src/plan-stabilization.js";
import {
  captureProtectedDomain,
  compareProtectedStateMaps,
  type ProtectedDomainSnapshot,
  protectedStatesUnchanged,
  type TopologyWatch,
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
//
// Deliberately duplicated from protected-domain.test.ts rather than shared. That
// file is sealed, and a shared helper module would reopen it to test a different
// module's contract. These builders are fixture plumbing, not semantics.

const GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000001";

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const DIRECTORY_STATE: PathState = {
  worktree: { kind: "directory" },
  index: { kind: "absent" },
};

const regularState = (content: string): PathState => ({
  worktree: { kind: "regular", content_ref: sha256(content), executable: false },
  index: { kind: "absent" },
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  readonly cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-stabilizefixture-"));
  const repoRoot = join(tmp, "repo");
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
  return { repoRoot, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

async function write(repo: TestRepo, rel: string, content: string): Promise<void> {
  const abs = join(repo.repoRoot, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

async function currentState(repoRoot: string, path: string): Promise<PathState> {
  const index = await readIndexSnapshot(repoRoot);
  return (await observePathState(repoRoot, path, index)).state;
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

function parentOp(
  path: string,
  observed: PathState,
  requiredBy: readonly string[],
): SelectiveRestoreOperation {
  return {
    kind: "create_parent_directory",
    path,
    target: { worktree: { kind: "directory" }, index: observed.index },
    observed,
    requiredBy,
  };
}

function eligiblePlan(parts: {
  classifications?: readonly SelectiveRestoreClassification[];
  operations?: readonly SelectiveRestoreOperation[];
  topologyDependencyPaths?: readonly string[];
}): SelectiveRestorePlan {
  return {
    outcome: "eligible",
    capabilities: { symlinkCheckout: true },
    selectedChangeGroupIds: [GROUP],
    classifications: parts.classifications ?? [],
    topologyDependencyPaths: parts.topologyDependencyPaths ?? [],
    operations: parts.operations ?? [],
    conflicts: [],
  };
}

const capture = (repo: TestRepo, plan: SelectiveRestorePlan, excludes: readonly string[] = []) =>
  captureProtectedDomain({
    repoRoot: repo.repoRoot,
    plan,
    rollbackExcludePatterns: excludes,
  });

const snapshotOf = (
  states: ReadonlyArray<readonly [string, PathState]>,
  watches: readonly TopologyWatch[] = [],
): ProtectedDomainSnapshot => ({
  states: new Map(states),
  topologyWatches: new Map(watches.map((w) => [w.path, w])),
});

/** Narrowing accessor: the union member a case actually asserts on. */
function differenceOf<K extends PlanStabilizationDifference["invariant"]>(
  differences: readonly PlanStabilizationDifference[],
  invariant: K,
): Extract<PlanStabilizationDifference, { invariant: K }> {
  const found = differences.find((d) => d.invariant === invariant);
  if (found === undefined) {
    throw new Error(
      `expected a ${invariant} difference, got ${JSON.stringify(differences.map((d) => d.invariant))}`,
    );
  }
  return found as Extract<PlanStabilizationDifference, { invariant: K }>;
}

function changedDifferences(result: ReturnType<typeof stabilizeSelectiveRestorePlan>) {
  if (result.outcome !== "precondition_changed") {
    throw new Error(`expected precondition_changed, got ${result.outcome}`);
  }
  return result.differences;
}

const pathsOf = (differences: readonly PlanStabilizationDifference[]): readonly string[] =>
  differences.map((d) => ("path" in d ? d.path : ""));

// =============================================================================
// Section A: against a real repository
// =============================================================================

describe("stabilizeSelectiveRestorePlan: against a captured S", () => {
  it("1: an untouched repository stabilizes", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "current\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observed = await currentState(repo.repoRoot, "a.txt");
      const target = regularState("before\n");

      const plan = eligiblePlan({
        classifications: [classificationAt("a.txt", observed, target)],
        operations: [restoreOp("a.txt", observed, target)],
      });

      const snapshot = await capture(repo, plan);
      expect(stabilizeSelectiveRestorePlan(plan, snapshot)).toEqual({ outcome: "stable" });
    } finally {
      await repo.cleanup();
    }
  });

  it("2: 14a -- a selected path edited between planning and S refuses", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "at planning time\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const atPlanningTime = await currentState(repo.repoRoot, "a.txt");
      const target = regularState("before\n");

      const plan = eligiblePlan({
        classifications: [classificationAt("a.txt", atPlanningTime, target)],
        operations: [restoreOp("a.txt", atPlanningTime, target)],
      });

      // The human edits after the plan was approved. Overwriting this would
      // destroy work the plan never accounted for.
      await write(repo, "a.txt", "the human changed their mind\n");

      const differences = changedDifferences(
        stabilizeSelectiveRestorePlan(plan, await capture(repo, plan)),
      );
      expect(differences).toHaveLength(1);
      expect(differenceOf(differences, "selected_prestate").path).toBe("a.txt");
    } finally {
      await repo.cleanup();
    }
  });

  it("3: 14b -- a new untracked child under a destructive root refuses", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "d/one.txt", "covered\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observedDir = await currentState(repo.repoRoot, "d");
      const observedChild = await currentState(repo.repoRoot, "d/one.txt");
      const collapsed = regularState("d is a file in the BEFORE world\n");

      // Eligible at planning: `d/one.txt` is a candidate whose BEFORE worktree
      // is absent, so C1a considered the whole subtree covered.
      const plan = eligiblePlan({
        classifications: [
          classificationAt("d", observedDir, collapsed),
          classificationAt("d/one.txt", observedChild, ABSENT_PATH_STATE),
        ],
        operations: [
          restoreOp("d", observedDir, collapsed),
          restoreOp("d/one.txt", observedChild, ABSENT_PATH_STATE),
        ],
      });

      // Appears AFTER stage C's scan. No classification changes, so invariant A
      // cannot see it; only the recursive watch can.
      await write(repo, "d/new-child.txt", "someone else's work\n");

      const differences = changedDifferences(
        stabilizeSelectiveRestorePlan(plan, await capture(repo, plan)),
      );
      const conflict = differenceOf(differences, "derived_conflict");
      // The planner's C1a reports the DESTRUCTIVE ROOT as the conflict path and
      // names the endangered child in the detail. Stabilization preserves that
      // structure rather than re-pointing it at the child.
      expect(conflict.path).toBe("d");
      expect(conflict.reason.code).toBe("UNSUPPORTED_STATE");
      expect(conflict.reason.code === "UNSUPPORTED_STATE" && conflict.reason.detail).toContain(
        "d/new-child.txt",
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("4: 14c -- a changed footprint refuses and does NOT recompute the plan", async () => {
    const repo = await setupRepo();
    try {
      const restored = regularState("restored\n");
      const plan = eligiblePlan({
        classifications: [classificationAt("a/b.txt", ABSENT_PATH_STATE, restored)],
        operations: [
          restoreOp("a/b.txt", ABSENT_PATH_STATE, restored),
          parentOp("a", ABSENT_PATH_STATE, ["a/b.txt"]),
        ],
      });

      // `a/` now exists, so the synthetic parent is no longer needed and `a`
      // becomes a topology dependency instead.
      await mkdir(join(repo.repoRoot, "a"), { recursive: true });

      const differences = changedDifferences(
        stabilizeSelectiveRestorePlan(plan, await capture(repo, plan)),
      );

      const dependency = differenceOf(differences, "topology_dependency");
      expect(dependency.addedPaths).toEqual(["a"]);
      expect(dependency.removedPaths).toEqual([]);

      const projection = differenceOf(differences, "executable_projection");
      expect(projection.removedPaths).toEqual(["a"]);
      expect(projection.addedPaths).toEqual([]);
      expect(projection.changedPaths).toEqual([]);

      // B precedes C.
      expect(differences.map((d) => d.invariant)).toEqual([
        "topology_dependency",
        "executable_projection",
      ]);

      // The approved plan is untouched: stabilization refuses, never replans.
      expect(plan.operations).toHaveLength(2);
      expect(plan.topologyDependencyPaths).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("5: 14d -- stabilization consumes S alone, so live policy cannot reach it", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "current\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await write(repo, "scratch.tmp", "excluded at session start\n");
      const observed = await currentState(repo.repoRoot, "a.txt");
      const target = regularState("before\n");

      const plan = eligiblePlan({
        classifications: [classificationAt("a.txt", observed, target)],
        operations: [restoreOp("a.txt", observed, target)],
      });

      // S is captured under the SESSION-START exclude policy.
      const snapshot = await capture(repo, plan, ["*.tmp"]);
      expect(snapshot.states.has("scratch.tmp")).toBe(false);

      // A capture under a different (say, live) policy really would differ, so
      // this assertion is not vacuous.
      const underDifferentPolicy = await capture(repo, plan, []);
      expect(underDifferentPolicy.states.has("scratch.tmp")).toBe(true);
      expect(
        protectedStatesUnchanged(
          compareProtectedStateMaps(snapshot.states, underDifferentPolicy.states),
        ),
      ).toBe(false);

      // Stabilization holds no repoRoot and no config, so only S can reach it.
      expect(stabilizeSelectiveRestorePlan(plan, snapshot)).toEqual({ outcome: "stable" });
    } finally {
      await repo.cleanup();
    }
  });

  it("6: invariant A short-circuits before the derivation runs", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "d/one.txt", "covered\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observedDir = await currentState(repo.repoRoot, "d");
      const observedChild = await currentState(repo.repoRoot, "d/one.txt");
      const collapsed = regularState("collapsed\n");

      const plan = eligiblePlan({
        classifications: [
          classificationAt("d", observedDir, collapsed),
          classificationAt("d/one.txt", observedChild, ABSENT_PATH_STATE),
        ],
        operations: [
          restoreOp("d", observedDir, collapsed),
          restoreOp("d/one.txt", observedChild, ABSENT_PATH_STATE),
        ],
      });

      // BOTH failures are present: a classification moved AND a new child
      // appeared that C1a would refuse. Only the cause is reported.
      await write(repo, "d/one.txt", "edited after planning\n");
      await write(repo, "d/new-child.txt", "would also conflict\n");

      const differences = changedDifferences(
        stabilizeSelectiveRestorePlan(plan, await capture(repo, plan)),
      );
      expect(differences.map((d) => d.invariant)).toEqual(["selected_prestate"]);
      expect(differenceOf(differences, "selected_prestate").path).toBe("d/one.txt");
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section B: projection and deterministic output, pure
// =============================================================================

describe("stabilizeSelectiveRestorePlan: executable identity and ordering", () => {
  const stateA = regularState("a\n");
  const stateB = regularState("b\n");

  it("7: operations differing ONLY in `observed` still stabilize", () => {
    // A deliberately inconsistent approved operation: its `observed` disagrees
    // with the classification's. Observation is precondition evidence, checked
    // by invariant A, so it is not part of executable identity.
    const snapshot = snapshotOf([["a.txt", stateA]]);
    const plan = eligiblePlan({
      classifications: [classificationAt("a.txt", stateA, stateB)],
      operations: [restoreOp("a.txt", stateB, stateB)],
    });

    expect(stabilizeSelectiveRestorePlan(plan, snapshot)).toEqual({ outcome: "stable" });
  });

  it("8: a changed `target` is an executable difference", () => {
    const snapshot = snapshotOf([["a.txt", stateA]]);
    const plan = eligiblePlan({
      classifications: [classificationAt("a.txt", stateA, stateB)],
      // Approved target is not what the classification's BEFORE state says.
      operations: [restoreOp("a.txt", stateA, regularState("something else\n"))],
    });

    const projection = differenceOf(
      changedDifferences(stabilizeSelectiveRestorePlan(plan, snapshot)),
      "executable_projection",
    );
    expect(projection.changedPaths).toEqual(["a.txt"]);
    expect(projection.addedPaths).toEqual([]);
    expect(projection.removedPaths).toEqual([]);
  });

  it("9: `requiredBy` is compared normalized, so reordering is not a difference", () => {
    const snapshot = snapshotOf([
      ["a", ABSENT_PATH_STATE],
      ["a/b.txt", ABSENT_PATH_STATE],
      ["a/c.txt", ABSENT_PATH_STATE],
    ]);
    const classifications = [
      classificationAt("a/b.txt", ABSENT_PATH_STATE, stateA),
      classificationAt("a/c.txt", ABSENT_PATH_STATE, stateA),
    ];
    const operations = [
      restoreOp("a/b.txt", ABSENT_PATH_STATE, stateA),
      restoreOp("a/c.txt", ABSENT_PATH_STATE, stateA),
    ];

    const reordered = eligiblePlan({
      classifications,
      operations: [...operations, parentOp("a", ABSENT_PATH_STATE, ["a/c.txt", "a/b.txt"])],
    });
    expect(stabilizeSelectiveRestorePlan(reordered, snapshot)).toEqual({ outcome: "stable" });

    const differentMember = eligiblePlan({
      classifications,
      operations: [...operations, parentOp("a", ABSENT_PATH_STATE, ["a/b.txt", "a/z.txt"])],
    });
    expect(
      differenceOf(
        changedDifferences(stabilizeSelectiveRestorePlan(differentMember, snapshot)),
        "executable_projection",
      ).changedPaths,
    ).toEqual(["a"]);
  });

  it("10: added and removed topology dependencies are reported", () => {
    const snapshot = snapshotOf([["a.txt", stateA]]);
    const plan = eligiblePlan({
      classifications: [classificationAt("a.txt", stateA, stateB)],
      operations: [restoreOp("a.txt", stateA, stateB)],
      // A root-level candidate has no ancestors, so nothing derives this.
      topologyDependencyPaths: ["keep"],
    });

    const dependency = differenceOf(
      changedDifferences(stabilizeSelectiveRestorePlan(plan, snapshot)),
      "topology_dependency",
    );
    expect(dependency.removedPaths).toEqual(["keep"]);
    expect(dependency.addedPaths).toEqual([]);
  });

  it("11: per-path refusal differences are deterministically sorted", () => {
    // Part 1: multiple prestate failures, supplied in reverse lexical order.
    const prestateSnapshot = snapshotOf([
      ["z.ts", stateB],
      ["a.ts", stateB],
    ]);
    const prestatePlan = eligiblePlan({
      classifications: [
        classificationAt("z.ts", stateA, stateB),
        classificationAt("a.ts", stateA, stateB),
      ],
    });
    expect(
      pathsOf(changedDifferences(stabilizeSelectiveRestorePlan(prestatePlan, prestateSnapshot))),
    ).toEqual(["a.ts", "z.ts"]);

    // Part 2: multiple DERIVED conflicts, generated in reverse lexical order.
    // C1a runs before C1b, so `z-dir`'s uncovered-descendant conflict is
    // produced before `a`'s non-directory-ancestor conflict.
    //
    // The shared derivation also sorts its own conflicts, so this locks the
    // EXTERNAL contract rather than proving which layer enforces it. That is
    // the guarantee callers depend on either way.
    const conflictSnapshot = snapshotOf(
      [
        ["z-dir", DIRECTORY_STATE],
        ["a/b.txt", ABSENT_PATH_STATE],
        ["a", regularState("a is a regular file\n")],
      ],
      [
        {
          path: "z-dir",
          kind: "recursive",
          members: [{ path: "z-dir/orphan.txt", kind: "leaf" }],
        },
      ],
    );
    const conflictPlan = eligiblePlan({
      classifications: [
        classificationAt("z-dir", DIRECTORY_STATE, regularState("collapsed\n")),
        classificationAt("a/b.txt", ABSENT_PATH_STATE, stateA),
      ],
    });

    const conflictDifferences = changedDifferences(
      stabilizeSelectiveRestorePlan(conflictPlan, conflictSnapshot),
    );
    expect(conflictDifferences.map((d) => d.invariant)).toEqual([
      "derived_conflict",
      "derived_conflict",
    ]);
    expect(pathsOf(conflictDifferences)).toEqual(["a", "z-dir"]);
  });

  it("12: aggregate difference path arrays are sorted unique", () => {
    // One scenario diverging at every aggregate surface at once, with each
    // family supplied in reverse lexical order and the approved dependency list
    // carrying a duplicate.
    const snapshot = snapshotOf([
      ["z-changed.txt", ABSENT_PATH_STATE],
      ["a-changed.txt", ABSENT_PATH_STATE],
      ["z-added", ABSENT_PATH_STATE],
      ["a-added", ABSENT_PATH_STATE],
      ["z-added/x.txt", ABSENT_PATH_STATE],
      ["a-added/y.txt", ABSENT_PATH_STATE],
      ["z-dep", DIRECTORY_STATE],
      ["a-dep", DIRECTORY_STATE],
      ["z-dep/x.txt", ABSENT_PATH_STATE],
      ["a-dep/y.txt", ABSENT_PATH_STATE],
    ]);

    const plan = eligiblePlan({
      classifications: [
        classificationAt("z-changed.txt", ABSENT_PATH_STATE, stateA),
        classificationAt("a-changed.txt", ABSENT_PATH_STATE, stateA),
        classificationAt("z-added/x.txt", ABSENT_PATH_STATE, stateA),
        classificationAt("a-added/y.txt", ABSENT_PATH_STATE, stateA),
        classificationAt("z-dep/x.txt", ABSENT_PATH_STATE, stateA),
        classificationAt("a-dep/y.txt", ABSENT_PATH_STATE, stateA),
      ],
      operations: [
        // Wrong targets -> changed.
        restoreOp("z-changed.txt", ABSENT_PATH_STATE, stateB),
        restoreOp("a-changed.txt", ABSENT_PATH_STATE, stateB),
        // Correct, and the derivation reproduces them.
        restoreOp("z-added/x.txt", ABSENT_PATH_STATE, stateA),
        restoreOp("a-added/y.txt", ABSENT_PATH_STATE, stateA),
        restoreOp("z-dep/x.txt", ABSENT_PATH_STATE, stateA),
        restoreOp("a-dep/y.txt", ABSENT_PATH_STATE, stateA),
        // Approved-only synthetic parents -> removed. The derivation produces
        // parents for `z-added` and `a-added` instead, which are additions.
        parentOp("z-removed", ABSENT_PATH_STATE, ["z-changed.txt"]),
        parentOp("a-removed", ABSENT_PATH_STATE, ["a-changed.txt"]),
      ],
      // Reverse order plus a duplicate; the derivation yields z-dep and a-dep.
      topologyDependencyPaths: ["z-gone", "a-gone", "z-gone"],
    });

    const differences = changedDifferences(stabilizeSelectiveRestorePlan(plan, snapshot));

    const dependency = differenceOf(differences, "topology_dependency");
    expect(dependency.addedPaths).toEqual(["a-dep", "z-dep"]);
    expect(dependency.removedPaths).toEqual(["a-gone", "z-gone"]);

    const projection = differenceOf(differences, "executable_projection");
    expect(projection.addedPaths).toEqual(["a-added", "z-added"]);
    expect(projection.removedPaths).toEqual(["a-removed", "z-removed"]);
    expect(projection.changedPaths).toEqual(["a-changed.txt", "z-changed.txt"]);
  });

  it("13: an operation present only in the derivation is an addition", () => {
    // The approved plan forgot its synthetic parent; the derivation produces it.
    const snapshot = snapshotOf([
      ["a", ABSENT_PATH_STATE],
      ["a/b.txt", ABSENT_PATH_STATE],
    ]);
    const plan = eligiblePlan({
      classifications: [classificationAt("a/b.txt", ABSENT_PATH_STATE, stateA)],
      operations: [restoreOp("a/b.txt", ABSENT_PATH_STATE, stateA)],
    });

    const projection = differenceOf(
      changedDifferences(stabilizeSelectiveRestorePlan(plan, snapshot)),
      "executable_projection",
    );
    expect(projection.addedPaths).toEqual(["a"]);
    expect(projection.removedPaths).toEqual([]);
  });
});

// =============================================================================
// Section C: refusals and lookup guards
// =============================================================================

describe("stabilizeSelectiveRestorePlan: guards", () => {
  const stateA = regularState("a\n");

  it("14: a noop or conflicted plan throws", () => {
    const snapshot = snapshotOf([]);
    const base = {
      capabilities: { symlinkCheckout: true },
      selectedChangeGroupIds: [GROUP],
      classifications: [],
      topologyDependencyPaths: [],
      operations: [],
    } as const;

    const noop: SelectiveRestorePlan = { ...base, outcome: "noop", conflicts: [] };
    const conflicted: SelectiveRestorePlan = {
      ...base,
      outcome: "conflicted",
      conflicts: [{ changeGroupId: GROUP, path: "x", reason: { code: "MODIFIED_SINCE" } }],
    };

    expect(() => stabilizeSelectiveRestorePlan(noop, snapshot)).toThrow(
      /requires an eligible plan/,
    );
    expect(() => stabilizeSelectiveRestorePlan(conflicted, snapshot)).toThrow(
      /requires an eligible plan/,
    );
  });

  it("15: a classification path absent from S is a construction error", () => {
    // Absence is never evidence here: S was captured from this very plan, so a
    // missing key means the caller's sequence is broken. Real absence is an
    // observed `PathState` whose worktree kind is "absent".
    const plan = eligiblePlan({
      classifications: [classificationAt("a.txt", stateA, stateA)],
    });
    expect(() => stabilizeSelectiveRestorePlan(plan, snapshotOf([]))).toThrow(
      /no observed state for "a\.txt"/,
    );
  });

  it("16: a missing or non-recursive watch for a destructive root throws", () => {
    const collapsed = regularState("collapsed\n");
    const plan = eligiblePlan({
      classifications: [classificationAt("d", DIRECTORY_STATE, collapsed)],
      operations: [restoreOp("d", DIRECTORY_STATE, collapsed)],
    });

    expect(() => stabilizeSelectiveRestorePlan(plan, snapshotOf([["d", DIRECTORY_STATE]]))).toThrow(
      /no topology watch for "d"/,
    );

    // An immediate watch is a SHALLOWER answer wearing the right shape. C1a
    // reasons about the whole subtree, so accepting it would silently weaken
    // the destructive-directory check.
    expect(() =>
      stabilizeSelectiveRestorePlan(
        plan,
        snapshotOf([["d", DIRECTORY_STATE]], [{ path: "d", kind: "immediate", members: [] }]),
      ),
    ).toThrow(/is immediate, but C1a requires recursive membership/);
  });
});

// =============================================================================
// Section D: source invariant
// =============================================================================
//
// The executable form of the no-live-policy lock. A regression guard in the
// style of the `captureProtectedStateMap` one: it proves this module opens no
// direct door to a policy or I/O read, not that no transitive path could ever
// exist.

describe("source invariant", () => {
  it("17: the stabilizer reads no policy and performs no I/O", async () => {
    const source = await readFile(new URL("../src/plan-stabilization.ts", import.meta.url), "utf8");

    for (const forbidden of [
      "./rollback-exclude.js",
      "./git-cli.js",
      "./fs-topology.js",
      "./checkpoint.js",
      "node:fs",
      "loadConfig",
    ]) {
      expect(source).not.toContain(`from "${forbidden}"`);
      expect(source).not.toContain(`${forbidden}(`);
    }

    // Synchronous by construction: an `async` signature would be the first step
    // toward reintroducing a read.
    expect(source).toContain("export function stabilizeSelectiveRestorePlan(");
    expect(source).not.toContain("export async function stabilizeSelectiveRestorePlan(");
  });
});
