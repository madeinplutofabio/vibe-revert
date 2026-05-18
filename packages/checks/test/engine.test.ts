// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/checks/src/engine.ts.
//
// Covers ENGINE-ORCHESTRATION semantics (D40 cluster mechanics live in
// severity.test.ts; this file does not duplicate them):
//
//   - runChecks shape: empty checks + empty context → empty result, no
//     leaked map keys; populated context → per-file riskLevelByPath
//     initialized to "low" even when no checks fire.
//   - Two-layer toggle filter (D28):
//     - Layer 1 (pre-run skip): when ALL of a check's emitted categories
//       are disabled, check.run is NOT invoked (spy-verified).
//     - Layer 1: when ANY emitted category is enabled, check.run IS invoked.
//     - Layer 1: emittedCategories defaults to [check.category] when undefined.
//     - Layer 2 (per-finding filter): findings whose result.category is
//       disabled are silently dropped; findings with enabled categories
//       survive.
//     - Disabled findings do NOT bump riskLevelByPath (regression guard:
//       riskLevelByPath must be computed from POST-Layer-2 findings, NOT
//       from raw or pre-Layer-2 ones).
//   - Schema validation: raw findings from check.run are validated against
//     CheckResultSchema BEFORE the toggle filter. An invalid finding throws
//     even when its category would have been filtered away (because schema
//     violations are detector bugs, not configuration outcomes).
//   - riskTagsByPath:
//     - Built from the injected classifier's matches per file.
//     - Only enabled-category rules contribute tags (D28 toggle filter
//       applies to classifier output too).
//     - Tags within a file are sorted ASCII-asc + deduped (satisfies
//       sortedUniqueStringArray schema constraint on ChangedFile.risk_tags).
//     - File with zero matched-and-enabled rules → empty tag array.
//   - riskLevelByPath:
//     - Every file in ctx.changedFiles initialized to "low".
//     - Bumped to max(current, finding.level) via compareLevel across
//       pre-cluster findings.
//     - Findings whose evidence[0].file points OUTSIDE ctx.changedFiles
//       (e.g., test-gap's suggested missing-test path) do NOT leak into
//       the map.
//     - PRE-clustering: a critical finding that gets swept into a cluster
//       tail summary STILL surfaces at the file level via riskLevelByPath
//       (D28 lock).
//   - Final result sort: deterministic [level desc, category asc, id asc,
//     file asc, line asc] applied AFTER clustering (D40 sort key).
//   - RunChecksOptions.classifyPath injection: when provided, the injected
//     classifier is used; when omitted, the production default is reached
//     and returns a sensible value type (shape-only; tests do NOT lock
//     production PATH_RULES contents, which Step 3+ populates).
//   - Classifier receives ctx.detectedFrameworks correctly.
//   - check.run receives the full CheckContext (same reference).
//   - Check iteration order matches registry order.
//
// Tests use vitest spies (vi.fn) to verify invocation behavior. Synthetic
// Check stubs return hand-crafted CheckResult[] arrays — no dependency on
// any real detector implementation. All category values used in tests are
// valid CHECKS_TOGGLE_MAP values so Layer 1 doesn't unintentionally skip
// checks built for testing other behaviors. Classifier-dependent tests
// inject their own classifier so the assertions don't depend on the
// current contents of PATH_RULES (which Step 3+ populates).

import { describe, expect, it, vi } from "vitest";

import type {
  ChangedFileInput,
  Check,
  CheckContext,
  CheckResult,
  ChecksToggleConfig,
  RiskLevel,
} from "../src/index.js";
import { runChecks } from "../src/index.js";

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Builds a ChangedFileInput with sensible defaults. All callers care about
 * is `path` and optionally `status`; line content is rarely relevant to
 * engine-orchestration tests (it's relevant to detectors, which are tested
 * separately in their own files).
 */
