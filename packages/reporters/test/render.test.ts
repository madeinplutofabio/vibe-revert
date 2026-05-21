// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/reporters/src/render.ts
// (Step 8 Phase C file 17 — the dispatcher).
//
// render() is a per-format dispatcher with 4 overloads (3 literal +
// 1 union). Each call routes to renderJson / renderTerminal /
// renderMarkdown based on the format. Each per-format renderer is
// tested in its own dedicated file (json.test.ts, terminal.test.ts,
// markdown.test.ts); these tests focus on the dispatcher-specific
// concerns:
//
//   1. ROUTING — each format produces output identifiable as coming
//      from the right per-format renderer (terminal: 80-char rule
//      header; markdown: H1; json: ReportFile-shaped value).
//
//   2. EXHAUSTIVENESS DEFENSE — passing an invalid format value
//      (untyped JS path) throws cleanly via the `never` default
//      branch's runtime guard.
//
//   3. THRESHOLD PASS-THROUGH — input.threshold is forwarded to
//      every per-format renderer.
//
//   4. productVersion PASS-THROUGH — input.productVersion is
//      forwarded; markdown consumes it for the footer, terminal
//      and json ignore it (per the per-renderer contracts).
//
// Tests deliberately AVOID `as string` casts on render(..., "terminal")
// and render(..., "markdown") calls. The literal overloads in
// render.ts narrow the return to `string` at the type level; if a
// future refactor widened those overloads to `unknown`, the
// .toContain assertions on string methods would fail to type-check
// and the tests would catch the regression at compile time. The
// `as ReportFile` cast on the "json" path IS needed because the
// json overload intentionally returns `unknown` for caller
// flexibility.

import type { CheckResult, ReportFile, RiskLevel, SessionReport } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import type { RenderInput, ReporterFormat } from "../src/index.js";
import { render } from "../src/render.js";

// =============================================================================
// Test fixture helpers
// =============================================================================

const VALID_ULID = "01ABCDEFGHJKMNPQRSTVWXYZ23";
const SESSION_ID = `sess_${VALID_ULID}`;

function makeResult(opts: {
  level: RiskLevel;
  category?: string;
  id?: string;
  title?: string;
  recommendation?: string;
}): CheckResult {
  const requiresReco = opts.level === "high" || opts.level === "critical";
  const reco = opts.recommendation ?? (requiresReco ? "Test recommendation." : undefined);
  const base = {
    id: opts.id ?? "test.id",
    category: opts.category ?? "test",
    level: opts.level,
    confidence: "medium" as const,
    title: opts.title ?? "Test title",
    message: "Test message",
    evidence: [{ detail: "test detail" }],
  };
  return reco === undefined ? base : { ...base, recommendation: reco };
}

