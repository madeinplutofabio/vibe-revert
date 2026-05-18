// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// All persisted-artifact object schemas are STRICT (z.strictObject): unknown
// fields are rejected, not silently stripped. This prevents schema drift.
//
// Scalar string schemas are pure validators (no silent trimming). Trimming
// happens only in producer-side helpers like normalizeStringArray; path
// helpers (normalizeRelativePath, normalizePathArray) deliberately do NOT
// trim, because pathnames with leading/trailing whitespace are legitimate
// filenames and silent rewriting at the manifest boundary would violate the
// trust-preserving principle that what we capture is what we restore.
//
// Naming convention: <Thing>Schema is the runtime zod value; <Thing> is the
// inferred TypeScript type. This avoids value/type same-name ambiguity at the
// public-API barrel and at every call site.

import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

// =============================================================================
// Path helpers
//
// All persisted relative paths in VibeRevert artifacts use forward slashes
// only and are canonical (no ".", no "..", no empty segments, no leading or
// trailing slash, not absolute, not UNC, not drive-letter-rooted).
//
// API:
//   - isSafeStoredRelativePath: schema-side predicate. No transformation;
//     returns true only if the input is already canonical.
//   - normalizeRelativePath: producer-side canonicalizer for a single path
//     (representation only, no semantic resolution; throws on any input that
//     cannot be canonicalized to a safe stored path).
//   - normalizePathArray: producer-side canonicalizer for an array of paths.
//     Maps each entry through normalizeRelativePath, dedupes via a Set, and
//     sorts ASCII-ascending. Distinct from normalizeStringArray, which is
//     wrong for paths because it trims: pathnames with leading/trailing
//     whitespace, while unusual, ARE legitimate filenames on most
//     filesystems, and silently rewriting them at the manifest boundary is
//     the opposite of trust-preserving.
// =============================================================================

const ABSOLUTE_DRIVE_LETTER = /^[a-zA-Z]:/;

/**
 * Schema-side predicate. Returns true iff `input` is a canonical, safe,
 * stored relative path. Performs no transformation.
 */
export function isSafeStoredRelativePath(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  if (input.includes("\\")) return false;
  if (input.startsWith("/")) return false;
  if (input.startsWith("//")) return false;
  if (ABSOLUTE_DRIVE_LETTER.test(input)) return false;
  const segments = input.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/**
 * Producer-side canonicalizer. Converts representational quirks (Windows
 * backslashes, leading "./", repeated "/") into the canonical form. Throws on
 * any input that cannot be made canonical without semantic resolution
 * (".." segments, absolute paths, etc.). Returns a string guaranteed to
 * satisfy isSafeStoredRelativePath().
 */
export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("normalizeRelativePath: input must be a non-empty string");
  }
  let p = input.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+/g, "/");
  if (!isSafeStoredRelativePath(p)) {
    throw new Error(`normalizeRelativePath: cannot canonicalize ${JSON.stringify(input)}`);
  }
  return p;
}

const safeStoredRelativePath = z.string().refine(isSafeStoredRelativePath, {
  message:
    "must be a canonical relative path: forward slashes only, no leading/trailing slash, no '.' or '..' segments, not absolute",
});

/**
 * Producer-side helper for arrays of relative paths. Maps each entry through
 * normalizeRelativePath (which throws on un-canonicalizable input), dedupes
 * via a Set, and sorts ASCII-ascending. Returns a string[] that satisfies
 * sortedUniquePathArray.
 *
 * Distinct from normalizeStringArray: that helper trims whitespace, which is
 * wrong for paths. Pathnames with leading/trailing whitespace, while unusual,
 * are legitimate filenames on most filesystems; trimming them at the manifest
 * boundary would silently rewrite the captured set and break the trust-
 * preserving principle that what we capture is what we restore.
 */
export function normalizePathArray(input: readonly string[]): string[] {
  return Array.from(new Set(input.map(normalizeRelativePath))).sort();
}

// =============================================================================
// String atom and string-array helpers
//
// nonBlankString is the default atom for required/optional human-meaningful
// scalar strings. It rejects both empty and whitespace-only strings. Use plain
// z.string() only where empty/whitespace is legitimately meaningful (e.g.,
// git.porcelain_v1 for a clean tree).
//
// Arrays like ChangedFile.risk_tags and SessionReport.detected_frameworks must
// be sorted ascending, unique, and contain no blank (empty or whitespace-only)
// strings in their persisted form. Producers call normalizeStringArray; the
// schema rejects non-canonical arrays.
// =============================================================================

