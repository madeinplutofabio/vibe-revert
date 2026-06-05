// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert prompt-fix [--session <s>] [--report <r>] [--llm]` —
// render a deterministic, agent-safe fix-prompt from a persisted
// risk report per M E D80-D97.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
//  1. **D84 `--llm` pre-resolve precedence.** The `--llm` check fires
//     BEFORE repo-root resolution, BEFORE any config or target
//     resolution, BEFORE any filesystem read. Invoking
//     `viberevert prompt-fix --llm` outside a repo OR with a malformed
//     id OR against a missing report still surfaces the locked
//     deferred-feature copy from D93, NOT a repo-not-found / invalid-
//     id / no-report error. The flag is declared with `hidden: true`
//     per D90.4; the architectural-invariants test in Step 4 grep-
//     asserts the literal `hidden: true` near the declaration.
//
//  2. **D88 + byte-level drift guard.** The source `report.json` is
//     read TWICE: read A before parse + render, read B after render
//     and before write. Comparison uses `Buffer.equals` on the raw
//     bytes — NOT `String === String` on the decoded text — so subtle
//     encoding / BOM / line-ending concerns can never mask a real
//     mid-render write by a concurrent `viberevert check`. If bytes
//     A !== bytes B, the locked D93 drift-refusal copy fires, no
//     sibling prompt file is written, and no stdout is emitted. The
//     drift guard preserves the no-D22-lock decision (D44 / D88) —
//     it narrows the stale-derived-artifact window but is not full
//     mutual exclusion; a check that writes AFTER our read B is still
//     possible and is intentionally accepted for v0.7.0.
//
//  3. **D86 empty-findings refusal — drift-guarded deletion.** If
//     `report.results.length === 0`, the command refuses with the
//     locked D93 copy AND removes the sibling prompt file if present
//     (the "sibling artifact mirrors source report" contract).
//     Before deleting, the SAME byte-level drift check from lock #2
//     runs against the source report — without that guard, a check
//     that concurrently rewrote `report.json` from empty to non-empty
//     between read A and the deletion would cause us to delete a
//     sibling that's about to become valid again. The deletion itself
//     is ENOENT-tolerant best-effort (force-removal) — absence is a
//     no-op; any non-ENOENT failure surfaces the locked stale-
//     removal-failure D93 copy and aborts the refusal flow (the user
//     is told the stale artifact could not be invalidated and must
//     be removed manually before re-running). This is the ONLY
//     refusal path that mutates the filesystem.
//
//  4. **D81 file-before-stdout write order.** On the success path,
//     the atomic write to the sibling prompt file runs FIRST;
//     `this.context.stdout.write(promptText)` runs SECOND, only after
//     the file write committed. If the atomic write fails (disk full,
//     EACCES, EROFS, ...), the locked I/O-failure D93 copy fires and
//     stdout stays empty — the user never sees a prompt that wasn't
//     persisted. Catches the "I see a prompt but the command failed"
//     bad state at the seam.
//
//  5. **D90.6 fs-surface lock via typed-target helpers.** The locked
//     CLI-side filesystem surface is exactly three operations against
//     exactly two paths:
//        - the report-path read operation occurs exactly twice in
//          source (one each in `readReportBytes` and
//          `assertSourceReportUnchanged`).
//        - the sibling stale-removal operation occurs exactly once
//          (in `removeStaleFixPrompt`).
//        - the sibling atomic-write operation occurs exactly once
//          (in `persistFixPrompt`).
//     Each helper takes the typed `PromptFixReportTarget` argument
//     so the literal target-field expression appears at the fs call
//     site inside the helper body — preserving the D90.6 grep
//     pattern exactly even though the execute() body uses the
//     helper-name abstraction for readability. No aliasing of these
//     fs helpers anywhere in this file (per D90.6 sub-lock — code
//     review stays mechanical). Comments and docstrings in this file
//     are deliberately written as prose (e.g., "the report-path read
//     operation") rather than as literal call-shaped fragments, so
//     the Step 4 D90.6 grep can be brutally simple and still
//     reliable.
//
//  6. **D90.7 single renderer call site.** The renderer is invoked
//     EXACTLY ONCE in this file. The architectural-invariants test
//     in Step 4 will grep for the literal renderer-function call
//     pattern and assert exactly one occurrence. To avoid tripping
//     the grep with false positives, comments and docstrings refer
//     to it as "the renderer call" or "the render invocation" — NOT
//     with the literal function-name-plus-paren form. The single
//     call lives in `execute()` on the success path.
//
//  7. **D90.1/2/3 forbidden imports.** This file MUST NOT import
//     process-spawning modules, MUST NOT import the checks package
//     (prompt-fix consumes a persisted report; it does not re-run
//     checks), and MUST NOT import any third-party LLM SDK package.
//     The `--llm` flag is reserved as a hidden seam per D84; no LLM
//     code path exists in v0.7.0. Comments and docstrings avoid
//     spelling those forbidden module specifiers verbatim so Step 4's
//     invariant tests can use simple source scans without false
//     positives.
//
//  8. **D29 reporters discipline + D17c CLI atomic helpers.** This
//     file imports the public renderer from `@viberevert/reporters`
//     (not any per-format helper). It uses the CLI-private atomic-
//     write helper from `../atomic.js` (not core's or git's private
//     copies — those serve different artifact families per D17c).
//
//  9. **D19 config-blind.** `viberevert prompt-fix` does NOT load
//     `.viberevert.yml`. The resolved target carries everything the
//     command needs from the persisted report. No config-load call
//     anywhere in this file.
//
// 10. **D92 + D93 exit codes + refusal copy.** Exit 0 ONLY when the
//     prompt was rendered AND persisted AND emitted to stdout
//     successfully. Exit 1 for every refusal and every error
//     (--llm, no-report, ambiguous flags, invalid id shape, parse
//     failure, drift, I/O failure, stale-removal failure, empty
//     findings, internal). NEVER exit 2 — prompt-fix is a renderer,
//     not a gate. Stderr copy for each refusal class matches D93
//     verbatim. `InvalidReportSelectionError`'s message from
//     `report-paths.ts` differs slightly from D93's locked wording
//     for the CLI surface, so `handleKnownError` OVERRIDES that
//     class's message with the D93 form ("Invalid <kind> id
//     <quoted>. Expected the form <kind>_<26-character Crockford
//     ULID>.") — the other two M C refusal classes
//     (AmbiguousReportSelectionError, ReportNotFoundError) carry
//     D93-compatible messages already and are surfaced verbatim.
//     The override uses explicit `if (subjectKind === "session")`
//     and `if (subjectKind === "report")` branches with a
//     terminating `throw err` so a future widening of the union is
//     caught loudly instead of silently misclassified.
//
// 11. **handleKnownError mapping pattern.** Every typed error class
//     this command can encounter is EXPLICITLY mapped in
//     `handleKnownError` — never relies on a catch-all. Unknown
//     errors are re-thrown so Clipanion surfaces them as a crash
//     with stack trace (loud failure is correct for genuinely-
//     unexpected exceptions). The exhaustive mapping covers:
//        - RepoRootNotFoundError (M B repo discovery)
//        - AmbiguousReportSelectionError (D93 verbatim)
//        - InvalidReportSelectionError (D93 OVERRIDE)
//        - ReportNotFoundError (D93 verbatim)
//        - RuntimeEnvInvalidError (test-only env override path)
//        - PromptFixTargetResolutionError (file-local — wraps any
//          non-refusal throw from resolvePromptFixReportTarget,
//          including the resolver's defensive structural errors for
//          unexpected filename / layout)
//        - PromptFixReadFailureError (file-local — read I/O failures)
//        - PromptFixReportParseError (file-local — JSON / schema)
//        - PromptFixDriftDetectedError (file-local — D93 drift)
//        - PromptFixStaleRemovalFailureError (file-local — D93)
//        - PromptFixIoFailureError (file-local — D93 write failure)
//
// 12. **Version-resolution deferral.** Product-version resolution is
//     called AFTER the empty-findings refusal branch and BEFORE the
//     renderer invocation. Rationale: a malformed env var
//     (RuntimeEnvInvalidError) should NOT block stale sibling-prompt
//     cleanup for a clean report. Empty-findings refusal is a pure-
//     data operation that doesn't need a version. The version is
//     only needed when we're about to render and persist.
//
// 13. **Explicit read/parse error wrapping.** Every file-system read
//     and every parse step is wrapped in a typed file-local error
//     class. Without these wraps, a race where `report.json`
//     disappears between resolution and read A, OR a malformed JSON
//     payload, OR a schema-invalid `report.json`, would propagate as
//     an unknown throw and crash through Clipanion. Both
//     `PromptFixReadFailureError` and `PromptFixReportParseError`
//     carry the path + cause so the stderr message is diagnostic
//     enough to fix the underlying issue. The parse helper also
//     strips a leading UTF-8 BOM before JSON.parse — hand-edited
//     report files sometimes carry one and the strip keeps parsing
//     tolerant without affecting drift detection (which compares
//     raw pre-strip bytes).

