// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Test file for all M C-specific @viberevert/session-format contracts.
//
// Companion to schemas.test.ts (which covers the M A / M B surface). The
// split exists because M C added enough new surface — the ReportFile
// wrapper with 5 cross-field refines, severity helpers, the ISO-second
// helper, two new enums, and the noise-budget caps that tighten
// SessionReportSchema — that folding everything into schemas.test.ts would
// have pushed it past 1,700 lines.
//
// What lives here:
//   - REPORT_FILE_SCHEMA_VERSION constant + type-level lock.
//   - NOISE_BUDGET_MAX_* constants.
//   - compareLevel + riskLevelAtOrAbove (D25 severity ordering).
//   - toIsoSecondString (D31 producer-side ISO-second helper).
//   - SinceKindSchema + ReportFileKindSchema enums (D31, D56).
//   - SessionReportSchema's M C noise-budget refines (D31).
//   - ReportFileSchema's 5 refines (D31 + D56):
//       (1) session_bound report_id matches sess_<26-char Crockford ULID>
//       (2) ad_hoc report_id matches rpt_<26-char Crockford ULID>
//       (3) staged_only=true implies kind="ad_hoc"
//       (4) since_kind ↔ kind consistency
//       (5) report.session_id === report_id (identity invariant)
//   - ReportFileJsonSchema shape (D21 invariant for the new wrapper).
//   - Barrel-surface lock on the new M C exports.
//
// What deliberately stays in schemas.test.ts:
//   - All path-helper / string-helper coverage.
//   - All M B schemas (Evidence, ChangedFile, CheckResult, Manifest,
//     SessionState, ActiveSessionLock).
//   - SessionReportSchema's pre-noise-budget coverage (round-trip,
//     detected_frameworks sortedness, etc.).
//   - JSON Schema shape coverage for M B artifacts.

import { describe, expect, it } from "vitest";

import type { CheckResult, ReportFileSchemaVersion, RiskLevel } from "../src/index.js";
import {
  compareLevel,
  NOISE_BUDGET_MAX_LOW,
  NOISE_BUDGET_MAX_PER_CATEGORY,
  NOISE_BUDGET_MAX_TOTAL,
  REPORT_FILE_SCHEMA_VERSION,
  ReportFileJsonSchema,
  ReportFileKindSchema,
  ReportFileSchema,
  riskLevelAtOrAbove,
  SCHEMA_VERSION,
  SessionReportSchema,
  SinceKindSchema,
  toIsoSecondString,
} from "../src/index.js";

// Type-level assertion: locks that ReportFileSchemaVersion is exported and
// equals the literal "1.0". If the type alias is removed from the barrel or
// changes value, this fails to compile (caught by `pnpm typecheck`).
const _REPORT_FILE_SCHEMA_VERSION_TYPE_CHECK: ReportFileSchemaVersion = "1.0";
void _REPORT_FILE_SCHEMA_VERSION_TYPE_CHECK;

// =============================================================================
// Reusable test data
//
// 26-char Crockford base32 bodies. Crockford alphabet = 0-9 + A-Z minus
// I, L, O, U. The regex used by the ReportFileSchema refines is
// /^(sess|rpt)_[0-9A-HJKMNP-TV-Z]{26}$/.
// =============================================================================

const ULID_BODY_A = "01JV8Y7W2M7AABCDEFGHJKMNPQ"; // 26 chars, all valid Crockford
const ULID_BODY_B = "01JV8Y7W2M7AABCDEFGHJKMNPR"; // 26 chars, different last char
const VALID_SESS_ID = `sess_${ULID_BODY_A}`;
const VALID_RPT_ID = `rpt_${ULID_BODY_A}`;
const OTHER_SESS_ID = `sess_${ULID_BODY_B}`;
const OTHER_RPT_ID = `rpt_${ULID_BODY_B}`;

/** Builds a minimal inner SessionReport that already passes its M B schema. */
function buildInnerReport(overrides: { session_id?: string } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    session_id: overrides.session_id ?? VALID_SESS_ID,
    started_at: "2026-05-04T10:30:11Z",
    detected_frameworks: [],
    risk_level: "low" as const,
    changed_files: [],
    results: [],
    rollback_available: false,
  };
}

