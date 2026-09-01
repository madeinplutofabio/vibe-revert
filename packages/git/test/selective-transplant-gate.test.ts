// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the selective transplant gate (M 0.8.0 step 10F).
//
// Four sections:
//   A. before the marker      (1-3)
//   B. the marker binding     (4-7)
//   C. success and failure    (8-9)
//   D. reachability           (10)
//
// The repository is REAL because the fence observes it through
// `readIndexSnapshot` and `gitListUntracked`. The ORACLE stays a plain
// directory throughout, following 10C: every transaction here is worktree-only,
// so no index axis differs, so preparation never reads an oracle index.
//
// `publishAttempt` is a recording spy in every case. Whether it was called at
// all is the load-bearing evidence for section A, and what it received is the
// evidence for case 8.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  type PathState,
  ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  type RollbackAttempt,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { getHeadSha } from "../src/git-cli.js";
import { observePathState, readIndexSnapshot } from "../src/path-state.js";
import { captureProtectedDomain, type ProtectedDomainSnapshot } from "../src/protected-domain.js";
import type {
  SelectiveRestoreClassification,
  SelectiveRestorePlan,
} from "../src/restore-selective.js";
import {
  type AttemptPublicationBinding,
  type PublishedAttemptEvidence,
  runSelectiveTransplantGate,
  type SelectiveTransplantGateResult,
} from "../src/selective-transplant-gate.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Fixtures
// =============================================================================

const GROUP = `cg_${"0".repeat(63)}1`;
const OTHER_GROUP = `cg_${"0".repeat(63)}2`;
const SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const OTHER_SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPR";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const OTHER_CHECKPOINT_ID = "cp_01JV8Y7W2M7AABCDEFGHJKMNPR";
const ROLLBACK_ID = "rb_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CONTRIBUTION_SHA = "a".repeat(64);
const OTHER_CONTRIBUTION_SHA = "b".repeat(64);
const ROLLBACK_DIR = "/published/by/core/rb_01JV8Y7W2M7AABCDEFGHJKMNPQ";

const AFTER_BYTES = "the session changed this\n";
const BEFORE_BYTES = "the pre-session content\n";
const RESTORED = "src/a.ts";

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

/**
 * The BEFORE state, derived from the live observation.
 *
 * Only `content_ref` moves. Reusing the observed `executable` keeps the
 * `null` this platform reports, and reusing the observed index keeps both index
 * axes equal so the transaction stays worktree-only.
 */
function beforeOf(observed: PathState, content: string): PathState {
  if (observed.worktree.kind !== "regular") {
    throw new Error("fixture: expected a regular file");
  }
  return {
    worktree: { ...observed.worktree, content_ref: sha256(content) },
    index: observed.index,
  };
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
    topologyDependencyPaths: [],
    operations: [
      {
        kind: "restore_candidate",
        path,
        changeGroupId: GROUP,
        target: before,
        observed,
      },
    ],
    conflicts: [],
  };
}

// ---- The transaction --------------------------------------------------------

