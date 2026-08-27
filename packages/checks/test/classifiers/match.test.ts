// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/checks/src/classifiers/match.ts.
//
// Covers:
//   - classifyPath (production wrapper): shape sanity (returns an array)
//     WITHOUT locking current PATH_RULES contents — Step 3 will populate
//     the rule table, and a content-locked test would create planned
//     technical debt.
//   - compilePathRules + classifyPathWithCompiledRules (testable layer):
//     - empty rules → empty result
//     - single rule match
//     - multiple rules can match the same path (D32 multi-match)
//     - rule iteration order preserved in output
//     - framework gating: skipped when rule.framework not in detected list
//     - framework gating: included when rule.framework IS in detected list
//     - rules with no framework field always evaluated (Generic tier)
//     - excludePatterns: rule skipped when any exclude matches
//     - excludePatterns: rule included when no exclude matches
//     - excludePatterns: array form matches against multiple patterns
//     - excludePatterns: empty array equivalent to no excludePatterns
//   - Locked picomatch option semantics (D32, D56):
//     - dot: true → dotfiles match patterns like .env*
//     - nocase: false → case-SENSITIVE matching
//     - nonegate: true → leading ! is literal (not a negation)
//     - explicit matcher normalization converts backslash separators to
//       POSIX slashes before include/exclude matching; posixSlashes remains
//       enabled as defense-in-depth
//   - Glob features:
//     - ** recursive segments
//     - * matches a single segment only (not /)
//     - {a,b} alternation (incl. nested)
//   - compilePathRules pure-compiler shape: 1:1 mapping, matchPattern +
//     matchAnyExclude functions on each entry, callable repeatedly with
//     different rule arrays (no module-level state)
//
// The test file imports compilePathRules + classifyPathWithCompiledRules
// from the INTERNAL module path (`../../src/classifiers/match.js`) per
// the public-API discipline locked in `src/index.ts`: those helpers are
// testability hooks, not consumer-facing API. The package barrel
// intentionally does not expose them. PathRule (the type) IS public —
// imported from the barrel.

import { describe, expect, it } from "vitest";
import {
  canonicalChangedFilePath,
  changedFilePathCandidates,
  classifyChangedFile,
  classifyChangedFileWithCompiledRules,
  classifyPath,
  classifyPathWithCompiledRules,
  compilePathRules,
} from "../../src/classifiers/match.js";
import type { PathRule } from "../../src/index.js";

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Builds a synthetic PathRule with sensible defaults. Optional fields
 * (framework, excludePatterns) are only spread into the result when
 * explicitly provided — required by `exactOptionalPropertyTypes: true`.
 */
function rule(opts: {
  id: string;
  pattern: string;
  category?: string;
  framework?: string;
  tags?: readonly string[];
  defaultLevel?: PathRule["defaultLevel"];
  excludePatterns?: readonly string[];
}): PathRule {
  return {
    id: opts.id,
    pattern: opts.pattern,
    category: opts.category ?? "test",
    tags: opts.tags ?? [],
    defaultLevel: opts.defaultLevel ?? "medium",
    ...(opts.framework !== undefined ? { framework: opts.framework } : {}),
    ...(opts.excludePatterns !== undefined ? { excludePatterns: opts.excludePatterns } : {}),
  };
}

// =============================================================================
// classifyPath (production wrapper)
// =============================================================================

describe("classifyPath (production wrapper)", () => {
  it("returns an array (shape sanity without locking current PATH_RULES contents)", () => {
    const result = classifyPath("anything.ts", []);
    expect(Array.isArray(result)).toBe(true);
  });
});

// =============================================================================
// classifyPathWithCompiledRules — basic matching
// =============================================================================

