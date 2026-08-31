// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the protected domain (M 0.8.0 step 10B, §9/§10 revision 13).
//
// Four sections:
//   A. capture -- the protected path set (REAL repository, hand-built plans)
//   B. capture -- topology watches       (REAL repository, hand-built plans)
//   C. comparison                        (pure, no repository)
//   D. source invariant                  (the state-only capture enumerates
//                                          nothing)
//
// Plans are hand-built typed literals rather than produced by
// `planSelectiveRestore`. The planner is proven in restore-selective.test.ts;
// here the plan is INPUT, and building it directly is the only way to exercise
// shapes the planner would refuse to emit -- a destructive root that stopped
// being a directory, a watch parent observed as a regular file, an index-only
// candidate. A failure here is attributable to the protected domain.
//
// The repository is real because capture OBSERVES reality: readIndexSnapshot,
// observePathState, gitListUntracked, and raw readdir. Typed literals cannot
// exercise it.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { observePathState, readIndexSnapshot } from "../src/path-state.js";
import {
  captureProtectedDomain,
  compareProtectedDomainSnapshots,
  compareProtectedStateMaps,
  type ProtectedDomainSnapshot,
  protectedDomainUnchanged,
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

/**
 * `withStore` controls whether `.gitignore` carries the `.viberevert/` line.
 * The live-store false-positive test deliberately omits it: Windows matches
 * ignore patterns case-insensitively, so `.viberevert/` would also ignore a
 * genuine user directory named `.VIBEREVERT/` and the test would pass for the
 * wrong reason on one platform and the right reason on another.
 */
async function setupRepo(withStore = true): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-domainfixture-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), withStore ? ".viberevert/\n" : "\n");
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

// ---- Plan construction ------------------------------------------------------

