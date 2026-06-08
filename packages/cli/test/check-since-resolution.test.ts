// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Behavioral tests for `resolveCheckBase` in
// `packages/cli/src/check-since-resolution.ts`.
//
// All tests are filesystem-real: temp git repo + real `createCheckpoint`
// calls from @viberevert/git + direct schema-typed writes of
// session.json / active-session.json (the same pattern
// start-end.test.ts uses for session fixtures — bypassing
// core.startSession to avoid coupling to its low-level signature).
//
// Five sections:
//   1. Happy-path dispatch (7 tests, one per dispatch arm)
//   2. --staged + snapshot-base mutual exclusion (3 tests)
//   3. Typed-error propagation + name-fallback wrap (3 tests)
//   4. Active-session lock path-traversal defense (1 test)
//   5. Env-override pass-through across base families (1 table-style test)
//
// Total: 15 tests. Scope-narrowed test for the "post-resolve failure
// NOT wrapped as CheckpointNameNotFoundError" path is intentionally
// SKIPPED here — it requires vi.mock of @viberevert/git which would
// make this otherwise behavioral test file brittle. The narrow try/catch
// in the resolver source is structurally obvious; if a CI-time lock
// becomes valuable, ship as a separate mock-focused test file.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ensureViberevertDirs, generateSessionId, SessionNotFoundError } from "@viberevert/core";
import { CheckpointNotFoundError, CommitRefNotFoundError, createCheckpoint } from "@viberevert/git";
import {
  type ActiveSessionLock,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { renameDirAtomic } from "../src/atomic.js";
import {
  CheckpointNameNotFoundError,
  type ResolvedCheckBase,
  resolveCheckBase,
  StagedIncompatibleWithSnapshotBaseError,
} from "../src/check-since-resolution.js";
import { VIBEREVERT_TEST_FIXED_SHA } from "../src/runtime-env.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Constants
// =============================================================================

/** Fixed timestamp used in all directly-written session fixtures. */
const SESSION_STARTED_AT = "2026-01-01T00:00:00Z";

/** Sentinel SHA used in the env-override test. */
const SENTINEL_SHA = "0".repeat(40);

// =============================================================================
// Test helpers
// =============================================================================

interface TestRepo {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], {
    cwd,
    windowsHide: true,
  });
  return String(stdout);
}

/**
 * Real temp git repo with .gitignore + initial commit + .viberevert/
 * subdirs ensured. Returns repoRoot + cleanup closure. Pattern mirrors
 * git-cli.test.ts / diff.test.ts with a distinct mkdtemp prefix so
 * cleanup-listing helpers in other test files don't collide.
 */
