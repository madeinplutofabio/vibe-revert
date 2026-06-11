// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Typed operation backing `viberevert prompt-fix` (CLI) and
// `generate_fix_prompt` (MCP). Owns all domain logic: repo-root
// resolution, target resolution (delegated to
// `resolvePromptFixReportTarget`), source-report read+parse,
// D86 drift-guarded empty-findings cleanup, D90.7 single renderer
// call, D88 success-path drift guard, D81 file-before-return-value
// write order.
//
// Owns NO presentation: never writes to process.stdout / process.stderr,
// never calls console.*, never reads process.cwd() (uses opts.cwd).
//
// =============================================================================
// "Move, don't improve" extraction discipline
// =============================================================================
//
// All locked behaviors are PRESERVED VERBATIM from the pre-extraction
// PromptFixCommand:
//   - Buffer.equals drift comparison (D88)
//   - Drift-first ordering in empty-findings path (D86 lock #3)
//   - Single renderer call site (D90.7)
//   - fs-surface lock: 2 read source occurrences + 1 rm + 1 write (D90.6)
//   - Leading BOM strip before JSON.parse (preserved from old line 383)
//   - ZodError compaction in formatCause (preserved from old lines 214-220)
//   - All typed-error `.message` strings (preserved byte-identical from
//     the pre-extraction file-local classes; CLI Command's
//     `${err.message}\n` stderr writes remain byte-identical).
//
// The ONLY new behavior in this file is `PromptFixEmptyFindingsError`
// (a typed error replacing the Command's inline-stderr-then-return-1
// pattern). Its `.message` is a brief diagnostic NEVER written to
// user stderr — the Command renders the locked D93 template using
// `err.reportId`. See PromptFixEmptyFindingsError's docstring.
//
// =============================================================================
// Architectural locks (carried over from PromptFixCommand verbatim)
// =============================================================================
//
// 1. **D88 + byte-level drift guard.** The source `report.json` is
//    read TWICE: read A before parse + render, read B after render
//    and before write. Comparison uses `Buffer.equals` on the raw
//    bytes — NEVER decode to string, NEVER parse, NEVER trim. A
//    future refactor that weakens the comparison (e.g., "but
//    JSON.parse would normalize..." reasoning) would silently break
//    D88's mid-render concurrent-write detection.
//
// 2. **D86 empty-findings refusal — drift-first ordering.** If
//    `report.results.length === 0`, the operation:
//      (a) drift-checks the source report (byte-level vs read A)
//      (b) removes the sibling fix-prompt.txt if present
//      (c) throws PromptFixEmptyFindingsError
//    Order is LOCKED: drift-check FIRST so we never delete a sibling
//    that's about to become valid again due to a concurrent check
//    that rewrote `report.json` from empty to non-empty. Stale
//    removal is ENOENT-tolerant (force-removal); other rm failures
//    surface as PromptFixStaleRemovalFailureError.
//    This is the ONLY refusal path that mutates the filesystem (the
//    sibling artifact mirrors the source report contract per D82).
//
// 3. **D81 file-before-return-value write order.** On the success
//    path, the atomic write to the sibling `fix-prompt.txt` runs
//    BEFORE this function returns the typed result. If the atomic
//    write fails, PromptFixIoFailureError is thrown — the caller
//    (CLI Command or MCP handler) never sees a `promptText` that
//    wasn't persisted. The CLI Command then writes `result.promptText`
//    to stdout AS-IS (NO trailing-newline append) — that completes
//    the D81 three-sink chain: renderer output → persisted file bytes
//    → returned promptText → CLI stdout bytes.
//
// 4. **D90.6 fs-surface lock via typed-target helpers.** The locked
//    operation-side filesystem surface is exactly three operations
//    against exactly two paths:
//      - the report-path read operation occurs exactly twice in
//        source (one each in `readReportBytes` and
//        `assertSourceReportUnchanged`).
//      - the sibling stale-removal operation occurs exactly once
//        (in `removeStaleFixPrompt`).
//      - the sibling atomic-write operation occurs exactly once
//        (in `persistFixPrompt`).
//    Each helper takes the typed `PromptFixReportTarget` argument so
//    the literal target-field expression appears at the fs call site
//    inside the helper body. No aliasing of these fs helpers anywhere
//    in this file.
//
// 5. **D90.7 single renderer call site.** `renderFixPrompt` is
//    invoked EXACTLY ONCE in this file. The architectural-invariants
//    test (substep 11) greps for the literal renderer-function call
//    pattern in `operations/generate-fix-prompt.ts` and asserts
//    exactly one occurrence. Comments and docstrings refer to it as
//    "the renderer call" or "the render invocation" — NOT with the
//    literal function-name-plus-paren form — to avoid tripping the
//    grep with false positives.
//
// 6. **D29 reporters discipline + D17c CLI atomic helpers.** This
//    file imports the public renderer from `@viberevert/reporters`
//    (not any per-format helper). It uses the cli-commands-private
//    atomic-write helper from `../atomic.js` (not core's or git's
//    private copies — those serve different artifact families).
//
// 7. **D19 config-blind.** This operation does NOT load
//    `.viberevert.yml`. The resolved target carries everything the
//    operation needs from the persisted report. No `loadConfig` call.
//
// 8. **Explicit read/parse/write/drift error wrapping.** Every fs
//    read, every parse, every write, every drift check is wrapped in
//    a typed operation-public error class. The `phase` field on
//    `PromptFixReadFailureError` and `PromptFixIoFailureError`
//    disambiguates which fs call site fired the error (the same
//    `target.reportPath` appears in both reads; the phase tells the
//    caller which one).
//
// =============================================================================
// `--llm` is CLI-only (NOT in this operation's surface)
// =============================================================================
//
// `--llm` is a reserved CLI-only hidden flag (D84 / D90.4). It must
// be refused BEFORE operation invocation by the Command (CLI
// pre-resolve check) or by the MCP tool's input schema (which simply
// has no `llm` field). The operation never sees `--llm` and has no
// opinion on it. NO `llm?: never` field on `GenerateFixPromptOperationOpts`
// — TS-level absence by design; runtime extras would be silently
// ignored anyway. A regression that calls this operation without
// the Command's pre-resolve refusal would mutate `fix-prompt.txt`
// even when the user passed `--llm`; the Command keeps that gate
// for both safety and locked CLI behavior.
//
// =============================================================================
// Callers must catch these typed errors and map to presentation
// =============================================================================
//
// Operation-public errors (defined in this file; barrel-exported;
// keyed by MCP's constructor-keyed envelope map):
//   - PromptFixTargetResolutionError      → wraps UNKNOWN resolver throws only
//   - PromptFixReadFailureError           → carries phase: "initial_read" | "drift_guard_read"
//   - PromptFixReportParseError           → JSON parse OR ReportFileSchema parse failed
//   - PromptFixDriftDetectedError         → byte-level mid-render drift detected
//   - PromptFixStaleRemovalFailureError   → empty-findings sibling rm failed (non-ENOENT)
//   - PromptFixIoFailureError             → carries phase: "persist_fix_prompt"
//   - PromptFixEmptyFindingsError         → carries reportId for D93 stderr template
//
// Passthrough errors (defined elsewhere; barrel-exported by their
// owning packages; mapped at @viberevert/core / report-paths /
// prompt-fix-targets / runtime-env layer). The operation does NOT
// re-wrap these — they pass through unchanged for the CLI Command's
// D93 stderr mapping and MCP's typed envelope mapping:
//   - RepoRootNotFoundError              (from @viberevert/core)
//   - AmbiguousReportSelectionError      (from ../prompt-fix-targets.js, re-exported from ../report-paths.js)
//   - InvalidReportSelectionError        (from ../prompt-fix-targets.js, re-exported from ../report-paths.js)
//   - ReportNotFoundError                (from ../prompt-fix-targets.js, re-exported from ../report-paths.js)
//   - RuntimeEnvInvalidError             (from ../runtime-env.js)
//
// =============================================================================
// Input validation boundary
// =============================================================================
//
// This operation accepts `opts.session` and `opts.report` as-is. The
// underlying resolver (`resolvePromptFixReportTarget`) enforces:
//   - mutual exclusion (both supplied → AmbiguousReportSelectionError)
//   - id shape (invalid → InvalidReportSelectionError)
//   - existence (no report → ReportNotFoundError)
// All three pass through unchanged. The operation does NOT re-validate
// flag shape (avoids double-validation drift between the two callers).

