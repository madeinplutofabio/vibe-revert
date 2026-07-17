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
// NARROW: truncation never splits a valid pair, but sanitizeInterceptedCommandLine
// does NOT repair a pre-existing LONE surrogate (no toWellFormed / normalizer).
// The upstream FATAL UTF-8 decode (4b-iii-a) rejects malformed BYTES but does NOT
// exclude lone surrogates: a request may carry an ASCII JSON escape naming a
// surrogate, which JSON.parse turns into one. A lone surrogate in a COMMAND LINE
// therefore survives as ambiguous-but-inert text (no control/bidi hazard, and
// JSON serialization stays valid). A reported CWD is different -- it is compared
// and stored as path IDENTITY, and a real $PWD cannot contain one -- so
// resolveAuditedCwd REJECTS malformed UTF-16 outright.
//
// RESOURCE BOUND (explicit deferral): the output cap does NOT bound CPU/memory.
// This transform runs its (linear-time) regexes over the WHOLE raw input; that
// input is bounded UPSTREAM by the interception connection's wire-line cap
// (PTY_INTERCEPTION_MAX_LINE_BYTES, 64 KiB -> overflow -> connection closed ->
// the line is never parsed and never reaches this module), which is the PTY
// input-size policy. The sanitizer does not re-bound raw input.
//
// This module is PURE (no I/O -- node:path is pure path manipulation). The audit
// side-effect (ownership re-check + append) is the session-owned hook wired in
// Step 5c; this module owns only the hygiene transform, the representation, the
// untrusted-cwd validator, and the shared audit result types.

import { posix } from "node:path";

/** Default cap on the sanitized command text stored in commands.log, in Unicode
 *  code points (D104.L). */
export const PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH = 4096;

/** Max accepted length of an untrusted shell-reported cwd, in UTF-16 CODE UNITS
 *  (a cheap defensive bound; a real path is far shorter than the wire cap). */
