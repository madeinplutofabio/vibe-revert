// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for the read-only selective preview.
//
// REAL oracle throughout. The preview's whole reason for materializing a
// checkpoint is that `missing_evidence` cannot be derived from the plan, so
// faking the checkpoint would remove the only thing under test.
//
// The load-bearing cases are the ones where the preview could claim more than
// it checked: evidence must beat a planning conflict, one missing path must not
// end the pass, `already_at_before` must be verified rather than assumed, and
// lookup must key on the (path, group) PAIR. The last test pins the other half
// of the contract, that observing all this leaves the project as it was.
//
// Cleanup-warning PROPAGATION needs a stranded worktree, which no portable
// filesystem state produces on demand, so it lives in
// `preview-selective-warnings.test.ts` behind a narrow mock.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import { createCheckpoint } from "../src/checkpoint.js";
import { getHeadSha } from "../src/git-cli.js";
import { observePathState, readIndexSnapshot } from "../src/path-state.js";
import {
  previewSelectiveRestore,
  type SelectivePreviewPath,
  type SelectiveRestorePreviewResult,
} from "../src/preview-selective.js";
import {
  ABSENT_PATH_STATE,
  type SelectiveRestoreClassification,
  type SelectiveRestoreConflict,
  type SelectiveRestorePlan,
} from "../src/restore-selective.js";

const execFileAsync = promisify(execFile);

const GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000001";
const OTHER_GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000002";

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const regularState = (content: string): PathState => ({
  worktree: { kind: "regular", content_ref: sha256(content), executable: false },
  index: { kind: "absent" },
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

async function gitOut(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, windowsHide: true });
  return stdout;
}

