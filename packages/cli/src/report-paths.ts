// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// CLI report-path resolution — D26/D47 dispatcher for `viberevert report`.
//
// Pure module: resolves CLI flags + filesystem state to a single absolute
// path pointing at the `report.json` the caller should render. Does NOT
// load or parse the report content for explicit-ID lookups (the caller
// reads + validates separately, so parse errors surface as their own
// distinct failure mode). DOES parse during the default-resolution scan
// to extract `written_at` and `report_id` for the locked sort key.
//
// Per D47 the resolution order is:
//
//   1. `--session` + `--report` both set → AmbiguousReportSelectionError.
//
//   2. `--report <id>` set → `.viberevert/reports/<id>/report.json`.
//      Existence check only; ReportNotFoundError if missing.
//
//   3. `--session <id>` set → `.viberevert/sessions/<id>/report.json`.
//      Existence check only; ReportNotFoundError with the D47-locked
//      message ("Run `viberevert check --since <id>` first") if missing.
//
//   4. Neither flag set → default resolution:
//      a. Active session's `report.json` if it exists.
//      b. Latest report across BOTH `.viberevert/sessions/*/report.json`
//         AND `.viberevert/reports/*/report.json`, sorted by the locked
//         multi-level key [written_at DESC, report_id DESC, path ASC].
//         Corrupt reports (parse failure) silently skipped so one bad
//         file doesn't crash the default-resolution path.
//      c. ReportNotFoundError if nothing found.
//
// Design rules (matching C.1's runtime-env.ts boundary):
//
//   - **ID validation EVERYWHERE a path is built from an id.** Both
//     CLI-flag ids AND the active lock's `session_id` MUST match their
//     canonical `sess_<ULID>` / `rpt_<ULID>` regex before being passed
//     into `path.join`. The active lock is on-disk state, NOT a
//     compile-time trusted constant — `ActiveSessionLockSchema` only
//     enforces `nonBlankString`, so a manually-edited or corrupted lock
//     containing `"../.."` would otherwise escape the intended
//     directory. Invalid ids throw `InvalidReportSelectionError`.
//
//   - **Container-name filtering in the default scan.** The default-
//     resolution scan accepts only directories whose name matches the
//     canonical `sess_<ULID>` / `rpt_<ULID>` regex. Without this filter,
//     a stray or attacker-created directory like
//     `.viberevert/reports/anything-else/` with a schema-valid
//     `report.json` would silently participate in default resolution
//     and could shadow the legitimate winner.
//
//   - **Symlink-strict at every filesystem boundary.** Existence checks
//     use `lstat` + `isFile()` / `isDirectory()` so symlinks fail the
//     check. The default-resolution scan ALSO `lstat`-checks each parent
//     container (`.viberevert/reports/<entry>/`) before probing the
//     inner `report.json` — without that, a symlinked container could
//     redirect the lookup to an arbitrary path.
//
//   - **No console, no process.stderr, no Clipanion.** Pure resolver
//     logic; the CLI layer owns terminal stream writes per D29.
//
//   - **Structured errors.** Each error class carries the fields the
//     caller would need to render the user-facing message (subjectKind,
//     subject, value, reason). The `message` field is already formatted
//     per D47 so the CLI can write it verbatim.

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadActiveSessionLock } from "@viberevert/core";
import { type ReportFile, ReportFileSchema } from "@viberevert/session-format";

// =============================================================================
// Constants
// =============================================================================

const VIBEREVERT_DIR = ".viberevert";
const SESSIONS_SUBDIR = "sessions";
const REPORTS_SUBDIR = "reports";
const REPORT_FILENAME = "report.json";

/** Canonical session id: sess_ + 26-char Crockford base32 (excludes I, L, O, U). */
const SESSION_ID_RE = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Canonical ad-hoc report id: rpt_ + 26-char Crockford base32. */
const REPORT_ID_RE = /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/;

// =============================================================================
// Public options
// =============================================================================

