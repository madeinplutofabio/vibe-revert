// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// CLI check orchestration — pure helpers consumed by `viberevert check`
// (Phase D). Per D29 this module owns NONE of:
//   - terminal output (no console/stderr/stdout)
//   - filesystem writes (the CLI command does atomic writes)
//   - git invocation (delegated to @viberevert/git)
// It only orchestrates: applies config defaults, translates git's raw
// diff into the checks engine's input shape, composes the persisted
// ReportFile, and computes the report-level aggregates.
//
// Locked exports per D48 (architectural-invariants test in Phase F grep-
// asserts these symbol names appear ONLY in this file):
//   - DEFAULT_RISK_BLOCK_ON, DEFAULT_RISK_WARN_ON (D24 default gate +
//     warn thresholds)
//   - DEFAULT_CHECKS_CONFIG (all 8 keys true per D57)
//   - DEFAULT_FRAMEWORKS_POLICY ("auto-detect" sentinel per D42/D57)
//
// Locked design rules:
//
//   - **Defaults applied ONLY here.** Per D57, `loadConfig` returns the
//     parsed config with optional fields as `undefined`; defaults flow
//     in at the engine/CLI boundary via `mergeChecksConfig`. No defaults
//     in core's schema; no defaults inside any check implementation.
//
//   - **buildReportFile validates before returning.** Calls
//     `ReportFileSchema.parse(file)` so noise-budget violations, the
//     identity-consistency refine (report.session_id === report_id),
//     and the since_kind ↔ kind / staged_only ↔ kind refines all
//     surface as a single typed failure at the orchestrator boundary.
//
//   - **buildReportFile drift-guards task input.** `sinceMeta.task`
//     and `ctx.task` are both honored (caller may set either), but if
//     BOTH are set and they DISAGREE, the function throws. Avoids
//     silent drift between the session/ad-hoc task carried in
//     sinceMeta and the CheckContext task the engine consumed.
//
//   - **Env-aware time + SHA resolvers.** `buildReportFile` accepts an
//     optional `env` parameter that flows into `resolveNowForCliTimestamp`
//     and `resolveSinceResolvedShaForReport` from C.1, so the golden-
//     fixture harness (Step 10) can pin all wall-clock + audit values
//     to deterministic sentinels via env-var overrides.
//
//   - **Picomatch options identical to git/checks.** `applyDiffPathExcludes`
//     uses the SAME `{ dot: true, nocase: false, posixSlashes: true,
//     nonegate: true }` options as `@viberevert/git`'s candidate-filter
//     in `getDiffSinceCheckpoint` and `@viberevert/checks`'s
//     path-classifier matcher. Single source of truth for glob
//     semantics across the codebase.
//
//   - **No I/O beyond what mergeChecksConfig delegates.**
//     `mergeChecksConfig` calls `core.detectFrameworks(repoRoot)` (which
//     does fs.existsSync probes) when `config.frameworks` is
//     omitted/empty; everything else is in-memory transformation.

import { join } from "node:path";
import type {
  ChangedFileInput,
  CheckContext,
  LineChunk,
  RunChecksResult,
} from "@viberevert/checks";
import { type Config, detectFrameworks } from "@viberevert/core";
import {
  CheckpointNotFoundError,
  loadCheckpoint,
  type RawDiff,
  type RawDiffEntry,
} from "@viberevert/git";
import {
  type ChangedFile,
  type CheckResult,
  compareLevel,
  REPORT_FILE_SCHEMA_VERSION,
  type ReportFile,
  type ReportFileKind,
  ReportFileSchema,
  type RiskLevel,
  SCHEMA_VERSION,
  type SessionReport,
  type SinceKind,
} from "@viberevert/session-format";
import picomatch from "picomatch";

import { resolveNowForCliTimestamp, resolveSinceResolvedShaForReport } from "./runtime-env.js";

// =============================================================================
// D48-locked default constants
// =============================================================================

/** Default `risk.block_on` per D24 / D57. */
export const DEFAULT_RISK_BLOCK_ON: RiskLevel = "critical";