import { readFile, rm } from "node:fs/promises";

import { resolveRepoRoot } from "@viberevert/core";
import { renderFixPrompt } from "@viberevert/reporters";
import { type ReportFile, ReportFileSchema } from "@viberevert/session-format";

import { writeFileAtomic } from "../atomic.js";
import {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  type PromptFixReportTarget,
  ReportNotFoundError,
  resolvePromptFixReportTarget,
} from "../prompt-fix-targets.js";
import { resolveProductVersionForReport } from "../runtime-env.js";

// =============================================================================
// Small helpers (file-internal — NOT exported from the barrel)
// =============================================================================

/**
 * Render `cause` as a short human-readable string for embedding into
 * a wrapped Error's message. Preserved verbatim from pre-extraction
 * PromptFixCommand (lines 214-220). Special-cases:
 *   - `SyntaxError` — keep `.message` (JSON parse error position is
 *     useful diagnostic).
 *   - `ZodError` (detected by `.name`) — collapse to a short canonical
 *     string. ZodError's own message is a multi-line issue dump that
 *     reads as a wall in stderr; the full cause stays attached to the
 *     wrapping Error's structured `cause` field for stack-trace
 *     debugging.
 *   - Other `Error` — use `.message`.
 *   - Non-Error — `String(cause)`.
 *
 * Detect ZodError by `.name === "ZodError"` rather than `instanceof`
 * to avoid an extra Zod import + tighter coupling. Zod sets `name`
 * canonically; if a future Zod version changes the name, the worst
 * case is the wall-of-text resurfaces (graceful degradation).
 */
