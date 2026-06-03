// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// renderReceiptTerminal: ANSI-free plain-text rendering of a
// ReceiptFile for human-facing CLI rollback output.
//
// =============================================================================
// CONTRACT (D45 + D55 + D54 + D62)
// =============================================================================
//
// Output is:
//   - PURE STRING — caller (CLI) writes to stdout; reporters never
//     write to terminal streams per D29.
//   - ANSI-FREE — no color codes, no escape sequences (D55). Plain
//     ASCII keeps the output portable and golden-fixture-friendly
//     (byte-stable across platforms and locales). The renderer
//     emits ONLY ASCII bytes in output strings (no em-dashes, no
//     smart quotes, no Unicode glyphs); the locked "ASCII" claim
//     is enforced at this boundary. Source-file comments may use
//     UTF-8 freely.
//     EXCEPTION: `file.out_of_scope_notice` is rendered verbatim
//     and originates from the schema's `ROLLBACK_OUT_OF_SCOPE_NOTICE`
//     literal in @viberevert/session-format. That literal is
//     pure ASCII today; if a future schema bump introduces
//     non-ASCII characters there, the ASCII contract becomes
//     scoped to "everything THIS renderer emits" rather than
//     "the entire output buffer". Goldens would catch the change.
//   - FIXED 80-COLUMN LAYOUT — no terminal-width probing; section
//     dividers are 80-char ASCII rules. Lines that naturally exceed
//     80 chars (long file paths, the out-of-scope notice paragraph)
//     are NOT truncated or word-wrapped; the renderer trusts the
//     terminal to wrap them visually. Same convention as M C
//     `renderTerminal`.
//   - NEWLINE-TERMINATED — the final character is always '\n', so
//     the CLI can write the string directly without appending.
//
// =============================================================================
// LAYOUT (LOCKED — drives golden fixtures from Step 8)
// =============================================================================
//
// Any future layout change requires a deliberate
// `pnpm regen-goldens` run + commit. Mirrors the M C report
// terminal layout's stability discipline.
//
//   ================================================================================
//   VibeRevert Rollback Receipt                         [or "...Receipt (DRY-RUN)"]
//   ================================================================================
//
//   Rollback ID:      <rb_id>
//   Session ID:       <sess_id>
//   Checkpoint ID:    <cp_id>
//   Mode:             <dry_run | apply>
//   Forced:           <true | false>
//   Pre-rollback CP:  <cp_id | "(none - dry-run)">
//   Dirty-tree check: <performed | skipped_no_after_state>
//   Written at:       <iso>
//
//   [WARNING] Active session - apply mode would refuse on this session.   [iff present]
//   [WARNING] No machine-readable after-status snapshot for this session. [iff present]
//
//   --------------------------------------------------------------------------------
//   Forced Unrelated Dirty Paths (<N>)                  [SECTION OMITTED when N=0]
//   --------------------------------------------------------------------------------
//
//   <path>
//   <path>
//
//   --------------------------------------------------------------------------------
//   Results (<N>)
//   --------------------------------------------------------------------------------
//
//   [<OUTCOME>]  <path>
//     Reason: <reason>                                  [iff present]
//
//   [<OUTCOME>]  <path>                                 [blank line between entries]
//
//   --------------------------------------------------------------------------------
//   Failures (<N>)
//   --------------------------------------------------------------------------------
//
//   [<ERROR_CODE>] <message>
//     Affected paths:                                   [iff affected_paths non-empty]
//       - <path>
//       - <path>
//
//   --------------------------------------------------------------------------------
//   Out of Scope
//   --------------------------------------------------------------------------------
//
//   <file.out_of_scope_notice>                          [verbatim, single paragraph]
//
// Outcome / error_code tokens preserve the schema's snake_case form
// uppercased inside brackets ("[TRACKED_RESTORED]",
// "[EXTRACTION_CONFLICT]") — same bracket convention as M C's
// "[CRITICAL]" level token. Underscore is preserved so the token
// stays grep-able as a single word.
//
// Empty Results / Failures sections render the placeholder "(none)"
// rather than vanishing — keeps layout shape predictable for human
// scanning and byte-stable for golden fixtures. The "Forced
// Unrelated Dirty Paths" section is the exception: it ONLY appears
// when non-empty (schema refines forbid populating it outside the
// --apply --force-overriding-unrelated-dirt path), so displaying
// "(none)" on every receipt would be visual noise. The "Out of
// Scope" section always appears — the D62 disclaimer is part of
// every receipt's locked contract.
//
// Results and Failures sections BOTH separate entries with a single
// blank line for visual consistency and golden-fixture stability.
// A previous draft had conditional spacing (blank line only when
// reason field present) which produced inconsistent output and
// fragile goldens; symmetric always-blank matches the M C
// `buildFindingsSection` pattern.
//
// NO version footer in terminal output (mirrors M C terminal).
// Version-stamping is markdown-only per the D45 locked footer.
// `input.productVersion` is accepted on ReceiptRenderInput for API
// uniformity across renderers but is intentionally NOT consumed
// here.

