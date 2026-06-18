// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for tools/check-repo.ts.
//
// Test strategy:
//
//   - Mock @viberevert/cli-commands at the BOUNDARY per the user's
//     ALSO #8 directive. vi.mock("@viberevert/cli-commands") with
//     passthrough of everything except runCommandInProcess, which
//     is replaced by vi.fn() so each test injects the harness
//     result. CheckCommand stays real (the argv it receives is
//     observable via the spy, and we assert exact argv per ALSO #2).
//
//   - Tests focus on envelope/data SHAPE per the per-tool test
//     boundary discipline. Dispatcher-level audit + cat-mapping
//     tests live in server.test.ts (Step 4).
//
// Groups:
//
//   A. Input validation -- safeParse rejection paths
//   B. Context guard -- isAbsolute(repoRoot) defensive guard
//   C. Argv construction -- exact tokens for every supported input
//   D. Exit 0 (no findings) -- success envelope, blocked:false
//   E. Exit 2 (blocker) -- success envelope, blocked:true (also
//      covered in tool-check-repo-blocked.test.ts, basic smoke here)
//   F. Exit 1 (CLI error) -- INTERNAL_ERROR envelope with
//      sanitized stderr-derived message
//   G. D99.U cap -- below-cap = full report, above-cap = summary
//      with bytes_omitted convergence invariant asserted
//   H. Throw from runCommandInProcess -- wrapped to envelope

import type { RunCommandInProcessResult } from "@viberevert/cli-commands";
import type { CheckResult, ReportFile } from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@viberevert/cli-commands", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/cli-commands")>(
    "@viberevert/cli-commands",
  );
  return {
    ...actual,
    runCommandInProcess: vi.fn(),
  };
});

const { handler, definition } = await import("../src/tools/check-repo.js");
const cliCommands = await import("@viberevert/cli-commands");
const mockedRun = vi.mocked(cliCommands.runCommandInProcess);

const ABS_REPO_ROOT = "/abs/repo";

const BASE_RESULT: RunCommandInProcessResult = {
  exitCode: 0,
  stdoutBytes: Buffer.from(""),
  stderrText: "",
  stdoutTruncated: false,
  stdoutBytesOmitted: 0,
  stderrTruncated: false,
  stderrBytesOmitted: 0,
};

function makeReport(overrides: Partial<ReportFile["report"]> = {}): ReportFile {
  return {
    schema_version: "1.0",
    kind: "ad_hoc",
    report_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
    since_kind: "git_ref",
    since_ref: "HEAD~1",
    since_resolved_sha: "abc1234567890abc1234567890abc1234567890",
    written_at: "2026-06-01T00:00:00Z",
    report: {
      schema_version: "1.0",
      session_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
      started_at: "2026-06-01T00:00:00Z",
      detected_frameworks: [],
      risk_level: "low",
      changed_files: [],
      results: [],
      rollback_available: false,
      ...overrides,
    },
  };
}

function makeSuccessResult(report: ReportFile, exitCode: 0 | 2 = 0): RunCommandInProcessResult {
  return {
    ...BASE_RESULT,
    exitCode,
    stdoutBytes: Buffer.from(JSON.stringify(report), "utf8"),
  };
}

beforeEach(() => {
  mockedRun.mockReset();
});

afterEach(() => {
  mockedRun.mockReset();
});

// ============================================================================
// A. Input validation
// ============================================================================