function formatCause(cause: unknown): string {
  if (cause instanceof SyntaxError) return cause.message;
  if (cause instanceof Error && cause.name === "ZodError") {
    return "report does not match ReportFile schema";
  }
  return cause instanceof Error ? cause.message : String(cause);
}

// =============================================================================
// Operation-public errors (barrel-exported; MCP constructor-keyed map keys)
// =============================================================================

/**
 * Thrown when `resolvePromptFixReportTarget` throws anything OTHER
 * than the three known refusal classes (Ambiguous, Invalid, NotFound).
 * Catches the resolver's own defensive structural errors (filename
 * mismatch, layout mismatch) AND any unforeseen internal throw.
 *
 * MCP envelope: { code: "PROMPT_FIX_TARGET_RESOLUTION_FAILED" }.
 *
 * Known refusal classes pass through UNCHANGED — this wrapper applies
 * ONLY to unexpected resolver failures.
 */
export class PromptFixTargetResolutionError extends Error {
  override readonly name = "PromptFixTargetResolutionError";
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(formatCause(cause));
    this.cause = cause;
  }
}

/**
 * Thrown when a source-report read fails for any reason (ENOENT race
 * after resolution, EACCES, EISDIR, EIO, ...). The `phase` field
 * disambiguates which of the two source-occurrence read sites fired:
 *   - "initial_read"       — `readReportBytes` (Step 3 in the operation)
 *   - "drift_guard_read"   — `assertSourceReportUnchanged` (Step 4 OR Step 7 at runtime)
 *
 * Without `phase`, two stderr entries pointing at the same report path
 * would be ambiguous; with `phase`, MCP diagnostics + audit log can
 * distinguish "couldn't even start" from "started but couldn't
 * re-verify".
 *
 * `.message` is preserved byte-identical from pre-extraction
 * PromptFixCommand (line 261): `Failed to read source report at ${path}: ${formatCause(cause)}.`
 */
