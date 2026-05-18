// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/checks/src/severity.ts.
//
// Covers:
//   - sortFindings: deterministic [level desc, category asc, id asc,
//     file asc, line asc] ordering, including undefined-field substitution
//   - clusterFindings: D40's 4-pass post-process pipeline
//     - Pass 1: identity-based dedup (exact duplicates collapse, distinct
//       findings survive, JSON tuple encoding is collision-safe)
//     - Pass 2: per-category cap (≤30 = 29 individual + 1 summary), plus
//       summary evidence cap (≤11 entries), deterministic recommendation
//       selection (first 3 distinct sorted by [level desc, id asc]), and
//       recommendation truncation with ellipsis at 280 chars
//     - Pass 3: low-finding global cap (≤20 = 19 + 1 summary)
//     - Pass 4: total cap (≤90 = 89 + 1 summary)
//   - Cluster-summary construction:
//     - level: max(...clustered) via compareLevel (except cluster.low-tail = "low")
//     - recommendation populated for high/critical clusters
//     - evidence: detail + file pairs, sorted ASCII-asc
//     - product-facing strings (no internal decision-tracking jargon)
//   - SCHEMA-VALIDITY OF CLUSTER OUTPUT: every output of clusterFindings
//     is asserted to round-trip through CheckResultSchema, proving the
//     "severity.ts must produce schema-valid summaries even though it
//     does not import the schema" contract at the test layer.
//   - CLUSTER_CAP_* constants are the expected values
//   - compareLevel re-export smoke test (function exists + works)