import type { ReceiptFile, RollbackFailure, RollbackFileResult } from "@viberevert/session-format";

import type { ReceiptRenderInput } from "./receipt-types.js";

// =============================================================================
// Locked layout constants
// =============================================================================

const TERMINAL_WIDTH = 80;
const RULE_DOUBLE = "=".repeat(TERMINAL_WIDTH);
const RULE_SINGLE = "-".repeat(TERMINAL_WIDTH);

// Header label column width. Chosen so the widest label
// ("Dirty-tree check:" = 17 chars) aligns with the rest, plus one
// trailing space → 18. If a longer label is ever added, bump this
// constant AND regenerate goldens. Locked locally rather than shared
// with terminal.ts's HEADER_LABEL_WIDTH so the report and receipt
// layouts can evolve independently — a future receipt-specific
// label change shouldn't drag the report layout along.
const HEADER_LABEL_WIDTH = 18;

// =============================================================================
// Tiny formatting helpers
// =============================================================================

/** Pad a string to `width` columns with trailing spaces. */
function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

/** Format a labeled header line: "Label:            value". */
function headerLine(label: string, value: string): string {
  return padRight(`${label}:`, HEADER_LABEL_WIDTH) + value;
}

/** Format an enum-like token in brackets: "[TRACKED_RESTORED]". */
function bracketToken(token: string): string {
  return `[${token.toUpperCase()}]`;
}

// =============================================================================
// Section builders
// =============================================================================

function buildBanner(file: ReceiptFile): string[] {
  const lines: string[] = [];
  lines.push(RULE_DOUBLE);
  // Mode-suffix on the banner so a human glancing at the terminal
  // output immediately knows whether this is a dry-run preview or
  // an applied operation. The Mode header field below carries the
  // same signal for machine readers.
  lines.push(
    file.mode === "dry_run"
      ? "VibeRevert Rollback Receipt (DRY-RUN)"
      : "VibeRevert Rollback Receipt",
  );
  lines.push(RULE_DOUBLE);
  return lines;
}

function buildHeader(file: ReceiptFile): string[] {
  const lines: string[] = [];
  lines.push(headerLine("Rollback ID", file.rollback_id));
  lines.push(headerLine("Session ID", file.session_id));
  lines.push(headerLine("Checkpoint ID", file.checkpoint_id));
  lines.push(headerLine("Mode", file.mode));
  lines.push(headerLine("Forced", String(file.forced)));
  // pre_rollback_checkpoint_id is null in dry-run mode per the
  // D69 refine; render an explicit ASCII placeholder so the human
  // reader knows the absence is intentional, not missing data.
  const preRollbackCp = file.pre_rollback_checkpoint_id ?? "(none - dry-run)";
  lines.push(headerLine("Pre-rollback CP", preRollbackCp));
  lines.push(headerLine("Dirty-tree check", file.dirty_tree_check));
  lines.push(headerLine("Written at", file.written_at));
  return lines;
}

function buildWarnings(file: ReceiptFile): string[] {
  const lines: string[] = [];
  if (file.active_session_warning === true) {
    // Wording assumes mode === "dry_run". The D69 schema refine
    // `r.active_session_warning !== true || r.mode === "dry_run"`
    // guarantees this is safe — apply mode refuses active sessions
    // outright per D63 and never produces a receipt with this
    // warning. If that refine is ever relaxed, this wording must
    // become mode-neutral.
    lines.push("[WARNING] Active session - apply mode would refuse on this session.");
  }
  if (file.un_ended_session_warning === true) {
    // Mode-neutral: un_ended_session_warning can appear on BOTH
    // dry-run receipts (informational) AND apply-with-force
    // receipts (escape hatch fired) per the D69 coupling refine.
    lines.push("[WARNING] No machine-readable after-status snapshot for this session.");
  }
  return lines;
}

