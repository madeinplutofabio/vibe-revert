// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for session-start oracle evidence validation (M 0.8.0 step 10B, §12).
//
// Every case runs the REAL oracle: a real checkpoint is materialized into a real
// linked worktree and each candidate's asserted BEFORE state is observed there.
// The question under test is whether the checkpoint can actually SUPPLY what the
// contribution DESCRIBES, so faking either side would test nothing.
//
// Checkpoint directories live OUTSIDE the repository, so they never become
// untracked content the oracle would observe.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import { createCheckpoint } from "../src/checkpoint.js";
import { CheckpointNotFoundError } from "../src/errors.js";
import { validateOracleEvidence } from "../src/oracle-evidence.js";
import { observePathState, readIndexSnapshot } from "../src/path-state.js";
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
  readonly checkpointRoot: string;
  readonly cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-evidencefixture-"));
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

async function currentState(repoRoot: string, path: string): Promise<PathState> {
  const index = await readIndexSnapshot(repoRoot);
  return (await observePathState(repoRoot, path, index)).state;
}

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

/**
 * `observed` and `expectedAfter` are ABSENT_PATH_STATE throughout, because this
 * module reads NEITHER. It compares the oracle's observation against
 * `expectedBefore` alone. Filling them with plausible fiction would suggest they
 * participate.
 */
function candidate(
  path: string,
  expectedBefore: PathState,
  disposition: "restore_required" | "already_at_before" = "restore_required",
): SelectiveRestoreClassification {
  return {
    path,
    changeGroupId: GROUP,
    expectedBefore,
    expectedAfter: ABSENT_PATH_STATE,
    observed: ABSENT_PATH_STATE,
    outcome: { kind: "planned", disposition },
  };
}

function eligiblePlan(
  classifications: readonly SelectiveRestoreClassification[],
  operations: readonly SelectiveRestoreOperation[] = [],
): SelectiveRestorePlan {
  return {
    outcome: "eligible",
    capabilities: { symlinkCheckout: true },
    selectedChangeGroupIds: [GROUP],
    classifications,
    topologyDependencyPaths: [],
    operations,
    conflicts: [],
  };
}

const validate = (repo: TestRepo, checkpointDir: string, plan: SelectiveRestorePlan) =>
  validateOracleEvidence({ repoRoot: repo.repoRoot, checkpointDir, plan });

function expectMissing(result: Awaited<ReturnType<typeof validate>>) {
  if (result.outcome !== "missing_evidence") {
    throw new Error(`expected missing_evidence, got ${result.outcome}`);
  }
  return result;
}

// =============================================================================
// Section A: can the checkpoint supply what the contribution asserts?
// =============================================================================