import { CheckResultSchema } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import type { CheckResult, RiskLevel } from "../src/index.js";
import {
  CLUSTER_CAP_LOW,
  CLUSTER_CAP_PER_CATEGORY,
  CLUSTER_CAP_TOTAL,
  clusterFindings,
  compareLevel,
  sortFindings,
} from "../src/index.js";

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Builds a CheckResult with explicit control over every field that the
 * sort key + dedup key + cluster-cap logic reads. Defaults are sensible
 * for "one realistic finding"; callers override per test.
 *
 * High/critical findings automatically get a default recommendation
 * (satisfies M B's CheckResultSchema refine).
 */
function buildFinding(opts: {
  id?: string;
  category?: string;
  level?: RiskLevel;
  file?: string;
  line?: number;
  detail?: string;
  recommendation?: string;
}): CheckResult {
  const level: RiskLevel = opts.level ?? "medium";
  const evidence = [
    {
      detail: opts.detail ?? "evidence detail",
      ...(opts.file !== undefined ? { file: opts.file } : {}),
      ...(opts.line !== undefined ? { line: opts.line } : {}),
    },
  ];
  const base = {
    id: opts.id ?? "test.finding",
    title: "Test finding",
    level,
    confidence: "medium" as const,
    category: opts.category ?? "test",
    message: "test message",
    evidence,
  };
  if (level === "high" || level === "critical") {
    return { ...base, recommendation: opts.recommendation ?? "fix it" };
  }
  if (opts.recommendation !== undefined) {
    return { ...base, recommendation: opts.recommendation };
  }
  return base;
}

/**
 * Asserts every finding in the array is structurally valid per
 * CheckResultSchema. severity.ts intentionally does NOT import the
 * schema (clustering is pure transformation; engine.ts re-validates
 * before returning to callers). This helper proves at the test layer
 * that severity.ts's direct output is schema-valid — closing the gap
 * where a malformed cluster summary could slip past severity's own
 * tests and only surface as an engine.ts re-validation throw.
 */
function expectAllFindingsSchemaValid(findings: readonly CheckResult[]): void {
  for (const finding of findings) {
    expect(() => CheckResultSchema.parse(finding)).not.toThrow();
  }
}

// =============================================================================
// CLUSTER_CAP_* constants
// =============================================================================

describe("CLUSTER_CAP_* constants", () => {
  it("CLUSTER_CAP_PER_CATEGORY is 30", () => {
    expect(CLUSTER_CAP_PER_CATEGORY).toBe(30);
  });

  it("CLUSTER_CAP_LOW is 20 (matches schema cap exactly, 0 headroom)", () => {
    expect(CLUSTER_CAP_LOW).toBe(20);
  });

  it("CLUSTER_CAP_TOTAL is 90", () => {
    expect(CLUSTER_CAP_TOTAL).toBe(90);
  });
});

// =============================================================================
// compareLevel re-export smoke test
// =============================================================================

describe("compareLevel (re-exported from session-format)", () => {
  it("is callable and returns the locked ordering", () => {
    expect(compareLevel("low", "high")).toBe(-1);
    expect(compareLevel("critical", "medium")).toBe(1);
    expect(compareLevel("high", "high")).toBe(0);
  });
});

// =============================================================================
// sortFindings
// =============================================================================

describe("sortFindings", () => {
  it("returns empty array for empty input", () => {
    expect(sortFindings([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [
      buildFinding({ level: "low", category: "z" }),
      buildFinding({ level: "high", category: "a" }),
    ];
    const inputCopy = [...input];
    sortFindings(input);
    expect(input).toEqual(inputCopy);
  });

  it("sorts by level DESC (critical > high > medium > low)", () => {
    const input = [
      buildFinding({ id: "low-1", level: "low" }),
      buildFinding({ id: "crit-1", level: "critical" }),
      buildFinding({ id: "med-1", level: "medium" }),
      buildFinding({ id: "high-1", level: "high" }),
    ];
    const sorted = sortFindings(input).map((f) => f.level);
    expect(sorted).toEqual(["critical", "high", "medium", "low"]);
  });

  it("breaks level ties by category ASC", () => {
    const input = [
      buildFinding({ id: "1", level: "high", category: "payments" }),
      buildFinding({ id: "2", level: "high", category: "auth" }),
      buildFinding({ id: "3", level: "high", category: "database" }),
    ];
    const sorted = sortFindings(input).map((f) => f.category);
    expect(sorted).toEqual(["auth", "database", "payments"]);
  });

  it("breaks (level, category) ties by id ASC", () => {
    const input = [
      buildFinding({ id: "secrets.z" }),
      buildFinding({ id: "secrets.a" }),
      buildFinding({ id: "secrets.m" }),
    ];
    const sorted = sortFindings(input).map((f) => f.id);
    expect(sorted).toEqual(["secrets.a", "secrets.m", "secrets.z"]);
  });

  it("breaks (level, category, id) ties by file ASC", () => {
    const input = [
      buildFinding({ id: "x", file: "z.ts" }),
      buildFinding({ id: "x", file: "a.ts" }),
      buildFinding({ id: "x", file: "m.ts" }),
    ];
    const sorted = sortFindings(input).map((f) => f.evidence[0]?.file);
    expect(sorted).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("breaks (level, category, id, file) ties by line ASC", () => {
    const input = [
      buildFinding({ id: "x", file: "a.ts", line: 100 }),
      buildFinding({ id: "x", file: "a.ts", line: 10 }),
      buildFinding({ id: "x", file: "a.ts", line: 50 }),
    ];
    const sorted = sortFindings(input).map((f) => f.evidence[0]?.line);
    expect(sorted).toEqual([10, 50, 100]);
  });

  it("treats missing line as 0 (sorts before any numbered line)", () => {
    const input = [
      buildFinding({ id: "x", file: "a.ts", line: 5 }),
      buildFinding({ id: "x", file: "a.ts" }),
    ];
    const sorted = sortFindings(input);
    expect(sorted[0]?.evidence[0]?.line).toBeUndefined();
    expect(sorted[1]?.evidence[0]?.line).toBe(5);
  });

  it("treats missing file as empty string (sorts before any path)", () => {
    const input = [buildFinding({ id: "x", file: "a.ts" }), buildFinding({ id: "x" })];
    const sorted = sortFindings(input);
    expect(sorted[0]?.evidence[0]?.file).toBeUndefined();
    expect(sorted[1]?.evidence[0]?.file).toBe("a.ts");
  });
});

// =============================================================================
// clusterFindings — Pass 1: identity-based dedup
// =============================================================================

describe("clusterFindings — Pass 1: identity-based dedup", () => {
  it("collapses exact duplicates (same id/category/file/line/detail)", () => {
    const f = buildFinding({ id: "secrets.regex", file: "app.ts", line: 10 });
    const result = clusterFindings([f, f, f]);
    expect(result).toHaveLength(1);
    expectAllFindingsSchemaValid(result);
  });

  it("keeps higher-level entry when duplicates have different levels", () => {
    const low = buildFinding({
      id: "secrets.regex",
      level: "low",
      file: "app.ts",
      line: 10,
      detail: "same",
    });
    const critical = buildFinding({
      id: "secrets.regex",
      level: "critical",
      file: "app.ts",
      line: 10,
      detail: "same",
    });
    const result = clusterFindings([low, critical]);
    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe("critical");
    expectAllFindingsSchemaValid(result);
  });

  it("preserves distinct findings with different ids on the same file", () => {
    // Path-classifier-style: same file matches two distinct rules,
    // each emits its own finding with a per-rule id. Dedup MUST NOT
    // collapse them per D40 lock.
    const ruleA = buildFinding({ id: "path-classifier.laravel.env", file: ".env" });
    const ruleB = buildFinding({ id: "path-classifier.next.env", file: ".env" });
    const result = clusterFindings([ruleA, ruleB]);
    expect(result).toHaveLength(2);
    expectAllFindingsSchemaValid(result);
  });

  it("preserves distinct findings with different details on the same file/line", () => {
    // Secrets-style: two distinct occurrences on the same line, each with
    // its own detail identifier (e.g., "pattern X, col 14" vs
    // "pattern X, col 92"). Dedup MUST NOT collapse them per D40 lock.
    const occA = buildFinding({
      id: "secrets.regex",
      file: "app.ts",
      line: 10,
      detail: "GitHub PAT [occurrence 1, col 14]",
    });
    const occB = buildFinding({
      id: "secrets.regex",
      file: "app.ts",
      line: 10,
      detail: "GitHub PAT [occurrence 2, col 92]",
    });
    const result = clusterFindings([occA, occB]);
    expect(result).toHaveLength(2);
    expectAllFindingsSchemaValid(result);
  });

  it("dedup key is delimiter-collision-safe (JSON tuple encoding)", () => {
    // SOH (U+0001, ASCII 0x01) is the delimiter character severity.ts USED
    // to use before the JSON tuple refactor. Building two tuples that
    // collide under naive concatenation around that boundary proves the
    // JSON encoding breaks the tie:
    //
    //   ["x" + SOH + "a", "b",            "app.ts", 10, "same"]
    //   ["x",             "a" + SOH + "b", "app.ts", 10, "same"]
    //
    // Both collapse to:
    //   x + SOH + a + SOH + b + SOH + app.ts + SOH + 10 + SOH + same
    // under naive concatenation. Under JSON.stringify, they remain
    // distinct because array element boundaries are preserved.
    //
    // We construct SOH via String.fromCharCode(0x01) rather than placing a
    // source-level U+0001 escape in a string literal because non-printable
    // escapes are easy for editors, formatters, or copy/paste paths to
    // mishandle. The function-call form keeps the source plain ASCII while
    // still creating the exact delimiter at runtime.
    const SOH = String.fromCharCode(0x01);
    const findingA = buildFinding({
      id: `x${SOH}a`,
      category: "b",
      file: "app.ts",
      line: 10,
      detail: "same",
    });
    const findingB = buildFinding({
      id: "x",
      category: `a${SOH}b`,
      file: "app.ts",
      line: 10,
      detail: "same",
    });
    const result = clusterFindings([findingA, findingB]);
    expect(result).toHaveLength(2);
    expectAllFindingsSchemaValid(result);
  });
});

// =============================================================================
// clusterFindings — Pass 2: per-category cap (≤30 = 29 + 1 summary)
// =============================================================================

describe("clusterFindings — Pass 2: per-category cap", () => {
  it("preserves all findings when count is at or below the cap", () => {
    // Exactly CLUSTER_CAP_PER_CATEGORY: no clustering should occur (the
    // pass fires only on `> CAP`).
    const input: CheckResult[] = [];
    for (let i = 0; i < CLUSTER_CAP_PER_CATEGORY; i++) {
      input.push(buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: "cat-x" }));
    }
    const result = clusterFindings(input);
    expect(result).toHaveLength(CLUSTER_CAP_PER_CATEGORY);
    expect(result.find((r) => r.id === "cluster.cat-x-tail")).toBeUndefined();
    expectAllFindingsSchemaValid(result);
  });

  it("clusters at 35 findings: 29 individual + 1 summary = 30 outputs", () => {
    const input: CheckResult[] = [];
    for (let i = 0; i < 35; i++) {
      input.push(buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: "cat-x" }));
    }
    const result = clusterFindings(input);
    expect(result).toHaveLength(CLUSTER_CAP_PER_CATEGORY);
    expect(result.filter((r) => r.id === "cluster.cat-x-tail")).toHaveLength(1);
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary carries category 'summary' (not the original category)", () => {
    const input: CheckResult[] = [];
    for (let i = 0; i < 35; i++) {
      input.push(buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: "auth" }));
    }
    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.auth-tail");
    expect(summary?.category).toBe("summary");
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary level = max(...dropped.level) via compareLevel", () => {
    // 5 critical + 30 high = 35 in category "auth".
    // KEPT (29 by sort, level DESC) = 5 critical + 24 high.
    // DROPPED (6) = remaining 6 high.
    // Summary level = max(...dropped) = "high".
    const input: CheckResult[] = [];
    for (let i = 0; i < 5; i++) {
      input.push(
        buildFinding({ id: `c${i}`, file: `c${i}.ts`, category: "auth", level: "critical" }),
      );
    }
    for (let i = 0; i < 30; i++) {
      input.push(buildFinding({ id: `h${i}`, file: `h${i}.ts`, category: "auth", level: "high" }));
    }
    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.auth-tail");
    expect(summary?.level).toBe("high");
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary carries a recommendation when level is high/critical", () => {
    const input: CheckResult[] = [];
    for (let i = 0; i < 35; i++) {
      input.push(
        buildFinding({
          id: `f${i}`,
          file: `f${i}.ts`,
          category: "auth",
          level: "high",
          recommendation: `fix ${i}`,
        }),
      );
    }
    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.auth-tail");
    expect(summary?.recommendation).toBeDefined();
    expect(typeof summary?.recommendation).toBe("string");
    expect((summary?.recommendation ?? "").length).toBeGreaterThan(0);
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary evidence[0] uses '+N more findings summarized' product-facing text", () => {
    const input: CheckResult[] = [];
    for (let i = 0; i < 35; i++) {
      input.push(buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: "cat-x" }));
    }
    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.cat-x-tail");
    expect(summary?.evidence[0]?.detail).toMatch(/^\+\d+ more findings summarized$/);
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary user-facing strings use product-facing language (no internal jargon)", () => {
    // Locks the v2 scrub: summary title / message / evidence detail use
    // "summarized" not "clustered", and contain no internal
    // decision-tracking labels (e.g., "D40", "noise budget").
    //
    // Asserts the FULL 3x3 surface — title × message × evidence.detail
    // crossed with the three forbidden tokens (D40, noise budget,
    // clustered) — so a regression in ANY field for ANY token surfaces
    // immediately.
    const input: CheckResult[] = [];
    for (let i = 0; i < 35; i++) {
      input.push(buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: "cat-x" }));
    }
    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.cat-x-tail");
    // Positive: each surface contains the product-facing word "summarized".
    expect(summary?.title).toContain("summarized");
    expect(summary?.message).toContain("summarized");
    expect(summary?.evidence[0]?.detail).toContain("summarized");
    // Negative 3x3: title × {D40, noise budget, clustered}
    expect(summary?.title).not.toContain("D40");
    expect(summary?.title).not.toContain("noise budget");
    expect(summary?.title).not.toContain("clustered");
    // Negative 3x3: message × {D40, noise budget, clustered}
    expect(summary?.message).not.toContain("D40");
    expect(summary?.message).not.toContain("noise budget");
    expect(summary?.message).not.toContain("clustered");
    // Negative 3x3: evidence[0].detail × {D40, noise budget, clustered}
    expect(summary?.evidence[0]?.detail).not.toContain("D40");
    expect(summary?.evidence[0]?.detail).not.toContain("noise budget");
    expect(summary?.evidence[0]?.detail).not.toContain("clustered");
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary evidence file paths are sorted ASCII-asc", () => {
    const input: CheckResult[] = [];
    // Use file paths that need sorting (out of order).
    const paths = ["z.ts", "a.ts", "m.ts", "b.ts"];
    for (let i = 0; i < 35; i++) {
      const file = paths[i % paths.length];
      if (file === undefined) {
        throw new Error("test invariant failed: paths fixture must be non-empty");
      }

      input.push(
        buildFinding({
          id: `f${i}`,
          file,
          category: "cat-x",
        }),
      );
    }
    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.cat-x-tail");
    // evidence[0].file is the FIRST sorted path among dropped findings.
    expect(summary?.evidence[0]?.file).toBe("a.ts");
    expectAllFindingsSchemaValid(result);
  });

  it("does NOT cluster within a category when the cap is not exceeded", () => {
    // Two categories, each with 25 findings. No category exceeds 30, so
    // no clustering should occur in this pass.
    const input: CheckResult[] = [];
    for (let i = 0; i < 25; i++) {
      input.push(buildFinding({ id: `a${i}`, file: `a${i}.ts`, category: "cat-a" }));
    }
    for (let i = 0; i < 25; i++) {
      input.push(buildFinding({ id: `b${i}`, file: `b${i}.ts`, category: "cat-b" }));
    }
    const result = clusterFindings(input);
    expect(result).toHaveLength(50);
    expect(result.find((r) => r.id === "cluster.cat-a-tail")).toBeUndefined();
    expect(result.find((r) => r.id === "cluster.cat-b-tail")).toBeUndefined();
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary evidence caps representative file paths at 10 plus the summary entry", () => {
    // 45 findings in one category. Per-category cap keeps 29 and summarizes
    // 16 dropped findings. Summary evidence should include:
    //   evidence[0]    = descriptive "+N more" entry with first file
    //   evidence[1..] = at most 10 representative file paths
    const input: CheckResult[] = [];
    for (let i = 0; i < 45; i++) {
      const n = String(i).padStart(2, "0");
      input.push(buildFinding({ id: `finding.${n}`, file: `file-${n}.ts`, category: "cat-x" }));
    }

    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.cat-x-tail");
    expect(summary).toBeDefined();
    expect(summary?.evidence).toHaveLength(11);

    const files =
      summary?.evidence
        .map((e) => e.file)
        .filter((file): file is string => typeof file === "string") ?? [];
    expect(files).toHaveLength(11);
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary recommendation uses the first 3 distinct dropped recommendations deterministically", () => {
    // 35 high findings in one category. Per-category cap keeps ids 00..28,
    // drops ids 29..34, then builds the summary recommendation from the
    // first 3 distinct dropped recommendations sorted by [level desc, id asc].
    const input: CheckResult[] = [];
    for (let i = 0; i < 35; i++) {
      const n = String(i).padStart(2, "0");
      input.push(
        buildFinding({
          id: `finding.${n}`,
          file: `file-${n}.ts`,
          category: "auth",
          level: "high",
          recommendation: `rec-${n}`,
        }),
      );
    }

    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.auth-tail");
    expect(summary?.recommendation).toBe("rec-29; rec-30; rec-31");
    expectAllFindingsSchemaValid(result);
  });

  it("cluster summary recommendation is truncated with an ellipsis when it exceeds the cap", () => {
    const input: CheckResult[] = [];
    const longText = "x".repeat(180);
    for (let i = 0; i < 35; i++) {
      const n = String(i).padStart(2, "0");
      input.push(
        buildFinding({
          id: `finding.${n}`,
          file: `file-${n}.ts`,
          category: "auth",
          level: "high",
          recommendation: `rec-${n}-${longText}`,
        }),
      );
    }

    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.auth-tail");
    const recommendation = summary?.recommendation ?? "";
    expect(recommendation.length).toBeLessThanOrEqual(280);
    expect(recommendation.endsWith("…")).toBe(true);
    expectAllFindingsSchemaValid(result);
  });
});

