// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// D28 toggle-behavior regression tests for the path-classifier check
// (Step 3, file 7).
//
// What this file locks (PROTECTS AGAINST):
//
//   1. Layer 1 pre-run skip when ALL of
//      pathClassifierCheck.emittedCategories are disabled. The engine
//      inspects emittedCategories ∩ enabled-set; if empty, the check's
//      run() is NEVER invoked. Tests 1 and 2 prove this via vi.fn spy
//      on .run — the spy MUST NOT be called.
//
//   2. Layer 1 skip works under TWO equivalent input shapes:
//        - All 8 toggles explicitly set to false (test 1)
//        - Empty config object (test 2)
//      These exercise different code paths in deriveEnabledCategories
//      (the explicit-false branch vs the missing-key branch via
//      `configChecks[key] === true`) but produce the same enabled-set
//      = empty → same Layer 1 skip outcome. Locking both confirms a
//      future refactor doesn't accidentally change one branch's
//      semantics while leaving the other intact.
//
//   3. The engine's DIRECT classifier call (which populates
//      riskTagsByPath INDEPENDENTLY of check.run()) ALSO honors the
//      Layer 2 toggle filter. With no categories enabled, the
//      `if (!enabledCategories.has(rule.category)) continue` inside
//      the riskTagsByPath loop drops every rule's tags → empty tag
//      array per file. Tests 1 and 2 assert riskTagsByPath.get(".env")
//      is [] (NOT the laravel.env+next.env tags that would appear
//      under enabled toggles). A regression where the riskTagsByPath
//      pass ignored the toggle filter would let disabled-category
//      tags leak through silently — the spy assertion alone is silent
//      about that failure mode. Same logic for riskLevelByPath:
//      "low" by default, never bumped because no pre-cluster findings
//      survived to bump it.
//
//   4. Layer 1 PASS + Layer 2 KEEP ALL (control baseline, test 3).
//      With all 8 toggles true and 3 paths producing findings in 3
//      different categories, every finding survives Layer 2 → 3
//      findings in results. This proves the partial-drop test below
//      is anchored to a real "Layer 2 selectively drops" scenario,
//      not to Layer 1 silently short-circuiting (which would ALSO
//      produce the empty result that mistests for "Layer 2 dropped
//      everything").
//
//   5. Layer 1 PASS + Layer 2 SELECTIVE DROP across multiple
//      categories (test 4). Distinct from file 5 test 5 (which tests
//      Layer 2 dropping MULTI-RULE same-category findings when that
//      category is disabled). File 7 test 4 tests Layer 2
//      SELECTIVITY across different categories: secrets+auth enabled
//      but migrations (=> database) disabled, paths producing all
//      three category findings → only secrets + auth findings
//      survive, database finding (path-classifier.laravel.migrations)
//      is explicitly asserted ABSENT. A regression where Layer 2
//      ignored the per-finding category filter would let migration
//      findings through.
//
//      ALSO asserts Layer 2 selectivity propagates UNIFORMLY to the
//      per-file maps: riskTagsByPath drops disabled-category tags via
//      the engine's direct classifier loop (so the migration path
//      gets [] tags despite laravel.migrations matching it);
//      riskLevelByPath stays "low" for the disabled path because the
//      dropped finding never bumped it. A regression where Layer 2
//      only filtered the findings array (and not riskTagsByPath OR
//      riskLevelByPath) would let disabled categories leak through
//      via the per-file maps even when the findings list correctly
//      excludes them — the per-file map assertions catch that failure
//      mode that the findings-array assertion alone is blind to.
//
//   6. CHECKS_TOGGLE_MAP fan-out semantics (test 5). A single toggle
//      key (`infra`) maps to MULTIPLE categories (`infra` AND
//      `deployment`). With only { infra: true }, BOTH categories'
//      findings should survive Layer 2. A regression where toggle
//      keys only enabled their primary category (and ignored the
//      array-valued fan-out) would drop the deployment finding here
//      despite the user enabling its toggle.
//
//      Test 5 ALSO asserts BOTH rule categories explicitly
//      (generic.dockerfile → infra, generic.gh-actions → deployment)
//      via an id→category map. Without this, a regression that
//      re-categorized one of the rules (e.g., generic.gh-actions
//      drifted from "deployment" to "infra") could let the test pass
//      on the id-list alone — both findings would survive enabling
//      "infra", but the test would no longer be exercising the
//      fan-out behavior it claims to lock. Asserting both id AND
//      category makes the test semantically airtight.
//
// Test pipeline: tests 1, 2 use the wrapped-spy `[check]` pattern
// (same as file 5 test 5) because the spy assertion is load-bearing
// — empty results would also occur under Layer 2 drop without the
// spy, losing the Layer 1 skip regression guard. Tests 3, 4, 5 use
// bare `[pathClassifierCheck]` because their non-empty result
// assertions are themselves sufficient proof that Layer 1 ran
// (empty results would fail the assertions immediately, by
// construction).
//
// Why `[pathClassifierCheck]` instead of `BUILTIN_CHECKS`: same
// future-detector-brittleness rationale as files 5 and 6 — tight
// id-list assertions would break under Step 4-7+ additions that
// might emit on the same paths. Isolating to [pathClassifierCheck]
// (or its spy wrap) keeps the test behavior stable.
//
// Disambiguation from sibling test files:
//   - path-rules.test.ts (file 4): matcher-level rule coverage.
//   - multi-match.test.ts (file 5): engine-level multi-rule
//     SURVIVAL through the full pipeline; test 5 covers ONE Layer 2
//     case where multi-rule SAME-category findings are all dropped.
//   - engine-risktags.test.ts (file 6): per-file aggregation map
//     survival through D40 clustering.
//   - path-classifier-toggle.test.ts (THIS FILE): D28 Layer 1 vs
//     Layer 2 toggle behavior across MULTIPLE combinations,
//     including Layer 1 skip (with classifier-direct-call toggle
//     compliance), Layer 2 cross-category selectivity (with uniform
//     per-file-map application), and CHECKS_TOGGLE_MAP fan-out
//     (with rule-category locking).