describe("validateOracleEvidence", () => {
  it("1: a checkpoint reproducing every candidate is sufficient evidence", async () => {
    const repo = await setupRepo();
    try {
      // Two candidates on different surfaces: one tracked and staged, one
      // untracked. Both must come back out of the checkpoint intact.
      await write(repo, "staged.txt", "staged content\n");
      await git(repo.repoRoot, ["add", "staged.txt"]);
      await write(repo, "untracked.txt", "untracked content\n");

      const stagedBefore = await currentState(repo.repoRoot, "staged.txt");
      const untrackedBefore = await currentState(repo.repoRoot, "untracked.txt");
      const checkpointDir = await makeCheckpoint(repo, "faithful");

      const plan = eligiblePlan([
        candidate("staged.txt", stagedBefore),
        candidate("untracked.txt", untrackedBefore),
      ]);

      const result = await validate(repo, checkpointDir, plan);
      expect(result.outcome).toBe("sufficient");
      expect(result.cleanupWarnings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("2: a WORKTREE-axis-only disagreement is missing evidence", async () => {
    const repo = await setupRepo();
    try {
      // Left UNTRACKED on purpose. The oracle will reconstruct
      // `worktree regular / index absent`, and `regularState` asserts
      // `worktree regular / index absent` too, so the ONLY disagreement is the
      // worktree content ref. Staging it would also mismatch the index axis and
      // the case would stay green even with worktree comparison broken.
      await write(repo, "a.txt", "what the checkpoint holds\n");
      const checkpointDir = await makeCheckpoint(repo, "worktree-axis");

      const plan = eligiblePlan([candidate("a.txt", regularState("a different BEFORE\n"))]);

      const result = expectMissing(await validate(repo, checkpointDir, plan));
      expect(result.path).toBe("a.txt");
      expect(result.detail).toContain("the contribution asserts");
    } finally {
      await repo.cleanup();
    }
  });

  it("3: an INDEX-axis-only disagreement is still missing evidence", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "identical bytes on both sides\n");
      await git(repo.repoRoot, ["add", "a.txt"]);
      const observed = await currentState(repo.repoRoot, "a.txt");
      const checkpointDir = await makeCheckpoint(repo, "index-axis");

      // Worktree axis matches EXACTLY; only the index claim differs. A
      // content-hash comparison would see nothing here at all.
      const plan = eligiblePlan([
        candidate("a.txt", { worktree: observed.worktree, index: { kind: "absent" } }),
      ]);

      const result = expectMissing(await validate(repo, checkpointDir, plan));
      expect(result.path).toBe("a.txt");
      expect(result.detail).toContain("index absent");
    } finally {
      await repo.cleanup();
    }
  });

  it("4: a path the checkpoint never captured is missing evidence", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await makeCheckpoint(repo, "never-captured");

      const plan = eligiblePlan([
        candidate("never-existed.txt", regularState("claimed to have existed\n")),
      ]);

      const result = expectMissing(await validate(repo, checkpointDir, plan));
      expect(result.path).toBe("never-existed.txt");
      expect(result.detail).toContain("worktree absent");
    } finally {
      await repo.cleanup();
    }
  });

  it("5: an already_at_before candidate is evidence-checked despite writing nothing", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "settled.txt", "what the checkpoint holds\n");
      await git(repo.repoRoot, ["add", "settled.txt"]);
      const checkpointDir = await makeCheckpoint(repo, "already-at-before");

      // No operation at all: by definition nothing writes this path. Evidence
      // validity must not depend on whether the live tree happens to need a
      // write, so it is checked anyway.
      const plan = eligiblePlan([
        candidate("settled.txt", regularState("an unreproducible BEFORE\n"), "already_at_before"),
      ]);
      expect(plan.operations).toEqual([]);

      const result = expectMissing(await validate(repo, checkpointDir, plan));
      expect(result.path).toBe("settled.txt");
    } finally {
      await repo.cleanup();
    }
  });

  it("6: the reported culprit is the lexically first, not the first supplied", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = await makeCheckpoint(repo, "two-failures");

      // Both fail. Supplied in reverse lexical order, so a function trusting
      // input order would report `z.txt`.
      const plan = eligiblePlan([
        candidate("z.txt", regularState("z BEFORE\n")),
        candidate("a.txt", regularState("a BEFORE\n")),
      ]);

      const result = expectMissing(await validate(repo, checkpointDir, plan));
      expect(result.path).toBe("a.txt");
      // And the approved plan is untouched by the local sort.
      expect(plan.classifications.map((c) => c.path)).toEqual(["z.txt", "a.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("7: a genuine checkpoint failure throws rather than reporting missing evidence", async () => {
    const repo = await setupRepo();
    try {
      // "We could not read the evidence" and "the evidence contradicts the
      // plan" demand different recovery advice.
      const plan = eligiblePlan([candidate("a.txt", regularState("anything\n"))]);
      const missing = join(repo.checkpointRoot, "does-not-exist");

      await expect(validate(repo, missing, plan)).rejects.toBeInstanceOf(CheckpointNotFoundError);
    } finally {
      await repo.cleanup();
    }
  });

  it("8: a noop or conflicted plan throws BEFORE any oracle work", async () => {
    const repo = await setupRepo();
    try {
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

      // Pointed at a checkpoint that does NOT exist: if the guard ran after the
      // oracle, these would reject with CheckpointNotFoundError instead. The
      // guard's own message is what proves the ordering.
      const absent = join(repo.checkpointRoot, "does-not-exist");
      await expect(validate(repo, absent, noop)).rejects.toThrow(/requires an eligible plan/);
      await expect(validate(repo, absent, conflicted)).rejects.toThrow(/requires an eligible plan/);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section B: source invariant
// =============================================================================

describe("source invariant", () => {
  it("9: the evidence chain has no protected-domain, topology, or object-store input", async () => {
    const source = await readFile(new URL("../src/oracle-evidence.ts", import.meta.url), "utf8");

    // Scoped to the IMPORT BLOCK: the file header names several of these
    // deliberately, to explain why none of them is used.
    const start = source.indexOf("import type { PathState }");
    const end = source.indexOf("const TEMP_DIR_PREFIX");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const imports = source.slice(start, end);

    for (const forbidden of [
      "./protected-domain.js",
      "./recovery-handle.js",
      "./fs-topology.js",
      // The object store lives in @viberevert/core, which @viberevert/git does
      // not depend on at all. `oid` and `content_ref` are compared here, never
      // dereferenced.
      "@viberevert/core",
      "object-store",
    ]) {
      expect(imports).not.toContain(forbidden);
    }
  });
});
