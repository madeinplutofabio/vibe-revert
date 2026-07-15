// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M G4 Step 5a -- PTY interception audit hygiene + representation (D104.H / D104.L).
//
// When the parent ALLOWS an intercepted prompt line it records ONE commands.log
// entry BEFORE the shell executes the command (D104.F, mirroring the REPL). The
// intercepted line is a RAW terminal line -- it may carry ANSI/OSC escape
// sequences, C0/C1 control codes, Unicode bidirectional display controls,
// embedded newlines, or a giant pasted blob. commands.log is an operational
// audit log that other tooling (`viberevert check`/`report`, or a plain `cat`)
// may PARSE and PRINT, so the stored value must be display-safe and bounded
// (D104.L):
//   - a single line;
//   - no terminal-control content (ANSI/OSC stripped; every C0/C1/DEL control
//     code neutralized) -- printable text cannot rewrite a viewer's terminal;
//   - no Unicode bidi/directional controls -- they cannot visually REORDER the
//     entry (Trojan-Source-style spoofing) when printed;
//   - length-capped -- the COMPLETE stored string (truncation marker included)
//     never exceeds the configured cap, measured in Unicode code points so
//     truncation never SPLITS a valid surrogate pair;
//   - non-empty -- an empty OR control-only line records NOTHING; the caller
//     still allows execution but skips the append, preserving core's non-empty
//     argv[0] contract.
//
// The RAW line is kept only transiently for policy evaluation; only the
// SANITIZED form (D104.H representation `[auditedLine]`) reaches commands.log.
// JSON escaping protects the file bytes but NOT a consumer that parses the JSON
// and prints the string, which is why sanitization happens here, before storage.
//
// These are JavaScript strings (UTF-16 code units), not byte arrays: the
// security claim is that no control CODE UNIT and no bidi control survives, and
// that lengths are counted in Unicode code points. The surrogate guarantee is
// NARROW: truncation never splits a valid pair, but this module does NOT repair
// a pre-existing LONE surrogate in malformed input (no toWellFormed / custom
// normalizer here). It relies on the upstream FATAL UTF-8 decode at the
// interception connection (4b-iii-a) -- which rejects malformed bytes rather
// than emitting lone surrogates -- so a lone surrogate cannot reach the real
// PTY path.
//
// RESOURCE BOUND (explicit deferral): the output cap does NOT bound CPU/memory.
// This transform runs its (linear-time) regexes over the WHOLE raw input; that
// input is bounded UPSTREAM by the interception connection's wire-line cap
// (PTY_INTERCEPTION_MAX_LINE_BYTES, 64 KiB -> overflow -> connection closed ->
// the line is never parsed and never reaches this module), which is the PTY
// input-size policy. The sanitizer does not re-bound raw input.
//
// This module is PURE (no I/O). The audit side-effect (ownership re-check +
// append) is the session-owned hook wired in Step 5c; this module owns only the
// hygiene transform, the representation, and the shared audit result types.

/** Default cap on the sanitized command text stored in commands.log, in Unicode
 *  code points (D104.L). */
export const PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH = 4096;

// Terminal escape SEQUENCES whose tails are printable -- stripped in full so a
// bare "[2J" / "31m" tail cannot survive once the ESC code itself is neutralized.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches the ESC control code to strip CSI sequences.
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches ESC/BEL to strip OSC sequences.
const OSC_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// Unicode bidirectional / directional display controls (U+061C, U+200E/F,
// U+202A-E, U+2066-9): not terminal escapes, but they can visually REORDER an
// audit entry (Trojan-Source style) when printed -- neutralize them too. Built
// from numeric code points so NO literal bidi character (and no fragile \u
// escape) sits in this source file -- an anti-spoofing guard must not itself be
// a spoofing vector. None of these code points is a char-class metacharacter, so
// embedding them directly needs no escaping.
const UNICODE_DISPLAY_CONTROL_CODE_POINTS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
] as const;
const UNICODE_DISPLAY_CONTROL = new RegExp(
  `[${String.fromCodePoint(...UNICODE_DISPLAY_CONTROL_CODE_POINTS)}]`,
  "g",
);
// SECURITY floor: every remaining C0 (incl. NUL/newline/CR/tab/ESC), DEL, and C1
// control code becomes a space, so NO control code unit can survive into the log.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches C0/C1/DEL control codes to neutralize them.
const CONTROL_CODE = /[\x00-\x1f\x7f-\x9f]/g;
const WHITESPACE_RUN = /\s+/g;

