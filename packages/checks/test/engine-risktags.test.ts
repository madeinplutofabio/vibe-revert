// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Engine-level per-file aggregation survival regression tests for the
// path-classifier check (Step 3, file 6).
//
// What this file locks (PROTECTS AGAINST):
//
//   1. The D28 invariant that `RunChecksResult.riskTagsByPath` and
//      `RunChecksResult.riskLevelByPath` are POST-Layer-2 toggle but
//      PRE-clustering. Per the locked engine pipeline:
//        - riskTagsByPath: populated by the engine's DIRECT
//          `classify(file.path, frameworks)` call inside the engine
//          loop — INDEPENDENT of pathClassifierCheck.run() AND of
//          the D40 cluster pass.
//        - riskLevelByPath: populated by walking preClusterFindings
//          (the POST-toggle, PRE-cluster pool). Cluster summaries
//          are constructed AFTER preClusterFindings is finalized and
//          do NOT contribute to this map.
//      Both maps therefore reflect the COMPLETE per-file picture even
//      when individual findings get swept into a `cluster.*-tail`
//      summary by D40's per-category cap (>30 findings/category).
//
//   2. Specific regression failure modes:
//
//      a. Future engine refactor moves riskTagsByPath computation
//         INSIDE the cluster pass → all clustered-away files would
//         lose their tags silently. Test 2's per-file riskTagsByPath
//         assertion for the targetPath catches this.
//
//      b. Future engine refactor uses clusterFindings() output
//         (post-cluster `results`) to seed riskLevelByPath → all
//         paths swept into the cluster summary would default to
//         "low" instead of inheriting "high" from their original
//         findings. Test 2's per-file riskLevelByPath assertion for
//         targetPath catches this.
//
//      c. Future change to D40's per-category cap that doesn't
//         account for per-file aggregation independence. Test 2's
//         triangulated cap-fire assertions (results.length === 30,
//         individual finding count === 29, cluster.deployment-tail
//         existence) together prove the cap fired AS EXPECTED, so
//         the per-file map assertions are anchored to a real
//         cap-fire scenario rather than a degenerate case where
//         clustering didn't actually fire.
//
//   3. The default state for unmatched paths. Test 3 locks that the
//      engine initializes EVERY changed-file path in both maps even
//      when no rule matches — riskTagsByPath gets `[]`,
//      riskLevelByPath gets "low". A future refactor that lazily
//      populated these maps (and thus omitted unmatched paths
//      entirely) would silently drop downstream consumer
//      expectations.
//
// Test pipeline: real `runChecks([pathClassifierCheck], ctx)`. This
// isolates the invariant from future built-in detectors while still
// exercising the real engine, real classifier check, real PATH_RULES,
// real clustering, and real map aggregation. No spies needed — the
// assertions on the returned maps are themselves load-bearing
// diagnostics. Using BUILTIN_CHECKS here would make the tight count
// assertions (results.length === 30, individual count === 29) brittle
// once Steps 4-7+ add detectors that might legitimately emit on the
// same changed files — failures unrelated to the invariant this file
// locks. Isolating to [pathClassifierCheck] removes that entire
// failure mode by construction. Paths use `.github/workflows/ci-*.yml`
// because `generic.gh-actions` is always-on (no framework gating),
// has a single deterministic tag (`ci`) and level (`high`), and
// keeps all 35 findings in ONE category (so we force the
// per-category cap rather than the global low-cap or total-cap).
//
// SORT-ORDER NOTE for test 2: path filenames are zero-padded to two
// digits (ci-01.yml .. ci-35.yml) so the engine's ASCII-asc `file`
// sort key aligns with numeric order. Without padding, the
// lexicographic sort would put ci-4.yml..ci-9.yml at sort positions
// 30-35 (the clustered tail) instead of ci-30.yml..ci-35.yml,
// making the targetPath = "ci-35.yml" assertion produce a
// false-positive pass under regressions that didn't actually cluster
// the intended file.
//
// Disambiguation from sibling test files:
//   - path-rules.test.ts (file 4): matcher-level rule coverage.
//   - multi-match.test.ts (file 5): engine-level multi-rule SURVIVAL
//     through the full runChecks pipeline.
//   - engine-risktags.test.ts (THIS FILE): per-file aggregation map
//     survival through D40 clustering pass.
//   - path-classifier-toggle.test.ts (file 7, next): D28 Layer 1 vs
//     Layer 2 behavior on the umbrella check across all toggle
//     combinations.

