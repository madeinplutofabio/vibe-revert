// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for session-start oracle evidence validation (M 0.8.0 step 10B, §12).
//
// Cases 1-7 run the REAL oracle: a real checkpoint is materialized into a real
// linked worktree and each candidate's asserted BEFORE state is observed there.
// Case 8 isolates the evidence function's eligibility precondition without
// materializing anything, and case 9 pins the module boundary from source.
//
// For the behavioral oracle cases, the question under test is whether the
// checkpoint can actually SUPPLY what the contribution DESCRIBES, so faking
// either side would test nothing.
//
// Checkpoint directories live OUTSIDE the repository, so they never become
// untracked content the oracle would observe.
//
// F1: `findMissingEvidence` takes an ALREADY MATERIALIZED oracle worktree, so
// cases 1-7 each open `withCheckpointOracle` themselves and pass that exact
// `worktreePath` in. The lifecycle is written out inline ON PURPOSE. A local
// `validate(repo, checkpointDir, plan)` helper would rebuild the deleted
// self-opening wrapper under a new name and hide the very composition
// production is required to use.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import { createCheckpoint } from "../src/checkpoint.js";
import { withCheckpointOracle } from "../src/checkpoint-oracle.js";
import { CheckpointNotFoundError } from "../src/errors.js";
import { findMissingEvidence, type OracleEvidenceVerdict } from "../src/oracle-evidence.js";
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

/**
 * This suite's own oracle prefix.
 *
 * The module under test no longer chooses one, because it no longer materializes
 * anything. Whoever owns the oracle owns its scratch naming.
 */
const TEST_ORACLE_PREFIX = "viberevert-evidence-test-oracle-";

/** Distributive, so it collects keys from EVERY arm rather than the shared ones. */
type KeysOfUnion<T> = T extends T ? keyof T : never;

/**
 * F1's API boundary, pinned at COMPILE time: the verdict is evidence semantics
 * only, and lifecycle belongs to whoever owns the oracle.
 *
 * A runtime key check proves only that today's `sufficient` value is clean. It
 * would still pass if `cleanupWarnings?:` were added back to either arm, which
 * is exactly the regression this guard exists to stop.
 */
const VERDICT_HAS_NO_CLEANUP_WARNINGS: "cleanupWarnings" extends KeysOfUnion<OracleEvidenceVerdict>
  ? false
  : true = true;

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

function expectMissing(verdict: OracleEvidenceVerdict) {
  if (verdict.outcome !== "missing_evidence") {
    throw new Error(`expected missing_evidence, got ${verdict.outcome}`);
  }
  return verdict;
}

// =============================================================================
// Section A: can the checkpoint supply what the contribution asserts?
// =============================================================================

describe("findMissingEvidence", () => {
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

      const { value, cleanupWarnings } = await withCheckpointOracle(repo.repoRoot, checkpointDir, {
        tempDirPrefix: TEST_ORACLE_PREFIX,
        run: ({ worktreePath }) => findMissingEvidence(worktreePath, plan),
      });

      expect(value.outcome).toBe("sufficient");
      // Lifecycle warnings now belong to the oracle's owner, which is this test.
      // The verdict itself carries none.
      expect(cleanupWarnings).toEqual([]);
      expect(Object.keys(value)).toEqual(["outcome"]);
      // Compile-time boundary: lifecycle cannot creep back into either verdict
      // arm, optional or required.
      expect(VERDICT_HAS_NO_CLEANUP_WARNINGS).toBe(true);
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

      const { value } = await withCheckpointOracle(repo.repoRoot, checkpointDir, {
        tempDirPrefix: TEST_ORACLE_PREFIX,
        run: ({ worktreePath }) => findMissingEvidence(worktreePath, plan),
      });

      const result = expectMissing(value);
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

      const { value } = await withCheckpointOracle(repo.repoRoot, checkpointDir, {
        tempDirPrefix: TEST_ORACLE_PREFIX,
        run: ({ worktreePath }) => findMissingEvidence(worktreePath, plan),
      });

      const result = expectMissing(value);
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

      const { value } = await withCheckpointOracle(repo.repoRoot, checkpointDir, {
        tempDirPrefix: TEST_ORACLE_PREFIX,
        run: ({ worktreePath }) => findMissingEvidence(worktreePath, plan),
      });

      const result = expectMissing(value);
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

      const { value } = await withCheckpointOracle(repo.repoRoot, checkpointDir, {
        tempDirPrefix: TEST_ORACLE_PREFIX,
        run: ({ worktreePath }) => findMissingEvidence(worktreePath, plan),
      });

      expect(expectMissing(value).path).toBe("settled.txt");
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

      const { value } = await withCheckpointOracle(repo.repoRoot, checkpointDir, {
        tempDirPrefix: TEST_ORACLE_PREFIX,
        run: ({ worktreePath }) => findMissingEvidence(worktreePath, plan),
      });

      expect(expectMissing(value).path).toBe("a.txt");
      // And the approved plan is untouched by the local sort.
      expect(plan.classifications.map((c) => c.path)).toEqual(["z.txt", "a.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("7: a checkpoint that cannot materialize never reaches evidence validation", async () => {
    const repo = await setupRepo();
    try {
      const plan = eligiblePlan([candidate("a.txt", regularState("anything\n"))]);
      const missing = join(repo.checkpointRoot, "does-not-exist");
      let ran = false;

      await expect(
        withCheckpointOracle(repo.repoRoot, missing, {
          tempDirPrefix: TEST_ORACLE_PREFIX,
          run: ({ worktreePath }) => {
            ran = true;
            return findMissingEvidence(worktreePath, plan);
          },
        }),
      ).rejects.toBeInstanceOf(CheckpointNotFoundError);

      // "We could not read the evidence" and "the evidence contradicts the
      // plan" demand different recovery advice, so the second must be
      // UNREACHABLE when the first happened. Under F1 that is a property of the
      // composition rather than of one self-opening function.
      expect(ran).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("8: a non-eligible plan throws without reading any oracle at all", async () => {
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

    // Eligibility is this function's own precondition, not an orchestration
    // convenience. The worktree path is deliberately nonexistent: if the guard
    // ran after the first index read, these would reject with a filesystem
    // error instead. The guard's own message is what proves the ordering, and
    // no repository or checkpoint is needed to prove it.
    const absent = join(tmpdir(), "viberevert-oracle-must-not-be-read");
    await expect(findMissingEvidence(absent, noop)).rejects.toThrow(/requires an eligible plan/);
    await expect(findMissingEvidence(absent, conflicted)).rejects.toThrow(
      /requires an eligible plan/,
    );
  });
});

// =============================================================================
// Section B: source invariant
// =============================================================================

describe("source invariant", () => {
  it("9: the evidence module has no lifecycle, protected-domain, or object-store input", async () => {
    const source = await readFile(new URL("../src/oracle-evidence.ts", import.meta.url), "utf8");

    // Scoped to the IMPORT BLOCK: the file header names several of these
    // deliberately, to explain why none of them is used. The end anchor is the
    // first exported declaration, since the temp-dir constant that used to sit
    // here went away with the self-opening wrapper.
    const start = source.indexOf("import type { PathState }");
    const end = source.indexOf("export type OracleEvidenceVerdict");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const imports = source.slice(start, end);

    for (const forbidden of [
      "./protected-domain.js",
      "./recovery-handle.js",
      "./fs-topology.js",
      // F1: this module must never materialize an oracle again. Evidence has to
      // be proven about the SAME worktree the transplant reads from, which is
      // only possible if the transaction owner supplies it.
      "./checkpoint-oracle.js",
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
