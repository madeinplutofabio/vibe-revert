// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// selective-restore-transaction.ts targeted tests.
//
// These drive the whole composed sequence against real repositories and real
// checkpoints: the session checkpoint the restore reads FROM, and E, the
// emergency checkpoint that becomes the recovery handle.
//
// Two arms are reached through the `publishAttempt` callback rather than a test
// seam. The gate invokes it AFTER the final fence and BEFORE the first mutation,
// so a callback that perturbs the repository at that instant is an adversarial
// use of a documented extension point:
//
//   - replacing a parent directory with a regular file makes the executor fail,
//     producing a gate `mutation_failed`;
//   - modifying an unrelated protected file lets the transplant complete while
//     first verification reports an unattributed change.
//
// NOT covered, for reasons established at the layers that own them: real torn
// observation races (the resolver owns that rule and is exhaustively tested),
// observation acquisition failures (no lever breaks the basis read while leaving
// the domain and HEAD commands working; an invalid `core.ignoreCase` poisons
// every git invocation, and duplicate `core.excludesFile` values are not an
// error at all), and cleanup-warning accumulation (no deterministic
// cross-platform way to make both oracle layers warn).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type PathState,
  ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  type RollbackAttempt,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { createCheckpoint } from "../src/checkpoint.js";
import { observePathState, readIndexSnapshot } from "../src/path-state.js";
import type {
  SelectiveRestoreClassification,
  SelectiveRestorePlan,
} from "../src/restore-selective.js";
import {
  runSelectiveRestoreTransaction,
  type SelectiveRestoreTransactionResult,
} from "../src/selective-restore-transaction.js";
import type {
  AttemptPublicationBinding,
  PublishedAttemptEvidence,
} from "../src/selective-transplant-gate.js";

const execFileAsync = promisify(execFile);

const GROUP = `cg_${"0".repeat(63)}1`;
const SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const ROLLBACK_ID = "rb_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CONTRIBUTION_SHA = "a".repeat(64);
const ROLLBACK_DIR = "/published/by/core/rb_01JV8Y7W2M7AABCDEFGHJKMNPQ";

const BEFORE_BYTES = "the pre-session content\n";
const AFTER_BYTES = "the session changed this\n";
const RESTORED = "src/a.ts";
/** Tracked, protected, and never part of any plan. */
const UNRELATED = "src/untouched.ts";
const UNRELATED_BYTES = "unrelated\n";

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

const read = (root: string, rel: string): Promise<string> =>
  readFile(join(root, ...rel.split("/")), "utf8");

async function currentState(repoRoot: string, path: string): Promise<PathState> {
  const index = await readIndexSnapshot(repoRoot);
  return (await observePathState(repoRoot, path, index)).state;
}

/** The BEFORE state, derived from the live observation so only bytes differ. */
function beforeOf(observed: PathState, content: string): PathState {
  if (observed.worktree.kind !== "regular") {
    throw new Error("fixture: expected a regular file");
  }
  return {
    worktree: { ...observed.worktree, content_ref: sha256(content) },
    index: observed.index,
  };
}

/**
 * Every ancestor directory of `path`, repo-relative.
 *
 * Restoring a nested path depends on the topology of the directories containing
 * it, and stabilization DERIVES that dependency set from the protected domain
 * and requires the plan to already declare it. A plan that omits them is
 * rejected with `topology_dependency`, which is what a root-level path never
 * triggers.
 */
function ancestorsOf(path: string): readonly string[] {
  const parts = path.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    ancestors.push(parts.slice(0, i).join("/"));
  }
  return ancestors;
}