// =============================================================================
// clusterFindings — Pass 3: low-finding global cap (≤20 = 19 + 1 summary)
// =============================================================================

describe("clusterFindings — Pass 3: low-finding global cap", () => {
  it("preserves all lows when count is at or below the cap", () => {
    // 20 lows distributed across 2 categories (each ≤ 30 per-cat cap).
    const input: CheckResult[] = [];
    for (let i = 0; i < 10; i++) {
      input.push(buildFinding({ id: `a${i}`, file: `a${i}.ts`, category: "cat-a", level: "low" }));
    }
    for (let i = 0; i < 10; i++) {
      input.push(buildFinding({ id: `b${i}`, file: `b${i}.ts`, category: "cat-b", level: "low" }));
    }
    const result = clusterFindings(input);
    expect(result.filter((r) => r.level === "low")).toHaveLength(CLUSTER_CAP_LOW);
    expect(result.find((r) => r.id === "cluster.low-tail")).toBeUndefined();
    expectAllFindingsSchemaValid(result);
  });

  it("clusters at 25 lows: keeps the count at exactly the low cap", () => {
    // 25 lows distributed across 3 categories (each ≤ 30 per-cat cap).
    // After low cap fires: 19 individual lows + 1 cluster.low-tail summary
    // (also low) = 20 lows total — matching the cap.
    const input: CheckResult[] = [];
    for (let i = 0; i < 9; i++) {
      input.push(buildFinding({ id: `a${i}`, file: `a${i}.ts`, category: "cat-a", level: "low" }));
    }
    for (let i = 0; i < 8; i++) {
      input.push(buildFinding({ id: `b${i}`, file: `b${i}.ts`, category: "cat-b", level: "low" }));
    }
    for (let i = 0; i < 8; i++) {
      input.push(buildFinding({ id: `c${i}`, file: `c${i}.ts`, category: "cat-c", level: "low" }));
    }
    const result = clusterFindings(input);
    const lows = result.filter((r) => r.level === "low");
    expect(lows).toHaveLength(CLUSTER_CAP_LOW);
    expect(result.filter((r) => r.id === "cluster.low-tail")).toHaveLength(1);
    expectAllFindingsSchemaValid(result);
  });

  it("cluster.low-tail summary has level 'low' by definition", () => {
    const input: CheckResult[] = [];
    for (let i = 0; i < 25; i++) {
      input.push(
        buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: `cat-${i % 3}`, level: "low" }),
      );
    }
    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.low-tail");
    expect(summary?.level).toBe("low");
    expectAllFindingsSchemaValid(result);
  });
});

