// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for envelope.ts.
//
// Four logical groups:
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
//      - Real-Zod integration: scrubbing against actual Zod
//        strict-object failure messages (not just hand-authored)
//
//   D. toInvalidToolInputEnvelope (M G1a Step 3.6 normalized contract)
//      - Envelope shape (code/message/details)
//      - issue_count + truncated semantics
//      - Whitelist projection (only code/path/message per issue)
//      - Snapshot ownership (no raw ZodIssue references escape)
//      - Bounds (issue count, message length, path segment length)
//      - R31 scrubbing of received-value AND unrecognized-key
//        messages, including a real-Zod integration test

import { ConcurrentOperationError } from "@viberevert/cli-commands";
import { ConfigNotFoundError } from "@viberevert/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  formatZodErrorSummary,
  type InvalidToolInputDetails,
  type InvalidToolInputIssue,
  MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN,
  MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN,
  MAX_INVALID_TOOL_INPUT_ISSUES,
  MCP_ERROR_CODE_ENTRIES,
  MCP_ERROR_CODE_MAP,
  toErrorEnvelope,
  toInvalidToolInputEnvelope,
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
// Section D + C-real-Zod helpers
// ============================================================================

/**
 * Local test helper: creates a ZodError from issue-like records,
 * keeping the unavoidable `as unknown as z.ZodIssue` cast in one
 * place. The `& Record<string, unknown>` lets defensive tests
 * inject extra fields (to prove the whitelist projection drops
 * them) without per-call casts.
 */
type TestZodIssue = {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
} & Record<string, unknown>;

function makeZodError(issues: readonly TestZodIssue[]): z.ZodError {
  return new z.ZodError(issues as unknown as z.ZodIssue[]);
}

/**
 * Shared INVALID_TOOL_INPUT envelope assertion. Locks the M G1a
 * Step 3.6 normalized contract by asserting the envelope shape AND
 * narrowing to InvalidToolInputDetails for return. Throws (loud
 * failure) if env is not an INVALID_TOOL_INPUT envelope -- replaces
 * the silent-pass `if (env.ok === false) { ... }` pattern.
 *
 * Returns InvalidToolInputDetails so callers can chain assertions
 * on issue_count / truncated / issues without re-casting.
 */
