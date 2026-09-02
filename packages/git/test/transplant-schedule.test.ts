// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the mutation schedule (M 0.8.0 step 10F, §13).
//
// Nine sections:
//   A. derivation and ordering      (1-3)
//   B. authorization                (4-8)
//   C. evidence linkage             (9-12)
//   D. synthetic parent authority   (13-15)
//   E. shape                        (16-19)
//   F. oracle index                 (20-21)
//   G. execution                    (22-25)
//   H. source invariant             (26)
//   I. obligation graph             (27-29)
//
// THREE FIXTURE TIERS, by what each case genuinely needs:
//
//   pure           no filesystem at all. `prepareSelectiveTransplant` reads the
//                  oracle ONLY when an index axis differs, so these pass
//                  `UNREAD_ORACLE`. If that policy ever regresses, the ENOENT
//                  names the constant instead of failing mysteriously.
//   plain dirs     following 10C: the "oracle" is an ordinary directory holding
//                  the bytes a real oracle worktree would hold, because the
//                  materializers do filesystem work, not git work.
//   real git       only where `readIndexSnapshot` or `update-index` genuinely
//                  need a repository. Three cases.
//
// Most plans here are FABRICATED: values a well-formed planner could not
// produce. That is the entire premise of this boundary. Preparation defends
// against runtime values, not against the type, so several cases must cast
// through `fabricated` to express a plan the type system forbids.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { IndexState, PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { type IndexSnapshot, readIndexSnapshot } from "../src/path-state.js";
import type {
  SelectiveRestoreClassification,
  SelectiveRestoreOperation,
  SelectiveRestorePlan,
} from "../src/restore-selective.js";
import { createTransplantProgress } from "../src/transplant-obligations.js";
import {
  executePreparedSelectiveTransplant,
  type PreparedIndexPhase,
  type PreparedSelectiveTransplant,
  prepareSelectiveTransplant,
  type ScheduledObligation,
} from "../src/transplant-schedule.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Fixtures
// =============================================================================

const GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000001";
const OTHER_GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000002";

/**
 * Deliberately not a real path. Preparation must not read the oracle when no
 * index axis differs, so any case that touches it fails loudly and by name.
 */
const UNREAD_ORACLE = join(tmpdir(), "viberevert-oracle-must-not-be-read");

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const ABSENT: PathState = { worktree: { kind: "absent" }, index: { kind: "absent" } };

const regular = (content: string, executable: boolean | null = null): PathState => ({
  worktree: { kind: "regular", content_ref: sha256(Buffer.from(content, "utf8")), executable },
  index: { kind: "absent" },
});

const symlinkState = (target: string): PathState => ({
  worktree: { kind: "symlink", target_ref: sha256(Buffer.from(target, "utf8")) },
  index: { kind: "absent" },
});

const directoryState: PathState = { worktree: { kind: "directory" }, index: { kind: "absent" } };

const unsupportedState: PathState = {
  worktree: { kind: "unsupported", fs_kind: "fifo" },
  index: { kind: "absent" },
};

const withIndex = (state: PathState, index: IndexState): PathState => ({ ...state, index });

const entry = (
  oid: string,
  mode: "100644" | "100755" | "120000" | "160000" = "100644",
): IndexState => ({ kind: "entry", mode, oid });

/**
 * A plan that violates its own type.
 *
 * Every refusal below is about a runtime value a planner could not have
 * produced, so expressing the case at all requires stepping outside the type.
 * Confined to this one helper so each use is visible.
 */
const fabricated = (plan: unknown): SelectiveRestorePlan => plan as SelectiveRestorePlan;

// ---- Plan construction ------------------------------------------------------

/**
 * A well-formed `restore_required` classification.
 *
 * `observed` defaults to `after`, which is stage A's own relation: it returns
 * `restore_required` exactly where the observation equals the recorded AFTER
 * state.
 */
function restoreRequired(
  path: string,
  before: PathState,
  after: PathState,
  changeGroupId: string = GROUP,
): SelectiveRestoreClassification {
  return {
    path,
    changeGroupId,
    expectedBefore: before,
    expectedAfter: after,
    observed: after,
    outcome: { kind: "planned", disposition: "restore_required" },
  };
}

// Narrowed to their exact union member. Declaring these as the whole
// `SelectiveRestoreOperation` union makes `{ ...op, field: x }` an object
// literal assigned to a union, and TypeScript's excess-property check then
// measures it against the WRONG member.
type CandidateOperation = Extract<SelectiveRestoreOperation, { kind: "restore_candidate" }>;
type ParentOperation = Extract<SelectiveRestoreOperation, { kind: "create_parent_directory" }>;

/** The operation the planner derives from a classification. */
function candidateOp(c: SelectiveRestoreClassification): CandidateOperation {
  return {
    kind: "restore_candidate",
    path: c.path,
    changeGroupId: c.changeGroupId,
    target: c.expectedBefore,
    observed: c.observed,
  };
}

function parentOp(
  path: string,
  requiredBy: readonly string[],
  observed: PathState = ABSENT,
): ParentOperation {
  return {
    kind: "create_parent_directory",
    path,
    // The planner's own `parentDirectoryTarget`: a directory, preserving the
    // observed index axis.
    target: { worktree: { kind: "directory" }, index: observed.index },
    observed,
    requiredBy: [...requiredBy].sort(),
  };
}