export class PromptFixReadFailureError extends Error {
  override readonly name = "PromptFixReadFailureError";
  readonly phase: "initial_read" | "drift_guard_read";
  readonly path: string;
  override readonly cause: unknown;
  constructor(opts: {
    phase: "initial_read" | "drift_guard_read";
    path: string;
    cause: unknown;
  }) {
    super(`Failed to read source report at ${opts.path}: ${formatCause(opts.cause)}.`);
    this.phase = opts.phase;
    this.path = opts.path;
    this.cause = opts.cause;
  }
}

/**
 * Thrown when `JSON.parse` fails (malformed JSON) OR
 * `ReportFileSchema.parse` fails (schema-invalid). Same defensive
 * rationale as `PromptFixReadFailureError`: prevents an unknown throw
 * from a corrupted-on-disk report from crashing the caller.
 * `formatCause` compacts ZodError's noisy message; SyntaxError's
 * parse-position message passes through verbatim.
 *
 * `.message` is preserved byte-identical from pre-extraction
 * PromptFixCommand (line 279): `Failed to parse source report at ${path}: ${formatCause(cause)}.`
 */
export class PromptFixReportParseError extends Error {
  override readonly name = "PromptFixReportParseError";
  readonly path: string;
  override readonly cause: unknown;
  constructor(opts: { path: string; cause: unknown }) {
    super(`Failed to parse source report at ${opts.path}: ${formatCause(opts.cause)}.`);
    this.path = opts.path;
    this.cause = opts.cause;
  }
}

/**
 * Thrown by `assertSourceReportUnchanged` when the post-render byte
 * comparison detects that the source `report.json` changed during the
 * rendering window. Per lock #1, no sibling prompt file is written
 * and no `promptText` is returned when this fires.
 *
 * Carries no structured fields — the refusal is binary "drift
 * detected" and the locked D93 message is fixed.
 *
 * `.message` is preserved byte-identical from pre-extraction
 * PromptFixCommand (line 293).
 */
export class PromptFixDriftDetectedError extends Error {
  override readonly name = "PromptFixDriftDetectedError";
  constructor() {
    super("Source report changed while generating fix-prompt; re-run `viberevert prompt-fix`.");
  }
}

/**
 * Thrown by `removeStaleFixPrompt` when the sibling-removal operation
 * fails for any non-ENOENT reason (EACCES, EBUSY, EISDIR, EROFS, ...).
 * ENOENT is swallowed by the force-removal flag per lock #2 — absence
 * is the expected case when no prior sibling prompt exists. The
 * D93 stale-removal-failure copy is distinct from the persist-failure
 * copy because the user's recovery action differs: the stale prompt
 * is still on disk and must be hand-deleted before re-run is safe.
 *
 * `.message` is preserved byte-identical from pre-extraction
 * PromptFixCommand (lines 313-316).
 */
export class PromptFixStaleRemovalFailureError extends Error {
  override readonly name = "PromptFixStaleRemovalFailureError";
  readonly path: string;
  override readonly cause: unknown;
  constructor(opts: { path: string; cause: unknown }) {
    super(
      `Failed to remove stale fix-prompt.txt at ${opts.path}: ${formatCause(opts.cause)}. ` +
        "Remove it manually and re-run `viberevert prompt-fix`.",
    );
    this.path = opts.path;
    this.cause = opts.cause;
  }
}

/**
 * Thrown by `persistFixPrompt` when the sibling atomic-write operation
 * fails (disk full, EACCES, EROFS, ...). The `phase` field is
 * forward-looking — currently always "persist_fix_prompt"; a future
 * refactor that surfaces sub-phases of writeFileAtomic (e.g.,
 * "temp_write", "temp_rename") can extend the union without breaking
 * the API.
 *
 * Per lock #3, the caller has NOT received a `promptText` when this
 * fires (the operation throws before returning) — no risk of a
 * "I see the result but the file isn't written" bad state.
 *
 * `.message` is preserved byte-identical from pre-extraction
 * PromptFixCommand (line 335).
 */