function planFor(path: string, observed: PathState, before: PathState): SelectiveRestorePlan {
  const classification: SelectiveRestoreClassification = {
    path,
    changeGroupId: GROUP,
    expectedBefore: before,
    expectedAfter: observed,
    observed,
    outcome: { kind: "planned", disposition: "restore_required" },
  };
  return {
    outcome: "eligible",
    capabilities: { symlinkCheckout: true },
    selectedChangeGroupIds: [GROUP],
    classifications: [classification],
    topologyDependencyPaths: ancestorsOf(path),
    operations: [
      { kind: "restore_candidate", path, changeGroupId: GROUP, target: before, observed },
    ],
    conflicts: [],
  };
}

function attemptFor(binding: AttemptPublicationBinding): RollbackAttempt {
  return {
    schema_version: ROLLBACK_ATTEMPT_SCHEMA_VERSION,
    rollback_id: ROLLBACK_ID,
    session_id: binding.sessionId,
    contribution_sha256: binding.contributionSha256,
    pre_rollback_checkpoint_id: binding.preRollbackCheckpointId,
    selection: {
      selectors: { only: ["**"] },
      resolved_change_group_ids: [...binding.resolvedChangeGroupIds],
    },
    state: "mutation_may_have_started",
    written_at: "2026-09-01T00:00:00Z",
  };
}

interface Fixture {
  readonly repoRoot: string;
  readonly tmp: string;
  readonly plan: SelectiveRestorePlan;
  readonly sessionCheckpointDir: string;
  cleanup: () => Promise<void>;
}

/**
 * A repository whose session changed `restoredPath` from BEFORE to AFTER, a
 * session checkpoint holding BEFORE, and a plan restoring that one path.
 */