import { describe, expect, it, vi } from "vitest";

import { pathClassifierCheck } from "../src/classifiers/path-classifier-check.js";
import type { ChangedFileInput, Check, CheckContext, ChecksToggleConfig } from "../src/index.js";
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
// Tests 1-2: Layer 1 skip (spy-locked)
// =============================================================================

describe("path-classifier toggle behavior — D28 Layer 1 skip when all emittedCategories disabled", () => {
  it("all 8 toggles explicit false → spy NOT called, results empty, per-file maps reflect disabled state", () => {
    const runSpy = vi.fn(pathClassifierCheck.run);
    const check: Check = { ...pathClassifierCheck, run: runSpy };

    const result = runChecks(
      [check],
      ctxFor([".env"], ["laravel", "nextjs"], {
        secrets: false,
        dependencies: false,
        migrations: false,
        auth: false,
        payments: false,
        infra: false,
        tests: false,
        scope_expansion: false,
      }),
    );

    // Layer 1 skip: spy proves check.run was NEVER invoked.
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);

    // Per-file map invariants: even though the engine's direct
    // classify call would normally populate riskTagsByPath from
    // laravel.env+next.env (both matching .env under detected
    // frameworks), the Layer 2 toggle filter inside the
    // riskTagsByPath loop drops every disabled-category rule's
    // tags. Result: no tags leak through. Same for riskLevelByPath
    // — defaults to "low" because no findings survived to bump it.
    expect(result.riskTagsByPath.get(".env")).toEqual([]);
    expect(result.riskLevelByPath.get(".env")).toBe("low");
  });

  it("empty config object → spy NOT called, results empty, per-file maps reflect disabled state", () => {
    // Exercises the OTHER code path in deriveEnabledCategories:
    // missing keys (configChecks[key] === undefined !== true → not
    // enabled). Functionally equivalent to all-false above, but a
    // different branch in the toggle-config processor — locking
    // both confirms a future refactor doesn't accidentally change
    // one branch's semantics while leaving the other intact.
    const runSpy = vi.fn(pathClassifierCheck.run);
    const check: Check = { ...pathClassifierCheck, run: runSpy };

    const result = runChecks([check], ctxFor([".env"], ["laravel", "nextjs"], {}));

    expect(runSpy).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.riskTagsByPath.get(".env")).toEqual([]);
    expect(result.riskLevelByPath.get(".env")).toBe("low");
  });
});

// =============================================================================
// Tests 3-4: Layer 1 pass + Layer 2 behavior
// =============================================================================