async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-resolver-test-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init", "-q", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@test.test"]);
  await runGit(repoRoot, ["config", "user.name", "Test"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["commit", "-q", "-m", "initial"]);
  await ensureViberevertDirs(repoRoot);
  return {
    repoRoot,
    cleanup: async () => {
      await rm(tmp, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    },
  };
}

/** Get the current HEAD SHA via direct git invocation. */
async function getHeadSha(repoRoot: string): Promise<string> {
  return (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
}

/**
 * Add a second commit so HEAD~1 resolves. Used by test 2c (the
 * omitted+no-active+no-staged default uses --since HEAD~1).
 */
async function addSecondCommit(repoRoot: string): Promise<void> {
  await writeFile(join(repoRoot, "second.txt"), "second\n");
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["commit", "-q", "-m", "second"]);
}

/**
 * Materialize a standalone checkpoint at
 * `.viberevert/checkpoints/<cp_<ULID>>/` using the same flow as
 * checkpoint.ts: createCheckpoint into a `.tmp-checkpoint-<hex>/` dir,
 * then renameDirAtomic to the final id-bearing dir. The random suffix
 * uses the same `randomBytes(8).toString("hex")` form as the production
 * code to avoid style divergence in fixture helpers.
 */
async function makeStandaloneCheckpoint(
  repoRoot: string,
  opts: { name?: string } = {},
): Promise<{ checkpointId: string; checkpointDir: string }> {
  const tmpName = `.tmp-checkpoint-${randomBytes(8).toString("hex")}`;
  const tmpDirAbs = join(repoRoot, ".viberevert", "checkpoints", tmpName);
  const result = await createCheckpoint({
    repoRoot,
    checkpointDir: tmpDirAbs,
    rollbackExcludePatterns: [],
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  });
  const finalDir = join(repoRoot, ".viberevert", "checkpoints", result.checkpointId);
  await renameDirAtomic(tmpDirAbs, finalDir);
  return { checkpointId: result.checkpointId, checkpointDir: finalDir };
}

/**
 * Materialize a session at `.viberevert/sessions/<sess_<ULID>>/` with:
 *   - inner checkpoint at `<sess>/checkpoint/` (real manifest via
 *     createCheckpoint — the resolver loads it via loadCheckpoint)
 *   - session.json + before-status.txt + commands.log via direct
 *     schema-typed writes (same pattern as start-end.test.ts's
 *     setupActiveSession)
 *   - optional active-session.json lock at .viberevert/ root
 *
 * The schema fields are written via the public SessionState /
 * ActiveSessionLock types from @viberevert/session-format so any
 * future schema extension would surface at compile time here.
 */
async function makeSession(
  repoRoot: string,
  opts: { task?: string; markAsActive?: boolean } = {},
): Promise<{ sessionId: string; checkpointId: string }> {
  const sessionId = generateSessionId();
  const sessionDir = join(repoRoot, ".viberevert", "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  // Real inner checkpoint with a valid manifest. createCheckpoint
  // creates the target dir itself; we just provide the path.
  const innerCheckpointDir = join(sessionDir, "checkpoint");
  const ckptResult = await createCheckpoint({
    repoRoot,
    checkpointDir: innerCheckpointDir,
    rollbackExcludePatterns: [],
  });
  const checkpointId = ckptResult.checkpointId;

  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: sessionId,
    checkpoint_id: checkpointId,
    started_at: SESSION_STARTED_AT,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    before_status_path: `.viberevert/sessions/${sessionId}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${sessionId}/commands.log`,
  };
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState, null, 2));
  await writeFile(join(sessionDir, "before-status.txt"), "");
  await writeFile(join(sessionDir, "commands.log"), "");

  if (opts.markAsActive === true) {
    const lock: ActiveSessionLock = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: sessionId,
      checkpoint_id: checkpointId,
      started_at: SESSION_STARTED_AT,
      ...(opts.task !== undefined ? { task: opts.task } : {}),
    };
    await writeFile(
      join(repoRoot, ".viberevert", "active-session.json"),
      JSON.stringify(lock, null, 2),
    );
  }

  return { sessionId, checkpointId };
}

/**
 * For the section-4 path-traversal-defense test: read the existing
 * active-session.json, mutate ONLY session_id to the given bogus
 * value, and write it back. Preserves all other schema-required
 * fields (so the file still parses against ActiveSessionLockSchema —
 * the defense fires at the resolver's regex check, not at schema
 * parse time).
 */
async function corruptActiveLockSessionId(repoRoot: string, bogusSessionId: string): Promise<void> {
  const lockPath = join(repoRoot, ".viberevert", "active-session.json");
  const raw = await readFile(lockPath, "utf8");
  const parsed = JSON.parse(raw) as ActiveSessionLock & Record<string, unknown>;
  const mutated = { ...parsed, session_id: bogusSessionId };
  await writeFile(lockPath, JSON.stringify(mutated, null, 2));
}

/**
 * Helper to narrow a ResolvedCheckBase to its "checkpoint" variant in
 * tests that need access to `checkpointDir` / `checkpointId` / `task`.
 * Throws (fails the test) if the actual mode is "git-ref".
 */
function asCheckpointBase(
  base: ResolvedCheckBase,
): Extract<ResolvedCheckBase, { mode: "checkpoint" }> {
  if (base.mode !== "checkpoint") {
    throw new Error(`expected checkpoint mode, got ${base.mode}`);
  }
  return base;
}