function expectInvalidToolInputDetails(
  env: ReturnType<typeof toInvalidToolInputEnvelope>,
): InvalidToolInputDetails {
  expect(env.ok).toBe(false);
  if (env.ok !== false) {
    throw new Error("Expected INVALID_TOOL_INPUT envelope");
  }

  expect(env.error.code).toBe("INVALID_TOOL_INPUT");
  expect(env.error.details).toEqual(
    expect.objectContaining({
      issue_count: expect.any(Number),
      truncated: expect.any(Boolean),
      issues: expect.any(Array),
    }),
  );

  const details = env.error.details as InvalidToolInputDetails;
  expect(details.issue_count).toBeGreaterThan(0);
  return details;
}

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

  it("real-Zod integration: scrubs Unrecognized keys against the actual installed Zod version", () => {
    // Locks the scrubber against Zod's actual strict-object failure
    // message format, not only our hand-authored test format.
    // Constructed credential-shaped fixture per the locked rule:
    // template-literal interpolation defeats scanner detection.
    const credentialKey = `sk${"_live_"}TEST_FIXTURE_ONLY`;
    const parsed = z
      .object({ allowed: z.string() })
      .strict()
      .safeParse({ allowed: "ok", [credentialKey]: "x" });
    expect(parsed.success).toBe(false);
    if (parsed.success !== false) throw new Error("Expected Zod parse failure");

    const summary = formatZodErrorSummary(parsed.error);
    expect(summary).not.toContain(credentialKey);
    expect(summary).toContain("unrecognized key(s): <key>");
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

// ============================================================================
// D. toInvalidToolInputEnvelope (M G1a Step 3.6 normalized contract)
// ============================================================================

describe("envelope: toInvalidToolInputEnvelope -- envelope shape", () => {
  it("returns ok:false with code INVALID_TOOL_INPUT", () => {
    const env = toInvalidToolInputEnvelope(
      "get_policy",
      makeZodError([{ code: "custom", path: ["x"], message: "bad" }]),
    );
    expectInvalidToolInputDetails(env);
  });

  it("interpolates toolName into error.message", () => {
    const env = toInvalidToolInputEnvelope(
      "start_session",
      makeZodError([{ code: "custom", path: [], message: "bad" }]),
    );
    expectInvalidToolInputDetails(env);
    if (env.ok !== false) throw new Error("unreachable");
    expect(env.error.message).toBe("start_session input failed validation");
  });

  it("details is the InvalidToolInputDetails shape {issue_count, truncated, issues}", () => {
    // Shape itself is asserted inside expectInvalidToolInputDetails; this
    // test additionally documents the contract intent with a name.
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([{ code: "custom", path: ["x"], message: "bad" }]),
    );
    expectInvalidToolInputDetails(env);
  });

  it("details.issue_count reflects the ORIGINAL ZodError issue count (not capped)", () => {
    const issues = Array.from({ length: MAX_INVALID_TOOL_INPUT_ISSUES + 7 }, (_, i) => ({
      code: "custom" as const,
      path: [`f${i}`],
      message: "bad",
    }));
    const env = toInvalidToolInputEnvelope("tool_x", makeZodError(issues));
    const details = expectInvalidToolInputDetails(env);
    expect(details.issue_count).toBe(MAX_INVALID_TOOL_INPUT_ISSUES + 7);
  });

  it("details.truncated is false when issue count <= MAX_INVALID_TOOL_INPUT_ISSUES", () => {
    const issues = Array.from({ length: MAX_INVALID_TOOL_INPUT_ISSUES }, (_, i) => ({
      code: "custom" as const,
      path: [`f${i}`],
      message: "bad",
    }));
    const env = toInvalidToolInputEnvelope("tool_x", makeZodError(issues));
    const details = expectInvalidToolInputDetails(env);
    expect(details.truncated).toBe(false);
    expect(details.issues.length).toBe(MAX_INVALID_TOOL_INPUT_ISSUES);
  });

  it("details.truncated is true when issue count > MAX_INVALID_TOOL_INPUT_ISSUES; issues array capped", () => {
    const issues = Array.from({ length: MAX_INVALID_TOOL_INPUT_ISSUES + 5 }, (_, i) => ({
      code: "custom" as const,
      path: [`f${i}`],
      message: "bad",
    }));
    const env = toInvalidToolInputEnvelope("tool_x", makeZodError(issues));
    const details = expectInvalidToolInputDetails(env);
    expect(details.truncated).toBe(true);
    expect(details.issues.length).toBe(MAX_INVALID_TOOL_INPUT_ISSUES);
  });

  it("details.issues is always an array even for a single issue", () => {
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([{ code: "custom", path: ["x"], message: "bad" }]),
    );
    const details = expectInvalidToolInputDetails(env);
    expect(Array.isArray(details.issues)).toBe(true);
    expect(details.issues.length).toBe(1);
  });
});

describe("envelope: toInvalidToolInputEnvelope -- whitelist + snapshot ownership", () => {
  it("each issue exposes ONLY {code, path, message} -- no raw Zod fields", () => {
    // Construct a ZodError whose issues carry extra fields a future Zod
    // version (or a malicious caller) might add. The whitelist projection
    // must drop everything except {code, path, message}.
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([
        {
          code: "custom",
          path: ["x"],
          message: "bad",
          received: "should-not-leak",
          expected: "string",
          _internalZodHandle: { secret: "do-not-expose" },
        },
      ]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as Record<string, unknown>;
    expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    expect(issue).not.toHaveProperty("received");
    expect(issue).not.toHaveProperty("expected");
    expect(issue).not.toHaveProperty("_internalZodHandle");
  });

  it("details.issues is a new array (not the same reference as source ZodError.issues)", () => {
    const zerr = makeZodError([{ code: "custom", path: ["x"], message: "bad" }]);
    const env = toInvalidToolInputEnvelope("tool_x", zerr);
    const details = expectInvalidToolInputDetails(env);
    expect(details.issues).not.toBe(zerr.issues);
  });

  it("each issue object is a fresh MCP-owned object (not the same reference as source ZodIssue)", () => {
    const sourceIssue: TestZodIssue = { code: "custom", path: ["x"], message: "bad" };
    const zerr = makeZodError([sourceIssue]);
    const env = toInvalidToolInputEnvelope("tool_x", zerr);
    const details = expectInvalidToolInputDetails(env);
    expect(details.issues[0]).not.toBe(sourceIssue);
    expect(details.issues[0]).not.toBe(zerr.issues[0]);
  });
});

describe("envelope: toInvalidToolInputEnvelope -- bounds", () => {
  it("issue.message is capped at MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN with truncation suffix", () => {
    const longMessage = "x".repeat(MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN * 2);
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([{ code: "custom", path: ["x"], message: longMessage }]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.message.length).toBe(MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN);
    expect(issue.message.endsWith("... (truncated)")).toBe(true);
  });

  it("issue.message is NOT modified when shorter than the cap", () => {
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([{ code: "custom", path: ["x"], message: "short" }]),
    );
    const details = expectInvalidToolInputDetails(env);
    expect((details.issues[0] as InvalidToolInputIssue).message).toBe("short");
  });

  it("path segments are capped at MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN with truncation suffix", () => {
    const longSegment = "p".repeat(MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN * 2);
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([{ code: "custom", path: [longSegment], message: "bad" }]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.path).toHaveLength(1);
    expect(issue.path[0]?.length).toBe(MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN);
    expect(issue.path[0]?.endsWith("... (truncated)")).toBe(true);
  });

  it("numeric path segments are stringified (Zod path: (string|number)[])", () => {
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([{ code: "custom", path: ["items", 7, "name"], message: "bad" }]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.path).toEqual(["items", "7", "name"]);
  });
});

