// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for audit.ts.
//
// Test strategy:
//
//   - HAPPY paths use REAL filesystem via os.tmpdir() + mkdtemp. Each
//     test creates an isolated temp dir + cleans up in afterEach. The
//     audit log file is read back as raw bytes to assert NDJSON shape +
//     locked field order.
//
//   - FAILURE injection uses vi.mock("node:fs/promises") with PASSTHROUGH
//     defaults. The mock wraps mkdir/open as vi.fn() so individual tests
//     can override with .mockRejectedValueOnce(...) to simulate
//     ENOENT/EACCES/EPERM. For appendFile/close failures, the test
//     overrides open to return a CUSTOM FAKE FileHandle whose appendFile/
//     close behave per the test's needs.
//
//   - Timestamp determinism: tests pass `now: () => fixedDate` to
//     openAuditLog so the ISO ts in serialized records is exactly known
//     for byte-level field-order assertions.
//
// Groups:
//
//   A. openAuditLog input validation (RangeError; no fs calls)
//   B. openAuditLog filesystem (happy + mkdir/open failures + exact path)
//   C. record() serialization (locked field order + schema_version + ts)
//   D. record() input safety (override prevention, sanitization,
//      numeric guards, timestamp-failure handling)
//   E. record() append chain (deterministic concurrent ordering,
//      poisoning after failure proves appendFile not called twice)
//   F. close() idempotency (success + failure paths) + failure
//      preservation (cause + secondaryCause + nested cause chain)
//   G. record() after close() (rejection + no-side-effect)

import { type FileHandle, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AuditRecordInput, type AuditWriter, openAuditLog } from "../src/audit.js";
import { McpAuditWriteError } from "../src/errors.js";

// ============================================================================
// fs/promises mock with passthrough (failure-injection seam)
// ============================================================================

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    open: vi.fn(actual.open),
  };
});

// ============================================================================
// Per-test fixtures
// ============================================================================

let tmpRoot: string;

const FIXED_DATE = new Date("2026-06-12T00:00:00.000Z");
const FIXED_TS = FIXED_DATE.toISOString();

function fixedNow(): Date {
  return FIXED_DATE;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-mcp-audit-"));
  vi.mocked(mkdir).mockClear();
  vi.mocked(open).mockClear();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(mkdir).mockImplementation(realFs.mkdir);
  vi.mocked(open).mockImplementation(realFs.open);
});

async function readAuditLog(): Promise<string> {
  return readFile(join(tmpRoot, ".viberevert", "mcp-audit.log"), "utf8");
}

function validRecord(overrides: Partial<AuditRecordInput> = {}): AuditRecordInput {
  return {
    event: "tool_call",
    tool_name: "check_repo",
    ok: true,
    exit_code: 0,
    duration_ms: 42,
    ...overrides,
  } as AuditRecordInput;
}

function makeFakeFH(opts: {
  appendFile?: () => Promise<void>;
  close?: () => Promise<void>;
}): FileHandle {
  const fakeFh = {
    appendFile: opts.appendFile ?? (() => Promise.resolve()),
    close: opts.close ?? (() => Promise.resolve()),
  };
  return fakeFh as unknown as FileHandle;
}

// ============================================================================
// A. openAuditLog input validation
// ============================================================================

describe("openAuditLog: input validation", () => {
  it("rejects with RangeError when repoRoot is not absolute", async () => {
    await expect(openAuditLog({ repoRoot: "relative/path" })).rejects.toThrow(RangeError);
  });

  it("does NOT call mkdir or open when repoRoot is not absolute", async () => {
    try {
      await openAuditLog({ repoRoot: "relative/path" });
    } catch {
      // Expected RangeError.
    }
    expect(vi.mocked(mkdir)).not.toHaveBeenCalled();
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });

  it("RangeError is NOT wrapped as McpAuditWriteError (programmer error stays raw)", async () => {
    await expect(openAuditLog({ repoRoot: "relative/path" })).rejects.not.toBeInstanceOf(
      McpAuditWriteError,
    );
  });
});