import { readFile, rm } from "node:fs/promises";

import { RepoRootNotFoundError, resolveRepoRoot } from "@viberevert/core";
import { renderFixPrompt } from "@viberevert/reporters";
import { type ReportFile, ReportFileSchema } from "@viberevert/session-format";
import { Command, Option } from "clipanion";

import { writeFileAtomic } from "../atomic.js";
import {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  type PromptFixReportTarget,
  ReportNotFoundError,
  resolvePromptFixReportTarget,
} from "../prompt-fix-targets.js";
import { RuntimeEnvInvalidError, resolveProductVersionForReport } from "../runtime-env.js";

// =============================================================================
// Small helpers
// =============================================================================

/**
 * Render `cause` as a short human-readable string for embedding into
 * a wrapped Error's message. Special-cases:
 *   - `SyntaxError` — keep `.message` (JSON parse error position is
 *     useful diagnostic).
 *   - `ZodError` (detected by `.name`) — collapse to a short
 *     canonical string. ZodError's own message is a multi-line
 *     issue dump that reads as a wall in stderr; the full cause
 *     stays attached to the wrapping Error's `{ cause }` for
 *     stack-trace debugging.
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
// File-local error classes (per lock #11 + #13 — every read/parse/drift/
// stale-removal/write/resolver-internal failure has its own typed class so
// handleKnownError can map to the locked D93 copy without a catch-all)
// =============================================================================

/**
 * Thrown by the execute() resolver-catch path when
 * `resolvePromptFixReportTarget` throws anything OTHER than the
 * three known refusal classes (Ambiguous, Invalid, NotFound).
 * Catches the resolver's own defensive structural errors (filename
 * mismatch, layout mismatch) AND any unforeseen internal throw,
 * surfacing them as clean exit 1 instead of bubbling as an unknown
 * Clipanion crash. The wrapped cause carries the original message
 * (formatted via `formatCause`).
 */
