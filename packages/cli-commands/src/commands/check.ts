// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert check [--since <ref>] [--staged] [--threshold <level>]
//                    [--task "..."] [--json]`
//
// Run risk checks against the diff between the current working tree and
// a base (checkpoint, session, or git ref). Produces a persisted
// `ReportFile` artifact AND a rendered human-or-machine view to stdout.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
// 1. **D19 — REQUIRES valid config.** `risk.block_on` controls the exit
//    code (D24), `risk.warn_on` controls the default output threshold
//    (D38), `frameworks` flows into the checks engine context (D41/D42),
//    `checks.*` toggles the per-category enable map (D28/D57), and
//    `rollback.exclude` filters the diff for D3 symmetry (D56). Silent
//    defaults from a missing config would diverge the exit code and the
//    filtered set from user expectations. Hard-fail on missing/invalid
//    config with the locked directive copy.
//
// 2. **D24 — Exit codes are locked.** 0 = no findings at-or-above
//    `resolved.riskBlockOn`. 1 = internal/config error (any typed-error
//    catch, the persist-failure catch, OR the catch-all unknown-error
//    rethrow Clipanion turns into its own non-zero). 2 = ≥1 finding
//    at-or-above `resolved.riskBlockOn`. **--threshold does NOT affect
//    exit code** per D38 — the gate always uses `resolved.riskBlockOn`
//    from `mergeChecksConfig`.
//
// 3. **D26 + D58 — --since dispatch via resolveCheckBase.** The
//    resolver in `check-since-resolution.ts` owns the D26 resolution
//    order (sess → cp → name → git-ref, with omitted-default and
//    --staged short-circuit rules) and the D58 mutual-exclusion check
//    for --staged + snapshot bases. check.ts just passes the user's
//    --since / --staged flags through and dispatches on the returned
//    `base.mode` to call either getDiffSinceRef or getDiffSinceCheckpoint.
//    Typed errors from the resolver (StagedIncompatibleWith…,
//    CheckpointNameNotFound…) are surfaced via the centralized
//    handleKnownError helper.
//
// 4. **D29 — check.ts owns stderr/stdout writes.** No orchestration
//    helper (check-orchestration.ts, check-since-resolution.ts,
//    runtime-env.ts) writes to the terminal. The reporters package
//    returns values that check.ts writes to stdout. The git package's
//    `getDiffSinceCheckpoint` returns `cleanupWarnings` on its result
//    (and attaches them to thrown errors); check.ts is the place that
//    decides how to surface those.
//
// 5. **D38 — --threshold is OUTPUT-ONLY.** The persisted ReportFile
//    contains the FULL unfiltered findings set; only the rendered view
//    is filtered. Default threshold (when --threshold not passed):
//    `undefined` (no filter) under --json; `resolved.riskWarnOn`
//    otherwise. Exit code uses `resolved.riskBlockOn` regardless of
//    --threshold.
//
// 6. **D44 — no D22 lock for check.** Check is a read operation against
//    the working tree + session/checkpoint state; it does not mutate
//    session state. Writes are to `report.json` files at deterministic
//    paths; atomic temp+rename (D13) makes concurrent overwrites safe
//    (last-writer-wins, no corruption possible). Two parallel checks
//    against different bases touch disjoint files. No lock acquisition.
//
// 7. **D56 — diff dispatch on base.mode.** "git-ref" → getDiffSinceRef
//    with {staged: base.stagedOnly}. "checkpoint" →
//    getDiffSinceCheckpoint with {liveExcludePatterns:
//    resolved.rollbackExclude}. Both helpers return
//    DiffResult { diff, cleanupWarnings }.
//
// 8. **D17b/D26 — atomic persistence dispatch on base.kind.**
//    "session_bound" → file-level writeFileAtomic to
//    `.viberevert/sessions/<sess>/report.json` (the session dir already
//    exists; re-runs OVERWRITE atomically per D44). "ad_hoc" → dir-level
//    rename: mkdir .viberevert/reports/ idempotent (always-shared
//    parent), mkdir .viberevert/reports/.tmp-rpt-<hex>/ NON-recursively
//    (so a stale or collision-reused dir fails loud with EEXIST rather
//    than silently joining a dir we didn't create — without this guard,
//    the renameDirAtomic step would move whatever the pre-existing dir
//    contained to the final reportId location), writeFileAtomic the
//    inner report.json, then renameDirAtomic to
//    .viberevert/reports/<rpt_<ULID>>/. On any failure inside the
//    ad-hoc path, best-effort rm -rf of the temp dir ONLY if we
//    successfully created it (via the `tmpDirCreated` flag) — so the
//    cleanup never removes a pre-existing dir we didn't own. D13
//    tolerates leftovers if cleanup also fails (loaders ignore .tmp-*).
//    The persist step is wrapped in a TARGETED try/catch in execute()
//    that surfaces filesystem failures (EEXIST, ENOENT, permission,
//    Windows rename quirks) as clean exit-1 errors rather than letting
//    Clipanion print a stack trace for what are mundane I/O failures.
//
// 9. **D29 — cleanup warnings surfaced to stderr.** getDiffSinceCheckpoint
//    returns DiffResult.cleanupWarnings on success; the inner-package
//    finalizer attaches them to thrown errors as a `cleanupWarnings`
//    property on the Error. check.ts surfaces both: from the happy path
//    after the diff call, and from handleKnownError BEFORE the typed
//    dispatch so the user sees the warnings in context with the error.
//    The handleKnownError lookup is guarded against non-object thrown
//    values (null, primitives) — a thrown `null` would otherwise
//    TypeError on the property access and skip the typed-error
//    dispatch entirely.
//
// 10. **exactOptionalPropertyTypes-safe spreads.** sinceMeta spreads
//     `checkpointId`, `stagedOnly`, and `task` conditionally — no field
//     gets `: undefined` explicitly. Same pattern for RenderInput's
//     optional `threshold`.