interface Transaction {
  readonly repo: string;
  readonly oracle: string;
  readonly plan: SelectiveRestorePlan;
  readonly snapshot: ProtectedDomainSnapshot;
  readonly headSha: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * A repository at AFTER, an oracle holding BEFORE, and a plan restoring one
 * path between them.
 *
 * `withOracleBytes: false` omits the oracle's copy, which is how case 9 forces
 * the executor to fail: the materializer reads its evidence before touching the
 * destination, and the oracle is outside the protected domain, so the fence
 * still passes and the executor is genuinely reached.
 */
async function setupTransaction(opts: { withOracleBytes?: boolean } = {}): Promise<Transaction> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-gatefixture-"));
  const repo = join(tmp, "repo");
  const oracle = join(tmp, "oracle");
  await mkdir(repo, { recursive: true });
  await mkdir(oracle, { recursive: true });

  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await write(repo, ".gitignore", ".viberevert/\n");
  await write(repo, RESTORED, AFTER_BYTES);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "seed"]);

  if (opts.withOracleBytes !== false) await write(oracle, RESTORED, BEFORE_BYTES);

  const observed = await currentState(repo, RESTORED);
  const plan = planFor(RESTORED, observed, beforeOf(observed, BEFORE_BYTES));
  const snapshot = await captureProtectedDomain({
    repoRoot: repo,
    plan,
    rollbackExcludePatterns: [],
  });
  const headSha = await getHeadSha(repo);

  return {
    repo,
    oracle,
    plan,
    snapshot,
    headSha,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

/** A repository with no commits, so the fence's HEAD read throws. */
async function setupUnbornTransaction(): Promise<Transaction> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-gateunborn-"));
  const repo = join(tmp, "repo");
  const oracle = join(tmp, "oracle");
  await mkdir(repo, { recursive: true });
  await mkdir(oracle, { recursive: true });

  await git(repo, ["init", "-b", "main"]);
  await write(repo, ".gitignore", ".viberevert/\n");
  await write(repo, RESTORED, AFTER_BYTES);
  await write(oracle, RESTORED, BEFORE_BYTES);

  const observed = await currentState(repo, RESTORED);
  const plan = planFor(RESTORED, observed, beforeOf(observed, BEFORE_BYTES));
  const snapshot = await captureProtectedDomain({
    repoRoot: repo,
    plan,
    rollbackExcludePatterns: [],
  });

  return {
    repo,
    oracle,
    plan,
    snapshot,
    // Never compared: the HEAD read throws before any comparison happens.
    headSha: "0".repeat(40),
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

// ---- The publication spy ----------------------------------------------------

interface Publisher {
  readonly calls: AttemptPublicationBinding[];
  readonly publishAttempt: (
    binding: AttemptPublicationBinding,
  ) => Promise<PublishedAttemptEvidence>;
}

function publisher(
  respond: (
    binding: AttemptPublicationBinding,
  ) => PublishedAttemptEvidence | Promise<PublishedAttemptEvidence>,
): Publisher {
  const calls: AttemptPublicationBinding[] = [];
  return {
    calls,
    publishAttempt: async (binding) => {
      calls.push(binding);
      return respond(binding);
    },
  };
}

/** A schema-valid attempt describing exactly the binding it was given. */
function attemptFor(
  binding: AttemptPublicationBinding,
  overrides: Partial<RollbackAttempt> = {},
): RollbackAttempt {
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
    ...overrides,
  };
}

const honest = (): Publisher =>
  publisher((binding) => ({ attempt: attemptFor(binding), rollbackDir: ROLLBACK_DIR }));

const runGate = (t: Transaction, p: Publisher): Promise<SelectiveTransplantGateResult> =>
  runSelectiveTransplantGate({
    repoRoot: t.repo,
    oracleWorktree: t.oracle,
    plan: t.plan,
    rollbackExcludePatterns: [],
    frozenSnapshot: t.snapshot,
    expectedHeadSha: t.headSha,
    sessionId: SESSION_ID,
    contributionSha256: CONTRIBUTION_SHA,
    preRollbackCheckpointId: CHECKPOINT_ID,
    publishAttempt: p.publishAttempt,
  });

// =============================================================================
// Section A: before the marker
// =============================================================================

describe("runSelectiveTransplantGate: before the marker", () => {
  it("1: a preparation refusal propagates, and nothing is published", async () => {
    // Pure: preparation precedes the fence, so an unusable plan throws before
    // any git access. A plan with no operations derives zero mutations.
    const p = honest();
    const empty: SelectiveRestorePlan = {
      outcome: "eligible",
      capabilities: { symlinkCheckout: true },
      selectedChangeGroupIds: [GROUP],
      classifications: [],
      topologyDependencyPaths: [],
      operations: [],
      conflicts: [],
    };

    await expect(
      runSelectiveTransplantGate({
        repoRoot: join(tmpdir(), "viberevert-gate-unused-repo"),
        oracleWorktree: join(tmpdir(), "viberevert-gate-unused-oracle"),
        plan: empty,
        rollbackExcludePatterns: [],
        frozenSnapshot: { states: new Map(), topologyWatches: new Map() },
        expectedHeadSha: "0".repeat(40),
        sessionId: SESSION_ID,
        contributionSha256: CONTRIBUTION_SHA,
        preRollbackCheckpointId: CHECKPOINT_ID,
        publishAttempt: p.publishAttempt,
      }),
    ).rejects.toThrow(/derived no mutations/);

    expect(p.calls).toEqual([]);
  });

  it("2: an unstable fence refuses BEFORE publishing anything", async () => {
    const t = await setupTransaction();
    try {
      // Drift the protected domain after S was frozen.
      await write(t.repo, "docs/appeared.txt", "new\n");

      const p = honest();
      const result = await runGate(t, p);

      expect(result.outcome).toBe("precondition_changed");
      // The fence's own structured evidence, not a re-derivation.
      if (result.outcome !== "precondition_changed") throw new Error("unreachable");
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0]?.kind).toBe("protected_domain");

      expect(p.calls).toEqual([]);
      expect(await read(t.repo, RESTORED)).toBe(AFTER_BYTES);
    } finally {
      await t.cleanup();
    }
  });

  it("3: a fence that THROWS propagates, and nothing is published", async () => {
    const t = await setupUnbornTransaction();
    try {
      // The domain capture succeeds on an unborn repository; reading HEAD does
      // not. A failed observation is not the same as observing a change, so it
      // must not become `precondition_changed`.
      const p = honest();

      await expect(runGate(t, p)).rejects.toThrow();
      expect(p.calls).toEqual([]);
      expect(await read(t.repo, RESTORED)).toBe(AFTER_BYTES);
    } finally {
      await t.cleanup();
    }
  });
});