describe("classifyPathWithCompiledRules — basic matching", () => {
  it("returns empty when compiled-rules array is empty", () => {
    expect(classifyPathWithCompiledRules("any.ts", [], [])).toEqual([]);
  });

  it("returns the single matching rule", () => {
    const rules = [rule({ id: "ts.files", pattern: "**/*.ts" })];
    const compiled = compilePathRules(rules);
    const result = classifyPathWithCompiledRules("src/app.ts", [], compiled);
    expect(result.map((r) => r.id)).toEqual(["ts.files"]);
  });

  it("returns empty when no rule matches", () => {
    const rules = [rule({ id: "py.files", pattern: "**/*.py" })];
    const compiled = compilePathRules(rules);
    const result = classifyPathWithCompiledRules("src/app.ts", [], compiled);
    expect(result).toEqual([]);
  });

  it("returns ALL matching rules (multi-match per D32)", () => {
    const rules = [
      rule({ id: "ts.files", pattern: "**/*.ts" }),
      rule({ id: "src.files", pattern: "src/**" }),
      rule({ id: "py.files", pattern: "**/*.py" }),
    ];
    const compiled = compilePathRules(rules);
    const result = classifyPathWithCompiledRules("src/app.ts", [], compiled);
    expect(result.map((r) => r.id).sort()).toEqual(["src.files", "ts.files"]);
  });

  it("preserves compiled-rules order in the matched output", () => {
    const rules = [
      rule({ id: "first", pattern: "**/*.ts" }),
      rule({ id: "second", pattern: "**/*.ts" }),
      rule({ id: "third", pattern: "**/*.ts" }),
    ];
    const compiled = compilePathRules(rules);
    const result = classifyPathWithCompiledRules("src/app.ts", [], compiled);
    expect(result.map((r) => r.id)).toEqual(["first", "second", "third"]);
  });
});

// =============================================================================
// classifyPathWithCompiledRules — framework gating (D32)
// =============================================================================

describe("classifyPathWithCompiledRules — framework gating (D32)", () => {
  it("skips rules with framework field when that framework is NOT detected", () => {
    const rules = [
      rule({ id: "laravel.controllers", pattern: "app/Http/**", framework: "laravel" }),
    ];
    const compiled = compilePathRules(rules);
    const result = classifyPathWithCompiledRules("app/Http/Controllers/X.php", [], compiled);
    expect(result).toEqual([]);
  });

  it("includes rules with framework field when that framework IS detected", () => {
    const rules = [
      rule({ id: "laravel.controllers", pattern: "app/Http/**", framework: "laravel" }),
    ];
    const compiled = compilePathRules(rules);
    const result = classifyPathWithCompiledRules(
      "app/Http/Controllers/X.php",
      ["laravel"],
      compiled,
    );
    expect(result.map((r) => r.id)).toEqual(["laravel.controllers"]);
  });

  it("always evaluates rules with no framework field (Generic tier)", () => {
    const rules = [rule({ id: "generic.dockerfile", pattern: "Dockerfile" })];
    const compiled = compilePathRules(rules);
    // No detected frameworks; generic rule still matches.
    expect(classifyPathWithCompiledRules("Dockerfile", [], compiled).map((r) => r.id)).toEqual([
      "generic.dockerfile",
    ]);
    // Many detected frameworks; same result.
    expect(
      classifyPathWithCompiledRules("Dockerfile", ["laravel", "nextjs"], compiled).map((r) => r.id),
    ).toEqual(["generic.dockerfile"]);
  });

  it("mixes framework-specific + generic rules correctly", () => {
    const rules = [
      rule({ id: "laravel.controllers", pattern: "app/Http/**", framework: "laravel" }),
      rule({ id: "next.middleware", pattern: "middleware.{ts,js}", framework: "nextjs" }),
      rule({ id: "generic.dockerfile", pattern: "Dockerfile" }),
    ];
    const compiled = compilePathRules(rules);
    // With laravel detected, only laravel + generic rules can fire.
    const laravelDocker = classifyPathWithCompiledRules("Dockerfile", ["laravel"], compiled);
    expect(laravelDocker.map((r) => r.id)).toEqual(["generic.dockerfile"]);
    const laravelMiddleware = classifyPathWithCompiledRules("middleware.ts", ["laravel"], compiled);
    expect(laravelMiddleware).toEqual([]);
    // With nextjs detected, only next + generic rules can fire.
    const nextMiddleware = classifyPathWithCompiledRules("middleware.ts", ["nextjs"], compiled);
    expect(nextMiddleware.map((r) => r.id)).toEqual(["next.middleware"]);
  });
});

