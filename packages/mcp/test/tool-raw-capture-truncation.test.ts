// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// D99.W handler policy + R26 mitigation: when runCommandInProcess
// returns stdoutTruncated:true, the handler MUST return
// MCP_COMMAND_OUTPUT_TOO_LARGE WITHOUT parsing the truncated bytes.
// Parsing truncated JSON could succeed and produce a fake-looking
// smaller-than-real summary that misleads the consumer.
//
// Covers all four command-harness tools landed through Slice 3.4:
//   - check_repo (CheckCommand)        -- JSON parser
//   - explain_diff (ReportCommand)     -- JSON FIRST, then markdown
//   - classify_risk (ReportCommand)    -- JSON parser
//   - list_risky_files (ReportCommand) -- JSON parser

import type { RunCommandInProcessResult } from "@viberevert/cli-commands";
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

const checkRepo = await import("../src/tools/check-repo.js");
const explainDiff = await import("../src/tools/explain-diff.js");
const classifyRisk = await import("../src/tools/classify-risk.js");
const listRiskyFiles = await import("../src/tools/list-risky-files.js");
const cliCommands = await import("@viberevert/cli-commands");
const mockedRun = vi.mocked(cliCommands.runCommandInProcess);

const ABS_REPO_ROOT = "/abs/repo";

function makeTruncatedResult(
  stdoutText: string,
  bytesOmitted = 5 * 1024 * 1024,
): RunCommandInProcessResult {
  return {
    exitCode: 0,
    stdoutBytes: Buffer.from(stdoutText, "utf8"),
    stderrText: "",
    stdoutTruncated: true,
    stdoutBytesOmitted: bytesOmitted,
    stderrTruncated: false,
    stderrBytesOmitted: 0,
  };
}

beforeEach(() => {
  mockedRun.mockReset();
});

// ============================================================================
// check_repo
// ============================================================================

describe("check_repo D99.W: stdoutTruncated -> MCP_COMMAND_OUTPUT_TOO_LARGE", () => {
  it("returns MCP_COMMAND_OUTPUT_TOO_LARGE envelope when stdoutTruncated is true", async () => {
    mockedRun.mockResolvedValueOnce(makeTruncatedResult('{"schema_version":"1.0","kind":"ad_hoc"'));
    const env = await checkRepo.handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
      expect(env.error.details).toBeDefined();
    }
  });

  it("does NOT attempt to parse truncated bytes even if they happen to parse", async () => {
    const truncatedButParseable = JSON.stringify({ schema_version: "1.0" });
    mockedRun.mockResolvedValueOnce(makeTruncatedResult(truncatedButParseable, 1024));
    const env = await checkRepo.handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === false) {
      expect(env.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
    }
  });
});

// ============================================================================
// explain_diff
// ============================================================================

describe("explain_diff D99.W: stdoutTruncated -> MCP_COMMAND_OUTPUT_TOO_LARGE", () => {
  it("JSON call truncated -> MCP_COMMAND_OUTPUT_TOO_LARGE; markdown call never made", async () => {
    mockedRun.mockResolvedValueOnce(makeTruncatedResult("{"));
    const env = await explainDiff.handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
    }
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });

  it("markdown call truncated -> MCP_COMMAND_OUTPUT_TOO_LARGE after JSON succeeded", async () => {
    // First call: JSON success.
    const validReport = {
      schema_version: "1.0" as const,
      kind: "ad_hoc" as const,
      report_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
      since_kind: "git_ref" as const,
      since_ref: "HEAD",
      since_resolved_sha: "abc1234567890abc1234567890abc1234567890",
      written_at: "2026-06-01T00:00:00Z",
      report: {
        schema_version: "1.0" as const,
        session_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
        started_at: "2026-06-01T00:00:00Z",
        detected_frameworks: [],
        risk_level: "low" as const,
        changed_files: [],
        results: [],
        rollback_available: false,
      },
    };
    mockedRun.mockResolvedValueOnce({
      exitCode: 0,
      stdoutBytes: Buffer.from(JSON.stringify(validReport), "utf8"),
      stderrText: "",
      stdoutTruncated: false,
      stdoutBytesOmitted: 0,
      stderrTruncated: false,
      stderrBytesOmitted: 0,
    });
    // Second call: markdown truncated.
    mockedRun.mockResolvedValueOnce(makeTruncatedResult("# Partial markdown..."));
    const env = await explainDiff.handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
    }
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// classify_risk
// ============================================================================

describe("classify_risk D99.W: stdoutTruncated -> MCP_COMMAND_OUTPUT_TOO_LARGE", () => {
  it("returns MCP_COMMAND_OUTPUT_TOO_LARGE envelope when stdoutTruncated is true", async () => {
    mockedRun.mockResolvedValueOnce(makeTruncatedResult("{"));
    const env = await classifyRisk.handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
    }
  });
});

// ============================================================================
// list_risky_files
// ============================================================================

describe("list_risky_files D99.W: stdoutTruncated -> MCP_COMMAND_OUTPUT_TOO_LARGE", () => {
  it("returns MCP_COMMAND_OUTPUT_TOO_LARGE envelope when stdoutTruncated is true", async () => {
    mockedRun.mockResolvedValueOnce(makeTruncatedResult("{"));
    const env = await listRiskyFiles.handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
    }
  });

  it("does NOT attempt projection from truncated bytes even if they happen to parse", async () => {
    const truncatedButParseable = JSON.stringify({ schema_version: "1.0" });
    mockedRun.mockResolvedValueOnce(makeTruncatedResult(truncatedButParseable, 1024));
    const env = await listRiskyFiles.handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === false) {
      expect(env.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
    }
  });
});

// ============================================================================
// stderr-only truncation does NOT fail any tool
// ============================================================================

describe("stderr-only truncation does NOT fail any tool", () => {
  const validReport = {
    schema_version: "1.0" as const,
    kind: "ad_hoc" as const,
    report_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
    since_kind: "git_ref" as const,
    since_ref: "HEAD",
    since_resolved_sha: "abc1234567890abc1234567890abc1234567890",
    written_at: "2026-06-01T00:00:00Z",
    report: {
      schema_version: "1.0" as const,
      session_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
      started_at: "2026-06-01T00:00:00Z",
      detected_frameworks: [],
      risk_level: "low" as const,
      changed_files: [],
      results: [],
      rollback_available: false,
    },
  };

  function stderrTruncatedJsonResult(): RunCommandInProcessResult {
    return {
      exitCode: 0,
      stdoutBytes: Buffer.from(JSON.stringify(validReport), "utf8"),
      stderrText: "x".repeat(100),
      stdoutTruncated: false,
      stdoutBytesOmitted: 0,
      stderrTruncated: true,
      stderrBytesOmitted: 4096,
    };
  }

  it("check_repo still succeeds when only stderr was truncated", async () => {
    mockedRun.mockResolvedValueOnce(stderrTruncatedJsonResult());
    const env = await checkRepo.handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
  });

  it("classify_risk still succeeds when only stderr was truncated", async () => {
    mockedRun.mockResolvedValueOnce(stderrTruncatedJsonResult());
    const env = await classifyRisk.handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
  });

  it("list_risky_files still succeeds when only stderr was truncated", async () => {
    mockedRun.mockResolvedValueOnce(stderrTruncatedJsonResult());
    const env = await listRiskyFiles.handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
  });
});
