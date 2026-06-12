// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for envelope.ts.
//
// Three logical groups:
//
//   A. Registry integrity
//      - MCP_ERROR_CODE_ENTRIES: exact count + unique values
//      - MCP_DIRECT_ERROR_CODES: exact list
//      - Disjointness between the two registries + INTERNAL_ERROR
//        excluded from both
//      - toolEnvelopeSchema accepts ok:true / ok:false shapes
//      - toolEnvelopeSchema is STRICT: extra top-level / inner-error
//        fields are rejected (prevents stack/secret leakage)
//
//   B. toErrorEnvelope 3-tier precedence
//      - Tier 1: McpDirectError -> mcpCode
//      - Tier 2: mapped domain error -> mapped code
//      - Tier 3 fallback for unknown Error, non-Error throw,
//        and string/null/undefined
//      - Stack is NEVER leaked
//      - Message sanitization: control-char strip, whitespace
//        collapse, 512-char cap
//
//   C. formatZodErrorSummary
//      - <root> path for empty path; numeric segments stringified
//      - Joined-issues format
//      - Quoted-value scrub (single + double quotes, including the
//        SECRET_SENTINEL_DO_NOT_LOG regression)
//      - Unquoted-value scrub (numbers, identifiers, etc.)
//      - Control-char normalization inside Zod messages
//      - Empty-issues fallback
//      - 256-char cap with truncation suffix

import { ConcurrentOperationError } from "@viberevert/cli-commands";
import { ConfigNotFoundError } from "@viberevert/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  formatZodErrorSummary,
  MCP_ERROR_CODE_ENTRIES,
  MCP_ERROR_CODE_MAP,
  toErrorEnvelope,
  toolEnvelopeSchema,
  toolEnvelopeSchemaOf,
} from "../src/envelope.js";
import {
  MCP_DIRECT_ERROR_CODES,
  McpAuditWriteError,
  McpBootError,
  McpToolInvocationError,
  McpToolTimeoutError,
} from "../src/errors.js";

// ============================================================================
// A. Registry integrity
// ============================================================================

