// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for server.ts dispatcher.
//
// Test focus:
//   - Boot lifecycle (success + 2 failure paths: resolveRepoRoot
//     throw, openAuditLog throw)
//   - Cat 1 known-tool success: wire shape (content+text+structured),
//     audit ok:true, exit_code:0, arguments=undefined normalized to
//     {}, arguments={...} passed through
//   - Cat 1 known-tool failure (handler ok:false): wire shape with
//     isError:true + structuredContent, audit ok:false + error_code,
//     INVALID_TOOL_INPUT envelopes flow as Cat 1 per slice 3.6
//   - Cat 2 unknown/reserved: generic message (R31 -- no name echo),
//     audit reserved:true with reason for the two locked reserved
//     names, audit reserved:false with "<unknown>" sentinel for
//     truly-unknown names (R31 -- no client bytes in audit). Every
//     Cat 2 test asserts NO handler ran (D99.D dispatcher-owned).
//   - D99.V conditional timeout: class A hangs -> MCP_TOOL_TIMEOUT
//     after 30s (fake timers), class B hangs -> runs to completion
//   - Defensive handler throw -> wrapped via toErrorEnvelope ->
//     INTERNAL_ERROR
//   - Audit failure paths with DEFERRED signalUnhealthy (per
//     setTimeout(0) helper): Cat 1 returns MCP_AUDIT_WRITE_FAILED
//     envelope; Cat 2 throws McpError(InternalError); closed
//     rejects after the response is returned AND audit.close is
//     called via the closed.finally cleanup chain
//   - D99.W stderr_truncated normalization: handler returns ok:true
//     with data.stderr_truncated=true -> wire shape becomes
//     MCP_COMMAND_OUTPUT_TOO_LARGE; audit records both the
//     stderr_truncated:true diagnostic AND the canonical error_code
//   - Audit field detection: blocked:true is recorded when present;
//     absent when false/missing
//   - Concurrent dispatch: N parallel dispatches produce N audit
//     records, each with the right tool_name
//   - Lifecycle: shutdown() resolves closed; closed Promise has its
//     noop catch handler (no unhandled-rejection from forced-failure
//     tests)
//
// Mock strategy: vi.hoisted to declare mock surfaces before vi.mock
// factories; vi.mock on three modules:
//   - "../src/tool-registry.js" -- 2-tool test registry (1 class A
//     using "get_policy" as the canonical name so the locked map's
//     "A" type-check passes, 1 class B using "check_repo" for the
//     "B" type-check)
//   - "../src/audit.js" -- openAuditLog returns a mock AuditWriter
//     with controllable record/close vi.fn implementations and an
//     in-memory `records` array for inspection
//   - "@viberevert/core" -- resolveRepoRoot stubbed to a fixed
//     absolute path so tests don't need a real .viberevert/ tree on
//     disk

import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditRecordInput } from "../src/audit.js";
import type { ToolEnvelope } from "../src/envelope.js";

// ============================================================================
// Hoisted mock surfaces
// ============================================================================

const { mockHandlerA, mockHandlerB, mockAuditWriter, mockResolveRepoRoot } = vi.hoisted(() => {
  return {
    mockHandlerA: vi.fn(),
    mockHandlerB: vi.fn(),
    mockAuditWriter: {
      records: [] as AuditRecordInput[],
      recordImpl: vi.fn(),
      closeImpl: vi.fn(),
    },
    mockResolveRepoRoot: vi.fn(),
  };
});

// ============================================================================
// vi.mock setups
// ============================================================================

