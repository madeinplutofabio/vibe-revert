// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit + integration tests for packages/checks/src/detectors/test-gap.ts
// (Step 7a file 3).
//
// Coverage strategy:
//
//   1. SCOPE GATE — files matched by a path rule with non-empty
//      testSiblingPatterns. Files not matching any rule, files
//      matching rules without testSiblingPatterns (e.g.,
//      laravel.migrations, generic.lockfiles), and rule matches
//      gated out by framework detection all return 0 findings.
//
//   2. POSITIVE EMISSION — single risky file without a sibling
//      test in the diff fires; multiple risky files across
//      distinct rules fire with distinct per-rule ids per D40's
//      identity-based dedup convention.
//
//   3. SIBLING SUPPRESSION (any-status coverage) — the rule
//      suppresses on ANY paired test change in the diff: ADDED,
//      MODIFIED, DELETED, or RENAMED. The deletion case is the
//      flagship "paired-deletion lock" — when a risky file is
//      deleted alongside its test, the finding correctly does
//      NOT fire, matching the detector's locked deletion
//      semantics.
//
//   4. SELF-SKIP INVARIANT (j === i lock) — a single-file diff
//      where the file matches BOTH its own rule AND its own
//      testSiblingPatterns. Pre-skip, sibling search would find
//      the file itself and suppress; post-skip, the finding
//      fires. Uses `app/api/billing.test.ts` — a real overlap in
//      current PATH_RULES (matches next.payment-api-files via
//      `*billing*.{ts,js}` AND that rule's testSiblingPatterns
//      `**/*.test.{ts,tsx,js}`).
//
//   5. FINDING SHAPE — id format `test-gap.<rule.id>`, level
//      "high", confidence "medium", category "test-gap",
//      non-empty recommendation containing the locked "Add or
//      update" + "paired test changes" wording (deletion-
//      semantics regression lock per the user's locked
//      correction).
//
//   6. PATH NORMALIZATION — Windows backslash paths normalized
//      through to evidence.file (CheckResultSchema's
//      safeStoredRelativePath would reject `\`); sibling matching
//      also normalizes both sides so a Windows-style sibling
//      test path correctly suppresses a Windows-style risky path.
//
//   7. EDGE CASES — binary risky file fires (test-gap does NOT
//      skip binaries — locked design, distinct from
//      migrations/secrets line-grep detectors); deleted risky
//      file without paired test deletion still fires (locked
//      deletion semantics).
//
// =============================================================================
// CRITICAL TEST DISCIPLINE — `configChecks: { tests: true }` +
// EXPLICIT `detectedFrameworks`
// =============================================================================
//
// Every test that calls runChecks MUST set `tests: true` in
// configChecks (else D28 Layer 1 skips the check and 0 findings is
// returned for the wrong reason). The ctxFor helper below defaults
// to { tests: true }. NOTE: the toggle key for test-gap is `tests`
// (mirrors the .viberevert.yml convention) — the EMITTED category
// is "test-gap", but the toggle key is `tests`. Mixing these up
// silently disables the check.
//
// `detectedFrameworks` is EXPLICIT per test (no hidden default like
// ["laravel", "nextjs"]) because the path-classifier scope gate is
// part of the detector's behavior. Hidden defaults could mask
// framework-gating bugs. The convenience wrappers (laravelCtx,
// nextjsCtx, railsCtx, noFrameworkCtx) make the framework choice
// visible at the call site.
//
// =============================================================================
// Test pipeline: isolated `runChecks([testGapCheck], ctx)` — same
// future-detector-brittleness avoidance as Step 4 (secrets), Step 5
// (dependencies), Step 6 (migrations).

import { describe, expect, it } from "vitest";

import { testGapCheck } from "../../src/detectors/test-gap.js";
import type { ChangedFileInput, CheckContext, ChecksToggleConfig } from "../../src/index.js";
import { runChecks } from "../../src/index.js";

