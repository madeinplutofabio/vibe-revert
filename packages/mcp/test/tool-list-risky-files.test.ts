// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for tools/list-risky-files.ts.
//
// Test focus:
//   - input validation (session/report mutex, empty strings, extras)
//   - argv construction
//   - Option B projection:
//     * ChangedFile-only entries (no findings) appear
//     * Finding-only entries (no ChangedFile match) appear
//     * Both ChangedFile + findings for same path -> max(severity)
//     * Multiple evidence entries for same file in same finding ->
//       counted ONCE (per locked direction "do not count evidence rows")
//     * Multiple findings touching same file -> finding_count tallies
//   - Sort order: max_severity DESC, finding_count DESC, path ASC
//   - D99.U 500-entry cap + truncated:true + omitted_count

import type { RunCommandInProcessResult } from "@viberevert/cli-commands";
import type { ChangedFile, CheckResult, ReportFile } from "@viberevert/session-format";
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

const { handler, definition } = await import("../src/tools/list-risky-files.js");
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
  filePaths: readonly (string | undefined)[],
): CheckResult {
  const evidence = filePaths.map((p) =>
    p === undefined ? { detail: "x" } : { detail: "x", file: p },
  );
  const f: CheckResult = {
    id,
    title: `T-${id}`,
    level,
    confidence: "high",
    category: "cat",
    message: "m",
    evidence: evidence.length > 0 ? evidence : [{ detail: "x" }],
  };
  if (level === "high" || level === "critical") {
    return { ...f, recommendation: "do something" };
  }
  return f;
}

function makeChangedFile(path: string, level: "low" | "medium" | "high" | "critical"): ChangedFile {
  return {
    path,
    status: "modified",
    risk_tags: [],
    risk_level: level,
  };
}

