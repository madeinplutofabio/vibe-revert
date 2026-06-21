// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for tools/create-checkpoint.ts.
//
// Test focus:
//   - input validation (empty input, name, empty/whitespace name,
//     non-string name, extras, name trimming after parse)
//   - length cap (boundary at MAX_NAME_LEN; cap+1 rejected)
//   - control-char ban (NUL specifically -- the regression that
//     /\S/ alone would accept; plus other 0x00-0x1F and 0x7F bytes)
//   - success projection (camelCase -> snake_case)
//   - operation invocation shape (cwd, lockCommand, conditional name)
//   - single-invocation guarantee on every operation-called path
//     (class-B tool: double-call regression would create 2 checkpoints)
//   - typed-error paths covering MCP_ERROR_CODE_MAP coverage
//   - details serializer whitelist correctness for lock / issues +
//     snapshot-identity (not the same reference as source)
//   - ConcurrentOperationError info=null branch (info_available:false)
//   - CheckpointNameCollisionError carries a GENERIC message + NO
//     details (regression-catch for re-introducing user-input echo
//     via either error.message or error.details -- the upstream
//     Error template interpolates the raw name, so the handler
//     special-cases the error to emit a generic message that
//     contains NO user-supplied bytes; constructed credential-
//     shaped fixture exercises the R31 path end-to-end)
//   - CreateCheckpointListLoadError carries NO details
//   - INTERNAL_ERROR fallback for unknown errors
//   - definition smoke (name, no cwd-like inputs, only `name`
//     property, JSON-schema maxLength + pattern presence-tolerant,
//     wire-contract additionalProperties:false)
//
// Mock strategy: stub @viberevert/cli-commands's
// createCheckpointOperation at the boundary; preserve the real
// CheckpointNameCollisionError + ConcurrentOperationError +
// CreateCheckpointListLoadError + RuntimeEnvInvalidError + every
// other barrel re-export. Real Config*Error / RepoRootNotFoundError
// from @viberevert/core imported normally (D99.M.6 already allows
// these classes via envelope.ts).

import {
  CheckpointNameCollisionError,
  ConcurrentOperationError,
  CreateCheckpointListLoadError,
  RuntimeEnvInvalidError,
} from "@viberevert/cli-commands";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  RepoRootNotFoundError,
} from "@viberevert/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@viberevert/cli-commands", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/cli-commands")>(
    "@viberevert/cli-commands",
  );
  return {
    ...actual,
    createCheckpointOperation: vi.fn(),
  };
});

const { handler, definition } = await import("../src/tools/create-checkpoint.js");
const cliCommands = await import("@viberevert/cli-commands");
const mockedCreateCheckpoint = vi.mocked(cliCommands.createCheckpointOperation);

const ABS_REPO_ROOT = "/abs/repo";

const DEFAULT_RESULT = {
  checkpointId: "cp_01ABCDEFGHJKMNPQRSTVWXYZ12",
  createdAt: "2026-06-14T18:00:00Z",
};

/**
 * Mirrors MAX_CREATE_CHECKPOINT_NAME_LEN in create-checkpoint.ts.
 * Module-private per D99.G; redeclared here so this test can pin
 * boundary values without exporting the implementation constant. If
 * the source cap changes, this test will fail at the boundary test
 * and surface the drift loudly (better than silently passing on a
 * weaker cap).
 */
const MAX_NAME_LEN = 128;

