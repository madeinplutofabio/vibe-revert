// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for tools/generate-fix-prompt.ts.
//
// Test focus:
//   - input validation (empty input, session-only, report-only,
//     both [mutual exclusion deferred to operation], empty strings
//     [resolver handles], non-string, extras, ID length cap
//     boundary, control-char ban)
//   - success projection (camelCase -> snake_case;
//     fix_prompt_path / prompt_text / source_report_id)
//   - D99.U truncation: BYTE-measured UTF-8 cap on prompt_text;
//     at-cap = NOT truncated; over-by-1-byte = bytes_omitted:1;
//     UTF-8 codepoint boundary safety (4-byte emoji straddling
//     cap -> truncation backs up to start byte, no replacement
//     char in result); fix_prompt_path is NEVER modified by
//     truncation (D99.U cap-applies-only-to-MCP-response)
//   - typed-error paths covering MCP_ERROR_CODE_MAP coverage
//     (12 typed error classes + INTERNAL_ERROR fallback;
//     PromptFixReadFailureError is tested in both phases)
//   - R31 regression-catch for the 4 special-cased errors
//     (Ambiguous / Invalid / ReportNotFound / TargetResolution):
//     real constructors with constructed credential-shaped
//     fixtures exercise the upstream message-template leak path;
//     assertions verify generic message AND no raw-input echo
//   - per-error WHITELIST detail serializers: path / phase /
//     report_id surfaced for the 5 PromptFix*Error classes that
//     carry them
//   - definition smoke (name, no cwd-like inputs, only `session` +
//     `report` properties, JSON-schema maxLength + pattern
//     presence-tolerant on each, additionalProperties:false)
//
// Mock strategy: stub @viberevert/cli-commands's
// generateFixPromptOperation at the boundary; preserve every other
// barrel re-export. Real RepoRootNotFoundError from
// @viberevert/core imported normally.
//
// All typed errors use their real constructors (no prototype-bypass
// helper). A prototype-bypass would defeat the R31 tests: those
// rely on the upstream message templates actually embedding the
// raw input bytes, which only happens when the real constructor
// runs.

import { Buffer } from "node:buffer";

import {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  PromptFixDriftDetectedError,
  PromptFixEmptyFindingsError,
  PromptFixIoFailureError,
  PromptFixReadFailureError,
  PromptFixReportParseError,
  PromptFixStaleRemovalFailureError,
  PromptFixTargetResolutionError,
  ReportNotFoundError,
  RuntimeEnvInvalidError,
} from "@viberevert/cli-commands";
import { RepoRootNotFoundError } from "@viberevert/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@viberevert/cli-commands", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/cli-commands")>(
    "@viberevert/cli-commands",
  );
  return {
    ...actual,
    generateFixPromptOperation: vi.fn(),
  };
});

const { handler, definition } = await import("../src/tools/generate-fix-prompt.js");
const cliCommands = await import("@viberevert/cli-commands");
const mockedGenerateFixPrompt = vi.mocked(cliCommands.generateFixPromptOperation);

const ABS_REPO_ROOT = "/abs/repo";

const DEFAULT_RESULT = {
  promptText: "the rendered prompt text",
  fixPromptPath: "/abs/repo/.viberevert/reports/rpt_01ABCDEFGHJKMNPQRSTVWXYZ12/fix-prompt.txt",
  sourceReportId: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
};

/**
 * Mirrors MAX_REPORT_TARGET_ID_LEN in generate-fix-prompt.ts.
 * Module-private per D99.G; redeclared here so this test can pin
 * boundary values without exporting the implementation constant.
 * Drift catch: source change without test update fails the
 * boundary tests loudly.
 */
const MAX_ID_LEN = 64;

/**
 * Mirrors MAX_GENERATE_FIX_PROMPT_TEXT_BYTES in
 * generate-fix-prompt.ts. Module-private per D99.G; redeclared
 * here so this test can construct boundary-condition prompts
 * without exporting the implementation constant.
 */
