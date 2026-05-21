// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/reporters/src/threshold.ts
// (Step 8 Phase C file 13).
//
// Coverage strategy:
//
//   1. NO-OP SHORT-CIRCUIT — when threshold is undefined OR "low"
//      (the floor of RiskLevel), applyThreshold returns the input
//      reference unchanged (no allocation).
//
//   2. FILTER BY LEVEL — results below threshold are dropped per
//      compareLevel. Findings AT threshold survive.
//
//   3. RECOMPUTE risk_level (D52) — filtered set's max via
//      compareLevel, or "low" when empty.
//
//   4. RECOMPUTE summary (D53) — "N findings: cat1 (n1), ..." with
//      ASCII-asc category sort. OMITTED when filtered results
//      empty. Original summary REPLACED by recomputed value.
//
//   5. CHANGED_FILES PRESERVATION — never filtered by threshold per
//      D38 (diff inventory contract); reference identity preserved.
//
//   6. PURITY — applyThreshold never mutates input. Wrapper fields
//      (kind, report_id, since_*, written_at, etc.) and SessionReport
//      fields other than results/risk_level/summary are preserved.

import type {
  ChangedFile,
  CheckResult,
  ReportFile,
  RiskLevel,
  SessionReport,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { applyThreshold } from "../src/threshold.js";

// =============================================================================
// Test fixture helpers
// =============================================================================

// 26-char Crockford-base32 ULID body (no I, L, O, U). Schema-valid.
const VALID_ULID = "01ABCDEFGHJKMNPQRSTVWXYZ23";
const SESSION_ID = `sess_${VALID_ULID}`;

function makeResult(opts: {
  level: RiskLevel;
  category?: string;
  id?: string;
  recommendation?: string;
}): CheckResult {
  // CheckResultSchema requires non-blank recommendation for
  // high/critical findings; auto-provide one when caller omits.
  const requiresReco = opts.level === "high" || opts.level === "critical";
  const reco = opts.recommendation ?? (requiresReco ? "Test recommendation." : undefined);
  const base = {
    id: opts.id ?? "test.id",
    category: opts.category ?? "test",
    level: opts.level,
    confidence: "medium" as const,
    title: "Test title",
    message: "Test message",
    evidence: [{ detail: "test detail" }],
  };
  return reco === undefined ? base : { ...base, recommendation: reco };
}

function makeReportFile(
  opts: {
    results?: readonly CheckResult[];
    summary?: string;
    riskLevel?: RiskLevel;
    changedFiles?: readonly ChangedFile[];
    task?: string;
  } = {},
): ReportFile {
  const reportBase: SessionReport = {
    schema_version: "1.0",
    session_id: SESSION_ID,
    started_at: "2026-01-01T00:00:00Z",
    detected_frameworks: [],
    risk_level: opts.riskLevel ?? "low",
    results: [...(opts.results ?? [])],
    changed_files: [...(opts.changedFiles ?? [])],
    rollback_available: true,
  };
  const report: SessionReport = {
    ...reportBase,
    ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
    ...(opts.task !== undefined ? { task: opts.task } : {}),
  };
  return {
    schema_version: "1.0",
    kind: "session_bound",
    report_id: SESSION_ID,
    since_kind: "session_id",
    since_ref: SESSION_ID,
    since_resolved_sha: "0000000000000000000000000000000000000000",
    written_at: "2026-01-01T00:00:00Z",
    report,
  };
}

// =============================================================================
// SECTION 1: no-op short-circuit
// =============================================================================

describe("applyThreshold — no-op short-circuit", () => {
  it("threshold undefined → returns input reference unchanged", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "high" })],
      riskLevel: "high",
    });
    const output = applyThreshold(input);
    expect(output).toBe(input);
  });

  it("threshold 'low' → returns input reference unchanged", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "high" })],
      riskLevel: "high",
    });
    const output = applyThreshold(input, "low");
    expect(output).toBe(input);
  });

  it("threshold 'low' on empty results → returns input reference unchanged", () => {
    const input = makeReportFile();
    const output = applyThreshold(input, "low");
    expect(output).toBe(input);
  });
});

// =============================================================================
// SECTION 2: filter results by level
// =============================================================================

describe("applyThreshold — filter results by level", () => {
  it("threshold 'medium' drops 'low', keeps 'medium'/'high'/'critical'", () => {
    const input = makeReportFile({
      results: [
        makeResult({ level: "low", id: "a.low" }),
        makeResult({ level: "medium", id: "a.medium" }),
        makeResult({ level: "high", id: "a.high" }),
        makeResult({ level: "critical", id: "a.critical" }),
      ],
      riskLevel: "critical",
    });
    const output = applyThreshold(input, "medium");
    const ids = output.report.results.map((r) => r.id).sort();
    expect(ids).toEqual(["a.critical", "a.high", "a.medium"]);
  });

  it("threshold 'high' drops 'low'/'medium', keeps 'high'/'critical'", () => {
    const input = makeReportFile({
      results: [
        makeResult({ level: "low" }),
        makeResult({ level: "medium" }),
        makeResult({ level: "high", id: "h" }),
        makeResult({ level: "critical", id: "c" }),
      ],
      riskLevel: "critical",
    });
    const output = applyThreshold(input, "high");
    const ids = output.report.results.map((r) => r.id).sort();
    expect(ids).toEqual(["c", "h"]);
  });

  it("threshold 'critical' keeps only 'critical' findings", () => {
    const input = makeReportFile({
      results: [
        makeResult({ level: "low" }),
        makeResult({ level: "medium" }),
        makeResult({ level: "high" }),
        makeResult({ level: "critical", id: "c" }),
      ],
      riskLevel: "critical",
    });
    const output = applyThreshold(input, "critical");
    expect(output.report.results).toHaveLength(1);
    expect(output.report.results[0]?.id).toBe("c");
  });

  it("threshold 'high' with no high+ findings → empty results", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "low" }), makeResult({ level: "medium" })],
      riskLevel: "medium",
    });
    const output = applyThreshold(input, "high");
    expect(output.report.results).toEqual([]);
  });
});