import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  BUILTIN_CHECKS,
  type CheckContext,
  type CheckResult,
  compareLevel,
  runChecks,
} from "@viberevert/checks";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  RepoRootNotFoundError,
  resolveRepoRoot,
  SessionNotFoundError,
} from "@viberevert/core";
import {
  CheckpointCorruptError,
  CheckpointNotFoundError,
  CommitRefNotFoundError,
  DiffRefNotFoundError,
  GitNotAvailableError,
  getDiffSinceCheckpoint,
  getDiffSinceRef,
  type RawDiff,
} from "@viberevert/git";
import { type RenderInput, renderJson, renderTerminal } from "@viberevert/reporters";
import type { ReportFile, RiskLevel } from "@viberevert/session-format";
import { Command, Option } from "clipanion";

import { renameDirAtomic, writeFileAtomic } from "../atomic.js";
import {
  applyDiffPathExcludes,
  buildReportFile,
  computeRollbackAvailable,
  mergeChecksConfig,
  parseRawDiffToInputs,
} from "../check-orchestration.js";
import {
  CheckpointNameNotFoundError,
  type ResolvedCheckBase,
  resolveCheckBase,
  StagedIncompatibleWithSnapshotBaseError,
} from "../check-since-resolution.js";
import { RuntimeEnvInvalidError, resolveProductVersionForReport } from "../runtime-env.js";

// =============================================================================
// Constants
// =============================================================================

const VIBEREVERT_DIR = ".viberevert";
const SESSIONS_SUBDIR = "sessions";
const REPORTS_SUBDIR = "reports";
const REPORT_FILENAME = "report.json";

const VALID_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

// =============================================================================
// Pure helpers
// =============================================================================

function isValidRiskLevel(value: string): value is RiskLevel {
  return (VALID_RISK_LEVELS as readonly string[]).includes(value);
}

/**
 * D24 gate predicate: returns true iff any finding's level is at-or-above
 * `blockOn`. Uses compareLevel from @viberevert/checks (re-exported from
 * session-format); a return of >= 0 means level is at-or-above blockOn.
 * `--threshold` does NOT affect this — D38 lock.
 */