export interface ResolveReportPathsOptions {
  readonly repoRoot: string;
  /** From `--session` flag. Mutually exclusive with `reportId`. */
  readonly sessionId?: string;
  /** From `--report` flag. Mutually exclusive with `sessionId`. */
  readonly reportId?: string;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown when both `--session` and `--report` are passed. D47 locks
 * them as mutually exclusive; the CLI surfaces this as exit 1.
 */
export class AmbiguousReportSelectionError extends Error {
  override readonly name = "AmbiguousReportSelectionError";
  constructor(
    readonly sessionId: string,
    readonly reportId: string,
  ) {
    super(
      `--session and --report are mutually exclusive. ` +
        `Got --session ${JSON.stringify(sessionId)} and --report ${JSON.stringify(reportId)}.`,
    );
  }
}

/**
 * Thrown when a session/report id does not match its canonical ULID
 * shape. Validating here — BEFORE path construction — prevents a
 * malformed value (e.g. `"../.."` or a value with slashes) from
 * escaping the intended directory via `path.join`.
 *
 * Surfaces for both CLI-flag ids AND repo-state ids (i.e., the
 * `session_id` field of `active-session.json`). The lock-state case
 * is real: `ActiveSessionLockSchema` only enforces `nonBlankString`
 * on `session_id`, so a manually-edited or corrupted lock could carry
 * an arbitrary string. The CLI surfaces this as exit 1.
 */
export class InvalidReportSelectionError extends Error {
  override readonly name = "InvalidReportSelectionError";
  constructor(
    readonly subjectKind: "session" | "report",
    readonly value: string,
    readonly reason: string,
  ) {
    super(`Invalid ${subjectKind} id ${JSON.stringify(value)}: ${reason}`);
  }
}

/**
 * Thrown when the requested report cannot be located. Carries
 * `subjectKind` ("session" / "report" / "default") and an optional
 * `subject` (the id the user requested, when applicable) so the
 * caller can branch on shape if needed. The `message` is the
 * user-facing text — already formatted per D47 — so the caller can
 * write it verbatim to stderr.
 */
export class ReportNotFoundError extends Error {
  override readonly name = "ReportNotFoundError";
  constructor(
    message: string,
    readonly subjectKind: "session" | "report" | "default",
    readonly subject?: string,
  ) {
    super(message);
  }
}

// =============================================================================
// ID validators (path-traversal defense)
// =============================================================================

function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new InvalidReportSelectionError(
      "session",
      sessionId,
      "expected sess_<26-char Crockford ULID>",
    );
  }
}

function assertValidReportId(reportId: string): void {
  if (!REPORT_ID_RE.test(reportId)) {
    throw new InvalidReportSelectionError(
      "report",
      reportId,
      "expected rpt_<26-char Crockford ULID>",
    );
  }
}

// =============================================================================
// Filesystem helpers (symlink-strict)
// =============================================================================

/**
 * True iff `absPath` exists as a regular file. Symlinks fail the check
 * (lstat does not follow), matching the codebase's symlink-strict
 * stance everywhere file-existence matters.
 */