/** Default `risk.warn_on` per D24 / D57. */
export const DEFAULT_RISK_WARN_ON: RiskLevel = "medium";

/**
 * Default per-category enable map per D57. All 8 keys default to true;
 * the user opts OUT by setting a key to `false` in `.viberevert.yml`.
 * Typed against `keyof ConfigChecks` so adding a new check toggle to
 * the schema forces an update here at compile time.
 */
type ConfigChecks = NonNullable<Config["checks"]>;
type ChecksToggleKey = keyof ConfigChecks;
export const DEFAULT_CHECKS_CONFIG: Readonly<Record<ChecksToggleKey, boolean>> = {
  secrets: true,
  dependencies: true,
  migrations: true,
  auth: true,
  payments: true,
  infra: true,
  tests: true,
  scope_expansion: true,
};

/**
 * Sentinel that documents the default-frameworks policy per D42 / D57:
 * when `config.frameworks` is omitted or empty, `mergeChecksConfig`
 * invokes `core.detectFrameworks(repoRoot)`. The const is exported for
 * discoverability + the D48 invariant grep; the merge function does
 * not branch on its value (the branch is on `config.frameworks` being
 * non-empty).
 */
export const DEFAULT_FRAMEWORKS_POLICY = "auto-detect" as const;

// =============================================================================
// Picomatch options (LOCKED — identical across git/checks/cli)
// =============================================================================

const PICOMATCH_OPTIONS = {
  dot: true,
  nocase: false,
  posixSlashes: true,
  nonegate: true,
} as const;

// =============================================================================
// ResolvedChecksConfig
// =============================================================================

export interface ResolvedChecksConfig {
  readonly riskBlockOn: RiskLevel;
  readonly riskWarnOn: RiskLevel;
  readonly checks: Readonly<Record<ChecksToggleKey, boolean>>;
  readonly frameworks: readonly string[];
  readonly rollbackExclude: readonly string[];
}

/**
 * Apply M C defaults per D57 to a loaded `Config`. Returns a fully-
 * resolved view with every field guaranteed non-undefined:
 *
 *   - `risk.block_on` / `risk.warn_on` default to `DEFAULT_RISK_*`.
 *   - Each `checks.*` toggle defaults to true.
 *   - `frameworks`: if `config.frameworks` is non-empty, returned
 *     verbatim. Otherwise `core.detectFrameworks(repoRoot)` is invoked.
 *   - `rollback.exclude` defaults to `[]`.
 *
 * Per D57's "defaults applied at the engine boundary, not in loadConfig"
 * rule, this is the SOLE place those defaults exist. The D48
 * architectural-invariants test enforces that no other module in
 * `packages/**​/src/**` exports symbols matching
 * `/^DEFAULT_(RISK|CHECKS|FRAMEWORKS)_/`.
 */
export async function mergeChecksConfig(
  config: Config,
  repoRoot: string,
): Promise<ResolvedChecksConfig> {
  const riskBlockOn = config.risk?.block_on ?? DEFAULT_RISK_BLOCK_ON;
  const riskWarnOn = config.risk?.warn_on ?? DEFAULT_RISK_WARN_ON;

  const checks: Record<ChecksToggleKey, boolean> = {
    secrets: config.checks?.secrets ?? DEFAULT_CHECKS_CONFIG.secrets,
    dependencies: config.checks?.dependencies ?? DEFAULT_CHECKS_CONFIG.dependencies,
    migrations: config.checks?.migrations ?? DEFAULT_CHECKS_CONFIG.migrations,
    auth: config.checks?.auth ?? DEFAULT_CHECKS_CONFIG.auth,
    payments: config.checks?.payments ?? DEFAULT_CHECKS_CONFIG.payments,
    infra: config.checks?.infra ?? DEFAULT_CHECKS_CONFIG.infra,
    tests: config.checks?.tests ?? DEFAULT_CHECKS_CONFIG.tests,
    scope_expansion: config.checks?.scope_expansion ?? DEFAULT_CHECKS_CONFIG.scope_expansion,
  };

  let frameworks: readonly string[];
  if (config.frameworks !== undefined && config.frameworks.length > 0) {
    frameworks = config.frameworks;
  } else {
    frameworks = await detectFrameworks(repoRoot);
  }

  const rollbackExclude = config.rollback?.exclude ?? [];

  return { riskBlockOn, riskWarnOn, checks, frameworks, rollbackExclude };
}