vi.mock("../src/tool-registry.js", () => ({
  TOOL_REGISTRATIONS_IN_ORDER: [
    {
      name: "get_policy",
      definition: {
        name: "get_policy",
        description: "class-A test substrate",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      handler: mockHandlerA,
      sideEffectClass: "A",
    },
    {
      name: "check_repo",
      definition: {
        name: "check_repo",
        description: "class-B test substrate",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      handler: mockHandlerB,
      sideEffectClass: "B",
    },
  ],
}));

vi.mock("../src/audit.js", async () => {
  const actual = await vi.importActual<typeof import("../src/audit.js")>("../src/audit.js");
  return {
    ...actual,
    openAuditLog: vi.fn(async () => ({
      record: mockAuditWriter.recordImpl,
      close: mockAuditWriter.closeImpl,
    })),
  };
});

vi.mock("@viberevert/core", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/core")>("@viberevert/core");
  return {
    ...actual,
    resolveRepoRoot: mockResolveRepoRoot,
  };
});

// ============================================================================
// Dynamic imports after mock setup
// ============================================================================

const { createServerForTests } = await import("../src/server.js");
const { McpBootError } = await import("../src/errors.js");
const auditModule = await import("../src/audit.js");
const mockedOpenAuditLog = vi.mocked(auditModule.openAuditLog);

// ============================================================================
// Test-local constants
// ============================================================================

const ABS_REPO_ROOT = "/abs/repo";

/**
 * Mirrors CLASS_A_TIMEOUT_MS in server.ts. Module-private per the
 * D99.G analog locked in slice 3.7; redeclared here so this test
 * can pin the boundary value without exporting the implementation
 * constant. Drift catch: source change without test update fails
 * the timeout test loudly.
 */
const CLASS_A_TIMEOUT_MS = 30_000;

// ============================================================================
// beforeEach: reset every mock and the in-memory audit record array
// ============================================================================

beforeEach(() => {
  mockHandlerA.mockReset();
  mockHandlerB.mockReset();

  mockAuditWriter.records.length = 0;
  mockAuditWriter.recordImpl.mockReset();
  mockAuditWriter.recordImpl.mockImplementation(async (entry: AuditRecordInput) => {
    mockAuditWriter.records.push(entry);
  });
  mockAuditWriter.closeImpl.mockReset();
  mockAuditWriter.closeImpl.mockResolvedValue(undefined);

  mockResolveRepoRoot.mockReset();
  mockResolveRepoRoot.mockReturnValue(ABS_REPO_ROOT);

  mockedOpenAuditLog.mockClear();
  // Reset the per-instance openAuditLog default so each test sees
  // the default mock writer unless it overrides explicitly via
  // mockResolvedValueOnce / mockRejectedValueOnce.
  mockedOpenAuditLog.mockImplementation(async () => ({
    record: mockAuditWriter.recordImpl,
    close: mockAuditWriter.closeImpl,
  }));
});

// ============================================================================
// Local helpers
// ============================================================================

/**
 * Build a server harness for a single test. Caller is responsible
 * for awaiting server.shutdown() in a cleanup block or using a
 * test-local try/finally; we don't add an afterEach because each
 * test names its lifecycle explicitly (some tests want to NOT
 * shutdown, e.g., to assert that `closed` rejects without manual
 * intervention).
 */
async function bootServer(): Promise<Awaited<ReturnType<typeof createServerForTests>>> {
  return createServerForTests({ cwd: "/some/cwd" });
}

// ============================================================================
// A. Boot lifecycle
// ============================================================================

describe("server: A. Boot lifecycle", () => {
  it("createServerForTests resolves and exposes dispatch/shutdown/closed", async () => {
    const server = await bootServer();
    expect(typeof server.dispatch).toBe("function");
    expect(typeof server.shutdown).toBe("function");
    expect(server.closed).toBeInstanceOf(Promise);
    await server.shutdown();
  });

  it("resolveRepoRoot throw -> McpBootError wrapping the cause", async () => {
    const cause = new Error("repo root resolution failed");
    mockResolveRepoRoot.mockImplementationOnce(() => {
      throw cause;
    });
    await expect(createServerForTests({ cwd: "/bad/cwd" })).rejects.toThrow(McpBootError);
  });

  it("openAuditLog throw -> McpBootError wrapping the cause", async () => {
    const cause = new Error("audit log open failed");
    mockedOpenAuditLog.mockRejectedValueOnce(cause);
    await expect(createServerForTests({ cwd: "/some/cwd" })).rejects.toThrow(McpBootError);
  });
});

// ============================================================================
// B. Cat 1 known-tool success
// ============================================================================

describe("server: B. Cat 1 known-tool success", () => {
  it("returns Cat 1 wire shape with content text + structuredContent (no isError)", async () => {
    const envelope: ToolEnvelope<{ ok: true; value: number }> = {
      ok: true,
      data: { ok: true, value: 42 },
    };
    mockHandlerA.mockResolvedValueOnce(envelope);

    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: "get_policy", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(envelope) }]);
      expect(result.structuredContent).toEqual(envelope);
      expect(result).not.toHaveProperty("isError");
    } finally {
      await server.shutdown();
    }
  });

  it("audit record is event:tool_call ok:true exit_code:0 with tool_name + duration_ms", async () => {
    mockHandlerA.mockResolvedValueOnce({ ok: true, data: {} });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "get_policy", arguments: {} });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records).toHaveLength(1);
    const rec = mockAuditWriter.records[0];
    expect(rec).toMatchObject({
      event: "tool_call",
      tool_name: "get_policy",
      ok: true,
      exit_code: 0,
    });
    expect(typeof (rec as { duration_ms: number }).duration_ms).toBe("number");
    expect((rec as { duration_ms: number }).duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("arguments=undefined is normalized to {} when passed to the handler", async () => {
    mockHandlerA.mockResolvedValueOnce({ ok: true, data: {} });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "get_policy" });
    } finally {
      await server.shutdown();
    }

    expect(mockHandlerA).toHaveBeenCalledTimes(1);
    expect(mockHandlerA).toHaveBeenCalledWith({}, { repoRoot: ABS_REPO_ROOT });
  });

  it("arguments={...} is passed to the handler unchanged", async () => {
    mockHandlerA.mockResolvedValueOnce({ ok: true, data: {} });
    const args = { foo: "bar", n: 7 };

    const server = await bootServer();
    try {
      await server.dispatch({ name: "get_policy", arguments: args });
    } finally {
      await server.shutdown();
    }

    expect(mockHandlerA).toHaveBeenCalledWith(args, { repoRoot: ABS_REPO_ROOT });
  });

  it("repoRoot from resolveRepoRoot is forwarded to the handler context", async () => {
    mockResolveRepoRoot.mockReturnValueOnce("/custom/abs/repo");
    mockHandlerA.mockResolvedValueOnce({ ok: true, data: {} });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "get_policy", arguments: {} });
    } finally {
      await server.shutdown();
    }

    expect(mockHandlerA).toHaveBeenCalledWith({}, { repoRoot: "/custom/abs/repo" });
  });
});