class PromptFixTargetResolutionError extends Error {
  override readonly name = "PromptFixTargetResolutionError";
  constructor(cause: unknown) {
    super(formatCause(cause), { cause });
  }
}

/**
 * Thrown by `readReportBytes` when the source-report read fails for
 * any reason (ENOENT race after resolution, EACCES, EISDIR, EIO,
 * ...). Without this wrap, an fs error from the initial source-
 * report read would propagate unhandled and crash through
 * Clipanion's surface instead of producing the locked exit-1 +
 * clean stderr message. The path is surfaced in the message so the
 * user can diagnose the underlying failure (e.g., file permissions,
 * broken symlink).
 */
class PromptFixReadFailureError extends Error {
  override readonly name = "PromptFixReadFailureError";
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`Failed to read source report at ${path}: ${formatCause(cause)}.`, { cause });
  }
}

/**
 * Thrown by `parseReportFile` when `JSON.parse` fails (malformed
 * JSON) OR `ReportFileSchema.parse` fails (schema-invalid). Same
 * defensive rationale as `PromptFixReadFailureError`: prevents an
 * unknown throw from a corrupted-on-disk report from crashing
 * Clipanion. `formatCause` compacts ZodError's noisy message;
 * SyntaxError's parse-position message passes through verbatim.
 */
class PromptFixReportParseError extends Error {
  override readonly name = "PromptFixReportParseError";
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`Failed to parse source report at ${path}: ${formatCause(cause)}.`, { cause });
  }
}

/**
 * Thrown by `assertSourceReportUnchanged` when the post-render byte
 * comparison detects that the source `report.json` changed during
 * the rendering window. Carries the locked D93 drift-refusal copy
 * verbatim. Per lock #2, no sibling prompt file is written and no
 * stdout is emitted when this fires.
 */
class PromptFixDriftDetectedError extends Error {
  override readonly name = "PromptFixDriftDetectedError";
  constructor() {
    super("Source report changed while generating fix-prompt; re-run `viberevert prompt-fix`.");
  }
}