// =============================================================================
// clusterFindings — Pass 4: total cap (≤90 = 89 + 1 summary)
// =============================================================================

describe("clusterFindings — Pass 4: total cap", () => {
  it("preserves all findings when total is at or below the cap", () => {
    // 80 medium findings spread across 4 categories. No per-cat hit, no
    // low cap (all medium), no total cap (80 < 90).
    const input: CheckResult[] = [];
    for (let i = 0; i < 80; i++) {
      input.push(
        buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: `cat-${i % 4}`, level: "medium" }),
      );
    }
    const result = clusterFindings(input);
    expect(result).toHaveLength(80);
    expect(result.find((r) => r.id === "cluster.tail")).toBeUndefined();
    expectAllFindingsSchemaValid(result);
  });

  it("clusters at 95 findings: 89 individual + 1 summary = 90 outputs", () => {
    // 95 medium findings spread across 4 categories (each ≤ 30 per-cat;
    // none low).
    const input: CheckResult[] = [];
    for (let i = 0; i < 95; i++) {
      input.push(
        buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: `cat-${i % 4}`, level: "medium" }),
      );
    }
    const result = clusterFindings(input);
    expect(result).toHaveLength(CLUSTER_CAP_TOTAL);
    expect(result.filter((r) => r.id === "cluster.tail")).toHaveLength(1);
    expectAllFindingsSchemaValid(result);
  });

  it("cluster.tail summary level = max(...dropped.level) via compareLevel", () => {
    // 5 critical + 90 medium = 95 total.
    // KEPT (89 by sort, level DESC) = 5 critical + 84 medium.
    // DROPPED (6) = remaining 6 medium.
    // Summary level = "medium".
    const input: CheckResult[] = [];
    for (let i = 0; i < 5; i++) {
      input.push(
        buildFinding({
          id: `c${i}`,
          file: `c${i}.ts`,
          category: `cat-${i % 4}`,
          level: "critical",
        }),
      );
    }
    for (let i = 0; i < 90; i++) {
      input.push(
        buildFinding({ id: `m${i}`, file: `m${i}.ts`, category: `cat-${i % 4}`, level: "medium" }),
      );
    }
    const result = clusterFindings(input);
    const summary = result.find((r) => r.id === "cluster.tail");
    expect(summary?.level).toBe("medium");
    expectAllFindingsSchemaValid(result);
  });
});