// ============================================================================
// C. Cat 1 known-tool failure (handler ok:false)
// ============================================================================

describe("server: C. Cat 1 known-tool failure", () => {
  it("handler ok:false -> wire shape includes isError:true + structuredContent", async () => {
    const envelope: ToolEnvelope<never> = {
      ok: false,
      error: { code: "SOME_DOMAIN_ERROR", message: "domain failure" },
    };
    mockHandlerA.mockResolvedValueOnce(envelope);

    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: "get_policy", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(envelope);
      expect(result.content[0]?.text).toBe(JSON.stringify(envelope));
    } finally {
      await server.shutdown();
    }
  });

  it("audit record is event:tool_call ok:false exit_code:1 with error_code", async () => {
    mockHandlerA.mockResolvedValueOnce({
      ok: false,
      error: { code: "SOME_DOMAIN_ERROR", message: "domain failure" },
    });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "get_policy", arguments: {} });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).toMatchObject({
      event: "tool_call",
      tool_name: "get_policy",
      ok: false,
      exit_code: 1,
      error_code: "SOME_DOMAIN_ERROR",
    });
  });

  it("INVALID_TOOL_INPUT envelope flows as Cat 1 with structuredContent (slice 3.6 contract)", async () => {
    // The dispatcher does NOT do safeParse -- handlers return their
    // own INVALID_TOOL_INPUT envelopes via toInvalidToolInputEnvelope.
    // The dispatcher treats the envelope as a regular Cat 1 ok:false
    // response; structuredContent carries the InvalidToolInputDetails.
    const envelope: ToolEnvelope<never> = {
      ok: false,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "get_policy input failed validation",
        details: { issue_count: 1, truncated: false, issues: [] },
      },
    };
    mockHandlerA.mockResolvedValueOnce(envelope);

    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: "get_policy", arguments: { bad: "input" } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(envelope);
      // Audit records the canonical error_code, not a denied-shape.
      expect(mockAuditWriter.records[0]).toMatchObject({
        event: "tool_call",
        ok: false,
        error_code: "INVALID_TOOL_INPUT",
      });
    } finally {
      await server.shutdown();
    }
  });

  it("MCP_TOOL_TIMEOUT envelope -> exit_code: null in audit (handler abandoned)", async () => {
    mockHandlerA.mockResolvedValueOnce({
      ok: false,
      error: { code: "MCP_TOOL_TIMEOUT", message: "Tool get_policy exceeded 30000ms timeout" },
    });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "get_policy", arguments: {} });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).toMatchObject({
      event: "tool_call",
      ok: false,
      exit_code: null,
      error_code: "MCP_TOOL_TIMEOUT",
    });
  });
});