// ============================================================================
// B. openAuditLog filesystem
// ============================================================================

describe("openAuditLog: filesystem -- happy path", () => {
  it("creates .viberevert/ with the EXACT repo-root-anchored path (mkdir-recursive)", async () => {
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    await writer.close();
    expect(vi.mocked(mkdir)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(
      join(tmpRoot, ".viberevert"),
      expect.objectContaining({ recursive: true }),
    );
  });

  it("succeeds when .viberevert/ already exists (mkdir-recursive idempotent)", async () => {
    await mkdir(join(tmpRoot, ".viberevert"), { recursive: true });
    vi.mocked(mkdir).mockClear();
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    await writer.close();
    expect(vi.mocked(mkdir)).toHaveBeenCalledTimes(1);
  });

  it("opens the audit log at the EXACT repo-root-anchored path in append mode", async () => {
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    await writer.close();
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(open)).toHaveBeenCalledWith(
      join(tmpRoot, ".viberevert", "mcp-audit.log"),
      "a",
    );
  });
});

describe("openAuditLog: filesystem -- failure paths", () => {
  it("wraps mkdir failure as McpAuditWriteError (not raw EACCES)", async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
    );
    await expect(openAuditLog({ repoRoot: tmpRoot, now: fixedNow })).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
  });

  it("wraps open failure as McpAuditWriteError (not raw ENOENT)", async () => {
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
    );
    await expect(openAuditLog({ repoRoot: tmpRoot, now: fixedNow })).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
  });

  it("McpAuditWriteError on open failure carries the original error as cause", async () => {
    const cause = Object.assign(new Error("EACCES"), { code: "EACCES" });
    vi.mocked(open).mockRejectedValueOnce(cause);
    let caught: unknown;
    try {
      await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpAuditWriteError);
    if (caught instanceof McpAuditWriteError) {
      expect(caught.cause).toBe(cause);
    }
  });
});

// ============================================================================
// C. record() serialization (locked field order + schema_version + ts)
// ============================================================================