/** Builds a valid session_bound ReportFile. */
function buildSessionBound(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: REPORT_FILE_SCHEMA_VERSION,
    kind: "session_bound" as const,
    report_id: VALID_SESS_ID,
    since_kind: "active_session" as const,
    since_ref: VALID_SESS_ID,
    since_resolved_sha: "abc123",
    written_at: "2026-05-04T11:00:00Z",
    report: buildInnerReport({ session_id: VALID_SESS_ID }),
    ...overrides,
  };
}

/** Builds a valid ad_hoc ReportFile. */
function buildAdHoc(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: REPORT_FILE_SCHEMA_VERSION,
    kind: "ad_hoc" as const,
    report_id: VALID_RPT_ID,
    since_kind: "git_ref" as const,
    since_ref: "main",
    since_resolved_sha: "abc123",
    written_at: "2026-05-04T11:00:00Z",
    report: buildInnerReport({ session_id: VALID_RPT_ID }),
    ...overrides,
  };
}

/** Builds a CheckResult with the requested level + category for noise-budget tests. */
function buildFinding(level: RiskLevel, category: string, idx: number): CheckResult {
  const base = {
    id: `noise.${category}.${idx}`,
    title: `finding ${idx}`,
    level,
    confidence: "low" as const,
    category,
    message: "x",
    evidence: [{ detail: "x" }],
  };
  // M B refine: high/critical require recommendation.
  if (level === "high" || level === "critical") {
    return { ...base, recommendation: "fix it" };
  }
  return base;
}

/** Builds a minimal SessionReport with the supplied findings (everything else defaulted). */
function buildSessionReportWithFindings(findings: readonly CheckResult[], riskLevel: RiskLevel) {
  return {
    schema_version: SCHEMA_VERSION,
    session_id: VALID_SESS_ID,
    started_at: "2026-05-04T10:30:11Z",
    detected_frameworks: [],
    risk_level: riskLevel,
    changed_files: [],
    results: findings,
    rollback_available: false,
  };
}

// =============================================================================
// REPORT_FILE_SCHEMA_VERSION + NOISE_BUDGET_MAX_* constants
// =============================================================================

describe("REPORT_FILE_SCHEMA_VERSION", () => {
  it("is the string '1.0'", () => {
    expect(REPORT_FILE_SCHEMA_VERSION).toBe("1.0");
  });
});

describe("NOISE_BUDGET_MAX_* constants", () => {
  it("NOISE_BUDGET_MAX_TOTAL is 100", () => {
    expect(NOISE_BUDGET_MAX_TOTAL).toBe(100);
  });

  it("NOISE_BUDGET_MAX_LOW is 20", () => {
    expect(NOISE_BUDGET_MAX_LOW).toBe(20);
  });

  it("NOISE_BUDGET_MAX_PER_CATEGORY is 40", () => {
    expect(NOISE_BUDGET_MAX_PER_CATEGORY).toBe(40);
  });
});

// =============================================================================
// compareLevel (D25): low < medium < high < critical
// =============================================================================

describe("compareLevel", () => {
  const allLevels: readonly RiskLevel[] = ["low", "medium", "high", "critical"];

  it("returns 0 for equal levels", () => {
    for (const l of allLevels) {
      expect(compareLevel(l, l)).toBe(0);
    }
  });

  it.each([
    ["low", "medium"],
    ["low", "high"],
    ["low", "critical"],
    ["medium", "high"],
    ["medium", "critical"],
    ["high", "critical"],
  ] as const)("returns -1 for %s < %s", (a, b) => {
    expect(compareLevel(a, b)).toBe(-1);
  });

  it.each([
    ["medium", "low"],
    ["high", "low"],
    ["critical", "low"],
    ["high", "medium"],
    ["critical", "medium"],
    ["critical", "high"],
  ] as const)("returns +1 for %s > %s", (a, b) => {
    expect(compareLevel(a, b)).toBe(1);
  });

  it("works as Array.sort comparator (ascending)", () => {
    const shuffled: RiskLevel[] = ["critical", "low", "high", "medium"];
    const sorted = [...shuffled].sort(compareLevel);
    expect(sorted).toEqual(["low", "medium", "high", "critical"]);
  });

  it("works as Array.sort comparator (descending)", () => {
    const shuffled: RiskLevel[] = ["medium", "critical", "low", "high"];
    const sorted = [...shuffled].sort((a, b) => -compareLevel(a, b));
    expect(sorted).toEqual(["critical", "high", "medium", "low"]);
  });
});