export interface SanitizeInterceptedCommandLineOptions {
  /** Max length (Unicode code points) of the COMPLETE result, truncation marker
   *  included. Omit for the reviewed default; an invalid explicit value throws. */
  readonly maxLength?: number;
}

function resolveMaxLength(value: number | undefined): number {
  if (value === undefined) {
    return PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      "sanitizeInterceptedCommandLine: maxLength must be a positive safe integer",
    );
  }
  return value;
}

/**
 * Truncate to `maxLength` Unicode code points INCLUDING the truncation marker.
 * Lengths and slicing are code-point based (Array.from), so a VALID surrogate
 * pair is never split (a pre-existing lone surrogate is passed through, not
 * repaired -- see the module header). The marker length depends on the dropped
 * count, which depends on how much is retained, so iterate until the retained/
 * marker split stabilizes (the retained length is monotonically non-increasing,
 * so this converges).
 */
function truncateWithMarker(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) {
    return value;
  }
  let retained = maxLength;
  while (retained > 0) {
    const dropped = chars.length - retained;
    const marker = ` …[+${dropped} chars]`;
    const nextRetained = Math.max(0, maxLength - Array.from(marker).length);
    if (nextRetained === retained) {
      return `${chars.slice(0, retained).join("")}${marker}`;
    }
    retained = nextRetained;
  }
  // Cap too small to hold even the marker: preserve the hard bound over the marker.
  return Array.from("…").slice(0, maxLength).join("");
}

/**
 * Reduce a raw intercepted prompt line to a single-line, control-free,
 * length-bounded string safe to store in and later print from commands.log.
 * Returns `""` when nothing meaningful remains (empty OR control-only line) --
 * the caller then allows the command WITHOUT recording an entry.
 *
 * Best-effort for exotic escapes, but GUARANTEES no C0/C1/DEL control code, no
 * embedded newline, and no Unicode bidi control survives, and that the complete
 * result never exceeds `maxLength` Unicode code points.
 */
export function sanitizeInterceptedCommandLine(
  rawLine: string,
  options: SanitizeInterceptedCommandLineOptions = {},
): string {
  const maxLength = resolveMaxLength(options.maxLength);
  const collapsed = rawLine
    .replace(CSI_SEQUENCE, "")
    .replace(OSC_SEQUENCE, "")
    .replace(UNICODE_DISPLAY_CONTROL, " ")
    .replace(CONTROL_CODE, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim();
  if (collapsed === "") {
    return "";
  }
  return truncateWithMarker(collapsed, maxLength);
}

/**
 * D104.H representation of an accepted PTY command for commands.log: the
 * sanitized line as a single synthetic argv element. Returns `null` when the
 * line has no meaningful text (empty OR control-only) -- caller skips the append.
 */
export function buildAuditedCommandArgv(
  rawLine: string,
  options?: SanitizeInterceptedCommandLineOptions,
): readonly [string] | null {
  const auditedLine = sanitizeInterceptedCommandLine(rawLine, options);
  return auditedLine === "" ? null : [auditedLine];
}

/**
 * Why an accepted command's audit prerequisite failed. Internally distinct
 * (ownership-loss vs append) even though all map to the SAME wire behavior:
 * the service sends no allow frame and closes (fail-closed, D104.J).
 */
export type AuditAcceptedCommandFailureReason =
  | "session_missing"
  | "session_changed"
  | "session_read_failed"
  | "append_failed";

/** Result of the accepted-command audit gate (Steps 5b/5c). */
export type AuditAcceptedCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AuditAcceptedCommandFailureReason };

/**
 * The REQUIRED parent-side gate the interception service runs on EVERY allow
 * before emitting the allow frame. Receives the RAW line and sanitizes
 * internally; `ok:false` => the service sends NO allow frame (fail-closed).
 */
export type AuditAcceptedCommand = (rawLine: string) => Promise<AuditAcceptedCommandResult>;