/**
 * Default scalar string atom for VibeRevert persisted artifacts. Rejects empty
 * strings and whitespace-only strings. No transformation performed.
 */
const nonBlankString = z.string().refine((s) => s.trim().length > 0, {
  message: "must not be empty or whitespace-only",
});

/**
 * Returns true iff `input` is sorted ASCII-ascending and contains no duplicates.
 */
export function isSortedUniqueStringArray(input: readonly string[]): boolean {
  for (let i = 1; i < input.length; i++) {
    const prev = input[i - 1];
    const curr = input[i];
    if (prev === undefined || curr === undefined) return false;
    if (curr <= prev) return false;
  }
  return true;
}

/**
 * Producer-side helper. Returns a new array that is trimmed, deduped, sorted
 * ASCII-ascending, with empty/whitespace-only entries dropped. Safe to call on
 * any string array; never throws.
 */
export function normalizeStringArray(input: readonly string[]): string[] {
  return Array.from(new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))).sort();
}

const sortedUniqueStringArray = z.array(nonBlankString).refine(isSortedUniqueStringArray, {
  message: "must be sorted ascending, contain no duplicates, and contain no blank strings",
});

/**
 * Like `sortedUniqueStringArray` but with `safeStoredRelativePath` as the
 * element validator: each entry must be a canonical relative POSIX path
 * (forward slashes only, no leading/trailing slash, no '.' or '..' segments,
 * not absolute). Used by `Manifest.snapshots.tracked_dirty_paths`.
 *
 * The same lexicographic sorted-unique invariant as `sortedUniqueStringArray`
 * applies: producers MUST sort + dedupe (gitListTrackedDirty already does);
 * the schema rejects non-canonical arrays.
 */
const sortedUniquePathArray = z.array(safeStoredRelativePath).refine(isSortedUniqueStringArray, {
  message:
    "must be sorted ascending, contain no duplicates, and contain only canonical relative POSIX paths",
});

// =============================================================================
// Enum atoms
// =============================================================================

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ChangedFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "type_changed",
]);
export type ChangedFileStatus = z.infer<typeof ChangedFileStatusSchema>;

/**
 * Discriminator for how a SessionReport's diff base was resolved. Carried on
 * the file-level `ReportFile` wrapper (NOT on the inner `SessionReport`) so
 * downstream consumers can disambiguate the meaning of `since_ref` without
 * re-parsing it. Per D56 in the M C plan.
 *
 *   - "git_ref"          → `--since main`, `--since HEAD~1`, `--since <SHA>`,
 *                          `--since <tag>`, or `--since HEAD` under `--staged`.
 *   - "checkpoint_id"    → `--since cp_<ULID>`.
 *   - "checkpoint_name"  → `--since <name>` matched against a manifest.
 *   - "session_id"       → `--since sess_<ULID>`.
 *   - "active_session"   → `--since` omitted with an active session present.
 */
export const SinceKindSchema = z.enum([
  "git_ref",
  "checkpoint_id",
  "checkpoint_name",
  "session_id",
  "active_session",
]);
export type SinceKind = z.infer<typeof SinceKindSchema>;

/**
 * Discriminator for the storage location of a written report. Per D26 in the
 * M C plan: session-bound reports live at
 * `.viberevert/sessions/<sess>/report.json` (file-level atomic);
 * ad-hoc reports live at `.viberevert/reports/<rpt_ULID>/report.json`
 * (dir-level atomic).
 */
export const ReportFileKindSchema = z.enum(["session_bound", "ad_hoc"]);
export type ReportFileKind = z.infer<typeof ReportFileKindSchema>;

// =============================================================================
// Severity ordering (single source of truth for level comparison)
//
// Per D25 in the M C plan. The checks engine, reporters, and CLI MUST import
// `compareLevel` / `riskLevelAtOrAbove` from here — no ad-hoc string
// comparison anywhere. The integer ranks are an implementation detail; only
// the helpers' return values are public.
// =============================================================================

const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Total order over `RiskLevel`: `low < medium < high < critical`. Returns
 * `-1` if `a < b`, `0` if `a === b`, `+1` if `a > b`. Intended for use as a
 * comparator (e.g. `[...levels].sort(compareLevel)`).
 */