// =============================================================================
// riskLevelAtOrAbove (D25): true iff actual >= threshold under compareLevel
// =============================================================================

describe("riskLevelAtOrAbove", () => {
  it("is true when actual equals threshold (boundary inclusive)", () => {
    for (const l of ["low", "medium", "high", "critical"] as const) {
      expect(riskLevelAtOrAbove(l, l)).toBe(true);
    }
  });

  it("is true when actual is strictly above threshold", () => {
    expect(riskLevelAtOrAbove("medium", "low")).toBe(true);
    expect(riskLevelAtOrAbove("high", "low")).toBe(true);
    expect(riskLevelAtOrAbove("critical", "low")).toBe(true);
    expect(riskLevelAtOrAbove("high", "medium")).toBe(true);
    expect(riskLevelAtOrAbove("critical", "medium")).toBe(true);
    expect(riskLevelAtOrAbove("critical", "high")).toBe(true);
  });

  it("is false when actual is strictly below threshold", () => {
    expect(riskLevelAtOrAbove("low", "medium")).toBe(false);
    expect(riskLevelAtOrAbove("low", "high")).toBe(false);
    expect(riskLevelAtOrAbove("low", "critical")).toBe(false);
    expect(riskLevelAtOrAbove("medium", "high")).toBe(false);
    expect(riskLevelAtOrAbove("medium", "critical")).toBe(false);
    expect(riskLevelAtOrAbove("high", "critical")).toBe(false);
  });
});

// =============================================================================
// toIsoSecondString (D31): producer-side bridge that strips the .NNN segment
// `Date.prototype.toISOString()` always emits, so the result passes
// z.iso.datetime({ offset: true, precision: 0 }).
//
// Truncates to the second; does NOT round (the .replace strips, not rounds).
// =============================================================================

describe("toIsoSecondString", () => {
  it("strips the millisecond segment (123 → no ms)", () => {
    expect(toIsoSecondString(new Date("2026-05-04T10:30:11.123Z"))).toBe("2026-05-04T10:30:11Z");
  });

  it("truncates 999ms — does NOT round up to the next second", () => {
    // Load-bearing: 999ms must produce :11, not :12. The implementation MUST
    // use .replace(/\.\d{3}Z$/, "Z"), NOT a rounding-aware path.
    expect(toIsoSecondString(new Date("2026-05-04T10:30:11.999Z"))).toBe("2026-05-04T10:30:11Z");
  });

  it("leaves an already-second-precision input unchanged", () => {
    // new Date("...Z").toISOString() always re-adds ".000Z", which the
    // helper then strips back to "Z".
    expect(toIsoSecondString(new Date("2026-05-04T10:30:11Z"))).toBe("2026-05-04T10:30:11Z");
  });

  it("throws RangeError on an Invalid Date (the underlying toISOString throws)", () => {
    expect(() => toIsoSecondString(new Date("not a real date"))).toThrow(RangeError);
  });

  // The reason this helper exists in the first place: raw Date.prototype
  // .toISOString() always emits milliseconds, which the schemas REJECT.
  // toIsoSecondString is the bridge that lets producers satisfy
  // z.iso.datetime({ offset: true, precision: 0 }).
  it("produces a value the strict ISO-second schema accepts (positive)", () => {
    const isoSecond = toIsoSecondString(new Date("2026-05-04T10:30:11.500Z"));
    // Exercise via SessionReportSchema.started_at (also second-precision).
    expect(() =>
      SessionReportSchema.parse({
        schema_version: SCHEMA_VERSION,
        session_id: VALID_SESS_ID,
        started_at: isoSecond,
        detected_frameworks: [],
        risk_level: "low",
        changed_files: [],
        results: [],
        rollback_available: false,
      }),
    ).not.toThrow();
  });

  it("raw Date.prototype.toISOString() is REJECTED by the strict ISO-second schema (negative)", () => {
    // Proves the helper is required, not optional. If the schema ever loosens
    // and starts accepting millisecond precision, this test will go green and
    // every producer can drop the helper.
    const rawIso = new Date("2026-05-04T10:30:11.500Z").toISOString();
    expect(rawIso).toMatch(/\.\d{3}Z$/); // sanity: raw output really does have .NNN
    expect(() =>
      SessionReportSchema.parse({
        schema_version: SCHEMA_VERSION,
        session_id: VALID_SESS_ID,
        started_at: rawIso,
        detected_frameworks: [],
        risk_level: "low",
        changed_files: [],
        results: [],
        rollback_available: false,
      }),
    ).toThrow();
  });
});

