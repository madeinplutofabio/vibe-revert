// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Operation-layer tests for startSessionOperation. Focused on contract
// specifics that distinguish the operation boundary from the Command
// boundary:
//
//   1. Typed result shape (StartSessionOperationResult).
//   2. D99.M.21 cwd-binding — operation uses opts.cwd, never
//      process.cwd().
//   3. Typed errors thrown (caller-observable without stderr scraping).
//   4. D22 lock-metadata command label — both the CLI default and the
//      MCP override are observed at the lock boundary via a mocked
//      withExclusiveLock, proving the resolved command is actually
//      passed through (not silently dropped).
//
// CLI-level coverage (stderr copy, exit codes, harness wiring) stays in
// start-end.test.ts as drift-detection layer 1 — that file MUST continue
// to pass against the refactored StartCommand.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RepoRootNotFoundError, SessionAlreadyActiveError } from "@viberevert/core";
import {
  type ActiveSessionLock,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
  SessionStateSchema,
} from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LockInfo } from "../../src/locks.js";
import {
  type StartSessionOperationResult,
  startSessionOperation,
} from "../../src/operations/start-session.js";

const execFileAsync = promisify(execFile);

const PRE_EXISTING_SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const PRE_EXISTING_CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const PRE_EXISTING_STARTED_AT = "2026-05-04T10:30:11Z";

let tmpRoot: string;
let originalCwd: string;

/**
 * Create a real git repo + minimal `.viberevert.yml` + `.gitignore`.
 * Operations are config-required (D19) so .viberevert.yml is mandatory.
 * NO `process.chdir` here — operations use opts.cwd, not process.cwd().
 * (The afterEach DOES restore the original cwd, which is set by the
 * cwd-binding test to confirm the operation isolates correctly.)
 */
async function setupRepo(): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: tmpRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.test",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
    { cwd: tmpRoot },
  );
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  // Minimal valid .viberevert.yml — empty body is rejected by
  // ConfigSchema, so we provide the smallest passing shape.
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\nchecks:\n  secrets: true\n");
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-startop-"));
  originalCwd = process.cwd();
  await setupRepo();
});

afterEach(async () => {
  // Restore cwd (the cwd-binding test changes it; restoring before rm
  // avoids Windows file-lock issues per the existing CLI test pattern).
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("startSessionOperation — typed result shape", () => {
  it("returns {sessionId, checkpointId, startedAt} with valid ULID prefixes and writes matching active-session.json", async () => {
    const result: StartSessionOperationResult = await startSessionOperation({
      cwd: tmpRoot,
    });

    // Typed shape assertions.
    expect(result.sessionId).toMatch(/^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.checkpointId).toMatch(/^cp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // On-disk: active-session.json reflects the same ids/timestamp.
    const lockJson = JSON.parse(
      await readFile(join(tmpRoot, ".viberevert", "active-session.json"), "utf8"),
    ) as ActiveSessionLock;
    expect(lockJson.session_id).toBe(result.sessionId);
    expect(lockJson.checkpoint_id).toBe(result.checkpointId);
    expect(lockJson.started_at).toBe(result.startedAt);

    // session.json on disk parses cleanly via the canonical schema.
    const sessionStateJson = JSON.parse(
      await readFile(
        join(tmpRoot, ".viberevert", "sessions", result.sessionId, "session.json"),
        "utf8",
      ),
    ) as unknown;
    const parsed: SessionState = SessionStateSchema.parse(sessionStateJson);
    expect(parsed.schema_version).toBe(SESSION_STATE_SCHEMA_VERSION);
    expect(parsed.session_id).toBe(result.sessionId);
  });
});

describe("startSessionOperation — D99.M.21 cwd binding (critical operation-contract boundary)", () => {
  it("uses opts.cwd, NOT process.cwd(): session is created at opts.cwd even when process.cwd() points elsewhere", async () => {
    // Chdir to a totally unrelated directory. If the operation reads
    // process.cwd() (bug), it would try to resolve a repo from there
    // and either fail or create the session in the wrong place.
    const unrelatedDir = await mkdtemp(join(tmpdir(), "viberevert-startop-unrelated-"));
    try {
      process.chdir(unrelatedDir);

      const result = await startSessionOperation({ cwd: tmpRoot });

      // Session artifact MUST exist under tmpRoot (the opts.cwd repo).
      const sessionDir = join(tmpRoot, ".viberevert", "sessions", result.sessionId);
      await expect(readFile(join(sessionDir, "session.json"), "utf8")).resolves.toContain(
        result.sessionId,
      );

      // And MUST NOT exist under unrelatedDir.
      await expect(
        readFile(join(unrelatedDir, ".viberevert", "active-session.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      // Restore before tmpRoot cleanup so afterEach's rm doesn't fail
      // (Windows file locks). The afterEach also restores originalCwd
      // to be doubly sure.
      process.chdir(originalCwd);
      await rm(unrelatedDir, { recursive: true, force: true });
    }
  });
});

describe("startSessionOperation — typed errors", () => {
  it("throws RepoRootNotFoundError when opts.cwd is not a git/viberevert project", async () => {
    const nonRepoDir = await mkdtemp(join(tmpdir(), "viberevert-startop-norepo-"));
    try {
      await expect(startSessionOperation({ cwd: nonRepoDir })).rejects.toBeInstanceOf(
        RepoRootNotFoundError,
      );
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true });
    }
  });

  it("throws SessionAlreadyActiveError carrying the active lock data when a session already exists", async () => {
    // Manually plant an active session.
    const sessionDir = join(tmpRoot, ".viberevert", "sessions", PRE_EXISTING_SESSION_ID);
    await mkdir(join(sessionDir, "checkpoint"), { recursive: true });
    const sessionState: SessionState = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: PRE_EXISTING_SESSION_ID,
      checkpoint_id: PRE_EXISTING_CHECKPOINT_ID,
      started_at: PRE_EXISTING_STARTED_AT,
      before_status_path: `.viberevert/sessions/${PRE_EXISTING_SESSION_ID}/before-status.txt`,
      commands_log_path: `.viberevert/sessions/${PRE_EXISTING_SESSION_ID}/commands.log`,
    };
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState));
    await writeFile(join(sessionDir, "before-status.txt"), "");
    await writeFile(join(sessionDir, "commands.log"), "");
    const activeLock: ActiveSessionLock = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: PRE_EXISTING_SESSION_ID,
      checkpoint_id: PRE_EXISTING_CHECKPOINT_ID,
      started_at: PRE_EXISTING_STARTED_AT,
    };
    await writeFile(
      join(tmpRoot, ".viberevert", "active-session.json"),
      JSON.stringify(activeLock),
    );

    try {
      await startSessionOperation({ cwd: tmpRoot });
      expect.fail("expected SessionAlreadyActiveError");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionAlreadyActiveError);
      // Critical for D11 refusal copy: the error carries the active
      // lock so the Command (and the MCP handler) can render the
      // pre-existing session's id/started_at/etc.
      expect((err as SessionAlreadyActiveError).active.session_id).toBe(PRE_EXISTING_SESSION_ID);
      expect((err as SessionAlreadyActiveError).active.checkpoint_id).toBe(
        PRE_EXISTING_CHECKPOINT_ID,
      );
      expect((err as SessionAlreadyActiveError).active.started_at).toBe(PRE_EXISTING_STARTED_AT);
    }
  });
});

