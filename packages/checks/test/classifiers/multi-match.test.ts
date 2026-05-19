// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Engine-level multi-rule survival regression tests for the
// path-classifier check (Step 3, file 5).
//
// What this file locks (PROTECTS AGAINST):
//
//   1. D40 identity-based dedup collapsing distinct multi-rule
//      findings. A path that matches multiple rules (e.g. .env
//      matching BOTH laravel.env AND next.env when both frameworks
//      are detected) produces multiple findings. The D40 dedup tuple
//      is (result.id, category, evidence[0].file, .line, .detail).
//      For these findings to be distinct under that tuple, they MUST
//      have different result.id values. pathClassifierCheck achieves
//      this via the `path-classifier.<rule.id>` namespacing
//      convention. REGRESSION GUARD: if someone changes
//      pathClassifierCheck to emit a generic id, both findings share
//      the same tuple, dedup collapses one silently → tests 1 + 2
//      fail.
//
//   2. Engine round-trip preservation. The matcher returning multiple
//      rules (locked by file 4) is necessary but not sufficient. The
//      full engine pipeline (validate → toggle-filter → dedup →
//      cluster → sort) MUST preserve the multi-rule output as two
//      distinct findings end-to-end. file 4 locks the matcher-level
//      invariant; this file locks the engine-level invariant. Both
//      are required because regressions can happen at either layer.
//
//   3. M B CheckResultSchema high/critical recommendation refine. The
//      laravel.env + next.env rules both have defaultLevel "high".
//      Every emitted finding MUST carry a non-empty recommendation;
//      otherwise the engine's CheckResultSchema.parse() throws. We
//      assert `r.recommendation.trim().length > 0` (non-blank) on
//      every positive finding to lock the END-USER contract
//      end-to-end. A weaker `typeof === "string"` check would pass
//      for the degenerate empty-string case; the trim-length check
//      catches that AND whitespace-only cases AND undefined (via
//      optional chaining short-circuiting to undefined which is not
//      > 0). A schema throw would surface elsewhere as a less
//      obvious failure; this assertion gives a precise diagnostic.
//
//   4. D28 Layer 2 per-finding toggle filter on multi-rule output
//      (SPY-LOCKED). With Layer 1 letting the check run (via
//      auth: true enabling one of pathClassifierCheck.emittedCategories),
//      Layer 2 MUST drop the resulting secrets findings (secrets:
//      false). The vi.fn spy on pathClassifierCheck.run proves the
//      check actually ran (Layer 1 didn't short-circuit), so empty
//      results are attributable to Layer 2 specifically — not to
//      accidental Layer 1 skip. Without the spy, the test would pass
//      under either Layer 1 skip OR Layer 2 drop, losing the Layer 2
//      regression guard.
//
//   5. Exclude patterns continue to fire AT ENGINE LEVEL, not just
//      matcher level. file 4 proves the matcher applies excludes;
//      this file proves nothing in the engine pipeline accidentally
//      reintroduces excluded findings (e.g., a buggy clustering pass
//      that synthesizes findings from raw matches).
//
//   6. Framework gating is consistent at engine level. file 4 proves
//      the matcher honors framework gating; this file proves the
//      engine doesn't bypass it (e.g., a buggy classifier injection
//      that ignores ctx.detectedFrameworks).
//
// Test pipeline: all five tests use `runChecks([pathClassifierCheck], ctx)`.
// Tests 1-4 use the bare check; test 5 uses a vi.fn spy wrapping
// pathClassifierCheck.run to make the Layer 2 proof airtight (the
// spy lets us distinguish "Layer 1 ran the check" from "Layer 1
// skipped" — both produce empty results otherwise, and only the spy
// can tell them apart).
//
// Why `[pathClassifierCheck]` instead of `BUILTIN_CHECKS`: tight
// assertions like `result.results.map((r) => r.id).sort().toEqual(...)`
// would become brittle once Steps 4-7+ add detectors that might
// legitimately emit on the same `.env` paths — failures unrelated to
// the multi-rule survival invariant this file locks. Isolating to
// `[pathClassifierCheck]` removes that entire failure mode by
// construction while still exercising the real engine, real
// classifier check, real PATH_RULES, real D40 dedup/clustering/sort,
// and real D28 Layer 2 toggle filter. The same isolation discipline
// is applied in file 6 (engine-risktags.test.ts) for the same
// reason.
//
// Disambiguation from sibling test files:
//   - path-rules.test.ts (file 4): matcher-level rule coverage.
//   - multi-match.test.ts (THIS FILE): engine-level multi-rule
//     SURVIVAL through the full runChecks pipeline.
//   - engine-risktags.test.ts (file 6, next): riskTagsByPath
//     survival through D40 clustering pass (different invariant —
//     per-file aggregation must not be collapsed by clustering).
//   - path-classifier-toggle.test.ts (file 7, last): D28 Layer 1
//     vs Layer 2 behavior on the umbrella check across all toggle
//     combinations (broader than this file's single Layer 2 case).

import { describe, expect, it, vi } from "vitest";

import { pathClassifierCheck } from "../../src/classifiers/path-classifier-check.js";
import type { ChangedFileInput, Check, CheckContext, ChecksToggleConfig } from "../../src/index.js";
import { runChecks } from "../../src/index.js";

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
 * toggle config. `task` is omitted (optional in CheckContext, not
 * required by path-classifier or any other check that runs in these
 * tests).
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
// Positive multi-rule survival (isolated [pathClassifierCheck] pipeline)
// =============================================================================