async function setupFixture(restoredPath: string = RESTORED): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-txn-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await git(repoRoot, ["config", "core.excludesFile", ""]);

  await write(repoRoot, restoredPath, BEFORE_BYTES);
  await write(repoRoot, UNRELATED, UNRELATED_BYTES);
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "pre-session"]);

  const sessionCheckpointDir = join(tmp, "session-checkpoint");
  await createCheckpoint({
    repoRoot,
    checkpointDir: sessionCheckpointDir,
    rollbackExcludePatterns: [],
  });

  // The session's change, which the transaction will undo.
  await write(repoRoot, restoredPath, AFTER_BYTES);

  const observed = await currentState(repoRoot, restoredPath);
  const plan = planFor(restoredPath, observed, beforeOf(observed, BEFORE_BYTES));

  return {
    repoRoot,
    tmp,
    plan,
    sessionCheckpointDir,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

interface Overrides<T> {
  readonly plan?: SelectiveRestorePlan;
  readonly createRecoveryCheckpoint?: () => Promise<{
    readonly checkpointId: string;
    readonly checkpointDir: string;
  }>;
  readonly publishAttempt?: (
    binding: AttemptPublicationBinding,
  ) => Promise<PublishedAttemptEvidence>;
  readonly runVerificationCommands?: () => Promise<T>;
}

async function runTransaction<T = string>(
  f: Fixture,
  over: Overrides<T> = {},
): Promise<SelectiveRestoreTransactionResult<T>> {
  let counter = 0;
  const defaultRecovery = async (): Promise<{
    readonly checkpointId: string;
    readonly checkpointDir: string;
  }> => {
    const checkpointDir = join(f.tmp, `emergency-${counter++}`);
    const { checkpointId } = await createCheckpoint({
      repoRoot: f.repoRoot,
      checkpointDir,
      rollbackExcludePatterns: [],
    });
    return { checkpointId, checkpointDir };
  };
  return runSelectiveRestoreTransaction<T>({
    repoRoot: f.repoRoot,
    plan: over.plan ?? f.plan,
    rollbackExcludePatterns: [],
    sessionCheckpointDir: f.sessionCheckpointDir,
    sessionId: SESSION_ID,
    contributionSha256: CONTRIBUTION_SHA,
    createRecoveryCheckpoint: over.createRecoveryCheckpoint ?? defaultRecovery,
    publishAttempt:
      over.publishAttempt ??
      (async (binding) => ({ attempt: attemptFor(binding), rollbackDir: ROLLBACK_DIR })),
    ...(over.runVerificationCommands === undefined
      ? {}
      : { runVerificationCommands: over.runVerificationCommands }),
  });
}

// =============================================================================
// Pre-marker outcomes, each carrying its owning module's own data
// =============================================================================

describe("runSelectiveRestoreTransaction pre-marker outcomes", () => {
  it("reports stabilization drift with the planner's differences", async () => {
    const f = await setupFixture();
    try {
      // The plan describes a world the repository has already left.
      await write(f.repoRoot, RESTORED, "drifted after planning\n");

      const result = await runTransaction(f);

      expect(result.outcome).toBe("precondition_changed");
      if (result.outcome !== "precondition_changed") {
        throw new Error("expected precondition_changed");
      }
      expect(result.source).toBe("stabilization");
      if (result.source !== "stabilization") {
        throw new Error("expected stabilization");
      }
      expect(result.differences.length).toBeGreaterThan(0);
    } finally {
      await f.cleanup();
    }
  });

  it("reports a recovery handle that reproduces a state S never had", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f, {
        // Mutate BEFORE capturing E, so E describes a different world than the
        // frozen S the transaction is judged against.
        createRecoveryCheckpoint: async () => {
          await write(f.repoRoot, UNRELATED, "changed before E was captured\n");
          const checkpointDir = join(f.tmp, "emergency-mismatch");
          const { checkpointId } = await createCheckpoint({
            repoRoot: f.repoRoot,
            checkpointDir,
            rollbackExcludePatterns: [],
          });
          return { checkpointId, checkpointDir };
        },
      });

      expect(result.outcome).toBe("recovery_handle_mismatch");
      if (result.outcome !== "recovery_handle_mismatch") {
        throw new Error("expected recovery_handle_mismatch");
      }
      expect(result.mismatch.differences.length).toBeGreaterThan(0);
      // The mismatch owns its warnings; the arm does not duplicate them.
      expect(result.mismatch.cleanupWarnings).toBeDefined();
    } finally {
      await f.cleanup();
    }
  });

  it("reports missing evidence when the oracle cannot supply a target's bytes", async () => {
    const f = await setupFixture();
    try {
      // `ghost.txt` postdates the session checkpoint, so the oracle has no copy
      // of the bytes this plan asks to restore.
      await write(f.repoRoot, "ghost.txt", "live but unknown to the oracle\n");
      const observed = await currentState(f.repoRoot, "ghost.txt");
      const plan = planFor("ghost.txt", observed, beforeOf(observed, "never existed\n"));

      const result = await runTransaction(f, { plan });

      expect(result.outcome).toBe("missing_evidence");
      if (result.outcome !== "missing_evidence") {
        throw new Error("expected missing_evidence");
      }
      expect(result.evidence.path).toBe("ghost.txt");
    } finally {
      await f.cleanup();
    }
  });

  it("reports final-fence drift, isolated from the recovery-handle check", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f, {
        // Capture E FIRST, so validation against the frozen S passes, then move
        // the live tree so only the fence can object.
        createRecoveryCheckpoint: async () => {
          const checkpointDir = join(f.tmp, "emergency-fence");
          const { checkpointId } = await createCheckpoint({
            repoRoot: f.repoRoot,
            checkpointDir,
            rollbackExcludePatterns: [],
          });
          await write(f.repoRoot, UNRELATED, "moved after E was captured\n");
          return { checkpointId, checkpointDir };
        },
      });

      expect(result.outcome).toBe("precondition_changed");
      if (result.outcome !== "precondition_changed") {
        throw new Error("expected precondition_changed");
      }
      expect(result.source).toBe("final_fence");
    } finally {
      await f.cleanup();
    }
  });
});

// =============================================================================
// F5: callback failures become data
// =============================================================================