// =============================================================================
// SinceKindSchema (D56) — the 5 base-resolution discriminator values.
// =============================================================================

describe("SinceKindSchema", () => {
  it.each([
    "git_ref",
    "checkpoint_id",
    "checkpoint_name",
    "session_id",
    "active_session",
  ])("accepts %s", (v) => {
    expect(SinceKindSchema.parse(v)).toBe(v);
  });

  it("rejects an unrelated string", () => {
    expect(() => SinceKindSchema.parse("staged")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => SinceKindSchema.parse("")).toThrow();
  });

  it("rejects a different-cased value", () => {
    expect(() => SinceKindSchema.parse("GIT_REF")).toThrow();
  });
});

// =============================================================================
// ReportFileKindSchema (D26) — session_bound vs ad_hoc.
// =============================================================================

describe("ReportFileKindSchema", () => {
  it.each(["session_bound", "ad_hoc"])("accepts %s", (v) => {
    expect(ReportFileKindSchema.parse(v)).toBe(v);
  });

  it("rejects an unrelated string", () => {
    expect(() => ReportFileKindSchema.parse("checkpoint")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => ReportFileKindSchema.parse("")).toThrow();
  });
});

// =============================================================================
// SessionReportSchema noise-budget caps (D31, M C addition)
//
// The M B SessionReportSchema round-trip + detected_frameworks coverage
// already lives in schemas.test.ts. This block ONLY exercises the three
// noise-budget refines added in M C.
// =============================================================================

describe("SessionReportSchema noise-budget caps (M C addition)", () => {
  // ---- total cap (100) -------------------------------------------------------

  it("accepts a report with exactly NOISE_BUDGET_MAX_TOTAL findings", () => {
    // Split across 3 categories (medium) so per-category and low caps don't fire.
    // 100 = 34+33+33 — none exceeds 40, none is low.
    const findings: CheckResult[] = [];
    for (let i = 0; i < 34; i++) findings.push(buildFinding("medium", "cat-a", i));
    for (let i = 0; i < 33; i++) findings.push(buildFinding("medium", "cat-b", i));
    for (let i = 0; i < 33; i++) findings.push(buildFinding("medium", "cat-c", i));
    expect(findings.length).toBe(NOISE_BUDGET_MAX_TOTAL);
    expect(() =>
      SessionReportSchema.parse(buildSessionReportWithFindings(findings, "medium")),
    ).not.toThrow();
  });

  it("rejects a report with NOISE_BUDGET_MAX_TOTAL + 1 findings", () => {
    const findings: CheckResult[] = [];
    for (let i = 0; i < 34; i++) findings.push(buildFinding("medium", "cat-a", i));
    for (let i = 0; i < 34; i++) findings.push(buildFinding("medium", "cat-b", i));
    for (let i = 0; i < 33; i++) findings.push(buildFinding("medium", "cat-c", i));
    expect(findings.length).toBe(NOISE_BUDGET_MAX_TOTAL + 1);
    expect(() =>
      SessionReportSchema.parse(buildSessionReportWithFindings(findings, "medium")),
    ).toThrow();
  });

  // ---- low cap (20) ----------------------------------------------------------

  it("accepts a report with exactly NOISE_BUDGET_MAX_LOW low findings", () => {
    // 20 lows distributed across 2 categories so per-category cap doesn't fire.
    const findings: CheckResult[] = [];
    for (let i = 0; i < 10; i++) findings.push(buildFinding("low", "low-a", i));
    for (let i = 0; i < 10; i++) findings.push(buildFinding("low", "low-b", i));
    expect(findings.filter((f) => f.level === "low").length).toBe(NOISE_BUDGET_MAX_LOW);
    expect(() =>
      SessionReportSchema.parse(buildSessionReportWithFindings(findings, "low")),
    ).not.toThrow();
  });

  it("rejects a report with NOISE_BUDGET_MAX_LOW + 1 low findings", () => {
    // 21 lows distributed across 3 categories — keeps per-category ≤ 40,
    // total ≤ 100; only the low cap should trip.
    const findings: CheckResult[] = [];
    for (let i = 0; i < 7; i++) findings.push(buildFinding("low", "low-a", i));
    for (let i = 0; i < 7; i++) findings.push(buildFinding("low", "low-b", i));
    for (let i = 0; i < 7; i++) findings.push(buildFinding("low", "low-c", i));
    expect(findings.length).toBe(NOISE_BUDGET_MAX_LOW + 1);
    expect(() =>
      SessionReportSchema.parse(buildSessionReportWithFindings(findings, "low")),
    ).toThrow();
  });

  // ---- per-category cap (40) -------------------------------------------------

  it("accepts a report with exactly NOISE_BUDGET_MAX_PER_CATEGORY findings in one category", () => {
    // All 40 medium so the low cap doesn't fire.
    const findings: CheckResult[] = [];
    for (let i = 0; i < NOISE_BUDGET_MAX_PER_CATEGORY; i++) {
      findings.push(buildFinding("medium", "cat-x", i));
    }
    expect(() =>
      SessionReportSchema.parse(buildSessionReportWithFindings(findings, "medium")),
    ).not.toThrow();
  });

  it("rejects a report with NOISE_BUDGET_MAX_PER_CATEGORY + 1 findings in one category", () => {
    const findings: CheckResult[] = [];
    for (let i = 0; i < NOISE_BUDGET_MAX_PER_CATEGORY + 1; i++) {
      findings.push(buildFinding("medium", "cat-x", i));
    }
    expect(() =>
      SessionReportSchema.parse(buildSessionReportWithFindings(findings, "medium")),
    ).toThrow();
  });

  it("accepts when each of two categories is at the per-category cap (no cross-category leakage)", () => {
    // 40 in cat-a + 40 in cat-b = 80 total, all medium. Per-category cap is
    // PER category, not summed across categories.
    const findings: CheckResult[] = [];
    for (let i = 0; i < NOISE_BUDGET_MAX_PER_CATEGORY; i++) {
      findings.push(buildFinding("medium", "cat-a", i));
    }
    for (let i = 0; i < NOISE_BUDGET_MAX_PER_CATEGORY; i++) {
      findings.push(buildFinding("medium", "cat-b", i));
    }
    expect(() =>
      SessionReportSchema.parse(buildSessionReportWithFindings(findings, "medium")),
    ).not.toThrow();
  });
});

