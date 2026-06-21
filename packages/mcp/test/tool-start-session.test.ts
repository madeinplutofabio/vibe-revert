// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for tools/start-session.ts.
//
// Test focus:
//   - input validation (empty input, task, empty/whitespace task,
//     non-string task, extras, task trimming after parse)
//   - success projection (camelCase -> snake_case)
//   - operation invocation shape (cwd, lockCommand, conditional task)
//   - single-invocation guarantee on every operation-called path
//     (class-B tool: double-call regression would create 2 sessions)
//   - 7 typed-error paths covering MCP_ERROR_CODE_MAP coverage
//   - details serializer whitelist correctness for active / lock /
//     issues + snapshot-identity (not the same reference as source)
//   - ConcurrentOperationError info=null branch (info_available:false)
//   - INTERNAL_ERROR fallback for unknown errors
//   - definition smoke (name, no cwd-like inputs, only `task`
//     property, JSON-schema task pattern, wire-contract
//     additionalProperties:false)
//
// Mock strategy: stub @viberevert/cli-commands's
// startSessionOperation at the boundary; preserve the real
// ConcurrentOperationError + RuntimeEnvInvalidError + every other
// barrel re-export. Real Config*Error / SessionAlreadyActiveError /
// RepoRootNotFoundError from @viberevert/core imported normally
// (D99.M.6 already allows these classes via envelope.ts).

import { ConcurrentOperationError, RuntimeEnvInvalidError } from "@viberevert/cli-commands";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  RepoRootNotFoundError,
  SessionAlreadyActiveError,
} from "@viberevert/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@viberevert/cli-commands", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/cli-commands")>(
    "@viberevert/cli-commands",
  );
  return {
    ...actual,
    startSessionOperation: vi.fn(),
  };
});

const { handler, definition } = await import("../src/tools/start-session.js");
const cliCommands = await import("@viberevert/cli-commands");
const mockedStartSession = vi.mocked(cliCommands.startSessionOperation);

const ABS_REPO_ROOT = "/abs/repo";

const DEFAULT_RESULT = {
  sessionId: "sess_01ABCDEFGHJKMNPQRSTVWXYZ12",
  checkpointId: "cp_01ABCDEFGHJKMNPQRSTVWXYZ34",
  startedAt: "2026-06-14T18:00:00Z",
};

beforeEach(() => {
  mockedStartSession.mockReset();
});

/**
 * Shared INVALID_TOOL_INPUT envelope assertion. Locks the M G1a
 * Step 3.6 normalized contract:
 *   - error.code === "INVALID_TOOL_INPUT"
 *   - error.details is the InvalidToolInputDetails shape:
 *       - issue_count: positive number (original ZodError issue count)
 *       - truncated: boolean
 *       - issues: non-empty array of MCP-owned issue records
 *
 * The shape comes from envelope.ts's toInvalidToolInputEnvelope
 * (centralized helper used by every MCP tool handler). The number-
 * shape `details.issues: number` that earlier slices used was
 * normalized away in slice 3.6.
 */
function expectInvalidToolInput(env: Awaited<ReturnType<typeof handler>>): void {
  expect(env.ok).toBe(false);
  if (env.ok === false) {
    expect(env.error.code).toBe("INVALID_TOOL_INPUT");
    expect(env.error.details).toEqual(
      expect.objectContaining({
        issue_count: expect.any(Number),
        truncated: expect.any(Boolean),
        issues: expect.any(Array),
      }),
    );

    const details = env.error.details as {
      issue_count: number;
      truncated: boolean;
      issues: unknown[];
    };
    expect(details.issue_count).toBeGreaterThan(0);
    expect(details.issues.length).toBeGreaterThan(0);
  }
}

// ============================================================================
// A. Input validation
// ============================================================================