describe("AuditWriter.record: serialization", () => {
  let writer: AuditWriter;

  beforeEach(async () => {
    writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
  });

  afterEach(async () => {
    await writer.close();
  });

  it('emits a line starting with {"schema_version":1,"event":"tool_call","ts":"<fixedTs>"...', async () => {
    await writer.record(validRecord());
    const content = await readAuditLog();
    const expectedPrefix = `{"schema_version":1,"event":"tool_call","ts":"${FIXED_TS}"`;
    expect(content.startsWith(expectedPrefix)).toBe(true);
  });

  it("terminates each line with a single '\\n'", async () => {
    await writer.record(validRecord());
    const content = await readAuditLog();
    expect(content.endsWith("\n")).toBe(true);
    expect(content.split("\n").filter((s) => s.length > 0).length).toBe(1);
  });

  it("serializes ToolCallRecord with ok:true in full locked order", async () => {
    await writer.record({
      event: "tool_call",
      tool_name: "check_repo",
      ok: true,
      exit_code: 0,
      blocked: true,
      duration_ms: 142,
    } as AuditRecordInput);
    const line = (await readAuditLog()).trim();
    expect(line).toBe(
      `{"schema_version":1,"event":"tool_call","ts":"${FIXED_TS}","tool_name":"check_repo","ok":true,"exit_code":0,"blocked":true,"duration_ms":142}`,
    );
  });

  it("serializes ToolCallRecord with ok:false + error_code in full locked order", async () => {
    await writer.record({
      event: "tool_call",
      tool_name: "start_session",
      ok: false,
      exit_code: 1,
      error_code: "CONCURRENT_OPERATION",
      duration_ms: 7,
    } as AuditRecordInput);
    const line = (await readAuditLog()).trim();
    expect(line).toBe(
      `{"schema_version":1,"event":"tool_call","ts":"${FIXED_TS}","tool_name":"start_session","ok":false,"exit_code":1,"error_code":"CONCURRENT_OPERATION","duration_ms":7}`,
    );
  });

  it("serializes stderr_truncated after duration_ms in locked order", async () => {
    await writer.record({
      event: "tool_call",
      tool_name: "check_repo",
      ok: true,
      exit_code: 0,
      duration_ms: 142,
      stderr_truncated: true,
    } as AuditRecordInput);
    const line = (await readAuditLog()).trim();
    expect(line).toBe(
      `{"schema_version":1,"event":"tool_call","ts":"${FIXED_TS}","tool_name":"check_repo","ok":true,"exit_code":0,"duration_ms":142,"stderr_truncated":true}`,
    );
  });

  it("serializes null exit_code as the JSON literal null", async () => {
    await writer.record({
      event: "tool_call",
      tool_name: "check_repo",
      ok: false,
      exit_code: null,
      error_code: "MCP_TOOL_TIMEOUT",
      duration_ms: 30000,
    } as AuditRecordInput);
    const line = (await readAuditLog()).trim();
    expect(line).toContain(`"exit_code":null`);
  });

  it("does not serialize runtime-supplied error_code when ok:true (cast bypass safety)", async () => {
    // TypeScript blocks this; runtime casts can still send it. The
    // serializer branches on r.ok === false, so error_code must
    // NOT appear in the output line for ok:true records.
    await writer.record({
      ...validRecord(),
      error_code: "SHOULD_NOT_APPEAR",
    } as unknown as AuditRecordInput);
    const line = (await readAuditLog()).trim();
    expect(line).not.toContain("SHOULD_NOT_APPEAR");
    expect(line).not.toContain("error_code");
  });

  it("serializes ToolCallDeniedRecord (reserved) in full locked order", async () => {
    await writer.record({
      event: "tool_call_denied",
      tool_name: "rollback",
      ok: false,
      error_code: "TOOL_NOT_FOUND",
      reserved: true,
      exposed: false,
      reason: "reserved_approval_gated_not_exposed",
    });
    const line = (await readAuditLog()).trim();
    expect(line).toBe(
      `{"schema_version":1,"event":"tool_call_denied","ts":"${FIXED_TS}","tool_name":"rollback","ok":false,"error_code":"TOOL_NOT_FOUND","reserved":true,"exposed":false,"reason":"reserved_approval_gated_not_exposed"}`,
    );
  });

  it("serializes ToolCallDeniedRecord (unknown -- no reason field) in full locked order", async () => {
    await writer.record({
      event: "tool_call_denied",
      tool_name: "made_up_tool",
      ok: false,
      error_code: "TOOL_NOT_FOUND",
      reserved: false,
      exposed: false,
    });
    const line = (await readAuditLog()).trim();
    expect(line).toBe(
      `{"schema_version":1,"event":"tool_call_denied","ts":"${FIXED_TS}","tool_name":"made_up_tool","ok":false,"error_code":"TOOL_NOT_FOUND","reserved":false,"exposed":false}`,
    );
  });

  it("serializes ServerIntegrityFailureRecord in full locked order", async () => {
    await writer.record({
      event: "server_integrity_failure",
      reason: "audit_append_failed_during_denial",
    });
    const line = (await readAuditLog()).trim();
    expect(line).toBe(
      `{"schema_version":1,"event":"server_integrity_failure","ts":"${FIXED_TS}","reason":"audit_append_failed_during_denial"}`,
    );
  });
});

// ============================================================================
// D. record() input safety
// ============================================================================