function buildForcedUnrelatedDirtyPathsSection(paths: readonly string[]): string[] {
  // Section omitted entirely when empty (per layout lock above).
  if (paths.length === 0) return [];
  const lines: string[] = [];
  lines.push(RULE_SINGLE);
  lines.push(`Forced Unrelated Dirty Paths (${paths.length})`);
  lines.push(RULE_SINGLE);
  lines.push("");
  for (const path of paths) {
    lines.push(path);
  }
  return lines;
}

function buildResult(result: RollbackFileResult): string[] {
  const lines: string[] = [];
  lines.push(`${bracketToken(result.outcome)}  ${result.path}`);
  if (result.reason !== undefined && result.reason.length > 0) {
    lines.push(`  Reason: ${result.reason}`);
  }
  return lines;
}

function buildResultsSection(results: readonly RollbackFileResult[]): string[] {
  const lines: string[] = [];
  lines.push(RULE_SINGLE);
  lines.push(`Results (${results.length})`);
  lines.push(RULE_SINGLE);
  lines.push("");
  if (results.length === 0) {
    lines.push("(none)");
    return lines;
  }
  for (const [i, result] of results.entries()) {
    for (const line of buildResult(result)) {
      lines.push(line);
    }
    // Always blank-line separate consecutive entries — matches
    // buildFailuresSection and gives predictable golden output
    // regardless of whether individual entries carry a reason.
    if (i < results.length - 1) {
      lines.push("");
    }
  }
  return lines;
}

function buildFailure(failure: RollbackFailure): string[] {
  const lines: string[] = [];
  lines.push(`${bracketToken(failure.error_code)} ${failure.message}`);
  if (failure.affected_paths.length > 0) {
    lines.push("  Affected paths:");
    for (const path of failure.affected_paths) {
      lines.push(`    - ${path}`);
    }
  }
  return lines;
}

function buildFailuresSection(failures: readonly RollbackFailure[]): string[] {
  const lines: string[] = [];
  lines.push(RULE_SINGLE);
  lines.push(`Failures (${failures.length})`);
  lines.push(RULE_SINGLE);
  lines.push("");
  if (failures.length === 0) {
    lines.push("(none)");
    return lines;
  }
  for (const [i, failure] of failures.entries()) {
    for (const line of buildFailure(failure)) {
      lines.push(line);
    }
    if (i < failures.length - 1) {
      lines.push("");
    }
  }
  return lines;
}

function buildOutOfScopeSection(file: ReceiptFile): string[] {
  const lines: string[] = [];
  lines.push(RULE_SINGLE);
  lines.push("Out of Scope");
  lines.push(RULE_SINGLE);
  lines.push("");
  // Verbatim from file.out_of_scope_notice. The schema's z.literal
  // refine guarantees this equals ROLLBACK_OUT_OF_SCOPE_NOTICE from
  // @viberevert/session-format; tests should assert byte-equality
  // against that constant to lock the "renders exactly as persisted"
  // contract.
  lines.push(file.out_of_scope_notice);
  return lines;
}

// =============================================================================
// renderReceiptTerminal
// =============================================================================

/**
 * Render a `ReceiptFile` as ANSI-free plain text suitable for CLI
 * terminal output. The output is newline-terminated.
 *
 * `input.productVersion` is intentionally NOT consumed — terminal
 * output has no locked version footer (markdown owns the
 * "Generated by VibeRevert v<version>" line per D45). The field
 * remains on `ReceiptRenderInput` for API uniformity across
 * renderers; the `renderReceipt()` dispatcher passes the same
 * shape to all three.
 *
 * Pure synchronous: no I/O, no Date.now(), no Math.random(),
 * no terminal writes. Allocations are limited to local formatting
 * arrays/strings needed to build the returned output.
 *
 * The caller (CLI) is responsible for writing the returned string
 * to stdout per the D29 boundary — reporters never write to
 * terminal streams.
 */
export function renderReceiptTerminal(input: ReceiptRenderInput): string {
  const { file } = input;

  const sections: string[][] = [buildBanner(file), [""], buildHeader(file)];

  const warnings = buildWarnings(file);
  if (warnings.length > 0) {
    sections.push([""]);
    sections.push(warnings);
  }

  const forcedUnrelated = buildForcedUnrelatedDirtyPathsSection(file.forced_unrelated_dirty_paths);
  if (forcedUnrelated.length > 0) {
    sections.push([""]);
    sections.push(forcedUnrelated);
  }

  sections.push([""]);
  sections.push(buildResultsSection(file.results));
  sections.push([""]);
  sections.push(buildFailuresSection(file.failures));
  sections.push([""]);
  sections.push(buildOutOfScopeSection(file));

  return `${sections.flat().join("\n")}\n`;
}