export const PTY_INTERCEPTION_MAX_CWD_LENGTH = 4096;

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
const UNICODE_DISPLAY_CONTROL_SOURCE = String.fromCodePoint(...UNICODE_DISPLAY_CONTROL_CODE_POINTS);
// ONE source set, two regexes -- they must never drift. Global: NEUTRALIZE
// (replace) in a command line. Non-global: PROBE a path (a /g regex is stateful
// under .test()), which is REJECTED rather than rewritten -- altering a path
// would falsify it.
const UNICODE_DISPLAY_CONTROL = new RegExp(`[${UNICODE_DISPLAY_CONTROL_SOURCE}]`, "g");
const CWD_UNICODE_DISPLAY_CONTROL = new RegExp(`[${UNICODE_DISPLAY_CONTROL_SOURCE}]`);
// SECURITY floor: every remaining C0 (incl. NUL/newline/CR/tab/ESC), DEL, and C1
// control code becomes a space, so NO control code unit can survive into the log.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches C0/C1/DEL control codes to neutralize them.
const CONTROL_CODE = /[\x00-\x1f\x7f-\x9f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches C0/C1/DEL control codes to reject them in a path.
const CWD_CONTROL_CODE = /[\x00-\x1f\x7f-\x9f]/;
// U+2028/U+2029 are NOT C0/C1 yet break a single-line claim in logs. A command
// line needs no separate probe: JS \s already covers them, so WHITESPACE_RUN
// collapses them.
const CWD_LINE_SEPARATOR = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`);
const WHITESPACE_RUN = /\s+/g;

/**
 * True if `value` holds an unpaired UTF-16 surrogate. The upstream fatal UTF-8
 * decode does NOT exclude these: a hostile request may carry an ASCII JSON escape
 * naming a surrogate, which JSON.parse turns into a lone one. Walks code units --
 * authoring a \u escape here would embed a lone surrogate in this source.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++; // valid pair -- skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // low surrogate with no preceding high
    }
  }
  return false;
}

/**
 * Text that must never appear in a stored/compared path: C0/C1/DEL control codes,
 * U+2028/U+2029, bidi/directional controls, or malformed UTF-16.
 */
function hasUnsafePathText(value: string): boolean {
  return (
    CWD_CONTROL_CODE.test(value) ||
    CWD_LINE_SEPARATOR.test(value) ||
    CWD_UNICODE_DISPLAY_CONTROL.test(value) ||
    hasLoneSurrogate(value)
  );
}

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

function resolveCwdMaxLength(value: number | undefined): number {
  if (value === undefined) {
    return PTY_INTERCEPTION_MAX_CWD_LENGTH;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("resolveAuditedCwd: maxLength must be a positive safe integer");
  }
  return value;
}

export interface ResolveAuditedCwdOptions {
  /** Max reported-cwd length in UTF-16 code units. Omit for the reviewed default;
   *  an invalid explicit value THROWS (a caller bug is not shell input). */
  readonly maxLength?: number;
}

export type ResolveAuditedCwdResult =
  | { readonly ok: true; readonly repoRelCwd: string }
  | { readonly ok: false; readonly reason: "cwd_invalid" | "cwd_outside_repo" };

/**
 * Validate an UNTRUSTED shell-reported prompt-time cwd and resolve it to the
 * repo-relative POSIX form stored in commands.log -- LEXICALLY, matching how
 * `viberevert run` records cwd (run.ts) and the codebase's deliberate lexical
 * repo-boundary policy.
 *
 * SCOPE OF THE CLAIM: this proves the LOGICAL shell cwd lies LEXICALLY under the
 * LOGICAL repoRoot. It is NOT a physical filesystem-boundary guarantee (symlinks
 * are not resolved) and MUST NOT be reused for access control without stronger
 * validation.
 *
 * TRUSTED config (repoRoot / maxLength) THROWS -- our bug, surfaced through the
 * service's gate catch as audit_hook_threw, never blamed on the shell. UNTRUSTED
 * input returns: cwd_invalid (empty, over the code-unit bound, any C0/C1/DEL,
 * U+2028/9, bidi control, malformed UTF-16, a non-absolute POSIX path, or a
 * resulting REPO-RELATIVE cwd containing a literal backslash -- legal in a POSIX
 * filename but unrepresentable in the locked forward-slash-only commands.log
 * path domain, D102.F); cwd_outside_repo (lexically `..`, under `../`, or a
 * different absolute root). Containment is decided BEFORE representability, so
 * a path outside the repo is never mislabeled cwd_invalid. On success returns
 * the normalized repo-relative POSIX cwd ("." for the repo root). NEVER
 * substitutes another directory.
 */
export function resolveAuditedCwd(
  reportedCwd: string,
  repoRoot: string,
  options: ResolveAuditedCwdOptions = {},
): ResolveAuditedCwdResult {
  const maxLength = resolveCwdMaxLength(options.maxLength);

  // TRUSTED: a bad root is OUR bug. Bash-only PTY => the root must be POSIX so
  // posix.relative compares ONE path domain (a Windows "C:\..." root against a
  // bash "/c/..." cwd would silently compare incompatible namespaces).
  if (!posix.isAbsolute(repoRoot) || hasUnsafePathText(repoRoot)) {
    throw new TypeError("resolveAuditedCwd: repoRoot must be a safe absolute POSIX path");
  }

  // UNTRUSTED protocol data from the shell.
  if (reportedCwd.length === 0 || reportedCwd.length > maxLength) {
    return { ok: false, reason: "cwd_invalid" };
  }
  if (hasUnsafePathText(reportedCwd) || !posix.isAbsolute(reportedCwd)) {
    return { ok: false, reason: "cwd_invalid" };
  }

  const rel = posix.relative(repoRoot, reportedCwd);
  if (posix.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    return { ok: false, reason: "cwd_outside_repo" };
  }
  const repoRelCwd = rel === "" ? "." : rel;

  // REPRESENTABILITY (D102.F): commands.log stores the canonical repo-relative
  // cwd, not the shell's absolute path. Core's appendCommandsLogEntry REJECTS a
  // backslash in that stored value -- on Windows a backslash is a separator
  // producers normalize away, so a stored one would be ambiguous (separator or
  // filename byte?). A literal backslash is LEGAL in a POSIX filename but
  // deliberately unsupported by that cross-platform representation. Reject it
  // only when it SURVIVES into the stored value: a backslash in a shared
  // absolute repo-root prefix is irrelevant because relativization removes it.
  // Rejecting here -- before any ownership or storage work -- gives the honest
  // reason (cwd_invalid) instead of a misleading append_failed from core.
  // Validate exactly the string that would be persisted, not `rel`.
  if (repoRelCwd.includes("\\")) {
    return { ok: false, reason: "cwd_invalid" };
  }

  return { ok: true, repoRelCwd };
}

/**
 * Why an accepted command's audit prerequisite failed. Internally distinct
 * (ownership-loss vs cwd vs append) even though all map to the SAME wire
 * behavior: the service sends no allow frame and closes (fail-closed, D104.J).
 */
export type AuditAcceptedCommandFailureReason =
  | "session_missing"
  | "session_changed"
  | "session_read_failed"
  | "append_failed"
  | "cwd_invalid"
  | "cwd_outside_repo";

/** Result of the accepted-command audit gate (Steps 5b/5c). */
export type AuditAcceptedCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AuditAcceptedCommandFailureReason };

/**
 * The per-command audit input: the intercepted line PLUS the untrusted prompt-
 * time working directory the hook captured with it, bound in the SAME nonce/id
 * request (an interactive shell can `cd`, so the session's initial directory
 * would be a false record).
 */
export interface AcceptedCommandAuditInput {
  readonly rawLine: string;
  readonly cwd: string;
}

/**
 * The REQUIRED parent-side gate the interception service runs on EVERY allow
 * before emitting the allow frame. Receives the RAW line + untrusted prompt-time
 * cwd and sanitizes/validates internally; `ok:false` => the service sends NO
 * allow frame (fail-closed).
 */
export type AuditAcceptedCommand = (
  input: AcceptedCommandAuditInput,
) => Promise<AuditAcceptedCommandResult>;
