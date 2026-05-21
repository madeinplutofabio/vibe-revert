// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/reporters/src/json.ts
// (Step 8 Phase C file 14).
//
// renderJson is a thin delegator around applyThreshold (which has
// its own dedicated test file). These tests focus on the renderJson-
// specific concerns:
//
//   1. NO-OP DELEGATE — without threshold (or with "low"), returns
//      the input ReportFile reference (same as applyThreshold's
//      no-op short-circuit).
//
//   2. THRESHOLD DELEGATE — with threshold > "low", returns a new
//      filtered ReportFile-shaped value (same as applyThreshold's
//      filter path).
//
//   3. JSON-STRINGIFY-ABLE — the returned value round-trips through
//      JSON.stringify/parse cleanly (no circular refs, no
//      unrepresentable values, no Symbols/Maps/Sets/functions).
//
//   4. SCHEMA-VERBATIM OPTIONAL OMISSION (D38 exception to D20) —
//      optional ReportFile and SessionReport fields ABSENT in the
//      input remain absent in the JSON output, NOT rewritten to
//      null. JSON.stringify naturally omits undefined keys; the
//      test locks the behavior.
//
//   5. productVersion IGNORED — renderJson does not consume
//      `input.productVersion`. Two inputs that differ only by
//      productVersion produce structurally-identical output.

import type { CheckResult, ReportFile, RiskLevel, SessionReport } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import type { RenderInput } from "../src/index.js";
import { renderJson } from "../src/json.js";

// =============================================================================
// Test fixture helpers (per-file duplication intentional, matching the
// checks-package test convention; each reporter test file owns its own
// fixtures rather than depending on a shared helpers module)
// =============================================================================

const VALID_ULID = "01ABCDEFGHJKMNPQRSTVWXYZ23";
const SESSION_ID = `sess_${VALID_ULID}`;

function makeResult(opts: {
  level: RiskLevel;
  category?: string;
  id?: string;
  recommendation?: string;
}): CheckResult {
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
    changed_files: [],
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

function makeRenderInput(opts: {
  file: ReportFile;
  threshold?: RiskLevel;
  productVersion?: string;
}): RenderInput {
  const base = { file: opts.file, productVersion: opts.productVersion ?? "0.7.0-beta" };
  return opts.threshold === undefined ? base : { ...base, threshold: opts.threshold };
}

// =============================================================================
// SECTION 1: no-op delegate
// =============================================================================

describe("renderJson — no-op delegate", () => {
  it("threshold undefined → returns input file reference", () => {
    const file = makeReportFile({ results: [makeResult({ level: "high" })], riskLevel: "high" });
    const output = renderJson(makeRenderInput({ file }));
    expect(output).toBe(file);
  });

  it("threshold 'low' → returns input file reference", () => {
    const file = makeReportFile({ results: [makeResult({ level: "high" })], riskLevel: "high" });
    const output = renderJson(makeRenderInput({ file, threshold: "low" }));
    expect(output).toBe(file);
  });
});

// =============================================================================
// SECTION 2: threshold delegate
// =============================================================================

describe("renderJson — threshold delegate", () => {
  it("threshold > 'low' → returns a NEW filtered ReportFile (not the input reference)", () => {
    const file = makeReportFile({
      results: [makeResult({ level: "low" }), makeResult({ level: "high" })],
      riskLevel: "high",
    });
    const output = renderJson(makeRenderInput({ file, threshold: "high" }));
    expect(output).not.toBe(file);
    const view = output as ReportFile;
    expect(view.report.results).toHaveLength(1);
    expect(view.report.results[0]?.level).toBe("high");
  });
});

// =============================================================================
// SECTION 3: JSON-stringify-able
// =============================================================================

describe("renderJson — JSON-stringify-able", () => {
  it("returned value round-trips cleanly through JSON.stringify/parse", () => {
    const file = makeReportFile({
      results: [makeResult({ level: "high", category: "auth" })],
      summary: "1 findings: auth (1)",
      riskLevel: "high",
      task: "Fix auth flow",
    });
    const output = renderJson(makeRenderInput({ file }));
    const parsed = JSON.parse(JSON.stringify(output)) as ReportFile;
    expect(parsed).toEqual(file);
  });
});

// =============================================================================
// SECTION 4: schema-verbatim optional omission (D38 exception to D20)
// =============================================================================

describe("renderJson — schema-verbatim optional omission", () => {
  it("optional fields ABSENT in input remain absent after JSON.stringify (no null rewrites)", () => {
    // Build a ReportFile with NO optional fields set: no staged_only,
    // no task, no summary, no ended_at, no checkpoint_id, no
    // agent_command. After JSON round-trip, those keys must NOT
    // appear in the parsed output (with `null` or otherwise).
    const file = makeReportFile({ results: [] });
    const output = renderJson(makeRenderInput({ file }));
    const parsed = JSON.parse(JSON.stringify(output)) as Record<string, unknown> & {
      report: Record<string, unknown>;
    };
    expect("staged_only" in parsed).toBe(false);
    expect("task" in parsed.report).toBe(false);
    expect("summary" in parsed.report).toBe(false);
    expect("ended_at" in parsed.report).toBe(false);
    expect("checkpoint_id" in parsed.report).toBe(false);
    expect("agent_command" in parsed.report).toBe(false);
  });

  it("optional fields PRESENT in input survive JSON round-trip with their values", () => {
    const file = makeReportFile({
      results: [makeResult({ level: "high" })],
      summary: "1 findings: test (1)",
      task: "Fix the flow",
      riskLevel: "high",
    });
    const output = renderJson(makeRenderInput({ file }));
    const parsed = JSON.parse(JSON.stringify(output)) as ReportFile;
    expect(parsed.report.summary).toBe("1 findings: test (1)");
    expect(parsed.report.task).toBe("Fix the flow");
  });
});

// =============================================================================
// SECTION 5: productVersion ignored
// =============================================================================

describe("renderJson — productVersion ignored", () => {
  it("two inputs differing only by productVersion produce structurally-identical output", () => {
    const file = makeReportFile({
      results: [makeResult({ level: "high" })],
      riskLevel: "high",
    });
    const a = renderJson(makeRenderInput({ file, productVersion: "0.7.0-beta" }));
    const b = renderJson(makeRenderInput({ file, productVersion: "999.999.999-fake" }));
    // Both are no-op short-circuit returns of `file` → reference equal too,
    // but the locked invariant is STRUCTURAL identity (productVersion not
    // consumed by renderJson).
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