// =============================================================================
// Section B: the marker binding
// =============================================================================

describe("runSelectiveTransplantGate: the marker binding", () => {
  it("4: a marker naming a DIFFERENT recovery checkpoint never reaches the executor", async () => {
    // The property this binding exists for. A schema-valid marker pointing at
    // some other checkpoint would hand an operator a recovery handle nothing
    // ever validated against S.
    const t = await setupTransaction();
    try {
      const p = publisher((binding) => ({
        attempt: attemptFor(binding, { pre_rollback_checkpoint_id: OTHER_CHECKPOINT_ID }),
        rollbackDir: ROLLBACK_DIR,
      }));

      await expect(runGate(t, p)).rejects.toThrow(
        /names recovery checkpoint .*but the validated recovery handle is/,
      );

      expect(p.calls).toHaveLength(1);
      // Mutation was unreachable: the tree is untouched.
      expect(await read(t.repo, RESTORED)).toBe(AFTER_BYTES);
    } finally {
      await t.cleanup();
    }
  });

  it("5: a marker describing a different transaction never reaches the executor", async () => {
    const t = await setupTransaction();
    try {
      const rows: readonly [string, Partial<RollbackAttempt>, RegExp][] = [
        ["session", { session_id: OTHER_SESSION_ID }, /names session .*but this transaction/],
        [
          "contribution",
          { contribution_sha256: OTHER_CONTRIBUTION_SHA },
          /names contribution .*but this transaction/,
        ],
        [
          "resolved groups",
          {
            selection: {
              selectors: { only: ["**"] },
              resolved_change_group_ids: [OTHER_GROUP],
            },
          },
          /misdescribes the mutation it authorizes/,
        ],
      ];

      for (const [label, overrides, message] of rows) {
        const p = publisher((binding) => ({
          attempt: attemptFor(binding, overrides),
          rollbackDir: ROLLBACK_DIR,
        }));

        await expect(runGate(t, p), label).rejects.toThrow(message);
        expect(p.calls, label).toHaveLength(1);
        expect(await read(t.repo, RESTORED), label).toBe(AFTER_BYTES);
      }
    } finally {
      await t.cleanup();
    }
  });

  it("6: a schema-invalid publication result is refused before the binding check", async () => {
    const t = await setupTransaction();
    try {
      // A malformed rollback id fails the schema's own refinement, so the
      // transaction binding is never consulted.
      const p = publisher((binding) => ({
        attempt: attemptFor(binding, { rollback_id: "not-a-rollback-id" }),
        rollbackDir: ROLLBACK_DIR,
      }));

      await expect(runGate(t, p)).rejects.toThrow(/rollback_id/);
      expect(p.calls).toHaveLength(1);
      expect(await read(t.repo, RESTORED)).toBe(AFTER_BYTES);
    } finally {
      await t.cleanup();
    }
  });

  it("7: a publication that REJECTS stops the gate, and its rejection propagates", async () => {
    const t = await setupTransaction();
    try {
      const failure = new Error("core refused to publish the marker");
      const p = publisher(() => Promise.reject(failure));

      // The middle boundary: unlike an unstable fence the callback DID run, and
      // unlike an execution failure no mutation may follow.
      await expect(runGate(t, p)).rejects.toThrow(failure);
      expect(p.calls).toHaveLength(1);
      expect(await read(t.repo, RESTORED)).toBe(AFTER_BYTES);
    } finally {
      await t.cleanup();
    }
  });
});

// =============================================================================
// Section C: success and failure
// =============================================================================

