// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit + integration tests for packages/checks/src/detectors/scope-expansion.ts
// (Step 7b file 3).
//
// Coverage strategy:
//
//   1. TRIGGER GATES — D37's multiple short-circuit guards:
//      undefined task, short task, padded short task (TRIM-GATE
//      LOCK from the user's locked correction), zero-token task,
//      zero-token file path (graceful skip alongside valid files).
//
//   2. POSITIVE EMISSION per risky category — one test per
//      category in the locked RISKY_CATEGORIES set (auth,
//      payments, database, infra, deployment). Each test uses a
//      realistic path + framework combination matching a real
//      PATH_RULES entry.
//
//   3. HIGH-OVERLAP SUPPRESSION — task tokens matching file
//      tokens push overlap >= 0.1, suppressing the finding even
//      on risky-category files.
//
//   4. PER-CATEGORY AGGREGATION — multi-file aggregation with
//      deterministic [overlap asc, file asc] evidence ordering;
//      cross-category emission with alphabetical category sort;
//      cap at 5 evidence entries + "+N more" message tail.
//
//   5. NON-RISKY CATEGORIES — secrets/dependencies files do NOT
//      contribute even at zero overlap (per D37 RISKY_CATEGORIES
//      lock). Future non-risky path categories should follow the
//      same rule.
//
//   6. FINDING SHAPE — id format `scope-expansion.<category>`,
//      level "high", confidence "medium", category
//      "scope-expansion", non-empty recommendation with locked
//      "Review the listed files" wording, evidence with POSIX
//      file path + "overlap: <0.NN>" detail format.
//
//   7. PATH NORMALIZATION — Windows backslash paths normalized
//      through to evidence.file (CheckResultSchema's
//      safeStoredRelativePath would reject `\`).
//
//   8. BOUNDARY CASES — trimmed task length 8 passes the
//      MIN_TASK_LENGTH gate; length 7 fails it.
//
// =============================================================================
// CRITICAL TEST DISCIPLINE — `configChecks: { scope_expansion: true }` +
// EXPLICIT `detectedFrameworks` + EXPLICIT `task`
// =============================================================================
//
// Every test that calls runChecks MUST set `scope_expansion: true`
// in configChecks (else D28 Layer 1 skips the check and 0 findings
// is returned for the wrong reason). The ctxFor helper below
// defaults to { scope_expansion: true }.
//
// NOTE: the toggle key for scope-expansion is `scope_expansion`
// (underscore, mirrors .viberevert.yml YAML key convention) — the
// EMITTED category is `scope-expansion` (hyphen), but the toggle
// key is `scope_expansion`. Mixing these up silently disables the
// check.
//
// `detectedFrameworks` is EXPLICIT per test (no hidden default)
// because the path-classifier scope gate is part of the detector's
// behavior — hidden defaults could mask framework-gating bugs.
//
// `task` is EXPLICIT per test (no hidden default like "Fix the
// thing") because the algorithm operates ENTIRELY on the task
// string. Hidden defaults could mask trigger-gate bugs OR
// overlap-calculation bugs. The convenience wrappers
// (laravelCtx, railsCtx, noFrameworkCtx) accept task as the
// second positional argument; tests intentionally testing the
// undefined-task gate simply omit it. ctxFor uses a conditional
// spread so the resulting CheckContext omits the `task` key
// entirely when no task is provided (rather than setting it to
// `undefined`) — matches the "present-iff-defined" pattern from
// D31 and works cleanly under exactOptionalPropertyTypes.
//
// =============================================================================
// Test pipeline: isolated `runChecks([scopeExpansionCheck], ctx)` — same
// future-detector-brittleness avoidance as Steps 4-7a.

import { describe, expect, it } from "vitest";

import { scopeExpansionCheck } from "../../src/detectors/scope-expansion.js";
import type { ChangedFileInput, CheckContext, ChecksToggleConfig } from "../../src/index.js";
import { runChecks } from "../../src/index.js";

// =============================================================================
// Local helpers
// =============================================================================

/**
 * Minimal ChangedFileInput for scope-expansion tests. The detector
 * keys off path + classification only — status, addedLines,
 * removedLines, and isBinary are all ignored. `pathOnly` is the
 * only file-shape helper we need.
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
 * Build a CheckContext with explicit `detectedFrameworks` and
 * optional `task`. Defaults `configChecks` to
 * `{ scope_expansion: true }` so D28 Layer 1 does NOT short-circuit
 * scopeExpansionCheck. Task is positional-third (more commonly
 * varied than configChecks).
 *
 * Conditional spread on `task`: the returned object OMITS the
 * `task` key entirely when no task was passed (rather than setting
 * `task: undefined`). Matches the schema's "present-iff-defined"
 * pattern (cf. D31's `staged_only`) and works cleanly under
 * exactOptionalPropertyTypes.
 */