describe("runSelectiveRestoreTransaction callback failures", () => {
  it("reports a createRecoveryCheckpoint throw with no cleanupWarnings field", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f, {
        createRecoveryCheckpoint: async () => {
          throw new Error("recovery checkpoint unavailable");
        },
      });

      expect(result.outcome).toBe("failed");
      if (result.outcome !== "failed") {
        throw new Error("expected failed");
      }
      expect(result.phase).toBe("create_recovery_checkpoint");
      // No oracle has existed, so the arm carries no warnings field at all
      // rather than an empty array that would imply "none were produced".
      expect("cleanupWarnings" in result).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("reports a publishAttempt throw as a gate failure with a possibly published marker", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f, {
        publishAttempt: async () => {
          throw new Error("marker persistence failed");
        },
      });

      expect(result.outcome).toBe("failed");
      if (result.outcome !== "failed" || result.phase !== "gate") {
        throw new Error("expected failed/gate");
      }
      // Publication may have persisted before the throw, and nothing
      // distinguishes that from a throw before it.
      expect(result.marker.status).toBe("possibly_published");
      expect(result.cleanupWarnings).toBeDefined();
    } finally {
      await f.cleanup();
    }
  });
});

// =============================================================================
// Adversarial publishAttempt: the two post-marker shapes
// =============================================================================

