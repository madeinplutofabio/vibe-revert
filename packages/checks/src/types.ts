// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public TypeScript types for @viberevert/checks.
//
// Per D28 in the M C plan, the engine is a pure synchronous function that
// maps checks + context + options to a lifecycle-typed result. These
// interfaces describe the engine surface: what a Check looks like (Check),
// what context the CLI feeds it (CheckContext), what a single changed-file
// input record carries (ChangedFileInput / LineChunk), what its toggle config
// looks like (ChecksToggleConfig), what options it accepts (RunChecksOptions /
// IdentifiedRunChecksOptions), and what it returns (RunChecksResult /
// IdentifiedRunChecksResult).
//
// Type re-exports from @viberevert/session-format are included so consumers
// can import { CheckResult, Evidence, RiskLevel, ... } from @viberevert/checks
// without a second import line.
//
// =============================================================================
// Two engine modes (M 0.8.0 step 6)
// =============================================================================
//
// A finding carries `affected_paths` from the moment a detector emits it, but
// `finding_id` can be derived only once the report identity is known AND the
// final path set has settled — dedup, caps, and cluster summaries all change
// it. So the engine runs in one of two modes:
//
//   reportId absent/undefined -> RunChecksResult            DetectorResult[]
//   reportId string value     -> IdentifiedRunChecksResult  IdentifiedCheckResult[]
//
// The pre-identity mode is not a degraded fallback: it is the correct shape
// for any caller exercising detector or severity behavior rather than
// producing a persisted report. The single production caller supplies
// `reportId` and therefore receives final findings.
//
// **Mode is decided by VALUE, not key presence.** `reportId?: undefined`
// deliberately admits both `{}` and `{ reportId: undefined }` — the latter
// models dynamically-built callers under exactOptionalPropertyTypes — so the
// implementation branches on `opts.reportId !== undefined`. A
// `"reportId" in opts` test would misclassify the explicit-undefined caller
// as identity-bearing.
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
  DetectorResult,
  Evidence,
  RiskLevel,
} from "@viberevert/session-format";

// Re-export session-format types so consumers can pull them from this
// package's barrel without a second import line.
export type {
  ChangedFile,
  ChangedFileStatus,
  CheckResult,
  Confidence,
  DetectorResult,
  Evidence,
  RiskLevel,
};

/**
 * A final engine finding, AFTER report identity has been assigned.
 *
 * `CheckResult` keeps `finding_id` and `affected_paths` optional so pre-0.8.0
 * persisted reports remain valid, and its both-or-neither coupling is a Zod
 * `.refine()` — a RUNTIME check that does not narrow the inferred TypeScript
 * type. Without this subtype, `DetectorResult` would satisfy every required
 * member of `CheckResult`, so a pre-identity result would be silently
 * assignable to an identity-bearing one and the engine's two modes would be a
 * naming convention rather than a boundary.
 *
 * Defined HERE rather than in session-format because it describes an engine
 * lifecycle state, not a separately persisted artifact. session-format's
 * `CheckResult` must stay legacy-compatible.
 */
export type IdentifiedCheckResult = CheckResult & {
  readonly finding_id: NonNullable<CheckResult["finding_id"]>;
  readonly affected_paths: NonNullable<CheckResult["affected_paths"]>;
};

/**
 * A risk check. Implementations live in `./detectors/` and `./classifiers/`
 * and are registered by appearing in `BUILTIN_CHECKS` (see `./registry.ts`).
 *
 * Per D28's locked engine rules:
 *   - `run` MUST be synchronous and pure (no I/O, no Date.now(),
 *     no Math.random(), no global state mutation).
 *   - `id` is the stable rule identifier surfaced first as
 *     `DetectorResult.id` and preserved as `CheckResult.id` after report
 *     identity is assigned (e.g. `"secrets.regex"`,
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
 * M 0.8.0 step 6: `run` returns `DetectorResult`, NOT the persisted
 * `CheckResult`. Every finding MUST carry its complete `affected_paths`
 * (possibly empty), and structurally CANNOT carry a `finding_id` — identity
 * is assigned by the engine after clustering, because `affected_paths`
 * participates in its derivation and clustering changes that set.
 *
 * `affected_paths` is semantic data the detector owns, not something
 * mechanically derivable from `evidence`. The distinction is both
 * cardinality and domain:
 *   - CARDINALITY: `scope-expansion` caps its evidence at five entries per
 *     category while a finding may span many more files. Deriving paths from
 *     evidence would truncate the machine set exactly where a finding is
 *     broadest.
 *   - DOMAIN: `EvidenceSchema.file` accepts any canonical relative path,
 *     whereas `SessionReportSchema` confines `affected_paths` to changed-file
 *     identities. Current detectors need not exercise that broader evidence
 *     domain for the contracts to remain distinct.
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
  readonly run: (ctx: CheckContext) => readonly DetectorResult[];
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
 *
 * It also does NOT carry the report identity. That is orchestration
 * metadata, not detector context: a detector has no reason to know which
 * report will contain its findings, and threading it through here would
 * leak report-assembly concerns into every check. It travels via
 * `IdentifiedRunChecksOptions` instead.
 */