describe("AuditWriter.record: writer-owned fields cannot be overridden", () => {
  let writer: AuditWriter;

  beforeEach(async () => {
    writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
  });

  afterEach(async () => {
    await writer.close();
  });

  it("ignores a runtime-supplied schema_version (writer always sets 1)", async () => {
    await writer.record({
      ...validRecord(),
      schema_version: 999,
    } as unknown as AuditRecordInput);
    const content = await readAuditLog();
    expect(content).toContain(`"schema_version":1`);
    expect(content).not.toContain(`"schema_version":999`);
  });

  it("ignores a runtime-supplied ts (writer always uses now())", async () => {
    await writer.record({
      ...validRecord(),
      ts: "1999-01-01T00:00:00.000Z",
    } as unknown as AuditRecordInput);
    const content = await readAuditLog();
    expect(content).toContain(`"ts":"${FIXED_TS}"`);
    expect(content).not.toContain("1999-01-01");
  });
});

describe("AuditWriter.record: tool_name sanitization (D99.J)", () => {
  let writer: AuditWriter;

  beforeEach(async () => {
    writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
  });

  afterEach(async () => {
    await writer.close();
  });

  it("replaces non-printable-ASCII chars with '?'", async () => {
    await writer.record(validRecord({ tool_name: "bad\x00name\x1Fhere" }));
    const content = await readAuditLog();
    expect(content).toContain(`"tool_name":"bad?name?here"`);
  });

  it("caps tool_name at 64 characters", async () => {
    const longName = "x".repeat(200);
    await writer.record(validRecord({ tool_name: longName }));
    const content = await readAuditLog();
    expect(content).toContain(`"tool_name":"${"x".repeat(64)}"`);
    expect(content).not.toContain("x".repeat(65));
  });

  it("defensively String-coerces non-string runtime tool_name", async () => {
    await writer.record(validRecord({ tool_name: 12345 as unknown as string }));
    const content = await readAuditLog();
    expect(content).toContain(`"tool_name":"12345"`);
  });
});

describe("AuditWriter.record: numeric guards", () => {
  let writer: AuditWriter;

  beforeEach(async () => {
    writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
  });

  afterEach(async () => {
    await writer.close();
  });

  it("rejects duration_ms = NaN", async () => {
    await expect(writer.record(validRecord({ duration_ms: Number.NaN }))).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
  });

  it("rejects duration_ms = Infinity", async () => {
    await expect(
      writer.record(validRecord({ duration_ms: Number.POSITIVE_INFINITY })),
    ).rejects.toBeInstanceOf(McpAuditWriteError);
  });

  it("rejects duration_ms = -1 (negative)", async () => {
    await expect(writer.record(validRecord({ duration_ms: -1 }))).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
  });

  it("rejects duration_ms = 1.5 (non-integer)", async () => {
    await expect(writer.record(validRecord({ duration_ms: 1.5 }))).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
  });

  it("rejects duration_ms above Number.MAX_SAFE_INTEGER (unsafe integer)", async () => {
    await expect(
      writer.record(validRecord({ duration_ms: Number.MAX_SAFE_INTEGER + 1 })),
    ).rejects.toBeInstanceOf(McpAuditWriteError);
  });

  it("rejects exit_code = NaN", async () => {
    await expect(writer.record(validRecord({ exit_code: Number.NaN }))).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
  });

  it("rejects exit_code = Infinity", async () => {
    await expect(
      writer.record(validRecord({ exit_code: Number.POSITIVE_INFINITY })),
    ).rejects.toBeInstanceOf(McpAuditWriteError);
  });

  it("rejects exit_code = -1 (negative)", async () => {
    await expect(writer.record(validRecord({ exit_code: -1 }))).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
  });

  it("rejects exit_code = 1.5 (non-integer)", async () => {
    await expect(writer.record(validRecord({ exit_code: 1.5 }))).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
  });

  it("rejects exit_code above Number.MAX_SAFE_INTEGER (unsafe integer)", async () => {
    await expect(
      writer.record(validRecord({ exit_code: Number.MAX_SAFE_INTEGER + 1 })),
    ).rejects.toBeInstanceOf(McpAuditWriteError);
  });

  it("serialization failure does NOT poison the chain (valid follow-up record succeeds)", async () => {
    await expect(writer.record(validRecord({ duration_ms: Number.NaN }))).rejects.toBeInstanceOf(
      McpAuditWriteError,
    );
    await expect(writer.record(validRecord())).resolves.toBeUndefined();
    const content = await readAuditLog();
    expect(content.split("\n").filter((s) => s.length > 0).length).toBe(1);
  });
});