function planOf(parts: {
  classifications: readonly SelectiveRestoreClassification[];
  operations?: readonly SelectiveRestoreOperation[];
  selectedChangeGroupIds?: readonly string[];
  symlinkCheckout?: boolean;
}): SelectiveRestorePlan {
  const classifications = parts.classifications;
  return {
    outcome: "eligible",
    capabilities: { symlinkCheckout: parts.symlinkCheckout ?? true },
    selectedChangeGroupIds: parts.selectedChangeGroupIds ?? [GROUP],
    classifications,
    topologyDependencyPaths: [],
    operations: parts.operations ?? classifications.filter(isPlanned).map(candidateOp),
    conflicts: [],
  };
}

const isPlanned = (c: SelectiveRestoreClassification): boolean =>
  c.outcome.kind === "planned" && c.outcome.disposition === "restore_required";

const prepare = (plan: SelectiveRestorePlan, oracle: string = UNREAD_ORACLE) =>
  prepareSelectiveTransplant(oracle, plan);

// ---- Filesystem roots -------------------------------------------------------

interface Roots {
  readonly repo: string;
  readonly oracle: string;
  readonly cleanup: () => Promise<void>;
}

/** Plain directories, per 10C: the materializers do filesystem work, not git. */
async function setupRoots(): Promise<Roots> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-schedulefixture-"));
  const repo = join(tmp, "repo");
  const oracle = join(tmp, "oracle");
  await mkdir(repo, { recursive: true });
  await mkdir(oracle, { recursive: true });
  return { repo, oracle, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

/** A real repository, for the three cases that genuinely need git. */
async function setupGitRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-schedulegit-"));
  const root = join(tmp, "repo");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  return { root, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const requireEntry = (snapshot: IndexSnapshot, path: string): IndexState => {
  const state = snapshot.byPath.get(path);
  if (state === undefined) throw new Error(`fixture: no index entry for ${path}`);
  return state;
};

const leafPaths = (prepared: PreparedSelectiveTransplant): readonly string[] =>
  prepared.leaves.map((l) => l.path);

const indexWritePaths = (prepared: PreparedSelectiveTransplant): readonly string[] =>
  prepared.indexPhase.kind === "writes" ? prepared.indexPhase.writes.map((w) => w.path) : [];

const removalPaths = (prepared: PreparedSelectiveTransplant): readonly string[] =>
  prepared.removals.map((r) => r.path);

const directoryPaths = (prepared: PreparedSelectiveTransplant): readonly string[] =>
  prepared.directories.map((d) => d.path);

/**
 * Build a prepared value directly, for the execution cases.
 *
 * Assigns ids sequentially in ARRAY order and deliberately does NOT sort. These
 * cases prove the executor honors the order it is handed; the sorting authority
 * belongs to preparation and is proven by cases 1 and 27.
 *
 * Attribution defaults to the step's own path, which is all a case observing
 * filesystem effects needs. The production relation, including a shared
 * synthetic parent serving several candidates, is proven from real plans in
 * case 28.
 */
function preparedOf(parts: {
  readonly removals?: readonly string[];
  readonly directories?: readonly string[];
  readonly leaves?: readonly { readonly path: string; readonly target: PathState }[];
  readonly indexWrites?: readonly { readonly path: string; readonly target: IndexState }[];
  readonly oracleIndex?: IndexSnapshot;
  readonly attribution?: ReadonlyMap<string, readonly string[]>;
}): PreparedSelectiveTransplant {
  const attributed = (path: string): readonly string[] => parts.attribution?.get(path) ?? [path];

  const removalsIn = parts.removals ?? [];
  const directoriesIn = parts.directories ?? [];
  const leavesIn = parts.leaves ?? [];
  const indexIn = parts.indexWrites ?? [];

  const directoryBase = removalsIn.length;
  const leafBase = directoryBase + directoriesIn.length;
  const indexBase = leafBase + leavesIn.length;

  const removals = removalsIn.map((path, i) => ({
    id: i,
    phase: "removal" as const,
    path,
    candidatePaths: attributed(path),
  }));
  const directories = directoriesIn.map((path, i) => ({
    id: directoryBase + i,
    phase: "directory" as const,
    path,
    candidatePaths: attributed(path),
  }));
  const leaves = leavesIn.map((leaf, i) => ({
    id: leafBase + i,
    phase: "leaf" as const,
    path: leaf.path,
    candidatePaths: attributed(leaf.path),
    target: leaf.target,
  }));
  const indexWrites = indexIn.map((write, i) => ({
    id: indexBase + i,
    phase: "index" as const,
    path: write.path,
    candidatePaths: attributed(write.path),
    target: write.target,
  }));

  const obligations: readonly ScheduledObligation[] = [
    ...removals,
    ...directories,
    ...leaves,
    ...indexWrites,
  ];

  const idsByCandidate = new Map<string, number[]>();
  for (const obligation of obligations) {
    for (const candidatePath of obligation.candidatePaths) {
      const ids = idsByCandidate.get(candidatePath) ?? [];
      ids.push(obligation.id);
      idsByCandidate.set(candidatePath, ids);
    }
  }
  const candidates = [...idsByCandidate.entries()]
    .map(([path, obligationIds]) => ({ path, changeGroupId: GROUP, obligationIds }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let indexPhase: PreparedIndexPhase = { kind: "none" };
  if (indexWrites.length > 0) {
    if (parts.oracleIndex === undefined) {
      throw new Error("fixture: index writes require an oracle snapshot");
    }
    indexPhase = { kind: "writes", writes: indexWrites, oracleIndex: parts.oracleIndex };
  }

  return { removals, directories, leaves, indexPhase, obligations, candidates };
}

// =============================================================================
// Section A: derivation and ordering
// =============================================================================

describe("prepareSelectiveTransplant: derivation and ordering", () => {
  it("1: derives the complete four-phase shape, ordered, with independent axes", async () => {
    // Real git, because this plan has index writes and preparation must read
    // the oracle's snapshot to agree with them.
    const fx = await setupGitRoot();
    try {
      await write(fx.root, "keep.txt", "kept\n");
      await git(fx.root, ["add", "-A"]);
      await git(fx.root, ["commit", "-m", "seed"]);
      const oracleIndex = await readIndexSnapshot(fx.root);
      const keptEntry = requireEntry(oracleIndex, "keep.txt");

      // Removals at two depths, directories at two depths, two leaves, and one
      // candidate that is worktree-identical but index-different.
      const classifications = [
        restoreRequired("top.txt", ABSENT, regular("top")),
        restoreRequired("a/b/deep.txt", ABSENT, regular("deep")),
        restoreRequired("m/leaf.txt", regular("before"), regular("after")),
        restoreRequired("z/leaf.txt", regular("before-z"), regular("after-z")),
        // Worktree identical on both sides; only the index moves. This is the
        // case that proves the two triggers are independent.
        restoreRequired(
          "keep.txt",
          withIndex(regular("kept\n"), keptEntry),
          withIndex(regular("kept\n"), { kind: "absent" }),
        ),
      ];
      // The synthetic parents' required candidates must themselves be
      // classified, or completeness and linkage would refuse them.
      const nested = restoreRequired("z/deeper/x.txt", regular("x"), regular("x2"));
      const full = planOf({
        classifications: [...classifications, nested],
        operations: [
          ...classifications.map(candidateOp),
          candidateOp(nested),
          parentOp("m", ["m/leaf.txt"]),
          parentOp("z/deeper", ["z/deeper/x.txt"]),
        ],
      });

      const prepared = await prepare(full, fx.root);

      // Removals: a candidate whose BEFORE worktree is absent is a removal, not
      // a leaf. Deepest first, ties lexical.
      expect(removalPaths(prepared)).toEqual(["a/b/deep.txt", "top.txt"]);
      // Directories: shallowest first.
      expect(directoryPaths(prepared)).toEqual(["m", "z/deeper"]);
      // Leaves: lexical.
      expect(leafPaths(prepared)).toEqual(["m/leaf.txt", "z/deeper/x.txt", "z/leaf.txt"]);
      // Index: only the axis that actually differs.
      expect(indexWritePaths(prepared)).toEqual(["keep.txt"]);

      // The independence property, stated directly: identical worktree means no
      // removal and no leaf, yet the index write is still scheduled.
      expect(removalPaths(prepared)).not.toContain("keep.txt");
      expect(leafPaths(prepared)).not.toContain("keep.txt");
    } finally {
      await fx.cleanup();
    }
  });

  it("2: the removal rule is the complement of what the primitives accept", async () => {
    const rows: readonly [string, PathState, PathState, boolean][] = [
      ["absent -> regular", ABSENT, regular("x"), false],
      ["regular -> regular", regular("now"), regular("before"), false],
      ["symlink -> symlink", symlinkState("now"), symlinkState("before"), false],
      ["regular -> absent", regular("now"), ABSENT, true],
      ["symlink -> regular", symlinkState("now"), regular("before"), true],
      ["directory -> regular", directoryState, regular("before"), true],
      ["directory -> absent", directoryState, ABSENT, true],
    ];

    for (const [label, observed, before, removalExpected] of rows) {
      const plan = planOf({ classifications: [restoreRequired("p.txt", before, observed)] });
      const prepared = await prepare(plan);
      expect(removalPaths(prepared), label).toEqual(removalExpected ? ["p.txt"] : []);
      // A present target always materializes; an absent one never does.
      expect(leafPaths(prepared), label).toEqual(
        before.worktree.kind === "absent" ? [] : ["p.txt"],
      );
    }
  });

  it("3: an index-identical candidate yields no index write, and no oracle read", async () => {
    // The converse of case 1's independence check. Bytes change, the index does
    // not, so phase 4 is empty -- and UNREAD_ORACLE proves the snapshot was
    // never fetched.
    const idx = entry("a".repeat(40));
    const plan = planOf({
      classifications: [
        restoreRequired(
          "p.txt",
          withIndex(regular("before"), idx),
          withIndex(regular("after"), idx),
        ),
      ],
    });

    const prepared = await prepare(plan);
    expect(leafPaths(prepared)).toEqual(["p.txt"]);
    expect(prepared.indexPhase).toEqual({ kind: "none" });
  });
});

// =============================================================================
// Section B: authorization
// =============================================================================
//
// These consume the plan fields that say a mutation is ALLOWED, as distinct from
// the fields that say what it would do. A field the scheduler ignores is a field
// a fabricated plan can lie about for free.

describe("prepareSelectiveTransplant: authorization", () => {
  it("4: a candidate from an unselected change group is refused", async () => {
    const plan = planOf({
      classifications: [restoreRequired("p.txt", ABSENT, regular("x"), OTHER_GROUP)],
      selectedChangeGroupIds: [GROUP],
    });

    await expect(prepare(plan)).rejects.toThrow(/which the plan did not select/);
  });

  it("5: an eligible plan carrying conflicts is refused", async () => {
    const plan = planOf({ classifications: [restoreRequired("p.txt", ABSENT, regular("x"))] });
    const withConflict = fabricated({
      ...plan,
      conflicts: [{ changeGroupId: GROUP, path: "other.txt", reason: { code: "MODIFIED_SINCE" } }],
    });

    await expect(prepare(withConflict)).rejects.toThrow(/carries unresolved conflicts/);
  });

  it("6: a conflicted classification is refused even when conflicts is empty", async () => {
    // The independent scan. A fabricated plan can empty `conflicts` while
    // leaving the conflicted classification in place.
    const plan = planOf({
      classifications: [
        restoreRequired("p.txt", ABSENT, regular("x")),
        {
          path: "bad.txt",
          changeGroupId: GROUP,
          expectedBefore: ABSENT,
          expectedAfter: regular("y"),
          observed: regular("y"),
          outcome: { kind: "conflict", reason: { code: "MODIFIED_SINCE" } },
        },
      ],
    });
    expect(plan.conflicts).toEqual([]);

    await expect(prepare(plan)).rejects.toThrow(/carries a conflicted classification/);
  });

  it("7: a symlink target is refused when the plan lacked symlink capability", async () => {
    const plan = planOf({
      classifications: [restoreRequired("link", symlinkState("target"), regular("now"))],
      symlinkCheckout: false,
    });

    await expect(prepare(plan)).rejects.toThrow(/without symlink-checkout capability/);
  });

  it("8: unsafe mutation paths are refused BEFORE the oracle is read", async () => {
    // Each plan below also carries an index write, so a correct implementation
    // would otherwise reach `readIndexSnapshot(UNREAD_ORACLE)`. Getting the
    // path-safety message rather than ENOENT is what proves the ordering.
    const idx = entry("b".repeat(40));
    for (const bad of [".git", ".git/config", "../escape.txt", ".viberevert/objects/x"]) {
      const plan = planOf({
        classifications: [
          restoreRequired(
            bad,
            withIndex(regular("before"), idx),
            withIndex(regular("after"), { kind: "absent" }),
          ),
        ],
      });
      // The shared authority's own message, not a restatement of its rules.
      await expect(prepare(plan), bad).rejects.toThrow(/prepareSelectiveTransplant:/);
    }

    // And specifically the mutation-only rule this scheduler must inherit.
    const gitPlan = planOf({
      classifications: [restoreRequired(".git/config", ABSENT, regular("x"))],
    });
    await expect(prepare(gitPlan)).rejects.toThrow(/Git control metadata/);
  });
});

// =============================================================================
// Section C: evidence linkage
// =============================================================================

describe("prepareSelectiveTransplant: evidence linkage", () => {
  it("9: an operation must match a classification on every field", async () => {
    const good = restoreRequired("p.txt", ABSENT, regular("now"));

    const rows: readonly [string, SelectiveRestorePlan, RegExp][] = [
      [
        "no classification",
        planOf({ classifications: [], operations: [candidateOp(good)] }),
        /no matching classification/,
      ],
      [
        "group disagreement",
        planOf({
          classifications: [good],
          operations: [{ ...candidateOp(good), changeGroupId: OTHER_GROUP }],
          selectedChangeGroupIds: [GROUP, OTHER_GROUP],
        }),
        /disagree on the change group/,
      ],
      [
        "observed disagreement",
        planOf({
          classifications: [good],
          operations: [{ ...candidateOp(good), observed: regular("something-else") }],
        }),
        /observed state differs from its classification/,
      ],
      [
        "target disagreement",
        planOf({
          classifications: [good],
          operations: [{ ...candidateOp(good), target: regular("not-the-before") }],
        }),
        /target differs from its classification's expectedBefore/,
      ],
      [
        "already_at_before classification",
        planOf({
          classifications: [
            { ...good, outcome: { kind: "planned", disposition: "already_at_before" } },
          ],
          operations: [candidateOp(good)],
        }),
        /not a planned restore_required candidate/,
      ],
    ];

    for (const [label, plan, message] of rows) {
      await expect(prepare(plan), label).rejects.toThrow(message);
    }
  });

  it("10: a classification must satisfy stage A's own relation", async () => {
    const path = "p.txt";
    const before = ABSENT;
    const after = regular("now");

    // observed != expectedAfter: stage A returns restore_required only where
    // they are equal.
    const notAfter: SelectiveRestoreClassification = {
      path,
      changeGroupId: GROUP,
      expectedBefore: before,
      expectedAfter: after,
      observed: regular("drifted"),
      outcome: { kind: "planned", disposition: "restore_required" },
    };
    await expect(prepare(planOf({ classifications: [notAfter] }))).rejects.toThrow(
      /not its recorded AFTER state/,
    );

    // observed == expectedBefore: already_at_before is tested FIRST, so stage A
    // could never have reached restore_required here.
    const atBefore: SelectiveRestoreClassification = {
      path,
      changeGroupId: GROUP,
      expectedBefore: after,
      expectedAfter: after,
      observed: after,
      outcome: { kind: "planned", disposition: "restore_required" },
    };
    await expect(prepare(planOf({ classifications: [atBefore] }))).rejects.toThrow(
      /already at its BEFORE state/,
    );
  });

  it("11: every restore_required classification must have an operation", async () => {
    // The other direction of the link. Executing one of two classified
    // candidates would silently apply half of what the evidence covers.
    const a = restoreRequired("a.txt", ABSENT, regular("a"));
    const b = restoreRequired("b.txt", ABSENT, regular("b"));
    const plan = planOf({ classifications: [a, b], operations: [candidateOp(a)] });

    await expect(prepare(plan)).rejects.toThrow(/"b\.txt".*no restore-candidate operation/);
  });

  it("12: duplicate operations and duplicate classifications are refused", async () => {
    const c = restoreRequired("p.txt", ABSENT, regular("now"));

    await expect(
      prepare(planOf({ classifications: [c], operations: [candidateOp(c), candidateOp(c)] })),
    ).rejects.toThrow(/two operations name the same physical path/);

    await expect(
      prepare(planOf({ classifications: [c, c], operations: [candidateOp(c)] })),
    ).rejects.toThrow(/two classifications name the same physical path/);
  });
});

// =============================================================================
// Section D: synthetic parent authority
// =============================================================================

describe("prepareSelectiveTransplant: synthetic parent authority", () => {
  const child = restoreRequired("dir/leaf.txt", regular("before"), regular("now"));

  it("13: a synthetic parent's shape is exactly create-absent-directory", async () => {
    const rows: readonly [string, SelectiveRestoreOperation, RegExp][] = [
      [
        "observed not absent",
        parentOp("dir", ["dir/leaf.txt"], regular("in-the-way")),
        /observed as regular rather than absent/,
      ],
      [
        "target not a directory",
        {
          ...parentOp("dir", ["dir/leaf.txt"]),
          target: regular("not-a-directory"),
        },
        /a synthetic parent targets regular/,
      ],
      [
        "carries an index transition",
        {
          ...parentOp("dir", ["dir/leaf.txt"]),
          target: { worktree: { kind: "directory" }, index: entry("c".repeat(40)) },
        },
        /carries an index transition/,
      ],
    ];

    for (const [label, op, message] of rows) {
      const plan = planOf({ classifications: [child], operations: [candidateOp(child), op] });
      await expect(prepare(plan), label).rejects.toThrow(message);
    }

    // Sharing a path with a classification: C1b skips ancestors that are
    // themselves candidates, so this cannot arise from a real planner. The
    // classification must be `already_at_before`, which needs no operation of
    // its own -- otherwise the duplicate-operation check fires first and this
    // branch is never reached.
    const ancestor: SelectiveRestoreClassification = {
      path: "dir",
      changeGroupId: GROUP,
      expectedBefore: directoryState,
      expectedAfter: directoryState,
      observed: directoryState,
      outcome: { kind: "planned", disposition: "already_at_before" },
    };
    await expect(
      prepare(
        planOf({
          classifications: [child, ancestor],
          operations: [candidateOp(child), parentOp("dir", ["dir/leaf.txt"])],
        }),
      ),
    ).rejects.toThrow(/shares its path with a classification/);
  });

  it("14: requiredBy must name candidates this parent genuinely supports", async () => {
    const elsewhere = restoreRequired("other/leaf.txt", regular("before"), regular("now"));
    const removalOnly = restoreRequired("dir/gone.txt", ABSENT, regular("now"));

    const rows: readonly [string, SelectiveRestorePlan, RegExp][] = [
      [
        "empty",
        planOf({
          classifications: [child],
          operations: [candidateOp(child), parentOp("dir", [])],
        }),
        /names no candidate requiring it/,
      ],
      [
        "not a candidate",
        planOf({
          classifications: [child],
          operations: [candidateOp(child), parentOp("dir", ["dir/never-planned.txt"])],
        }),
        /which is not a restore candidate/,
      ],
      [
        "not beneath",
        planOf({
          classifications: [child, elsewhere],
          operations: [
            candidateOp(child),
            candidateOp(elsewhere),
            parentOp("dir", ["other/leaf.txt"]),
          ],
        }),
        /which is not beneath it/,
      ],
      [
        "restores no worktree node",
        planOf({
          classifications: [child, removalOnly],
          operations: [
            candidateOp(child),
            candidateOp(removalOnly),
            parentOp("dir", ["dir/gone.txt"]),
          ],
        }),
        /which restores no worktree node/,
      ],
    ];

    for (const [label, plan, message] of rows) {
      await expect(prepare(plan), label).rejects.toThrow(message);
    }
  });

  it("15: authority does not depend on operation order", async () => {
    // The planner sorts operations lexically, so `dir` precedes `dir/leaf.txt`.
    // Validating in array order would fail on ordering rather than authority,
    // which is why derivation runs in two passes.
    const parentFirst = planOf({
      classifications: [child],
      operations: [parentOp("dir", ["dir/leaf.txt"]), candidateOp(child)],
    });
    const parentLast = planOf({
      classifications: [child],
      operations: [candidateOp(child), parentOp("dir", ["dir/leaf.txt"])],
    });

    for (const plan of [parentFirst, parentLast]) {
      const prepared = await prepare(plan);
      expect(directoryPaths(prepared)).toEqual(["dir"]);
      expect(leafPaths(prepared)).toEqual(["dir/leaf.txt"]);
    }
  });
});

// =============================================================================
// Section E: shape
// =============================================================================

describe("prepareSelectiveTransplant: shape", () => {
  it("16: a plan that is not eligible is refused", async () => {
    for (const outcome of ["noop", "conflicted"]) {
      const plan = fabricated({
        outcome,
        capabilities: { symlinkCheckout: true },
        selectedChangeGroupIds: [GROUP],
        classifications: [],
        topologyDependencyPaths: [],
        operations: [],
        conflicts: [],
      });
      await expect(prepare(plan), outcome).rejects.toThrow(/requires an eligible plan/);
    }
  });

  it("17: unsupported states and directory targets are refused", async () => {
    const rows: readonly [string, PathState, PathState, RegExp][] = [
      [
        "observed unsupported",
        unsupportedState,
        regular("before"),
        /observed worktree state is unsupported/,
      ],
      [
        "target unsupported",
        regular("now"),
        unsupportedState,
        /target worktree state is unsupported/,
      ],
      ["target directory", regular("now"), directoryState, /belongs to create_parent_directory/],
    ];

    for (const [label, observed, before, message] of rows) {
      const plan = planOf({ classifications: [restoreRequired("p.txt", before, observed)] });
      await expect(prepare(plan), label).rejects.toThrow(message);
    }
  });

  it("18: index states outside 10D's transplantable set are refused", async () => {
    const unmerged: IndexState = { kind: "unmerged", entries: [] };
    const gitlink = entry("d".repeat(40), "160000");

    const rows: readonly [string, PathState, PathState, RegExp][] = [
      [
        "observed unmerged",
        withIndex(regular("now"), unmerged),
        regular("before"),
        /the observed entry is unmerged/,
      ],
      [
        "target unmerged",
        regular("now"),
        withIndex(regular("before"), unmerged),
        /the target entry is unmerged/,
      ],
      [
        "observed gitlink",
        withIndex(regular("now"), gitlink),
        regular("before"),
        /the observed entry is a gitlink/,
      ],
      [
        "target gitlink",
        regular("now"),
        withIndex(regular("before"), gitlink),
        /the target entry is a gitlink/,
      ],
    ];

    for (const [label, observed, before, message] of rows) {
      const plan = planOf({ classifications: [restoreRequired("p.txt", before, observed)] });
      await expect(prepare(plan), label).rejects.toThrow(message);
    }
  });

  it("19: a schedule deriving zero mutations is refused", async () => {
    // A plan with no operations at all. The per-candidate checks cannot fire,
    // so this is the backstop doing its job.
    const plan = planOf({ classifications: [], operations: [] });

    await expect(prepare(plan)).rejects.toThrow(/derived no mutations/);
  });
});

// =============================================================================
// Section F: oracle index
// =============================================================================

describe("prepareSelectiveTransplant: oracle index", () => {
  it("20: no index writes means the oracle is never read", async () => {
    // UNREAD_ORACLE does not exist. Preparation succeeding proves the read is
    // conditional rather than unconditional.
    const plan = planOf({
      classifications: [restoreRequired("p.txt", regular("before"), regular("now"))],
    });
    await expect(lstat(UNREAD_ORACLE)).rejects.toThrow();

    const prepared = await prepare(plan);
    expect(prepared.indexPhase).toEqual({ kind: "none" });
    expect(leafPaths(prepared)).toEqual(["p.txt"]);
  });

  it("21: an oracle contradicting the plan's index target is refused in PREPARATION", async () => {
    const fx = await setupGitRoot();
    try {
      await write(fx.root, "k.txt", "real\n");
      await git(fx.root, ["add", "-A"]);
      await git(fx.root, ["commit", "-m", "seed"]);

      // The plan asserts an index entry the oracle does not hold.
      const bogus = entry("e".repeat(40));
      const plan = planOf({
        classifications: [
          restoreRequired(
            "k.txt",
            withIndex(regular("real\n"), bogus),
            withIndex(regular("real\n"), { kind: "absent" }),
          ),
        ],
      });

      await expect(prepare(plan, fx.root)).rejects.toThrow(
        /the oracle's index entry does not match the state the plan restores/,
      );
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section G: execution
// =============================================================================
//
// `PreparedSelectiveTransplant` is exported, so these build the prepared value
// directly through `preparedOf`. That isolates the mutation phases from
// preparation, and keeps the worktree cases on plain directories.
//
// Each case supplies a REAL accumulator built by `createTransplantProgress`,
// because the gate's contract is that the executor never receives one it did
// not construct. A stub sink here would test an arrangement production forbids.

describe("executePreparedSelectiveTransplant", () => {
  it("22: a mixed transplant removes, creates, and materializes", async () => {
    const fx = await setupRoots();
    try {
      await write(fx.repo, "gone.txt", "delete me\n");
      await write(fx.oracle, "new/leaf.txt", "materialized\n");

      const prepared = preparedOf({
        removals: ["gone.txt"],
        directories: ["new"],
        leaves: [{ path: "new/leaf.txt", target: regular("materialized\n") }],
      });
      const progress = createTransplantProgress(prepared.obligations, prepared.candidates);
      await executePreparedSelectiveTransplant(fx.repo, fx.oracle, prepared, progress);

      await expect(lstat(join(fx.repo, "gone.txt"))).rejects.toThrow();
      expect((await lstat(join(fx.repo, "new"))).isDirectory()).toBe(true);
      expect(await readFile(join(fx.repo, "new", "leaf.txt"), "utf8")).toBe("materialized\n");
      // A completed run leaves every obligation completed.
      expect(progress.snapshot().states).toEqual(["completed", "completed", "completed"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("23: removals run deepest-first, so a directory is empty when removed", async () => {
    const fx = await setupRoots();
    try {
      await write(fx.repo, "a/b/c.txt", "child\n");

      // `removeWorktreePath` uses `rmdir` and refuses ENOTEMPTY, so the reverse
      // order could not succeed.
      const prepared = preparedOf({ removals: ["a/b/c.txt", "a/b", "a"] });
      const progress = createTransplantProgress(prepared.obligations, prepared.candidates);
      await executePreparedSelectiveTransplant(fx.repo, fx.oracle, prepared, progress);

      await expect(lstat(join(fx.repo, "a"))).rejects.toThrow();
    } finally {
      await fx.cleanup();
    }
  });

  it("24: directories are created shallowest-first, so parents exist first", async () => {
    const fx = await setupRoots();
    try {
      // `createWorktreeDirectory` uses a non-recursive `mkdir`, so the reverse
      // order could not succeed.
      const prepared = preparedOf({ directories: ["x", "x/y", "x/y/z"] });
      const progress = createTransplantProgress(prepared.obligations, prepared.candidates);
      await executePreparedSelectiveTransplant(fx.repo, fx.oracle, prepared, progress);

      expect((await lstat(join(fx.repo, "x", "y", "z"))).isDirectory()).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("25: the index phase runs AFTER the entire worktree phase", async () => {
    const fx = await setupGitRoot();
    const dirs = await setupRoots();
    try {
      await write(fx.root, "k.txt", "v1\n");
      await git(fx.root, ["add", "-A"]);
      await git(fx.root, ["commit", "-m", "seed"]);
      // The state the index write would install, captured before it moves.
      const oracleIndex = await readIndexSnapshot(fx.root);
      const v1Entry = requireEntry(oracleIndex, "k.txt");

      // Move the real index somewhere else, so installing v1 would be visible.
      await write(fx.root, "k.txt", "v2\n");
      await git(fx.root, ["add", "k.txt"]);
      const staged = await readIndexSnapshot(fx.root);
      expect(requireEntry(staged, "k.txt")).not.toEqual(v1Entry);

      // Break phase 3: a directory sits where a leaf must be materialized, which
      // `materializeWorktreeLeaf` refuses as "phase 1 should have removed" it.
      await mkdir(join(fx.root, "blocked.txt"), { recursive: true });
      await write(dirs.oracle, "blocked.txt", "leaf bytes\n");

      const prepared = preparedOf({
        leaves: [{ path: "blocked.txt", target: regular("leaf bytes\n") }],
        indexWrites: [{ path: "k.txt", target: v1Entry }],
        oracleIndex,
      });
      const progress = createTransplantProgress(prepared.obligations, prepared.candidates);

      await expect(
        executePreparedSelectiveTransplant(fx.root, dirs.oracle, prepared, progress),
      ).rejects.toThrow(/is in the way/);

      // The load-bearing assertion: phase 4 never ran, so the real index is
      // exactly where the worktree phase found it. If phase 4 ever moves ahead
      // of phase 3, this becomes `v1Entry` and fails.
      const after = await readIndexSnapshot(fx.root);
      expect(requireEntry(after, "k.txt")).toEqual(requireEntry(staged, "k.txt"));
    } finally {
      await dirs.cleanup();
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section H: source invariant
// =============================================================================

describe("source invariant", () => {
  it("26: the post-marker region is exactly four primitives and their bookkeeping", async () => {
    const source = await readFile(
      new URL("../src/transplant-schedule.ts", import.meta.url),
      "utf8",
    );

    const start = source.indexOf("export async function executePreparedSelectiveTransplant(");
    expect(start).toBeGreaterThan(-1);
    // Slice AFTER the signature, so the function's own name is not counted as a
    // call by the scan below.
    const signatureEnd = source.indexOf("): Promise<void> {", start);
    expect(signatureEnd).toBeGreaterThan(start);
    const end = source.indexOf("\n}\n", signatureEnd);
    expect(end).toBeGreaterThan(signatureEnd);
    const body = source.slice(signatureEnd, end);

    // ORDERED, not merely a set: this pins §13's four phases at the call
    // boundary, while cases 23 to 25 prove at runtime why the order matters.
    const awaited = [...body.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    expect(awaited).toEqual([
      "removeWorktreePath",
      "createWorktreeDirectory",
      "materializeWorktreeLeaf",
      "transplantIndexPath",
    ]);

    // EVERY call, not only the awaited ones. Without this a future SYNCHRONOUS
    // `validateSomething()` would reintroduce a deterministic post-marker
    // refusal while still satisfying the assertion above.
    const keywords = new Set(["if", "for", "while", "switch", "catch", "return", "typeof"]);
    const called = new Set(
      [...body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined && !keywords.has(name)),
    );
    expect([...called].sort()).toEqual([
      "createWorktreeDirectory",
      "materializeWorktreeLeaf",
      "progress.markAttempted",
      "progress.markCompleted",
      "removeWorktreePath",
      "transplantIndexPath",
    ]);

    // The F3 ordering rule, structurally rather than by convention: every
    // primitive is bracketed by its own marks, and ATTEMPTED is recorded before
    // the primitive runs, because a primitive may mutate and still fail.
    const bracketed = [
      ...body.matchAll(
        /progress\.markAttempted\(step\.id\);\s*await\s+([A-Za-z_$][\w$]*)\([^;]*\);\s*progress\.markCompleted\(step\.id\);/g,
      ),
    ].map((m) => m[1]);
    expect(bracketed).toEqual([
      "removeWorktreePath",
      "createWorktreeDirectory",
      "materializeWorktreeLeaf",
      "transplantIndexPath",
    ]);

    // Nothing between the marker and the first mutation may deterministically
    // refuse.
    expect(body).not.toContain("throw");
    expect(body).not.toMatch(/\breturn\b/);
  });
});

// =============================================================================
// Section I: obligation graph
// =============================================================================
//
// Built from REAL plans rather than hand-assembled values, because the point is
// what preparation derives, not what a fixture can assert about itself.

describe("the obligation graph", () => {
  it("27: ids are dense and follow execution order across all four phases", async () => {
    const fx = await setupGitRoot();
    try {
      await write(fx.root, "keep.txt", "kept\n");
      await git(fx.root, ["add", "-A"]);
      await git(fx.root, ["commit", "-m", "seed"]);
      const oracleIndex = await readIndexSnapshot(fx.root);
      const keptEntry = requireEntry(oracleIndex, "keep.txt");

      const classifications = [
        restoreRequired("top.txt", ABSENT, regular("top")),
        restoreRequired("m/leaf.txt", regular("before"), regular("after")),
        restoreRequired(
          "keep.txt",
          withIndex(regular("kept\n"), keptEntry),
          withIndex(regular("kept\n"), { kind: "absent" }),
        ),
      ];
      const plan = planOf({
        classifications,
        operations: [...classifications.map(candidateOp), parentOp("m", ["m/leaf.txt"])],
      });

      const prepared = await prepare(plan, fx.root);

      // Dense: the table is indexed by its own ids, with no gaps.
      expect(prepared.obligations.map((o) => o.id)).toEqual(prepared.obligations.map((_, i) => i));

      // And that order IS execution order: removals, directories, leaves, index.
      expect(prepared.obligations.map((o) => [o.phase, o.path])).toEqual([
        ["removal", "top.txt"],
        ["directory", "m"],
        ["leaf", "m/leaf.txt"],
        ["index", "keep.txt"],
      ]);

      // The flattened table is an INDEX over the execution program, not a
      // parallel description. Every phase entry is the exact object reachable
      // through its obligation id.
      const phaseSteps = [
        ...prepared.removals,
        ...prepared.directories,
        ...prepared.leaves,
        ...(prepared.indexPhase.kind === "writes" ? prepared.indexPhase.writes : []),
      ];
      for (const step of phaseSteps) {
        expect(prepared.obligations[step.id]).toBe(step);
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("28: attribution is reciprocal, and the table holds the phase-step objects", async () => {
    const a = restoreRequired("src/a.ts", regular("a-before"), regular("a-after"));
    const b = restoreRequired("src/b.ts", regular("b-before"), regular("b-after"));
    const plan = planOf({
      classifications: [a, b],
      operations: [candidateOp(a), candidateOp(b), parentOp("src", ["src/a.ts", "src/b.ts"])],
    });

    const prepared = await prepare(plan);

    const parent = prepared.directories[0];
    if (parent === undefined) throw new Error("fixture: expected a synthetic parent");
    expect(parent.path).toBe("src");
    // The one many-to-many case: a shared parent serves BOTH candidates, so its
    // failure can later mark both incomplete.
    expect([...parent.candidatePaths].sort()).toEqual(["src/a.ts", "src/b.ts"]);

    expect(prepared.candidates.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"]);
    for (const candidate of prepared.candidates) {
      // Reverse direction: the shared parent appears in every record it serves.
      expect(candidate.obligationIds).toContain(parent.id);
      expect([...candidate.obligationIds]).toEqual(
        [...candidate.obligationIds].sort((x, y) => x - y),
      );
      // Forward direction: every id named attributes back to this candidate.
      for (const id of candidate.obligationIds) {
        const obligation = prepared.obligations[id];
        if (obligation === undefined) throw new Error(`fixture: no obligation ${id}`);
        expect(obligation.candidatePaths).toContain(candidate.path);
      }
    }

    // IDENTITY, not equality. The table is a view over the execution program,
    // never a parallel description that could drift from it.
    expect(prepared.obligations[parent.id]).toBe(parent);
    for (const leaf of prepared.leaves) {
      expect(prepared.obligations[leaf.id]).toBe(leaf);
    }
  });

  it("29: a primitive failure leaves exactly one obligation attempted", async () => {
    const fx = await setupRoots();
    try {
      await write(fx.repo, "gone.txt", "delete me\n");
      await write(fx.oracle, "a.txt", "a\n");
      await write(fx.oracle, "blocked.txt", "blocked\n");
      // A directory where a leaf must be materialized, which
      // `materializeWorktreeLeaf` refuses, exactly as in case 25.
      await mkdir(join(fx.repo, "blocked.txt"), { recursive: true });

      const prepared = preparedOf({
        removals: ["gone.txt"],
        directories: ["new"],
        leaves: [
          { path: "a.txt", target: regular("a\n") },
          { path: "blocked.txt", target: regular("blocked\n") },
          { path: "z.txt", target: regular("never\n") },
        ],
      });
      const progress = createTransplantProgress(prepared.obligations, prepared.candidates);

      await expect(
        executePreparedSelectiveTransplant(fx.repo, fx.oracle, prepared, progress),
      ).rejects.toThrow(/is in the way/);

      // The RAW fact from which `failed` versus `not_attempted` is later
      // derived. Nothing here classifies anything: that belongs to the evidence
      // layer, and is proven separately.
      expect(progress.snapshot().states).toEqual([
        "completed", // gone.txt removal
        "completed", // new directory
        "completed", // a.txt leaf
        "attempted", // blocked.txt leaf: reached, refused, never completed
        "pending", // z.txt leaf: never reached
      ]);
    } finally {
      await fx.cleanup();
    }
  });
});