function shouldExitWithBlocker(results: readonly CheckResult[], blockOn: RiskLevel): boolean {
  for (const r of results) {
    if (compareLevel(r.level, blockOn) >= 0) return true;
  }
  return false;
}

// =============================================================================
// Atomic persistence (D17b/D26 dispatch on base.kind)
// =============================================================================

/**
 * Persist the validated `ReportFile` per D26's storage rule:
 *   - session_bound → file-level writeFileAtomic to
 *     `.viberevert/sessions/<sess>/report.json`.
 *   - ad_hoc → dir-level: mkdir reports parent idempotent (always-
 *     shared `.viberevert/reports/`), mkdir `.tmp-rpt-<hex>/`
 *     NON-recursively (so a stale dir from a previous crash OR a hex
 *     collision fails loud with EEXIST rather than silently joining a
 *     dir we didn't create — without this guard, the subsequent
 *     renameDirAtomic would move whatever the pre-existing dir
 *     contained to the final reportId location), writeFileAtomic the
 *     inner report.json, then renameDirAtomic outer dir →
 *     `<rpt_<ULID>>/`. Best-effort `rm -rf` of the temp dir on any
 *     failure — but ONLY if we successfully created it (via the
 *     `tmpDirCreated` flag), so the cleanup never removes a
 *     pre-existing dir we didn't own.
 *
 * The session dir is assumed to already exist for session_bound (the
 * session creation in viberevert start mkdir'd it); writing report.json
 * into that existing dir is the only mutation here, atomically via
 * writeFileAtomic's sibling-temp + rename.
 *
 * Failures rethrow unchanged — the targeted catch in execute()'s
 * step 11 wraps them as clean exit-1 errors with the original message
 * surfaced to stderr.
 */