/**
 * Thrown by `removeStaleFixPrompt` when the sibling-removal
 * operation fails for any non-ENOENT reason (EACCES, EBUSY, EISDIR,
 * EROFS, ...). ENOENT is swallowed by the force-removal flag per
 * lock #3 — absence is the expected case when no prior sibling
 * prompt exists. Carries the locked D93 stale-removal-failure copy,
 * distinct from the persist-failure copy because the user's
 * recovery action differs: the stale prompt is still on disk and
 * must be hand-deleted before re-run is safe.
 */
class PromptFixStaleRemovalFailureError extends Error {
  override readonly name = "PromptFixStaleRemovalFailureError";
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `Failed to remove stale fix-prompt.txt at ${path}: ${formatCause(cause)}. ` +
        "Remove it manually and re-run `viberevert prompt-fix`.",
      { cause },
    );
  }
}

/**
 * Thrown by `persistFixPrompt` when the sibling atomic-write
 * operation fails (disk full, EACCES, EROFS, ...). Carries the
 * locked D93 I/O-failure copy. Per lock #4, stdout has NOT been
 * written when this fires (file-before-stdout write order) — the
 * user never sees a prompt that wasn't persisted.
 */
class PromptFixIoFailureError extends Error {
  override readonly name = "PromptFixIoFailureError";
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `Failed to persist fix-prompt.txt at ${path}: ${formatCause(cause)}. No prompt was emitted.`,
      { cause },
    );
  }
}

// =============================================================================
// Filesystem helpers (per lock #5 — each helper takes the typed
// PromptFixReportTarget so the literal target-field expression appears
// at the fs call site; D90.6 grep sees the expected pattern even though
// execute() uses the helper-name abstraction)
// =============================================================================

/**
 * Read A: read the source report bytes once. Returns the raw `Buffer`
 * so the caller can compare via `Buffer.equals` (lock #2 byte-level
 * drift guard) AND parse via `.toString("utf8")`. Wraps fs errors
 * in `PromptFixReadFailureError` per lock #13.
 *
 * Inside this helper body the read uses the target's report-path
 * field literally — one of the EXACTLY-TWO source occurrences D90.6
 * enforces. The other lives inside `assertSourceReportUnchanged`.
 */
async function readReportBytes(target: PromptFixReportTarget): Promise<Buffer> {
  try {
    return await readFile(target.reportPath);
  } catch (err) {
    throw new PromptFixReadFailureError(target.reportPath, err);
  }
}

/**
 * Parse the bytes from `readReportBytes` into a validated `ReportFile`.
 * Three failure modes wrapped uniformly in `PromptFixReportParseError`:
 *   - `JSON.parse` throws `SyntaxError` (malformed JSON)
 *   - `ReportFileSchema.parse` throws `ZodError` (schema-invalid)
 *   - leading UTF-8 BOM strip is BEFORE `JSON.parse` — older or
 *     cross-tool-edited report files sometimes carry one and Node's
 *     `JSON.parse` rejects it. The strip is byte-LEVEL on the
 *     decoded text only; raw-byte drift detection compares the
 *     pre-strip Buffer so this does not weaken D88.
 *
 * No filesystem access — pure transform. The `target` argument is
 * accepted only so the wrapped error message can carry the path
 * for diagnostics (which file failed to parse).
 */
function parseReportFile(target: PromptFixReportTarget, bytes: Buffer): ReportFile {
  try {
    const jsonText = bytes.toString("utf8").replace(/^﻿/, "");
    return ReportFileSchema.parse(JSON.parse(jsonText));
  } catch (err) {
    throw new PromptFixReportParseError(target.reportPath, err);
  }
}

/**
 * Read B + compare: re-read the source report bytes and compare
 * against `bytesA` (the bytes captured by `readReportBytes`).
 * Throws `PromptFixDriftDetectedError` on mismatch — per lock #2 the
 * caller MUST treat this as a hard refusal (no sibling prompt file
 * written, no stdout emitted, exit 1).
 *
 * Called from TWO sites at runtime — empty-findings refusal flow
 * (D86 drift-guarded deletion) AND success-path write flow (D88
 * drift-guarded write). Both call THIS helper exactly once per
 * execution; mutually exclusive at runtime.
 *
 * Inside this helper body the read uses the target's report-path
 * field literally — the second of the EXACTLY-TWO source
 * occurrences D90.6 enforces. Comparison uses `Buffer.equals` per
 * lock #2 — raw bytes only, not UTF-8 strings.
 */