function makeReport(
  opts: { changedFiles?: ChangedFile[]; results?: CheckResult[] } = {},
): ReportFile {
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
      changed_files: opts.changedFiles ?? [],
      results: opts.results ?? [],
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

describe("list_risky_files handler: input validation", () => {
  it("rejects session+report mutex", async () => {
    const env = await handler({ session: "s", report: "r" }, { repoRoot: ABS_REPO_ROOT });
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

describe("list_risky_files handler: argv construction", () => {
  it("empty input -> ['report', '--json']", async () => {
    mockedRun.mockResolvedValueOnce(jsonResult(makeReport()));
    await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["report", "--json"]);
  });

  it("--session/--report propagate", async () => {
    mockedRun.mockResolvedValueOnce(jsonResult(makeReport()));
    await handler({ session: "sess_A" }, { repoRoot: ABS_REPO_ROOT });
    expect(mockedRun.mock.calls[0]?.[1]).toEqual(["report", "--json", "--session", "sess_A"]);
  });
});

// ============================================================================
// C. Option B projection
// ============================================================================

describe("list_risky_files handler: Option B projection", () => {
  it("ChangedFile-only entry (no findings) appears with ChangedFile.risk_level and finding_count:0", async () => {
    const report = makeReport({
      changedFiles: [makeChangedFile("a.ts", "high")],
      results: [],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files).toEqual([{ path: "a.ts", max_severity: "high", finding_count: 0 }]);
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("finding-only entry (no matching ChangedFile) appears with finding.level and finding_count:1", async () => {
    const report = makeReport({
      changedFiles: [],
      results: [makeFinding("f1", "medium", ["only-in-evidence.ts"])],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files).toEqual([
        { path: "only-in-evidence.ts", max_severity: "medium", finding_count: 1 },
      ]);
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("ChangedFile + finding for same path: max_severity = max(both)", async () => {
    // ChangedFile says "medium", finding says "critical" -> max is "critical".
    const report = makeReport({
      changedFiles: [makeChangedFile("x.ts", "medium")],
      results: [makeFinding("f1", "critical", ["x.ts"])],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files).toEqual([
        { path: "x.ts", max_severity: "critical", finding_count: 1 },
      ]);
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("ChangedFile severity wins when greater than finding levels", async () => {
    const report = makeReport({
      changedFiles: [makeChangedFile("y.ts", "critical")],
      results: [makeFinding("f1", "low", ["y.ts"])],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files[0]?.max_severity).toBe("critical");
    }
  });

  it("DOES NOT count evidence rows: a finding with 3 evidence entries pointing to same file counts ONCE", async () => {
    // A single finding with 3 evidence entries all pointing to "a.ts".
    const finding = makeFinding("f1", "high", ["a.ts", "a.ts", "a.ts"]);
    const report = makeReport({ changedFiles: [], results: [finding] });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files).toEqual([{ path: "a.ts", max_severity: "high", finding_count: 1 }]);
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("DOES count distinct findings: 3 separate findings pointing to same file -> finding_count:3", async () => {
    const report = makeReport({
      changedFiles: [],
      results: [
        makeFinding("f1", "low", ["a.ts"]),
        makeFinding("f2", "medium", ["a.ts"]),
        makeFinding("f3", "high", ["a.ts"]),
      ],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files).toEqual([{ path: "a.ts", max_severity: "high", finding_count: 3 }]);
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("a finding pointing to multiple distinct files counts ONCE per file", async () => {
    const report = makeReport({
      changedFiles: [],
      results: [makeFinding("f1", "high", ["a.ts", "b.ts"])],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      // Both files get finding_count:1 from this single finding.
      expect(env.data.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
      expect(env.data.files.every((f) => f.finding_count === 1)).toBe(true);
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("findings with no evidence file (only detail) are excluded from per-file aggregation", async () => {
    const report = makeReport({
      changedFiles: [makeChangedFile("a.ts", "low")],
      results: [makeFinding("f1", "critical", [undefined])], // evidence has no file
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      // a.ts only gets ChangedFile contribution. The critical finding
      // does NOT bump it because evidence had no file path.
      expect(env.data.files).toEqual([{ path: "a.ts", max_severity: "low", finding_count: 0 }]);
    } else {
      throw new Error("expected ok:true");
    }
  });
});

// ============================================================================
// D. Sort order
// ============================================================================

describe("list_risky_files handler: sort order", () => {
  it("sorts by [max_severity DESC, finding_count DESC, path ASC]", async () => {
    const report = makeReport({
      changedFiles: [
        makeChangedFile("a-low.ts", "low"),
        makeChangedFile("b-medium.ts", "medium"),
        makeChangedFile("c-high.ts", "high"),
        makeChangedFile("d-critical.ts", "critical"),
      ],
      results: [],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files.map((f) => f.path)).toEqual([
        "d-critical.ts",
        "c-high.ts",
        "b-medium.ts",
        "a-low.ts",
      ]);
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("tie-breaks at same severity by finding_count DESC", async () => {
    const report = makeReport({
      changedFiles: [makeChangedFile("a.ts", "high"), makeChangedFile("b.ts", "high")],
      results: [
        // 3 findings on b.ts, 1 finding on a.ts
        makeFinding("f1", "high", ["b.ts"]),
        makeFinding("f2", "high", ["b.ts"]),
        makeFinding("f3", "high", ["b.ts"]),
        makeFinding("f4", "high", ["a.ts"]),
      ],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      // b.ts (3 findings) before a.ts (1 finding) despite same severity.
      expect(env.data.files.map((f) => f.path)).toEqual(["b.ts", "a.ts"]);
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("tie-breaks at same severity + same finding_count by path ASC", async () => {
    const report = makeReport({
      changedFiles: [
        makeChangedFile("z.ts", "high"),
        makeChangedFile("a.ts", "high"),
        makeChangedFile("m.ts", "high"),
      ],
      results: [],
    });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files.map((f) => f.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
    } else {
      throw new Error("expected ok:true");
    }
  });
});

// ============================================================================
// E. D99.U 500-entry cap
// ============================================================================

describe("list_risky_files handler: D99.U 500-entry cap", () => {
  it("at exactly 500 entries -> no truncation", async () => {
    const changedFiles = Array.from({ length: 500 }, (_, i) =>
      makeChangedFile(`f${String(i).padStart(4, "0")}.ts`, "low"),
    );
    const report = makeReport({ changedFiles, results: [] });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files.length).toBe(500);
      expect(env.data.truncated).toBeUndefined();
      expect(env.data.omitted_count).toBeUndefined();
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("above 500 -> slice(0, 500) + truncated:true + omitted_count", async () => {
    // Build N > 500 paths via ChangedFile.
    // Note: ReportFile's results array has noise budget caps but
    // changed_files does NOT, so we can safely exceed 500 here.
    const changedFiles = Array.from({ length: 600 }, (_, i) =>
      makeChangedFile(`f${String(i).padStart(4, "0")}.ts`, "low"),
    );
    const report = makeReport({ changedFiles, results: [] });
    mockedRun.mockResolvedValueOnce(jsonResult(report));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true) {
      expect(env.data.files.length).toBe(500);
      expect(env.data.truncated).toBe(true);
      expect(env.data.omitted_count).toBe(100);
    } else {
      throw new Error("expected ok:true");
    }
  });
});

// ============================================================================
// Definition smoke
// ============================================================================

describe("list_risky_files definition export", () => {
  it("name is 'list_risky_files'", () => {
    expect(definition.name).toBe("list_risky_files");
  });
  it("inputSchema has no cwd-like keys", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    const forbidden = ["cwd", "target_repo", "repo", "directory", "repo_path", "working_directory"];
    for (const k of Object.keys(props)) expect(forbidden).not.toContain(k);
  });
});