function buildChangedFile(opts: {
  path: string;
  status?: ChangedFileInput["status"];
  isBinary?: boolean;
}): ChangedFileInput {
  return {
    path: opts.path,
    status: opts.status ?? "modified",
    addedLines: [],
    removedLines: [],
    isBinary: opts.isBinary ?? false,
  };
}

/**
 * Builds a CheckResult with sensible defaults. High/critical findings
 * automatically get a default recommendation (satisfies M B refine).
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
    category: opts.category ?? "auth",
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
 * Builds a synthetic Check that returns the given findings on every run.
 * Optionally accepts a custom run function (e.g., to inspect ctx).
 */
function buildCheck(opts: {
  id: string;
  category: string;
  emittedCategories?: readonly string[];
  findings?: readonly CheckResult[];
  run?: (ctx: CheckContext) => readonly CheckResult[];
}): Check {
  return {
    id: opts.id,
    category: opts.category,
    ...(opts.emittedCategories !== undefined ? { emittedCategories: opts.emittedCategories } : {}),
    run: opts.run ?? (() => opts.findings ?? []),
  };
}

/**
 * Builds a CheckContext with sensible defaults. All categories used by
 * the M C toggle map are enabled by default; tests that care about
 * specific toggle behavior override `configChecks` explicitly.
 */
function buildContext(opts: {
  changedFiles?: readonly ChangedFileInput[];
  task?: string;
  detectedFrameworks?: readonly string[];
  configChecks?: ChecksToggleConfig;
}): CheckContext {
  return {
    changedFiles: opts.changedFiles ?? [],
    detectedFrameworks: opts.detectedFrameworks ?? [],
    configChecks:
      opts.configChecks ??
      ({
        secrets: true,
        dependencies: true,
        migrations: true,
        auth: true,
        payments: true,
        infra: true,
        tests: true,
        scope_expansion: true,
      } satisfies ChecksToggleConfig),
    ...(opts.task !== undefined ? { task: opts.task } : {}),
  };
}

// =============================================================================
// runChecks — empty / sanity
// =============================================================================