describe("start_session handler: input validation", () => {
  it("empty input passes; operation called exactly once with only cwd + lockCommand (no task)", async () => {
    mockedStartSession.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
    expect(mockedStartSession).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      lockCommand: "viberevert mcp start_session",
    });
    // Extra lock: confirm the operation arg has NO `task` property at
    // all (not `task: undefined`). vitest's .toHaveBeenCalledWith
    // ignores undefined properties, so this separate hasOwnProperty
    // check is what actually locks the "omit task entirely when
    // absent" decision in the handler.
    const opts = mockedStartSession.mock.calls[0]?.[0];
    expect(opts).not.toHaveProperty("task");
  });

  it("non-empty task passes; operation called exactly once with cwd + task + lockCommand", async () => {
    mockedStartSession.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler({ task: "fix auth bug" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
    expect(mockedStartSession).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      task: "fix auth bug",
      lockCommand: "viberevert mcp start_session",
    });
  });

  it("empty-string task rejected with INVALID_TOOL_INPUT; operation not called", async () => {
    const env = await handler({ task: "" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("whitespace-only task rejected with INVALID_TOOL_INPUT; operation not called", async () => {
    const env = await handler({ task: "   " }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("tab/newline-only task rejected with INVALID_TOOL_INPUT", async () => {
    const env = await handler({ task: "\t\n " }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("rejects non-string task with INVALID_TOOL_INPUT; operation not called", async () => {
    // Locks against a future regression to z.coerce.string() or other
    // permissive input handling. number / null / boolean must all be
    // rejected at the schema layer.
    for (const task of [123, null, true]) {
      mockedStartSession.mockClear();
      const env = await handler({ task }, { repoRoot: ABS_REPO_ROOT });
      expectInvalidToolInput(env);
      expect(mockedStartSession).not.toHaveBeenCalled();
    }
  });

  it("rejects extra key (cwd) with INVALID_TOOL_INPUT; operation not called", async () => {
    const env = await handler({ cwd: "/other/repo" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("task is trimmed before operation call", async () => {
    mockedStartSession.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler({ task: "  fix auth bug  " }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
    expect(mockedStartSession).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      task: "fix auth bug",
      lockCommand: "viberevert mcp start_session",
    });
  });
});

// ============================================================================
// B. Success projection
// ============================================================================

describe("start_session handler: success projection", () => {
  it("projects operation result camelCase to MCP snake_case shape; operation called exactly once", async () => {
    mockedStartSession.mockResolvedValueOnce({
      sessionId: "sess_PROJTESTABCDEFGHJKMNPQRS",
      checkpointId: "cp_PROJTESTABCDEFGHJKMNPQRS",
      startedAt: "2026-06-14T18:30:00Z",
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
    if (env.ok === true) {
      expect(env.data).toEqual({
        session_id: "sess_PROJTESTABCDEFGHJKMNPQRS",
        checkpoint_id: "cp_PROJTESTABCDEFGHJKMNPQRS",
        started_at: "2026-06-14T18:30:00Z",
      });
    }
  });
});

// ============================================================================
// C. Typed-error mapping + details serializers
// ============================================================================

describe("start_session handler: typed-error mapping", () => {
  it("RepoRootNotFoundError -> REPO_ROOT_NOT_FOUND; operation called once", async () => {
    mockedStartSession.mockRejectedValueOnce(new RepoRootNotFoundError(ABS_REPO_ROOT));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("REPO_ROOT_NOT_FOUND");
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("ConfigNotFoundError -> CONFIG_NOT_FOUND; operation called once", async () => {
    mockedStartSession.mockRejectedValueOnce(new ConfigNotFoundError("/abs/repo/.viberevert.yml"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("CONFIG_NOT_FOUND");
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("ConfigParseError -> CONFIG_PARSE_FAILED; operation called once", async () => {
    mockedStartSession.mockRejectedValueOnce(
      new ConfigParseError("/abs/repo/.viberevert.yml", new Error("bad YAML")),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("CONFIG_PARSE_FAILED");
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("ConfigValidationError -> CONFIG_VALIDATION_FAILED with details.issues populated; operation called once", async () => {
    const realSchema = z.strictObject({ version: z.literal(1), foo: z.string() });
    const safeParseResult = realSchema.safeParse({ version: 1 });
    expect(safeParseResult.success).toBe(false);
    if (safeParseResult.success === false) {
      mockedStartSession.mockRejectedValueOnce(
        new ConfigValidationError("/abs/repo/.viberevert.yml", safeParseResult.error),
      );
      const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
      expect(env.ok).toBe(false);
      if (env.ok === false) {
        expect(env.error.code).toBe("CONFIG_VALIDATION_FAILED");
        const details = env.error.details as { issues?: unknown };
        expect(Array.isArray(details.issues)).toBe(true);
        expect((details.issues as unknown[]).length).toBeGreaterThan(0);
      }
      expect(mockedStartSession).toHaveBeenCalledTimes(1);
    }
  });

  it("CONFIG_VALIDATION_FAILED details.issues is a different array reference than err.issues", async () => {
    const realSchema = z.strictObject({ version: z.literal(1), foo: z.string() });
    const safeParseResult = realSchema.safeParse({ version: 1 });
    if (safeParseResult.success === false) {
      const validationErr = new ConfigValidationError(
        "/abs/repo/.viberevert.yml",
        safeParseResult.error,
      );
      mockedStartSession.mockRejectedValueOnce(validationErr);
      const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
      expect(env.ok).toBe(false);
      if (env.ok === false) {
        const detailsIssues = (env.error.details as { issues: unknown }).issues;
        expect(detailsIssues).not.toBe(validationErr.issues);
        expect(detailsIssues).toEqual(validationErr.issues);
      }
      expect(mockedStartSession).toHaveBeenCalledTimes(1);
    }
  });

  it("RuntimeEnvInvalidError -> RUNTIME_ENV_INVALID; operation called once", async () => {
    mockedStartSession.mockRejectedValueOnce(
      new RuntimeEnvInvalidError("VIBEREVERT_TEST_FIXED_NOW", "bad-value", "invalid format"),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("RUNTIME_ENV_INVALID");
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("SessionAlreadyActiveError -> SESSION_ALREADY_ACTIVE with details.active (whitelist serializer); operation called once", async () => {
    const activeLock = {
      schema_version: "1.0" as const,
      session_id: "sess_ACTIVETESTABCDEFGHJKMNPQ",
      checkpoint_id: "cp_ACTIVETESTABCDEFGHJKMNPQ",
      started_at: "2026-06-14T10:00:00Z",
      task: "previously started work",
    };
    mockedStartSession.mockRejectedValueOnce(new SessionAlreadyActiveError(activeLock));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("SESSION_ALREADY_ACTIVE");
      const details = env.error.details as { active: Record<string, unknown> };
      expect(details.active).toEqual({
        session_id: activeLock.session_id,
        checkpoint_id: activeLock.checkpoint_id,
        started_at: activeLock.started_at,
        task: activeLock.task,
      });
      // Whitelist: schema_version NOT surfaced (plumbing field excluded)
      expect(details.active).not.toHaveProperty("schema_version");
    }
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("SESSION_ALREADY_ACTIVE details.active is a different object reference than err.active", async () => {
    const activeLock = {
      schema_version: "1.0" as const,
      session_id: "sess_ACTIVETESTABCDEFGHJKMNPQ",
      checkpoint_id: "cp_ACTIVETESTABCDEFGHJKMNPQ",
      started_at: "2026-06-14T10:00:00Z",
      task: "previously started work",
    };
    const err = new SessionAlreadyActiveError(activeLock);
    mockedStartSession.mockRejectedValueOnce(err);
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      const detailsActive = (env.error.details as { active: unknown }).active;
      expect(detailsActive).not.toBe(err.active);
      expect(detailsActive).not.toBe(activeLock);
    }
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("SESSION_ALREADY_ACTIVE details.active omits optional task when undefined", async () => {
    const activeLock = {
      schema_version: "1.0" as const,
      session_id: "sess_ACTIVETESTABCDEFGHJKMNPQ",
      checkpoint_id: "cp_ACTIVETESTABCDEFGHJKMNPQ",
      started_at: "2026-06-14T10:00:00Z",
      // task: undefined (omitted)
    };
    mockedStartSession.mockRejectedValueOnce(new SessionAlreadyActiveError(activeLock));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      const details = env.error.details as { active: Record<string, unknown> };
      expect(details.active).not.toHaveProperty("task");
      expect(details.active).toEqual({
        session_id: activeLock.session_id,
        checkpoint_id: activeLock.checkpoint_id,
        started_at: activeLock.started_at,
      });
    }
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("ConcurrentOperationError (with info) -> CONCURRENT_OPERATION with details.lock (whitelist serializer); operation called once", async () => {
    const lockDir = "/abs/repo/.viberevert/.locks/start.lock";
    const lockInfo = {
      pid: 12345,
      command: "viberevert start --task 'something'",
      started_at: "2026-06-14T17:55:00Z",
      host: "test-host",
    };
    mockedStartSession.mockRejectedValueOnce(new ConcurrentOperationError(lockDir, lockInfo));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("CONCURRENT_OPERATION");
      const details = env.error.details as { lock: Record<string, unknown> };
      expect(details.lock).toEqual({
        lock_dir: lockDir,
        info_available: true,
        pid: lockInfo.pid,
        command: lockInfo.command,
        started_at: lockInfo.started_at,
        host: lockInfo.host,
      });
    }
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("CONCURRENT_OPERATION details.lock is a different object reference than err.info", async () => {
    const lockDir = "/abs/repo/.viberevert/.locks/start.lock";
    const lockInfo = {
      pid: 12345,
      command: "viberevert start",
      started_at: "2026-06-14T17:55:00Z",
      host: "test-host",
    };
    const err = new ConcurrentOperationError(lockDir, lockInfo);
    mockedStartSession.mockRejectedValueOnce(err);
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      const detailsLock = (env.error.details as { lock: unknown }).lock;
      expect(detailsLock).not.toBe(err.info);
      expect(detailsLock).not.toBe(lockInfo);
    }
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("ConcurrentOperationError (info=null) -> details.lock with info_available:false (no pid/command/host)", async () => {
    const lockDir = "/abs/repo/.viberevert/.locks/start.lock";
    mockedStartSession.mockRejectedValueOnce(new ConcurrentOperationError(lockDir, null));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("CONCURRENT_OPERATION");
      const details = env.error.details as { lock: Record<string, unknown> };
      expect(details.lock).toEqual({
        lock_dir: lockDir,
        info_available: false,
      });
      // Defensive: lock-info fields NOT surfaced when info is null
      expect(details.lock).not.toHaveProperty("pid");
      expect(details.lock).not.toHaveProperty("command");
      expect(details.lock).not.toHaveProperty("host");
    }
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });

  it("unknown error from operation -> INTERNAL_ERROR fallback; operation called once", async () => {
    mockedStartSession.mockRejectedValueOnce(new Error("disk on fire"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INTERNAL_ERROR");
    expect(mockedStartSession).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// D. Definition smoke
// ============================================================================

describe("start_session definition export", () => {
  it("name is 'start_session'", () => {
    expect(definition.name).toBe("start_session");
  });

  it("inputSchema has no cwd-like keys (D99.M.17)", () => {
    const props = (definition.inputSchema.properties ?? {}) as { task?: unknown };
    const forbidden = ["cwd", "target_repo", "repo", "directory", "repo_path", "working_directory"];
    for (const k of Object.keys(props)) expect(forbidden).not.toContain(k);
  });

  it("inputSchema's only property is 'task'", () => {
    const props = (definition.inputSchema.properties ?? {}) as { task?: unknown };
    expect(Object.keys(props)).toEqual(["task"]);
  });

  it("inputSchema exposes task as a string with non-whitespace pattern", () => {
    // Locks the "JSON-schema-representable validation, runtime trim
    // after parse" decision. If a future refactor switches to
    // .transform((s) => s.trim()).refine(...) in the schema, the
    // pattern property would be missing here and this test catches
    // it before MCP consumers see the regression.
    const props = (definition.inputSchema.properties ?? {}) as { task?: unknown };
    const task = props.task as { type?: unknown; pattern?: unknown };
    expect(task.type).toBe("string");
    expect(task.pattern).toBe("\\S");
  });

  it("inputSchema rejects additional properties at the JSON-schema layer", () => {
    expect(definition.inputSchema.additionalProperties).toBe(false);
  });
});