describe("runSelectiveTransplantGate: success and failure", () => {
  it("8: publishes the exact binding, then mutates, in that order", async () => {
    const t = await setupTransaction();
    try {
      let observedDuringPublication: string | undefined;
      const p = publisher(async (binding) => {
        // Inside the callback the marker is being written and NOTHING has been
        // mutated yet. Reading here proves the ordering directly, rather than
        // inferring it from two facts observed afterwards.
        observedDuringPublication = await read(t.repo, RESTORED);
        return { attempt: attemptFor(binding), rollbackDir: ROLLBACK_DIR };
      });

      const result = await runGate(t, p);

      expect(observedDuringPublication).toBe(AFTER_BYTES);
      expect(await read(t.repo, RESTORED)).toBe(BEFORE_BYTES);

      // The gate constructs the binding; the caller does not reconstruct it.
      expect(p.calls).toEqual([
        {
          sessionId: SESSION_ID,
          contributionSha256: CONTRIBUTION_SHA,
          preRollbackCheckpointId: CHECKPOINT_ID,
          resolvedChangeGroupIds: [GROUP],
        },
      ]);
      expect(p.calls[0]?.resolvedChangeGroupIds).toEqual(t.plan.selectedChangeGroupIds);

      expect(result.outcome).toBe("mutated");
      if (result.outcome !== "mutated") throw new Error("unreachable");
      expect(result.rollbackDir).toBe(ROLLBACK_DIR);
      expect(result.attempt.pre_rollback_checkpoint_id).toBe(CHECKPOINT_ID);
    } finally {
      await t.cleanup();
    }
  });

  it("9: an executor failure returns mutation_failed carrying the evidence", async () => {
    // The oracle has no copy of the restored path, so the materializer fails
    // while reading its evidence. The oracle is outside the protected domain,
    // so the fence still passes and the executor is genuinely reached.
    const t = await setupTransaction({ withOracleBytes: false });
    try {
      const p = honest();
      const result = await runGate(t, p);

      expect(result.outcome).toBe("mutation_failed");
      if (result.outcome !== "mutation_failed") throw new Error("unreachable");

      // The evidence survives the failure, because past this point a marker
      // exists and the caller must be able to record a receipt for it.
      expect(result.rollbackDir).toBe(ROLLBACK_DIR);
      expect(result.attempt.pre_rollback_checkpoint_id).toBe(CHECKPOINT_ID);
      expect(result.attempt.session_id).toBe(SESSION_ID);

      // The primitive's own failure, not a wrapped one. `cause` is typed
      // `unknown` because JavaScript permits throwing any value; this asserts
      // the value by type and message rather than pretending to hold a
      // reference to an object the gate created internally.
      expect(result.cause).toBeInstanceOf(Error);
      expect((result.cause as Error).message).toMatch(RESTORED);

      // Nothing was written before the failure.
      expect(await read(t.repo, RESTORED)).toBe(AFTER_BYTES);
    } finally {
      await t.cleanup();
    }
  });
});

// =============================================================================
// Section D: reachability
// =============================================================================

describe("source invariant", () => {
  it("10: the executor has exactly one approved production caller, this gate", async () => {
    const srcDir = new URL("../src/", import.meta.url);
    const APPROVED_CALLER = "selective-transplant-gate.ts";

    // Specific to the EXECUTOR symbol, not the module: the gate legitimately
    // imports `prepareSelectiveTransplant` from the same file, so a
    // module-level assertion would stay green if the mutation call vanished.
    const approved = await readFile(new URL(APPROVED_CALLER, srcDir), "utf8");
    expect(approved).toMatch(
      /import\s*\{[^}]*\bexecutePreparedSelectiveTransplant\b[^}]*\}\s*from\s*["']\.\/transplant-schedule\.js["']/s,
    );
    expect(approved).toMatch(/\bexecutePreparedSelectiveTransplant\s*\(/);

    const names = (await readdir(srcDir)).filter(
      (name) =>
        name.endsWith(".ts") && name !== "transplant-schedule.ts" && name !== APPROVED_CALLER,
    );
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const source = await readFile(new URL(name, srcDir), "utf8");
      expect(source, `${name} imports the internal-only scheduler`).not.toMatch(
        /from\s*["']\.\/transplant-schedule\.js["']/,
      );
    }

    // Neither the scheduler nor the gate is reachable from outside the package
    // until the cli-commands orchestration lands.
    const barrel = await readFile(new URL("index.ts", srcDir), "utf8");
    expect(barrel).not.toContain("transplant-schedule");
    expect(barrel).not.toContain("selective-transplant-gate");
  });
});