function makeReportFile(
  opts: { results?: readonly CheckResult[]; riskLevel?: RiskLevel } = {},
): ReportFile {
  const report: SessionReport = {
    schema_version: "1.0",
    session_id: SESSION_ID,
    started_at: "2026-01-01T00:00:00Z",
    detected_frameworks: [],
    risk_level: opts.riskLevel ?? "low",
    results: [...(opts.results ?? [])],
    changed_files: [],
    rollback_available: true,
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
// SECTION 1: routing
// =============================================================================

describe("render — routing", () => {
  it("'terminal' routes to renderTerminal (output contains 80-char '=' rule + header)", () => {
    // Literal "terminal" overload narrows return to `string` — no cast.
    const output = render(makeRenderInput({ file: makeReportFile() }), "terminal");
    expect(typeof output).toBe("string");
    expect(output).toContain("=".repeat(80));
    expect(output).toContain("VibeRevert Report");
    expect(output).toContain("Report ID:");
  });

  it("'markdown' routes to renderMarkdown (output contains H1 + locked footer)", () => {
    // Literal "markdown" overload narrows return to `string` — no cast.
    const output = render(makeRenderInput({ file: makeReportFile() }), "markdown");
    expect(typeof output).toBe("string");
    expect(output).toContain("# VibeRevert Report");
    expect(output).toContain("## Summary");
    expect(output).toContain("Generated by VibeRevert v");
  });

  it("'json' routes to renderJson (output is a ReportFile-shaped value, not a string)", () => {
    const file = makeReportFile();
    const output = render(makeRenderInput({ file }), "json");
    expect(typeof output).toBe("object");
    expect(output).toBe(file); // no-op short-circuit returns the input file reference
  });
});

// =============================================================================
// SECTION 2: exhaustiveness defense
// =============================================================================

describe("render — exhaustiveness defense", () => {
  it("throws cleanly when format is an invalid value (untyped JS / runtime defense)", () => {
    const input = makeRenderInput({ file: makeReportFile() });
    expect(() => {
      // Cast bypasses the type system to simulate an untyped JS caller
      // passing a value outside the ReporterFormat union. The default
      // branch's `never` assertion + throw provides defense-in-depth.
      render(input, "totally_invalid" as ReporterFormat);
    }).toThrow(/Unknown reporter format/);
  });
});

// =============================================================================
// SECTION 3: threshold pass-through
// =============================================================================

describe("render — threshold pass-through", () => {
  it("threshold forwards to terminal (low findings filtered at threshold 'high')", () => {
    const file = makeReportFile({
      results: [
        makeResult({ level: "low", title: "below" }),
        makeResult({ level: "high", title: "above" }),
      ],
      riskLevel: "high",
    });
    const output = render(makeRenderInput({ file, threshold: "high" }), "terminal");
    expect(output).toContain("above");
    expect(output).not.toContain("below");
  });

  it("threshold forwards to markdown (low findings filtered at threshold 'high')", () => {
    const file = makeReportFile({
      results: [
        makeResult({ level: "low", title: "below" }),
        makeResult({ level: "high", title: "above" }),
      ],
      riskLevel: "high",
    });
    const output = render(makeRenderInput({ file, threshold: "high" }), "markdown");
    expect(output).toContain("above");
    expect(output).not.toContain("below");
  });

  it("threshold forwards to json (filtered ReportFile returned, not the input)", () => {
    const file = makeReportFile({
      results: [makeResult({ level: "low" }), makeResult({ level: "high" })],
      riskLevel: "high",
    });
    const output = render(makeRenderInput({ file, threshold: "high" }), "json");
    expect(output).not.toBe(file);
    // json overload returns unknown by design; cast to access .report.
    const view = output as ReportFile;
    expect(view.report.results).toHaveLength(1);
    expect(view.report.results[0]?.level).toBe("high");
  });
});

// =============================================================================
// SECTION 4: productVersion pass-through
// =============================================================================

describe("render — productVersion pass-through", () => {
  it("productVersion forwards to markdown (appears in locked footer)", () => {
    const output = render(
      makeRenderInput({ file: makeReportFile(), productVersion: "1.2.3-test" }),
      "markdown",
    );
    expect(output).toContain("Generated by VibeRevert v1.2.3-test.");
  });

  it("productVersion forwards to terminal but is NOT consumed (per renderer contract)", () => {
    const output = render(
      makeRenderInput({ file: makeReportFile(), productVersion: "999.999.999-fake" }),
      "terminal",
    );
    expect(output).not.toContain("999.999.999-fake");
    expect(output).not.toContain("Generated by VibeRevert");
  });

  it("productVersion forwards to json but is NOT consumed (per renderer contract)", () => {
    const output = render(
      makeRenderInput({ file: makeReportFile(), productVersion: "999.999.999-fake" }),
      "json",
    );
    // The returned ReportFile is the on-disk wrapper schema; it has
    // NO productVersion field. The string "999.999.999-fake" never
    // appears anywhere in a JSON-stringified version.
    expect(JSON.stringify(output)).not.toContain("999.999.999-fake");
  });
});