/**
 * Helper to narrow a ResolvedCheckBase to its "git-ref" variant.
 * Throws if the actual mode is "checkpoint".
 */
function asGitRefBase(base: ResolvedCheckBase): Extract<ResolvedCheckBase, { mode: "git-ref" }> {
  if (base.mode !== "git-ref") {
    throw new Error(`expected git-ref mode, got ${base.mode}`);
  }
  return base;
}

// =============================================================================
// Tests
// =============================================================================

describe("resolveCheckBase", () => {
  // ---------------------------------------------------------------------------
  // Section 1 — Happy-path dispatch arms (D26)
  // ---------------------------------------------------------------------------

  describe("Section 1 — happy-path dispatch arms", () => {
    it("1a: --since sess_<ULID> → session_bound from named session", async () => {
      const repo = await setupRepo();
      try {
        const { sessionId, checkpointId } = await makeSession(repo.repoRoot, {
          task: "fix the bug",
        });
        const base = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          since: sessionId,
          staged: false,
        });
        const cb = asCheckpointBase(base);
        expect(cb.kind).toBe("session_bound");
        expect(cb.sinceKind).toBe("session_id");
        expect(cb.sinceRef).toBe(sessionId);
        expect(cb.reportId).toBe(sessionId); // D31 identity
        expect(cb.checkpointId).toBe(checkpointId);
        expect(cb.startedAt).toBe(SESSION_STARTED_AT);
        expect(cb.task).toBe("fix the bug");
        expect(cb.stagedOnly).toBe(false);
        // sinceResolvedSha = the inner checkpoint manifest's head_sha,
        // which (since the session's inner checkpoint was created at
        // the initial commit) equals the initial HEAD SHA.
        const headSha = await getHeadSha(repo.repoRoot);
        expect(cb.sinceResolvedSha).toBe(headSha);
      } finally {
        await repo.cleanup();
      }
    });

    it("1b: --since cp_<ULID> → ad_hoc from named checkpoint id", async () => {
      const repo = await setupRepo();
      try {
        const { checkpointId, checkpointDir } = await makeStandaloneCheckpoint(repo.repoRoot);
        const base = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          since: checkpointId,
          staged: false,
        });
        const cb = asCheckpointBase(base);
        expect(cb.kind).toBe("ad_hoc");
        expect(cb.sinceKind).toBe("checkpoint_id");
        expect(cb.sinceRef).toBe(checkpointId);
        expect(cb.checkpointDir).toBe(checkpointDir);
        expect(cb.checkpointId).toBeUndefined(); // only set for session_bound
        expect(cb.task).toBeUndefined();
        expect(cb.stagedOnly).toBe(false);
        // reportId is a fresh rpt_<ULID> for ad-hoc.
        expect(cb.reportId).toMatch(/^rpt_[0-9A-HJKMNP-TV-Z]{26}$/);
      } finally {
        await repo.cleanup();
      }
    });

    it("1c: --since <name> → ad_hoc via findCheckpointByName", async () => {
      const repo = await setupRepo();
      try {
        const { checkpointDir } = await makeStandaloneCheckpoint(repo.repoRoot, {
          name: "baseline",
        });
        const base = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          since: "baseline",
          staged: false,
        });
        const cb = asCheckpointBase(base);
        expect(cb.kind).toBe("ad_hoc");
        expect(cb.sinceKind).toBe("checkpoint_name");
        expect(cb.sinceRef).toBe("baseline"); // user input preserved
        expect(cb.checkpointDir).toBe(checkpointDir);
        expect(cb.checkpointId).toBeUndefined();
        expect(cb.task).toBeUndefined();
        expect(cb.reportId).toMatch(/^rpt_[0-9A-HJKMNP-TV-Z]{26}$/);
      } finally {
        await repo.cleanup();
      }
    });

    it("1d: --since <git SHA> → git-ref mode (not staged)", async () => {
      const repo = await setupRepo();
      try {
        const headSha = await getHeadSha(repo.repoRoot);
        const base = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          since: headSha,
          staged: false,
        });
        const gb = asGitRefBase(base);
        expect(gb.kind).toBe("ad_hoc");
        expect(gb.sinceKind).toBe("git_ref");
        expect(gb.sinceRef).toBe(headSha);
        expect(gb.sinceResolvedSha).toBe(headSha);
        expect(gb.stagedOnly).toBe(false);
        expect(gb.task).toBeUndefined();
        expect(gb.reportId).toMatch(/^rpt_[0-9A-HJKMNP-TV-Z]{26}$/);
      } finally {
        await repo.cleanup();
      }
    });

    it("2a: omitted + --staged → git-ref HEAD with stagedOnly=true", async () => {
      const repo = await setupRepo();
      try {
        // Per D58: --staged short-circuits the active-session default.
        // Materialize an active session to prove the short-circuit
        // fires (resolver must NOT use the active session).
        await makeSession(repo.repoRoot, { markAsActive: true });
        const base = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          staged: true,
        });
        const gb = asGitRefBase(base);
        expect(gb.sinceKind).toBe("git_ref");
        expect(gb.sinceRef).toBe("HEAD");
        expect(gb.stagedOnly).toBe(true);
        expect(gb.kind).toBe("ad_hoc");
      } finally {
        await repo.cleanup();
      }
    });

    it("2b: omitted + active session → session_bound from active_session", async () => {
      const repo = await setupRepo();
      try {
        const { sessionId, checkpointId } = await makeSession(repo.repoRoot, {
          task: "active task",
          markAsActive: true,
        });
        const base = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          staged: false,
        });
        const cb = asCheckpointBase(base);
        expect(cb.kind).toBe("session_bound");
        expect(cb.sinceKind).toBe("active_session"); // NOT session_id
        expect(cb.sinceRef).toBe(sessionId); // derived from active lock
        expect(cb.reportId).toBe(sessionId);
        expect(cb.checkpointId).toBe(checkpointId);
        expect(cb.task).toBe("active task");
      } finally {
        await repo.cleanup();
      }
    });

    it("2c: omitted + no active session + no --staged → git-ref HEAD~1", async () => {
      const repo = await setupRepo();
      try {
        // Need a second commit so HEAD~1 resolves.
        await addSecondCommit(repo.repoRoot);
        const base = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          staged: false,
        });
        const gb = asGitRefBase(base);
        expect(gb.sinceKind).toBe("git_ref");
        expect(gb.sinceRef).toBe("HEAD~1");
        expect(gb.stagedOnly).toBe(false);
        // sinceResolvedSha should equal the FIRST commit (the one HEAD~1
        // points to after addSecondCommit).
        const firstSha = (await runGit(repo.repoRoot, ["rev-parse", "HEAD~1"])).trim();
        expect(gb.sinceResolvedSha).toBe(firstSha);
      } finally {
        await repo.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Section 2 — --staged + snapshot-base mutual exclusion (D58)
  // ---------------------------------------------------------------------------

  describe("Section 2 — --staged + snapshot-base mutual exclusion", () => {
    it("--staged + --since sess_<ULID> throws with baseKind=session", async () => {
      const repo = await setupRepo();
      try {
        const { sessionId } = await makeSession(repo.repoRoot);
        let caught: unknown;
        try {
          await resolveCheckBase({
            repoRoot: repo.repoRoot,
            since: sessionId,
            staged: true,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(StagedIncompatibleWithSnapshotBaseError);
        const err = caught as StagedIncompatibleWithSnapshotBaseError;
        expect(err.sinceArg).toBe(sessionId);
        expect(err.baseKind).toBe("session");
      } finally {
        await repo.cleanup();
      }
    });

    it("--staged + --since cp_<ULID> throws with baseKind=checkpoint", async () => {
      const repo = await setupRepo();
      try {
        const { checkpointId } = await makeStandaloneCheckpoint(repo.repoRoot);
        let caught: unknown;
        try {
          await resolveCheckBase({
            repoRoot: repo.repoRoot,
            since: checkpointId,
            staged: true,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(StagedIncompatibleWithSnapshotBaseError);
        const err = caught as StagedIncompatibleWithSnapshotBaseError;
        expect(err.sinceArg).toBe(checkpointId);
        expect(err.baseKind).toBe("checkpoint");
      } finally {
        await repo.cleanup();
      }
    });

    it("--staged + --since <name> throws with baseKind=checkpoint-name", async () => {
      const repo = await setupRepo();
      try {
        await makeStandaloneCheckpoint(repo.repoRoot, { name: "baseline" });
        let caught: unknown;
        try {
          await resolveCheckBase({
            repoRoot: repo.repoRoot,
            since: "baseline",
            staged: true,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(StagedIncompatibleWithSnapshotBaseError);
        const err = caught as StagedIncompatibleWithSnapshotBaseError;
        expect(err.sinceArg).toBe("baseline");
        expect(err.baseKind).toBe("checkpoint-name");
      } finally {
        await repo.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Section 3 — typed-error propagation + name-fallback wrap
  // ---------------------------------------------------------------------------

  describe("Section 3 — typed-error propagation + name-fallback wrap", () => {
    it("--since sess_<nonexistent> propagates SessionNotFoundError (not wrapped as CheckpointNameNotFoundError)", async () => {
      const repo = await setupRepo();
      try {
        // A well-formed sess_<ULID> that doesn't exist on disk. Should
        // propagate the owner-package error from core.loadSession, NOT
        // wrap as CheckpointNameNotFoundError (the sess_ pattern is
        // distinctive enough that the resolver does NOT fall through
        // to name/git-ref interpretation).
        const bogus = "sess_01JV8Y7W2M7AAAAAAAAAAAAAAA";
        let caught: unknown;
        try {
          await resolveCheckBase({
            repoRoot: repo.repoRoot,
            since: bogus,
            staged: false,
          });
        } catch (err) {
          caught = err;
        }
        // Positive: the resolver propagated the EXACT owner-package
        // error class from core.loadSession. This locks the
        // propagation contract — a random Error, a ZodError, a path
        // bug, or a schema-validation drift would NOT pass.
        expect(caught).toBeInstanceOf(SessionNotFoundError);
        // Negative: also lock that the resolver did NOT mistakenly
        // wrap into one of its own typed errors. Both assertions
        // together pin the full no-wrap contract.
        expect(caught).not.toBeInstanceOf(CheckpointNameNotFoundError);
        expect(caught).not.toBeInstanceOf(StagedIncompatibleWithSnapshotBaseError);
      } finally {
        await repo.cleanup();
      }
    });

    it("--since cp_<nonexistent> propagates CheckpointNotFoundError (not wrapped as CheckpointNameNotFoundError)", async () => {
      const repo = await setupRepo();
      try {
        // A well-formed cp_<ULID> that doesn't exist on disk. Should
        // propagate the owner-package error from git.loadCheckpoint,
        // NOT wrap as CheckpointNameNotFoundError.
        const bogus = "cp_01JV8Y7W2M7AAAAAAAAAAAAAAA";
        let caught: unknown;
        try {
          await resolveCheckBase({
            repoRoot: repo.repoRoot,
            since: bogus,
            staged: false,
          });
        } catch (err) {
          caught = err;
        }
        // Positive: the resolver propagated the EXACT owner-package
        // error class from git.loadCheckpoint. Same rationale as the
        // sess_ test above — locks the full propagation contract.
        expect(caught).toBeInstanceOf(CheckpointNotFoundError);
        // Negative: also lock that the resolver did NOT mistakenly
        // wrap into one of its own typed errors.
        expect(caught).not.toBeInstanceOf(CheckpointNameNotFoundError);
        expect(caught).not.toBeInstanceOf(StagedIncompatibleWithSnapshotBaseError);
      } finally {
        await repo.cleanup();
      }
    });

    it("--since <neither-name-nor-ref> throws CheckpointNameNotFoundError with CommitRefNotFoundError as cause", async () => {
      const repo = await setupRepo();
      try {
        // A value that:
        //   - is NOT a sess_/cp_ pattern
        //   - does NOT match any checkpoint name (no checkpoints exist)
        //   - is NOT a valid git ref
        // → name-fallback wrap fires.
        const bogus = "definitely-not-a-real-ref-or-name";
        let caught: unknown;
        try {
          await resolveCheckBase({
            repoRoot: repo.repoRoot,
            since: bogus,
            staged: false,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(CheckpointNameNotFoundError);
        const err = caught as CheckpointNameNotFoundError & { cause?: unknown };
        expect(err.sinceArg).toBe(bogus);
        // The wrap preserves the underlying CommitRefNotFoundError on
        // `cause` via the standard Error options API. Direct property
        // access works regardless of cause enumerability.
        expect(err.cause).toBeInstanceOf(CommitRefNotFoundError);
      } finally {
        await repo.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Section 4 — active-session lock path-traversal defense
  // ---------------------------------------------------------------------------

  describe("Section 4 — active-session lock path-traversal defense", () => {
    it("corrupt active-lock session_id ('../..') throws plain Error BEFORE path.join", async () => {
      const repo = await setupRepo();
      try {
        // Start with a valid active session, then mutate ONLY the
        // session_id field to a path-traversal vector. The schema
        // still parses (nonBlankString accepts '../..') but the
        // resolver's defensive regex check rejects.
        await makeSession(repo.repoRoot, { markAsActive: true });
        await corruptActiveLockSessionId(repo.repoRoot, "../..");
        let caught: unknown;
        try {
          await resolveCheckBase({
            repoRoot: repo.repoRoot,
            staged: false,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        // Defensive check: the message names the source ("active-session
        // lock") AND the expected shape, so a future contributor reading
        // the failure understands the rejection. We don't lock the exact
        // wording — substring match on the diagnostic phrase is enough.
        const err = caught as Error;
        expect(err.message).toContain("active-session lock");
        expect(err.message).toContain("sess_");
        // Also assert it's NOT one of the typed CheckpointName/Staged
        // errors — those would indicate the regex defense never fired.
        expect(caught).not.toBeInstanceOf(CheckpointNameNotFoundError);
        expect(caught).not.toBeInstanceOf(StagedIncompatibleWithSnapshotBaseError);
      } finally {
        await repo.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Section 5 — env-override pass-through across base families
  // ---------------------------------------------------------------------------

  describe("Section 5 — env-override pass-through", () => {
    it("VIBEREVERT_TEST_FIXED_SHA env override applies to sinceResolvedSha across git-ref AND checkpoint-id bases", async () => {
      const repo = await setupRepo();
      try {
        const env = { ...process.env, [VIBEREVERT_TEST_FIXED_SHA]: SENTINEL_SHA };

        // Sub-case A: git-ref base routes through
        // resolveSinceResolvedShaForReport in the git-ref resolver arm.
        const headSha = await getHeadSha(repo.repoRoot);
        const gitRefBase = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          since: headSha,
          staged: false,
          env,
        });
        expect(gitRefBase.sinceResolvedSha).toBe(SENTINEL_SHA);
        // Sanity: the override didn't accidentally land on other SHA-shaped
        // fields. sinceRef stays the verbatim user input.
        expect(gitRefBase.sinceRef).toBe(headSha);

        // Sub-case B: checkpoint-id base routes through
        // resolveSinceResolvedShaForReport in the checkpoint resolver
        // arm. Proves BOTH resolver families share the env-override
        // pass-through.
        const { checkpointId } = await makeStandaloneCheckpoint(repo.repoRoot);
        const checkpointBase = await resolveCheckBase({
          repoRoot: repo.repoRoot,
          since: checkpointId,
          staged: false,
          env,
        });
        expect(checkpointBase.sinceResolvedSha).toBe(SENTINEL_SHA);
        expect(checkpointBase.sinceRef).toBe(checkpointId);
      } finally {
        await repo.cleanup();
      }
    });
  });
});