// =============================================================================
// classifyPathWithCompiledRules — excludePatterns (D32 suppression)
// =============================================================================

describe("classifyPathWithCompiledRules — excludePatterns (D32 suppression)", () => {
  it("skips rule when any excludePattern matches the path", () => {
    const rules = [
      rule({
        id: "root-env",
        pattern: ".env*",
        excludePatterns: [".env.example"],
      }),
      rule({
        id: "nested-env",
        pattern: "apps/**/.env*",
        excludePatterns: ["apps/**/.env.example"],
      }),
    ];
    const compiled = compilePathRules(rules);

    expect(classifyPathWithCompiledRules(".env.example", [], compiled)).toEqual([]);
    expect(classifyPathWithCompiledRules("apps/web/.env.example", [], compiled)).toEqual([]);

    expect(classifyPathWithCompiledRules(".env.local", [], compiled).map((r) => r.id)).toEqual([
      "root-env",
    ]);
    expect(
      classifyPathWithCompiledRules("apps/web/.env.local", [], compiled).map((r) => r.id),
    ).toEqual(["nested-env"]);
  });

  it("includes rule when NO excludePattern matches the path", () => {
    const rules = [
      rule({
        id: "env.files",
        pattern: ".env*",
        excludePatterns: [".env.example"],
      }),
    ];
    const compiled = compilePathRules(rules);
    const result = classifyPathWithCompiledRules(".env", [], compiled);
    expect(result.map((r) => r.id)).toEqual(["env.files"]);
  });

  it("treats rule with empty excludePatterns the same as no excludePatterns", () => {
    const rulesA = [rule({ id: "a", pattern: ".env" })];
    const rulesB = [rule({ id: "b", pattern: ".env", excludePatterns: [] })];
    const a = classifyPathWithCompiledRules(".env", [], compilePathRules(rulesA));
    const b = classifyPathWithCompiledRules(".env", [], compilePathRules(rulesB));
    expect(a.map((r) => r.id)).toEqual(["a"]);
    expect(b.map((r) => r.id)).toEqual(["b"]);
  });

  it("matches against multiple distinct excludePatterns (array form)", () => {
    const rules = [
      rule({
        id: "all-files",
        pattern: "**",
        excludePatterns: [".env.example", ".env.template", "**/*.template"],
      }),
    ];
    const compiled = compilePathRules(rules);
    expect(classifyPathWithCompiledRules(".env.example", [], compiled)).toEqual([]);
    expect(classifyPathWithCompiledRules(".env.template", [], compiled)).toEqual([]);
    expect(classifyPathWithCompiledRules("config/foo.template", [], compiled)).toEqual([]);
    expect(classifyPathWithCompiledRules("config/real.ts", [], compiled).map((r) => r.id)).toEqual([
      "all-files",
    ]);
  });
});

// =============================================================================
// Locked picomatch option semantics (D32, D56)
// =============================================================================

