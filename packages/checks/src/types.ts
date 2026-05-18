// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public TypeScript types for @viberevert/checks.
//
// Per D28 in the M C plan, the engine is a pure synchronous function that
// maps (checks, ctx) -> RunChecksResult. These interfaces describe the engine
// surface: what a Check looks like (Check), what context the CLI feeds it
// (CheckContext), what a single changed-file input record carries
// (ChangedFileInput / LineChunk), what its toggle config looks like
// (ChecksToggleConfig), and what the engine returns (RunChecksResult).
//
// Type re-exports from @viberevert/session-format are included so consumers
// can import { CheckResult, Evidence, RiskLevel, ... } from @viberevert/checks
// without a second import line.
//
// LOCKED INVARIANTS (verified by architectural-invariants grep in
// packages/cli/test/architectural-invariants.test.ts per D48):
//   - No I/O. No fs, child_process, path, os, crypto, url, stream, util.
//   - No terminal writes. No process.stdout/stderr/console.*.
//   - No async/Promise/await — every Check.run is synchronous.
//   - No Date.now(), Math.random(), crypto.randomUUID(), ulid().

import type {
  ChangedFile,
  ChangedFileStatus,
  CheckResult,
  Confidence,
  Evidence,
  RiskLevel,
} from "@viberevert/session-format";

// Re-export session-format types so consumers can pull them from this
// package's barrel without a second import line.
export type { ChangedFile, ChangedFileStatus, CheckResult, Confidence, Evidence, RiskLevel };

/**
 * A risk check. Implementations live in `./detectors/` and `./classifiers/`
 * and are registered by appearing in `BUILTIN_CHECKS` (see `./registry.ts`).
 *
 * Per D28's locked engine rules:
 *   - `run` MUST be synchronous and pure (no I/O, no Date.now(),
 *     no Math.random(), no global state mutation).
 *   - `id` is the stable identifier surfaced as `CheckResult.id` when a
 *     finding emits (e.g. `"secrets.regex"`,
 *     `"deps.lockfile-without-manifest"`). Single-rule checks use a
 *     static id; multi-rule checks (notably path-classifier) MUST
 *     namespace per matched rule (e.g. `path-classifier.<rule.id>`) per
 *     D40's per-rule-id rule so the identity-based dedup key tuple
 *     stays distinct.
 *   - `category` is the PRIMARY category label used for sort/cluster
 *     purposes; it MUST match a category in the M C risk taxonomy from
 *     full_beta_plan §11 (e.g. "auth", "payments", "database",
 *     "secrets").
 *   - `emittedCategories` is REQUIRED for multi-category checks —
 *     checks that may emit findings under more than one category in a
 *     single `run()` invocation. Path-classifier is the canonical
 *     example: a single matched path can produce findings in `auth`,
 *     `payments`, `database`, `infra`, `deployment`, or `secrets`
 *     depending on the rule. The engine's two-layer toggle enforcement
 *     reads this field to decide whether to pre-skip the entire check
 *     (all emitted categories disabled) versus run it and then
 *     per-finding filter (some categories enabled). Default for
 *     single-category checks is `[category]`.
 *
 * NO `defaultEnabled` field on Check by deliberate choice (D28):
 * enable/disable defaults live SOLELY in `mergeChecksConfig` in
 * `cli/src/check-orchestration.ts` per D57. A per-check default would
 * create a second source of truth and risk drift.
 */
export interface Check {
  readonly id: string;
  readonly category: string;
  readonly emittedCategories?: readonly string[];
  readonly run: (ctx: CheckContext) => readonly CheckResult[];
}

/**
 * Per-line content fragment from a unified-diff hunk. Line numbers are
 * 1-indexed in the OLD file (for `removedLines`) or the NEW file (for
 * `addedLines`). `text` is the line's full content with the unified-diff
 * `+`/`-`/` ` prefix STRIPPED and the trailing newline REMOVED.
 *
 * Detectors that scan content (secrets, migration danger terms,
 * install-script keys, etc.) read these line records — they never see
 * the raw diff text or the file's full content.
 */
export interface LineChunk {
  readonly line: number;
  readonly text: string;
}