// ============================================================================
// D. Cat 2 unknown / reserved tool name
// ============================================================================

describe("server: D. Cat 2 unknown / reserved", () => {
  it("reserved name 'rollback' -> generic Cat 2 text + audit reserved:true with reason; NO handler invoked", async () => {
    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: "rollback" });
      // R31: text is generic; no name echo.
      expect(result.content[0]?.text).toBe("MCP error -32602: Tool not found");
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("structuredContent");
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).toMatchObject({
      event: "tool_call_denied",
      tool_name: "rollback",
      ok: false,
      error_code: "TOOL_NOT_FOUND",
      reserved: true,
      exposed: false,
      reason: "reserved_approval_gated_not_exposed",
    });
    // D99.D lock: denied names MUST NOT invoke any handler.
    expect(mockHandlerA).not.toHaveBeenCalled();
    expect(mockHandlerB).not.toHaveBeenCalled();
  });

  it("reserved name 'request_human_approval' -> generic text + audit reserved:true with reason; NO handler invoked", async () => {
    const server = await bootServer();
    try {
      await server.dispatch({ name: "request_human_approval" });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).toMatchObject({
      event: "tool_call_denied",
      tool_name: "request_human_approval",
      ok: false,
      error_code: "TOOL_NOT_FOUND",
      reserved: true,
      exposed: false,
      reason: "reserved_approval_gated_not_exposed",
    });
    // D99.D lock: denied names MUST NOT invoke any handler.
    expect(mockHandlerA).not.toHaveBeenCalled();
    expect(mockHandlerB).not.toHaveBeenCalled();
  });

  it("truly-unknown name -> generic text + audit reserved:false + tool_name '<unknown>'; NO handler invoked", async () => {
    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: "made_up_tool_name" });
      expect(result.content[0]?.text).toBe("MCP error -32602: Tool not found");
      expect(result.isError).toBe(true);
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).toMatchObject({
      event: "tool_call_denied",
      tool_name: "<unknown>",
      ok: false,
      error_code: "TOOL_NOT_FOUND",
      reserved: false,
      exposed: false,
    });
    expect(mockAuditWriter.records[0]).not.toHaveProperty("reason");
    // D99.D lock: denied names MUST NOT invoke any handler.
    expect(mockHandlerA).not.toHaveBeenCalled();
    expect(mockHandlerB).not.toHaveBeenCalled();
  });

  it("R31: credential-shaped unknown name does NOT appear in wire text OR audit; NO handler invoked", async () => {
    // Constructed credential-shaped fixture per
    // [[feedback_constructed_secret_fixtures]] -- template-literal
    // interpolation defeats source-byte scanner detection.
    const rawUnknown = `sk${"_live_"}UNKNOWN_TOOL_FIXTURE`;

    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: rawUnknown });
      expect(result.content[0]?.text).toBe("MCP error -32602: Tool not found");
      expect(result.content[0]?.text).not.toContain(rawUnknown);
    } finally {
      await server.shutdown();
    }

    // Audit's tool_name is the "<unknown>" sentinel; the raw client
    // bytes never reach the audit log.
    expect(mockAuditWriter.records[0]).toMatchObject({
      tool_name: "<unknown>",
      reserved: false,
    });
    const auditText = JSON.stringify(mockAuditWriter.records[0]);
    expect(auditText).not.toContain(rawUnknown);
    // D99.D lock: denied names MUST NOT invoke any handler.
    expect(mockHandlerA).not.toHaveBeenCalled();
    expect(mockHandlerB).not.toHaveBeenCalled();
  });
});