// =============================================================================
// SECTION 3: recompute risk_level (D52)
// =============================================================================

describe("applyThreshold — recompute risk_level (D52)", () => {
  it("filtered set contains 'critical' → risk_level: 'critical'", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "low" }), makeResult({ level: "critical" })],
      riskLevel: "critical",
    });
    const output = applyThreshold(input, "high");
    expect(output.report.risk_level).toBe("critical");
  });

  it("filtered set max is 'medium' → risk_level: 'medium'", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "low" }), makeResult({ level: "medium" })],
      riskLevel: "medium",
    });
    const output = applyThreshold(input, "medium");
    expect(output.report.risk_level).toBe("medium");
  });

  it("filtered set empty → risk_level: 'low' (floor)", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "low" }), makeResult({ level: "medium" })],
      riskLevel: "medium",
    });
    const output = applyThreshold(input, "critical");
    expect(output.report.risk_level).toBe("low");
  });
});

// =============================================================================
// SECTION 4: recompute summary (D53)
// =============================================================================

describe("applyThreshold — recompute summary (D53)", () => {
  it("filtered set non-empty → summary recomputed with ASCII-asc category breakdown", () => {
    const input = makeReportFile({
      results: [
        makeResult({ level: "high", category: "payments", id: "p1" }),
        makeResult({ level: "high", category: "auth", id: "a1" }),
        makeResult({ level: "high", category: "payments", id: "p2" }),
        makeResult({ level: "high", category: "database", id: "d1" }),
      ],
      riskLevel: "high",
    });
    const output = applyThreshold(input, "high");
    expect(output.report.summary).toBe("4 findings: auth (1), database (1), payments (2)");
  });

  it("filtered set empty → summary OMITTED from output (present-iff-defined)", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "low" })],
      summary: "1 findings: test (1)",
      riskLevel: "low",
    });
    const output = applyThreshold(input, "high");
    expect(output.report.summary).toBeUndefined();
    expect("summary" in output.report).toBe(false);
  });

  it("single finding → summary uses 'N findings:' plural form (D53 locked)", () => {
    // D53 locks the format as `"<N> findings:"` always — plural form
    // even for N=1. Slight grammatical wart, but deterministic and
    // testable; an amendment would require revisiting D53.
    const input = makeReportFile({
      results: [makeResult({ level: "high", category: "auth" })],
      riskLevel: "high",
    });
    const output = applyThreshold(input, "high");
    expect(output.report.summary).toBe("1 findings: auth (1)");
  });

  it("original summary is REPLACED by recomputed summary", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "low" }), makeResult({ level: "high", category: "auth" })],
      summary: "ORIGINAL SUMMARY",
      riskLevel: "high",
    });
    const output = applyThreshold(input, "high");
    expect(output.report.summary).toBe("1 findings: auth (1)");
  });
});

// =============================================================================
// SECTION 5: changed_files preservation (D38 inventory contract)
// =============================================================================

describe("applyThreshold — changed_files preservation", () => {
  it("threshold filtering does NOT touch changed_files (preserves reference)", () => {
    const cf: ChangedFile = {
      path: "src/foo.ts",
      status: "modified",
      risk_tags: ["middleware"],
      risk_level: "high",
    };
    const input = makeReportFile({
      results: [makeResult({ level: "low" })],
      changedFiles: [cf],
    });
    const output = applyThreshold(input, "critical");
    expect(output.report.changed_files).toBe(input.report.changed_files);
  });
});

// =============================================================================
// SECTION 6: purity (no mutation of input)
// =============================================================================

describe("applyThreshold — purity", () => {
  it("does not mutate the input ReportFile", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "low", id: "a" }), makeResult({ level: "high", id: "b" })],
      summary: "ORIGINAL",
      riskLevel: "high",
    });
    applyThreshold(input, "high");
    expect(input.report.results).toHaveLength(2);
    expect(input.report.risk_level).toBe("high");
    expect(input.report.summary).toBe("ORIGINAL");
  });
});

// =============================================================================
// SECTION 7: wrapper + non-filtered SessionReport fields preserved
// =============================================================================

describe("applyThreshold — wrapper and non-filtered fields preserved", () => {
  it("wrapper fields and SessionReport fields other than results/risk_level/summary preserved", () => {
    const input = makeReportFile({
      results: [makeResult({ level: "high" })],
      riskLevel: "high",
      task: "Fix auth flow",
    });
    const output = applyThreshold(input, "high");
    // Wrapper fields
    expect(output.kind).toBe(input.kind);
    expect(output.report_id).toBe(input.report_id);
    expect(output.since_kind).toBe(input.since_kind);
    expect(output.since_ref).toBe(input.since_ref);
    expect(output.since_resolved_sha).toBe(input.since_resolved_sha);
    expect(output.written_at).toBe(input.written_at);
    expect(output.schema_version).toBe(input.schema_version);
    // SessionReport fields other than results/risk_level/summary
    expect(output.report.session_id).toBe(input.report.session_id);
    expect(output.report.started_at).toBe(input.report.started_at);
    expect(output.report.detected_frameworks).toBe(input.report.detected_frameworks);
    expect(output.report.task).toBe("Fix auth flow");
  });
});