async function persistReportFile(
  repoRoot: string,
  base: ResolvedCheckBase,
  file: ReportFile,
): Promise<void> {
  const json = `${JSON.stringify(file, null, 2)}\n`;
  if (base.kind === "session_bound") {
    const targetPath = join(
      repoRoot,
      VIBEREVERT_DIR,
      SESSIONS_SUBDIR,
      base.reportId,
      REPORT_FILENAME,
    );
    await writeFileAtomic(targetPath, json);
    return;
  }
  const reportsParent = join(repoRoot, VIBEREVERT_DIR, REPORTS_SUBDIR);
  await mkdir(reportsParent, { recursive: true });
  const tmpName = `.tmp-rpt-${randomBytes(8).toString("hex")}`;
  const tmpDirAbs = join(reportsParent, tmpName);
  const finalDirAbs = join(reportsParent, base.reportId);
  let tmpDirCreated = false;
  try {
    await mkdir(tmpDirAbs);
    tmpDirCreated = true;
    await writeFileAtomic(join(tmpDirAbs, REPORT_FILENAME), json);
    await renameDirAtomic(tmpDirAbs, finalDirAbs);
  } catch (err) {
    if (tmpDirCreated) {
      await rm(tmpDirAbs, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
}

// =============================================================================
// Centralized typed-error → stderr message mapping
// =============================================================================

/**
 * Maps every typed error class check.ts expects into a clean stderr
 * message + exit code. Unknown errors re-throw and let Clipanion
 * surface them (which will print a stack trace and exit non-zero).
 *
 * Cleanup-warnings attached to the error (by getDiffSinceCheckpoint's
 * finalizer when its main algorithm threw mid-way) are surfaced FIRST,
 * so the user sees them in context with the typed-error message.
 */
function handleKnownError(stderr: { write(s: string): unknown }, err: unknown): number {
  // Surface cleanup warnings attached by getDiffSinceCheckpoint on throw.
  // Guard against non-object thrown values: throwing `null`,
  // `undefined`, a string, or a number is legal JS, and
  // `(null as any).cleanupWarnings` would TypeError before any of the
  // typed-error dispatch arms below could cleanly rethrow. The
  // null+typeof check returns undefined for any non-object,
  // short-circuiting safely. Combined with the Array.isArray guard
  // below, handleKnownError is safe against absolutely any thrown
  // value.
  const warnings =
    err !== null && typeof err === "object"
      ? (err as { cleanupWarnings?: readonly string[] }).cleanupWarnings
      : undefined;
  if (Array.isArray(warnings)) {
    for (const w of warnings) {
      if (typeof w === "string") stderr.write(`warning: ${w}\n`);
    }
  }

  if (err instanceof RepoRootNotFoundError) {
    stderr.write(
      "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
    );
    stderr.write("Run `viberevert init` to create a project here.\n");
    return 1;
  }
  if (err instanceof ConfigNotFoundError) {
    stderr.write("No .viberevert.yml found in this repo.\n");
    stderr.write("Run:\n");
    stderr.write("  viberevert init\n\n");
    stderr.write("to create one.\n");
    return 1;
  }
  if (err instanceof ConfigParseError || err instanceof ConfigValidationError) {
    stderr.write(`Invalid .viberevert.yml: ${err.message}\n`);
    stderr.write("Fix the file, or re-run:\n");
    stderr.write("  viberevert init\n\n");
    stderr.write("to start fresh.\n");
    return 1;
  }
  if (
    err instanceof StagedIncompatibleWithSnapshotBaseError ||
    err instanceof CheckpointNameNotFoundError ||
    err instanceof SessionNotFoundError ||
    err instanceof CheckpointNotFoundError ||
    err instanceof CheckpointCorruptError ||
    err instanceof DiffRefNotFoundError ||
    err instanceof CommitRefNotFoundError ||
    err instanceof RuntimeEnvInvalidError
  ) {
    // These error classes carry their own user-friendly, already-formatted
    // messages (with JSON.stringify hardening, shallow-clone hints,
    // disambiguation copy, etc.). Surface them verbatim.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  if (err instanceof GitNotAvailableError) {
    stderr.write(`git is not available: ${err.message}\n`);
    return 1;
  }
  // Unknown error — re-throw so Clipanion surfaces it as a crash.
  throw err;
}

// =============================================================================
// Command class
// =============================================================================

export class CheckCommand extends Command {
  static override paths = [["check"]];

  static override usage = Command.Usage({
    description: "Run risk checks against changes since a base (checkpoint, session, or git ref)",
    details: `\
Computes the diff between the current working tree and a base, runs the
configured risk checks against the changed files, persists a ReportFile
artifact, and renders a human or JSON view to stdout.

Base selection (--since):
  - cp_<ULID>            → ad-hoc report against the named checkpoint
  - sess_<ULID>          → session-bound report against the named session
  - <name>               → ad-hoc report against the checkpoint with that name
  - <git-ref>            → ad-hoc report against the git ref (HEAD~1, main, SHA, tag)
  - (omitted, with active session) → session-bound report against the active session
  - (omitted, no active session)   → ad-hoc against HEAD~1
  - --staged                       → ad-hoc against HEAD, scoped to staged changes
                                     (incompatible with --since cp_/sess_/<name>)

Exit codes:
  0  — no findings at or above risk.block_on (default: critical)
  1  — internal or configuration error
  2  — at least one finding at or above risk.block_on
       (--threshold does NOT affect this; it only filters output)`,
  });

  since = Option.String("--since", {
    description:
      "Base to check against: checkpoint id (cp_X), checkpoint name, session id (sess_X), or git ref",
  });

  staged = Option.Boolean("--staged", false, {
    description: "Scope diff to staged changes only (incompatible with --since cp_/sess_/<name>)",
  });

  threshold = Option.String("--threshold", {
    description:
      "Output filter: only show findings at-or-above this level (low|medium|high|critical). Does NOT affect exit code.",
  });

  task = Option.String("--task", {
    description: "Override the task string (default: inherited from the resolved session, if any)",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the ReportFile as JSON to stdout instead of human-readable terminal output",
  });

  override async execute(): Promise<number> {
    try {
      // Step 1: resolve repo root.
      const repoRoot = resolveRepoRoot();

      // Step 2: validate input flags (fail fast before any I/O beyond
      // step 1's repo-root scan).
      //
      // --threshold: per D38, --threshold is OUTPUT-ONLY; gating uses
      // resolved.riskBlockOn always. Reject unknown values here.
      if (this.threshold !== undefined && !isValidRiskLevel(this.threshold)) {
        this.context.stderr.write(
          `Invalid --threshold ${JSON.stringify(this.threshold)}. ` +
            `Expected one of: low, medium, high, critical.\n`,
        );
        return 1;
      }
      // --task: reject empty / whitespace-only strings up front. Without
      // this, the value would flow into ReportFileSchema.parse() and
      // fail the nonBlankString constraint as an uncaught ZodError →
      // Clipanion stack trace. Mirrors checkpoint.ts's --name pattern:
      // CHECK trim() for rejection, but preserve the raw string value
      // (no silent trim) for non-empty inputs.
      if (this.task !== undefined && this.task.trim().length === 0) {
        this.context.stderr.write("Invalid --task: expected a non-empty string.\n");
        return 1;
      }

      // Step 3: load config (D19 — REQUIRED for check).
      const config = await loadConfig(repoRoot);

      // Step 4: merge M C defaults (D57). Returns ResolvedChecksConfig
      // with every field guaranteed non-undefined (block_on, warn_on,
      // checks toggles, frameworks (auto-detected if omitted),
      // rollback.exclude).
      const resolved = await mergeChecksConfig(config, repoRoot);

      // Compute the OUTPUT threshold per D38 — distinct from the gate
      // threshold (resolved.riskBlockOn) which we use in step 13.
      //   - --threshold set      → use it (validated above)
      //   - else --json          → undefined (no filter; JSON consumers
      //                            want the full set unless they
      //                            explicitly ask for filtering)
      //   - else                 → resolved.riskWarnOn (default to
      //                            "show me what's worth warning about")
      let renderThreshold: RiskLevel | undefined;
      if (this.threshold !== undefined) {
        renderThreshold = this.threshold as RiskLevel;
      } else if (!this.json) {
        renderThreshold = resolved.riskWarnOn;
      }

      // Step 5: resolve the since base (D26 + D58 dispatch). All the
      // hard policy lives in resolveCheckBase; check.ts just passes
      // flags through and dispatches on base.mode / base.kind.
      const base = await resolveCheckBase({
        repoRoot,
        ...(this.since !== undefined ? { since: this.since } : {}),
        staged: this.staged,
      });

      // Step 6: get the diff (D56 dispatch on base.mode). Both helpers
      // return DiffResult { diff, cleanupWarnings }; the cleanup
      // warnings are non-fatal and get surfaced to stderr per D29.
      let diff: RawDiff;
      let cleanupWarnings: readonly string[];
      if (base.mode === "git-ref") {
        const result = await getDiffSinceRef(repoRoot, base.sinceRef, {
          staged: base.stagedOnly,
        });
        diff = result.diff;
        cleanupWarnings = result.cleanupWarnings;
      } else {
        const result = await getDiffSinceCheckpoint(repoRoot, base.checkpointDir, {
          liveExcludePatterns: resolved.rollbackExclude,
        });
        diff = result.diff;
        cleanupWarnings = result.cleanupWarnings;
      }
      for (const w of cleanupWarnings) {
        this.context.stderr.write(`warning: ${w}\n`);
      }

      // Step 7: D3 symmetry filter (defense-in-depth — the checkpoint
      // helper already filters internally before mirror construction,
      // but this catches the git-ref path which doesn't, and acts as a
      // second pass for checkpoint paths in case any edge case slipped
      // through the internal filter).
      const filteredDiff = applyDiffPathExcludes(diff, resolved.rollbackExclude);

      // Step 8: parse RawDiff → ChangedFileInput[] for the checks engine.
      const changedFiles = parseRawDiffToInputs(filteredDiff);

      // Step 9: build CheckContext + run the engine. Task precedence
      // per D28: --task overrides base.task (which is set only for
      // session bases via session.task). The `task?: undefined` on the
      // git-ref variant of ResolvedCheckBase makes this access
      // type-safe under exactOptionalPropertyTypes without union
      // narrowing. At this point this.task is either undefined OR a
      // non-empty string (validated in step 2).
      const task = this.task ?? base.task;
      const ctx: CheckContext = {
        changedFiles,
        ...(task !== undefined ? { task } : {}),
        detectedFrameworks: resolved.frameworks,
        configChecks: resolved.checks,
      };
      const runResult = runChecks(BUILTIN_CHECKS, ctx);

      // Step 10a: assemble sinceMeta with a PROVISIONAL
      // rollbackAvailable=false. The provisional value is required
      // to satisfy BuildReportSinceMeta's type (rollbackAvailable
      // is a required boolean), but `computeRollbackAvailable`
      // explicitly ignores the field — its docstring locks that
      // only `kind` and `reportId` are read. The real value is
      // computed in Step 10b and threaded into the final sinceMeta
      // for Step 10c.
      const sinceMetaProvisional = {
        kind: base.kind,
        sinceKind: base.sinceKind,
        sinceRef: base.sinceRef,
        sinceResolvedSha: base.sinceResolvedSha,
        reportId: base.reportId,
        startedAt: base.startedAt,
        rollbackAvailable: false,
        // Conditional spreads keep exactOptionalPropertyTypes happy —
        // no field gets explicit-undefined.
        ...(base.mode === "checkpoint" && base.checkpointId !== undefined
          ? { checkpointId: base.checkpointId }
          : {}),
        ...(base.mode === "git-ref" && base.stagedOnly ? { stagedOnly: true as const } : {}),
        ...(task !== undefined ? { task } : {}),
      };

      // Step 10b: derive rollback_available per D72. Session-bound
      // reports probe the session's INNER checkpoint dir; ad-hoc
      // reports always get false (M D rollback is session-only per
      // D59). CheckpointNotFoundError → false; any other error
      // (corruption, I/O, malformed reportId rejecting the fail-
      // closed path guard) propagates as a stack trace per the
      // same "engine bug" rule applied to schema failures below.
      const rollbackAvailable = await computeRollbackAvailable(sinceMetaProvisional, repoRoot);

      // Step 10c: build the validated ReportFile. buildReportFile calls
      // ReportFileSchema.parse internally so noise-budget violations,
      // identity-consistency drift, and since_kind ↔ kind / staged_only
      // ↔ kind refines all surface as one typed throw here. Schema
      // failures here are engine bugs and propagate to Clipanion as
      // stack traces (intentional — these are bug surfaces, not
      // user-facing errors).
      const reportFile = buildReportFile({
        ctx,
        raw: filteredDiff,
        runResult,
        sinceMeta: { ...sinceMetaProvisional, rollbackAvailable },
      });

      // Step 11: atomic persistence (D17b/D26 dispatch on base.kind).
      // Wrap filesystem failures (EEXIST from the non-recursive
      // temp-dir mkdir or renameDirAtomic's no-replace check, ENOENT
      // from missing session dir, EACCES, Windows rename-on-open
      // quirks, etc.) as clean exit-1 errors per D24 — these are
      // mundane I/O failures that don't deserve stack traces.
      try {
        await persistReportFile(repoRoot, base, reportFile);
      } catch (err) {
        this.context.stderr.write(
          `Failed to persist check report: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }

      // Step 12: render. productVersion comes from runtime-env's
      // resolver (env-overridable for golden fixtures); threshold is
      // the OUTPUT filter computed in step 4.
      const productVersion = resolveProductVersionForReport();
      const renderInput: RenderInput = {
        file: reportFile,
        productVersion,
        ...(renderThreshold !== undefined ? { threshold: renderThreshold } : {}),
      };
      if (this.json) {
        const value = renderJson(renderInput);
        this.context.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else {
        this.context.stdout.write(renderTerminal(renderInput));
      }

      // Step 13: exit code per D24. --threshold is NOT consulted here —
      // the gate always uses resolved.riskBlockOn from mergeChecksConfig.
      return shouldExitWithBlocker(runResult.results, resolved.riskBlockOn) ? 2 : 0;
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }
  }
}