const MAX_TEXT_BYTES = 256 * 1024;

beforeEach(() => {
  mockedGenerateFixPrompt.mockReset();
});

/**
 * Shared INVALID_TOOL_INPUT envelope assertion. Locks the M G1a
 * Step 3.6 normalized contract:
 *   - error.code === "INVALID_TOOL_INPUT"
 *   - error.details is the InvalidToolInputDetails shape:
 *       - issue_count: positive number
 *       - truncated: boolean
 *       - issues: non-empty array of MCP-owned issue records
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

describe("generate_fix_prompt handler: input validation", () => {
  it("empty input passes; operation called exactly once with only cwd", async () => {
    mockedGenerateFixPrompt.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledWith({ cwd: ABS_REPO_ROOT });
    const opts = mockedGenerateFixPrompt.mock.calls[0]?.[0];
    expect(opts).not.toHaveProperty("session");
    expect(opts).not.toHaveProperty("report");
  });

  it("session-only passes; operation called with cwd + session (no report key)", async () => {
    mockedGenerateFixPrompt.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler(
      { session: "sess_01ABCDEFGHJKMNPQRSTVWXYZ12" },
      { repoRoot: ABS_REPO_ROOT },
    );
    expect(env.ok).toBe(true);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      session: "sess_01ABCDEFGHJKMNPQRSTVWXYZ12",
    });
    const opts = mockedGenerateFixPrompt.mock.calls[0]?.[0];
    expect(opts).not.toHaveProperty("report");
  });

  it("report-only passes; operation called with cwd + report (no session key)", async () => {
    mockedGenerateFixPrompt.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler(
      { report: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ34" },
      { repoRoot: ABS_REPO_ROOT },
    );
    expect(env.ok).toBe(true);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      report: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ34",
    });
    const opts = mockedGenerateFixPrompt.mock.calls[0]?.[0];
    expect(opts).not.toHaveProperty("session");
  });

  it("both session AND report pass schema (mutual exclusion deferred to operation/resolver)", async () => {
    mockedGenerateFixPrompt.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler(
      {
        session: "sess_01ABCDEFGHJKMNPQRSTVWXYZ12",
        report: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ34",
      },
      { repoRoot: ABS_REPO_ROOT },
    );
    expect(env.ok).toBe(true);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      session: "sess_01ABCDEFGHJKMNPQRSTVWXYZ12",
      report: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ34",
    });
  });

  it("empty-string session passes schema (resolver downstream handles invalid id shape)", async () => {
    mockedGenerateFixPrompt.mockResolvedValueOnce(DEFAULT_RESULT);
    const env = await handler({ session: "" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledWith({
      cwd: ABS_REPO_ROOT,
      session: "",
    });
  });

  it("rejects non-string session/report with INVALID_TOOL_INPUT; operation not called", async () => {
    for (const bad of [123, null, true, [], {}]) {
      mockedGenerateFixPrompt.mockClear();
      const sessionEnv = await handler({ session: bad }, { repoRoot: ABS_REPO_ROOT });
      expectInvalidToolInput(sessionEnv);
      expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();

      mockedGenerateFixPrompt.mockClear();
      const reportEnv = await handler({ report: bad }, { repoRoot: ABS_REPO_ROOT });
      expectInvalidToolInput(reportEnv);
      expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();
    }
  });

  it("rejects extra key (cwd) with INVALID_TOOL_INPUT; operation not called", async () => {
    const env = await handler({ cwd: "/other/repo" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(env);
    expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();
  });

  it("session and report at exactly MAX_ID_LEN characters pass schema", async () => {
    mockedGenerateFixPrompt.mockResolvedValue(DEFAULT_RESULT);
    const exactlyMax = "x".repeat(MAX_ID_LEN);

    const sessionEnv = await handler({ session: exactlyMax }, { repoRoot: ABS_REPO_ROOT });
    expect(sessionEnv.ok).toBe(true);

    mockedGenerateFixPrompt.mockClear();
    const reportEnv = await handler({ report: exactlyMax }, { repoRoot: ABS_REPO_ROOT });
    expect(reportEnv.ok).toBe(true);
  });

  it("session and report at MAX_ID_LEN+1 characters rejected with INVALID_TOOL_INPUT", async () => {
    const overMax = "x".repeat(MAX_ID_LEN + 1);

    const sessionEnv = await handler({ session: overMax }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(sessionEnv);
    expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();

    mockedGenerateFixPrompt.mockClear();
    const reportEnv = await handler({ report: overMax }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(reportEnv);
    expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();
  });

  it("session and report with NUL byte rejected (regression: control-char ban catches path-injection)", async () => {
    const sessionEnv = await handler(
      { session: "sess_X\x00injected" },
      { repoRoot: ABS_REPO_ROOT },
    );
    expectInvalidToolInput(sessionEnv);
    expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();

    mockedGenerateFixPrompt.mockClear();
    const reportEnv = await handler({ report: "rpt_Y\x00injected" }, { repoRoot: ABS_REPO_ROOT });
    expectInvalidToolInput(reportEnv);
    expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();
  });

  it("session and report with various ASCII control chars rejected", async () => {
    for (const controlChar of ["\x07", "\x1B", "\x7F", "\x1F"]) {
      mockedGenerateFixPrompt.mockClear();
      const sessionEnv = await handler(
        { session: `prefix${controlChar}suffix` },
        { repoRoot: ABS_REPO_ROOT },
      );
      expectInvalidToolInput(sessionEnv);
      expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();

      mockedGenerateFixPrompt.mockClear();
      const reportEnv = await handler(
        { report: `prefix${controlChar}suffix` },
        { repoRoot: ABS_REPO_ROOT },
      );
      expectInvalidToolInput(reportEnv);
      expect(mockedGenerateFixPrompt).not.toHaveBeenCalled();
    }
  });
});

// ============================================================================
// B. Success projection
// ============================================================================

describe("generate_fix_prompt handler: success projection", () => {
  it("projects operation result camelCase to MCP snake_case; non-truncated path omits truncated/bytes_omitted", async () => {
    mockedGenerateFixPrompt.mockResolvedValueOnce({
      promptText: "short prompt",
      fixPromptPath: "/abs/repo/.viberevert/reports/rpt_PROJTEST/fix-prompt.txt",
      sourceReportId: "rpt_PROJTEST",
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
    if (env.ok === true) {
      expect(env.data).toEqual({
        fix_prompt_path: "/abs/repo/.viberevert/reports/rpt_PROJTEST/fix-prompt.txt",
        prompt_text: "short prompt",
        source_report_id: "rpt_PROJTEST",
      });
      expect(env.data).not.toHaveProperty("truncated");
      expect(env.data).not.toHaveProperty("bytes_omitted");
    }
  });
});

// ============================================================================
// C. D99.U truncation (BYTE-measured, UTF-8 boundary-safe)
// ============================================================================

describe("generate_fix_prompt handler: D99.U truncation", () => {
  it("at-cap (exactly MAX_TEXT_BYTES of ASCII) is NOT truncated", async () => {
    const exactlyCap = "x".repeat(MAX_TEXT_BYTES);
    mockedGenerateFixPrompt.mockResolvedValueOnce({
      ...DEFAULT_RESULT,
      promptText: exactlyCap,
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true) {
      expect(Buffer.byteLength(env.data.prompt_text, "utf8")).toBe(MAX_TEXT_BYTES);
      expect(env.data).not.toHaveProperty("truncated");
      expect(env.data).not.toHaveProperty("bytes_omitted");
      expect(env.data.fix_prompt_path).toBe(DEFAULT_RESULT.fixPromptPath);
    }
  });

  it("over-by-1-byte ASCII is truncated; bytes_omitted=1; fix_prompt_path unchanged", async () => {
    const oneOverCap = "x".repeat(MAX_TEXT_BYTES + 1);
    mockedGenerateFixPrompt.mockResolvedValueOnce({
      ...DEFAULT_RESULT,
      promptText: oneOverCap,
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true) {
      expect(Buffer.byteLength(env.data.prompt_text, "utf8")).toBe(MAX_TEXT_BYTES);
      expect(env.data.truncated).toBe(true);
      expect(env.data.bytes_omitted).toBe(1);
      expect(env.data.fix_prompt_path).toBe(DEFAULT_RESULT.fixPromptPath);
    }
  });

  it("4-byte codepoint straddling cap: truncation backs up to start byte; result is valid UTF-8", async () => {
    const ASCII_PREFIX_BYTES = MAX_TEXT_BYTES - 3;
    const prompt = `${"x".repeat(ASCII_PREFIX_BYTES)}\u{1F600}`;
    expect(Buffer.byteLength(prompt, "utf8")).toBe(MAX_TEXT_BYTES + 1);

    mockedGenerateFixPrompt.mockResolvedValueOnce({
      ...DEFAULT_RESULT,
      promptText: prompt,
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true) {
      expect(Buffer.byteLength(env.data.prompt_text, "utf8")).toBe(ASCII_PREFIX_BYTES);
      expect(env.data.truncated).toBe(true);
      expect(env.data.bytes_omitted).toBe(4);
      expect(env.data.prompt_text).not.toContain("\u{1F600}");
      expect(env.data.prompt_text).not.toContain("\u{FFFD}");
      expect(env.data.fix_prompt_path).toBe(DEFAULT_RESULT.fixPromptPath);
    }
  });
});

// ============================================================================
// D. Typed-error mapping + per-error WHITELIST detail serializers
// ============================================================================

describe("generate_fix_prompt handler: typed-error mapping", () => {
  it("RepoRootNotFoundError -> REPO_ROOT_NOT_FOUND; operation called once", async () => {
    mockedGenerateFixPrompt.mockRejectedValueOnce(new RepoRootNotFoundError(ABS_REPO_ROOT));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("REPO_ROOT_NOT_FOUND");
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
  });

  it("AmbiguousReportSelectionError -> AMBIGUOUS_REPORT_SELECTION with generic message and no raw id echo", async () => {
    // R31 regression-catch: the upstream Error template embeds
    // BOTH the raw session and the raw report user-supplied ids.
    // Without the handler's special-case, toErrorEnvelope ->
    // sanitizeMessage would pass those bytes through unchanged.
    // Constructed credential-shaped fixtures per
    // [[feedback_constructed_secret_fixtures]] exercise the leak
    // path: template-literal interpolation defeats source-byte
    // scanner detection while producing credential-shaped runtime
    // strings the assertions below verify are NOT in the response.
    const rawSession = `sk${"_live_"}SESSION_FIXTURE`;
    const rawReport = `sk${"_live_"}REPORT_FIXTURE`;

    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new AmbiguousReportSelectionError(rawSession, rawReport),
    );

    const env = await handler(
      { session: rawSession, report: rawReport },
      { repoRoot: ABS_REPO_ROOT },
    );

    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("AMBIGUOUS_REPORT_SELECTION");
      expect(env.error.message).toBe("session and report are mutually exclusive");
      expect(env.error.message).not.toContain(rawSession);
      expect(env.error.message).not.toContain(rawReport);
      expect(env.error.details).toBeUndefined();
    }
  });

  it("InvalidReportSelectionError -> INVALID_REPORT_SELECTION with generic message and no raw id echo", async () => {
    // R31 regression-catch: upstream template embeds the rejected
    // raw value (kind, value, expectedShape).
    const rawReport = `sk${"_live_"}REPORT_FIXTURE`;

    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new InvalidReportSelectionError("report", rawReport, "expected rpt_<26-char Crockford ULID>"),
    );

    const env = await handler({ report: rawReport }, { repoRoot: ABS_REPO_ROOT });

    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INVALID_REPORT_SELECTION");
      expect(env.error.message).toBe("invalid report selection");
      expect(env.error.message).not.toContain(rawReport);
      expect(env.error.details).toBeUndefined();
    }
  });

  it("ReportNotFoundError -> REPORT_NOT_FOUND with generic message and no raw id echo", async () => {
    // R31 regression-catch: upstream message template embeds the
    // rejected raw id directly.
    const rawReport = "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12";

    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new ReportNotFoundError(`Report ${rawReport} not found.`, "report", rawReport),
    );

    const env = await handler({ report: rawReport }, { repoRoot: ABS_REPO_ROOT });

    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("REPORT_NOT_FOUND");
      expect(env.error.message).toBe("report not found");
      expect(env.error.message).not.toContain(rawReport);
      expect(env.error.details).toBeUndefined();
    }
  });

  it("RuntimeEnvInvalidError -> RUNTIME_ENV_INVALID; operation called once", async () => {
    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new RuntimeEnvInvalidError("VIBEREVERT_TEST_FIXED_NOW", "bad-value", "invalid format"),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("RUNTIME_ENV_INVALID");
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
  });

  it("PromptFixTargetResolutionError -> PROMPT_FIX_TARGET_RESOLUTION_FAILED with generic message; cause text not echoed", async () => {
    // R31 regression-catch: upstream template is formatCause(cause)
    // where cause may carry arbitrary bytes from UNKNOWN resolver
    // throws. The sentinel cause-message string must NOT appear in
    // the envelope's error.message after the handler's special-case
    // bypasses toErrorEnvelope.
    const sentinelCauseText = "SENTINEL_CAUSE_TEXT_DO_NOT_LEAK";
    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new PromptFixTargetResolutionError(new Error(sentinelCauseText)),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("PROMPT_FIX_TARGET_RESOLUTION_FAILED");
      expect(env.error.message).toBe("failed to resolve prompt-fix target");
      expect(env.error.message).not.toContain(sentinelCauseText);
      expect(env.error.details).toBeUndefined();
    }
  });

  it("PromptFixReadFailureError (phase=initial_read) -> PROMPT_FIX_READ_FAILED + details.{path,phase}", async () => {
    const path = "/abs/repo/.viberevert/reports/rpt_X/report.json";
    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new PromptFixReadFailureError({
        phase: "initial_read",
        path,
        cause: new Error("ENOENT"),
      }),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("PROMPT_FIX_READ_FAILED");
      const details = env.error.details as { path?: unknown; phase?: unknown };
      expect(details.path).toBe(path);
      expect(details.phase).toBe("initial_read");
    }
  });

  it("PromptFixReadFailureError (phase=drift_guard_read) -> details.phase reflects the drift-guard call site", async () => {
    const path = "/abs/repo/.viberevert/reports/rpt_X/report.json";
    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new PromptFixReadFailureError({
        phase: "drift_guard_read",
        path,
        cause: new Error("EIO"),
      }),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("PROMPT_FIX_READ_FAILED");
      const details = env.error.details as { phase?: unknown };
      expect(details.phase).toBe("drift_guard_read");
    }
  });

  it("PromptFixReportParseError -> PROMPT_FIX_REPORT_PARSE_FAILED + details.path", async () => {
    const path = "/abs/repo/.viberevert/reports/rpt_X/report.json";
    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new PromptFixReportParseError({ path, cause: new SyntaxError("Unexpected token") }),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("PROMPT_FIX_REPORT_PARSE_FAILED");
      const details = env.error.details as { path?: unknown };
      expect(details.path).toBe(path);
    }
  });

  it("PromptFixDriftDetectedError -> PROMPT_FIX_DRIFT_DETECTED (no details -- binary refusal)", async () => {
    mockedGenerateFixPrompt.mockRejectedValueOnce(new PromptFixDriftDetectedError());
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("PROMPT_FIX_DRIFT_DETECTED");
      expect(env.error.details).toBeUndefined();
    }
  });

  it("PromptFixStaleRemovalFailureError -> PROMPT_FIX_STALE_REMOVAL_FAILED + details.path", async () => {
    const path = "/abs/repo/.viberevert/reports/rpt_X/fix-prompt.txt";
    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new PromptFixStaleRemovalFailureError({ path, cause: new Error("EACCES") }),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("PROMPT_FIX_STALE_REMOVAL_FAILED");
      const details = env.error.details as { path?: unknown };
      expect(details.path).toBe(path);
    }
  });

  it("PromptFixIoFailureError -> PROMPT_FIX_IO_FAILED + details.{path,phase}", async () => {
    const path = "/abs/repo/.viberevert/reports/rpt_X/fix-prompt.txt";
    mockedGenerateFixPrompt.mockRejectedValueOnce(
      new PromptFixIoFailureError({
        phase: "persist_fix_prompt",
        path,
        cause: new Error("ENOSPC"),
      }),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("PROMPT_FIX_IO_FAILED");
      const details = env.error.details as { path?: unknown; phase?: unknown };
      expect(details.path).toBe(path);
      expect(details.phase).toBe("persist_fix_prompt");
    }
  });

  it("PromptFixEmptyFindingsError -> PROMPT_FIX_EMPTY_FINDINGS + details.report_id (semantic id from D86, NOT raw input)", async () => {
    const reportId = "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12";
    mockedGenerateFixPrompt.mockRejectedValueOnce(new PromptFixEmptyFindingsError({ reportId }));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("PROMPT_FIX_EMPTY_FINDINGS");
      const details = env.error.details as { report_id?: unknown };
      expect(details.report_id).toBe(reportId);
    }
  });

  it("unknown error from operation -> INTERNAL_ERROR fallback; operation called once", async () => {
    mockedGenerateFixPrompt.mockRejectedValueOnce(new Error("disk on fire"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INTERNAL_ERROR");
    expect(mockedGenerateFixPrompt).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// E. Definition smoke
// ============================================================================

describe("generate_fix_prompt definition export", () => {
  it("name is 'generate_fix_prompt'", () => {
    expect(definition.name).toBe("generate_fix_prompt");
  });

  it("inputSchema has no cwd-like keys (D99.M.17)", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    const forbidden = ["cwd", "target_repo", "repo", "directory", "repo_path", "working_directory"];
    for (const k of Object.keys(props)) expect(forbidden).not.toContain(k);
  });

  it("inputSchema's properties are exactly 'session' and 'report' (no other keys)", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["report", "session"]);
  });

  it("inputSchema exposes session and report as strings with maxLength === MAX_ID_LEN", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    const session = props["session"] as { type?: unknown; maxLength?: unknown };
    const report = props["report"] as { type?: unknown; maxLength?: unknown };
    expect(session.type).toBe("string");
    expect(session.maxLength).toBe(MAX_ID_LEN);
    expect(report.type).toBe("string");
    expect(report.maxLength).toBe(MAX_ID_LEN);
  });

  it("inputSchema's `session` and `report` each carry a pattern constraint somewhere in their schema", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    const session = props["session"] as Record<string, unknown>;
    const report = props["report"] as Record<string, unknown>;
    expect(JSON.stringify(session)).toContain('"pattern"');
    expect(JSON.stringify(report)).toContain('"pattern"');
  });

  it("inputSchema rejects additional properties at the JSON-schema layer", () => {
    expect(definition.inputSchema.additionalProperties).toBe(false);
  });
});
