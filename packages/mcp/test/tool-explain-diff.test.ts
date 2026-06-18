// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for tools/explain-diff.ts.
//
// Test focus:
//   - 2-call sequence (JSON first, markdown second with explicit id)
//   - Metadata projection
//   - Threshold propagation to both calls
//   - D99.U 256 KiB cap with truncated flag
//   - TOCTOU mitigation: markdown call uses identifier from JSON result
//   - session/report mutex rejection

import type { RunCommandInProcessResult } from "@viberevert/cli-commands";
import type { ReportFile } from "@viberevert/session-format";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@viberevert/cli-commands", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/cli-commands")>(
    "@viberevert/cli-commands",
  );
  return {
    ...actual,
    runCommandInProcess: vi.fn(),
  };
});

const { handler, definition } = await import("../src/tools/explain-diff.js");
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

function makeReport(
  overrides: {
    kind?: "ad_hoc" | "session_bound";
    reportId?: string;
    resultsCount?: number;
    changedFilesCount?: number;
    riskLevel?: "low" | "medium" | "high" | "critical";
  } = {},
): ReportFile {
  const kind = overrides.kind ?? "ad_hoc";
  const reportId =
    overrides.reportId ??
    (kind === "ad_hoc" ? "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12" : "sess_01ABCDEFGHJKMNPQRSTVWXYZ34");
  return {
    schema_version: "1.0",
    kind,
    report_id: reportId,
    since_kind: kind === "session_bound" ? "session_id" : "git_ref",
    since_ref: "HEAD~1",
    since_resolved_sha: "abc1234567890abc1234567890abc1234567890",
    written_at: "2026-06-01T00:00:00Z",
    report: {
      schema_version: "1.0",
      session_id: reportId,
      started_at: "2026-06-01T00:00:00Z",
      detected_frameworks: [],
      risk_level: overrides.riskLevel ?? "low",
      changed_files: Array.from({ length: overrides.changedFilesCount ?? 0 }, (_, i) => ({
        path: `src/f${i}.ts`,
        status: "modified" as const,
        risk_tags: [],
        risk_level: "low" as const,
      })),
      results: Array.from({ length: overrides.resultsCount ?? 0 }, (_, i) => ({
        id: `rule.${i}`,
        title: `T${i}`,
        level: "low" as const,
        confidence: "high" as const,
        category: "cat",
        message: "m",
        evidence: [{ detail: "x" }],
      })),
      rollback_available: false,
    },
  };
}

function jsonResult(report: ReportFile): RunCommandInProcessResult {
  return { ...BASE_RESULT, stdoutBytes: Buffer.from(JSON.stringify(report), "utf8") };
}

function markdownResult(body: string): RunCommandInProcessResult {
  return { ...BASE_RESULT, stdoutBytes: Buffer.from(body, "utf8") };
}

beforeEach(() => {
  mockedRun.mockReset();
});

// ============================================================================
// A. Input validation
// ============================================================================