// =============================================================================
// Local helpers
// =============================================================================

/** ChangedFileInput with no added lines (status defaults to "modified"). */
function pathOnly(path: string): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines: [],
    removedLines: [],
    isBinary: false,
  };
}

/** ChangedFileInput with added lines (status defaults to "added" — typical for new files). */
function withAddedLines(
  path: string,
  addedLines: readonly { line: number; text: string }[],
): ChangedFileInput {
  return {
    path,
    status: "added",
    addedLines,
    removedLines: [],
    isBinary: false,
  };
}

/**
 * ChangedFileInput with explicit status override. Default-empty
 * `addedLines` (small divergence from migrations.test.ts's strict
 * required form) reflects the test-gap detector's design: it does
 * NOT read addedLines, so empty is the COMMON case for status-only
 * coverage tests (modified-without-content, deleted, etc.). Tests
 * that need content can still pass it explicitly.
 */
function withStatus(
  path: string,
  status: ChangedFileInput["status"],
  addedLines: readonly { line: number; text: string }[] = [],
): ChangedFileInput {
  return {
    path,
    status,
    addedLines,
    removedLines: [],
    isBinary: false,
  };
}

/**
 * ChangedFileInput for a renamed file. Carries the required
 * `previous_path` field per the ChangedFileInput contract for
 * status: "renamed". Not in migrations.test.ts because migrations
 * doesn't exercise rename status — test-gap's sibling-suppression
 * coverage matrix requires it (rename-into-sibling-location is a
 * locked any-status suppression case).
 */
function renamedFile(
  path: string,
  previousPath: string,
  addedLines: readonly { line: number; text: string }[] = [],
): ChangedFileInput {
  return {
    path,
    previous_path: previousPath,
    status: "renamed",
    addedLines,
    removedLines: [],
    isBinary: false,
  };
}

/**
 * Binary ChangedFileInput. test-gap intentionally does NOT skip
 * binaries (distinct from migrations/secrets which DO skip them) —
 * the detector keys off path classification, not line content, so a
 * binary middleware file is still a middleware change.
 */
function binaryFile(path: string): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines: [],
    removedLines: [],
    isBinary: true,
  };
}

/**
 * Build a CheckContext with explicit `detectedFrameworks`. Defaults
 * `configChecks` to `{ tests: true }` so D28 Layer 1 does NOT
 * short-circuit testGapCheck.
 */
function ctxFor(
  files: readonly ChangedFileInput[],
  detectedFrameworks: readonly string[],
  configChecks: ChecksToggleConfig = { tests: true },
): CheckContext {
  return { changedFiles: files, detectedFrameworks, configChecks };
}

// Convenience wrappers per ecosystem. Keep the framework gate
// visible at the call site — a hidden multi-framework default would
// mask the scope-gate behavior these tests are validating.
const laravelCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, ["laravel"]);
const nextjsCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, ["nextjs"]);
const railsCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, ["rails"]);
const noFrameworkCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, []);

// =============================================================================
// SECTION 1: scope gate — files matched by a rule WITH testSiblingPatterns
// =============================================================================