// =============================================================================
// ReportFileSchema (D31 + D56) — the 5 cross-field refines
// =============================================================================

describe("ReportFileSchema", () => {
  // ---- happy-path round-trip ------------------------------------------------

  it("accepts a valid session_bound report", () => {
    const v = buildSessionBound();
    expect(ReportFileSchema.parse(v)).toEqual(v);
  });

  it("accepts a valid ad_hoc report", () => {
    const v = buildAdHoc();
    expect(ReportFileSchema.parse(v)).toEqual(v);
  });

  it("accepts a valid ad_hoc report with staged_only: true", () => {
    const v = buildAdHoc({ staged_only: true });
    expect(ReportFileSchema.parse(v)).toEqual(v);
  });

  it("accepts session_bound with since_kind: session_id (in addition to active_session)", () => {
    const v = buildSessionBound({ since_kind: "session_id" });
    expect(ReportFileSchema.parse(v)).toEqual(v);
  });

  it("accepts ad_hoc with each allowed since_kind", () => {
    for (const since_kind of ["git_ref", "checkpoint_id", "checkpoint_name"] as const) {
      const v = buildAdHoc({ since_kind });
      expect(ReportFileSchema.parse(v)).toEqual(v);
    }
  });

  // ---- basic shape rejections -----------------------------------------------

  it("rejects wrong schema_version", () => {
    expect(() => ReportFileSchema.parse(buildSessionBound({ schema_version: "2.0" }))).toThrow();
  });

  it("rejects unknown top-level field (strict)", () => {
    expect(() => ReportFileSchema.parse(buildSessionBound({ extra_field: "nope" }))).toThrow();
  });

  it("rejects whitespace-only since_ref", () => {
    expect(() => ReportFileSchema.parse(buildAdHoc({ since_ref: "   " }))).toThrow();
  });

  it("rejects whitespace-only since_resolved_sha", () => {
    expect(() => ReportFileSchema.parse(buildAdHoc({ since_resolved_sha: "   " }))).toThrow();
  });

  it("rejects written_at without offset", () => {
    expect(() =>
      ReportFileSchema.parse(buildAdHoc({ written_at: "2026-05-04T11:00:00" })),
    ).toThrow();
  });

  it("rejects written_at with fractional seconds (D31 rationale for toIsoSecondString)", () => {
    expect(() =>
      ReportFileSchema.parse(buildAdHoc({ written_at: "2026-05-04T11:00:00.500Z" })),
    ).toThrow();
  });

  // ---- (1) session_bound report_id must be sess_<26-char Crockford ULID> ----

  describe("session_bound report_id ULID-shape refine", () => {
    it("accepts a real sess_<26-char Crockford ULID>", () => {
      expect(() => ReportFileSchema.parse(buildSessionBound())).not.toThrow();
    });

    it("rejects 'sess_garbage' (body wrong length and chars)", () => {
      const v = buildSessionBound({
        report_id: "sess_garbage",
        report: buildInnerReport({ session_id: "sess_garbage" }),
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("rejects 'sess_' alone (prefix only, empty body)", () => {
      const v = buildSessionBound({
        report_id: "sess_",
        report: buildInnerReport({ session_id: "sess_" }),
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("rejects a 25-char body (too short)", () => {
      const id = `sess_${"0".repeat(25)}`;
      const v = buildSessionBound({ report_id: id, report: buildInnerReport({ session_id: id }) });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("rejects a 27-char body (too long)", () => {
      const id = `sess_${"0".repeat(27)}`;
      const v = buildSessionBound({ report_id: id, report: buildInnerReport({ session_id: id }) });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it.each(["I", "L", "O", "U"])("rejects a body containing forbidden Crockford char %s", (ch) => {
      // Take ULID_BODY_A and replace its 5th char with the forbidden one.
      const body = ULID_BODY_A.slice(0, 5) + ch + ULID_BODY_A.slice(6);
      const id = `sess_${body}`;
      const v = buildSessionBound({ report_id: id, report: buildInnerReport({ session_id: id }) });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("rejects a lowercase body", () => {
      const id = `sess_${ULID_BODY_A.toLowerCase()}`;
      const v = buildSessionBound({ report_id: id, report: buildInnerReport({ session_id: id }) });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("rejects an rpt_<ULID> on a session_bound report (wrong prefix for kind)", () => {
      const v = buildSessionBound({
        report_id: VALID_RPT_ID,
        report: buildInnerReport({ session_id: VALID_RPT_ID }),
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });
  });

  // ---- (2) ad_hoc report_id must be rpt_<26-char Crockford ULID> ------------

  describe("ad_hoc report_id ULID-shape refine", () => {
    it("accepts a real rpt_<26-char Crockford ULID>", () => {
      expect(() => ReportFileSchema.parse(buildAdHoc())).not.toThrow();
    });

    it("rejects 'rpt_garbage'", () => {
      const v = buildAdHoc({
        report_id: "rpt_garbage",
        report: buildInnerReport({ session_id: "rpt_garbage" }),
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("rejects 'rpt_' alone (prefix only)", () => {
      const v = buildAdHoc({
        report_id: "rpt_",
        report: buildInnerReport({ session_id: "rpt_" }),
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it.each(["I", "L", "O", "U"])("rejects a body containing forbidden Crockford char %s", (ch) => {
      const body = ULID_BODY_A.slice(0, 5) + ch + ULID_BODY_A.slice(6);
      const id = `rpt_${body}`;
      const v = buildAdHoc({ report_id: id, report: buildInnerReport({ session_id: id }) });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("rejects a sess_<ULID> on an ad_hoc report (wrong prefix for kind)", () => {
      const v = buildAdHoc({
        report_id: VALID_SESS_ID,
        report: buildInnerReport({ session_id: VALID_SESS_ID }),
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });
  });

  // ---- (3) staged_only literal-true rule (D39) -----------------------------

  describe("staged_only literal-true refine", () => {
    it("accepts staged_only: true on ad_hoc", () => {
      expect(() => ReportFileSchema.parse(buildAdHoc({ staged_only: true }))).not.toThrow();
    });

    it("accepts staged_only key OMITTED on ad_hoc", () => {
      // The default builder omits staged_only — this just locks the contract
      // alongside the explicit-true case above for symmetry.
      const v = buildAdHoc();
      expect(v).not.toHaveProperty("staged_only");
      expect(() => ReportFileSchema.parse(v)).not.toThrow();
    });

    it("accepts staged_only key OMITTED on session_bound", () => {
      const v = buildSessionBound();
      expect(v).not.toHaveProperty("staged_only");
      expect(() => ReportFileSchema.parse(v)).not.toThrow();
    });

    it("REJECTS staged_only: false (z.literal(true) accepts only true; false is invalid)", () => {
      expect(() => ReportFileSchema.parse(buildAdHoc({ staged_only: false }))).toThrow();
    });

    it("REJECTS staged_only: true with kind: session_bound (cross-field refine)", () => {
      expect(() => ReportFileSchema.parse(buildSessionBound({ staged_only: true }))).toThrow();
    });
  });

  // ---- (4) since_kind ↔ kind consistency (D56) -----------------------------

  describe("since_kind ↔ kind consistency refine", () => {
    it("rejects session_bound + git_ref", () => {
      expect(() =>
        ReportFileSchema.parse(buildSessionBound({ since_kind: "git_ref", since_ref: "main" })),
      ).toThrow();
    });

    it("rejects session_bound + checkpoint_id", () => {
      expect(() =>
        ReportFileSchema.parse(
          buildSessionBound({ since_kind: "checkpoint_id", since_ref: "cp_xyz" }),
        ),
      ).toThrow();
    });

    it("rejects session_bound + checkpoint_name", () => {
      expect(() =>
        ReportFileSchema.parse(
          buildSessionBound({ since_kind: "checkpoint_name", since_ref: "baseline" }),
        ),
      ).toThrow();
    });

    it("rejects ad_hoc + session_id", () => {
      expect(() =>
        ReportFileSchema.parse(buildAdHoc({ since_kind: "session_id", since_ref: VALID_SESS_ID })),
      ).toThrow();
    });

    it("rejects ad_hoc + active_session", () => {
      expect(() =>
        ReportFileSchema.parse(
          buildAdHoc({ since_kind: "active_session", since_ref: VALID_SESS_ID }),
        ),
      ).toThrow();
    });
  });

  // ---- (5) identity invariant (D31) ----------------------------------------

  describe("report.session_id === report_id identity refine", () => {
    it("accepts session_bound where both ids match", () => {
      const v = buildSessionBound({
        report_id: VALID_SESS_ID,
        report: buildInnerReport({ session_id: VALID_SESS_ID }),
      });
      expect(() => ReportFileSchema.parse(v)).not.toThrow();
    });

    it("accepts ad_hoc where both ids match (both are the rpt_<ULID>)", () => {
      const v = buildAdHoc({
        report_id: VALID_RPT_ID,
        report: buildInnerReport({ session_id: VALID_RPT_ID }),
      });
      expect(() => ReportFileSchema.parse(v)).not.toThrow();
    });

    it("REJECTS session_bound where the embedded report.session_id drifts", () => {
      const v = buildSessionBound({
        report_id: VALID_SESS_ID,
        report: buildInnerReport({ session_id: OTHER_SESS_ID }), // different valid sess_<ULID>
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("REJECTS ad_hoc where the embedded report.session_id drifts", () => {
      const v = buildAdHoc({
        report_id: VALID_RPT_ID,
        report: buildInnerReport({ session_id: OTHER_RPT_ID }), // different valid rpt_<ULID>
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });

    it("REJECTS ad_hoc where wrapper carries rpt_ and embedded carries sess_ (mixed)", () => {
      const v = buildAdHoc({
        report_id: VALID_RPT_ID,
        report: buildInnerReport({ session_id: VALID_SESS_ID }),
      });
      expect(() => ReportFileSchema.parse(v)).toThrow();
    });
  });
});

// =============================================================================
// ReportFileJsonSchema (D21 invariant for the new wrapper)
//
// JSON Schema cannot express the cross-field .refine() rules
// (kind/since_kind consistency, ULID-shape regex on report_id,
// staged_only ↔ kind, identity invariant). What it CAN express — and
// what we lock here — is the wrapper's basic shape + the optional/required
// property split + the embedded report sub-schema.
// =============================================================================

describe("ReportFileJsonSchema", () => {
  it("is an object with type=object and properties", () => {
    expect(ReportFileJsonSchema).toBeTypeOf("object");
    expect(ReportFileJsonSchema).not.toBeNull();
    expect((ReportFileJsonSchema as { type: string }).type).toBe("object");
    expect((ReportFileJsonSchema as { properties: object }).properties).toBeTypeOf("object");
  });

  it("describes all expected wrapper properties", () => {
    const props = (ReportFileJsonSchema as { properties: Record<string, unknown> }).properties;
    for (const k of [
      "schema_version",
      "kind",
      "report_id",
      "since_kind",
      "since_ref",
      "since_resolved_sha",
      "staged_only",
      "written_at",
      "report",
    ]) {
      expect(props).toHaveProperty(k);
    }
  });

  it("lists exactly the non-optional wrapper fields as required (staged_only omitted)", () => {
    const required = (ReportFileJsonSchema as { required: readonly string[] }).required;
    expect([...required].sort()).toEqual(
      [
        "kind",
        "report",
        "report_id",
        "schema_version",
        "since_kind",
        "since_ref",
        "since_resolved_sha",
        "written_at",
      ].sort(),
    );
    // staged_only is .optional() in zod → MUST NOT appear in required.
    expect(required).not.toContain("staged_only");
  });

  it("embeds the SessionReport sub-schema at .properties.report", () => {
    const props = (ReportFileJsonSchema as { properties: { report?: unknown } }).properties;
    const reportProp = props.report as { type?: string; properties?: Record<string, unknown> };
    expect(reportProp).toBeTypeOf("object");
    expect(reportProp.type).toBe("object");
    expect(reportProp.properties).toHaveProperty("session_id");
    expect(reportProp.properties).toHaveProperty("results");
    expect(reportProp.properties).toHaveProperty("changed_files");
  });
});

// =============================================================================
// Barrel surface (M C additions) — locks the new public API.
//
// Importing from `../src/index.js` (NOT internal paths) and asserting each
// new M C symbol is defined + has the expected runtime shape. Removing any
// of these from index.ts breaks this test.
// =============================================================================

describe("Barrel surface (M C additions)", () => {
  it("exports ReportFileSchema as a zod schema", () => {
    expect(ReportFileSchema).toBeDefined();
    expect(ReportFileSchema).toHaveProperty("parse");
    expect(typeof (ReportFileSchema as { parse: unknown }).parse).toBe("function");
  });

  it("exports ReportFileKindSchema as a zod schema", () => {
    expect(ReportFileKindSchema).toBeDefined();
    expect(typeof (ReportFileKindSchema as { parse: unknown }).parse).toBe("function");
  });

  it("exports SinceKindSchema as a zod schema", () => {
    expect(SinceKindSchema).toBeDefined();
    expect(typeof (SinceKindSchema as { parse: unknown }).parse).toBe("function");
  });

  it("exports ReportFileJsonSchema as a JSON Schema object", () => {
    expect(ReportFileJsonSchema).toBeDefined();
    expect((ReportFileJsonSchema as { type: string }).type).toBe("object");
  });

  it("exports REPORT_FILE_SCHEMA_VERSION as the literal '1.0'", () => {
    expect(REPORT_FILE_SCHEMA_VERSION).toBe("1.0");
  });

  it("exports NOISE_BUDGET_MAX_* constants", () => {
    expect(NOISE_BUDGET_MAX_TOTAL).toBe(100);
    expect(NOISE_BUDGET_MAX_LOW).toBe(20);
    expect(NOISE_BUDGET_MAX_PER_CATEGORY).toBe(40);
  });

  it("exports compareLevel as a callable function", () => {
    expect(typeof compareLevel).toBe("function");
    expect(compareLevel("low", "high")).toBe(-1);
  });

  it("exports riskLevelAtOrAbove as a callable function", () => {
    expect(typeof riskLevelAtOrAbove).toBe("function");
    expect(riskLevelAtOrAbove("high", "medium")).toBe(true);
  });

  it("exports toIsoSecondString as a callable function", () => {
    expect(typeof toIsoSecondString).toBe("function");
    expect(toIsoSecondString(new Date("2026-01-01T00:00:00.123Z"))).toBe("2026-01-01T00:00:00Z");
  });
});