// =============================================================================
// parseRawDiffToInputs
// =============================================================================

/**
 * Translate git's `RawDiff` (with `{kind, text}` line records) into the
 * checks engine's `ChangedFileInput[]` shape (with `{line, text}`
 * records split into `addedLines` + `removedLines`).
 *
 * Line-number tracking per D28's locked contract:
 *   - addedLines: only `+` lines, numbered in the NEW file
 *     (counter starts at hunk.newStart, increments on `+` and ` `).
 *   - removedLines: only `-` lines, numbered in the OLD file
 *     (counter starts at hunk.oldStart, increments on `-` and ` `).
 *   - context lines do NOT enter either array.
 *
 * Binary entries (isBinary=true) produce empty addedLines/removedLines —
 * content scanning is suppressed for binaries per D28's contract.
 */
export function parseRawDiffToInputs(raw: RawDiff): readonly ChangedFileInput[] {
  return raw.entries.map(entryToInput);
}

function entryToInput(entry: RawDiffEntry): ChangedFileInput {
  const addedLines: LineChunk[] = [];
  const removedLines: LineChunk[] = [];
  if (!entry.isBinary) {
    for (const hunk of entry.hunks) {
      let newLine = hunk.newStart;
      let oldLine = hunk.oldStart;
      for (const l of hunk.lines) {
        if (l.kind === "add") {
          addedLines.push({ line: newLine, text: l.text });
          newLine += 1;
        } else if (l.kind === "remove") {
          removedLines.push({ line: oldLine, text: l.text });
          oldLine += 1;
        } else {
          // context — advance both counters but emit neither.
          newLine += 1;
          oldLine += 1;
        }
      }
    }
  }
  return {
    path: entry.path,
    ...(entry.previous_path !== undefined ? { previous_path: entry.previous_path } : {}),
    status: entry.status,
    addedLines,
    removedLines,
    isBinary: entry.isBinary,
  };
}

// =============================================================================
// applyDiffPathExcludes (D3 symmetry at check time per D56)
// =============================================================================

/**
 * Filter `raw.entries` whose `path` matches any of `excludePatterns`.
 * Used by the CLI to enforce D3 symmetry on git-ref-mode diffs (the
 * `getDiffSinceCheckpoint` path filters internally before mirror
 * construction; this is the explicit filter for `getDiffSinceRef`-mode
 * AND a defense-in-depth pass for checkpoint mode).
 *
 * Uses the LOCKED picomatch options — identical to the matchers in
 * `@viberevert/git`'s candidate-filter and `@viberevert/checks`'s
 * path-classifier — so glob semantics agree across the codebase.
 * Empty `excludePatterns` is a no-op (returns the same RawDiff
 * reference; no allocation).
 */
export function applyDiffPathExcludes(raw: RawDiff, excludePatterns: readonly string[]): RawDiff {
  if (excludePatterns.length === 0) return raw;
  const matchers = excludePatterns.map((p) => picomatch(p, PICOMATCH_OPTIONS));
  const filtered = raw.entries.filter((e) => {
    for (const m of matchers) {
      if (m(e.path)) return false;
    }
    return true;
  });
  return { entries: filtered };
}

// =============================================================================
// Risk-level + summary aggregates
// =============================================================================

/**
 * `SessionReport.risk_level` per D52: `max(...results.level, "low")`
 * using `compareLevel`. Empty results → `"low"`.
 */
export function computeRiskLevel(results: readonly CheckResult[]): RiskLevel {
  let max: RiskLevel = "low";
  for (const r of results) {
    if (compareLevel(r.level, max) > 0) {
      max = r.level;
    }
  }
  return max;
}