describe("runChecks — empty / sanity", () => {
  it("empty checks + empty context → empty result with no leaked map keys", () => {
    const result = runChecks([], buildContext({}));
    expect(result.results).toEqual([]);
    expect([...result.riskTagsByPath.keys()]).toEqual([]);
    expect([...result.riskLevelByPath.keys()]).toEqual([]);
  });

  it("empty checks + populated context → each changed file gets riskLevelByPath = 'low'", () => {
    const result = runChecks(
      [],
      buildContext({
        changedFiles: [
          buildChangedFile({ path: "src/a.ts" }),
          buildChangedFile({ path: "src/b.ts" }),
        ],
      }),
    );
    expect(result.results).toEqual([]);
    expect(result.riskLevelByPath.get("src/a.ts")).toBe("low");
    expect(result.riskLevelByPath.get("src/b.ts")).toBe("low");
    expect([...result.riskLevelByPath.keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("empty checks + populated context → each changed file gets riskTagsByPath = empty array when classifier has no matches", () => {
    // Inject a no-match classifier so this test isolates engine behavior
    // (every file maps to empty tags when no rule matches) rather than
    // depending on the current contents of PATH_RULES — Step 3 will
    // populate the rule table and a content-locked assertion would break.
    const classifier = vi.fn((_path: string, _frameworks: readonly string[]) => []);
    const result = runChecks(
      [],
      buildContext({
        changedFiles: [buildChangedFile({ path: "src/a.ts" })],
      }),
      { classifyPath: classifier },
    );

    expect(result.riskTagsByPath.get("src/a.ts")).toEqual([]);
  });
});

// =============================================================================
// runChecks — single-check pipeline smoke
// =============================================================================

describe("runChecks — single-check pipeline smoke", () => {
  it("a single check's valid finding appears in results", () => {
    const finding = buildFinding({
      id: "smoke.1",
      category: "auth",
      level: "medium",
      file: "src/a.ts",
    });
    const check = buildCheck({ id: "smoke", category: "auth", findings: [finding] });
    const result = runChecks(
      [check],
      buildContext({ changedFiles: [buildChangedFile({ path: "src/a.ts" })] }),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe("smoke.1");
  });

  it("a finding's level bumps the file's riskLevelByPath entry", () => {
    const finding = buildFinding({
      id: "smoke.2",
      category: "auth",
      level: "critical",
      file: "src/a.ts",
    });
    const check = buildCheck({ id: "smoke", category: "auth", findings: [finding] });
    const result = runChecks(
      [check],
      buildContext({ changedFiles: [buildChangedFile({ path: "src/a.ts" })] }),
    );
    expect(result.riskLevelByPath.get("src/a.ts")).toBe("critical");
  });

  it("findings do NOT contribute to riskTagsByPath (only the classifier does in M C)", () => {
    // M C lock: EvidenceSchema has no `tags` field, so non-classifier checks
    // cannot structurally contribute risk tags. Only the path-classifier
    // (via the injected classifyPath) populates riskTagsByPath.
    //
    // We inject a no-match classifier here so the assertion proves the
    // engine doesn't synthesize tags from findings, independent of
    // PATH_RULES contents (Step 3+ may add real matches for `src/a.ts`).
    const finding = buildFinding({
      id: "smoke.3",
      category: "auth",
      file: "src/a.ts",
    });
    const check = buildCheck({ id: "smoke", category: "auth", findings: [finding] });
    const result = runChecks(
      [check],
      buildContext({ changedFiles: [buildChangedFile({ path: "src/a.ts" })] }),
      { classifyPath: (_path: string, _frameworks: readonly string[]) => [] },
    );
    expect(result.riskTagsByPath.get("src/a.ts")).toEqual([]);
  });
});

// =============================================================================
// runChecks — two-layer toggle filter (D28)
// =============================================================================

describe("runChecks — two-layer toggle filter (D28)", () => {
  it("Layer 1: check is NOT invoked when its single category is disabled", () => {
    const runSpy = vi.fn().mockReturnValue([]);
    const check = buildCheck({ id: "skip-me", category: "auth", run: runSpy });
    runChecks(
      [check],
      buildContext({
        configChecks: { auth: false, secrets: true, payments: true },
      }),
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("Layer 1: check IS invoked when its single category is enabled", () => {
    const runSpy = vi.fn().mockReturnValue([]);
    const check = buildCheck({ id: "run-me", category: "auth", run: runSpy });
    runChecks(
      [check],
      buildContext({
        configChecks: { auth: true, secrets: false },
      }),
    );
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("Layer 1: multi-category check is NOT invoked when ALL emitted categories are disabled", () => {
    const runSpy = vi.fn().mockReturnValue([]);
    const check = buildCheck({
      id: "multi-skip",
      category: "auth",
      emittedCategories: ["auth", "payments", "secrets"],
      run: runSpy,
    });
    runChecks(
      [check],
      buildContext({
        configChecks: { auth: false, payments: false, secrets: false, dependencies: true },
      }),
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("Layer 1: multi-category check IS invoked when ANY emitted category is enabled", () => {
    const runSpy = vi.fn().mockReturnValue([]);
    const check = buildCheck({
      id: "multi-run",
      category: "auth",
      emittedCategories: ["auth", "payments", "secrets"],
      run: runSpy,
    });
    runChecks(
      [check],
      buildContext({
        configChecks: { auth: false, payments: false, secrets: true },
      }),
    );
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("Layer 1: emittedCategories defaults to [check.category] when undefined", () => {
    const runSpy = vi.fn().mockReturnValue([]);
    // No explicit emittedCategories → defaults to [category]
    const check = buildCheck({ id: "default-emitted", category: "auth", run: runSpy });
    // Disable auth → check should be skipped because default emittedCategories = ["auth"]
    runChecks([check], buildContext({ configChecks: { auth: false } }));
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("Layer 2: findings whose result.category is enabled survive", () => {
    const check = buildCheck({
      id: "mixed",
      category: "auth",
      emittedCategories: ["auth", "payments"],
      findings: [
        buildFinding({ id: "auth.1", category: "auth", file: "a.ts" }),
        buildFinding({ id: "pay.1", category: "payments", file: "a.ts" }),
      ],
    });
    const result = runChecks(
      [check],
      buildContext({
        changedFiles: [buildChangedFile({ path: "a.ts" })],
        configChecks: { auth: true, payments: true },
      }),
    );
    expect(result.results.map((r) => r.id).sort()).toEqual(["auth.1", "pay.1"]);
  });

  it("Layer 2: findings whose result.category is disabled are silently dropped", () => {
    const check = buildCheck({
      id: "mixed",
      category: "auth",
      emittedCategories: ["auth", "payments"],
      findings: [
        buildFinding({ id: "auth.1", category: "auth", file: "a.ts" }),
        buildFinding({ id: "pay.1", category: "payments", file: "a.ts" }),
      ],
    });
    // payments disabled → pay.1 dropped post-run; auth.1 survives.
    const result = runChecks(
      [check],
      buildContext({
        changedFiles: [buildChangedFile({ path: "a.ts" })],
        configChecks: { auth: true, payments: false },
      }),
    );
    expect(result.results.map((r) => r.id)).toEqual(["auth.1"]);
  });

  it("Layer 2: when all returned findings have disabled categories, results is empty", () => {
    // Construct a scenario where Layer 1 lets the check run (one emitted
    // category is enabled), but Layer 2 has to drop everything (the actual
    // findings all carry disabled categories). The spy assertion proves
    // Layer 1 didn't skip; the empty result proves Layer 2 dropped both
    // findings.
    const runSpy = vi
      .fn<Check["run"]>()
      .mockReturnValue([
        buildFinding({ id: "auth.1", category: "auth", file: "a.ts" }),
        buildFinding({ id: "pay.1", category: "payments", file: "a.ts" }),
      ]);

    const check = buildCheck({
      id: "all-filtered-after-run",
      category: "auth",
      emittedCategories: ["auth", "payments", "secrets"],
      run: runSpy,
    });

    const result = runChecks(
      [check],
      buildContext({
        changedFiles: [buildChangedFile({ path: "a.ts" })],
        configChecks: { auth: false, payments: false, secrets: true },
      }),
    );

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// runChecks — schema validation
// =============================================================================

describe("runChecks — schema validation", () => {
  it("throws when a check returns a CheckResult with empty evidence array", () => {
    // Cast through unknown to bypass TS type-check and simulate a detector bug.
    const badCheck: Check = {
      id: "buggy",
      category: "auth",
      run: () =>
        [
          {
            id: "bad.1",
            title: "Bad",
            level: "medium",
            confidence: "medium",
            category: "auth",
            message: "msg",
            evidence: [],
          },
        ] as unknown as readonly CheckResult[],
    };
    expect(() => runChecks([badCheck], buildContext({ configChecks: { auth: true } }))).toThrow();
  });

  it("throws when a check returns a high-level CheckResult without recommendation (M B refine)", () => {
    const badCheck: Check = {
      id: "buggy.high",
      category: "auth",
      run: () =>
        [
          {
            id: "bad.high",
            title: "Bad high",
            level: "high",
            confidence: "medium",
            category: "auth",
            message: "msg",
            evidence: [{ detail: "x" }],
            // no recommendation → M B refine rejects
          },
        ] as unknown as readonly CheckResult[],
    };
    expect(() => runChecks([badCheck], buildContext({ configChecks: { auth: true } }))).toThrow();
  });

  it("validation runs BEFORE the Layer-2 toggle filter (invalid finding throws even when category would be filtered)", () => {
    // Detector bug: emits a finding for a category that's disabled.
    // Without "validate first, filter second", the engine would silently
    // drop the invalid finding and the bug would never surface.
    const badCheck: Check = {
      id: "buggy.filtered",
      category: "payments",
      emittedCategories: ["payments", "auth"], // both possible
      run: () =>
        [
          // Invalid: empty evidence. Category is "payments".
          {
            id: "bad.filtered",
            title: "Bad",
            level: "medium",
            confidence: "medium",
            category: "payments",
            message: "msg",
            evidence: [],
          },
        ] as unknown as readonly CheckResult[],
    };
    // payments disabled, auth enabled → Layer 1 doesn't skip (auth enabled
    // means check runs), but Layer 2 WOULD filter out the "payments"
    // finding... IF validation hadn't already thrown.
    expect(() =>
      runChecks([badCheck], buildContext({ configChecks: { payments: false, auth: true } })),
    ).toThrow();
  });
});

// =============================================================================
// runChecks — riskTagsByPath
// =============================================================================

describe("runChecks — riskTagsByPath", () => {
  it("accumulates tags from injected classifier per file", () => {
    const classifier = vi.fn((path: string, _frameworks: readonly string[]) => {
      if (path === "src/auth.ts") {
        return [
          { category: "auth", tags: ["auth", "middleware"] },
          { category: "auth", tags: ["controllers"] },
        ];
      }
      return [];
    });
    const result = runChecks(
      [],
      buildContext({
        changedFiles: [
          buildChangedFile({ path: "src/auth.ts" }),
          buildChangedFile({ path: "src/other.ts" }),
        ],
      }),
      { classifyPath: classifier },
    );
    // Tags from both matched rules, deduped, sorted ASCII-asc.
    expect(result.riskTagsByPath.get("src/auth.ts")).toEqual(["auth", "controllers", "middleware"]);
    expect(result.riskTagsByPath.get("src/other.ts")).toEqual([]);
  });

  it("only enabled-category rules contribute tags (D28 toggle filter applies to classifier)", () => {
    const classifier = vi.fn((_path: string, _frameworks: readonly string[]) => [
      { category: "auth", tags: ["auth"] },
      { category: "payments", tags: ["payments", "billing"] },
    ]);
    const result = runChecks(
      [],
      buildContext({
        changedFiles: [buildChangedFile({ path: "src/x.ts" })],
        configChecks: { auth: true, payments: false }, // payments disabled
      }),
      { classifyPath: classifier },
    );
    // Only auth tags survive; payments rule's tags are filtered out.
    expect(result.riskTagsByPath.get("src/x.ts")).toEqual(["auth"]);
  });

  it("tags within a file are deduped and sorted ASCII-asc", () => {
    const classifier = vi.fn((_path: string, _frameworks: readonly string[]) => [
      { category: "auth", tags: ["zebra", "alpha", "middleware"] },
      { category: "auth", tags: ["alpha", "beta"] }, // alpha duplicate
    ]);
    const result = runChecks(
      [],
      buildContext({ changedFiles: [buildChangedFile({ path: "src/x.ts" })] }),
      { classifyPath: classifier },
    );
    expect(result.riskTagsByPath.get("src/x.ts")).toEqual(["alpha", "beta", "middleware", "zebra"]);
  });

  it("omitting opts uses the production classifier without locking current PATH_RULES contents", () => {
    // Shape-only assertion: omitting opts must reach the default
    // classifier and the engine must return an array for the file's
    // risk-tags entry. Does NOT lock what the production classifier
    // returns (Step 3+ populates PATH_RULES; this test must survive that).
    const path = "src/x.ts";
    const result = runChecks([], buildContext({ changedFiles: [buildChangedFile({ path })] }));

    expect(Array.isArray(result.riskTagsByPath.get(path))).toBe(true);
  });
});

// =============================================================================
// runChecks — riskLevelByPath
// =============================================================================

describe("runChecks — riskLevelByPath", () => {
  it("every file in ctx.changedFiles initialized to 'low'", () => {
    const result = runChecks(
      [],
      buildContext({
        changedFiles: [
          buildChangedFile({ path: "a.ts" }),
          buildChangedFile({ path: "b.ts" }),
          buildChangedFile({ path: "c.ts" }),
        ],
      }),
    );
    expect(result.riskLevelByPath.get("a.ts")).toBe("low");
    expect(result.riskLevelByPath.get("b.ts")).toBe("low");
    expect(result.riskLevelByPath.get("c.ts")).toBe("low");
  });

  it("bumped to max(current, finding.level) across pre-cluster findings", () => {
    const check = buildCheck({
      id: "multi",
      category: "auth",
      findings: [
        buildFinding({ id: "low.1", category: "auth", level: "low", file: "a.ts" }),
        buildFinding({ id: "medium.1", category: "auth", level: "medium", file: "a.ts" }),
        buildFinding({ id: "critical.1", category: "auth", level: "critical", file: "a.ts" }),
        buildFinding({ id: "high.1", category: "auth", level: "high", file: "a.ts" }),
      ],
    });
    const result = runChecks(
      [check],
      buildContext({ changedFiles: [buildChangedFile({ path: "a.ts" })] }),
    );
    expect(result.riskLevelByPath.get("a.ts")).toBe("critical");
  });

  it("disabled-category findings do NOT bump riskLevelByPath", () => {
    // Regression guard: riskLevelByPath must be computed from POST-Layer-2
    // findings, NOT from raw or pre-Layer-2-filter pools. If someone
    // refactored the engine to compute riskLevelByPath from the validated
    // (pre-toggle-filter) pool, disabled categories would silently bump
    // file-level severity — a user-visible toggle violation.
    //
    // Setup: same file, auth/low (enabled) + payments/critical (disabled).
    // Correct: only auth/low contributes → file level = "low".
    // Buggy:   payments/critical leaks → file level = "critical".
    const check = buildCheck({
      id: "mixed-risk",
      category: "auth",
      emittedCategories: ["auth", "payments"],
      findings: [
        buildFinding({
          id: "auth.low",
          category: "auth",
          level: "low",
          file: "a.ts",
        }),
        buildFinding({
          id: "payments.critical",
          category: "payments",
          level: "critical",
          file: "a.ts",
        }),
      ],
    });

    const result = runChecks(
      [check],
      buildContext({
        changedFiles: [buildChangedFile({ path: "a.ts" })],
        configChecks: { auth: true, payments: false },
      }),
    );

    expect(result.results.map((r) => r.id)).toEqual(["auth.low"]);
    expect(result.riskLevelByPath.get("a.ts")).toBe("low");
  });

  it("findings pointing OUTSIDE ctx.changedFiles do NOT leak into the map", () => {
    // test-gap-style scenario: check's evidence references a file that's
    // not in the diff (e.g., the missing-test path it suggests creating).
    // That file MUST NOT appear in riskLevelByPath.
    //
    // The check's category is "test-gap" (the emitted category, NOT the
    // toggle key "tests"). configChecks.tests=true maps to enabled
    // categories ["test-gap"] per CHECKS_TOGGLE_MAP.
    const check = buildCheck({
      id: "test-gap",
      category: "test-gap",
      findings: [
        buildFinding({
          id: "missing.test",
          category: "test-gap",
          level: "high",
          file: "tests/Feature/SuggestedMissingTest.php", // NOT in changedFiles
        }),
      ],
    });
    const result = runChecks(
      [check],
      buildContext({
        changedFiles: [buildChangedFile({ path: "app/Http/Controllers/X.php" })],
        configChecks: { tests: true },
      }),
    );
    // Finding still appears in results...
    expect(result.results.map((r) => r.id)).toEqual(["missing.test"]);
    // ...but the suggested-missing-test path is NOT in riskLevelByPath.
    expect(result.riskLevelByPath.has("tests/Feature/SuggestedMissingTest.php")).toBe(false);
    // And the actually-changed file stays at "low" (no finding evidence
    // pointed at it).
    expect(result.riskLevelByPath.get("app/Http/Controllers/X.php")).toBe("low");
  });

  it("PRE-clustering: critical finding swept into a cluster summary STILL surfaces at file level (D28 lock)", () => {
    // Build 35 ALL-CRITICAL findings in one category. Per-category cap (30)
    // keeps the first 29 by sort (id ASC under tied level/category) and
    // sweeps 6 into a cluster.auth-tail summary. The target file
    // "src/critical.ts" is the LAST id (finding.34) — guaranteed to be
    // in the dropped set. Without the D28 PRE-clustering lock,
    // riskLevelByPath.get("src/critical.ts") would be "low" (no surviving
    // finding evidence references it). With the lock, it MUST be
    // "critical" because the level is computed from the pre-cluster pool.
    const findings: CheckResult[] = [];

    for (let i = 0; i < 35; i++) {
      const idx = String(i).padStart(2, "0");
      findings.push(
        buildFinding({
          id: `finding.${idx}`,
          category: "auth",
          level: "critical",
          file: i === 34 ? "src/critical.ts" : `src/file-${idx}.ts`,
        }),
      );
    }

    const changedFiles = findings.map((f) => {
      const file = f.evidence[0]?.file;
      if (file === undefined) {
        throw new Error("test invariant failed: finding must carry evidence[0].file");
      }
      return buildChangedFile({ path: file });
    });

    const check = buildCheck({
      id: "many",
      category: "auth",
      emittedCategories: ["auth"],
      findings,
    });

    const result = runChecks([check], buildContext({ changedFiles }));

    // finding.34 was swept into the cluster (it's the LAST by id ASC,
    // so it's in the dropped 6 after sort).
    expect(result.results.some((r) => r.id === "finding.34")).toBe(false);
    // The cluster summary was created.
    expect(result.results.some((r) => r.id === "cluster.auth-tail")).toBe(true);
    // The PRE-clustering lock: src/critical.ts STILL shows as critical
    // even though its finding was swept into the summary.
    expect(result.riskLevelByPath.get("src/critical.ts")).toBe("critical");
  });
});

// =============================================================================
// runChecks — final result sort order (D40)
// =============================================================================

describe("runChecks — final result sort order", () => {
  it("results are sorted by [level desc, category asc, id asc, file asc, line asc]", () => {
    // Use real CHECKS_TOGGLE_MAP categories (auth + payments) so the engine's
    // Layer-1 filter doesn't skip the check. Sort key order:
    //   (critical, auth, a, a.ts, 1) → "a"
    //   (critical, auth, b, a.ts, 2) → "b"
    //   (high,     auth, c, a.ts, 1) → "c"
    //   (low,      payments, z, z.ts, 100) → "z"
    const findings: CheckResult[] = [
      buildFinding({ id: "z", category: "payments", level: "low", file: "z.ts", line: 100 }),
      buildFinding({ id: "b", category: "auth", level: "critical", file: "a.ts", line: 2 }),
      buildFinding({ id: "a", category: "auth", level: "critical", file: "a.ts", line: 1 }),
      buildFinding({ id: "c", category: "auth", level: "high", file: "a.ts", line: 1 }),
    ];

    const check = buildCheck({
      id: "many",
      category: "auth",
      emittedCategories: ["auth", "payments"],
      findings,
    });

    const result = runChecks(
      [check],
      buildContext({
        changedFiles: [buildChangedFile({ path: "a.ts" }), buildChangedFile({ path: "z.ts" })],
        configChecks: { auth: true, payments: true },
      }),
    );

    expect(result.results.map((r) => r.id)).toEqual(["a", "b", "c", "z"]);
  });
});

// =============================================================================
// runChecks — RunChecksOptions.classifyPath injection
// =============================================================================

describe("runChecks — RunChecksOptions.classifyPath injection", () => {
  it("uses the injected classifyPath when provided", () => {
    const customClassifier = vi.fn((_path: string, _frameworks: readonly string[]) => [
      { category: "auth", tags: ["injected-tag"] },
    ]);
    const result = runChecks(
      [],
      buildContext({ changedFiles: [buildChangedFile({ path: "src/x.ts" })] }),
      { classifyPath: customClassifier },
    );
    expect(customClassifier).toHaveBeenCalled();
    expect(result.riskTagsByPath.get("src/x.ts")).toEqual(["injected-tag"]);
  });

  it("uses the production default classifyPath when opts is omitted", () => {
    // Shape-only: the production default must be reachable and produce a
    // sensible value type. Does NOT lock production PATH_RULES contents
    // (Step 3+ populates the rule table).
    const path = "src/x.ts";
    const result = runChecks([], buildContext({ changedFiles: [buildChangedFile({ path })] }));

    expect(Array.isArray(result.riskTagsByPath.get(path))).toBe(true);
  });

  it("uses the production default classifyPath when opts is provided without classifyPath", () => {
    // Same shape-only guarantee when opts is an empty object instead of
    // omitted entirely.
    const path = "src/x.ts";
    const result = runChecks([], buildContext({ changedFiles: [buildChangedFile({ path })] }), {});

    expect(Array.isArray(result.riskTagsByPath.get(path))).toBe(true);
  });
});

// =============================================================================
// runChecks — classifier receives detectedFrameworks
// =============================================================================

describe("runChecks — classifier receives detectedFrameworks", () => {
  it("passes ctx.detectedFrameworks through to the classifier on every file", () => {
    const classifier = vi.fn((_path: string, _frameworks: readonly string[]) => []);
    runChecks(
      [],
      buildContext({
        changedFiles: [buildChangedFile({ path: "a.ts" }), buildChangedFile({ path: "b.ts" })],
        detectedFrameworks: ["laravel", "nextjs"],
      }),
      { classifyPath: classifier },
    );
    expect(classifier).toHaveBeenCalledTimes(2);
    expect(classifier).toHaveBeenNthCalledWith(1, "a.ts", ["laravel", "nextjs"]);
    expect(classifier).toHaveBeenNthCalledWith(2, "b.ts", ["laravel", "nextjs"]);
  });
});

// =============================================================================
// runChecks — check.run receives the full context
// =============================================================================

describe("runChecks — check.run receives the full context", () => {
  it("passes the same ctx (incl. task, detectedFrameworks, changedFiles) into check.run", () => {
    let capturedCtx: CheckContext | undefined;
    const check = buildCheck({
      id: "introspect",
      category: "auth",
      run: (ctx) => {
        capturedCtx = ctx;
        return [];
      },
    });
    const inputCtx = buildContext({
      changedFiles: [buildChangedFile({ path: "a.ts" })],
      task: "test the engine",
      detectedFrameworks: ["laravel"],
      configChecks: { auth: true },
    });
    runChecks([check], inputCtx);
    expect(capturedCtx).toBe(inputCtx); // same reference, not just structurally equal
    expect(capturedCtx?.task).toBe("test the engine");
    expect(capturedCtx?.detectedFrameworks).toEqual(["laravel"]);
    expect(capturedCtx?.changedFiles.map((f) => f.path)).toEqual(["a.ts"]);
  });
});

// =============================================================================
// runChecks — check iteration order
// =============================================================================

describe("runChecks — check iteration order", () => {
  it("invokes checks in registry array order (preserved through pipeline)", () => {
    const invocations: string[] = [];
    const checkA = buildCheck({
      id: "a",
      category: "auth",
      run: () => {
        invocations.push("a");
        return [];
      },
    });
    const checkB = buildCheck({
      id: "b",
      category: "auth",
      run: () => {
        invocations.push("b");
        return [];
      },
    });
    const checkC = buildCheck({
      id: "c",
      category: "auth",
      run: () => {
        invocations.push("c");
        return [];
      },
    });
    runChecks([checkA, checkB, checkC], buildContext({ configChecks: { auth: true } }));
    expect(invocations).toEqual(["a", "b", "c"]);
  });
});