export function compareLevel(a: RiskLevel, b: RiskLevel): -1 | 0 | 1 {
  const ra = LEVEL_RANK[a];
  const rb = LEVEL_RANK[b];
  if (ra < rb) return -1;
  if (ra > rb) return 1;
  return 0;
}

/**
 * True iff `actual` meets or exceeds `threshold` in the locked severity
 * ordering. Used by `viberevert check`'s gate (`actual >= risk.block_on`)
 * and by `--threshold <level>` output filtering in renderers.
 */
export function riskLevelAtOrAbove(actual: RiskLevel, threshold: RiskLevel): boolean {
  return LEVEL_RANK[actual] >= LEVEL_RANK[threshold];
}

// =============================================================================
// Evidence (strict)
//
// Refinement: if `line` is present, `file` must also be present.
// =============================================================================

export const EvidenceSchema = z
  .strictObject({
    detail: nonBlankString,
    file: safeStoredRelativePath.optional(),
    line: z.int().positive().optional(),
    command: nonBlankString.optional(),
  })
  .refine((e) => e.line === undefined || typeof e.file === "string", {
    message: "file is required when line is present",
    path: ["file"],
  });
export type Evidence = z.infer<typeof EvidenceSchema>;

// =============================================================================
// ChangedFile (strict)
//
// Refinements:
//   - status === "renamed" => previous_path required
//   - status !== "renamed" => previous_path must be absent
//   - previous_path (when present) must differ from path
// =============================================================================

export const ChangedFileSchema = z
  .strictObject({
    path: safeStoredRelativePath,
    previous_path: safeStoredRelativePath.optional(),
    status: ChangedFileStatusSchema,
    risk_tags: sortedUniqueStringArray,
    risk_level: RiskLevelSchema,
  })
  .refine((f) => f.status !== "renamed" || typeof f.previous_path === "string", {
    message: "previous_path is required when status is 'renamed'",
    path: ["previous_path"],
  })
  .refine((f) => f.status === "renamed" || f.previous_path === undefined, {
    message: "previous_path must be absent when status is not 'renamed'",
    path: ["previous_path"],
  })
  .refine((f) => f.previous_path === undefined || f.previous_path !== f.path, {
    message: "previous_path must differ from path",
    path: ["previous_path"],
  });
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

// =============================================================================
// CheckResult (strict)
//
// Noise-budget rules:
//   - evidence array must be non-empty
//   - high/critical findings must include a recommendation
// =============================================================================

export const CheckResultSchema = z
  .strictObject({
    id: nonBlankString,
    title: nonBlankString,
    level: RiskLevelSchema,
    confidence: ConfidenceSchema,
    category: nonBlankString,
    message: nonBlankString,
    evidence: z.array(EvidenceSchema).min(1),
    recommendation: nonBlankString.optional(),
  })
  .refine(
    (r) => (r.level !== "high" && r.level !== "critical") || typeof r.recommendation === "string",
    {
      message: "recommendation is required when level is 'high' or 'critical'",
      path: ["recommendation"],
    },
  );
export type CheckResult = z.infer<typeof CheckResultSchema>;