async function assertSourceReportUnchanged(
  target: PromptFixReportTarget,
  bytesA: Buffer,
): Promise<void> {
  let bytesB: Buffer;
  try {
    bytesB = await readFile(target.reportPath);
  } catch (err) {
    // A read failure on the re-read path is treated the same as a
    // read failure on the initial read — wrap and surface as
    // PromptFixReadFailureError. The user's recovery action is the
    // same (fix the underlying fs/permission issue and re-run).
    throw new PromptFixReadFailureError(target.reportPath, err);
  }
  if (!bytesA.equals(bytesB)) {
    throw new PromptFixDriftDetectedError();
  }
}

/**
 * Remove the sibling prompt file per D86 empty-findings refusal.
 * ENOENT is intentionally swallowed via the force-removal flag —
 * absence is the expected case when no prior sibling prompt exists.
 * Any non-ENOENT failure (EACCES, EBUSY, EISDIR, ...) wraps as
 * `PromptFixStaleRemovalFailureError` carrying the locked D93 copy.
 *
 * Inside this helper body the removal uses the target's fix-prompt-
 * path field literally — the ONLY source occurrence D90.6 allows
 * for the sibling-removal operation.
 */
async function removeStaleFixPrompt(target: PromptFixReportTarget): Promise<void> {
  try {
    await rm(target.fixPromptPath, { force: true });
  } catch (err) {
    throw new PromptFixStaleRemovalFailureError(target.fixPromptPath, err);
  }
}

/**
 * Atomically persist the rendered prompt to the sibling prompt file
 * per D81 file-before-stdout write order. On the success path, this
 * runs BEFORE the stdout write — if it throws, stdout stays empty
 * and the user gets the locked D93 I/O-failure copy via
 * `handleKnownError`. Wrapped as `PromptFixIoFailureError`.
 *
 * Inside this helper body the write uses the target's fix-prompt-
 * path field literally — the ONLY source occurrence D90.6 allows
 * for the sibling atomic-write operation.
 */
async function persistFixPrompt(target: PromptFixReportTarget, text: string): Promise<void> {
  try {
    await writeFileAtomic(target.fixPromptPath, text);
  } catch (err) {
    throw new PromptFixIoFailureError(target.fixPromptPath, err);
  }
}

// =============================================================================
// Centralized typed-error → stderr mapping (lock #11)
// =============================================================================

/**
 * Map every typed error class this command can encounter to clean
 * stderr + exit 1. Mirrors `rollback.ts`'s pattern. Unknown errors
 * re-throw so Clipanion surfaces them as a crash with stack trace
 * (loud failure is correct for genuinely-unexpected exceptions —
 * the file-local error wrappers in lock #13 + the resolver-error
 * wrapper in lock #11 ensure no internal fs/parse/resolver failure
 * ever reaches this branch unwrapped).
 *
 * Special-case: `InvalidReportSelectionError` from `report-paths.ts`
 * carries a message format that differs slightly from D93's locked
 * wording for the prompt-fix CLI surface. Per D93, the prompt-fix
 * stderr copy is "Invalid <kind> id <quoted>. Expected the form
 * <kind>_<26-character Crockford ULID>." — this handler OVERRIDES
 * the class's `.message` with the D93 form, branching EXPLICITLY on
 * `err.subjectKind` ("session" vs "report") with a terminating
 * `throw err` for any unrecognized value (so a future widening of
 * the union is caught loudly instead of silently misclassified).
 */