export interface CheckContext {
  readonly changedFiles: readonly ChangedFileInput[];
  readonly task?: string;
  readonly detectedFrameworks: readonly string[];
  readonly configChecks: ChecksToggleConfig;
}

/**
 * Engine extension points shared by both option modes. Reserved for future
 * additions (further analyzers, custom sort overrides, etc.) — all
 * injectable, all optional.
 *
 * The minimum classifier shape the engine reads is
 * `{ category: string; tags: readonly string[] }`. The default
 * `classifyPath` returns `readonly PathRule[]` which satisfies this shape
 * structurally; tests may inject any object array matching it.
 *
 * Deliberately NOT exported, and deliberately shared rather than duplicated
 * across the two modes: the callback signature is elaborate enough that two
 * copies would eventually drift.
 */
interface RunChecksInjectables {
  readonly classifyPath?: (
    path: string,
    detectedFrameworks: readonly string[],
  ) => readonly { readonly category: string; readonly tags: readonly string[] }[];
}

/**
 * Options for `runChecks` in PRE-IDENTITY mode.
 *
 * `reportId` is typed as `undefined` rather than omitted so this type stays
 * DISJOINT from `IdentifiedRunChecksOptions`: an object carrying a report id
 * string cannot satisfy it, which is what lets the two overloads resolve
 * unambiguously.
 */
export interface RunChecksOptions extends RunChecksInjectables {
  readonly reportId?: undefined;
}

/**
 * Options for `runChecks` in IDENTITY-BEARING mode: the same injectables plus
 * the owning report's id, which the engine needs to derive `finding_id`.
 *
 * `reportId` is `sess_<ULID>` for a session-bound report or `rpt_<ULID>` for
 * an ad-hoc one. Typed as a plain `string`: the prefix rules are owned by the
 * report schema, and `deriveFindingId` guards only against blank input. A
 * nominal/branded identity type would only pay for itself alongside a
 * canonical constructor propagated from every allocation site, which is a
 * wider project than this engine boundary.
 */
export interface IdentifiedRunChecksOptions extends RunChecksInjectables {
  readonly reportId: string;
}

/**
 * The engine's return value, parameterized by finding lifecycle stage.
 *
 * `results` — the CLUSTERED findings at the lifecycle stage selected by the
 * overload. Already deduplicated (per D40 identity-based dedup on
 * `(result.id, category, evidence[0].file/.line/.detail)`), cluster-capped
 * (per-category, low-tail, total-tail passes), and sorted by
 * `[level desc, category asc, id asc, file asc, line asc]`. Every entry is
 * schema-validated before it enters this array. When duplicates collapse or a
 * cluster summary absorbs members, the survivor carries the UNION of the
 * absorbed `affected_paths` — the machine path set is never capped, even
 * where human-facing `evidence` is.
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
 * `riskLevelByPath` — per file, the `max` of `level` across ALL pre-cluster
 * findings whose `affected_paths` contain that path, computed via
 * `compareLevel`. Files with zero pre-cluster findings get `"low"`. The CLI
 * uses this to populate `ChangedFile.risk_level`. **Computed PRE-clustering**
 * so a critical finding that the cluster pipeline sweeps into a tail summary
 * STILL surfaces at the file level — the locked invariant from D28.
 *
 * M 0.8.0 step 6 changed the source from `evidence[0].file` to the complete
 * `affected_paths` set. Aggregating per finding at that finding's own level
 * is deliberate and must stay pre-cluster: doing it after clustering would
 * let a summary holding one critical and one medium member promote the
 * medium member's paths to critical.
 */
interface RunChecksResultBase<TFinding> {
  readonly results: readonly TFinding[];
  readonly riskTagsByPath: ReadonlyMap<string, readonly string[]>;
  readonly riskLevelByPath: ReadonlyMap<string, RiskLevel>;
}

/** Pre-identity result: findings carry `affected_paths` but no `finding_id`. */
export type RunChecksResult = RunChecksResultBase<DetectorResult>;

/** Identity-bearing result: findings carry both fields, derived for the supplied reportId. */
export type IdentifiedRunChecksResult = RunChecksResultBase<IdentifiedCheckResult>;