// =============================================================================
// Manifest (strict; rollback contract)
//
// All path values are relative to the session directory root
// (.viberevert/sessions/<id>/). All hash values are SHA-256 (64-char hex).
// All timestamps are ISO 8601 with second precision and explicit offset.
// `git.porcelain_v1` may legitimately be the empty string (clean tree).
//
// `name` is an optional human-supplied label from `viberevert checkpoint --name`
// (D15 in the M B plan). Storage paths are always ID-based (cp_<ULID>) per D6;
// `name` is metadata only, looked up by scanning manifests, never used as a
// filesystem path component.
//
// `session_id` semantics (D6): the parent record's ID. For checkpoints
// belonging to a session, this is the owning session's `sess_<ULID>`. For
// standalone checkpoints, it is the checkpoint's own `cp_<ULID>`.
//
// `snapshots.tracked_dirty_paths` vs `snapshots.file_hashes` (load-bearing):
//   - `tracked_dirty_paths` is the FULL set of tracked paths that were dirty
//     at checkpoint time — the verbatim output of `git diff --name-only` +
//     `git diff --cached --name-only` (sorted, deduped). It INCLUDES tracked
//     deletions, tracked-symlink changes, mode-only changes, and any other
//     dirty tracked entry, regardless of whether the path currently exists
//     on disk as a regular file. Restore uses this for exact set-parity
//     verification of the tracked-dirty surface.
//   - `file_hashes` is a STRICT SUBSET — only the regular-file entries
//     whose bytes were captured into `tracked_dirty_archive_path`
//     (snapshots.ts's `filterRegularFiles` skips deletions, symlinks,
//     non-regular entries). Restore uses this for content-level SHA-256
//     verification.
//   - Both fields are required because they answer different questions and
//     verify different things. Removing `tracked_dirty_paths` would re-open
//     the soundness hole where a tampered patch could smuggle an
//     unauthorized tracked deletion or mode/symlink change past restore
//     verification (the path wouldn't be in `file_hashes`, and there'd be
//     no other set to compare against).
//
// `untracked.exclude_patterns` (load-bearing for restore drift detection):
// the `rollback.exclude` glob list in effect at checkpoint creation time,
// persisted after normalization via `normalizeStringArray` (trimmed,
// deduped, sorted ASCII-ascending). NOT verbatim — what readers see in
// the manifest is the normalized form, not the raw line order from
// `.viberevert.yml`.
//
// **Why sort + dedup is safe (load-bearing assumption):** M B treats
// `rollback.exclude` as an UNORDERED DENY-LIST per D3 — `nonegate: true`
// disables `!pattern` re-include semantics, and there is no "earlier
// patterns take precedence" rule. Under those constraints, two pattern
// lists are semantically equivalent iff they represent the same SET of
// patterns, so sorting + dedup are lossless transformations and
// pattern-set comparison is a sound drift signal. If a future milestone
// introduces order-sensitive glob semantics (negation, precedence
// rules, anchored-vs-unanchored ordering, etc.), this normalization
// stops being valid and `RestoreExcludeDriftError`'s pattern-set
// comparison would miss order-sensitive policy changes — both this
// docstring and the producer-side normalization call must be revisited
// at that point.
//
// Required field because restore needs both ends of the exclude policy
// on hand to detect drift bidirectionally:
//   - **Tightening drift** (current patterns are a SUPERSET of captured):
//     the new patterns may match captured manifest paths, which would
//     mean restore is being asked to extract files into paths the policy
//     now says are off-limits. Pre-mutation refusal via
//     `RestoreExcludeDriftError` (in `@viberevert/git`).
//   - **Loosening drift** (current patterns are a SUBSET of captured):
//     the working tree may contain pre-existing files that capture-time
//     exclusion preserved but restore-time would now consider deletable
//     by `deleteUncapturedUntracked`. Same pre-mutation refusal.
// Without this field persisted, only the tightening direction is
// detectable (by intersecting current-matcher against manifest paths);
// loosening requires comparing pattern sets directly, which needs the
// captured set on hand.
//
// Glob-string semantics, not path-string semantics — producers use
// `normalizeStringArray` (trims whitespace), NOT `normalizePathArray`
// (which preserves whitespace because pathnames legitimately may
// contain it).
// =============================================================================

const FileHashMap = z.record(safeStoredRelativePath, z.hash("sha256"));

export const ManifestSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  session_id: nonBlankString,
  captured_at: z.iso.datetime({ offset: true, precision: 0 }),
  name: nonBlankString.optional(),
  git: z.strictObject({
    head_sha: nonBlankString,
    branch: nonBlankString,
    porcelain_v1: z.string(),
  }),
  diffs: z.strictObject({
    unstaged_patch_path: safeStoredRelativePath,
    staged_patch_path: safeStoredRelativePath,
  }),
  snapshots: z.strictObject({
    tracked_dirty_archive_path: safeStoredRelativePath,
    tracked_dirty_paths: sortedUniquePathArray,
    file_hashes: FileHashMap,
  }),
  untracked: z.strictObject({
    archive_path: safeStoredRelativePath,
    exclude_patterns: sortedUniqueStringArray,
    file_hashes: FileHashMap,
  }),
  rollback_target_description: nonBlankString,
});
export type Manifest = z.infer<typeof ManifestSchema>;