describe("classifyPathWithCompiledRules — locked picomatch options (D32, D56)", () => {
  it("matches dotfiles via { dot: true } (e.g., .env* matches .env, .env.local, .envrc)", () => {
    const rules = [rule({ id: "env", pattern: ".env*" })];
    const compiled = compilePathRules(rules);
    expect(classifyPathWithCompiledRules(".env", [], compiled).map((r) => r.id)).toEqual(["env"]);
    expect(classifyPathWithCompiledRules(".env.local", [], compiled).map((r) => r.id)).toEqual([
      "env",
    ]);
    expect(classifyPathWithCompiledRules(".envrc", [], compiled).map((r) => r.id)).toEqual(["env"]);
  });

  it("matches dotfiles inside ** segments", () => {
    const rules = [rule({ id: "env", pattern: "**/.env" })];
    const compiled = compilePathRules(rules);
    expect(classifyPathWithCompiledRules("apps/web/.env", [], compiled).map((r) => r.id)).toEqual([
      "env",
    ]);
  });

  it("is case-SENSITIVE via { nocase: false }", () => {
    const rules = [rule({ id: "dockerfile", pattern: "Dockerfile" })];
    const compiled = compilePathRules(rules);
    // Exact case matches.
    expect(classifyPathWithCompiledRules("Dockerfile", [], compiled).map((r) => r.id)).toEqual([
      "dockerfile",
    ]);
    // Different case does NOT match.
    expect(classifyPathWithCompiledRules("dockerfile", [], compiled)).toEqual([]);
    expect(classifyPathWithCompiledRules("DOCKERFILE", [], compiled)).toEqual([]);
  });

  it("treats leading ! as a LITERAL character via { nonegate: true } (not a negation)", () => {
    const rules = [rule({ id: "literal-bang", pattern: "!secret" })];
    const compiled = compilePathRules(rules);
    // The pattern matches the literal path "!secret", not "everything except secret".
    expect(classifyPathWithCompiledRules("!secret", [], compiled).map((r) => r.id)).toEqual([
      "literal-bang",
    ]);
    // Other paths do NOT match (if nonegate were false, "!secret" would
    // be a negation pattern and "any-other-path" would match).
    expect(classifyPathWithCompiledRules("any-other-path", [], compiled)).toEqual([]);
    expect(classifyPathWithCompiledRules("secret", [], compiled)).toEqual([]);
  });

  it("normalizes backslash separators before include matching", () => {
    // The matcher EXPLICITLY normalizes backslashes to forward slashes
    // before invoking picomatch (see normalizeClassifierPath in
    // ../../src/classifiers/match.ts). This is the cross-platform
    // guarantee; picomatch's own posixSlashes flag is platform-dependent
    // and cannot be relied on. Production callers (the CLI today, future
    // adapters tomorrow) get OS-independent matching regardless of input
    // path shape.
    const rules = [rule({ id: "ts", pattern: "src/**/*.ts" })];
    const compiled = compilePathRules(rules);
    expect(
      classifyPathWithCompiledRules("src\\nested\\app.ts", [], compiled).map((r) => r.id),
    ).toEqual(["ts"]);
  });

  it("normalizes backslash separators before exclude matching too (symmetric contract)", () => {
    // Locks the symmetric application: normalization must apply to BOTH
    // include pattern matching AND exclude pattern matching. A bug that
    // normalized only the include side would let backslash-input paths
    // slip past excludes that should suppress them — rule would fire when
    // it shouldn't. (The "neither side normalized" failure mode is caught
    // by the preceding include test, which would return [] when the rule
    // should have fired.)
    const rules = [
      rule({
        id: "ts",
        pattern: "src/**/*.ts",
        excludePatterns: ["src/**/*.test.ts"],
      }),
    ];
    const compiled = compilePathRules(rules);
    expect(classifyPathWithCompiledRules("src\\nested\\foo.test.ts", [], compiled)).toEqual([]);
  });
});

// =============================================================================
// Glob features
// =============================================================================

describe("classifyPathWithCompiledRules — glob features", () => {
  it("** matches multiple nested segments", () => {
    const rules = [rule({ id: "deep", pattern: "src/**" })];
    const compiled = compilePathRules(rules);
    expect(classifyPathWithCompiledRules("src/a.ts", [], compiled).length).toBe(1);
    expect(classifyPathWithCompiledRules("src/a/b/c/d.ts", [], compiled).length).toBe(1);
  });

  it("* matches only a single path segment (not /)", () => {
    const rules = [rule({ id: "shallow", pattern: "src/*" })];
    const compiled = compilePathRules(rules);
    expect(classifyPathWithCompiledRules("src/a.ts", [], compiled).length).toBe(1);
    // Nested file does NOT match single-segment *.
    expect(classifyPathWithCompiledRules("src/a/b.ts", [], compiled)).toEqual([]);
  });

  it("{a,b} alternation matches either branch", () => {
    const rules = [rule({ id: "tsjs", pattern: "**/*.{ts,js}" })];
    const compiled = compilePathRules(rules);
    expect(classifyPathWithCompiledRules("src/a.ts", [], compiled).length).toBe(1);
    expect(classifyPathWithCompiledRules("src/a.js", [], compiled).length).toBe(1);
    expect(classifyPathWithCompiledRules("src/a.py", [], compiled)).toEqual([]);
  });

  it("nested {a,b} alternations work", () => {
    const rules = [
      rule({ id: "payment-api", pattern: "{app,pages}/api/**/*{billing,payment}*.{ts,js}" }),
    ];
    const compiled = compilePathRules(rules);
    expect(classifyPathWithCompiledRules("app/api/v1/billing.ts", [], compiled).length).toBe(1);
    expect(
      classifyPathWithCompiledRules("pages/api/checkout/payment-process.js", [], compiled).length,
    ).toBe(1);
    expect(classifyPathWithCompiledRules("app/api/users.ts", [], compiled)).toEqual([]);
  });
});