function ctxFor(
  files: readonly ChangedFileInput[],
  detectedFrameworks: readonly string[],
  task?: string,
  configChecks: ChecksToggleConfig = { scope_expansion: true },
): CheckContext {
  const base = { changedFiles: files, detectedFrameworks, configChecks };
  return task === undefined ? base : { ...base, task };
}

// Convenience wrappers per ecosystem. Task accepted as positional
// second arg; tests testing the undefined-task gate omit it.
const laravelCtx = (files: readonly ChangedFileInput[], task?: string) =>
  ctxFor(files, ["laravel"], task);
const railsCtx = (files: readonly ChangedFileInput[], task?: string) =>
  ctxFor(files, ["rails"], task);
const noFrameworkCtx = (files: readonly ChangedFileInput[], task?: string) =>
  ctxFor(files, [], task);

// =============================================================================
// SECTION 1: trigger gates
// =============================================================================

describe("scopeExpansionCheck — trigger gates", () => {
  it("ctx.task undefined → 0 findings (gate a)", () => {
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")]),
    );
    expect(result.results).toEqual([]);
  });

  it("ctx.task = 'Fix' (length 3 < MIN_TASK_LENGTH) → 0 findings (gate b)", () => {
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "Fix"),
    );
    expect(result.results).toEqual([]);
  });

  it("ctx.task = '   fix   ' (length 9 BUT trimmed length 3) → 0 findings (TRIM-GATE LOCK)", () => {
    // The flagship trim-gate regression lock per the user's locked
    // correction. Pre-trim, length 9 would have bypassed the floor;
    // post-trim, the gate correctly rejects the semantically-short
    // "fix". If a future maintainer removes the trim, this fails.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "   fix   "),
    );
    expect(result.results).toEqual([]);
  });

  it("ctx.task = '!!!  !!!' (length 8 passes gate b BUT zero tokens after tokenize) → 0 findings (gate c)", () => {
    // Length 8 passes the trimmed-length floor (gate b), but
    // tokenizeTask yields {} because all characters are
    // non-alphanumeric. The zero-token guard fires before the
    // per-file loop.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "!!!  !!!"),
    );
    expect(result.results).toEqual([]);
  });

  it("file with zero extractable path tokens mixed with valid risky file → only valid file produces findings (gate d)", () => {
    // The path `_/.x` tokenizes to {} (separators consume the `_`
    // and `.`; `x` is < MIN_TOKEN_LENGTH). The per-file zero-token
    // guard skips this file's overlap calc (avoids divide-by-zero
    // NaN). The valid auth file in the same diff still produces
    // its scope-expansion finding.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx(
        [pathOnly("_/.x"), pathOnly("app/Http/Middleware/AuthMiddleware.php")],
        "Update homepage styling",
      ),
    );
    const ids = result.results
      .filter((r) => r.category === "scope-expansion")
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(["scope-expansion.auth"]);
  });
});

// =============================================================================
// SECTION 2: positive emission per risky category
// =============================================================================

describe("scopeExpansionCheck — positive emission per risky category", () => {
  it("auth: Laravel middleware with low-overlap task → emits scope-expansion.auth", () => {
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "Update homepage styling"),
    );
    expect(result.results.some((r) => r.id === "scope-expansion.auth")).toBe(true);
  });

  it("payments: Laravel billing controller with low-overlap task → emits scope-expansion.payments", () => {
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx(
        [pathOnly("app/Http/Controllers/Billing/CheckoutController.php")],
        "Update homepage styling",
      ),
    );
    expect(result.results.some((r) => r.id === "scope-expansion.payments")).toBe(true);
  });

  it("database: Rails migration with low-overlap task → emits scope-expansion.database", () => {
    const result = runChecks(
      [scopeExpansionCheck],
      railsCtx([pathOnly("db/migrate/20260101000000_create_users.rb")], "Update homepage styling"),
    );
    expect(result.results.some((r) => r.id === "scope-expansion.database")).toBe(true);
  });

  it("infra: Dockerfile with low-overlap task → emits scope-expansion.infra", () => {
    // generic.dockerfile is framework-agnostic — noFrameworkCtx
    // suffices.
    const result = runChecks(
      [scopeExpansionCheck],
      noFrameworkCtx([pathOnly("Dockerfile")], "Update homepage styling"),
    );
    expect(result.results.some((r) => r.id === "scope-expansion.infra")).toBe(true);
  });

  it("deployment: GitHub Actions workflow with low-overlap task → emits scope-expansion.deployment", () => {
    // generic.gh-actions is framework-agnostic.
    const result = runChecks(
      [scopeExpansionCheck],
      noFrameworkCtx([pathOnly(".github/workflows/deploy.yml")], "Update homepage styling"),
    );
    expect(result.results.some((r) => r.id === "scope-expansion.deployment")).toBe(true);
  });
});