describe("AuditWriter.record: timestamp-generation failure", () => {
  it("timestamp generation failure is wrapped and does NOT poison the chain", async () => {
    let calls = 0;
    const writer = await openAuditLog({
      repoRoot: tmpRoot,
      now: () => {
        calls += 1;
        // First call: invalid Date (.toISOString() will throw RangeError).
        // Second call: valid date.
        return calls === 1 ? new Date(Number.NaN) : FIXED_DATE;
      },
    });

    try {
      await expect(writer.record(validRecord())).rejects.toBeInstanceOf(McpAuditWriteError);
      await expect(writer.record(validRecord())).resolves.toBeUndefined();

      const lines = (await readAuditLog()).split("\n").filter((s) => s.length > 0);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(`"ts":"${FIXED_TS}"`);
    } finally {
      await writer.close();
    }
  });
});

// ============================================================================
// E. record() append chain
// ============================================================================

describe("AuditWriter.record: concurrent ordering", () => {
  it("serializes concurrent record() calls in deterministic call order", async () => {
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    await Promise.all([
      writer.record(validRecord({ tool_name: "first" })),
      writer.record(validRecord({ tool_name: "second" })),
      writer.record(validRecord({ tool_name: "third" })),
    ]);
    await writer.close();
    const lines = (await readAuditLog()).split("\n").filter((s) => s.length > 0);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain(`"tool_name":"first"`);
    expect(lines[1]).toContain(`"tool_name":"second"`);
    expect(lines[2]).toContain(`"tool_name":"third"`);
  });
});

describe("AuditWriter.record: chain poisoning after appendFile failure", () => {
  it("first appendFile failure rejects with branded McpAuditWriteError; second valid record rejects with the SAME object AND appendFile is never called again", async () => {
    const appendErr = Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" });
    const appendFile = vi.fn(async () => {
      throw appendErr;
    });

    vi.mocked(open).mockResolvedValueOnce(makeFakeFH({ appendFile }));

    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });

    const firstErr = await writer.record(validRecord()).catch((err: unknown) => err);
    expect(firstErr).toBeInstanceOf(McpAuditWriteError);
    if (firstErr instanceof McpAuditWriteError) {
      expect(firstErr.cause).toBe(appendErr);
    }

    // Second VALID record. If the chain were not poisoned, it would
    // attempt a fresh appendFile -- and the test would observe
    // appendFile having been called twice. The chain IS poisoned,
    // so the second record's await on this.tail rejects with the
    // SAME branded error object captured above, and appendFile is
    // never reached.
    await expect(writer.record(validRecord())).rejects.toBe(firstErr);
    expect(appendFile).toHaveBeenCalledTimes(1);

    await writer.close().catch(() => undefined);
  });
});

// ============================================================================
// F. close() idempotency + failure preservation
// ============================================================================

describe("AuditWriter.close: idempotency", () => {
  it("second close() returns the SAME Promise instance as the first (success path)", async () => {
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    const first = writer.close();
    const second = writer.close();
    expect(second).toBe(first);
    await first;
  });

  it("second close() returns the SAME REJECTED Promise after close failure", async () => {
    const closeErr = new Error("close fail");
    vi.mocked(open).mockResolvedValueOnce(
      makeFakeFH({
        appendFile: () => Promise.resolve(),
        close: () => Promise.reject(closeErr),
      }),
    );

    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    const first = writer.close();
    const second = writer.close();

    expect(second).toBe(first);
    await expect(first).rejects.toBeInstanceOf(McpAuditWriteError);
  });

  it("awaits in-flight record() before closing the FileHandle", async () => {
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    const recordPromise = writer.record(validRecord());
    const closePromise = writer.close();
    await Promise.all([recordPromise, closePromise]);
    const content = await readAuditLog();
    expect(content).toContain(`"tool_name":"check_repo"`);
  });
});