// =============================================================================
// clusterFindings — pass-ordering invariant
// =============================================================================

describe("clusterFindings — pass-ordering invariant", () => {
  it("dedup happens before per-category cap (duplicates don't inflate count)", () => {
    // 35 identical findings in one category. Dedup collapses to 1 → per-cat
    // cap (30) does not fire.
    const same = buildFinding({
      id: "secrets.regex",
      file: "app.ts",
      line: 10,
      category: "secrets",
    });
    const input = Array.from({ length: 35 }, () => same);
    const result = clusterFindings(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("secrets.regex");
    expectAllFindingsSchemaValid(result);
  });

  it("per-category cap happens before low cap (low count stays at cap)", () => {
    // 35 lows in one category. Per-cat fires first (35 > 30): 29 lows
    // kept + 1 cluster.cat-x-tail (low). Then low cap sees 30 lows → keep
    // ≤20. The exact composition is implementation-determined; what we
    // assert is the OBSERVABLE invariant: total low count never exceeds
    // CLUSTER_CAP_LOW after both passes.
    const input: CheckResult[] = [];
    for (let i = 0; i < 35; i++) {
      input.push(buildFinding({ id: `f${i}`, file: `f${i}.ts`, category: "cat-x", level: "low" }));
    }
    const result = clusterFindings(input);
    const lows = result.filter((r) => r.level === "low");
    expect(lows.length).toBeLessThanOrEqual(CLUSTER_CAP_LOW);
    expectAllFindingsSchemaValid(result);
  });
});