// ============================================================================
// E. D99.V conditional timeout
// ============================================================================

describe("server: E. D99.V conditional timeout", () => {
  it("class A handler that never resolves -> MCP_TOOL_TIMEOUT after CLASS_A_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      // Never-resolving handler.
      mockHandlerA.mockReturnValue(new Promise(() => {}));

      const server = await bootServer();
      try {
        const dispatchPromise = server.dispatch({ name: "get_policy" });
        // Advance past the locked class-A timeout.
        await vi.advanceTimersByTimeAsync(CLASS_A_TIMEOUT_MS + 1);
        const result = await dispatchPromise;

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          ok: false,
          error: { code: "MCP_TOOL_TIMEOUT" },
        });
      } finally {
        await server.shutdown();
      }

      expect(mockAuditWriter.records[0]).toMatchObject({
        event: "tool_call",
        ok: false,
        exit_code: null,
        error_code: "MCP_TOOL_TIMEOUT",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("class B handler runs to completion even past 30s wall-clock (NOT wrapped per R17)", async () => {
    vi.useFakeTimers();
    try {
      // Resolves only after we advance past 60s -- class B has no
      // timeout, so the dispatch completes normally.
      let resolveB!: (v: ToolEnvelope<unknown>) => void;
      mockHandlerB.mockReturnValueOnce(
        new Promise<ToolEnvelope<unknown>>((res) => {
          resolveB = res;
        }),
      );

      const server = await bootServer();
      try {
        const dispatchPromise = server.dispatch({ name: "check_repo" });

        // Advance time past the CLASS_A_TIMEOUT_MS boundary. If class
        // B were wrapped, the dispatch would now have rejected with
        // MCP_TOOL_TIMEOUT. Instead it stays pending because class B
        // is unwrapped.
        await vi.advanceTimersByTimeAsync(CLASS_A_TIMEOUT_MS * 2);

        // Resolve the handler late; dispatch should complete with
        // the handler's envelope.
        resolveB({ ok: true, data: { done: true } });
        const result = await dispatchPromise;

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({ ok: true, data: { done: true } });
      } finally {
        await server.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// F. Defensive handler throw
// ============================================================================

describe("server: F. Defensive handler throw", () => {
  it("handler throws unknown Error -> wrapped via toErrorEnvelope -> INTERNAL_ERROR", async () => {
    mockHandlerA.mockRejectedValueOnce(new Error("disk on fire"));

    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: "get_policy", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR" },
      });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).toMatchObject({
      event: "tool_call",
      ok: false,
      exit_code: 1,
      error_code: "INTERNAL_ERROR",
    });
  });
});

// ============================================================================
// G. Audit failure paths with deferred signalUnhealthy
// ============================================================================

describe("server: G. Audit failure paths", () => {
  it("Cat 1 audit failure -> MCP_AUDIT_WRITE_FAILED envelope; closed rejects + audit.close called via finally", async () => {
    mockHandlerA.mockResolvedValueOnce({ ok: true, data: {} });
    mockAuditWriter.recordImpl.mockRejectedValueOnce(new Error("audit append failed"));

    const server = await bootServer();
    // Dispatch RETURNS the MCP_AUDIT_WRITE_FAILED envelope normally
    // (the signalUnhealthy is deferred via setTimeout(0) so the
    // response handoff wins the race).
    const result = await server.dispatch({ name: "get_policy", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "MCP_AUDIT_WRITE_FAILED" },
    });

    // After the response, the deferred signalUnhealthy fires on the
    // next macrotask. closed rejects with McpBootError wrapping the
    // audit cause.
    await expect(server.closed).rejects.toThrow(McpBootError);
    // Audit cleanup ran via the closed.finally chain even on the
    // unhealthy path. Without this, the audit FH would leak.
    expect(mockAuditWriter.closeImpl).toHaveBeenCalledTimes(1);
  });

  it("Cat 2 audit failure -> dispatch throws McpError(InternalError); closed rejects + audit.close called via finally", async () => {
    mockAuditWriter.recordImpl.mockRejectedValueOnce(new Error("audit append failed"));

    const server = await bootServer();
    // For an unknown name, dispatch throws McpError. The SDK would
    // serialize it to a JSON-RPC error envelope (-32603) in
    // production; in the test the throw propagates directly.
    await expect(server.dispatch({ name: "rollback" })).rejects.toThrow(McpError);

    // closed rejects via the deferred signal.
    await expect(server.closed).rejects.toThrow(McpBootError);
    // Audit cleanup ran via the closed.finally chain on the
    // unhealthy path triggered by the denied-tool audit failure.
    expect(mockAuditWriter.closeImpl).toHaveBeenCalledTimes(1);
  });

  it("Cat 2 audit failure: thrown McpError carries the raw reason (no SDK auto-prepend in throw); audit.close still runs", async () => {
    // Per R30: we throw with JUST the raw reason because the SDK
    // auto-prepends "MCP error -32603: " when serializing the
    // McpError. Test the raw .message exactly.
    mockAuditWriter.recordImpl.mockRejectedValueOnce(new Error("audit failed"));

    const server = await bootServer();
    let thrown: unknown;
    try {
      await server.dispatch({ name: "rollback" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as Error).message).toContain(
      "audit append failed during denied-tool-name probe",
    );
    expect((thrown as Error).message).not.toContain("MCP error -32603: MCP error");

    await expect(server.closed).rejects.toThrow(McpBootError);
    // Audit cleanup ran via the closed.finally chain.
    expect(mockAuditWriter.closeImpl).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// H. D99.W stderr_truncated normalization
// ============================================================================

describe("server: H. D99.W stderr_truncated normalization", () => {
  it("handler ok:true with data.stderr_truncated=true -> wire becomes MCP_COMMAND_OUTPUT_TOO_LARGE", async () => {
    mockHandlerA.mockResolvedValueOnce({
      ok: true,
      data: { result: "partial", stderr_truncated: true },
    });

    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: "get_policy", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "MCP_COMMAND_OUTPUT_TOO_LARGE" },
      });
    } finally {
      await server.shutdown();
    }
  });

  it("audit record carries BOTH stderr_truncated:true AND error_code:MCP_COMMAND_OUTPUT_TOO_LARGE", async () => {
    mockHandlerA.mockResolvedValueOnce({
      ok: true,
      data: { stderr_truncated: true },
    });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "get_policy", arguments: {} });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).toMatchObject({
      event: "tool_call",
      ok: false,
      error_code: "MCP_COMMAND_OUTPUT_TOO_LARGE",
      stderr_truncated: true,
    });
  });

  it("handler ok:true WITHOUT stderr_truncated flag -> pass-through (no normalization)", async () => {
    const envelope = { ok: true as const, data: { result: "full" } };
    mockHandlerA.mockResolvedValueOnce(envelope);

    const server = await bootServer();
    try {
      const result = await server.dispatch({ name: "get_policy", arguments: {} });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(envelope);
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).not.toHaveProperty("stderr_truncated");
    expect(mockAuditWriter.records[0]).toMatchObject({ ok: true, exit_code: 0 });
  });
});

// ============================================================================
// I. Audit field detection (blocked)
// ============================================================================

describe("server: I. Audit field detection -- blocked", () => {
  it("handler ok:true with data.blocked=true -> audit records blocked:true", async () => {
    mockHandlerB.mockResolvedValueOnce({
      ok: true,
      data: { report: {}, exit_code: 2, blocked: true },
    });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "check_repo", arguments: {} });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).toMatchObject({
      event: "tool_call",
      ok: true,
      exit_code: 0,
      blocked: true,
    });
  });

  it("handler ok:true with data.blocked=false -> audit does NOT include blocked field", async () => {
    mockHandlerB.mockResolvedValueOnce({
      ok: true,
      data: { report: {}, exit_code: 0, blocked: false },
    });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "check_repo", arguments: {} });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).not.toHaveProperty("blocked");
  });

  it("handler ok:false (e.g. INTERNAL_ERROR) -> audit does NOT include blocked field", async () => {
    // blocked is detected on the raw envelope; if rawEnvelope.ok is
    // false (handler errored OR threw), hasBooleanDataField returns
    // false regardless of any data shape.
    mockHandlerB.mockResolvedValueOnce({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "x" },
    });

    const server = await bootServer();
    try {
      await server.dispatch({ name: "check_repo", arguments: {} });
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records[0]).not.toHaveProperty("blocked");
  });
});