describe("envelope: toInvalidToolInputEnvelope -- R31 message scrubbing", () => {
  it('scrubs `received "..."` in issue message', () => {
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([
        { code: "custom", path: ["x"], message: 'Invalid input, received "raw-value-bytes"' },
      ]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.message).not.toContain("raw-value-bytes");
    expect(issue.message).toContain("received <value>");
  });

  it("scrubs Unrecognized key (singular) with credential-shaped key name", () => {
    const credentialKey = `sk${"_live_"}TEST_FIXTURE_ONLY`;
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([
        {
          code: "unrecognized_keys",
          path: [],
          message: `Unrecognized key: "${credentialKey}"`,
        },
      ]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.message).not.toContain(credentialKey);
    expect(issue.message).toContain("unrecognized key(s): <key>");
  });

  it("scrubs Unrecognized keys (plural) with multiple credential-shaped key names", () => {
    const credentialA = `sk${"_test_"}FIXTURE_A`;
    const credentialB = `ak${"ia_"}FIXTURE_B`;
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([
        {
          code: "unrecognized_keys",
          path: [],
          message: `Unrecognized keys: "${credentialA}", "${credentialB}"`,
        },
      ]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.message).not.toContain(credentialA);
    expect(issue.message).not.toContain(credentialB);
    expect(issue.message).toContain("unrecognized key(s): <key>");
  });

  it("scrubs older Zod wording with single-quoted key names", () => {
    // Locks the broader regex branch: `Unrecognized key(s) in object:`
    // wording + single-quoted key list. Older Zod versions used this
    // shape; the regex tolerates both.
    const credentialKey = `sk${"_live_"}OLDER_WORDING_FIXTURE`;
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([
        {
          code: "unrecognized_keys",
          path: [],
          message: `Unrecognized key(s) in object: '${credentialKey}'`,
        },
      ]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.message).not.toContain(credentialKey);
    expect(issue.message).toContain("unrecognized key(s): <key>");
  });

  it("scrubs quoted key names that contain escaped quote characters", () => {
    // Locks the escape-aware quoted-string matcher (?:\\.|[^"\\])*.
    // With the old non-escape-aware matcher `(?:"[^"]*")`, this test
    // would FAIL because the regex would stop at the escaped quote,
    // leaving the "suffix" portion of the key name in the output.
    // Both `prefix` and `suffix` must be scrubbed for the test to pass.
    const escapedQuoteKey = 'prefix\\"suffix';
    const env = toInvalidToolInputEnvelope(
      "tool_x",
      makeZodError([
        {
          code: "unrecognized_keys",
          path: [],
          message: `Unrecognized key: "${escapedQuoteKey}"`,
        },
      ]),
    );
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.message).not.toContain("prefix");
    expect(issue.message).not.toContain("suffix");
    expect(issue.message).toContain("unrecognized key(s): <key>");
  });

  it("real-Zod integration: scrubs Unrecognized keys against the actual installed Zod version", () => {
    // Locks the scrubber against Zod's actual strict-object failure
    // message format, not only our hand-authored test format. If Zod
    // changes its message wording in a future version, this test
    // catches the leak before MCP consumers see it.
    const credentialKey = `sk${"_live_"}TEST_FIXTURE_ONLY`;
    const parsed = z
      .object({ allowed: z.string() })
      .strict()
      .safeParse({ allowed: "ok", [credentialKey]: "x" });
    expect(parsed.success).toBe(false);
    if (parsed.success !== false) throw new Error("Expected Zod parse failure");

    const env = toInvalidToolInputEnvelope("tool_x", parsed.error);
    const details = expectInvalidToolInputDetails(env);
    const issue = details.issues[0] as InvalidToolInputIssue;
    expect(issue.message).not.toContain(credentialKey);
    expect(issue.message).toContain("unrecognized key(s): <key>");
  });
});