interface TestRepo {
  readonly repoRoot: string;
  readonly checkpointRoot: string;
  readonly cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-previewfixture-"));
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
  return { repoRoot, checkpointRoot, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

async function write(repo: TestRepo, rel: string, content: string): Promise<void> {
  await writeFile(join(repo.repoRoot, rel), content, "utf8");
}

async function currentState(repoRoot: string, path: string): Promise<PathState> {
  const index = await readIndexSnapshot(repoRoot);
  return (await observePathState(repoRoot, path, index)).state;
}

/** Five files, staged and captured. The oracle reproduces exactly these. */
const FILES = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"] as const;

async function seeded(repo: TestRepo): Promise<string> {
  for (const name of FILES) await write(repo, name, `${name} content\n`);
  await git(repo.repoRoot, ["add", "-A"]);
  const dir = join(repo.checkpointRoot, "cp");
  await mkdir(dir, { recursive: true });
  await createCheckpoint({
    repoRoot: repo.repoRoot,
    checkpointDir: dir,
    rollbackExcludePatterns: [],
  });
  return dir;
}

const PLANNED_RESTORE = { kind: "planned", disposition: "restore_required" } as const;
const PLANNED_AT_BEFORE = { kind: "planned", disposition: "already_at_before" } as const;
const MODIFIED_SINCE = { kind: "conflict", reason: { code: "MODIFIED_SINCE" } } as const;
const UNSUPPORTED = {
  kind: "conflict",
  reason: { code: "UNSUPPORTED_STATE", detail: "a socket cannot be reconstructed" },
} as const;

function classification(
  path: string,
  expectedBefore: PathState,
  outcome: SelectiveRestoreClassification["outcome"],
  changeGroupId: string = GROUP,
): SelectiveRestoreClassification {
  return {
    path,
    changeGroupId,
    expectedBefore,
    expectedAfter: ABSENT_PATH_STATE,
    observed: ABSENT_PATH_STATE,
    outcome,
  };
}

/**
 * A COHERENT plan for the given classifications.
 *
 * Everything derivable is derived: the authorized groups are the groups the
 * classifications actually use, the conflict list mirrors the conflicted
 * classifications, and the outcome follows from both. A fixture that authorized
 * groups it does not classify, or claimed `eligible` while carrying a conflict,
 * would be testing a plan the planner cannot produce.
 */
function planOf(classifications: readonly SelectiveRestoreClassification[]): SelectiveRestorePlan {
  const conflicts: SelectiveRestoreConflict[] = [];
  for (const c of classifications) {
    if (c.outcome.kind === "conflict") {
      conflicts.push({ changeGroupId: c.changeGroupId, path: c.path, reason: c.outcome.reason });
    }
  }

  const base = {
    capabilities: { symlinkCheckout: true },
    selectedChangeGroupIds: [...new Set(classifications.map((c) => c.changeGroupId))].sort(),
    classifications,
    topologyDependencyPaths: [],
  } as const;

  // Returned per ARM rather than with a computed `outcome`: the plan is a
  // discriminated union whose arms constrain `operations` and `conflicts`
  // differently, so only a concrete literal per branch can be checked.
  if (classifications.length === 0) {
    return { ...base, outcome: "noop", operations: [], conflicts: [] };
  }
  if (conflicts.length > 0) {
    return { ...base, outcome: "conflicted", operations: [], conflicts };
  }
  return { ...base, outcome: "eligible", operations: [], conflicts: [] };
}

function expectPreviewed(result: SelectiveRestorePreviewResult) {
  if (result.outcome !== "previewed") {
    throw new Error(`expected previewed, got failed: ${String(result.cause)}`);
  }
  return result;
}

const outcomeAt = (paths: readonly SelectivePreviewPath[], path: string) =>
  paths.find((p) => p.path === path)?.outcome;

describe("previewSelectiveRestore: classification", () => {
  it("1: produces all five outcomes from one plan", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await seeded(repo);
      const present = (p: string) => currentState(repo.repoRoot, p);

      const plan = planOf([
        classification("a.txt", await present("a.txt"), PLANNED_RESTORE),
        classification("b.txt", await present("b.txt"), PLANNED_AT_BEFORE),
        classification("c.txt", await present("c.txt"), MODIFIED_SINCE),
        classification("d.txt", await present("d.txt"), UNSUPPORTED),
        // Asserts a BEFORE state the checkpoint does not hold.
        classification("e.txt", regularState("never existed\n"), PLANNED_RESTORE),
      ]);

      const { paths } = expectPreviewed(
        await previewSelectiveRestore({
          repoRoot: repo.repoRoot,
          sessionCheckpointDir: checkpointDir,
          plan,
        }),
      );

      expect(paths.map((p) => p.outcome)).toEqual([
        "restored",
        "already_at_before",
        "modified_since",
        "unsupported_state",
        "missing_evidence",
      ]);
      // One entry per classification, in the plan's own order.
      expect(paths.map((p) => p.path)).toEqual([...FILES]);
      // The conflict's own detail survives.
      expect(paths[3]?.detail).toContain("socket");
      // So does the evidence gap's.
      expect(paths[4]?.detail).toContain("the contribution asserts");
    } finally {
      await repo.cleanup();
    }
  });

  it("2: missing evidence beats a planning conflict", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await seeded(repo);
      // A conflicted path whose evidence is ALSO absent. If the conflict won,
      // the evidence finding would vanish from the observable preview and the
      // exhaustive pass would be pointless for exactly these paths.
      const plan = planOf([classification("a.txt", regularState("wrong\n"), MODIFIED_SINCE)]);

      const { paths } = expectPreviewed(
        await previewSelectiveRestore({
          repoRoot: repo.repoRoot,
          sessionCheckpointDir: checkpointDir,
          plan,
        }),
      );

      expect(paths.map((p) => p.outcome)).toEqual(["missing_evidence"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("3: every missing path is reported, not just the first", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await seeded(repo);
      const plan = planOf([
        classification("a.txt", regularState("wrong\n"), PLANNED_RESTORE),
        classification("b.txt", await currentState(repo.repoRoot, "b.txt"), PLANNED_RESTORE),
        classification("c.txt", regularState("also wrong\n"), PLANNED_RESTORE, OTHER_GROUP),
      ]);

      const { paths } = expectPreviewed(
        await previewSelectiveRestore({
          repoRoot: repo.repoRoot,
          sessionCheckpointDir: checkpointDir,
          plan,
        }),
      );

      expect(outcomeAt(paths, "a.txt")).toBe("missing_evidence");
      expect(outcomeAt(paths, "b.txt")).toBe("restored");
      // a.txt did not stop the pass, and the second group is joined correctly.
      expect(outcomeAt(paths, "c.txt")).toBe("missing_evidence");
    } finally {
      await repo.cleanup();
    }
  });

  it("4: already_at_before is evidence-checked, not assumed", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await seeded(repo);
      // Exempting it would make evidence validity depend on the live checkout
      // and let the preview promise a path the apply then refuses.
      const plan = planOf([classification("a.txt", regularState("wrong\n"), PLANNED_AT_BEFORE)]);

      const { paths } = expectPreviewed(
        await previewSelectiveRestore({
          repoRoot: repo.repoRoot,
          sessionCheckpointDir: checkpointDir,
          plan,
        }),
      );

      expect(paths.map((p) => p.outcome)).toEqual(["missing_evidence"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("5: one path in two groups is keyed by the PAIR, not by the path", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await seeded(repo);
      // The SAME path classified twice with different asserted BEFORE states,
      // so exactly one pair has an evidence gap. Keyed by path alone, both
      // would come back `missing_evidence`; this is the reason the lookup key
      // is NUL-delimited rather than concatenated.
      const plan = planOf([
        classification("a.txt", await currentState(repo.repoRoot, "a.txt"), PLANNED_RESTORE),
        classification("a.txt", regularState("wrong\n"), PLANNED_RESTORE, OTHER_GROUP),
      ]);

      const { paths } = expectPreviewed(
        await previewSelectiveRestore({
          repoRoot: repo.repoRoot,
          sessionCheckpointDir: checkpointDir,
          plan,
        }),
      );

      expect(paths.map((p) => p.changeGroupId)).toEqual([GROUP, OTHER_GROUP]);
      expect(paths.map((p) => p.outcome)).toEqual(["restored", "missing_evidence"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("6: an empty selection previews nothing and is not an error", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await seeded(repo);
      const result = expectPreviewed(
        await previewSelectiveRestore({
          repoRoot: repo.repoRoot,
          sessionCheckpointDir: checkpointDir,
          plan: planOf([]),
        }),
      );

      // Empty is a real preview, distinct from a failure. The CALLER turns this
      // into `empty_selection`; `paths.every(...)` alone would call it eligible.
      expect(result.paths).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("previewSelectiveRestore: lifecycle", () => {
  it("7: reports no cleanup warnings when nothing was stranded", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await seeded(repo);
      const result = expectPreviewed(
        await previewSelectiveRestore({
          repoRoot: repo.repoRoot,
          sessionCheckpointDir: checkpointDir,
          plan: planOf([
            classification("a.txt", await currentState(repo.repoRoot, "a.txt"), PLANNED_RESTORE),
          ]),
        }),
      );

      expect(result.cleanupWarnings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("8: a checkpoint that cannot be loaded fails as a value", async () => {
    const repo = await setupRepo();
    try {
      const result = await previewSelectiveRestore({
        repoRoot: repo.repoRoot,
        sessionCheckpointDir: join(repo.checkpointRoot, "does-not-exist"),
        plan: planOf([]),
      });

      if (result.outcome !== "failed") throw new Error("expected failed");
      expect(result.cause).toBeDefined();
      // Nothing was stranded, so nothing is claimed.
      expect(result.cleanupWarnings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("9: leaves the project's worktree, index and HEAD exactly as they were", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await seeded(repo);

      const headBefore = await getHeadSha(repo.repoRoot);
      const statusBefore = await gitOut(repo.repoRoot, ["status", "--porcelain"]);
      const bytesBefore = await Promise.all(
        FILES.map((f) => readFile(join(repo.repoRoot, f), "utf8")),
      );

      // A plan mixing every outcome, so the widest path through the module runs.
      const result = await previewSelectiveRestore({
        repoRoot: repo.repoRoot,
        sessionCheckpointDir: checkpointDir,
        plan: planOf([
          classification("a.txt", await currentState(repo.repoRoot, "a.txt"), PLANNED_RESTORE),
          classification("b.txt", regularState("wrong\n"), PLANNED_AT_BEFORE),
          classification("c.txt", await currentState(repo.repoRoot, "c.txt"), MODIFIED_SINCE),
        ]),
      });

      // Load-bearing: an immediate failure would satisfy every assertion below
      // without the oracle ever having been materialized.
      expectPreviewed(result);

      expect(await getHeadSha(repo.repoRoot)).toBe(headBefore);
      expect(await gitOut(repo.repoRoot, ["status", "--porcelain"])).toBe(statusBefore);
      expect(await Promise.all(FILES.map((f) => readFile(join(repo.repoRoot, f), "utf8")))).toEqual(
        bytesBefore,
      );
    } finally {
      await repo.cleanup();
    }
  });
});
