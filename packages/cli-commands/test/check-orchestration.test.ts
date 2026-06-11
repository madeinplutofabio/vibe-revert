// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// check-orchestration.ts — C.6 targeted tests + M D Step 4b additions.
//
// 50 tests across 8 describe blocks. Explicit coverage for the
// hardening paths C.5 introduced:
//   - task drift guard (both set + disagree → throws)
//   - staged_only literal-true emission + schema-refine throw on
//     staged_only + session_bound
//   - env SHA override flowing through buildReportFile via the C.1
//     resolveSinceResolvedShaForReport call
//   - line-number mapping (add/remove/context counters advancing
//     through hunks; multi-hunk reset; binary suppression)
//   - risk_level / summary aggregation per D52 / D53
//   - risk_tags defensive dedupe + sort to satisfy
//     sortedUniqueStringArray
//   - exclude filtering glob semantics matching the locked picomatch
//     options across git / checks / cli
//
// M D Step 4b additions (D72 strict rule for `rollback_available`):
//   - computeRollbackAvailable: 6 tests pinning the locked decision
//     branches — ad_hoc kind short-circuit, session_bound inner
//     checkpoint present/missing/corrupt, the architectural canary
//     proving the helper reads the SESSION-OWNED inner checkpoint
//     (not the global `cp_<ULID>` store), and the fail-closed
//     SESSION_ID_RE guard rejecting malformed reportId BEFORE any
//     filesystem path interpolation.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CheckContext, RunChecksResult } from "@viberevert/checks";
import type { Config } from "@viberevert/core";
import type { RawDiff, RawDiffEntry, RawDiffHunk } from "@viberevert/git";
import { type CheckResult, type RiskLevel, SCHEMA_VERSION } from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyDiffPathExcludes,
  type BuildReportSinceMeta,
  buildReportFile,
  computeRiskLevel,
  computeRollbackAvailable,
  computeSummary,
  DEFAULT_CHECKS_CONFIG,
  DEFAULT_FRAMEWORKS_POLICY,
  DEFAULT_RISK_BLOCK_ON,
  DEFAULT_RISK_WARN_ON,
  mergeChecksConfig,
  parseRawDiffToInputs,
} from "../src/check-orchestration.js";
import { VIBEREVERT_TEST_FIXED_NOW, VIBEREVERT_TEST_FIXED_SHA } from "../src/runtime-env.js";

// =============================================================================
// Fixture constants
// =============================================================================

const VALID_SHA = "0".repeat(40);
const ANOTHER_VALID_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const VALID_SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const VALID_REPORT_ID = "rpt_01JV8Y7W2M7AABCDEFGHJKMNPQ";