// =============================================================================
// compilePathRules — pure compiler shape
// =============================================================================

describe("compilePathRules — pure compiler", () => {
  it("returns an array of compiled entries 1:1 with the input rules (order preserved)", () => {
    const rules = [
      rule({ id: "a", pattern: "a.ts" }),
      rule({ id: "b", pattern: "b.ts" }),
      rule({ id: "c", pattern: "c.ts" }),
    ];
    const compiled = compilePathRules(rules);
    expect(compiled).toHaveLength(3);
    expect(compiled.map((c) => c.rule.id)).toEqual(["a", "b", "c"]);
  });

  it("each compiled entry has matchPattern + matchAnyExclude callable functions", () => {
    const rules = [rule({ id: "a", pattern: "a.ts" })];
    const [c] = compilePathRules(rules);
    expect(typeof c?.matchPattern).toBe("function");
    expect(typeof c?.matchAnyExclude).toBe("function");
  });

  it("rule with no excludePatterns gets a matchAnyExclude that always returns false", () => {
    const rules = [rule({ id: "no-excludes", pattern: "**/*" })];
    const [c] = compilePathRules(rules);
    expect(c?.matchAnyExclude("anything")).toBe(false);
    expect(c?.matchAnyExclude("")).toBe(false);
  });

  it("rule with excludePatterns gets a matchAnyExclude that fires when any pattern matches", () => {
    const rules = [
      rule({
        id: "with-excludes",
        pattern: "**/*",
        excludePatterns: ["*.example", "*.template"],
      }),
    ];
    const [c] = compilePathRules(rules);
    expect(c?.matchAnyExclude("foo.example")).toBe(true);
    expect(c?.matchAnyExclude("bar.template")).toBe(true);
    expect(c?.matchAnyExclude("real.ts")).toBe(false);
  });

  it("can be called repeatedly with different rule arrays (no module-level state)", () => {
    const compiledA = compilePathRules([rule({ id: "a", pattern: "a.ts" })]);
    const compiledB = compilePathRules([rule({ id: "b", pattern: "b.ts" })]);
    expect(compiledA[0]?.rule.id).toBe("a");
    expect(compiledB[0]?.rule.id).toBe("b");
    expect(compiledA[0]?.matchPattern("b.ts")).toBe(false);
    expect(compiledB[0]?.matchPattern("a.ts")).toBe(false);
  });
});

// =============================================================================
// Rename aliases (M 0.8.0 step 7)
// =============================================================================

describe("changedFilePathCandidates", () => {
  it("a non-rename yields one candidate", () => {
    expect(changedFilePathCandidates({ path: "src/a.ts" })).toEqual([
      { path: "src/a.ts", source: "current" },
    ]);
  });

  it("a rename yields current then previous", () => {
    expect(
      changedFilePathCandidates({ path: "utils/webhook.ts", previous_path: "payments/webhook.ts" }),
    ).toEqual([
      { path: "utils/webhook.ts", source: "current" },
      { path: "payments/webhook.ts", source: "previous" },
    ]);
  });

  it("canonicalizes BOTH sides, not just the current path", () => {
    // previous_path arrives in the same transport form as path and is not
    // canonicalized anywhere upstream, so a Windows-shaped rename origin would
    // otherwise be classified as a literal-backslash path.
    expect(
      changedFilePathCandidates({
        path: "utils\\webhook.ts",
        previous_path: "payments\\webhook.ts",
      }),
    ).toEqual([
      { path: "utils/webhook.ts", source: "current" },
      { path: "payments/webhook.ts", source: "previous" },
    ]);
  });

  it("collapses to a single 'both' candidate when the two canonicalize alike", () => {
    // Degenerate but reachable: no reason to classify the same path twice.
    expect(changedFilePathCandidates({ path: "a/b.ts", previous_path: "a\\b.ts" })).toEqual([
      { path: "a/b.ts", source: "both" },
    ]);
  });
});