describe("runSelectiveRestoreTransaction post-marker shapes", () => {
  it("records a failed transplant with its verification and commands skipped", async () => {
    const f = await setupFixture("dir/file.txt");
    let commandsCalled = 0;
    try {
      const result = await runTransaction(f, {
        // The fence has already passed. Replacing the parent directory with a
        // regular file makes the executor's write fail deterministically.
        publishAttempt: async (binding) => {
          await rm(join(f.repoRoot, "dir"), { recursive: true, force: true });
          await writeFile(join(f.repoRoot, "dir"), "now a file\n", "utf8");
          return { attempt: attemptFor(binding), rollbackDir: ROLLBACK_DIR };
        },
        runVerificationCommands: async () => {
          commandsCalled += 1;
          return "ran";
        },
      });

      expect(result.outcome).toBe("settled");
      if (result.outcome !== "settled" || result.gate.outcome !== "mutation_failed") {
        throw new Error("expected settled with a failed mutation");
      }
      // First verification runs on BOTH post-marker gate outcomes.
      expect(result.verification).toBeDefined();
      expect(result.gate.progress).toBeDefined();
      expect(result.commandPhase.execution.outcome).toBe("skipped");
      if (result.commandPhase.execution.outcome !== "skipped") {
        throw new Error("expected skipped");
      }
      expect(result.commandPhase.execution.reason).toBe("transplant_failed");
      expect(result.commandPhase.integrity.outcome).toBe("not_run");
      expect(commandsCalled).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("skips commands when the transplant completed but verification is unclean", async () => {
    const f = await setupFixture();
    let commandsCalled = 0;
    try {
      const result = await runTransaction(f, {
        // An unrelated protected file moves after the fence, so the selected
        // transplant completes while verification sees an unattributed change.
        publishAttempt: async (binding) => {
          await write(f.repoRoot, UNRELATED, "mutated behind the fence\n");
          return { attempt: attemptFor(binding), rollbackDir: ROLLBACK_DIR };
        },
        runVerificationCommands: async () => {
          commandsCalled += 1;
          return "ran";
        },
      });

      expect(result.outcome).toBe("settled");
      if (result.outcome !== "settled" || result.gate.outcome !== "mutation_completed") {
        throw new Error("expected settled with a completed mutation");
      }
      expect(result.verification.violations.length).toBeGreaterThan(0);
      expect(result.commandPhase.execution.outcome).toBe("skipped");
      if (result.commandPhase.execution.outcome !== "skipped") {
        throw new Error("expected skipped");
      }
      expect(result.commandPhase.execution.reason).toBe("transplant_not_clean");
      expect(commandsCalled).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
});

// =============================================================================
// The settled sequence
// =============================================================================

describe("runSelectiveRestoreTransaction settled outcomes", () => {
  it("restores the selected path and reports not_configured when no commands exist", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f);

      expect(result.outcome).toBe("settled");
      if (result.outcome !== "settled" || result.gate.outcome !== "mutation_completed") {
        throw new Error("expected settled with a completed mutation");
      }
      expect(await read(f.repoRoot, RESTORED)).toBe(BEFORE_BYTES);
      expect(result.verification.violations).toEqual([]);
      expect(result.commandPhase).toEqual({
        execution: { outcome: "not_configured" },
        integrity: { outcome: "not_run" },
      });
    } finally {
      await f.cleanup();
    }
  });

  it("runs configured commands and reports clean integrity when they touch nothing", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f, {
        runVerificationCommands: async () => "green",
      });

      if (result.outcome !== "settled") {
        throw new Error("expected settled");
      }
      expect(result.commandPhase.execution).toEqual({ outcome: "completed", result: "green" });
      expect(result.commandPhase.integrity).toEqual({ outcome: "clean" });
    } finally {
      await f.cleanup();
    }
  });

  it("records a thrown command and STILL evaluates integrity", async () => {
    const f = await setupFixture();
    try {
      const failure = new Error("tests failed");
      const result = await runTransaction(f, {
        runVerificationCommands: async () => {
          throw failure;
        },
      });

      if (result.outcome !== "settled") {
        throw new Error("expected settled");
      }
      // What the commands DID to the repository is a separate question from
      // whether they exited zero, so C is acquired either way.
      expect(result.commandPhase.execution).toEqual({ outcome: "failed", cause: failure });
      expect(result.commandPhase.integrity).toEqual({ outcome: "clean" });
    } finally {
      await f.cleanup();
    }
  });

  it("reports project_mutated when a command writes a managed file", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f, {
        runVerificationCommands: async () => {
          await write(f.repoRoot, UNRELATED, "a command wrote this\n");
          return "done";
        },
      });

      if (result.outcome !== "settled") {
        throw new Error("expected settled");
      }
      const integrity = result.commandPhase.integrity;
      expect(integrity.outcome).toBe("project_mutated");
      if (integrity.outcome !== "project_mutated") {
        throw new Error("expected project_mutated");
      }
      expect(integrity.differences.changedPaths).toContain(UNRELATED);
      expect(integrity.headMoved).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("reports basis_changed when a command adds a self-ignored .gitignore", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f, {
        runVerificationCommands: async () => {
          // Self-ignored, so it never enters the protected domain, yet it is a
          // live rule source. Only the exclusion basis moves.
          await write(f.repoRoot, ".gitignore", ".gitignore\n");
          return "done";
        },
      });

      if (result.outcome !== "settled") {
        throw new Error("expected settled");
      }
      expect(result.commandPhase.integrity.outcome).toBe("basis_changed");
    } finally {
      await f.cleanup();
    }
  });

  it("reports headMoved for a command that commits without changing files", async () => {
    const f = await setupFixture();
    try {
      const result = await runTransaction(f, {
        runVerificationCommands: async () => {
          await git(f.repoRoot, ["commit", "--allow-empty", "-m", "a command committed"]);
          return "done";
        },
      });

      if (result.outcome !== "settled") {
        throw new Error("expected settled");
      }
      const integrity = result.commandPhase.integrity;
      expect(integrity.outcome).toBe("project_mutated");
      if (integrity.outcome !== "project_mutated") {
        throw new Error("expected project_mutated");
      }
      // An empty commit leaves every managed path exactly as verified. A
      // bytes-and-index-only check would pass this.
      expect(integrity.headMoved).toBe(true);
      expect(integrity.differences.changedPaths).toEqual([]);
      expect(integrity.differences.addedPaths).toEqual([]);
      expect(integrity.differences.removedPaths).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});