describe("multi-rule survival — engine round-trip preserves distinct findings", () => {
  it("'.env' under [laravel, nextjs] + secrets:true produces TWO distinct findings (one per matched rule)", () => {
    const result = runChecks(
      [pathClassifierCheck],
      ctxFor([".env"], ["laravel", "nextjs"], { secrets: true }),
    );

    // D40 distinctness: per-rule ids keep the dedup tuple distinct.
    // Sorted compare so a future change to engine sort order doesn't
    // break this assertion (engine sort is independent of distinctness).
    expect(result.results.map((r) => r.id).sort()).toEqual([
      "path-classifier.laravel.env",
      "path-classifier.next.env",
    ]);
    // Both findings are secrets/high per PATH_RULES defaults.
    expect(result.results.every((r) => r.category === "secrets")).toBe(true);
    expect(result.results.every((r) => r.level === "high")).toBe(true);
    // M B CheckResultSchema refine: high/critical findings MUST carry
    // a NON-BLANK recommendation. The engine's schema.parse() would
    // have thrown if any finding violated this; we assert non-blank
    // (not just `typeof === "string"`) here to lock the END-USER
    // contract end-to-end. An empty string would pass typeof but
    // provide no actionable guidance — the trim-length check catches
    // empty, whitespace-only, AND undefined-via-optional-chain.
    expect(
      result.results.every(
        (r) => typeof r.recommendation === "string" && r.recommendation.trim().length > 0,
      ),
    ).toBe(true);
  });

  it("'apps/web/.env.local' (nested) under [laravel, nextjs] + secrets:true produces TWO distinct findings (alternation branches survive engine)", () => {
    const result = runChecks(
      [pathClassifierCheck],
      ctxFor(["apps/web/.env.local"], ["laravel", "nextjs"], { secrets: true }),
    );

    expect(result.results.map((r) => r.id).sort()).toEqual([
      "path-classifier.laravel.env",
      "path-classifier.next.env",
    ]);
    expect(result.results.every((r) => r.category === "secrets")).toBe(true);
    expect(result.results.every((r) => r.level === "high")).toBe(true);
    expect(
      result.results.every(
        (r) => typeof r.recommendation === "string" && r.recommendation.trim().length > 0,
      ),
    ).toBe(true);
  });
});

// =============================================================================
// Negative: matcher-level negation persists through engine
// =============================================================================

describe("multi-rule survival — matcher-level negatives survive engine round-trip", () => {
  it("'.env.example' under [laravel, nextjs] + secrets:true produces ZERO findings (exclude patterns fire at engine level)", () => {
    // Locks: the engine pipeline does NOT bypass rule-level excludes.
    // A regression in the engine that ignored excludes (e.g. a faulty
    // clustering pass that synthesizes findings from raw matches)
    // would surface here.
    const result = runChecks(
      [pathClassifierCheck],
      ctxFor([".env.example"], ["laravel", "nextjs"], { secrets: true }),
    );
    expect(result.results).toEqual([]);
  });

  it("'.env' under [laravel] only + secrets:true produces ONE finding (framework gating drops next.env)", () => {
    // Locks: the engine pipeline honors framework gating. Without
    // 'nextjs' in detectedFrameworks, next.env MUST be gated out even
    // when secrets is enabled and the path matches its include
    // pattern.
    const result = runChecks(
      [pathClassifierCheck],
      ctxFor([".env"], ["laravel"], { secrets: true }),
    );

    expect(result.results.map((r) => r.id)).toEqual(["path-classifier.laravel.env"]);
    expect(result.results[0]?.category).toBe("secrets");
    expect(result.results[0]?.level).toBe("high");
    // Non-blank recommendation via optional chain (results[0] is the
    // single surviving finding). If recommendation is missing,
    // `?.trim().length` short-circuits to undefined and the
    // toBeGreaterThan(0) assertion fails.
    expect(result.results[0]?.recommendation?.trim().length).toBeGreaterThan(0);
  });
});

// =============================================================================
// D28 Layer 2 per-finding toggle filter (spy-locked)
// =============================================================================

describe("multi-rule survival — D28 Layer 2 toggle filter drops findings whose category is disabled", () => {
  it("Layer 2 drops secrets findings when secrets:false BUT another emitted category (auth) is enabled (spy proves Layer 1 ran)", () => {
    // Setup:
    //  - configChecks = { secrets: false, auth: true } → enabled set = {auth}.
    //  - pathClassifierCheck.emittedCategories includes both "auth"
    //    and "secrets" (the union across PATH_RULES categories).
    //  - Layer 1 inspects emittedCategories ∩ enabled set: "auth" is
    //    in both → check RUNS. We prove this with the runSpy
    //    assertion.
    //  - pathClassifierCheck.run on ".env" emits two findings, BOTH
    //    category "secrets" (laravel.env + next.env).
    //  - Layer 2 inspects each finding's category against the enabled
    //    set: "secrets" is NOT enabled → BOTH dropped.
    //  - Result: spy called once + empty results = the ONLY pipeline
    //    that could have produced that outcome is Layer 2 firing.
    //
    // Without the spy, this test would pass even if Layer 1 had
    // incorrectly short-circuited (also producing empty results) —
    // we'd silently lose the Layer 2 regression guard. The spy
    // distinguishes the two cases by construction.
    //
    // vi.fn(impl) wraps the real run with a spy that preserves the
    // implementation. When the engine invokes check.run(ctx), the
    // real pathClassifierCheck.run executes (emitting the two
    // secrets findings) AND the call is recorded for the assertion.
    const runSpy = vi.fn(pathClassifierCheck.run);
    const check: Check = { ...pathClassifierCheck, run: runSpy };

    const result = runChecks(
      [check],
      ctxFor([".env"], ["laravel", "nextjs"], { secrets: false, auth: true }),
    );

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([]);
  });
});
