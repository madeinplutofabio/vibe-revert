// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// applyThreshold: the pure threshold-filter helper for D38's
// output-filter semantics. Used by all three renderers (json,
// terminal, markdown) and by the render() dispatcher to apply
// `RenderInput.threshold` before formatting.
//
// =============================================================================
// SEMANTICS (D38 — output-filter ONLY)
// =============================================================================
//
// `threshold` is an OUTPUT-FILTER, not a gate. The persisted on-disk
// ReportFile is NEVER mutated by this function. When called by a
// renderer, it returns a NEW ReportFile-shaped value with:
//   - report.results filtered to entries with level >= threshold
//   - report.risk_level RECOMPUTED against the filtered set (D52)
//   - report.summary RECOMPUTED against the filtered set (D53);
//     OMITTED when filtered results are empty (matches the schema's
//     optional-field "present-iff-defined" convention)
//   - report.changed_files UNCHANGED (D38: the diff inventory is
//     never filtered by threshold — it documents what files were
//     touched, not which findings remain visible)
//
// The threshold-undefined and threshold="low" cases are SHORT-
// CIRCUITED to return the input reference unchanged (no allocation).
// "low" is the floor of the RiskLevel enum, so every finding is
// trivially >= "low".
//
// =============================================================================
// LOCAL HELPERS, NOT EXPORTED (D17c-style duplication discipline)
// =============================================================================
//
// `computeRiskLevel` and `computeSummary` are PRIVATE to this module.
// The CLI's check-orchestration.ts (Step 9) has its own copies for
// constructing the ReportFile at write time — same per-package
// atomic-helper duplication M B used for writeFileAtomic. The total
// LOC duplicated is small (~20 lines per package) and the duplication
// avoids the awkward dependency direction of CLI → reporters →
// helpers (CLI does depend on reporters, but reporters' role is
// rendering, not arithmetic; mixing the two would couple
// otherwise-independent code paths).

import {
  type CheckResult,
  compareLevel,
  type ReportFile,
  type RiskLevel,
  type SessionReport,
} from "@viberevert/session-format";

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Compute risk_level per D52: `max(...results.level, "low")` using
 * the locked total order from `compareLevel`. Empty results → "low".
 */
function computeRiskLevel(results: readonly CheckResult[]): RiskLevel {
  let max: RiskLevel = "low";
  for (const r of results) {
    if (compareLevel(r.level, max) > 0) {
      max = r.level;
    }
  }
  return max;
}

/**
 * Compute summary per D53: `"<N> findings: <breakdown by category,
 * comma-separated, sorted by category asc>"`. Empty results →
 * undefined (caller omits the field from the output).
 *
 *   results = [auth/high, payments/critical, auth/medium]
 *     → "3 findings: auth (2), payments (1)"
 *
 * Category sort is ASCII-ascending (no localeCompare — locale-
 * sensitive comparison would make the same report render
 * differently across machines).
 */
function computeSummary(results: readonly CheckResult[]): string | undefined {
  if (results.length === 0) return undefined;

  const countsByCategory = new Map<string, number>();
  for (const r of results) {
    countsByCategory.set(r.category, (countsByCategory.get(r.category) ?? 0) + 1);
  }

  const breakdown = [...countsByCategory.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([category, count]) => `${category} (${count})`)
    .join(", ");

  return `${results.length} findings: ${breakdown}`;
}

// =============================================================================
// applyThreshold
// =============================================================================

/**
 * Pure threshold-filter for D38's output-filter semantics. See the
 * file header for the full semantic contract.
 *
 * Returns the input reference unchanged when `threshold` is undefined
 * OR equal to "low" (no-filtering short-circuit). Otherwise returns
 * a new `ReportFile` with `report.results`, `report.risk_level`, and
 * `report.summary` recomputed; all other fields are preserved by
 * reference.
 *
 * Pure: never mutates `file` or anything reachable from it.
 */
export function applyThreshold(file: ReportFile, threshold?: RiskLevel): ReportFile {
  if (threshold === undefined || threshold === "low") {
    return file;
  }

  const oldReport = file.report;
  const filteredResults = oldReport.results.filter((r) => compareLevel(r.level, threshold) >= 0);
  const newRiskLevel = computeRiskLevel(filteredResults);
  const newSummary = computeSummary(filteredResults);

  // Build the new SessionReport. Destructure to separate the
  // possibly-existing original summary from the rest so we can
  // conditionally include OR omit the recomputed summary
  // ("present-iff-defined" pattern matching the schema). The
  // `void originalSummary` line marks the destructured value as
  // intentionally consumed while keeping the omission explicit.
  const { summary: originalSummary, ...reportSansSummary } = oldReport;
  void originalSummary;

  const newReport: SessionReport =
    newSummary === undefined
      ? {
          ...reportSansSummary,
          results: filteredResults,
          risk_level: newRiskLevel,
        }
      : {
          ...reportSansSummary,
          results: filteredResults,
          risk_level: newRiskLevel,
          summary: newSummary,
        };

  return { ...file, report: newReport };
}