describe("path-classifier toggle behavior — D28 Layer 2 per-finding filter (all enabled vs selective)", () => {
  it("all 8 toggles true → all findings across multiple categories survive (control baseline)", () => {
    // Three paths each matching ONE rule in a different category:
    //   - .env                                       → laravel.env (secrets/high)
    //   - app/Http/Middleware/Authenticate.php       → laravel.middleware (auth/high)
    //   - database/migrations/...users_table.php     → laravel.migrations (database/high)
    // With all 8 toggles enabled, every finding survives Layer 2.
    // Anchors test 4 below to a real "Layer 2 selectively dropped"
    // scenario — without this control, test 4's "2 findings survive"
    // result could equally be explained by Layer 1 having dropped
    // findings silently.
    const paths = [
      ".env",
      "app/Http/Middleware/Authenticate.php",
      "database/migrations/2026_01_01_000000_create_users_table.php",
    ];
    const result = runChecks(
      [pathClassifierCheck],
      ctxFor(paths, ["laravel"], {
        secrets: true,
        dependencies: true,
        migrations: true,
        auth: true,
        payments: true,
        infra: true,
        tests: true,
        scope_expansion: true,
      }),
    );

    // All 3 findings survive Layer 2 — one per path/category.
    // Sorted alphabetically by id for deterministic compare.
    expect(result.results.map((r) => r.id).sort()).toEqual([
      "path-classifier.laravel.env",
      "path-classifier.laravel.middleware",
      "path-classifier.laravel.migrations",
    ]);
  });

  it("partial enable (secrets+auth, NOT migrations) → secrets+auth findings survive, database finding dropped, per-file maps reflect Layer 2 selectivity uniformly", () => {
    // Cross-category selectivity: 3 paths each producing a finding
    // in a DIFFERENT category (secrets, auth, database). With
    // configChecks enabling secrets+auth but NOT migrations (which
    // toggles `database`), Layer 2 should drop the database finding
    // specifically while keeping the other two.
    //
    // Distinct from file 5 test 5: that test drops multi-rule
    // SAME-category findings when that category is disabled. THIS
    // test drops a single finding when its specific category is
    // disabled while OTHER categories' findings survive.
    //
    // Path constants extracted so the per-file-map assertions below
    // reference the same literals without repetition (and avoid
    // noUncheckedIndexedAccess type noise from paths[N]).
    const envPath = ".env";
    const middlewarePath = "app/Http/Middleware/Authenticate.php";
    const migrationPath = "database/migrations/2026_01_01_000000_create_users_table.php";
    const paths = [envPath, middlewarePath, migrationPath];

    const result = runChecks(
      [pathClassifierCheck],
      ctxFor(paths, ["laravel"], {
        secrets: true,
        auth: true,
        migrations: false,
      }),
    );

    // Two findings survive — secrets + auth.
    expect(result.results.map((r) => r.id).sort()).toEqual([
      "path-classifier.laravel.env",
      "path-classifier.laravel.middleware",
    ]);
    // Explicit negative: database finding is GONE. A regression
    // where Layer 2 ignored the per-finding filter would let
    // path-classifier.laravel.migrations through despite migrations:
    // false — the negative assertion makes that regression fail
    // with a precise diagnostic rather than a less obvious
    // length-mismatch.
    expect(result.results.some((r) => r.id === "path-classifier.laravel.migrations")).toBe(false);

    // Per-file maps reflect Layer 2 selectivity UNIFORMLY across the
    // findings array AND the engine's direct classifier loop. A
    // regression that filtered the findings array but skipped the
    // toggle check inside the riskTagsByPath loop would let
    // disabled-category tags leak through (e.g., migration path
    // would carry ["database", "migration"] tags despite the
    // database category being disabled). riskLevelByPath stays
    // "low" for the disabled path because the dropped finding never
    // bumped it past the default initialization.

    // Enabled — .env (laravel.env, secrets/high, tags: ["env"]):
    expect(result.riskTagsByPath.get(envPath)).toEqual(["env"]);
    expect(result.riskLevelByPath.get(envPath)).toBe("high");

    // Enabled — middleware (laravel.middleware, auth/high, tags
    // sorted alphabetically: ["auth", "middleware"]):
    expect(result.riskTagsByPath.get(middlewarePath)).toEqual(["auth", "middleware"]);
    expect(result.riskLevelByPath.get(middlewarePath)).toBe("high");

    // Disabled — migration (laravel.migrations, database/high →
    // dropped by Layer 2; per-file maps reflect the disabled state):
    expect(result.riskTagsByPath.get(migrationPath)).toEqual([]);
    expect(result.riskLevelByPath.get(migrationPath)).toBe("low");
  });
});

// =============================================================================
// Test 5: CHECKS_TOGGLE_MAP fan-out
// =============================================================================

describe("path-classifier toggle behavior — CHECKS_TOGGLE_MAP fan-out (single toggle enables multiple categories)", () => {
  it("infra:true enables BOTH 'infra' AND 'deployment' categories → findings under both survive (id AND category locked)", () => {
    // Per CHECKS_TOGGLE_MAP: `infra: ["infra", "deployment"]`. So
    // enabling the `infra` toggle key fans out to TWO categories. A
    // regression where toggle keys only enabled their primary
    // category (and ignored the array-valued fan-out) would drop
    // the deployment finding here despite the user enabling its
    // toggle.
    //
    // Paths use generic always-on rules (no framework gating), so
    // detectedFrameworks: [] is sufficient.
    const paths = [
      "Dockerfile", // → generic.dockerfile (infra/high)
      ".github/workflows/ci.yml", // → generic.gh-actions (deployment/high)
    ];
    const result = runChecks([pathClassifierCheck], ctxFor(paths, [], { infra: true }));

    // BOTH findings survive — the infra toggle enabled both
    // categories through CHECKS_TOGGLE_MAP fan-out.
    expect(result.results.map((r) => r.id).sort()).toEqual([
      "path-classifier.generic.dockerfile",
      "path-classifier.generic.gh-actions",
    ]);

    // Category lock: assert each finding's category explicitly.
    // Without this, a regression that re-categorized
    // generic.gh-actions (e.g., to "infra") would let the id-list
    // assertion above pass — both findings would still survive
    // because both categories are enabled — but the test would no
    // longer be exercising the fan-out behavior it claims to lock.
    // Asserting (id → category) makes the test semantically airtight.
    expect(Object.fromEntries(result.results.map((r) => [r.id, r.category]))).toEqual({
      "path-classifier.generic.dockerfile": "infra",
      "path-classifier.generic.gh-actions": "deployment",
    });
  });
});