export class PromptFixIoFailureError extends Error {
  override readonly name = "PromptFixIoFailureError";
  readonly phase: "persist_fix_prompt";
  readonly path: string;
  override readonly cause: unknown;
  constructor(opts: { phase: "persist_fix_prompt"; path: string; cause: unknown }) {
    super(
      `Failed to persist fix-prompt.txt at ${opts.path}: ${formatCause(opts.cause)}. No prompt was emitted.`,
    );
    this.phase = opts.phase;
    this.path = opts.path;
    this.cause = opts.cause;
  }
}

/**
 * Thrown when the parsed source report has zero findings
 * (`file.report.results.length === 0`). The operation throws this
 * AFTER the drift-guarded stale-sibling cleanup completes (or after
 * a drift check catches a concurrent mid-render mutation, in which
 * case PromptFixDriftDetectedError fires instead and the cleanup
 * doesn't happen).
 *
 * Carries `reportId` (the `report_id` field from the parsed
 * ReportFile — the semantic source of truth per D86).
 *
 * **`.message` is NEVER written to user-facing stderr.** The brief
 * "Report X contains no findings" form is for typed-error
 * introspection only (audit logs, test assertions, MCP envelope
 * details.reason). The CLI Command catches this class and renders
 * the locked D93 stderr copy using `err.reportId`:
 *   `Report ${err.reportId} contains no findings; nothing to prompt-fix. ` +
 *   "Run `viberevert check ...` against fresh changes to generate a report with findings.\n"
 * The Command's stderr template is preserved byte-identical from
 * pre-extraction PromptFixCommand (lines 697-700) — only the source
 * of the id changes (was `file.report_id`, now `err.reportId`; same
 * value at runtime).
 */
export class PromptFixEmptyFindingsError extends Error {
  override readonly name = "PromptFixEmptyFindingsError";
  readonly reportId: string;
  constructor(opts: { reportId: string }) {
    super(`Report ${opts.reportId} contains no findings`);
    this.reportId = opts.reportId;
  }
}

// =============================================================================
// Filesystem helpers (file-internal — NOT exported from the barrel)
// =============================================================================

/**
 * Read A: read the source report bytes once. Returns the raw `Buffer`
 * so the caller can compare via `Buffer.equals` (lock #1 byte-level
 * drift guard) AND parse via `.toString("utf8")`. Wraps fs errors in
 * PromptFixReadFailureError with phase="initial_read".
 *
 * Inside this helper body the read uses the target's report-path
 * field literally — one of the EXACTLY-TWO source occurrences D90.6
 * (lock #4) enforces. The other lives inside `assertSourceReportUnchanged`.
 */
async function readReportBytes(target: PromptFixReportTarget): Promise<Buffer> {
  try {
    return await readFile(target.reportPath);
  } catch (err) {
    throw new PromptFixReadFailureError({
      phase: "initial_read",
      path: target.reportPath,
      cause: err,
    });
  }
}

/**
 * Parse the bytes from `readReportBytes` into a validated `ReportFile`.
 * Three failure modes wrapped uniformly in PromptFixReportParseError:
 *   - `JSON.parse` throws `SyntaxError` (malformed JSON)
 *   - `ReportFileSchema.parse` throws `ZodError` (schema-invalid)
 *   - leading UTF-8 BOM strip is BEFORE `JSON.parse`. The escape form
 *     `﻿` is used here for code-review visibility; the runtime
 *     character is U+FEFF either way. Behavior preserved from
 *     pre-extraction PromptFixCommand (line 383). Older or
 *     cross-tool-edited report files sometimes carry a BOM and Node's
 *     `JSON.parse` rejects it. The strip is byte-LEVEL on the decoded
 *     text only; raw-byte drift detection (lock #1) compares the
 *     pre-strip Buffer so this does not weaken D88.
 *
 * No filesystem access — pure transform. The `target` argument is
 * accepted only so the wrapped error message can carry the path for
 * diagnostics (which file failed to parse).
 */