/**
 * One changed file's pre-parsed contribution to the checks engine. The
 * CLI parses git's raw diff output (via `@viberevert/git`'s
 * `getDiffSinceRef` / `getDiffSinceCheckpoint` helpers per D56) into an
 * array of these before calling `runChecks`. Checks NEVER see a git
 * command line, NEVER see `.viberevert/`, NEVER touch the filesystem
 * (D29, D30).
 *
 * `previous_path` is populated ONLY when `status === "renamed"`
 * (mirrors `ChangedFileSchema.refine`'s rule on the persisted output
 * side). `addedLines` and `removedLines` are EMPTY when
 * `isBinary === true` — content scanning is suppressed for binary
 * files.
 */
export interface ChangedFileInput {
  readonly path: string;
  readonly previous_path?: string;
  readonly status: ChangedFileStatus;
  readonly addedLines: readonly LineChunk[];
  readonly removedLines: readonly LineChunk[];
  readonly isBinary: boolean;
}

/**
 * Opaque boolean record of which `checks.*` categories are enabled. The
 * CLI resolves the user's `.viberevert.yml` config + M C defaults (via
 * `mergeChecksConfig` in `cli/src/check-orchestration.ts` per D57) into
 * this shape before calling `runChecks`.
 *
 * Locked as `Readonly<Record<string, boolean>>` rather than tied to
 * the CLI's `ResolvedChecksConfig["checks"]` type, per D29's
 * package-boundary rule — checks MUST NOT know the CLI's
 * resolved-config type exists. The CLI hands `resolved.checks` (which
 * structurally satisfies this shape) into `runChecks` via
 * `CheckContext.configChecks`; checks treats it as an opaque boolean
 * record.
 *
 * Used by `deriveEnabledCategories` in `./registry.js` to compute the
 * enabled-category set the engine consults for its two-layer toggle
 * filter (D28).
 */
export type ChecksToggleConfig = Readonly<Record<string, boolean>>;

/**
 * Context the CLI hands to `runChecks`. Everything `runChecks` needs to
 * make decisions: the parsed diff inputs, the optional task string
 * (from `--task` flag or active-session metadata per D28's task
 * precedence rule), the resolved framework list (D41 + D42), and the
 * resolved check-toggle config (D28 + D57).
 *
 * Per D29 + D30, `CheckContext` does NOT carry: `repoRoot`, any git
 * helper handle, any I/O capability, any config-loading capability.
 * The CLI does ALL resolution upstream.
 */
export interface CheckContext {
  readonly changedFiles: readonly ChangedFileInput[];
  readonly task?: string;
  readonly detectedFrameworks: readonly string[];
  readonly configChecks: ChecksToggleConfig;
}

/**
 * The engine's return value from `runChecks`.
 *
 * `results` — the CLUSTERED, PERSISTED findings. Already deduplicated
 * (per D40 identity-based dedup on
 * `(result.id, category, evidence[0].file/.line/.detail)`),
 * cluster-capped (per-category, low-tail, total-tail passes), and
 * sorted by `[level desc, category asc, id asc, file asc, line asc]`.
 * Every entry is validated against `CheckResultSchema` before it enters
 * this array.
 *
 * `riskTagsByPath` — per file, the union of `tags` from path-classifier
 * rules that matched that file (after D28 layer-2 toggle filter, BEFORE
 * D40 clustering). The CLI uses this to populate
 * `ChangedFile.risk_tags` for each file in the persisted report. Files
 * with zero matching rules map to an empty tag array. **In M C, only
 * the path-classifier contributes to `risk_tags`** — EvidenceSchema has
 * no `tags` field, so other detectors cannot structurally contribute
 * tags.
 *
 * `riskLevelByPath` — per file, the `max` of `level` across ALL
 * pre-cluster findings whose `evidence[0].file === path`, computed via
 * `compareLevel`. Files with zero pre-cluster findings get `"low"`.
 * The CLI uses this to populate `ChangedFile.risk_level`. **Computed
 * PRE-clustering** so a critical finding that the cluster pipeline
 * sweeps into a tail summary STILL surfaces at the file level via
 * `ChangedFile.risk_level` — the locked invariant from D28.
 */
export interface RunChecksResult {
  readonly results: readonly CheckResult[];
  readonly riskTagsByPath: ReadonlyMap<string, readonly string[]>;
  readonly riskLevelByPath: ReadonlyMap<string, RiskLevel>;
}