// =============================================================================
// Fixture builders
// =============================================================================

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    changedFiles: [],
    detectedFrameworks: [],
    configChecks: {},
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunChecksResult> = {}): RunChecksResult {
  return {
    results: [],
    riskTagsByPath: new Map(),
    riskLevelByPath: new Map(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RawDiffEntry> = {}): RawDiffEntry {
  return {
    path: "src/foo.ts",
    status: "added",
    isBinary: false,
    hunks: [],
    ...overrides,
  };
}

function makeHunk(opts: {
  newStart?: number;
  oldStart?: number;
  lines: { kind: "add" | "remove" | "context"; text: string }[];
}): RawDiffHunk {
  return {
    oldStart: opts.oldStart ?? 1,
    oldLines: opts.lines.filter((l) => l.kind !== "add").length,
    newStart: opts.newStart ?? 1,
    newLines: opts.lines.filter((l) => l.kind !== "remove").length,
    lines: opts.lines,
  };
}

function makeSessionBoundSinceMeta(
  overrides: Partial<BuildReportSinceMeta> = {},
): BuildReportSinceMeta {
  return {
    kind: "session_bound",
    sinceKind: "session_id",
    sinceRef: VALID_SESSION_ID,
    sinceResolvedSha: VALID_SHA,
    reportId: VALID_SESSION_ID,
    startedAt: "2026-01-01T00:00:00Z",
    // D72 default: false. The 15 `buildReportFile` describe-block
    // tests don't exercise rollback_available's derivation (that's
    // the `computeRollbackAvailable` describe block below); they
    // only need the field to be present so the fixture satisfies
    // BuildReportSinceMeta's required-boolean shape. Per-test
    // overrides can set it explicitly when needed.
    rollbackAvailable: false,
    ...overrides,
  };
}

function makeAdHocSinceMeta(overrides: Partial<BuildReportSinceMeta> = {}): BuildReportSinceMeta {
  return {
    kind: "ad_hoc",
    sinceKind: "git_ref",
    sinceRef: "HEAD~1",
    sinceResolvedSha: VALID_SHA,
    reportId: VALID_REPORT_ID,
    startedAt: "2026-01-01T00:00:00Z",
    // D72 default: false. See makeSessionBoundSinceMeta for the
    // rationale; ad_hoc reports are NEVER rollback-targetable in
    // M D regardless of artifact presence (D72), so `false` is
    // also the semantic value the actual derivation would emit.
    rollbackAvailable: false,
    ...overrides,
  };
}

function makeMinimalConfig(overrides: Partial<Config> = {}): Config {
  return { version: 1, ...overrides };
}

function makeCheckResult(opts: {
  level: RiskLevel;
  category?: string;
  id?: string;
  recommendation?: string;
}): CheckResult {
  const requiresReco = opts.level === "high" || opts.level === "critical";
  const reco = opts.recommendation ?? (requiresReco ? "Test recommendation" : undefined);
  const base: CheckResult = {
    id: opts.id ?? "test.id",
    category: opts.category ?? "test",
    level: opts.level,
    confidence: "medium",
    title: "Test title",
    message: "Test message",
    evidence: [{ detail: "test detail" }],
  };
  return reco === undefined ? base : { ...base, recommendation: reco };
}

// =============================================================================
// Per-test temp repo (mergeChecksConfig → detectFrameworks does fs probes)
// =============================================================================

let tmpRoot: string;
let repoRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-checkorch-test-"));
  repoRoot = join(tmpRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// =============================================================================
// D48 default constants
// =============================================================================

describe("D48 default constants", () => {
  it("DEFAULT_RISK_BLOCK_ON === 'critical'", () => {
    expect(DEFAULT_RISK_BLOCK_ON).toBe("critical");
  });

  it("DEFAULT_RISK_WARN_ON === 'medium'", () => {
    expect(DEFAULT_RISK_WARN_ON).toBe("medium");
  });

  it("DEFAULT_CHECKS_CONFIG has all 8 toggle keys set to true", () => {
    expect(DEFAULT_CHECKS_CONFIG).toEqual({
      secrets: true,
      dependencies: true,
      migrations: true,
      auth: true,
      payments: true,
      infra: true,
      tests: true,
      scope_expansion: true,
    });
  });

  it("DEFAULT_FRAMEWORKS_POLICY === 'auto-detect'", () => {
    expect(DEFAULT_FRAMEWORKS_POLICY).toBe("auto-detect");
  });
});

// =============================================================================
// mergeChecksConfig
// =============================================================================

describe("mergeChecksConfig — D57 default merging", () => {
  it("empty config: applies all defaults; auto-detect returns [] on empty repo", async () => {
    const result = await mergeChecksConfig(makeMinimalConfig(), repoRoot);
    expect(result.riskBlockOn).toBe("critical");
    expect(result.riskWarnOn).toBe("medium");
    expect(result.checks).toEqual(DEFAULT_CHECKS_CONFIG);
    expect(result.frameworks).toEqual([]);
    expect(result.rollbackExclude).toEqual([]);
  });

  it("risk.block_on / warn_on overrides preserved", async () => {
    const result = await mergeChecksConfig(
      makeMinimalConfig({ risk: { block_on: "high", warn_on: "low" } }),
      repoRoot,
    );
    expect(result.riskBlockOn).toBe("high");
    expect(result.riskWarnOn).toBe("low");
  });

  it("explicit checks.* false overrides default true", async () => {
    const result = await mergeChecksConfig(
      makeMinimalConfig({ checks: { secrets: false, dependencies: false } }),
      repoRoot,
    );
    expect(result.checks.secrets).toBe(false);
    expect(result.checks.dependencies).toBe(false);
    // Other keys remain default true.
    expect(result.checks.migrations).toBe(true);
    expect(result.checks.auth).toBe(true);
  });

  it("explicit frameworks array used verbatim (skips auto-detect)", async () => {
    const result = await mergeChecksConfig(
      makeMinimalConfig({ frameworks: ["laravel", "nextjs"] }),
      repoRoot,
    );
    expect(result.frameworks).toEqual(["laravel", "nextjs"]);
  });

  it("frameworks omitted OR empty array → auto-detect invoked", async () => {
    const omitted = await mergeChecksConfig(makeMinimalConfig(), repoRoot);
    const empty = await mergeChecksConfig(makeMinimalConfig({ frameworks: [] }), repoRoot);
    expect(omitted.frameworks).toEqual([]);
    expect(empty.frameworks).toEqual([]);
  });

  it("rollback.exclude passed through; defaults to []", async () => {
    const withExcludes = await mergeChecksConfig(
      makeMinimalConfig({ rollback: { exclude: ["vendor/**"] } }),
      repoRoot,
    );
    expect(withExcludes.rollbackExclude).toEqual(["vendor/**"]);
    const without = await mergeChecksConfig(makeMinimalConfig(), repoRoot);
    expect(without.rollbackExclude).toEqual([]);
  });
});

// =============================================================================
// parseRawDiffToInputs — line-number mapping
// =============================================================================

describe("parseRawDiffToInputs — D28 line-number mapping", () => {
  it("add hunk: line numbers start at newStart and increment per add", () => {
    const raw: RawDiff = {
      entries: [
        makeEntry({
          hunks: [
            makeHunk({
              newStart: 10,
              oldStart: 0,
              lines: [
                { kind: "add", text: "line one" },
                { kind: "add", text: "line two" },
                { kind: "add", text: "line three" },
              ],
            }),
          ],
        }),
      ],
    };
    const inputs = parseRawDiffToInputs(raw);
    expect(inputs[0]?.addedLines).toEqual([
      { line: 10, text: "line one" },
      { line: 11, text: "line two" },
      { line: 12, text: "line three" },
    ]);
    expect(inputs[0]?.removedLines).toEqual([]);
  });

  it("remove hunk: line numbers start at oldStart and increment per remove", () => {
    const raw: RawDiff = {
      entries: [
        makeEntry({
          status: "deleted",
          hunks: [
            makeHunk({
              newStart: 0,
              oldStart: 5,
              lines: [
                { kind: "remove", text: "gone one" },
                { kind: "remove", text: "gone two" },
              ],
            }),
          ],
        }),
      ],
    };
    const inputs = parseRawDiffToInputs(raw);
    expect(inputs[0]?.removedLines).toEqual([
      { line: 5, text: "gone one" },
      { line: 6, text: "gone two" },
    ]);
    expect(inputs[0]?.addedLines).toEqual([]);
  });

  it("mixed add/remove/context: counters advance correctly through context", () => {
    // newStart=100, oldStart=100. Walk:
    //   context  → newLine 100 → 101, oldLine 100 → 101  (emit neither)
    //   remove   → oldLine 101 → 102  (emit { line:101, text:"removed" })
    //   add      → newLine 101 → 102  (emit { line:101, text:"added" })
    //   context  → newLine 102 → 103, oldLine 102 → 103  (emit neither)
    const raw: RawDiff = {
      entries: [
        makeEntry({
          status: "modified",
          hunks: [
            makeHunk({
              newStart: 100,
              oldStart: 100,
              lines: [
                { kind: "context", text: "unchanged" },
                { kind: "remove", text: "removed" },
                { kind: "add", text: "added" },
                { kind: "context", text: "unchanged 2" },
              ],
            }),
          ],
        }),
      ],
    };
    const inputs = parseRawDiffToInputs(raw);
    expect(inputs[0]?.addedLines).toEqual([{ line: 101, text: "added" }]);
    expect(inputs[0]?.removedLines).toEqual([{ line: 101, text: "removed" }]);
  });

  it("multiple hunks in one entry: counters reset per hunk", () => {
    const raw: RawDiff = {
      entries: [
        makeEntry({
          status: "modified",
          hunks: [
            makeHunk({
              newStart: 1,
              oldStart: 1,
              lines: [{ kind: "add", text: "first hunk" }],
            }),
            makeHunk({
              newStart: 50,
              oldStart: 49,
              lines: [{ kind: "add", text: "second hunk" }],
            }),
          ],
        }),
      ],
    };
    const inputs = parseRawDiffToInputs(raw);
    expect(inputs[0]?.addedLines).toEqual([
      { line: 1, text: "first hunk" },
      { line: 50, text: "second hunk" },
    ]);
  });

  it("binary entry: addedLines + removedLines empty regardless of hunks", () => {
    const raw: RawDiff = {
      entries: [
        makeEntry({
          isBinary: true,
          hunks: [makeHunk({ lines: [{ kind: "add", text: "would be ignored" }] })],
        }),
      ],
    };
    const inputs = parseRawDiffToInputs(raw);
    expect(inputs[0]?.isBinary).toBe(true);
    expect(inputs[0]?.addedLines).toEqual([]);
    expect(inputs[0]?.removedLines).toEqual([]);
  });

  it("rename entry: previous_path preserved on the ChangedFileInput", () => {
    const raw: RawDiff = {
      entries: [
        makeEntry({
          path: "src/new.ts",
          previous_path: "src/old.ts",
          status: "renamed",
        }),
      ],
    };
    const inputs = parseRawDiffToInputs(raw);
    expect(inputs[0]?.path).toBe("src/new.ts");
    expect(inputs[0]?.previous_path).toBe("src/old.ts");
    expect(inputs[0]?.status).toBe("renamed");
  });
});

// =============================================================================
// applyDiffPathExcludes — D3 symmetry filter
// =============================================================================

describe("applyDiffPathExcludes — D3 symmetry filter", () => {
  it("empty patterns: returns same RawDiff reference (no allocation)", () => {
    const raw: RawDiff = { entries: [makeEntry({ path: "src/foo.ts" })] };
    const result = applyDiffPathExcludes(raw, []);
    expect(result).toBe(raw);
  });

  it("single matching pattern: filters that entry out", () => {
    const raw: RawDiff = {
      entries: [makeEntry({ path: "src/foo.ts" }), makeEntry({ path: "vendor/lib.ts" })],
    };
    const result = applyDiffPathExcludes(raw, ["vendor/**"]);
    expect(result.entries.map((e) => e.path)).toEqual(["src/foo.ts"]);
  });

  it("glob pattern (vendor/**) matches nested paths", () => {
    const raw: RawDiff = {
      entries: [
        makeEntry({ path: "vendor/deep/nested/lib.ts" }),
        makeEntry({ path: "src/foo.ts" }),
      ],
    };
    const result = applyDiffPathExcludes(raw, ["vendor/**"]);
    expect(result.entries.map((e) => e.path)).toEqual(["src/foo.ts"]);
  });

  it("dot pattern (.env*) matches dotfiles via dot:true option", () => {
    const raw: RawDiff = {
      entries: [
        makeEntry({ path: ".env" }),
        makeEntry({ path: ".env.local" }),
        makeEntry({ path: "src/foo.ts" }),
      ],
    };
    const result = applyDiffPathExcludes(raw, [".env*"]);
    expect(result.entries.map((e) => e.path)).toEqual(["src/foo.ts"]);
  });

  it("multiple patterns: any match excludes", () => {
    const raw: RawDiff = {
      entries: [
        makeEntry({ path: "vendor/lib.ts" }),
        makeEntry({ path: "dist/bundle.js" }),
        makeEntry({ path: "src/foo.ts" }),
      ],
    };
    const result = applyDiffPathExcludes(raw, ["vendor/**", "dist/**"]);
    expect(result.entries.map((e) => e.path)).toEqual(["src/foo.ts"]);
  });

  it("nonegate option: leading-! pattern matches literally, not as negation", () => {
    const raw: RawDiff = {
      entries: [makeEntry({ path: "!special" }), makeEntry({ path: "src/foo.ts" })],
    };
    // With nonegate: true, "!special" matches the LITERAL path "!special",
    // not "everything except special". So src/foo.ts SURVIVES.
    const result = applyDiffPathExcludes(raw, ["!special"]);
    expect(result.entries.map((e) => e.path)).toEqual(["src/foo.ts"]);
  });

  it("case-sensitive (nocase: false): Vendor/foo not matched by vendor/**", () => {
    const raw: RawDiff = {
      entries: [makeEntry({ path: "Vendor/lib.ts" }), makeEntry({ path: "vendor/lib.ts" })],
    };
    const result = applyDiffPathExcludes(raw, ["vendor/**"]);
    expect(result.entries.map((e) => e.path)).toEqual(["Vendor/lib.ts"]);
  });
});

// =============================================================================
// computeRiskLevel
// =============================================================================

describe("computeRiskLevel — D52", () => {
  it("empty results → 'low'", () => {
    expect(computeRiskLevel([])).toBe("low");
  });

  it("all low → 'low'", () => {
    expect(
      computeRiskLevel([makeCheckResult({ level: "low" }), makeCheckResult({ level: "low" })]),
    ).toBe("low");
  });

  it("mixed levels → max via compareLevel", () => {
    expect(
      computeRiskLevel([
        makeCheckResult({ level: "low" }),
        makeCheckResult({ level: "high" }),
        makeCheckResult({ level: "medium" }),
      ]),
    ).toBe("high");
  });

  it("any critical → 'critical'", () => {
    expect(
      computeRiskLevel([
        makeCheckResult({ level: "low" }),
        makeCheckResult({ level: "critical" }),
        makeCheckResult({ level: "high" }),
      ]),
    ).toBe("critical");
  });
});

// =============================================================================
// computeSummary
// =============================================================================

describe("computeSummary — D53", () => {
  it("empty results → undefined (field omitted from report)", () => {
    expect(computeSummary([])).toBeUndefined();
  });

  it("single category: 'N findings: cat (n)'", () => {
    const result = computeSummary([
      makeCheckResult({ level: "low", category: "secrets" }),
      makeCheckResult({ level: "low", category: "secrets" }),
    ]);
    expect(result).toBe("2 findings: secrets (2)");
  });

  it("multiple categories sorted ASC by category name", () => {
    const result = computeSummary([
      makeCheckResult({ level: "low", category: "payments" }),
      makeCheckResult({ level: "high", category: "auth" }),
      makeCheckResult({ level: "low", category: "secrets" }),
      makeCheckResult({ level: "low", category: "auth" }),
    ]);
    expect(result).toBe("4 findings: auth (2), payments (1), secrets (1)");
  });
});

// =============================================================================
// buildReportFile
// =============================================================================

const FIXED_NOW_ENV = { [VIBEREVERT_TEST_FIXED_NOW]: "2026-01-01T00:00:00Z" };

describe("buildReportFile", () => {
  it("session_bound happy path: report_id === report.session_id === sess_id", () => {
    const file = buildReportFile({
      ctx: makeCtx(),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeSessionBoundSinceMeta(),
      env: FIXED_NOW_ENV,
    });
    expect(file.kind).toBe("session_bound");
    expect(file.report_id).toBe(VALID_SESSION_ID);
    expect(file.report.session_id).toBe(VALID_SESSION_ID);
    expect(file.since_resolved_sha).toBe(VALID_SHA);
  });

  it("ad_hoc happy path: report_id === report.session_id === rpt_id", () => {
    const file = buildReportFile({
      ctx: makeCtx(),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta(),
      env: FIXED_NOW_ENV,
    });
    expect(file.kind).toBe("ad_hoc");
    expect(file.report_id).toBe(VALID_REPORT_ID);
    expect(file.report.session_id).toBe(VALID_REPORT_ID);
  });

  it("staged_only: true emitted in output (literal-true semantics)", () => {
    const file = buildReportFile({
      ctx: makeCtx(),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta({ stagedOnly: true }),
      env: FIXED_NOW_ENV,
    });
    expect(file.staged_only).toBe(true);
  });

  it("staged_only NOT set → key absent from output (present-iff-true)", () => {
    const file = buildReportFile({
      ctx: makeCtx(),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta(),
      env: FIXED_NOW_ENV,
    });
    expect("staged_only" in file).toBe(false);
  });

  it("staged_only + session_bound → ReportFileSchema.parse throws (D31 refine)", () => {
    expect(() =>
      buildReportFile({
        ctx: makeCtx(),
        raw: { entries: [] },
        runResult: makeRunResult(),
        sinceMeta: makeSessionBoundSinceMeta({ stagedOnly: true }),
        env: FIXED_NOW_ENV,
      }),
    ).toThrow();
  });

  it("VIBEREVERT_TEST_FIXED_SHA env override applied to since_resolved_sha", () => {
    const file = buildReportFile({
      ctx: makeCtx(),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta({ sinceResolvedSha: VALID_SHA }),
      env: {
        ...FIXED_NOW_ENV,
        [VIBEREVERT_TEST_FIXED_SHA]: ANOTHER_VALID_SHA,
      },
    });
    expect(file.since_resolved_sha).toBe(ANOTHER_VALID_SHA);
  });

  it("VIBEREVERT_TEST_FIXED_NOW env override applied to written_at + ended_at", () => {
    const file = buildReportFile({
      ctx: makeCtx(),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta(),
      env: { [VIBEREVERT_TEST_FIXED_NOW]: "2026-06-15T12:00:00Z" },
    });
    expect(file.written_at).toBe("2026-06-15T12:00:00Z");
    expect(file.report.ended_at).toBe("2026-06-15T12:00:00Z");
  });

  it("task drift guard: sinceMeta.task and ctx.task AGREE → no throw, value used", () => {
    const file = buildReportFile({
      ctx: makeCtx({ task: "do the thing" }),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta({ task: "do the thing" }),
      env: FIXED_NOW_ENV,
    });
    expect(file.report.task).toBe("do the thing");
  });

  it("task drift guard: sinceMeta.task and ctx.task DISAGREE → throws", () => {
    expect(() =>
      buildReportFile({
        ctx: makeCtx({ task: "task A" }),
        raw: { entries: [] },
        runResult: makeRunResult(),
        sinceMeta: makeAdHocSinceMeta({ task: "task B" }),
        env: FIXED_NOW_ENV,
      }),
    ).toThrow(/disagree/);
  });

  it("task only on sinceMeta → used", () => {
    const file = buildReportFile({
      ctx: makeCtx(),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta({ task: "from sinceMeta" }),
      env: FIXED_NOW_ENV,
    });
    expect(file.report.task).toBe("from sinceMeta");
  });

  it("task only on ctx → used", () => {
    const file = buildReportFile({
      ctx: makeCtx({ task: "from ctx" }),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta(),
      env: FIXED_NOW_ENV,
    });
    expect(file.report.task).toBe("from ctx");
  });

  it("task absent from both → omitted from report (key absent)", () => {
    const file = buildReportFile({
      ctx: makeCtx(),
      raw: { entries: [] },
      runResult: makeRunResult(),
      sinceMeta: makeAdHocSinceMeta(),
      env: FIXED_NOW_ENV,
    });
    expect("task" in file.report).toBe(false);
  });

  it("risk_tags: defensively deduped + sorted from unsorted/duplicated map", () => {
    const raw: RawDiff = { entries: [makeEntry({ path: "src/foo.ts" })] };
    const riskTagsByPath = new Map<string, readonly string[]>([
      ["src/foo.ts", ["zebra", "apple", "apple", "mango"]],
    ]);
    const file = buildReportFile({
      ctx: makeCtx(),
      raw,
      runResult: makeRunResult({ riskTagsByPath }),
      sinceMeta: makeAdHocSinceMeta(),
      env: FIXED_NOW_ENV,
    });
    expect(file.report.changed_files[0]?.risk_tags).toEqual(["apple", "mango", "zebra"]);
  });

  it("risk_level: unmapped paths fall back to 'low' (D28 contract)", () => {
    const raw: RawDiff = {
      entries: [makeEntry({ path: "src/known.ts" }), makeEntry({ path: "src/unknown.ts" })],
    };
    const riskLevelByPath = new Map<string, RiskLevel>([["src/known.ts", "high"]]);
    const file = buildReportFile({
      ctx: makeCtx(),
      raw,
      runResult: makeRunResult({ riskLevelByPath }),
      sinceMeta: makeAdHocSinceMeta(),
      env: FIXED_NOW_ENV,
    });
    expect(file.report.changed_files.find((f) => f.path === "src/known.ts")?.risk_level).toBe(
      "high",
    );
    expect(file.report.changed_files.find((f) => f.path === "src/unknown.ts")?.risk_level).toBe(
      "low",
    );
  });
});

describe("computeRollbackAvailable — M D Step 4b D72", () => {
  // ---------------------------------------------------------------------------
  // Local helpers — scoped to this describe block. The fixture-builder
  // pattern (mkdtemp + try/finally cleanup) mirrors the convention used
  // across the codebase's filesystem-touching test suites.
  // ---------------------------------------------------------------------------

  interface TestRepoRoot {
    readonly repoRoot: string;
    cleanup: () => Promise<void>;
  }

  async function setupRepoRoot(): Promise<TestRepoRoot> {
    const tmp = await mkdtemp(join(tmpdir(), "viberevert-rollback-avail-"));
    return {
      repoRoot: tmp,
      cleanup: async () => {
        await rm(tmp, { recursive: true, force: true });
      },
    };
  }

  /**
   * Write a minimal-valid Manifest to `<checkpointDir>/manifest.json`
   * AND materialize empty stub files at every artifact path the
   * manifest references. Sufficient to make `loadCheckpoint` succeed.
   *
   * Why the stub files: `loadCheckpoint` enforces TWO contracts —
   *   (a) `ManifestSchema.parse` succeeds on the manifest JSON, AND
   *   (b) every referenced artifact path (`unstaged_patch_path`,
   *       `staged_patch_path`, `tracked_dirty_archive_path`,
   *       `untracked.archive_path`) resolves to an existing
   *       filesystem entry via `lstat`.
   * Without (b), `loadCheckpoint` throws `CheckpointCorruptError`
   * ("referenced artifact missing"), which propagates from
   * `computeRollbackAvailable` as a non-CheckpointNotFoundError and
   * makes test 1 fail. The stubs are 0-byte placeholders — content
   * is not validated, only existence is.
   */
  async function writeMinimalCheckpointManifest(
    checkpointDir: string,
    sessionId: string,
  ): Promise<void> {
    await mkdir(checkpointDir, { recursive: true });
    const manifest = {
      schema_version: SCHEMA_VERSION,
      session_id: sessionId,
      captured_at: "2026-01-01T00:00:00Z",
      git: {
        head_sha: "0".repeat(40),
        branch: "main",
        porcelain_v1: "",
      },
      diffs: {
        unstaged_patch_path: "diffs/unstaged.patch",
        staged_patch_path: "diffs/staged.patch",
      },
      snapshots: {
        tracked_dirty_archive_path: "snapshots/tracked.tar.gz",
        tracked_dirty_paths: [],
        file_hashes: {},
      },
      untracked: {
        archive_path: "snapshots/untracked.tar.gz",
        exclude_patterns: [],
        file_hashes: {},
      },
      rollback_target_description: "test fixture checkpoint",
    };
    await writeFile(join(checkpointDir, "manifest.json"), JSON.stringify(manifest));

    // Materialize the four referenced artifact paths as empty files so
    // loadCheckpoint's lstat checks succeed. mkdir the two parent
    // subdirs first (recursive is fine — both might or might not
    // already exist depending on which path we touched first).
    await mkdir(join(checkpointDir, "diffs"), { recursive: true });
    await mkdir(join(checkpointDir, "snapshots"), { recursive: true });
    await writeFile(join(checkpointDir, "diffs/unstaged.patch"), "");
    await writeFile(join(checkpointDir, "diffs/staged.patch"), "");
    await writeFile(join(checkpointDir, "snapshots/tracked.tar.gz"), "");
    await writeFile(join(checkpointDir, "snapshots/untracked.tar.gz"), "");
  }

  function sessionCheckpointDir(repoRoot: string, sessionId: string): string {
    return join(repoRoot, ".viberevert", "sessions", sessionId, "checkpoint");
  }

  function globalCheckpointDir(repoRoot: string, checkpointId: string): string {
    return join(repoRoot, ".viberevert", "checkpoints", checkpointId);
  }

  // ---------------------------------------------------------------------------
  // Tests — one per locked branch of the D72 rule
  // ---------------------------------------------------------------------------

  it("returns true when session_bound and the session's inner checkpoint manifest loads", async () => {
    const env = await setupRepoRoot();
    try {
      await writeMinimalCheckpointManifest(
        sessionCheckpointDir(env.repoRoot, VALID_SESSION_ID),
        VALID_SESSION_ID,
      );

      const result = await computeRollbackAvailable(makeSessionBoundSinceMeta(), env.repoRoot);
      expect(result).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it("returns false when session_bound and the inner checkpoint dir is missing", async () => {
    const env = await setupRepoRoot();
    try {
      // No checkpoint written. loadCheckpoint will throw
      // CheckpointNotFoundError, which the helper swallows → false.
      const result = await computeRollbackAvailable(makeSessionBoundSinceMeta(), env.repoRoot);
      expect(result).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it("ARCHITECTURAL CANARY: returns false when only the GLOBAL checkpoint dir exists and the session's inner checkpoint dir is missing", async () => {
    // The locked invariant being pinned: computeRollbackAvailable
    // probes `.viberevert/sessions/<sess>/checkpoint/`, NOT
    // `.viberevert/checkpoints/<cp>/`. Without this test, a
    // regression that switched to the global store would pass tests
    // 1, 2, 4, 5 cleanly (those don't set up a global checkpoint at
    // all). Here we set up ONLY the global checkpoint — a regression
    // would erroneously return true and this test would fail.
    const env = await setupRepoRoot();
    try {
      const globalCheckpointId = "cp_01JV8Y7W2M7AABCDEFGHJKMNPQ";
      await writeMinimalCheckpointManifest(
        globalCheckpointDir(env.repoRoot, globalCheckpointId),
        VALID_SESSION_ID,
      );
      // Deliberately do NOT create the session's inner checkpoint dir.

      const result = await computeRollbackAvailable(
        makeSessionBoundSinceMeta({ checkpointId: globalCheckpointId }),
        env.repoRoot,
      );
      expect(result).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it("returns false when kind is ad_hoc (M D rollback is session-only per D59; no I/O fires)", async () => {
    // The ad_hoc branch short-circuits BEFORE any filesystem access,
    // so repoRoot pointing at a nonexistent path is fine — the test
    // also implicitly proves the no-I/O property.
    const result = await computeRollbackAvailable(
      makeAdHocSinceMeta(),
      "/this/path/does/not/exist/and/that/is/fine",
    );
    expect(result).toBe(false);
  });

  it("propagates non-CheckpointNotFoundError load failures (corrupted manifest JSON)", async () => {
    const env = await setupRepoRoot();
    try {
      const checkpointDir = sessionCheckpointDir(env.repoRoot, VALID_SESSION_ID);
      await mkdir(checkpointDir, { recursive: true });
      // Malformed JSON triggers CheckpointCorruptError (or similar
      // non-CNF error) inside loadCheckpoint. The helper does NOT
      // swallow this — propagation is the locked safety move: a
      // corrupted/tampered checkpoint must surface to the CLI, not
      // silently degrade rollback_available to false.
      await writeFile(join(checkpointDir, "manifest.json"), "{this is not valid JSON");

      await expect(
        computeRollbackAvailable(makeSessionBoundSinceMeta(), env.repoRoot),
      ).rejects.toThrow();
    } finally {
      await env.cleanup();
    }
  });

  it("fail-closed: rejects malformed reportId BEFORE any filesystem path interpolation", async () => {
    // The fail-closed SESSION_ID_RE guard fires before any join() or
    // loadCheckpoint call, so repoRoot pointing at a nonexistent path
    // is irrelevant — the throw should fire from the regex check
    // alone. Without this guard, a buggy upstream caller could make
    // the helper read outside the intended session checkpoint dir
    // via traversal-like segments. Same defense pattern as
    // loadEndOfSessionChangedPaths in @viberevert/git.
    await expect(
      computeRollbackAvailable(
        makeSessionBoundSinceMeta({ reportId: "../escape/not-a-session-id" }),
        "/irrelevant/path",
      ),
    ).rejects.toThrow(/not a valid session id/);
  });
});