function parseReportFile(target: PromptFixReportTarget, bytes: Buffer): ReportFile {
  try {
    const jsonText = bytes.toString("utf8").replace(/^﻿/, "");
    return ReportFileSchema.parse(JSON.parse(jsonText));
  } catch (err) {
    throw new PromptFixReportParseError({ path: target.reportPath, cause: err });
  }
}

/**
 * Read B + compare: re-read the source report bytes and compare
 * against `bytesA` (the bytes captured by `readReportBytes`). Throws
 * PromptFixDriftDetectedError on mismatch — per lock #1 the caller
 * MUST treat this as a hard refusal (no sibling prompt file written,
 * no promptText returned).
 *
 * Called from TWO sites at runtime — empty-findings refusal flow
 * (D86 drift-guarded deletion) AND success-path write flow (D88
 * drift-guarded write). Both call THIS helper exactly once per
 * execution; mutually exclusive at runtime.
 *
 * Inside this helper body the read uses the target's report-path
 * field literally — the second of the EXACTLY-TWO source occurrences
 * D90.6 (lock #4) enforces. Comparison uses `Buffer.equals` per lock
 * #1 — raw bytes only, NEVER UTF-8 strings.
 */
async function assertSourceReportUnchanged(
  target: PromptFixReportTarget,
  bytesA: Buffer,
): Promise<void> {
  let bytesB: Buffer;
  try {
    bytesB = await readFile(target.reportPath);
  } catch (err) {
    throw new PromptFixReadFailureError({
      phase: "drift_guard_read",
      path: target.reportPath,
      cause: err,
    });
  }
  if (!bytesA.equals(bytesB)) {
    throw new PromptFixDriftDetectedError();
  }
}

/**
 * Remove the sibling prompt file per D86 empty-findings refusal.
 * ENOENT is intentionally swallowed via the force-removal flag —
 * absence is the expected case when no prior sibling prompt exists.
 * Any non-ENOENT failure wraps as PromptFixStaleRemovalFailureError.
 *
 * Inside this helper body the removal uses the target's fix-prompt-
 * path field literally — the ONLY source occurrence D90.6 (lock #4)
 * allows for the sibling-removal operation.
 */
async function removeStaleFixPrompt(target: PromptFixReportTarget): Promise<void> {
  try {
    await rm(target.fixPromptPath, { force: true });
  } catch (err) {
    throw new PromptFixStaleRemovalFailureError({ path: target.fixPromptPath, cause: err });
  }
}

/**
 * Atomically persist the rendered prompt to the sibling prompt file
 * per D81 file-before-return-value write order. On the success path,
 * this runs BEFORE the operation returns — if it throws, no
 * `promptText` is returned and the caller (CLI Command or MCP
 * handler) never sees a result that wasn't persisted.
 *
 * Inside this helper body the write uses the target's fix-prompt-
 * path field literally — the ONLY source occurrence D90.6 (lock #4)
 * allows for the sibling atomic-write operation.
 */
async function persistFixPrompt(target: PromptFixReportTarget, text: string): Promise<void> {
  try {
    await writeFileAtomic(target.fixPromptPath, text);
  } catch (err) {
    throw new PromptFixIoFailureError({
      phase: "persist_fix_prompt",
      path: target.fixPromptPath,
      cause: err,
    });
  }
}

// =============================================================================
// Operation public surface
// =============================================================================

export type GenerateFixPromptOperationOpts = {
  /** Directory to resolve the repo root from. Caller-supplied; the
   *  operation MUST NOT read `process.cwd()`. */
  cwd: string;
  /** Optional explicit session id (sess_<ULID>). Mutually exclusive
   *  with `report` — the resolver throws AmbiguousReportSelectionError
   *  if both are supplied. */
  session?: string;
  /** Optional explicit ad-hoc report id (rpt_<ULID>). Mutually
   *  exclusive with `session`. */
  report?: string;
};

