// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for tools/classify-risk.ts.
//
// Test focus:
//   - input validation (session/report mutex, empty strings, extras)
//   - argv construction
//   - severity counts projection across all 4 levels
//   - empty results -> {critical:0, high:0, medium:0, low:0}

import type { RunCommandInProcessResult } from "@viberevert/cli-commands";
import type { CheckResult, ReportFile } from "@viberevert/session-format";
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

const { handler, definition } = await import("../src/tools/classify-risk.js");
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

function makeFinding(
  id: string,
  level: "low" | "medium" | "high" | "critical",
  category = "cat",
): CheckResult {
  const f: CheckResult = {
    id,
    title: `T-${id}`,
    level,
    confidence: "high",
    category,
    message: "m",
    evidence: [{ detail: "x" }],
  };
  if (level === "high" || level === "critical") {
    return { ...f, recommendation: "do something" };
  }
  return f;
}

function makeReport(results: CheckResult[]): ReportFile {
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
      risk_level: results.length > 0 ? results[0]!.level : "low",
      changed_files: [],
      results,
      rollback_available: false,
    },
  };
}

function jsonResult(report: ReportFile): RunCommandInProcessResult {
  return { ...BASE_RESULT, stdoutBytes: Buffer.from(JSON.stringify(report), "utf8") };
}

beforeEach(() => {
  mockedRun.mockReset();
});

// ============================================================================
// A. Input validation
// ============================================================================

describe("classify_risk handler: input validation", () => {
  it("rejects session+report mutex", async () => {
    const env = await handler({ session: "s", report: "r" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INVALID_TOOL_INPUT");
  });

  it("rejects empty-string report", async () => {
    const env = await handler({ report: "" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INVALID_TOOL_INPUT");
  });

  it("rejects extra key", async () => {
    const env = await handler({ threshold: "low" }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INVALID_TOOL_INPUT");
  });
});

// ============================================================================
// B. Argv construction
// ============================================================================

describe("classify_risk handler: argv construction", () => {
  it("empty input -> ['report', '--json']", async () => {
    mockedRun.mockResolvedValueOnce(jsonResult(makeReport([])));
    await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["report", "--json"]);
  });

  it("--session -> ['report', '--json', '--session', X]", async () => {
    mockedRun.mockResolvedValueOnce(jsonResult(makeReport([])));
    await handler({ session: "sess_X" }, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["report", "--json", "--session", "sess_X"]);
  });

  it("--report -> ['report', '--json', '--report', X]", async () => {
    mockedRun.mockResolvedValueOnce(jsonResult(makeReport([])));
    await handler({ report: "rpt_Y" }, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["report", "--json", "--report", "rpt_Y"]);
  });
});

// ============================================================================
// C. Severity-count projection
// ============================================================================

describe("classify_risk handler: severity projection", () => {
  it("empty results -> all zeros", async () => {
    mockedRun.mockResolvedValueOnce(jsonResult(makeReport([])));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true) {
      expect(env.data).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    }
  });

  it("mixed levels are counted per-bucket", async () => {
    const results = [
      makeFinding("a", "critical"),
      makeFinding("b", "critical"),
      makeFinding("c", "high"),
      makeFinding("d", "medium"),
      makeFinding("e", "medium"),
      makeFinding("f", "medium"),
      makeFinding("g", "low"),
    ];
    mockedRun.mockResolvedValueOnce(jsonResult(makeReport(results)));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true) {
      expect(env.data).toEqual({ critical: 2, high: 1, medium: 3, low: 1 });
    }
  });

  it("counts ALL findings (does NOT filter by threshold; no threshold input)", async () => {
    const results = [makeFinding("a", "low"), makeFinding("b", "critical")];
    mockedRun.mockResolvedValueOnce(jsonResult(makeReport(results)));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data).toEqual({ critical: 1, high: 0, medium: 0, low: 1 });
    }
  });
});

// ============================================================================
// Definition smoke
// ============================================================================

describe("classify_risk definition export", () => {
  it("name is 'classify_risk'", () => {
    expect(definition.name).toBe("classify_risk");
  });
  it("inputSchema does NOT declare a threshold field", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).not.toContain("threshold");
  });
  it("inputSchema has no cwd-like keys", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    const forbidden = ["cwd", "target_repo", "repo", "directory", "repo_path", "working_directory"];
    for (const k of Object.keys(props)) expect(forbidden).not.toContain(k);
  });
});