describe("AuditWriter.close: closes FileHandle even if tail rejected (object identity preserved)", () => {
  it("close() runs fh.close() AND throws the SAME branded tail error", async () => {
    let closeCalled = false;
    vi.mocked(open).mockResolvedValueOnce(
      makeFakeFH({
        appendFile: () => Promise.reject(new Error("tail fail")),
        close: () => {
          closeCalled = true;
          return Promise.resolve();
        },
      }),
    );
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });

    const recordErr = await writer.record(validRecord()).catch((err: unknown) => err);
    expect(recordErr).toBeInstanceOf(McpAuditWriteError);

    // close() must throw the SAME error object as record() rejected
    // with -- this locks the "preserve object identity" guarantee
    // documented in close()'s try/finally branch.
    await expect(writer.close()).rejects.toBe(recordErr);
    expect(closeCalled).toBe(true);
  });
});

describe("AuditWriter.close: failure preservation", () => {
  it("BOTH tail and close fail -> McpAuditWriteError with cause=branded-tail (whose cause=raw-tail) + secondaryCause=close", async () => {
    const tailErr = new Error("tail fail");
    const closeErr = new Error("close fail");
    vi.mocked(open).mockResolvedValueOnce(
      makeFakeFH({
        appendFile: () => Promise.reject(tailErr),
        close: () => Promise.reject(closeErr),
      }),
    );
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    const recordCatch = writer.record(validRecord()).catch(() => undefined);
    await recordCatch;
    let caught: unknown;
    try {
      await writer.close();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpAuditWriteError);
    if (caught instanceof McpAuditWriteError) {
      // record's .catch wrapped tailErr into a McpAuditWriteError.
      // close's "both failures" branch preserves that wrapper as
      // `cause` and adds closeErr as `secondaryCause`.
      expect(caught.cause).toBeInstanceOf(McpAuditWriteError);
      if (caught.cause instanceof McpAuditWriteError) {
        // The raw tailErr is reachable via the inner cause chain.
        expect(caught.cause.cause).toBe(tailErr);
      }
      expect(caught.secondaryCause).toBe(closeErr);
    }
  });

  it("tail OK + close fails -> McpAuditWriteError with cause=closeError", async () => {
    const closeErr = new Error("close fail");
    vi.mocked(open).mockResolvedValueOnce(
      makeFakeFH({
        appendFile: () => Promise.resolve(),
        close: () => Promise.reject(closeErr),
      }),
    );
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    await writer.record(validRecord());
    let caught: unknown;
    try {
      await writer.close();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpAuditWriteError);
    if (caught instanceof McpAuditWriteError) {
      expect(caught.cause).toBe(closeErr);
    }
  });
});

// ============================================================================
// G. record() after close()
// ============================================================================

describe("AuditWriter.record: rejection after close()", () => {
  it("record() after close() rejects with McpAuditWriteError", async () => {
    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    await writer.close();
    await expect(writer.record(validRecord())).rejects.toBeInstanceOf(McpAuditWriteError);
  });

  it("record() after close() does NOT call appendFile (no side effect)", async () => {
    const appendFile = vi.fn(async () => {});
    vi.mocked(open).mockResolvedValueOnce(makeFakeFH({ appendFile }));

    const writer = await openAuditLog({ repoRoot: tmpRoot, now: fixedNow });
    await writer.close();

    await expect(writer.record(validRecord())).rejects.toBeInstanceOf(McpAuditWriteError);
    expect(appendFile).not.toHaveBeenCalled();
  });
});