describe("check_repo handler: input validation", () => {
  it("rejects extra keys (strict)", async () => {
    const env = await handler({ extraneous: "x" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INVALID_TOOL_INPUT");
    }
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects invalid threshold enum value", async () => {
    const env = await handler({ threshold: "INVALID" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INVALID_TOOL_INPUT");
    }
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects wrong-type since (non-string)", async () => {
    const env = await handler({ since: 123 }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INVALID_TOOL_INPUT");
    }
  });

  it("accepts empty input object", async () => {
    mockedRun.mockResolvedValueOnce(makeSuccessResult(makeReport()));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
  });
});

// ============================================================================
// B. Context guard
// ============================================================================

describe("check_repo handler: ToolHandlerContext.repoRoot guard", () => {
  it("returns INTERNAL_ERROR when repoRoot is not absolute", async () => {
    const env = await handler({}, { repoRoot: "relative/path" });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
      expect(env.error.message).toContain("must be an absolute path");
    }
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

// ============================================================================
// C. Argv construction (exact tokens per supported input)
// ============================================================================

describe("check_repo handler: argv construction", () => {
  beforeEach(() => {
    mockedRun.mockResolvedValueOnce(makeSuccessResult(makeReport()));
  });

  it("emits ['check', '--json'] for empty input", async () => {
    await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun).toHaveBeenCalledTimes(1);
    const call = mockedRun.mock.calls[0];
    expect(call?.[0]).toBe(cliCommands.CheckCommand);
    expect(call?.[1]).toEqual(["check", "--json"]);
    expect(call?.[2]).toEqual({ cwd: ABS_REPO_ROOT });
  });

  it("emits ['check', '--json', '--since', '<value>'] when since is set", async () => {
    await handler({ since: "HEAD~3" }, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["check", "--json", "--since", "HEAD~3"]);
  });

  it("emits ['check', '--json', '--staged'] when staged is true", async () => {
    await handler({ staged: true }, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["check", "--json", "--staged"]);
  });

  it("does NOT emit --staged when staged is false (default)", async () => {
    await handler({ staged: false }, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["check", "--json"]);
  });

  it("emits ['check', '--json', '--threshold', '<level>']", async () => {
    await handler({ threshold: "high" }, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["check", "--json", "--threshold", "high"]);
  });

  it("emits ['check', '--json', '--task', '<text>']", async () => {
    await handler({ task: "Refactor auth" }, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["check", "--json", "--task", "Refactor auth"]);
  });

  it("emits all flags in stable order when all supplied", async () => {
    await handler(
      { since: "HEAD~1", staged: true, threshold: "medium", task: "T" },
      { repoRoot: ABS_REPO_ROOT },
    );
    expect(mockedRun.mock.calls[0]?.[1]).toEqual([
      "check",
      "--json",
      "--since",
      "HEAD~1",
      "--staged",
      "--threshold",
      "medium",
      "--task",
      "T",
    ]);
  });
});

// ============================================================================
// D. Exit 0 (no findings)
// ============================================================================

describe("check_repo handler: exit 0 success envelope", () => {
  it("returns ok:true, exit_code:0, blocked:false, full report", async () => {
    const report = makeReport();
    mockedRun.mockResolvedValueOnce(makeSuccessResult(report, 0));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true && "report" in env.data) {
      expect(env.data.exit_code).toBe(0);
      expect(env.data.blocked).toBe(false);
      expect(env.data.report).toEqual(report);
      expect(env.data.truncated).toBeUndefined();
    } else {
      throw new Error("expected report branch with exit_code 0");
    }
  });
});

// ============================================================================
// E. Exit 2 (blocker)
// ============================================================================

describe("check_repo handler: exit 2 success envelope (blocker)", () => {
  it("returns ok:true, exit_code:2, blocked:true, full report (basic smoke)", async () => {
    const report = makeReport({
      risk_level: "critical",
      results: [
        {
          id: "rule.x",
          title: "Bad",
          level: "critical",
          confidence: "high",
          category: "secrets",
          message: "found a secret",
          evidence: [{ detail: "x" }],
          recommendation: "Remove the secret.",
        },
      ],
    });
    mockedRun.mockResolvedValueOnce(makeSuccessResult(report, 2));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true && "report" in env.data) {
      expect(env.data.exit_code).toBe(2);
      expect(env.data.blocked).toBe(true);
    } else {
      throw new Error("expected report branch with exit_code 2");
    }
  });
});

// ============================================================================
// F. Exit 1 (CLI error)
// ============================================================================

describe("check_repo handler: exit 1 maps to INTERNAL_ERROR", () => {
  it("uses sanitized stderr when present", async () => {
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      exitCode: 1,
      stderrText: 'Invalid --threshold "oops". Expected one of: low, medium, high, critical.\n',
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
      expect(env.error.message).toContain("Invalid --threshold");
      expect(env.error.message).not.toMatch(/\n/);
    }
  });

  it("uses fallback message when stderr is empty", async () => {
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, exitCode: 1, stderrText: "" });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
      expect(env.error.message).toBe("check_repo command failed");
    }
  });

  it("caps sanitized stderr at 512 chars", async () => {
    const longStderr = "x".repeat(2000);
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, exitCode: 1, stderrText: longStderr });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === false) {
      expect(env.error.message.length).toBeLessThanOrEqual(512);
      expect(env.error.message).toMatch(/truncated/);
    }
  });
});

// ============================================================================
// G. D99.U cap (1 MiB) discriminated-union switch
// ============================================================================