async function isRegularFile(absPath: string): Promise<boolean> {
  try {
    const st = await lstat(absPath);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * True iff `absPath` exists as a real directory (not a symlink-to-dir).
 * Used to reject symlinked parent containers in the default-resolution
 * scan, mirroring the convention in `listCheckpoints` over in
 * `@viberevert/git`.
 */
async function isRegularDirectory(absPath: string): Promise<boolean> {
  try {
    const st = await lstat(absPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Absolute path to a session-bound report. */
function sessionReportPath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, VIBEREVERT_DIR, SESSIONS_SUBDIR, sessionId, REPORT_FILENAME);
}

/** Absolute path to an ad-hoc report. */
function adHocReportPath(repoRoot: string, reportId: string): string {
  return join(repoRoot, VIBEREVERT_DIR, REPORTS_SUBDIR, reportId, REPORT_FILENAME);
}

/**
 * Read + ReportFileSchema-parse the file at `absPath`. Returns the
 * parsed value on success, `null` on any failure (missing, unreadable,
 * malformed JSON, schema-invalid). Used ONLY by the default-resolution
 * scan; explicit-ID paths defer parsing to the caller so parse errors
 * surface as their own distinct failure mode.
 */
async function tryLoadReportFile(absPath: string): Promise<ReportFile | null> {
  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ReportFileSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Enumerate candidate `report.json` paths under the given parent
 * directory (either `.viberevert/sessions` or `.viberevert/reports`).
 * Returns absolute paths for entries whose name matches `expectedName`
 * AND whose container is a real directory AND whose `report.json` is
 * a real file. Returns `[]` if the parent directory itself is absent
 * (fresh repo, no checks/sessions run yet).
 *
 * Three layers of filter:
 *   1. **Name match** — only entries whose basename matches the
 *      caller-supplied canonical regex (`SESSION_ID_RE` or
 *      `REPORT_ID_RE`). Excludes stray/foreign dirs from default
 *      resolution; without this, an entry like
 *      `.viberevert/reports/anything-else/report.json` could silently
 *      shadow legitimate winners.
 *   2. **Symlink-strict container** — `lstat` + `isDirectory()`.
 *      Without this, `.viberevert/reports/rpt_FAKE -> /tmp/evil/`
 *      would silently redirect the lookup.
 *   3. **Symlink-strict inner file** — `lstat` + `isFile()` on the
 *      `report.json` itself.
 */
async function listCandidateReports(
  parentAbs: string,
  expectedName: RegExp,
): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(parentAbs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    // Skip D13 temp/in-progress siblings at iteration time.
    if (name.startsWith(".tmp-")) continue;
    // Name filter — only canonical container names participate.
    if (!expectedName.test(name)) continue;
    const entryAbs = join(parentAbs, name);
    if (!(await isRegularDirectory(entryAbs))) continue;
    const candidate = join(entryAbs, REPORT_FILENAME);
    if (await isRegularFile(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

interface ScannedReport {
  readonly absPath: string;
  readonly file: ReportFile;
}

/**
 * Scan + parse every report.json across both sessions/ and reports/.
 * Silently drops files that fail to read or schema-parse — the
 * default-resolution path's job is "find the latest VALID report",
 * not "fail on the first corrupt one". Each side's enumeration is
 * scoped to canonically-named containers (SESSION_ID_RE / REPORT_ID_RE).
 */
async function scanValidReports(repoRoot: string): Promise<readonly ScannedReport[]> {
  const [sessionCandidates, adHocCandidates] = await Promise.all([
    listCandidateReports(join(repoRoot, VIBEREVERT_DIR, SESSIONS_SUBDIR), SESSION_ID_RE),
    listCandidateReports(join(repoRoot, VIBEREVERT_DIR, REPORTS_SUBDIR), REPORT_ID_RE),
  ]);
  const all = [...sessionCandidates, ...adHocCandidates];
  const scanned: ScannedReport[] = [];
  for (const absPath of all) {
    const file = await tryLoadReportFile(absPath);
    if (file !== null) scanned.push({ absPath, file });
  }
  return scanned;
}

/**
 * D47-locked sort comparator: [written_at DESC, report_id DESC,
 * absPath ASC]. The second-precision `written_at` makes ties realistic
 * (two reports written in the same second is plausible); the
 * tie-breakers guarantee deterministic ordering regardless of
 * filesystem iteration order.
 *
 * ULID lex == chronological per D5, and the `written_at` string is
 * fixed-width ISO 8601, so plain string comparison gives the right
 * order on both fields.
 */
function compareForDefaultResolution(a: ScannedReport, b: ScannedReport): number {
  const wa = a.file.written_at;
  const wb = b.file.written_at;
  if (wa !== wb) return wa < wb ? 1 : -1; // DESC
  const ra = a.file.report_id;
  const rb = b.file.report_id;
  if (ra !== rb) return ra < rb ? 1 : -1; // DESC
  return a.absPath < b.absPath ? -1 : a.absPath > b.absPath ? 1 : 0; // ASC
}

// =============================================================================
// Public — resolveReportPaths
// =============================================================================

export async function resolveReportPaths(opts: ResolveReportPathsOptions): Promise<string> {
  const { repoRoot, sessionId, reportId } = opts;

  // 1. Mutual exclusion.
  if (sessionId !== undefined && reportId !== undefined) {
    throw new AmbiguousReportSelectionError(sessionId, reportId);
  }

  // 2. --report <id> path. Validate id BEFORE path construction.
  if (reportId !== undefined) {
    assertValidReportId(reportId);
    const abs = adHocReportPath(repoRoot, reportId);
    if (await isRegularFile(abs)) {
      return abs;
    }
    throw new ReportNotFoundError(`Report ${reportId} not found.`, "report", reportId);
  }

  // 3. --session <id> path. Validate id BEFORE path construction.
  if (sessionId !== undefined) {
    assertValidSessionId(sessionId);
    const abs = sessionReportPath(repoRoot, sessionId);
    if (await isRegularFile(abs)) {
      return abs;
    }
    throw new ReportNotFoundError(
      `No report found for session ${sessionId}. ` +
        `Run \`viberevert check --since ${sessionId}\` first.`,
      "session",
      sessionId,
    );
  }

  // 4. Default resolution.
  //   4a. Active session with a report. The active lock is on-disk
  //   state (could be manually edited or corrupted) and
  //   ActiveSessionLockSchema only enforces nonBlankString on
  //   session_id — so re-validate against the canonical ULID shape
  //   BEFORE building the path. A `../..` value would otherwise escape
  //   via `join`.
  const activeLock = await loadActiveSessionLock(repoRoot);
  if (activeLock !== null) {
    assertValidSessionId(activeLock.session_id);
    const activeReportAbs = sessionReportPath(repoRoot, activeLock.session_id);
    if (await isRegularFile(activeReportAbs)) {
      return activeReportAbs;
    }
    // Fall through to 4b: active session exists but no report yet.
  }

  //   4b. Latest across both dirs, deterministic sort.
  const scanned = await scanValidReports(repoRoot);
  if (scanned.length > 0) {
    const sorted = [...scanned].sort(compareForDefaultResolution);
    // sorted[0] is defined because length > 0; defensive narrowing for TS.
    const winner = sorted[0];
    if (winner !== undefined) return winner.absPath;
  }

  //   4c. Nothing anywhere.
  throw new ReportNotFoundError("No reports found. Run `viberevert check` first.", "default");
}