describe("explain_diff handler: input validation", () => {
  it("rejects session+report mutex", async () => {
    const env = await handler({ session: "s", report: "r" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INVALID_TOOL_INPUT");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects empty-string session", async () => {
    const env = await handler({ session: "" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INVALID_TOOL_INPUT");
  });

  it("rejects invalid threshold value", async () => {
    const env = await handler({ threshold: "X" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INVALID_TOOL_INPUT");
  });

  it("rejects extra key", async () => {
    const env = await handler({ extra: 1 }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INVALID_TOOL_INPUT");
  });
});

// ============================================================================
// B. 2-call argv sequence (JSON first, markdown second with explicit id)
// ============================================================================

describe("explain_diff handler: 2-call sequence", () => {
  it("calls --json FIRST, then --markdown SECOND with explicit id from JSON (ad_hoc)", async () => {
    const report = makeReport({ kind: "ad_hoc", reportId: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ77" });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce(markdownResult("# VibeRevert Report\n..."));
    await handler({}, { repoRoot: ABS_REPO_ROOT });

    expect(mockedRun).toHaveBeenCalledTimes(2);
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["report", "--json"]);
    // Second call uses --report (ad_hoc -> --report) with the EXACT id from JSON.
    expect(mockedRun.mock.calls[1]?.[1]).toEqual([
      "report",
      "--markdown",
      "--report",
      "rpt_01ABCDEFGHJKMNPQRSTVWXYZ77",
    ]);
  });

  it("uses --session for session_bound kind", async () => {
    const report = makeReport({
      kind: "session_bound",
      reportId: "sess_01ABCDEFGHJKMNPQRSTVWXYZ88",
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce(markdownResult("body"));
    await handler({}, { repoRoot: ABS_REPO_ROOT });

    expect(mockedRun.mock.calls[1]?.[1]).toEqual([
      "report",
      "--markdown",
      "--session",
      "sess_01ABCDEFGHJKMNPQRSTVWXYZ88",
    ]);
  });

  it("propagates --session input to JSON call", async () => {
    const report = makeReport({
      kind: "session_bound",
      reportId: "sess_01ABCDEFGHJKMNPQRSTVWXYZ99",
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce(markdownResult("body"));
    await handler({ session: "sess_XYZ_INPUT" }, { repoRoot: ABS_REPO_ROOT });

    expect(mockedRun.mock.calls[0]?.[1]).toEqual([
      "report",
      "--json",
      "--session",
      "sess_XYZ_INPUT",
    ]);
    // Second call uses the id from the PARSED ReportFile, NOT the input.
    expect(mockedRun.mock.calls[1]?.[1]).toEqual([
      "report",
      "--markdown",
      "--session",
      "sess_01ABCDEFGHJKMNPQRSTVWXYZ99", // from parsed ReportFile.report_id
    ]);
  });

  it("propagates --report input to JSON call", async () => {
    const report = makeReport({
      kind: "ad_hoc",
      reportId: "rpt_01ABCDEFGHJKMNPQRSTVWXYZRR",
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce(markdownResult("body"));

    await handler({ report: "rpt_INPUT" }, { repoRoot: ABS_REPO_ROOT });

    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["report", "--json", "--report", "rpt_INPUT"]);

    expect(mockedRun.mock.calls[1]?.[1]).toEqual([
      "report",
      "--markdown",
      "--report",
      "rpt_01ABCDEFGHJKMNPQRSTVWXYZRR",
    ]);
  });

  it("propagates --threshold to BOTH calls (matches metadata and markdown filtering)", async () => {
    const report = makeReport({ kind: "ad_hoc", reportId: "rpt_01ABCDEFGHJKMNPQRSTVWXYZAA" });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce(markdownResult("body"));
    await handler({ threshold: "high" }, { repoRoot: ABS_REPO_ROOT });

    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["report", "--json", "--threshold", "high"]);
    expect(mockedRun.mock.calls[1]?.[1]).toEqual([
      "report",
      "--markdown",
      "--report",
      "rpt_01ABCDEFGHJKMNPQRSTVWXYZAA",
      "--threshold",
      "high",
    ]);
  });
});

// ============================================================================
// C. Metadata projection
// ============================================================================

describe("explain_diff handler: metadata projection", () => {
  it("returns the locked metadata shape (8 fields, no SessionReport leak)", async () => {
    const report = makeReport({
      kind: "ad_hoc",
      reportId: "rpt_01ABCDEFGHJKMNPQRSTVWXYZMM",
      resultsCount: 5,
      changedFilesCount: 7,
      riskLevel: "high",
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce(markdownResult("body"));

    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true) {
      expect(env.data.report_id).toBe("rpt_01ABCDEFGHJKMNPQRSTVWXYZMM");
      expect(env.data.report_metadata).toEqual({
        kind: "ad_hoc",
        since_kind: "git_ref",
        since_ref: "HEAD~1",
        since_resolved_sha: "abc1234567890abc1234567890abc1234567890",
        written_at: "2026-06-01T00:00:00Z",
        risk_level: "high",
        finding_count: 5,
        changed_file_count: 7,
      });
      expect(env.data.markdown).toBe("body");
      expect(env.data.truncated).toBeUndefined();
    }
  });
});

// ============================================================================
// D. D99.U 256 KiB markdown cap
// ============================================================================

describe("explain_diff handler: D99.U markdown cap (256 KiB)", () => {
  it("below cap -> truncated flag absent", async () => {
    const report = makeReport();
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce(markdownResult("# Small\n"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.truncated).toBeUndefined();
      expect(env.data.bytes_omitted).toBeUndefined();
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("above cap -> truncated:true + bytes_omitted, markdown sliced at UTF-8 boundary", async () => {
    const report = makeReport();
    // Build a 300 KiB ASCII body (over the 256 KiB cap).
    const body = "x".repeat(300 * 1024);
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce(markdownResult(body));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true) {
      expect(env.data.truncated).toBe(true);
      expect(env.data.bytes_omitted).toBe(Buffer.byteLength(body, "utf8") - 256 * 1024);
      expect(Buffer.byteLength(env.data.markdown, "utf8")).toBe(256 * 1024);
    }
  });
});

// ============================================================================
// E. Error propagation (JSON call fails)
// ============================================================================

describe("explain_diff handler: failure propagation", () => {
  it("returns harness error from JSON call WITHOUT making markdown call", async () => {
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, exitCode: 1, stderrText: "boom" });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INTERNAL_ERROR");
    // Only one call was made (JSON).
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });

  it("returns harness error from markdown call after JSON succeeded", async () => {
    const report = makeReport();
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, exitCode: 1, stderrText: "md boom" });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
      expect(env.error.message).toContain("md boom");
    }
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Definition smoke
// ============================================================================

describe("explain_diff definition export", () => {
  it("name is 'explain_diff'", () => {
    expect(definition.name).toBe("explain_diff");
  });
  it("inputSchema is non-null object with no cwd-like keys", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    const forbidden = ["cwd", "target_repo", "repo", "directory", "repo_path", "working_directory"];
    for (const k of Object.keys(props)) expect(forbidden).not.toContain(k);
  });
});