export type GenerateFixPromptOperationResult = {
  /** The FULL rendered fix prompt. Byte-identical to the persisted
   *  `fix-prompt.txt` sibling file (D81). The CLI Command writes this
   *  string AS-IS to stdout (NO trailing-newline append) to complete
   *  the three-sink chain. */
  promptText: string;
  /** Absolute path to the persisted `fix-prompt.txt` sibling. */
  fixPromptPath: string;
  /** The `report_id` field from the parsed ReportFile.
   *  The ReportFile field is the semantic source of truth per D86;
   *  NEVER derived from the target's path-based `sourceId`. The
   *  shape is `sess_<ULID>` for session-bound reports and
   *  `rpt_<ULID>` for ad_hoc reports (per ReportFileSchema refines
   *  #1 and #2). */
  sourceReportId: string;
};

export async function generateFixPromptOperation(
  opts: GenerateFixPromptOperationOpts,
): Promise<GenerateFixPromptOperationResult> {
  // Step 1: resolve repo root from caller-supplied cwd.
  const repoRoot = resolveRepoRoot(opts.cwd);

  // Step 2: resolve target. The resolver enforces flag mutual
  // exclusion + id shape + existence. Known refusal classes
  // (AmbiguousReportSelectionError, InvalidReportSelectionError,
  // ReportNotFoundError) pass through UNCHANGED — they are the
  // resolver's public contract. Only unexpected resolver throws
  // wrap as PromptFixTargetResolutionError.
  let target: PromptFixReportTarget;
  try {
    target = await resolvePromptFixReportTarget(repoRoot, {
      ...(opts.session !== undefined ? { session: opts.session } : {}),
      ...(opts.report !== undefined ? { report: opts.report } : {}),
    });
  } catch (err) {
    if (
      err instanceof AmbiguousReportSelectionError ||
      err instanceof InvalidReportSelectionError ||
      err instanceof ReportNotFoundError
    ) {
      throw err;
    }
    throw new PromptFixTargetResolutionError(err);
  }

  // Step 3: read A + parse.
  const reportBytesA = await readReportBytes(target);
  const file = parseReportFile(target, reportBytesA);

  // Step 4: empty-findings refusal (D86) with drift-first ordering
  // per lock #2. Drift-check FIRST so we never delete a sibling
  // that's about to become valid again due to a concurrent check
  // write. `sourceReportId` is the ReportFile field (lock #5: the
  // ReportFile field is the semantic source of truth — NOT
  // target.sourceId which is path-derived).
  if (file.report.results.length === 0) {
    await assertSourceReportUnchanged(target, reportBytesA);
    await removeStaleFixPrompt(target);
    throw new PromptFixEmptyFindingsError({ reportId: file.report_id });
  }

  // Step 5: resolve product version. Deferred until after the empty-
  // findings refusal so a malformed env var (RuntimeEnvInvalidError)
  // doesn't block stale-sibling cleanup for a clean-but-empty report.
  const productVersion = resolveProductVersionForReport();

  // Step 6: the single renderer call site (lock #5 / D81 / D90.7).
  // The architectural-invariants test (substep 11) will grep-assert
  // exactly one occurrence of the renderer function call in this
  // file. Comments here refer to it as "the renderer call" or "the
  // render invocation" — NOT by literal name + paren — to avoid
  // tripping the grep with false positives.
  const promptText = renderFixPrompt({ file, productVersion });

  // Step 7: D88 drift guard for the success path + D81 file-before-
  // return-value write order. If the drift check fires, the persist
  // helper is NOT reached (no file written, no result returned).
  await assertSourceReportUnchanged(target, reportBytesA);
  await persistFixPrompt(target, promptText);

  // Step 8: return the typed result. `sourceReportId` is the
  // ReportFile field (semantic source of truth per D86 / lock #5),
  // NEVER derived from target.sourceId (path-based).
  return {
    promptText,
    fixPromptPath: target.fixPromptPath,
    sourceReportId: file.report_id,
  };
}