beforeEach(() => {
  mockedCreateCheckpoint.mockReset();
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
 * (centralized helper used by every MCP tool handler).
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

describe("create_checkpoint handler: input validation", () => {
  it("empty input passes; operation called exactly once with only cwd + lockCommand (no name)", async () => {
    mockedCreateCheckpoint.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockedCreateCheckpoint).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      lockCommand: "viberevert mcp create_checkpoint",
    });
    const opts = mockedCreateCheckpoint.mock.calls[0]?.[0];
    expect(opts).not.toHaveProperty("name");
  });

  it("non-empty name passes; operation called exactly once with cwd + name + lockCommand", async () => {
    mockedCreateCheckpoint.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler({ name: "before refactor" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockedCreateCheckpoint).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      name: "before refactor",
      lockCommand: "viberevert mcp create_checkpoint",
    });
  });

  it("empty-string name rejected with INVALID_TOOL_INPUT; operation not called", async () => {
    const env = await handler({ name: "" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("whitespace-only name rejected with INVALID_TOOL_INPUT; operation not called", async () => {
    const env = await handler({ name: "   " }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("tab/newline-only name rejected with INVALID_TOOL_INPUT", async () => {
    const env = await handler({ name: "\t\n " }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects non-string name with INVALID_TOOL_INPUT; operation not called", async () => {
    for (const name of [123, null, true]) {
      mockedCreateCheckpoint.mockClear();
      const env = await handler({ name }, { repoRoot: ABS_REPO_ROOT });
      expectInvalidToolInput(env);
      expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
    }
  });

  it("rejects extra key (cwd) with INVALID_TOOL_INPUT; operation not called", async () => {
    const env = await handler({ cwd: "/other/repo" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects extra key (message) -- operation does not accept message; schema enforces strict object", async () => {
    const env = await handler({ message: "some message" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("name is trimmed before operation call", async () => {
    mockedCreateCheckpoint.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler({ name: "  before refactor  " }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockedCreateCheckpoint).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      name: "before refactor",
      lockCommand: "viberevert mcp create_checkpoint",
    });
  });

  it("name exactly MAX_NAME_LEN characters passes; operation called once", async () => {
    mockedCreateCheckpoint.mockResolvedValueOnce(DEFAULT_RESULT);
    const exactlyMax = "x".repeat(MAX_NAME_LEN);
    const env = await handler({ name: exactlyMax }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockedCreateCheckpoint).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      name: exactlyMax,
      lockCommand: "viberevert mcp create_checkpoint",
    });
  });

  it("name MAX_NAME_LEN+1 characters rejected with INVALID_TOOL_INPUT; operation not called", async () => {
    const overMax = "x".repeat(MAX_NAME_LEN + 1);
    const env = await handler({ name: overMax }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("name with NUL byte rejected (regression: /\\S/ alone would accept NUL)", async () => {
    const env = await handler({ name: "\x00" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("name with embedded NUL byte rejected (NUL-injection mid-string)", async () => {
    const env = await handler({ name: "valid-name\x00injected" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("name with various ASCII control chars rejected", async () => {
    for (const controlChar of ["\x07", "\x1B", "\x7F", "\x1F"]) {
      mockedCreateCheckpoint.mockClear();
      const env = await handler(
        { name: `prefix${controlChar}suffix` },
        { repoRoot: ABS_REPO_ROOT },
      );
      expectInvalidToolInput(env);
      expect(mockedCreateCheckpoint).not.toHaveBeenCalled();
    }
  });
});

// ============================================================================
// B. Success projection
// ============================================================================

describe("create_checkpoint handler: success projection", () => {
  it("projects operation result camelCase to MCP snake_case shape; operation called exactly once", async () => {
    mockedCreateCheckpoint.mockResolvedValueOnce({
      checkpointId: "cp_PROJTESTABCDEFGHJKMNPQRS",
      createdAt: "2026-06-14T18:30:00Z",
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
    if (env.ok === true) {
      expect(env.data).toEqual({
        checkpoint_id: "cp_PROJTESTABCDEFGHJKMNPQRS",
        created_at: "2026-06-14T18:30:00Z",
      });
    }
  });
});

// ============================================================================
// C. Typed-error mapping + details serializers
// ============================================================================

describe("create_checkpoint handler: typed-error mapping", () => {
  it("RepoRootNotFoundError -> REPO_ROOT_NOT_FOUND; operation called once", async () => {
    mockedCreateCheckpoint.mockRejectedValueOnce(new RepoRootNotFoundError(ABS_REPO_ROOT));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("REPO_ROOT_NOT_FOUND");
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("ConfigNotFoundError -> CONFIG_NOT_FOUND; operation called once", async () => {
    mockedCreateCheckpoint.mockRejectedValueOnce(
      new ConfigNotFoundError("/abs/repo/.viberevert.yml"),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("CONFIG_NOT_FOUND");
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("ConfigParseError -> CONFIG_PARSE_FAILED; operation called once", async () => {
    mockedCreateCheckpoint.mockRejectedValueOnce(
      new ConfigParseError("/abs/repo/.viberevert.yml", new Error("bad YAML")),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("CONFIG_PARSE_FAILED");
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("ConfigValidationError -> CONFIG_VALIDATION_FAILED with details.issues populated; operation called once", async () => {
    const realSchema = z.strictObject({ version: z.literal(1), foo: z.string() });
    const safeParseResult = realSchema.safeParse({ version: 1 });
    expect(safeParseResult.success).toBe(false);
    if (safeParseResult.success === false) {
      mockedCreateCheckpoint.mockRejectedValueOnce(
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
      expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
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
      mockedCreateCheckpoint.mockRejectedValueOnce(validationErr);
      const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
      expect(env.ok).toBe(false);
      if (env.ok === false) {
        const detailsIssues = (env.error.details as { issues: unknown }).issues;
        expect(detailsIssues).not.toBe(validationErr.issues);
        expect(detailsIssues).toEqual(validationErr.issues);
      }
      expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
    }
  });

  it("RuntimeEnvInvalidError -> RUNTIME_ENV_INVALID; operation called once", async () => {
    mockedCreateCheckpoint.mockRejectedValueOnce(
      new RuntimeEnvInvalidError("VIBEREVERT_TEST_FIXED_NOW", "bad-value", "invalid format"),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("RUNTIME_ENV_INVALID");
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("ConcurrentOperationError (with info) -> CONCURRENT_OPERATION with details.lock (whitelist serializer); operation called once", async () => {
    const lockDir = "/abs/repo/.viberevert/.locks/checkpoint-name.lock";
    const lockInfo = {
      pid: 12345,
      command: "viberevert checkpoint --name 'something'",
      started_at: "2026-06-14T17:55:00Z",
      host: "test-host",
    };
    mockedCreateCheckpoint.mockRejectedValueOnce(new ConcurrentOperationError(lockDir, lockInfo));
    const env = await handler({ name: "test-name" }, { repoRoot: ABS_REPO_ROOT });
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
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("CONCURRENT_OPERATION details.lock is a different object reference than err.info", async () => {
    const lockDir = "/abs/repo/.viberevert/.locks/checkpoint-name.lock";
    const lockInfo = {
      pid: 12345,
      command: "viberevert checkpoint",
      started_at: "2026-06-14T17:55:00Z",
      host: "test-host",
    };
    const err = new ConcurrentOperationError(lockDir, lockInfo);
    mockedCreateCheckpoint.mockRejectedValueOnce(err);
    const env = await handler({ name: "test-name" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      const detailsLock = (env.error.details as { lock: unknown }).lock;
      expect(detailsLock).not.toBe(err.info);
      expect(detailsLock).not.toBe(lockInfo);
    }
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("ConcurrentOperationError (info=null) -> details.lock with info_available:false (no pid/command/host)", async () => {
    const lockDir = "/abs/repo/.viberevert/.locks/checkpoint-name.lock";
    mockedCreateCheckpoint.mockRejectedValueOnce(new ConcurrentOperationError(lockDir, null));
    const env = await handler({ name: "test-name" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("CONCURRENT_OPERATION");
      const details = env.error.details as { lock: Record<string, unknown> };
      expect(details.lock).toEqual({
        lock_dir: lockDir,
        info_available: false,
      });
      expect(details.lock).not.toHaveProperty("pid");
      expect(details.lock).not.toHaveProperty("command");
      expect(details.lock).not.toHaveProperty("host");
    }
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("CheckpointNameCollisionError -> CHECKPOINT_NAME_COLLISION with generic message and NO details", async () => {
    // Locks the slice-3.7 user-directed R31 contract: the upstream
    // Error template interpolates the raw user-supplied name
    // (`checkpoint name already exists: ${name}`); the handler
    // special-cases this error to emit a generic message that
    // contains NO user-supplied bytes. The stable code carries the
    // semantic refusal; clients render their own "choose a different
    // name" copy. Constructed credential-shaped fixture per
    // [[feedback_constructed_secret_fixtures]] exercises the R31
    // path end-to-end: template-literal interpolation defeats
    // scanner detection of the source bytes while still producing
    // a credential-shaped runtime string the assertion below
    // verifies is NOT echoed in the wire response.
    const collidingName = `sk${"_live_"}CHECKPOINT_NAME_FIXTURE`;

    mockedCreateCheckpoint.mockRejectedValueOnce(
      new CheckpointNameCollisionError({ checkpointName: collidingName }),
    );

    const env = await handler({ name: collidingName }, { repoRoot: ABS_REPO_ROOT });

    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("CHECKPOINT_NAME_COLLISION");
      expect(env.error.message).toBe("checkpoint name already exists");
      // CRITICAL R31 regression-catch: the credential-shaped name
      // MUST NOT appear anywhere in error.message. Without the
      // handler's special-case, toErrorEnvelope -> sanitizeMessage
      // would pass through the credential-shaped checkpoint name
      // unchanged (sanitizeMessage strips control chars + caps length
      // only -- it does NOT redact arbitrary embedded substrings).
      expect(env.error.message).not.toContain(collidingName);
      // Details remains undefined: the special-case constructs the
      // envelope directly without passing through augmentEnvelope,
      // and re-surfacing the user-supplied name in details would
      // re-introduce the same leak via a different field.
      expect(env.error.details).toBeUndefined();
    }

    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("CreateCheckpointListLoadError -> CHECKPOINT_LIST_LOAD_FAILED with NO details", async () => {
    // Wrapped internal cause; sanitized error.message is enough
    // for diagnosis. Safe to pass through toErrorEnvelope unchanged
    // because the upstream Error template is formatCause(internal
    // fs/scan error), NOT raw user input.
    mockedCreateCheckpoint.mockRejectedValueOnce(
      new CreateCheckpointListLoadError({
        repoRoot: ABS_REPO_ROOT,
        cause: new Error("corrupt manifest"),
      }),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("CHECKPOINT_LIST_LOAD_FAILED");
      expect(env.error.details).toBeUndefined();
    }
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("unknown error from operation -> INTERNAL_ERROR fallback; operation called once", async () => {
    mockedCreateCheckpoint.mockRejectedValueOnce(new Error("disk on fire"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INTERNAL_ERROR");
    expect(mockedCreateCheckpoint).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// D. Definition smoke
// ============================================================================

describe("create_checkpoint definition export", () => {
  it("name is 'create_checkpoint'", () => {
    expect(definition.name).toBe("create_checkpoint");
  });

  it("inputSchema has no cwd-like keys (D99.M.17)", () => {
    const props = (definition.inputSchema.properties ?? {}) as { name?: unknown };
    const forbidden = ["cwd", "target_repo", "repo", "directory", "repo_path", "working_directory"];
    for (const k of Object.keys(props)) expect(forbidden).not.toContain(k);
  });

  it("inputSchema's only property is 'name' (no `message` -- operation does not accept it)", () => {
    const props = (definition.inputSchema.properties ?? {}) as { name?: unknown };
    expect(Object.keys(props)).toEqual(["name"]);
  });

  it("inputSchema exposes name as a string with maxLength === MAX_NAME_LEN", () => {
    const props = (definition.inputSchema.properties ?? {}) as { name?: unknown };
    const name = props.name as { type?: unknown; maxLength?: unknown };
    expect(name.type).toBe("string");
    expect(name.maxLength).toBe(MAX_NAME_LEN);
  });

  it("inputSchema's `name` carries a pattern constraint somewhere in its schema", () => {
    const props = (definition.inputSchema.properties ?? {}) as { name?: unknown };
    const name = props.name as Record<string, unknown>;
    expect(JSON.stringify(name)).toContain('"pattern"');
  });

  it("inputSchema rejects additional properties at the JSON-schema layer", () => {
    expect(definition.inputSchema.additionalProperties).toBe(false);
  });
});