describe("canonicalChangedFilePath", () => {
  it("is the POSIX form of the current path", () => {
    expect(canonicalChangedFilePath({ path: "a\\b\\c.ts" })).toBe("a/b/c.ts");
  });
});

describe("classifyChangedFileWithCompiledRules", () => {
  it("a non-rename behaves like single-path classification, with source 'current'", () => {
    const compiled = compilePathRules([rule({ id: "ts", pattern: "**/*.ts" })]);
    const result = classifyChangedFileWithCompiledRules({ path: "src/a.ts" }, [], compiled);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("current");
    expect(result[0]?.currentPath).toBe("src/a.ts");
    expect(result[0]?.previousPath).toBeUndefined();
  });

  it("retains risk from the rename ORIGIN while identity stays the new path", () => {
    // The canonical step 7 case: payments/webhook.ts -> utils/webhook.ts.
    // The payments rule matches only the old location, but the finding's
    // identity is the new one.
    const compiled = compilePathRules([
      rule({ id: "payments", pattern: "payments/**", category: "payments" }),
    ]);
    const result = classifyChangedFileWithCompiledRules(
      { path: "utils/webhook.ts", previous_path: "payments/webhook.ts" },
      [],
      compiled,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.rule.id).toBe("payments");
    expect(result[0]?.source).toBe("previous");
    expect(result[0]?.currentPath).toBe("utils/webhook.ts");
    expect(result[0]?.previousPath).toBe("payments/webhook.ts");
  });

  it("a rule matching both aliases is emitted ONCE with source 'both'", () => {
    const compiled = compilePathRules([rule({ id: "ts", pattern: "**/*.ts" })]);
    const result = classifyChangedFileWithCompiledRules(
      { path: "new.ts", previous_path: "old.ts" },
      [],
      compiled,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("both");
  });

  it("emits in compiled-rule order, NOT current-then-previous concatenation order", () => {
    // Table is [a, b]; only the PREVIOUS path matches a, only the CURRENT
    // matches b. Each single-path call preserves order individually, so naive
    // concatenation would yield [b, a].
    const compiled = compilePathRules([
      rule({ id: "a", pattern: "old.ts" }),
      rule({ id: "b", pattern: "new.ts" }),
    ]);
    const result = classifyChangedFileWithCompiledRules(
      { path: "new.ts", previous_path: "old.ts" },
      [],
      compiled,
    );
    expect(result.map((m) => m.rule.id)).toEqual(["a", "b"]);
    expect(result.map((m) => m.source)).toEqual(["previous", "current"]);
  });

  it("emits a repeated rule object once", () => {
    // compilePathRules accepts arbitrary arrays, so "no object repeats" is as
    // unverifiable an assumption as "ids are unique".
    const shared = rule({ id: "dup", pattern: "**/*.ts" });
    const compiled = compilePathRules([shared, shared]);
    const result = classifyChangedFileWithCompiledRules({ path: "a.ts" }, [], compiled);
    expect(result).toHaveLength(1);
  });

  it("does NOT collapse distinct rule objects that share an id", () => {
    // Rule ids are not an asserted uniqueness boundary in this module.
    // Dedupe is by PathRule object identity, so two distinct rules with the
    // same id remain distinct matches in compiled-rule order.
    const first = rule({ id: "shared", pattern: "**/*.ts", category: "auth" });
    const second = rule({ id: "shared", pattern: "**/*.ts", category: "payments" });
    const compiled = compilePathRules([first, second]);

    const result = classifyChangedFileWithCompiledRules({ path: "a.ts" }, [], compiled);

    expect(result).toHaveLength(2);
    expect(result[0]?.rule).toBe(first);
    expect(result[1]?.rule).toBe(second);
  });
});

describe("classifyChangedFile (production wrapper)", () => {
  it("returns an array (shape sanity without locking PATH_RULES contents)", () => {
    expect(Array.isArray(classifyChangedFile({ path: "anything.ts" }, []))).toBe(true);
  });
});