describe("check_repo handler: D99.U cap (1 MiB)", () => {
  it("below cap -> full report branch", async () => {
    const report = makeReport();
    mockedRun.mockResolvedValueOnce(makeSuccessResult(report, 0));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true && "report" in env.data) {
      expect(env.data.truncated).toBeUndefined();
    } else {
      throw new Error("expected report branch below cap");
    }
  });

  it("above cap -> report_summary branch with severity_counts + bytes_omitted convergence", async () => {
    // Build a synthetic ReportFile whose serialized data payload
    // exceeds 1 MiB. Uses noise-budget-valid distribution per the
    // ReportFileSchema refinements:
    //   - total findings <= 100 (NOISE_BUDGET_MAX_TOTAL)
    //   - low findings <= 20 (NOISE_BUDGET_MAX_LOW)
    //   - per-category findings <= 40 (NOISE_BUDGET_MAX_PER_CATEGORY)
    //
    // Distribution: 40 critical / 40 high / 20 medium / 0 low,
    // each in its own category to respect per-category cap.
    // Recommendation is ~13 KiB per finding to push above 1 MiB.
    const longRec = "x".repeat(13 * 1024);
    const results: CheckResult[] = [];
    for (let i = 0; i < 40; i += 1) {
      results.push({
        id: `crit.${i}`,
        title: `Critical ${i}`,
        level: "critical",
        confidence: "high",
        category: "critical",
        message: `msg ${i}`,
        evidence: [{ detail: "x" }],
        recommendation: longRec,
      });
    }
    for (let i = 0; i < 40; i += 1) {
      results.push({
        id: `high.${i}`,
        title: `High ${i}`,
        level: "high",
        confidence: "high",
        category: "high",
        message: `msg ${i}`,
        evidence: [{ detail: "x" }],
        recommendation: longRec,
      });
    }
    for (let i = 0; i < 20; i += 1) {
      results.push({
        id: `med.${i}`,
        title: `Medium ${i}`,
        level: "medium",
        confidence: "high",
        category: "medium",
        message: `msg ${i}`,
        evidence: [{ detail: "x" }],
        recommendation: longRec,
      });
    }
    const report = makeReport({ risk_level: "critical", results });
    mockedRun.mockResolvedValueOnce(makeSuccessResult(report, 0));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true && "report_summary" in env.data) {
      expect(env.data.truncated).toBe(true);
      expect(env.data.bytes_omitted).toBeGreaterThan(0);
      expect(env.data.report_summary.finding_count).toBe(100);
      expect(env.data.report_summary.findings_omitted).toBe(100);
      expect(env.data.report_summary.severity_counts).toEqual({
        critical: 40,
        high: 40,
        medium: 20,
        low: 0,
      });
      expect(env.data.report_summary.report_id).toBe(report.report_id);

      // Convergence invariant: bytes_omitted equals the exact
      // difference between the full data payload size and the
      // actual emitted summary data size. This catches any
      // regression in the fixed-point loop that could land
      // bytes_omitted on an off-by-one value.
      const fullDataBytes = Buffer.byteLength(
        JSON.stringify({ report, exit_code: 0, blocked: false }),
        "utf8",
      );
      expect(env.data.bytes_omitted).toBe(
        fullDataBytes - Buffer.byteLength(JSON.stringify(env.data), "utf8"),
      );
    } else {
      throw new Error("expected report_summary branch above cap");
    }
  });
});

// ============================================================================
// H. runCommandInProcess throw -> wrapped envelope
// ============================================================================

describe("check_repo handler: harness throw mapping", () => {
  it("wraps a thrown error into INTERNAL_ERROR envelope (never re-throws)", async () => {
    mockedRun.mockRejectedValueOnce(new Error("synthetic harness boom"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
      expect(env.error.message).toContain("synthetic harness boom");
    }
  });
});

// ============================================================================
// Definition smoke (per-file definition export shape)
// ============================================================================

describe("check_repo definition export", () => {
  it("name is 'check_repo'", () => {
    expect(definition.name).toBe("check_repo");
  });
  it("inputSchema is a non-null object with no cwd-like keys", () => {
    expect(typeof definition.inputSchema).toBe("object");
    expect(definition.inputSchema).not.toBeNull();
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    const keys = Object.keys(props);
    const forbidden = ["cwd", "target_repo", "repo", "directory", "repo_path", "working_directory"];
    for (const k of keys) {
      expect(forbidden).not.toContain(k);
    }
  });
});