// ============================================================================
// J. Concurrent dispatch
// ============================================================================

describe("server: J. Concurrent dispatch", () => {
  it("N parallel dispatches produce N audit records each with the right tool_name", async () => {
    // Default success envelope for every call.
    mockHandlerA.mockResolvedValue({ ok: true, data: {} });
    mockHandlerB.mockResolvedValue({ ok: true, data: {} });

    const server = await bootServer();
    try {
      const dispatches = Array.from({ length: 10 }, (_, i) =>
        server.dispatch({
          name: i % 2 === 0 ? "get_policy" : "check_repo",
          arguments: { i },
        }),
      );
      const results = await Promise.all(dispatches);
      expect(results).toHaveLength(10);
      for (const r of results) {
        expect(r.isError).toBeUndefined();
      }
    } finally {
      await server.shutdown();
    }

    expect(mockAuditWriter.records).toHaveLength(10);
    // Each record has the tool_name matching its dispatch slot;
    // order is not strictly asserted because audit.record() is
    // mocked as immediate-push (real audit uses a per-instance
    // Promise chain for serialization).
    const getPolicyCount = mockAuditWriter.records.filter(
      (r) => "tool_name" in r && r.tool_name === "get_policy",
    ).length;
    const checkRepoCount = mockAuditWriter.records.filter(
      (r) => "tool_name" in r && r.tool_name === "check_repo",
    ).length;
    expect(getPolicyCount).toBe(5);
    expect(checkRepoCount).toBe(5);
  });
});