// =============================================================================
// SessionReport (strict; M C `viberevert check` output artifact)
//
// Noise-budget caps (per D31 in the M C plan): a report MUST NOT exceed
// these limits when persisted. These are the LAST line of defense — the
// checks engine's D40 clustering pre-shrinks output before persistence so
// a non-buggy engine never trips them. Exceeding any cap signals an engine
// bug and the schema rejects the file.
//
// The low-cap matches the engine's own low-cap EXACTLY (per D40's locked
// "Headroom" table). The total and per-category caps leave a small (10)
// headroom over the engine's caps so a slightly-off engine still produces
// a schema-valid file with a clear "clustering should have been tighter"
// signal in code review rather than a hard parse failure in CI.
// =============================================================================

/** Per D31. Locked for v0.7.0-beta. Bumps require a new locked decision. */
export const NOISE_BUDGET_MAX_TOTAL = 100 as const;
/** Per D31. Matches the engine's D40 low-cap exactly (no headroom). */
export const NOISE_BUDGET_MAX_LOW = 20 as const;
/** Per D31. */
export const NOISE_BUDGET_MAX_PER_CATEGORY = 40 as const;

export const SessionReportSchema = z
  .strictObject({
    schema_version: z.literal(SCHEMA_VERSION),
    session_id: nonBlankString,
    started_at: z.iso.datetime({ offset: true, precision: 0 }),
    ended_at: z.iso.datetime({ offset: true, precision: 0 }).optional(),
    agent_command: nonBlankString.optional(),
    detected_frameworks: sortedUniqueStringArray,
    task: nonBlankString.optional(),
    checkpoint_id: nonBlankString.optional(),
    risk_level: RiskLevelSchema,
    changed_files: z.array(ChangedFileSchema),
    results: z.array(CheckResultSchema),
    rollback_available: z.boolean(),
    summary: nonBlankString.optional(),
  })
  .refine((r) => r.results.length <= NOISE_BUDGET_MAX_TOTAL, {
    message: `results must contain at most ${NOISE_BUDGET_MAX_TOTAL} findings total (engine should cluster)`,
    path: ["results"],
  })
  .refine((r) => r.results.filter((f) => f.level === "low").length <= NOISE_BUDGET_MAX_LOW, {
    message: `results must contain at most ${NOISE_BUDGET_MAX_LOW} findings of level 'low' (engine should cluster low-tail)`,
    path: ["results"],
  })
  .refine(
    (r) => {
      const counts = new Map<string, number>();
      for (const f of r.results) {
        counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
      }
      for (const count of counts.values()) {
        if (count > NOISE_BUDGET_MAX_PER_CATEGORY) return false;
      }
      return true;
    },
    {
      message: `results must contain at most ${NOISE_BUDGET_MAX_PER_CATEGORY} findings per category (engine should cluster category-tail)`,
      path: ["results"],
    },
  );
export type SessionReport = z.infer<typeof SessionReportSchema>;

// =============================================================================
// SessionState (strict; M B `session.json` artifact) and ActiveSessionLock
// (strict; M B `active-session.json` artifact).
//
// SessionState describes a single session's lifecycle metadata + paths to its
// associated status files. ActiveSessionLock is the in-flight subset persisted
// to `.viberevert/active-session.json` by `viberevert start` and removed by
// `viberevert end` — it represents "exactly one session is active in this repo
// right now" (per D11).
//
// Versioned independently of Manifest/SessionReport (see SESSION_STATE_SCHEMA_VERSION
// below) so SessionState can evolve without breaking Manifest readers and vice
// versa. They share the value "1.0" today; future migrations of either are
// independent.
//
// Path fields (`before_status_path`, `after_status_path`, `commands_log_path`)
// are repo-relative POSIX paths (forward slashes only, no '.' or '..' segments)
// per the canonical-path rule already used by Manifest.
//
// Refinement: `ended_at` and `after_status_path` are tied — both present iff
// the session has been ended. Validated below via `.refine()`.
// =============================================================================

/**
 * Independent schema version for the session.json artifact. Distinct from
 * SCHEMA_VERSION (which versions Manifest + SessionReport): SessionState may
 * evolve independently. Bumping this requires a documented migration in
 * MIGRATIONS.md (when that file exists) and corresponding zod schema changes
 * here.
 */
export const SESSION_STATE_SCHEMA_VERSION = "1.0" as const;