describe("envelope: MCP_ERROR_CODE_MAP registry integrity", () => {
  it("MCP_ERROR_CODE_ENTRIES contains exactly 19 entries (14 cli-commands + 5 core)", () => {
    expect(MCP_ERROR_CODE_ENTRIES.length).toBe(19);
  });

  it("MCP_ERROR_CODE_ENTRIES values are unique (no duplicate code strings)", () => {
    const codes = MCP_ERROR_CODE_ENTRIES.map(([, code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("MCP_ERROR_CODE_MAP exposes every entry from MCP_ERROR_CODE_ENTRIES", () => {
    for (const [ctor, code] of MCP_ERROR_CODE_ENTRIES) {
      expect(MCP_ERROR_CODE_MAP.get(ctor)).toBe(code);
    }
    expect(MCP_ERROR_CODE_MAP.size).toBe(MCP_ERROR_CODE_ENTRIES.length);
  });
});

describe("envelope: MCP_DIRECT_ERROR_CODES registry integrity", () => {
  it("contains exactly the 4 locked direct codes in locked order", () => {
    expect([...MCP_DIRECT_ERROR_CODES]).toEqual([
      "MCP_TOOL_TIMEOUT",
      "MCP_AUDIT_WRITE_FAILED",
      "MCP_COMMAND_OUTPUT_TOO_LARGE",
      "INVALID_TOOL_INPUT",
    ]);
  });

  it("is frozen (Object.isFrozen returns true)", () => {
    expect(Object.isFrozen(MCP_DIRECT_ERROR_CODES)).toBe(true);
  });
});

describe("envelope: disjointness invariants", () => {
  it("MCP_ERROR_CODE_MAP values and MCP_DIRECT_ERROR_CODES are disjoint sets", () => {
    const mapCodes = new Set<string>(MCP_ERROR_CODE_ENTRIES.map(([, code]) => code));
    for (const directCode of MCP_DIRECT_ERROR_CODES) {
      expect(
        mapCodes.has(directCode),
        `${directCode} must NOT also appear in MCP_ERROR_CODE_MAP values`,
      ).toBe(false);
    }
  });

  it("INTERNAL_ERROR is in NEITHER registry (it is the fallback only)", () => {
    const mapCodes = new Set<string>(MCP_ERROR_CODE_ENTRIES.map(([, code]) => code));
    expect(mapCodes.has("INTERNAL_ERROR")).toBe(false);
    expect((MCP_DIRECT_ERROR_CODES as readonly string[]).includes("INTERNAL_ERROR")).toBe(false);
  });
});

describe("envelope: toolEnvelopeSchema", () => {
  it("accepts {ok:true, data:...}", () => {
    const result = toolEnvelopeSchema.safeParse({ ok: true, data: { x: 1 } });
    expect(result.success).toBe(true);
  });

  it("accepts {ok:false, error:{code, message}}", () => {
    const result = toolEnvelopeSchema.safeParse({
      ok: false,
      error: { code: "CONFIG_NOT_FOUND", message: "no .viberevert.yml" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts {ok:false, error:{code, message, details}}", () => {
    const result = toolEnvelopeSchema.safeParse({
      ok: false,
      error: { code: "X", message: "y", details: { hint: "z" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing ok discriminator", () => {
    const result = toolEnvelopeSchema.safeParse({ data: { x: 1 } });
    expect(result.success).toBe(false);
  });

  it("rejects ok:true with an extra error field (strict mode)", () => {
    const result = toolEnvelopeSchema.safeParse({
      ok: true,
      data: { x: 1 },
      error: { code: "X", message: "y" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects ok:false with an extra data field (strict mode)", () => {
    const result = toolEnvelopeSchema.safeParse({
      ok: false,
      data: { x: 1 },
      error: { code: "X", message: "y" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects ok:false with extra error object fields (strict mode -- blocks stack leak)", () => {
    const result = toolEnvelopeSchema.safeParse({
      ok: false,
      error: { code: "X", message: "y", stack: "do-not-leak" },
    });
    expect(result.success).toBe(false);
  });
});

describe("envelope: toolEnvelopeSchemaOf factory", () => {
  it("validates ok:true data against the per-tool data schema", () => {
    const schema = toolEnvelopeSchemaOf(
      z.object({ session_id: z.string(), checkpoint_id: z.string() }),
    );
    const valid = schema.safeParse({
      ok: true,
      data: { session_id: "sess_X", checkpoint_id: "cp_Y" },
    });
    expect(valid.success).toBe(true);

    const invalid = schema.safeParse({
      ok: true,
      data: { session_id: "sess_X" /* missing checkpoint_id */ },
    });
    expect(invalid.success).toBe(false);
  });

  it("ok:false uses the shared error shape regardless of data schema", () => {
    const schema = toolEnvelopeSchemaOf(z.object({ specific: z.literal("shape") }));
    const result = schema.safeParse({
      ok: false,
      error: { code: "X", message: "y" },
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// B. toErrorEnvelope 3-tier precedence
// ============================================================================

describe("envelope: toErrorEnvelope -- Tier 1 (McpDirectError brand)", () => {
  it("McpAuditWriteError -> MCP_AUDIT_WRITE_FAILED", () => {
    const env = toErrorEnvelope(new McpAuditWriteError("audit failed"));
    expect(env).toMatchObject({
      ok: false,
      error: { code: "MCP_AUDIT_WRITE_FAILED", message: "audit failed" },
    });
  });

  it("McpToolTimeoutError -> MCP_TOOL_TIMEOUT (via brand, not via map)", () => {
    const env = toErrorEnvelope(new McpToolTimeoutError("check_repo", 30000));
    expect(env).toMatchObject({
      ok: false,
      error: { code: "MCP_TOOL_TIMEOUT" },
    });
    if (env.ok === false) {
      expect(env.error.message).toContain("check_repo");
      expect(env.error.message).toContain("30000");
    }
  });
});

describe("envelope: toErrorEnvelope -- Tier 2 (constructor-keyed map)", () => {
  it("ConcurrentOperationError (cli-commands) -> CONCURRENT_OPERATION", () => {
    const env = toErrorEnvelope(
      new ConcurrentOperationError("/repo/.viberevert/locks/start", null),
    );
    expect(env).toMatchObject({
      ok: false,
      error: { code: "CONCURRENT_OPERATION" },
    });
  });

  it("ConfigNotFoundError (core) -> CONFIG_NOT_FOUND", () => {
    const env = toErrorEnvelope(new ConfigNotFoundError("/repo/.viberevert.yml"));
    expect(env).toMatchObject({
      ok: false,
      error: { code: "CONFIG_NOT_FOUND" },
    });
  });

  it("uses EXACT constructor identity (subclass without entry falls through to Tier 3)", () => {
    class DerivedConcurrent extends ConcurrentOperationError {}
    const env = toErrorEnvelope(new DerivedConcurrent("/repo/.viberevert/locks/start", null));
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
    }
  });
});

describe("envelope: toErrorEnvelope -- Tier 3 (fallback)", () => {
  it("unknown Error class -> INTERNAL_ERROR with original message", () => {
    const env = toErrorEnvelope(new Error("something exploded"));
    expect(env).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "something exploded" },
    });
  });

  it("McpBootError (regular Error, no brand) -> INTERNAL_ERROR", () => {
    const env = toErrorEnvelope(new McpBootError("boot blew up"));
    expect(env).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "boot blew up" },
    });
  });

  it("McpToolInvocationError (regular Error, no brand) -> INTERNAL_ERROR", () => {
    const env = toErrorEnvelope(new McpToolInvocationError("check_repo", "handler threw"));
    expect(env).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "handler threw" },
    });
  });

  it("string thrown -> INTERNAL_ERROR with the string as message", () => {
    const env = toErrorEnvelope("explicit string throw");
    expect(env).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "explicit string throw" },
    });
  });

  it("null thrown -> INTERNAL_ERROR with String(null) message", () => {
    const env = toErrorEnvelope(null);
    expect(env).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "null" },
    });
  });

  it("undefined thrown -> INTERNAL_ERROR with String(undefined) message", () => {
    const env = toErrorEnvelope(undefined);
    expect(env).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "undefined" },
    });
  });

  it("number thrown -> INTERNAL_ERROR with String(number) message", () => {
    const env = toErrorEnvelope(42);
    expect(env).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "42" },
    });
  });

  it("plain object thrown -> INTERNAL_ERROR with String(object) message", () => {
    const env = toErrorEnvelope({ foo: "bar" });
    expect(env).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "[object Object]" },
    });
  });
});