// ============================================================================
// K. Lifecycle: shutdown + closed semantics
// ============================================================================

describe("server: K. Lifecycle", () => {
  it("shutdown() resolves; closed resolves cleanly on graceful path", async () => {
    const server = await bootServer();
    await server.shutdown();
    await expect(server.closed).resolves.toBeUndefined();
    expect(mockAuditWriter.closeImpl).toHaveBeenCalledTimes(1);
  });

  it("shutdown() is safe to call after closed has already settled (idempotent path)", async () => {
    const server = await bootServer();
    await server.shutdown();
    // Second shutdown should not throw (shutdown controller's
    // signalGraceful is idempotent; audit.close is also idempotent
    // per audit.ts contract; awaiting `closed` after it has resolved
    // is a no-op).
    await expect(server.shutdown()).resolves.toBeUndefined();
  });

  it("closed has a noop catch handler so a forced-unhealthy test that drops `closed` doesn't trip unhandled-rejection", async () => {
    // Force an audit failure on the only dispatch; intentionally do
    // NOT await server.closed afterward. If the noop catch handler
    // were missing, Node would emit an unhandled-rejection event
    // when the test completes. With the handler in place, the test
    // settles cleanly and `closed` is still observable as rejected
    // when we DO await it.
    mockAuditWriter.recordImpl.mockRejectedValueOnce(new Error("audit failed"));

    const server = await bootServer();
    await server.dispatch({ name: "rollback" }).catch(() => {
      /* Cat 2 audit failure path throws McpError -- caught here */
    });

    // Confirm closed eventually rejects (proving the noop handler
    // didn't swallow the rejection, only prevented unhandled-
    // rejection noise).
    await expect(server.closed).rejects.toThrow(McpBootError);
  });
});