describe("startSessionOperation — D22 lock metadata (mocked locks boundary)", () => {
  // Mock only the lock boundary so the operation still runs its real
  // domain flow while the test can observe the D22 lock metadata
  // without a timing race.

  /**
   * Helper that vi-mocks `../../src/locks.js`, dynamically re-imports
   * the operation so it sees the mock, runs it once with the supplied
   * opts, and returns the captured LockInfo. Guarantees mock cleanup
   * via try/finally so a failed assertion can't poison sibling tests.
   */
  async function captureLockInfoOnce(
    opts: Parameters<typeof startSessionOperation>[0],
  ): Promise<LockInfo> {
    vi.resetModules();
    const capturedLockInfos: LockInfo[] = [];
    vi.doMock("../../src/locks.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/locks.js")>();
      return {
        ...actual,
        withExclusiveLock: async <T>(
          _lockDir: string,
          lockInfo: LockInfo,
          protectedFlow: () => Promise<T>,
        ): Promise<T> => {
          capturedLockInfos.push(lockInfo);
          return protectedFlow();
        },
      };
    });
    try {
      const { startSessionOperation: startSessionOperationWithMockedLock } = await import(
        "../../src/operations/start-session.js"
      );
      await startSessionOperationWithMockedLock(opts);
      expect(capturedLockInfos).toHaveLength(1);
      return capturedLockInfos[0] as LockInfo;
    } finally {
      vi.doUnmock("../../src/locks.js");
      vi.resetModules();
    }
  }

  it("uses the default CLI literal when neither lockCommand nor task is supplied", async () => {
    const info = await captureLockInfoOnce({ cwd: tmpRoot });
    expect(info.command).toBe("viberevert start");
  });

  it("uses the JSON-stringified --task literal when task is supplied without lockCommand", async () => {
    const info = await captureLockInfoOnce({ cwd: tmpRoot, task: "fix auth flow" });
    expect(info.command).toBe('viberevert start --task "fix auth flow"');
  });

  it("uses the lockCommand override when supplied (MCP path), ignoring task entirely for label purposes", async () => {
    const info = await captureLockInfoOnce({
      cwd: tmpRoot,
      task: "fix auth flow",
      lockCommand: "viberevert mcp start_session",
    });
    expect(info.command).toBe("viberevert mcp start_session");
  });
});