describe("envelope: toErrorEnvelope -- never leaks stack", () => {
  it("Tier 3 (unknown Error) does not include stack in message", () => {
    const err = new Error("oops");
    expect(err.stack).toBeDefined();
    const env = toErrorEnvelope(err);
    if (env.ok === false) {
      expect(env.error.message).toBe("oops");
      expect(env.error.message).not.toContain("at ");
      expect(env.error.message).not.toContain(".test.ts");
    }
  });

  it("Tier 1 (McpDirectError) does not include stack in message", () => {
    const env = toErrorEnvelope(new McpAuditWriteError("close failed"));
    if (env.ok === false) {
      expect(env.error.message).toBe("close failed");
      expect(env.error.message).not.toContain("at ");
    }
  });

  it("envelope shape never carries a details field unless explicitly set (and toErrorEnvelope never sets it)", () => {
    const env = toErrorEnvelope(new Error("x"));
    if (env.ok === false) {
      expect(env.error.details).toBeUndefined();
    }
  });
});

describe("envelope: toErrorEnvelope -- sanitizeMessage behavior (verified through Tier 3)", () => {
  it("strips ASCII control chars (0x00-0x1F and 0x7F) to spaces", () => {
    const env = toErrorEnvelope(new Error("a\x00b\x1Fc\x7Fd\te\nf"));
    if (env.ok === false) {
      expect(env.error.message).toBe("a b c d e f");
    }
  });

  it("collapses whitespace runs to a single space and trims", () => {
    const env = toErrorEnvelope(new Error("   foo   bar   "));
    if (env.ok === false) {
      expect(env.error.message).toBe("foo bar");
    }
  });

  it("caps the message at 512 chars with a truncation suffix", () => {
    const long = "x".repeat(1000);
    const env = toErrorEnvelope(new Error(long));
    if (env.ok === false) {
      expect(env.error.message.length).toBe(512);
      expect(env.error.message.endsWith("... (truncated)")).toBe(true);
    }
  });

  it("does NOT truncate short messages", () => {
    const env = toErrorEnvelope(new Error("short"));
    if (env.ok === false) {
      expect(env.error.message).toBe("short");
    }
  });
});

// ============================================================================
// C. formatZodErrorSummary
// ============================================================================