/**
 * `SessionReport.summary` per D53: a deterministic one-line breakdown
 * by category (sorted ASC). Empty results → `undefined` (the schema
 * marks the field optional; omit rather than emit an empty string).
 *
 * Format: `"<N> findings: <cat> (<n>), <cat> (<n>), ..."`.
 */
export function computeSummary(results: readonly CheckResult[]): string | undefined {
  if (results.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const r of results) {
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const breakdown = sorted.map(([c, n]) => `${c} (${n})`).join(", ");
  return `${results.length} findings: ${breakdown}`;
}

// =============================================================================
// computeRollbackAvailable (M D — D72)
// =============================================================================

// TODO(M D follow-up): SESSION_ID_RE is duplicated here from
// @viberevert/git/src/git-cli.ts's `loadEndOfSessionChangedPaths`
// (same shape, same purpose: fail-closed validation of session ids
// used as path segments before any filesystem I/O). The long-term
// home for this regex is @viberevert/session-format (exported,
// consumed by every helper that reads session-owned paths). See the
// matching TODO in git-cli.ts for the full deduplication list
// (`.viberevert/sessions`, `after-status.{txt,z}`, sess_<ULID>
// shape). Until that lift happens, keep the two copies BYTE-
// IDENTICAL — a drift between readers would surface as
// inconsistent "valid session id" decisions across the codebase.
const SESSION_ID_RE = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Compute the `rollback_available` boolean for a report's `sinceMeta`,
 * per D72's strict rule:
 *
 *   - `kind === "ad_hoc"` → false (M D's rollback engine is
 *     session-only per D59; ad-hoc reports — including
 *     checkpoint-name, checkpoint-id, and git-ref bases — are not
 *     rollback-targetable in M D regardless of artifact presence).
 *   - `kind === "session_bound"` → fail-closed validate that
 *     `sinceMeta.reportId` matches `SESSION_ID_RE` (throws plain
 *     Error otherwise), then probe the SESSION-OWNED INNER
 *     checkpoint dir at `.viberevert/sessions/<sess>/checkpoint/`
 *     and return `true` iff `loadCheckpoint` succeeds.
 *     `CheckpointNotFoundError` → false; ANY other error
 *     propagates (no swallowing of I/O / corruption failures —
 *     those should surface to the CLI, not silently degrade the
 *     report).
 *
 * Three architectural locks:
 *
 *   1. **`sinceMeta.reportId` is used because, for `session_bound`,
 *      it IS the originating session's id** (per the dual-meaning
 *      JSDoc on `BuildReportSinceMeta.reportId`). If that contract
 *      ever changes — e.g., reportId becomes a fresh id for both
 *      kinds — this helper MUST be updated to source the session
 *      id elsewhere. The coupling is intentional and grep-
 *      discoverable via this comment.
 *
 *   2. **`reportId` must validate against `SESSION_ID_RE` before
 *      any path interpolation.** Without this fail-closed check,
 *      a malformed reportId from a buggy upstream caller (e.g.,
 *      a future code path that skips
 *      `check-since-resolution.ts`'s validation, or a corrupted
 *      `active-session.json` smuggling a bad id) could make this
 *      helper read outside the intended session checkpoint dir
 *      via traversal-like segments. Same defense pattern as
 *      `loadEndOfSessionChangedPaths` in @viberevert/git — see
 *      that helper's R1 hardening for the matching rationale.
 *
 *   3. **Probes the same checkpoint directory rollback will restore
 *      from**, NOT the globally-named checkpoint id (`cp_<ULID>`
 *      under `.viberevert/checkpoints/`). Rollback restores from the
 *      session's INNER checkpoint per M B's locked storage layout;
 *      using the global store here could return `true` for a
 *      report whose actual rollback target is missing/corrupt.
 *      A future "let me reuse this for non-session contexts"
 *      refactor must confront this comment first.
 *
 * Called by the CLI's `check.ts` orchestrator when constructing
 * `BuildReportSinceMeta`; the boolean result is threaded through
 * `sinceMeta.rollbackAvailable` so `buildReportFile` stays pure/sync.
 */