export type SessionStateSchemaVersion = typeof SESSION_STATE_SCHEMA_VERSION;

/**
 * Internal base object for SessionStateSchema and ActiveSessionLockSchema.
 *
 * Defined as a plain `strictObject` (not yet wrapped in `.refine()`) so that
 * `ActiveSessionLockSchema` can use `.pick()` to derive its subset — which is
 * not available on the `ZodEffects` wrapper produced by `.refine()`.
 */
const SessionStateBaseSchema = z.strictObject({
  schema_version: z.literal(SESSION_STATE_SCHEMA_VERSION),
  session_id: nonBlankString,
  checkpoint_id: nonBlankString,
  started_at: z.iso.datetime({ offset: true, precision: 0 }),
  ended_at: z.iso.datetime({ offset: true, precision: 0 }).optional(),
  task: nonBlankString.optional(),
  agent_command: nonBlankString.optional(),
  before_status_path: safeStoredRelativePath,
  after_status_path: safeStoredRelativePath.optional(),
  commands_log_path: safeStoredRelativePath,
});

export const SessionStateSchema = SessionStateBaseSchema.refine(
  (s) => (s.ended_at === undefined) === (s.after_status_path === undefined),
  {
    message:
      "ended_at and after_status_path must both be present (session ended) or both absent (session in-flight)",
    path: ["after_status_path"],
  },
);
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * In-flight subset of SessionState persisted to .viberevert/active-session.json.
 * Strict subset (`.pick()` on a `strictObject` returns a `strictObject`), so
 * unknown fields are rejected here too. No `ended_at` (an active session has
 * not ended), no path fields (those live in `session.json`).
 */
export const ActiveSessionLockSchema = SessionStateBaseSchema.pick({
  schema_version: true,
  session_id: true,
  checkpoint_id: true,
  started_at: true,
  task: true,
});
export type ActiveSessionLock = z.infer<typeof ActiveSessionLockSchema>;

// =============================================================================
// ReportFile (strict; M C on-disk wrapper for a written report)
//
// Per D31 in the M C plan. `SessionReportSchema` requires `session_id`, and
// an ad-hoc report (no owning session) has no real session id. Rather than
// breaking the locked v1.0 `SessionReportSchema`, we wrap it here with a
// small file-level header that distinguishes session-bound vs ad-hoc reports.
// Two persistence locations per D26 share ONE schema:
//
//   - session_bound  →  .viberevert/sessions/<sess>/report.json  (file-level atomic)
//   - ad_hoc         →  .viberevert/reports/<rpt_ULID>/report.json (dir-level atomic)
//
// `report_id` semantics:
//   - session_bound: equals the owning session's `sess_<ULID>`.
//   - ad_hoc:        equals a fresh `rpt_<ULID>` generated by the CLI for
//                    this report (see `generateReportId()` in @viberevert/core).
//   The file is self-identifying without inspecting its on-disk path.
//
//   **Important:** the embedded `report.session_id` MUST equal `report_id`
//   in BOTH cases — see the identity-invariant refine below. For ad-hoc
//   reports this means `report.session_id` deliberately carries the
//   `rpt_<ULID>` value, NOT a `sess_<ULID>` value (the underlying
//   `SessionReportSchema.session_id` is `nonBlankString`, not
//   `sess_`-prefix-constrained, so this is legal at the inner schema and
//   tightened here at the wrapper). Anything reading `report.session_id`
//   on an ad-hoc report should treat it as the report's own id, not as a
//   session reference; the `kind` discriminator on the wrapper makes the
//   distinction explicit.
//
// `since_kind` + `since_ref` + `since_resolved_sha` together fully describe
// the diff base (per D56):
//   - since_kind         → discriminator: how the user expressed the base.
//   - since_ref          → verbatim user input, post-resolution
//                          (e.g. "baseline" for checkpoint-name,
//                          "sess_01..." for session-id, "main" for git-ref).
//   - since_resolved_sha → audit field. For git-ref → the resolved SHA.
//                          For checkpoint/session → the checkpoint's
//                          captured `manifest.git.head_sha`.
//
// `staged_only` per D39: present-iff-true (literal `true`, never `false`).
// Omitted when `--staged` was not used. Combined with `kind: "ad_hoc"` only
// — checkpoint/session bases are mutually exclusive with `--staged` (D58).
//
// `written_at` is the wall-clock time the CLI persisted this report.
// Second-precision ISO 8601 (matches all other M B / M C timestamps);
// producers MUST route through `toIsoSecondString` from `./time.js`
// because `Date.prototype.toISOString()` always emits millisecond
// precision which `z.iso.datetime({ precision: 0 })` rejects.
// =============================================================================