function handleKnownError(stderr: { write(s: string): unknown }, err: unknown): number {
  if (err instanceof RepoRootNotFoundError) {
    stderr.write(
      "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
    );
    stderr.write("Run `viberevert init` to create a project here.\n");
    return 1;
  }
  if (err instanceof AmbiguousReportSelectionError) {
    // D93 reuse verbatim — M C error class carries the locked copy.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  if (err instanceof InvalidReportSelectionError) {
    // D93 OVERRIDE — M C error class's wording differs from the
    // locked prompt-fix surface copy. Explicit subjectKind
    // branching with a terminating throw for unrecognized values.
    if (err.subjectKind === "session") {
      stderr.write(
        `Invalid session id ${JSON.stringify(err.value)}. ` +
          "Expected the form sess_<26-character Crockford ULID>.\n",
      );
      return 1;
    }
    if (err.subjectKind === "report") {
      stderr.write(
        `Invalid report id ${JSON.stringify(err.value)}. ` +
          "Expected the form rpt_<26-character Crockford ULID>.\n",
      );
      return 1;
    }
    // A future widening of subjectKind would land here. Fail loud
    // rather than silently misclassify as one of the existing kinds.
    throw err;
  }
  if (err instanceof ReportNotFoundError) {
    // D93 reuse verbatim — M C error class carries the locked copy.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  if (
    err instanceof RuntimeEnvInvalidError ||
    err instanceof PromptFixTargetResolutionError ||
    err instanceof PromptFixReadFailureError ||
    err instanceof PromptFixReportParseError ||
    err instanceof PromptFixDriftDetectedError ||
    err instanceof PromptFixStaleRemovalFailureError ||
    err instanceof PromptFixIoFailureError
  ) {
    // Each class carries a locked or fully-formatted message per
    // D93 / lock #13. Surface verbatim.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  // Unknown error — re-throw so Clipanion surfaces it.
  throw err;
}

// =============================================================================
// Command class
// =============================================================================

export class PromptFixCommand extends Command {
  static override paths = [["prompt-fix"]];

  static override usage = Command.Usage({
    description: "Render a deterministic, agent-safe fix-prompt from a persisted risk report",
    details: `
Reads the most recent risk report (or the one specified via --session / --report)
and renders a text-only prompt suitable for pasting into a coding agent. The
prompt is also persisted as a sibling 'fix-prompt.txt' next to the source
'report.json'. Stdout and the persisted file are byte-identical.

Resolution order matches 'viberevert report':
  1. --session <sess> and --report <rpt> are mutually exclusive.
  2. --report <rpt>  → .viberevert/reports/<rpt>/report.json
  3. --session <sess> → .viberevert/sessions/<sess>/report.json
  4. Otherwise: the active session's report if present, else the latest
     report across both stores.

Refusals (exit 1, no fix-prompt.txt emitted):
  - --llm is reserved for a future release (not available in v0.7.0).
  - No matching report found.
  - Source report contains no findings (empty findings; stale
    fix-prompt.txt is removed if present).
  - Source report changed during rendering (drift guard).
  - Failed to write the prompt or remove a stale sibling.
    `,
    examples: [
      ["Render the latest report's fix-prompt", "$0 prompt-fix"],
      [
        "Render a specific session's prompt",
        "$0 prompt-fix --session sess_01JV8Z0N6E7ABCDEFGHJKMNPQR",
      ],
      [
        "Render a specific ad-hoc report's prompt",
        "$0 prompt-fix --report rpt_01JV8Z0N6E7ABCDEFGHJKMNPQR",
      ],
    ],
  });

  // --session and --report are validated by the resolver (lock #11
  // single source of truth). The command does NOT pre-validate id
  // shape — it catches InvalidReportSelectionError / Ambiguous /
  // NotFound from the resolver and maps to D93 copy.
  session = Option.String("--session", {
    description:
      "Load .viberevert/sessions/<sess>/report.json explicitly. Mutually exclusive with --report.",
  });

  report = Option.String("--report", {
    description:
      "Load .viberevert/reports/<rpt>/report.json explicitly. Mutually exclusive with --session.",
  });

  // D84 + D90.4: --llm is the reserved hidden seam for v0.8.x+. The
  // `hidden: true` literal MUST stay verbatim near this declaration
  // — the architectural-invariants test in Step 4 grep-asserts the
  // paired tokens within a small window.
  llm = Option.Boolean("--llm", false, {
    hidden: true,
    description: "[reserved] LLM-backed prompt rendering. Not available in v0.7.0; see roadmap.",
  });

  override async execute(): Promise<number> {
    // -------------------------------------------------------------------------
    // STEP 1: --llm pre-resolve check (lock #1 / D84).
    // Fires BEFORE repo-root resolution so the deferred-feature copy
    // is deterministic regardless of repo state.
    // -------------------------------------------------------------------------

    if (this.llm) {
      this.context.stderr.write(
        "--llm is reserved for a future release. Not available in v0.7.0; see roadmap.\n",
      );
      return 1;
    }

    // -------------------------------------------------------------------------
    // STEP 2: resolve repo root.
    // -------------------------------------------------------------------------

    let repoRoot: string;
    try {
      repoRoot = resolveRepoRoot();
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // -------------------------------------------------------------------------
    // STEP 3: resolve target (delegated to the resolver per the
    // single-source-of-truth flag-validation rule). The resolver
    // throws AmbiguousReportSelectionError / InvalidReportSelectionError /
    // ReportNotFoundError as appropriate; handleKnownError maps each
    // to its D93 copy. Anything else from the resolver (defensive
    // structural errors for unexpected filename / layout, or any
    // unforeseen internal throw) wraps as PromptFixTargetResolutionError
    // so handleKnownError can surface it as clean exit 1 instead of
    // letting it crash through Clipanion.
    // -------------------------------------------------------------------------

    let target: PromptFixReportTarget;
    try {
      target = await resolvePromptFixReportTarget(repoRoot, {
        ...(this.session !== undefined ? { session: this.session } : {}),
        ...(this.report !== undefined ? { report: this.report } : {}),
      });
    } catch (err) {
      if (
        err instanceof AmbiguousReportSelectionError ||
        err instanceof InvalidReportSelectionError ||
        err instanceof ReportNotFoundError
      ) {
        return handleKnownError(this.context.stderr, err);
      }
      return handleKnownError(this.context.stderr, new PromptFixTargetResolutionError(err));
    }

    // -------------------------------------------------------------------------
    // STEP 4: read A + parse. Both failure modes wrapped per lock #13
    // (PromptFixReadFailureError / PromptFixReportParseError).
    // -------------------------------------------------------------------------

    let reportBytesA: Buffer;
    let file: ReportFile;
    try {
      reportBytesA = await readReportBytes(target);
      file = parseReportFile(target, reportBytesA);
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // -------------------------------------------------------------------------
    // STEP 5: empty-findings refusal (D86) with drift-guarded
    // deletion (lock #3). The drift check fires BEFORE the
    // sibling-removal operation so we never delete a sibling that's
    // about to become valid again due to a concurrent check write.
    // The locked D93 copy references `file.report_id` — the
    // ReportFile field is the semantic source of truth (target.sourceId
    // is path-derived and currently equivalent, but D86's contract
    // wording is tied to the artifact field).
    // -------------------------------------------------------------------------

    if (file.report.results.length === 0) {
      try {
        await assertSourceReportUnchanged(target, reportBytesA);
        await removeStaleFixPrompt(target);
      } catch (err) {
        return handleKnownError(this.context.stderr, err);
      }
      this.context.stderr.write(
        `Report ${file.report_id} contains no findings; nothing to prompt-fix. ` +
          "Run `viberevert check ...` against fresh changes to generate a report with findings.\n",
      );
      return 1;
    }

    // -------------------------------------------------------------------------
    // STEP 6: resolve product version (lock #12 — deferred until
    // after empty-findings refusal so a malformed env var doesn't
    // block stale cleanup for a clean report).
    // -------------------------------------------------------------------------

    let productVersion: string;
    try {
      productVersion = resolveProductVersionForReport();
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // -------------------------------------------------------------------------
    // STEP 7: the single renderer call site (lock #6 / D81 / D90.7).
    // The architectural-invariants test in Step 4 will grep-assert
    // exactly one occurrence of the renderer function call in this
    // file. Comments here refer to it as "the renderer call" or
    // "the render invocation" — not by literal name + paren — to
    // avoid tripping the grep with false positives.
    // -------------------------------------------------------------------------

    const promptText = renderFixPrompt({ file, productVersion });

    // -------------------------------------------------------------------------
    // STEP 8: D88 drift guard for the success path + D81 file-before-
    // stdout write order. Both wrapped in a single try/catch — if the
    // drift check fires, the persist helper is NOT reached (no file
    // written, no stdout emitted, exit 1 with the D93 drift copy).
    // -------------------------------------------------------------------------

    try {
      await assertSourceReportUnchanged(target, reportBytesA);
      await persistFixPrompt(target, promptText);
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // -------------------------------------------------------------------------
    // STEP 9: stdout emission (D81 second sink — only after file
    // commit). Byte-identical to the persisted sibling prompt file
    // because both sinks consume the same `promptText` string from
    // the single renderer call in step 7.
    // -------------------------------------------------------------------------

    this.context.stdout.write(promptText);
    return 0;
  }
}