export async function computeRollbackAvailable(
  sinceMeta: BuildReportSinceMeta,
  repoRoot: string,
): Promise<boolean> {
  if (sinceMeta.kind !== "session_bound") return false;

  if (!SESSION_ID_RE.test(sinceMeta.reportId)) {
    throw new Error(
      `Cannot compute rollback availability: session_bound reportId is not a valid session id: ${JSON.stringify(
        sinceMeta.reportId,
      )}`,
    );
  }

  const checkpointDir = join(repoRoot, ".viberevert", "sessions", sinceMeta.reportId, "checkpoint");

  try {
    await loadCheckpoint(checkpointDir);
    return true;
  } catch (err) {
    if (err instanceof CheckpointNotFoundError) return false;
    throw err;
  }
}

// =============================================================================
// buildReportFile
// =============================================================================

export interface BuildReportSinceMeta {
  /** session_bound (--since sess_X or active session) | ad_hoc (everything else). */
  readonly kind: ReportFileKind;
  /** D56 since-kind discriminator. */
  readonly sinceKind: SinceKind;
  /** Verbatim user-input form, post-resolution. */
  readonly sinceRef: string;
  /** REAL sha (from git rev-parse or manifest.git.head_sha); resolver applies env override. */
  readonly sinceResolvedSha: string;
  /**
   * For session_bound: the originating session's id (sess_<ULID>).
   * For ad_hoc: a freshly-generated rpt_<ULID>.
   * Per D31's identity-consistency refine, this value is used for BOTH
   * `wrapper.report_id` AND `wrapper.report.session_id`.
   */
  readonly reportId: string;
  /** Only for session_bound: the originating session's checkpoint_id. */
  readonly checkpointId?: string;
  /**
   * Whether rollback can actually run on this report's underlying
   * artifact, per D72. Derived UPSTREAM in the CLI orchestrator via
   * `computeRollbackAvailable` (see helper below) and threaded
   * through verbatim so `buildReportFile` stays pure/sync — no I/O
   * inside report composition. The strict rule (locked):
   *   - `kind === "ad_hoc"` → false (M D doesn't roll back ad-hoc).
   *   - `kind === "session_bound"` AND the session's INNER
   *     checkpoint manifest loads → true.
   *   - `kind === "session_bound"` AND the inner checkpoint is
   *     missing → false. Non-CheckpointNotFoundError load failures
   *     (corruption, I/O, malformed reportId rejecting the path
   *     guard) propagate from `computeRollbackAvailable` rather than
   *     silently degrading the report to false.
   */
  readonly rollbackAvailable: boolean;
  /**
   * report.started_at: for session_bound, mirrors session.json's
   * started_at; for ad_hoc with checkpoint base, the manifest's
   * captured_at; for ad_hoc with git-ref base, the commit's `%cI`
   * timestamp (from git.getCommitTimestamp).
   */
  readonly startedAt: string;
  /**
   * Present-iff-true per D31's `z.literal(true).optional()`. Implies
   * `kind === "ad_hoc"` (the schema refine enforces this).
   */
  readonly stagedOnly?: true;
  /**
   * Optional task string. Per D28's task-precedence rule, the CLI
   * caller may resolve task either upstream (and pass via CheckContext)
   * or carry it on sinceMeta. buildReportFile honors EITHER but throws
   * if both are set and disagree.
   */
  readonly task?: string;
  /** Optional agent_command (reserved for M G2). */
  readonly agentCommand?: string;
}