import { describe, expect, it } from "vitest";

import { pathClassifierCheck } from "../src/classifiers/path-classifier-check.js";
import type { ChangedFileInput, CheckContext, ChecksToggleConfig } from "../src/index.js";
import { runChecks } from "../src/index.js";

// =============================================================================
// Test fixtures: minimal ChangedFileInput + CheckContext helpers
// =============================================================================

/**
 * Builds a minimal ChangedFileInput. path-classifier only reads
 * `.path`, but the engine accepts the full shape, so this helper
 * supplies schema-valid defaults for the rest. Status "modified" is a
 * neutral default that doesn't bias any current check.
 */
function pathOnly(path: string): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines: [],
    removedLines: [],
    isBinary: false,
  };
}

/**
 * Convenience: build a CheckContext from path list + framework list +
 * toggle config.
 */
function ctxFor(
  paths: readonly string[],
  detectedFrameworks: readonly string[],
  configChecks: ChecksToggleConfig,
): CheckContext {
  return {
    changedFiles: paths.map(pathOnly),
    detectedFrameworks,
    configChecks,
  };
}

// =============================================================================
// Test 1: baseline (no clustering, control)
// =============================================================================

describe("engine per-file aggregation — baseline (clustering does not fire)", () => {
  it("3 deployment files produce 3 individual findings, riskTagsByPath + riskLevelByPath both fully populated", () => {
    const paths = [
      ".github/workflows/ci-1.yml",
      ".github/workflows/ci-2.yml",
      ".github/workflows/ci-3.yml",
    ];
    const result = runChecks([pathClassifierCheck], ctxFor(paths, [], { infra: true }));

    // Exactly 3 individual findings — far below the D40 per-category
    // cap of 30, so no clustering fires.
    expect(result.results.length).toBe(3);
    expect(result.results.every((r) => r.id === "path-classifier.generic.gh-actions")).toBe(true);
    expect(result.results.every((r) => r.category === "deployment")).toBe(true);
    expect(result.results.every((r) => r.level === "high")).toBe(true);
    // Control: NO cluster summary appears. Proves the baseline is
    // genuinely below the clustering threshold, so test 2's clustering
    // assertions are anchored to a real cap-fire scenario.
    expect(result.results.some((r) => r.id === "cluster.deployment-tail")).toBe(false);

    // riskTagsByPath: each of 3 paths has ["ci"] (the tag declared by
    // generic.gh-actions).
    expect(result.riskTagsByPath.size).toBe(3);
    for (const p of paths) {
      expect(result.riskTagsByPath.get(p)).toEqual(["ci"]);
    }

    // riskLevelByPath: each of 3 paths has "high" (defaultLevel of
    // generic.gh-actions).
    expect(result.riskLevelByPath.size).toBe(3);
    for (const p of paths) {
      expect(result.riskLevelByPath.get(p)).toBe("high");
    }
  });
});

// =============================================================================
// Test 2: clustering active — both per-file maps survive
// =============================================================================