// =============================================================================
// SECTION 3: high-overlap suppression
// =============================================================================

describe("scopeExpansionCheck — high-overlap suppression (overlap >= 0.1 → no finding)", () => {
  it("auth file with task containing 'middleware' → overlap 0.2 → 0 findings", () => {
    // Task tokens: {"fix", "authentication", "middleware"}
    // Path tokens: {"app", "http", "middleware", "authmiddleware", "php"}
    // Intersection: {"middleware"} → 1 / 5 = 0.20 >= 0.10 → suppressed.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx(
        [pathOnly("app/Http/Middleware/AuthMiddleware.php")],
        "Fix authentication middleware",
      ),
    );
    expect(result.results).toEqual([]);
  });

  it("payments file with task containing 'billing' → overlap > 0.1 → 0 findings", () => {
    // Task tokens: {"fix", "billing", "checkout", "flow"}
    // Path tokens: {"app", "http", "controllers", "billing",
    //               "checkoutcontroller", "php"}
    // Intersection: {"billing"} → 1 / 6 ≈ 0.167 >= 0.10 → suppressed.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx(
        [pathOnly("app/Http/Controllers/Billing/CheckoutController.php")],
        "Fix billing checkout flow",
      ),
    );
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// SECTION 4: per-category aggregation
// =============================================================================

describe("scopeExpansionCheck — per-category aggregation", () => {
  it("multiple files in same category → ONE finding with [overlap asc, file asc] evidence ordering", () => {
    // Files passed in NON-alphabetical order to prove the detector
    // sorts internally (not by changedFiles insertion order). All
    // have overlap 0, so file path is the tiebreaker.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx(
        [
          pathOnly("app/Http/Middleware/CsrfMiddleware.php"),
          pathOnly("app/Http/Middleware/AuthMiddleware.php"),
          pathOnly("app/Http/Middleware/SessionMiddleware.php"),
        ],
        "Update homepage styling",
      ),
    );
    const finding = result.results.find((r) => r.id === "scope-expansion.auth");
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence).toHaveLength(3);
    const paths = finding.evidence.map((e) => e.file);
    expect(paths).toEqual([
      "app/Http/Middleware/AuthMiddleware.php",
      "app/Http/Middleware/CsrfMiddleware.php",
      "app/Http/Middleware/SessionMiddleware.php",
    ]);
    expect(finding.message).toBe("3 files in the auth area had low overlap with the task");
  });

  it("files across THREE risky categories → 3 findings emitted in alphabetical id order", () => {
    // auth (laravel.middleware) + payments (laravel.billing-controllers)
    // + deployment (generic.gh-actions, framework-agnostic). All
    // share framework gating: laravel detected enables auth +
    // payments; deployment requires no framework. Expected emission
    // order via the detector's `[...keys].sort()`: auth, deployment,
    // payments — and the engine's final sort by [level, category, id]
    // preserves the same order.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx(
        [
          pathOnly("app/Http/Middleware/AuthMiddleware.php"),
          pathOnly("app/Http/Controllers/Billing/CheckoutController.php"),
          pathOnly(".github/workflows/deploy.yml"),
        ],
        "Update homepage styling",
      ),
    );
    const ids = result.results.filter((r) => r.category === "scope-expansion").map((r) => r.id);
    expect(ids).toEqual([
      "scope-expansion.auth",
      "scope-expansion.deployment",
      "scope-expansion.payments",
    ]);
  });

  it("7 files in same category → ONE finding with 5 evidence entries + '+2 more' message tail (MAX_EVIDENCE cap)", () => {
    // The MAX_EVIDENCE_PER_CATEGORY=5 cap test. 7 distinct auth
    // files → 5 evidence (sorted alphabetically by basename) +
    // "+2 more" tail in the message. Total count "7 files" appears
    // verbatim in the message.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx(
        [
          pathOnly("app/Http/Middleware/M1.php"),
          pathOnly("app/Http/Middleware/M2.php"),
          pathOnly("app/Http/Middleware/M3.php"),
          pathOnly("app/Http/Middleware/M4.php"),
          pathOnly("app/Http/Middleware/M5.php"),
          pathOnly("app/Http/Middleware/M6.php"),
          pathOnly("app/Http/Middleware/M7.php"),
        ],
        "Update homepage styling",
      ),
    );
    const finding = result.results.find((r) => r.id === "scope-expansion.auth");
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence).toHaveLength(5);
    expect(finding.message).toContain("7 files");
    expect(finding.message).toContain("+2 more");
  });
});

// =============================================================================
// SECTION 5: non-risky categories don't fire
// =============================================================================