describe("testGapCheck — scope gate", () => {
  it("empty changedFiles → 0 findings", () => {
    const result = runChecks([testGapCheck], laravelCtx([]));
    expect(result.results).toEqual([]);
  });

  it("file matching no path rule → 0 findings", () => {
    const result = runChecks(
      [testGapCheck],
      laravelCtx([withAddedLines("src/utils/helper.ts", [])]),
    );
    expect(result.results).toEqual([]);
  });

  it("file matching a path rule WITHOUT testSiblingPatterns (laravel.migrations) → 0 findings", () => {
    // laravel.migrations matches `database/migrations/**` and has
    // NO testSiblingPatterns (migrations have no canonical
    // sibling-test convention). The detector's per-rule skip
    // correctly bypasses such rules.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_create.php", [{ line: 1, text: "<?php" }]),
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("file matching a path rule WITHOUT testSiblingPatterns (generic.lockfiles) → 0 findings", () => {
    // generic.lockfiles is framework-agnostic and has no
    // testSiblingPatterns. Locks the empty/undefined check on the
    // detector's rule-skip branch.
    const result = runChecks([testGapCheck], laravelCtx([withAddedLines("package-lock.json", [])]));
    expect(result.results).toEqual([]);
  });

  it("Laravel middleware path WITHOUT 'laravel' detected → 0 findings (classifyPath framework gate)", () => {
    // classifyPath itself enforces framework gating — the Laravel
    // rule has framework: "laravel" and only participates when the
    // CLI passes "laravel" in detectedFrameworks. The detector
    // doesn't re-check framework state; it trusts classifyPath.
    const result = runChecks(
      [testGapCheck],
      noFrameworkCtx([withAddedLines("app/Http/Middleware/AuthMiddleware.php", [])]),
    );
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// SECTION 2: positive emission
// =============================================================================

describe("testGapCheck — positive emission (risky file without sibling test fires)", () => {
  it("Laravel middleware ADDED without sibling test → emits test-gap.laravel.middleware", () => {
    const result = runChecks(
      [testGapCheck],
      laravelCtx([withAddedLines("app/Http/Middleware/AuthMiddleware.php", [])]),
    );
    expect(result.results.some((r) => r.id === "test-gap.laravel.middleware")).toBe(true);
  });

  it("two risky files matched by DIFFERENT rules, neither with siblings → two distinct findings (per-rule ids)", () => {
    // Locks the D40 per-rule id convention end-to-end: distinct
    // rules emit distinct ids, dedup preserves both. The middleware
    // and auth-controller files have DIFFERENT testSiblingPatterns
    // (`tests/Feature/**` vs `tests/Feature/Auth/**`), so neither
    // file's sibling pattern is satisfied by the other.
    //
    // Filter by category instead of asserting raw length: future
    // D40 cluster summaries (category: "summary") could land in
    // result.results without breaking the per-rule-id contract
    // this test exists to lock. Same idiom as migrations.test.ts's
    // multi-finding tests.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([
        withAddedLines("app/Http/Middleware/AuthMiddleware.php", []),
        withAddedLines("app/Http/Controllers/Auth/LoginController.php", []),
      ]),
    );
    const testGapIds = result.results
      .filter((r) => r.category === "test-gap")
      .map((r) => r.id)
      .sort();

    expect(testGapIds).toEqual([
      "test-gap.laravel.auth-controllers",
      "test-gap.laravel.middleware",
    ]);
  });
});

// =============================================================================
// SECTION 3: sibling suppression (any-status coverage)
// =============================================================================

describe("testGapCheck — sibling suppression (ANY-status paired test change suppresses)", () => {
  it("risky middleware ADDED + sibling test ADDED in same diff → 0 findings", () => {
    const result = runChecks(
      [testGapCheck],
      laravelCtx([
        withAddedLines("app/Http/Middleware/AuthMiddleware.php", []),
        withAddedLines("tests/Feature/AuthMiddlewareTest.php", []),
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("risky middleware MODIFIED + sibling test MODIFIED in same diff → 0 findings", () => {
    const result = runChecks(
      [testGapCheck],
      laravelCtx([
        withStatus("app/Http/Middleware/AuthMiddleware.php", "modified"),
        withStatus("tests/Feature/AuthMiddlewareTest.php", "modified"),
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("risky middleware DELETED + sibling test DELETED in same diff → 0 findings (PAIRED-DELETION LOCK)", () => {
    // The flagship locked-deletion-semantics test. Per the
    // detector's run() JSDoc: when a deletion IS accompanied by
    // the corresponding test deletion, the sibling search finds
    // the deleted test file (still present in changedFiles) and
    // suppresses the finding correctly.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([
        withStatus("app/Http/Middleware/AuthMiddleware.php", "deleted"),
        withStatus("tests/Feature/AuthMiddlewareTest.php", "deleted"),
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("risky middleware ADDED + sibling test RENAMED into testSiblingPatterns → 0 findings", () => {
    // A test file renamed into (or kept inside) the sibling
    // location still appears in changedFiles with the new path
    // matching the pattern → counts as coverage. The detector
    // matches on `f.path` (the new path), so renames work
    // naturally.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([
        withAddedLines("app/Http/Middleware/AuthMiddleware.php", []),
        renamedFile("tests/Feature/RenamedAuthTest.php", "tests/Feature/OldAuthTest.php"),
      ]),
    );
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// SECTION 4: self-skip invariant (j === i lock)
// =============================================================================

describe("testGapCheck — self-skip invariant (j === i lock)", () => {
  it("single-file diff matching its OWN rule AND OWN testSiblingPattern → STILL fires", () => {
    // The flagship j === i regression lock. `app/api/billing.test.ts`
    // matches BOTH:
    //   - next.payment-api-files rule (pattern
    //     `{app,pages}/api/**/*{billing,...}*.{ts,js}` accepts
    //     `billing.test.ts` because `*billing*.ts` is "any chars
    //     containing 'billing' ending in .ts" — picomatch's `*`
    //     includes dots)
    //   - that rule's testSiblingPatterns `**/*.test.{ts,tsx,js}`
    //     (matches `app/api/billing.test.ts`)
    //
    // Without the j === i skip, the sibling search would find the
    // file itself and incorrectly suppress. With the skip, the
    // finding fires correctly — a file cannot satisfy its own
    // test-gap.
    const result = runChecks(
      [testGapCheck],
      nextjsCtx([withAddedLines("app/api/billing.test.ts", [])]),
    );
    expect(result.results.some((r) => r.id === "test-gap.next.payment-api-files")).toBe(true);
  });
});

// =============================================================================
// SECTION 5: finding shape (locked contract)
// =============================================================================

describe("testGapCheck — finding shape (D40 + M B schema enforcement locks)", () => {
  it("finding has id 'test-gap.<rule.id>', category 'test-gap', level 'high', confidence 'medium'", () => {
    const result = runChecks(
      [testGapCheck],
      laravelCtx([withAddedLines("app/Http/Middleware/AuthMiddleware.php", [])]),
    );
    const finding = result.results.find((r) => r.id === "test-gap.laravel.middleware");
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.category).toBe("test-gap");
    expect(finding.level).toBe("high");
    expect(finding.confidence).toBe("medium");
  });

  it("finding has non-empty recommendation (M B CheckResultSchema refine: high level requires recommendation)", () => {
    const result = runChecks(
      [testGapCheck],
      laravelCtx([withAddedLines("app/Http/Middleware/AuthMiddleware.php", [])]),
    );
    const finding = result.results.find((r) => r.id === "test-gap.laravel.middleware");
    expect(finding?.recommendation).toBeDefined();
    expect(finding?.recommendation?.length ?? 0).toBeGreaterThan(0);
  });

  it("recommendation uses 'Add or update' + 'paired test changes' wording (deletion-semantics lock)", () => {
    // Regression lock per the user's locked correction to the
    // detector: any-status sibling coverage means the recommendation
    // must NOT say "Add sibling tests" alone — it must allow for
    // updates/deletions. If a future maintainer reverts the wording
    // to "addition", this test fails.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([withAddedLines("app/Http/Middleware/AuthMiddleware.php", [])]),
    );
    const finding = result.results.find((r) => r.id === "test-gap.laravel.middleware");
    expect(finding?.recommendation).toContain("Add or update");
    expect(finding?.recommendation).toContain("paired test changes");
  });

  it("evidence[0] has file + detail 'path-rule: <rule.id>'", () => {
    const result = runChecks(
      [testGapCheck],
      laravelCtx([withAddedLines("app/Http/Middleware/AuthMiddleware.php", [])]),
    );
    const finding = result.results.find((r) => r.id === "test-gap.laravel.middleware");
    expect(finding?.evidence[0]?.file).toBe("app/Http/Middleware/AuthMiddleware.php");
    expect(finding?.evidence[0]?.detail).toBe("path-rule: laravel.middleware");
  });
});

// =============================================================================
// SECTION 6: path normalization
// =============================================================================

describe("testGapCheck — path normalization (Windows backslashes)", () => {
  it("Windows backslash risky path → evidence.file normalized to POSIX (matches CheckResultSchema)", () => {
    // CheckResultSchema's safeStoredRelativePath rejects backslash
    // paths via D28 layer-2 validation. The detector normalizes
    // via the shared normalizePathSeparators helper.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([withAddedLines("app\\Http\\Middleware\\AuthMiddleware.php", [])]),
    );
    const finding = result.results.find((r) => r.id === "test-gap.laravel.middleware");
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence[0]?.file).toBe("app/Http/Middleware/AuthMiddleware.php");
    expect(finding.evidence[0]?.file).not.toContain("\\");
  });

  it("Windows backslash on BOTH risky AND sibling-test paths → sibling suppression still works", () => {
    // Locks the rule that BOTH sides of the sibling comparison
    // pre-normalize before classification AND before picomatch
    // matching. A Windows-shaped sibling test path correctly
    // suppresses a Windows-shaped risky path.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([
        withAddedLines("app\\Http\\Middleware\\AuthMiddleware.php", []),
        withAddedLines("tests\\Feature\\AuthMiddlewareTest.php", []),
      ]),
    );
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// SECTION 7: edge cases
// =============================================================================

describe("testGapCheck — edge cases", () => {
  it("binary risky file → STILL fires (test-gap does NOT skip binaries — locked design)", () => {
    // Unlike migrations/secrets (line-grep detectors that skip
    // binaries because they scan content), test-gap is a
    // composition-style detector keyed off path classification.
    // Binary files MUST still be checked for sibling tests —
    // conceptually a binary middleware file is still a middleware
    // change. Locked design choice.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([binaryFile("app/Http/Middleware/AuthMiddleware.php")]),
    );
    expect(result.results.some((r) => r.id === "test-gap.laravel.middleware")).toBe(true);
  });

  it("deleted risky file WITHOUT paired test deletion → fires (locked deletion semantics)", () => {
    // Per the detector's run() JSDoc: "a deleted Laravel controller
    // without a paired test deletion in the same diff is a
    // legitimate test-gap signal (the corresponding test file should
    // have been deleted too)."
    const result = runChecks(
      [testGapCheck],
      laravelCtx([withStatus("app/Http/Middleware/AuthMiddleware.php", "deleted")]),
    );
    expect(result.results.some((r) => r.id === "test-gap.laravel.middleware")).toBe(true);
  });

  it("Rails controller MODIFIED without sibling test → emits test-gap.rails.controllers (framework-coverage smoke)", () => {
    // Smoke test for the rails ecosystem to lock that framework
    // wrappers other than Laravel work end-to-end. rails.controllers
    // pattern `app/controllers/**` with testSiblingPatterns
    // `["spec/controllers/**", "test/controllers/**"]`.
    const result = runChecks(
      [testGapCheck],
      railsCtx([withStatus("app/controllers/users_controller.rb", "modified")]),
    );
    expect(result.results.some((r) => r.id === "test-gap.rails.controllers")).toBe(true);
  });

  it("pathOnly modified middleware (no addedLines) → fires (content not required)", () => {
    // Locks that test-gap does NOT depend on addedLines content —
    // path classification alone is sufficient. A status: "modified"
    // file with empty addedLines (the pathOnly helper's shape) still
    // fires when not paired with a sibling.
    const result = runChecks(
      [testGapCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")]),
    );
    expect(result.results.some((r) => r.id === "test-gap.laravel.middleware")).toBe(true);
  });
});