/**
 * Independent schema version for the ReportFile wrapper artifact. Distinct
 * from SCHEMA_VERSION (which versions Manifest + SessionReport) AND from
 * SESSION_STATE_SCHEMA_VERSION (which versions session.json). Mirrors the
 * M B precedent of versioning each persisted-artifact family independently
 * so a bump in one wrapper does not force a bump in the others.
 */
export const REPORT_FILE_SCHEMA_VERSION = "1.0" as const;

export type ReportFileSchemaVersion = typeof REPORT_FILE_SCHEMA_VERSION;

// Crockford base32 alphabet excludes I, L, O, U. The 26-char body comes after
// the prefix. These regexes are used by the ReportFileSchema refines below to
// catch typos and malformed ids that a naive .startsWith() check would miss
// (e.g., "sess_garbage" or "sess_" alone).
const SESS_ULID_REGEX = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;
const RPT_ULID_REGEX = /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/;

// The locked `since_kind ↔ kind` consistency rule per D56:
//   - session_bound  ↔ since_kind ∈ { session_id, active_session }
//   - ad_hoc         ↔ since_kind ∈ { checkpoint_id, checkpoint_name, git_ref }
// These constant sets are checked at refine time so the rule is easy to audit
// and trivially extensible if a future SinceKind value lands.
const SESSION_BOUND_SINCE_KINDS: ReadonlySet<SinceKind> = new Set(["session_id", "active_session"]);
const AD_HOC_SINCE_KINDS: ReadonlySet<SinceKind> = new Set([
  "checkpoint_id",
  "checkpoint_name",
  "git_ref",
]);

export const ReportFileSchema = z
  .strictObject({
    schema_version: z.literal(REPORT_FILE_SCHEMA_VERSION),
    kind: ReportFileKindSchema,
    report_id: nonBlankString,
    since_kind: SinceKindSchema,
    since_ref: nonBlankString,
    since_resolved_sha: nonBlankString,
    staged_only: z.literal(true).optional(),
    written_at: z.iso.datetime({ offset: true, precision: 0 }),
    report: SessionReportSchema,
  })
  // (1) session_bound report_id must be a real sess_<26-char Crockford ULID>.
  .refine((f) => f.kind !== "session_bound" || SESS_ULID_REGEX.test(f.report_id), {
    message: "session_bound report_id must be a sess_<26-char Crockford ULID>",
    path: ["report_id"],
  })
  // (2) ad_hoc report_id must be a real rpt_<26-char Crockford ULID>.
  .refine((f) => f.kind !== "ad_hoc" || RPT_ULID_REGEX.test(f.report_id), {
    message: "ad_hoc report_id must be a rpt_<26-char Crockford ULID>",
    path: ["report_id"],
  })
  // (3) staged_only=true implies kind: "ad_hoc" (D39: --staged is mutually
  //     exclusive with session/checkpoint bases per D58, so any session_bound
  //     report carrying staged_only is a producer bug).
  .refine((f) => f.staged_only !== true || f.kind === "ad_hoc", {
    message: "staged_only=true requires kind='ad_hoc'",
    path: ["staged_only"],
  })
  // (4) since_kind ↔ kind consistency per D56.
  .refine(
    (f) =>
      f.kind === "session_bound"
        ? SESSION_BOUND_SINCE_KINDS.has(f.since_kind)
        : AD_HOC_SINCE_KINDS.has(f.since_kind),
    {
      message: "since_kind is inconsistent with kind",
      path: ["since_kind"],
    },
  )
  // (5) Identity invariant: report_id mirrors the embedded SessionReport's
  //     session_id exactly. Guarantees a consumer reading either field gets
  //     the same identity, and prevents a class of producer bugs where the
  //     wrapper-id and embedded-id drift.
  .refine((f) => f.report.session_id === f.report_id, {
    message: "report.session_id must equal report_id",
    path: ["report", "session_id"],
  });
export type ReportFile = z.infer<typeof ReportFileSchema>;