function classificationAt(
  path: string,
  observed: PathState,
  expectedBefore: PathState,
  disposition: "restore_required" | "already_at_before" = "restore_required",
): SelectiveRestoreClassification {
  return {
    path,
    changeGroupId: GROUP,
    expectedBefore,
    expectedAfter: observed,
    observed,
    outcome: { kind: "planned", disposition },
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
  requiredBy: string,
): SelectiveRestoreOperation {
  return {
    kind: "create_parent_directory",
    path,
    target: { worktree: { kind: "directory" }, index: observed.index },
    observed,
    requiredBy: [requiredBy],
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

const watchAt = (snapshot: ProtectedDomainSnapshot, path: string): TopologyWatch => {
  const watch = snapshot.topologyWatches.get(path);
  if (watch === undefined) throw new Error(`no topology watch at ${JSON.stringify(path)}`);
  return watch;
};

const memberPaths = (watch: TopologyWatch): readonly string[] => watch.members.map((m) => m.path);

// =============================================================================
// Section A: the protected path set
// =============================================================================

describe("captureProtectedDomain: protected path set", () => {
  it("1: both rename aliases of the selected footprint are protected", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "new.ts", "moved\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const plan = eligiblePlan({
        classifications: [
          classificationAt("old.ts", ABSENT_PATH_STATE, regularState("moved\n")),
          classificationAt(
            "new.ts",
            await currentState(repo.repoRoot, "new.ts"),
            ABSENT_PATH_STATE,
          ),
        ],
      });

      const { states } = await capture(repo, plan);
      expect(states.has("old.ts")).toBe(true);
      expect(states.has("new.ts")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("2: an already_at_before classification is still protected", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "stable.ts", "same\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observed = await currentState(repo.repoRoot, "stable.ts");

      // No operation: nothing writes it. It must still be frozen, because the
      // transaction must not let it move either.
      const plan = eligiblePlan({
        classifications: [classificationAt("stable.ts", observed, observed, "already_at_before")],
      });

      const { states } = await capture(repo, plan);
      expect(states.has("stable.ts")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("3: a synthetic create_parent_directory path is protected", async () => {
    const repo = await setupRepo();
    try {
      const plan = eligiblePlan({
        classifications: [
          classificationAt("a/b.txt", ABSENT_PATH_STATE, regularState("restored\n")),
        ],
        operations: [
          restoreOp("a/b.txt", ABSENT_PATH_STATE, regularState("restored\n")),
          parentOp("a", ABSENT_PATH_STATE, "a/b.txt"),
        ],
      });

      const { states } = await capture(repo, plan);
      expect(states.get("a")?.worktree.kind).toBe("absent");
    } finally {
      await repo.cleanup();
    }
  });

  it("4: topologyDependencyPaths are protected", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "keep/child.txt", "x\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const plan = eligiblePlan({ topologyDependencyPaths: ["keep"] });
      const { states } = await capture(repo, plan);
      expect(states.get("keep")?.worktree.kind).toBe("directory");
    } finally {
      await repo.cleanup();
    }
  });

  it("5: the parent of a PURE REMOVAL is protected, though stage C1b skips it", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "dir/gone.txt", "delete me\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observed = await currentState(repo.repoRoot, "dir/gone.txt");

      // BEFORE worktree is ABSENT, so C1b's ancestor loop skips `dir` entirely
      // and it reaches neither topologyDependencyPaths nor a synthetic parent.
      // Git never tracks directories, so bucket 5 cannot supply it either.
      // Bucket 4 is the only reason it is in S.
      const plan = eligiblePlan({
        classifications: [classificationAt("dir/gone.txt", observed, ABSENT_PATH_STATE)],
        operations: [restoreOp("dir/gone.txt", observed, ABSENT_PATH_STATE)],
      });

      const { states } = await capture(repo, plan);
      expect(states.get("dir")?.worktree.kind).toBe("directory");
    } finally {
      await repo.cleanup();
    }
  });

  it("6: an unselected TRACKED path is protected", async () => {
    const repo = await setupRepo();
    try {
      const { states } = await capture(repo, eligiblePlan({}));
      expect(states.has("README.md")).toBe(true);
      expect(states.has(".gitignore")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("7: an unselected NON-EXCLUDED untracked path is protected", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "scratch.txt", "untracked\n");
      const { states } = await capture(repo, eligiblePlan({}));
      expect(states.get("scratch.txt")?.worktree.kind).toBe("regular");
    } finally {
      await repo.cleanup();
    }
  });

  it("8: a GITIGNORED untracked path is NOT protected", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, ".gitignore", ".viberevert/\nbuild/\n");
      await write(repo, "build/out.js", "generated\n");
      const { states } = await capture(repo, eligiblePlan({}));
      expect(states.has("build/out.js")).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("9: a rollback.exclude-matched untracked path is NOT protected", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "cache.tmp", "transient\n");
      await write(repo, "kept.txt", "real\n");

      const { states } = await capture(repo, eligiblePlan({}), ["*.tmp"]);
      expect(states.has("cache.tmp")).toBe(false);
      expect(states.has("kept.txt")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("10: .viberevert/** is excluded even with its .gitignore line removed", async () => {
    const repo = await setupRepo();
    try {
      // Independent hard-exclusion: without it, removing the ignore line would
      // let the protected domain observe VibeRevert's own store.
      await write(repo, ".gitignore", "\n");
      await write(repo, ".viberevert/objects/ab/cdef", "internal\n");

      const { states } = await capture(repo, eligiblePlan({}));
      expect([...states.keys()].some((p) => p.startsWith(".viberevert/"))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("11: a force-added TRACKED .viberevert path is still excluded", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, ".viberevert/sessions/x.json", "{}\n");
      await git(repo.repoRoot, ["add", "-f", ".viberevert/sessions/x.json"]);

      const { states } = await capture(repo, eligiblePlan({}));
      expect(states.has(".viberevert/sessions/x.json")).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("12: ordinary paths merely RESEMBLING the store stay protected", async () => {
    // Locks why File 6 uses `isViberevertStorePath` (exact case, root-anchored)
    // rather than restore-preflight's case-folding hostile-evidence predicate.
    // Both paths are TRACKED so they enter through the index, independent of
    // whether any platform's ignore matching would hide them.
    const repo = await setupRepo(false);
    try {
      await write(repo, ".VIBEREVERT/user.txt", "my data\n");
      await write(repo, "src/.viberevert/x", "nested user dir\n");
      await git(repo.repoRoot, ["add", "-f", ".VIBEREVERT/user.txt", "src/.viberevert/x"]);

      const { states } = await capture(repo, eligiblePlan({}));
      expect(states.has(".VIBEREVERT/user.txt")).toBe(true);
      expect(states.has("src/.viberevert/x")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("13: a SELECTED path inside the store throws", async () => {
    const repo = await setupRepo();
    try {
      const plan = eligiblePlan({
        classifications: [
          classificationAt(".viberevert/objects/ab", ABSENT_PATH_STATE, regularState("x\n")),
        ],
      });
      await expect(capture(repo, plan)).rejects.toThrow(/VibeRevert's own store/);
    } finally {
      await repo.cleanup();
    }
  });

  it("14: a noop plan and a conflicted plan both throw", async () => {
    const repo = await setupRepo();
    try {
      const noop: SelectiveRestorePlan = {
        outcome: "noop",
        capabilities: { symlinkCheckout: true },
        selectedChangeGroupIds: [GROUP],
        classifications: [],
        topologyDependencyPaths: [],
        operations: [],
        conflicts: [],
      };
      const conflicted: SelectiveRestorePlan = {
        outcome: "conflicted",
        capabilities: { symlinkCheckout: true },
        selectedChangeGroupIds: [GROUP],
        classifications: [],
        topologyDependencyPaths: [],
        operations: [],
        conflicts: [{ changeGroupId: GROUP, path: "x", reason: { code: "MODIFIED_SINCE" } }],
      };

      await expect(capture(repo, noop)).rejects.toThrow(/requires an eligible plan/);
      await expect(capture(repo, conflicted)).rejects.toThrow(/requires an eligible plan/);
    } finally {
      await repo.cleanup();
    }
  });

  it("15: S is FRESHLY observed, not copied from classification.observed", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "edited.ts", "phase one\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const atPlanningTime = await currentState(repo.repoRoot, "edited.ts");

      // The human edits between phase 1 and S. Reusing `classification.observed`
      // would make plan stabilization compare a value with itself and never see
      // this.
      await write(repo, "edited.ts", "phase two, edited by a human\n");

      const plan = eligiblePlan({
        classifications: [classificationAt("edited.ts", atPlanningTime, regularState("before\n"))],
      });

      const { states } = await capture(repo, plan);
      const frozen = states.get("edited.ts");
      expect(frozen).toBeDefined();
      expect(frozen).not.toEqual(atPlanningTime);
      expect(frozen?.worktree).toEqual((await currentState(repo.repoRoot, "edited.ts")).worktree);
    } finally {
      await repo.cleanup();
    }
  });

  it("16: an unsupported worktree state stays in the managed domain (POSIX)", async (ctx) => {
    // Revision 11. Sockets and FIFOs cannot be created on Windows, so this runs
    // on CI's Linux and macOS legs only, like the symlink arms in Open items.
    if (process.platform === "win32") ctx.skip();

    const repo = await setupRepo();
    try {
      // Tracked FIRST as an ordinary file, so the path enters the managed
      // domain through the INDEX. That makes the assertion independent of
      // whether git would enumerate an untracked socket at all.
      await write(repo, "daemon.sock", "placeholder\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "track the path"]);

      const abs = join(repo.repoRoot, "daemon.sock");
      await rm(abs, { force: true });
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(abs, resolve));
      try {
        const { states } = await capture(repo, eligiblePlan({}));
        const frozen = states.get("daemon.sock");
        expect(frozen).toBeDefined();
        expect(frozen?.worktree.kind).toBe("unsupported");
        expect(frozen?.index.kind).toBe("entry");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section B: topology watches
// =============================================================================

describe("captureProtectedDomain: topology watches", () => {
  it("17: a destructive root gets a RECURSIVE watch over its full subtree", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "d/one.txt", "1\n");
      await write(repo, "d/deep/two.txt", "2\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observed = await currentState(repo.repoRoot, "d");

      const plan = eligiblePlan({
        classifications: [classificationAt("d", observed, regularState("was a file\n"))],
        operations: [restoreOp("d", observed, regularState("was a file\n"))],
      });

      const watch = watchAt(await capture(repo, plan), "d");
      expect(watch.kind).toBe("recursive");
      expect(memberPaths(watch)).toEqual(["d/deep", "d/deep/two.txt", "d/one.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("18: a destructive root that is no longer a directory at S yields EMPTY membership", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "d/one.txt", "1\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observedAtPlanning = await currentState(repo.repoRoot, "d");

      // The world moved after planning. Revision 12: this is a structured
      // stabilization difference, never an ENOTDIR leaking out of enumeration.
      await rm(join(repo.repoRoot, "d"), { recursive: true, force: true });
      await write(repo, "d", "now a file\n");

      const plan = eligiblePlan({
        classifications: [classificationAt("d", observedAtPlanning, regularState("target\n"))],
        operations: [restoreOp("d", observedAtPlanning, regularState("target\n"))],
      });

      const snapshot = await capture(repo, plan);
      const watch = watchAt(snapshot, "d");
      expect(watch.kind).toBe("recursive");
      expect(watch.members).toEqual([]);
      // The changed kind is still visible where it belongs: in the state map.
      expect(snapshot.states.get("d")?.worktree.kind).toBe("regular");
    } finally {
      await repo.cleanup();
    }
  });

  it("19: a worktree-affecting operation watches its parent's IMMEDIATE members", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.ts", "a\n");
      await write(repo, "src/b.ts", "b\n");
      await write(repo, "src/nested/c.ts", "c\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observed = await currentState(repo.repoRoot, "src/a.ts");

      const plan = eligiblePlan({
        classifications: [classificationAt("src/a.ts", observed, ABSENT_PATH_STATE)],
        operations: [restoreOp("src/a.ts", observed, ABSENT_PATH_STATE)],
      });

      const watch = watchAt(await capture(repo, plan), "src");
      expect(watch.kind).toBe("immediate");
      // Immediate, so `src/nested/c.ts` is NOT a member.
      expect(memberPaths(watch)).toEqual(["src/a.ts", "src/b.ts", "src/nested"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("20: an INDEX-ONLY restore_candidate creates NO watch", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/staged.ts", "content\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observed = await currentState(repo.repoRoot, "src/staged.ts");

      // Identical worktree axis on both sides; only the index differs. Nothing
      // is written to the filesystem, so freezing the neighbourhood would only
      // invite a spurious refusal.
      const target: PathState = { worktree: observed.worktree, index: { kind: "absent" } };

      const plan = eligiblePlan({
        classifications: [classificationAt("src/staged.ts", observed, target)],
        operations: [restoreOp("src/staged.ts", observed, target)],
      });

      const { topologyWatches } = await capture(repo, plan);
      expect(topologyWatches.has("src")).toBe(false);
      expect(topologyWatches.size).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("21: a create_parent_directory operation always watches its parent", async () => {
    const repo = await setupRepo();
    try {
      const plan = eligiblePlan({
        classifications: [
          classificationAt("a/b/c.txt", ABSENT_PATH_STATE, regularState("restored\n")),
        ],
        operations: [
          restoreOp("a/b/c.txt", ABSENT_PATH_STATE, regularState("restored\n")),
          parentOp("a", ABSENT_PATH_STATE, "a/b/c.txt"),
          parentOp("a/b", ABSENT_PATH_STATE, "a/b/c.txt"),
        ],
      });

      const snapshot = await capture(repo, plan);
      // Parents of the two synthetic operations plus the leaf's own parent.
      expect([...snapshot.topologyWatches.keys()].sort()).toEqual(["", "a", "a/b"]);
      // `a` is absent, so its frozen membership is empty rather than a throw.
      expect(watchAt(snapshot, "a").members).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("22: a watch parent observed as a NON-DIRECTORY yields empty membership", async () => {
    const repo = await setupRepo();
    try {
      // The `regular -> directory` transition 10A supports: `a` is itself a
      // selected candidate becoming a directory, and `a/b` is restored beneath
      // it. Refusing here would make a supported restoration unsnapshotable.
      await write(repo, "a", "currently a regular file\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observedA = await currentState(repo.repoRoot, "a");

      const plan = eligiblePlan({
        classifications: [
          classificationAt("a", observedA, DIRECTORY_STATE),
          classificationAt("a/b", ABSENT_PATH_STATE, regularState("child\n")),
        ],
        operations: [
          restoreOp("a", observedA, DIRECTORY_STATE),
          restoreOp("a/b", ABSENT_PATH_STATE, regularState("child\n")),
        ],
      });

      const snapshot = await capture(repo, plan);
      const watch = watchAt(snapshot, "a");
      expect(watch.kind).toBe("immediate");
      expect(watch.members).toEqual([]);
      expect(snapshot.states.get("a")?.worktree.kind).toBe("regular");
    } finally {
      await repo.cleanup();
    }
  });

  it("23: the ROOT watch excludes .git and .viberevert", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, ".viberevert/sessions/x.json", "{}\n");
      const observed = await currentState(repo.repoRoot, "README.md");

      const plan = eligiblePlan({
        classifications: [classificationAt("README.md", observed, regularState("# before\n"))],
        operations: [restoreOp("README.md", observed, regularState("# before\n"))],
      });

      const members = memberPaths(watchAt(await capture(repo, plan), ""));
      expect(members).toContain("README.md");
      expect(members).toContain(".gitignore");
      expect(members).not.toContain(".git");
      expect(members).not.toContain(".viberevert");
    } finally {
      await repo.cleanup();
    }
  });

  it("24: NESTED .git and .viberevert remain ordinary physical membership", async () => {
    const repo = await setupRepo();
    try {
      // Physical fixture on purpose. `enumerateDescendants` reads the raw
      // filesystem, so whether Git would stage a file literally named `.git` is
      // irrelevant to what this test proves.
      await write(repo, "vendor/pkg/.git", "gitdir: elsewhere\n");
      await write(repo, "vendor/pkg/.viberevert/note.txt", "someone else's tool\n");
      await write(repo, "vendor/pkg/main.c", "int main(){}\n");
      const observed = await currentState(repo.repoRoot, "vendor");

      const plan = eligiblePlan({
        classifications: [classificationAt("vendor", observed, regularState("was a file\n"))],
        operations: [restoreOp("vendor", observed, regularState("was a file\n"))],
      });

      const members = memberPaths(watchAt(await capture(repo, plan), "vendor"));
      expect(members).toContain("vendor/pkg/.git");
      expect(members).toContain("vendor/pkg/.viberevert");
      expect(members).toContain("vendor/pkg/.viberevert/note.txt");
    } finally {
      await repo.cleanup();
    }
  });

  it("25: RECURSIVE wins when a path is both a destructive root and an op parent", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "d/child.txt", "c\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const observedDir = await currentState(repo.repoRoot, "d");
      const observedChild = await currentState(repo.repoRoot, "d/child.txt");

      const plan = eligiblePlan({
        classifications: [
          classificationAt("d", observedDir, regularState("collapsed\n")),
          classificationAt("d/child.txt", observedChild, ABSENT_PATH_STATE),
        ],
        operations: [
          restoreOp("d", observedDir, regularState("collapsed\n")),
          restoreOp("d/child.txt", observedChild, ABSENT_PATH_STATE),
        ],
      });

      const watch = watchAt(await capture(repo, plan), "d");
      expect(watch.kind).toBe("recursive");
      expect(memberPaths(watch)).toEqual(["d/child.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("26: raw watches stay RAW -- ignored and excluded content is still membership", async () => {
    const repo = await setupRepo();
    try {
      // Revision 13's capability boundary, from the watch side. A future
      // "cleanup" that filtered these out of the watch would silently undo it.
      await write(repo, ".gitignore", ".viberevert/\nnode_modules/\n");
      await write(repo, "node_modules/pkg.js", "vendored\n");
      await write(repo, "scratch.tmp", "excluded\n");
      const observed = await currentState(repo.repoRoot, "README.md");

      const plan = eligiblePlan({
        classifications: [classificationAt("README.md", observed, regularState("# before\n"))],
        operations: [restoreOp("README.md", observed, regularState("# before\n"))],
      });

      const snapshot = await capture(repo, plan, ["*.tmp"]);

      // Neither is a protected STATE: one is gitignored, one is excluded.
      expect(snapshot.states.has("node_modules/pkg.js")).toBe(false);
      expect(snapshot.states.has("scratch.tmp")).toBe(false);

      // Both are still raw MEMBERSHIP the real transaction must not disturb.
      const members = memberPaths(watchAt(snapshot, ""));
      expect(members).toContain("node_modules");
      expect(members).toContain("scratch.tmp");
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section C: comparison
// =============================================================================

describe("protected-domain comparison", () => {
  const stateA = regularState("a\n");
  const stateB = regularState("b\n");

  const leaf = (path: string) => ({ path, kind: "leaf" as const });
  const dir = (path: string) => ({ path, kind: "directory" as const });

  const snapshot = (
    states: ReadonlyArray<readonly [string, PathState]>,
    watches: readonly TopologyWatch[] = [],
  ): ProtectedDomainSnapshot => ({
    states: new Map(states),
    topologyWatches: new Map(watches.map((w) => [w.path, w])),
  });

  const immediate = (
    path: string,
    members: readonly { path: string; kind: "leaf" | "directory" }[],
  ): TopologyWatch => ({ path, kind: "immediate", members });

  it("27: identical snapshots compare unchanged on both predicates", () => {
    const a = snapshot([["x.ts", stateA]], [immediate("", [leaf("x.ts")])]);
    const b = snapshot([["x.ts", stateA]], [immediate("", [leaf("x.ts")])]);

    expect(protectedStatesUnchanged(compareProtectedStateMaps(a.states, b.states))).toBe(true);
    expect(protectedDomainUnchanged(compareProtectedDomainSnapshots(a, b))).toBe(true);
  });

  it("28: an added, a removed, and a changed path are each reported", () => {
    const expected = snapshot([
      ["gone.ts", stateA],
      ["moved.ts", stateA],
    ]);
    const actual = snapshot([
      ["moved.ts", stateB],
      ["new.ts", stateA],
    ]);

    const diff = compareProtectedStateMaps(expected.states, actual.states);
    expect(diff.removedPaths).toEqual(["gone.ts"]);
    expect(diff.addedPaths).toEqual(["new.ts"]);
    expect(diff.changedPaths).toEqual(["moved.ts"]);
    expect(protectedStatesUnchanged(diff)).toBe(false);
  });

  it("29: watch_added, watch_removed, and kind_changed are each reported", () => {
    const expected = snapshot(
      [],
      [immediate("gone", []), { path: "flip", kind: "immediate", members: [] }],
    );
    const actual = snapshot(
      [],
      [{ path: "flip", kind: "recursive", members: [] }, immediate("fresh", [])],
    );

    const diff = compareProtectedDomainSnapshots(expected, actual);
    const byPath = new Map(diff.topologyWatchDifferences.map((d) => [d.path, d.reason]));
    expect(byPath.get("gone")).toBe("watch_removed");
    expect(byPath.get("fresh")).toBe("watch_added");
    expect(byPath.get("flip")).toBe("kind_changed");
  });

  it("30: added and removed watch members are reported", () => {
    const expected = snapshot([], [immediate("d", [leaf("d/stays"), leaf("d/vanishes")])]);
    const actual = snapshot([], [immediate("d", [leaf("d/appears"), leaf("d/stays")])]);

    const [difference] = compareProtectedDomainSnapshots(expected, actual).topologyWatchDifferences;
    expect(difference?.reason).toBe("membership_changed");
    expect(difference?.path).toBe("d");
    expect(difference?.addedMembers).toEqual(["d/appears"]);
    expect(difference?.removedMembers).toEqual(["d/vanishes"]);
    expect(difference?.changedMembers).toEqual([]);
  });

  it("31: a member whose KIND flipped is changed, not added-and-removed", () => {
    const expected = snapshot([], [immediate("d", [dir("d/thing")])]);
    const actual = snapshot([], [immediate("d", [leaf("d/thing")])]);

    const [difference] = compareProtectedDomainSnapshots(expected, actual).topologyWatchDifferences;
    expect(difference?.changedMembers).toEqual(["d/thing"]);
    expect(difference?.addedMembers).toEqual([]);
    expect(difference?.removedMembers).toEqual([]);
  });

  it("32: STATE-ONLY and WHOLE-DOMAIN comparison diverge on watch-only drift", () => {
    // The executable lock for §9 revision 13: the recovery oracle compares
    // `states` only, while stabilization and the fence compare both. Identical
    // states, different raw membership.
    const states: ReadonlyArray<readonly [string, PathState]> = [["x.ts", stateA]];
    const expected = snapshot(states, [immediate("", [leaf("x.ts")])]);
    const actual = snapshot(states, [immediate("", [dir("node_modules"), leaf("x.ts")])]);

    expect(
      protectedStatesUnchanged(compareProtectedStateMaps(expected.states, actual.states)),
    ).toBe(true);
    expect(protectedDomainUnchanged(compareProtectedDomainSnapshots(expected, actual))).toBe(false);
  });

  it("33: compareProtectedDomainSnapshots reproduces the state fields verbatim", () => {
    const expected = snapshot([
      ["gone.ts", stateA],
      ["moved.ts", stateA],
    ]);
    const actual = snapshot([
      ["moved.ts", stateB],
      ["new.ts", stateA],
    ]);

    const stateOnly = compareProtectedStateMaps(expected.states, actual.states);
    const whole = compareProtectedDomainSnapshots(expected, actual);
    expect(whole.addedPaths).toEqual(stateOnly.addedPaths);
    expect(whole.removedPaths).toEqual(stateOnly.removedPaths);
    expect(whole.changedPaths).toEqual(stateOnly.changedPaths);
  });

  it("34: EVERY output array is sorted, from deliberately unsorted input", () => {
    // Two values in each of the seven sortable outputs, every input supplied in
    // reverse lexical order, so a missing `.sort()` anywhere fails here.
    const churnedMembers = (root: string) => ({
      before: [
        leaf(`${root}/z-gone`),
        leaf(`${root}/a-gone`),
        dir(`${root}/z-flip`),
        dir(`${root}/a-flip`),
      ],
      after: [
        leaf(`${root}/z-new`),
        leaf(`${root}/a-new`),
        leaf(`${root}/z-flip`),
        leaf(`${root}/a-flip`),
      ],
    });
    const zDir = churnedMembers("z-dir");
    const aDir = churnedMembers("a-dir");

    const expected = snapshot(
      [
        ["z-removed.ts", stateA],
        ["a-removed.ts", stateA],
        ["z-changed.ts", stateA],
        ["a-changed.ts", stateA],
      ],
      [immediate("z-dir", zDir.before), immediate("a-dir", aDir.before)],
    );
    const actual = snapshot(
      [
        ["z-changed.ts", stateB],
        ["a-changed.ts", stateB],
        ["z-added.ts", stateA],
        ["a-added.ts", stateA],
      ],
      [immediate("z-dir", zDir.after), immediate("a-dir", aDir.after)],
    );

    const diff = compareProtectedDomainSnapshots(expected, actual);
    expect(diff.addedPaths).toEqual(["a-added.ts", "z-added.ts"]);
    expect(diff.removedPaths).toEqual(["a-removed.ts", "z-removed.ts"]);
    expect(diff.changedPaths).toEqual(["a-changed.ts", "z-changed.ts"]);

    expect(diff.topologyWatchDifferences.map((d) => d.path)).toEqual(["a-dir", "z-dir"]);
    for (const difference of diff.topologyWatchDifferences) {
      const root = difference.path;
      expect(difference.addedMembers).toEqual([`${root}/a-new`, `${root}/z-new`]);
      expect(difference.removedMembers).toEqual([`${root}/a-gone`, `${root}/z-gone`]);
      expect(difference.changedMembers).toEqual([`${root}/a-flip`, `${root}/z-flip`]);
    }
  });
});

// =============================================================================
// Section D: source invariant
// =============================================================================
//
// A regression guard in the style of the existing D19 `loadConfig` invariant
// test, not a call-graph proof. Adding an injection seam purely so a test could
// make the enumerators throw would distort the production API for no other
// benefit, and no portable filesystem scenario separates the two functions:
// Windows will not make a directory unreadable, and deleting a watch root just
// produces revision 12's empty membership.
//
// Scoped to `captureProtectedStateMap` alone. The same module legitimately
// calls both enumerators from `captureProtectedDomain`.

describe("source invariant", () => {
  it("35: captureProtectedStateMap enumerates no filesystem topology", async () => {
    const source = await readFile(new URL("../src/protected-domain.ts", import.meta.url), "utf8");

    const declaration = "export async function captureProtectedStateMap(";
    const start = source.indexOf(declaration);
    expect(start).toBeGreaterThan(-1);

    // The first column-zero `}` after the declaration closes the function.
    const end = source.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    for (const forbidden of [
      "enumerateDescendants(",
      "enumerateImmediateMembers(",
      "immediateMembership(",
      "captureProtectedDomain(",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