describe("envelope: formatZodErrorSummary -- path formatting", () => {
  it("uses <root> for an issue at the root path", () => {
    const fakeError = new z.ZodError([{ code: "custom", path: [], message: "root-level issue" }]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).toBe("<root>: root-level issue");
  });

  it("joins multi-segment paths with dots", () => {
    const fakeError = new z.ZodError([
      { code: "custom", path: ["a", "b", "c"], message: "nested issue" },
    ]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).toBe("a.b.c: nested issue");
  });

  it("stringifies numeric path segments (array index, etc.)", () => {
    const fakeError = new z.ZodError([
      { code: "custom", path: ["items", 0, "name"], message: "bad" },
    ]);
    expect(formatZodErrorSummary(fakeError)).toBe("items.0.name: bad");
  });

  it("joins multiple issues with '; '", () => {
    const fakeError = new z.ZodError([
      { code: "custom", path: ["x"], message: "first" },
      { code: "custom", path: ["y"], message: "second" },
    ]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).toBe("x: first; y: second");
  });
});

describe("envelope: formatZodErrorSummary -- value scrub (R31 secret-leak mitigation)", () => {
  it('scrubs `received "..."` (double-quoted) raw values', () => {
    const fakeError = new z.ZodError([
      {
        code: "custom",
        path: ["task"],
        message: 'Invalid input, received "this-is-the-raw-value"',
      },
    ]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).not.toContain("this-is-the-raw-value");
    expect(summary).toContain("received <value>");
  });

  it("scrubs `received '...'` (single-quoted) raw values", () => {
    const fakeError = new z.ZodError([
      {
        code: "custom",
        path: ["task"],
        message: "Invalid input, received 'another-raw-value'",
      },
    ]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).not.toContain("another-raw-value");
    expect(summary).toContain("received <value>");
  });

  it("scrubs unquoted received values (numbers, identifiers, etc.)", () => {
    const fakeError = new z.ZodError([
      {
        code: "custom",
        path: ["task"],
        message: "Invalid input, received SECRET_SENTINEL_DO_NOT_LOG",
      },
    ]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).not.toContain("SECRET_SENTINEL_DO_NOT_LOG");
    expect(summary).toContain("received <value>");
  });

  it("scrubs SECRET_SENTINEL_DO_NOT_LOG in quoted form (regression)", () => {
    const fakeError = new z.ZodError([
      {
        code: "custom",
        path: ["task"],
        message: 'Invalid value, received "SECRET_SENTINEL_DO_NOT_LOG"',
      },
    ]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).not.toContain("SECRET_SENTINEL_DO_NOT_LOG");
  });

  it("preserves structural info (expected type, path) when scrubbing values", () => {
    const fakeError = new z.ZodError([
      {
        code: "custom",
        path: ["task"],
        message: 'Expected string, received "actual-secret"',
      },
    ]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).toContain("Expected string");
    expect(summary).toContain("task");
    expect(summary).not.toContain("actual-secret");
  });
});

describe("envelope: formatZodErrorSummary -- control-char normalization", () => {
  it("normalizes newlines/tabs inside a Zod issue message to single spaces", () => {
    const fakeError = new z.ZodError([
      {
        code: "custom",
        path: ["task"],
        message: "first\nsecond\tthird",
      },
    ]);
    const summary = formatZodErrorSummary(fakeError);
    expect(summary).toBe("task: first second third");
    expect(summary).not.toContain("\n");
    expect(summary).not.toContain("\t");
  });
});

describe("envelope: formatZodErrorSummary -- empty fallback", () => {
  it("returns a non-empty fallback for empty ZodError issues", () => {
    expect(formatZodErrorSummary(new z.ZodError([]))).toBe("<root>: Invalid input");
  });
});

describe("envelope: formatZodErrorSummary -- truncation", () => {
  it("caps at 256 chars with `... (truncated)` suffix when exceeded", () => {
    const issues = Array.from({ length: 30 }, (_, i) => ({
      code: "custom" as const,
      path: [`field${i}`],
      message: "bad",
    }));
    const summary = formatZodErrorSummary(new z.ZodError(issues));
    expect(summary.length).toBe(256);
    expect(summary.endsWith("... (truncated)")).toBe(true);
  });

  it("does NOT truncate when under the cap", () => {
    const summary = formatZodErrorSummary(
      new z.ZodError([{ code: "custom", path: ["x"], message: "short" }]),
    );
    expect(summary.length).toBeLessThan(256);
    expect(summary).toBe("x: short");
  });
});