describe("scopeExpansionCheck — non-risky categories don't fire (RISKY_CATEGORIES lock)", () => {
  it("secrets file (laravel.env: '.env') with zero overlap → 0 findings (secrets not in RISKY_CATEGORIES)", () => {
    // `.env` matches laravel.env (category "secrets") when Laravel
    // is detected. "secrets" is NOT in RISKY_CATEGORIES per D37 —
    // those are owned by the secrets detector, not scope-expansion.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly(".env")], "Update homepage styling"),
    );
    expect(result.results).toEqual([]);
  });

  it("dependencies file ('package.json') with zero overlap → 0 findings (dependencies not in RISKY_CATEGORIES)", () => {
    // package.json matches generic.manifests (category
    // "dependencies", framework-agnostic). "dependencies" is NOT
    // in RISKY_CATEGORIES — owned by the dependencies detector.
    const result = runChecks(
      [scopeExpansionCheck],
      noFrameworkCtx([pathOnly("package.json")], "Update homepage styling"),
    );
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// SECTION 6: finding shape (locked contract)
// =============================================================================

describe("scopeExpansionCheck — finding shape (D40 + M B schema enforcement locks)", () => {
  it("finding has id 'scope-expansion.<category>', category 'scope-expansion', level 'high', confidence 'medium'", () => {
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "Update homepage styling"),
    );
    const finding = result.results.find((r) => r.id === "scope-expansion.auth");
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.category).toBe("scope-expansion");
    expect(finding.level).toBe("high");
    expect(finding.confidence).toBe("medium");
  });

  it("finding has non-empty recommendation with locked 'Review the listed files' + 'scope expansion' wording", () => {
    // Regression lock for the locked recommendation text. If a
    // future maintainer drops "Review the listed files" or "scope
    // expansion", this fails.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "Update homepage styling"),
    );
    const finding = result.results.find((r) => r.id === "scope-expansion.auth");
    expect(finding?.recommendation).toBeDefined();
    expect(finding?.recommendation?.length ?? 0).toBeGreaterThan(0);
    expect(finding?.recommendation).toContain("Review the listed files");
    expect(finding?.recommendation).toContain("scope expansion");
  });

  it("evidence[0] has file (POSIX) + detail 'overlap: 0.00' format (locked format string)", () => {
    // With "Update homepage styling" task and AuthMiddleware.php
    // path, intersection is 0 → overlap is exactly 0.00. The
    // locked format `overlap: ${overlap.toFixed(2)}` produces
    // "overlap: 0.00".
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "Update homepage styling"),
    );
    const finding = result.results.find((r) => r.id === "scope-expansion.auth");
    expect(finding?.evidence[0]?.file).toBe("app/Http/Middleware/AuthMiddleware.php");
    expect(finding?.evidence[0]?.detail).toBe("overlap: 0.00");
  });
});

// =============================================================================
// SECTION 7: path normalization
// =============================================================================

describe("scopeExpansionCheck — path normalization (Windows backslashes)", () => {
  it("Windows backslash risky path → evidence.file normalized to POSIX (matches CheckResultSchema)", () => {
    // CheckResultSchema's safeStoredRelativePath rejects backslash
    // paths via D28 layer-2 validation. The detector normalizes
    // via the shared normalizePathSeparators helper before BOTH
    // tokenization AND emission.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx(
        [pathOnly("app\\Http\\Middleware\\AuthMiddleware.php")],
        "Update homepage styling",
      ),
    );
    const finding = result.results.find((r) => r.id === "scope-expansion.auth");
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence[0]?.file).toBe("app/Http/Middleware/AuthMiddleware.php");
    expect(finding.evidence[0]?.file).not.toContain("\\");
  });
});

// =============================================================================
// SECTION 8: boundary cases
// =============================================================================

describe("scopeExpansionCheck — boundary cases", () => {
  it("trimmed task length exactly 8 ('homepage') → does NOT skip; produces findings", () => {
    // MIN_TASK_LENGTH = 8 and the check is `< MIN_TASK_LENGTH`
    // (strict less-than), so length 8 PASSES. Locks the off-by-one
    // boundary: length 8 fires; length 7 (next test) does not.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "homepage"),
    );
    expect(result.results.some((r) => r.id === "scope-expansion.auth")).toBe(true);
  });

  it("trimmed task length 7 ('homepag') → skips; 0 findings", () => {
    // length 7 < MIN_TASK_LENGTH (8) → gate b fires. Verifies
    // the boundary the previous test relies on.
    const result = runChecks(
      [scopeExpansionCheck],
      laravelCtx([pathOnly("app/Http/Middleware/AuthMiddleware.php")], "homepag"),
    );
    expect(result.results).toEqual([]);
  });
});