export interface BuildReportFileParams {
  readonly ctx: CheckContext;
  readonly raw: RawDiff;
  readonly runResult: RunChecksResult;
  readonly sinceMeta: BuildReportSinceMeta;
  /** Optional env override for runtime-env resolvers (C.1). */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Compose the full `ReportFile` for the CLI's persist + render step.
 *
 * Key-order is schema-declaration order per D54 so a downstream
 * `JSON.stringify(file, null, 2)` produces byte-stable output for
 * byte-stable inputs (golden-fixture guarantee).
 *
 * Returns the value AFTER `ReportFileSchema.parse(file)` — catches
 * noise-budget violations (engine bug), the identity-consistency
 * refine (report.session_id === report_id), and the
 * since_kind ↔ kind / staged_only ↔ kind refines at the orchestrator
 * boundary instead of letting them surface later during persistence.
 *
 * Task handling: `sinceMeta.task` and `ctx.task` are both honored, but
 * if both are set AND disagree, the function throws (drift guard).
 * This catches a CLI bug where the orchestrator wires different task
 * values into the two slots.
 *
 * `rollback_available` is derived per D72 by `computeRollbackAvailable`
 * (the helper above this function) and threaded through via
 * `sinceMeta.rollbackAvailable`. The derivation runs UPSTREAM of
 * `buildReportFile` so this function stays pure/sync — no I/O inside
 * report composition. Session-bound reports whose inner checkpoint
 * loads → true; ad-hoc reports OR session-bound reports whose inner
 * checkpoint is missing → false. Non-CheckpointNotFoundError load
 * failures (corruption, I/O, fail-closed reportId-validation throws)
 * propagate from `computeRollbackAvailable` rather than being
 * downgraded to `false`.
 */
export function buildReportFile(params: BuildReportFileParams): ReportFile {
  const { ctx, raw, runResult, sinceMeta, env } = params;

  const writtenAt = resolveNowForCliTimestamp(env);
  const endedAt = writtenAt;
  const sinceResolvedSha = resolveSinceResolvedShaForReport(sinceMeta.sinceResolvedSha, env);

  // Task drift guard — see method doc. Resolved task is non-undefined
  // iff at least one source provided it.
  if (sinceMeta.task !== undefined && ctx.task !== undefined && sinceMeta.task !== ctx.task) {
    throw new Error("buildReportFile: sinceMeta.task and ctx.task disagree");
  }
  const task = sinceMeta.task ?? ctx.task;

  // changed_files: zip raw.entries with runResult's per-path maps.
  const changedFiles: ChangedFile[] = raw.entries.map((entry) => {
    const tagsRaw = runResult.riskTagsByPath.get(entry.path) ?? [];
    // ChangedFileSchema requires sortedUniqueStringArray; dedupe + sort
    // defensively (the engine map's value shape isn't a guaranteed contract).
    const tags = [...new Set(tagsRaw)].sort();
    const level = runResult.riskLevelByPath.get(entry.path) ?? "low";
    return {
      path: entry.path,
      ...(entry.previous_path !== undefined ? { previous_path: entry.previous_path } : {}),
      status: entry.status,
      risk_tags: tags,
      risk_level: level,
    };
  });

  const riskLevel = computeRiskLevel(runResult.results);
  const summary = computeSummary(runResult.results);

  // SessionReport in schema-declaration order (D54).
  const report: SessionReport = {
    schema_version: SCHEMA_VERSION,
    session_id: sinceMeta.reportId,
    started_at: sinceMeta.startedAt,
    ended_at: endedAt,
    ...(sinceMeta.agentCommand !== undefined ? { agent_command: sinceMeta.agentCommand } : {}),
    detected_frameworks: [...new Set(ctx.detectedFrameworks)].sort(),
    ...(task !== undefined ? { task } : {}),
    ...(sinceMeta.checkpointId !== undefined ? { checkpoint_id: sinceMeta.checkpointId } : {}),
    risk_level: riskLevel,
    changed_files: changedFiles,
    results: [...runResult.results],
    rollback_available: sinceMeta.rollbackAvailable,
    ...(summary !== undefined ? { summary } : {}),
  };

  // ReportFile in schema-declaration order (D54).
  const file: ReportFile = {
    schema_version: REPORT_FILE_SCHEMA_VERSION,
    kind: sinceMeta.kind,
    report_id: sinceMeta.reportId,
    since_kind: sinceMeta.sinceKind,
    since_ref: sinceMeta.sinceRef,
    since_resolved_sha: sinceResolvedSha,
    ...(sinceMeta.stagedOnly === true ? { staged_only: true as const } : {}),
    written_at: writtenAt,
    report,
  };

  return ReportFileSchema.parse(file);
}