describe("engine per-file aggregation — clustering preserves riskTagsByPath AND riskLevelByPath", () => {
  it("35 deployment files trigger D40 per-category cap, but BOTH per-file maps still carry data for every path INCLUDING the clustered-away targetPath", () => {
    const N = 35;
    // Zero-pad so ASCII-asc file sort matches numeric order —
    // guarantees ci-35.yml lands at sort position 35 (clustered away)
    // rather than position 29 (last individual survivor under
    // unpadded lexicographic sort). Without padding,
    // ci-4.yml..ci-9.yml would be the clustered tail and ci-35.yml
    // would still appear as an individual finding, defeating the
    // targetPath assertion.
    const paths = Array.from(
      { length: N },
      (_, i) => `.github/workflows/ci-${String(i + 1).padStart(2, "0")}.yml`,
    );
    // Defined as a literal (not paths[N - 1]) to keep the type as
    // `string` under noUncheckedIndexedAccess-style strict mode AND
    // to make the test's specific target self-documenting.
    const targetPath = ".github/workflows/ci-35.yml";

    const result = runChecks([pathClassifierCheck], ctxFor(paths, [], { infra: true }));

    // D40 per-category cap fired: 30 results total = 29 individual + 1 summary.
    expect(result.results.length).toBe(30);
    expect(result.results.some((r) => r.id === "cluster.deployment-tail")).toBe(true);

    // Triangulation: exactly 29 individual path-classifier findings
    // survive (the rest were clustered into the summary). Together
    // with results.length === 30 and the summary-exists assertion,
    // this proves "29 individual + exactly 1 summary" — a regression
    // that produced (say) 28 individuals + 2 summaries, or 30
    // individuals + 0 summaries, would fail this assertion AND one
    // of the others, with a precise diagnostic on each.
    expect(
      result.results.filter((r) => r.id === "path-classifier.generic.gh-actions"),
    ).toHaveLength(29);

    // Sharpness: targetPath was clustered away — no individual
    // finding for it remains in results.
    expect(
      result.results.some(
        (r) => r.id === "path-classifier.generic.gh-actions" && r.evidence[0]?.file === targetPath,
      ),
    ).toBe(false);

    // LOAD-BEARING: even though targetPath's individual finding was
    // clustered away from results, its per-file aggregation in BOTH
    // maps STILL survives. This is the D28 invariant being locked —
    // clustering does NOT collapse per-file aggregation.
    expect(result.riskTagsByPath.get(targetPath)).toEqual(["ci"]);
    expect(result.riskLevelByPath.get(targetPath)).toBe("high");

    // Bulk invariants: all 35 entries present in both maps with
    // correct values (not just targetPath).
    expect(result.riskTagsByPath.size).toBe(N);
    expect(result.riskLevelByPath.size).toBe(N);
    for (const p of paths) {
      expect(result.riskTagsByPath.get(p)).toEqual(["ci"]);
      expect(result.riskLevelByPath.get(p)).toBe("high");
    }
  });
});

// =============================================================================
// Test 3: unmatched paths get defaults
// =============================================================================

describe("engine per-file aggregation — unmatched paths receive default entries", () => {
  it("paths matching no rule still appear in riskTagsByPath ([]) and riskLevelByPath ('low')", () => {
    const paths = ["src/utils/helper.ts", "docs/README.md"];
    const result = runChecks([pathClassifierCheck], ctxFor(paths, [], { infra: true }));

    // No rule matches these paths → no findings.
    expect(result.results).toEqual([]);

    // riskTagsByPath: entries still initialized for every changed
    // file, with [] for unmatched. Locks the engine's "initialize all
    // changed-file paths, then update from classifier output" pattern.
    expect(result.riskTagsByPath.size).toBe(2);
    for (const p of paths) {
      expect(result.riskTagsByPath.get(p)).toEqual([]);
    }

    // riskLevelByPath: entries still initialized for every changed
    // file, with "low" as the default level. Locks the engine's
    // "initialize all paths to low, then bump from findings" pattern.
    expect(result.riskLevelByPath.size).toBe(2);
    for (const p of paths) {
      expect(result.riskLevelByPath.get(p)).toBe("low");
    }
  });
});
