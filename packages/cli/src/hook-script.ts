// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook script template + identification constants for M F's `viberevert hook
 * install` / `viberevert hook uninstall`. Pure constants + one pure function.
 * No I/O, no @viberevert/* runtime imports, no clock/random reads.
 *
 * Architectural locks (see docs/hook-contract.md and the M F plan):
 *
 *  1. ASCII-only at byte level (D98.M.4 + D98.M.13). Every byte in this file
 *     has value < 128. No em-dashes, smart quotes, arrows, ellipsis, etc.
 *     anywhere -- string literals, comments, JSDoc, identifiers, or escape
 *     sequences that would resolve to non-ASCII chars. Cross-platform script-
 *     encoding lessons from M E em-dash cleanup apply.
 *
 *  2. HOOK_SCRIPT_TEMPLATE construction (D98.M.14). Built via
 *     `[...lines].join("\n") + "\n"`, NOT a raw multi-line template literal
 *     assigned to HOOK_SCRIPT_TEMPLATE. A raw template literal would pass the
 *     no-CR + trailing-LF unit tests on an LF checkout but silently introduce
 *     CRLF on a CRLF checkout (Windows + git autocrlf=true). The array-join
 *     construction is platform-immune. (Backticks INSIDE individual array
 *     elements are fine -- D98.M.14 grep targets only the
 *     `HOOK_SCRIPT_TEMPLATE = <backtick>` assignment pattern.)
 *
 *  3. Marker is version-free (D98.G). MANAGED_BY_MARKER does NOT embed a
 *     version number. Rationale: hook uninstall in v0.7.5 must recognize hooks
 *     installed by v0.7.0. If versioned identification is ever needed, it
 *     lands as a SECOND marker line AFTER this one; the v0.7-line marker
 *     stays stable for backward recognition.
 *
 *  4. BACKUP_FILE_PREFIX is a basename (D98.H), not a path. Install joins
 *     with hooksDir; uninstall scans readdir entries which are basenames.
 *
 *  5. BACKUP_FILE_REGEX is strict (D98.H). Only timestamp-shaped suffixes
 *     match. Prevents `pre-commit.viberevert-backup-z-danger` from being
 *     selected as "latest" backup during uninstall --restore.
 *
 *  6. formatBackupTimestamp takes Date as parameter (D49 determinism).
 *     Callers source the date via runtime-env.ts resolveNowForCliTimestamp
 *     which honors VIBEREVERT_TEST_FIXED_NOW for deterministic test runs.
 *
 *  7. No node:fs, no @viberevert/* runtime imports (D98.M.5). This is a
 *     pure constants + pure function module.
 *
 *  8. The hook body intentionally contains literal backslash-backtick
 *     sequences in the tip line (POSIX sh inside a double-quoted string uses
 *     backslash-backtick to emit a literal backtick that doesn't trigger
 *     command substitution). Those are TS source escapes; the rendered hook
 *     line is the shell text shown verbatim in D98.U.
 */

/**
 * Version-free identification marker (D98.G). Embedded on line 2 of every
 * viberevert-managed pre-commit hook.
 *
 * Marker verification rules (D98.A11):
 *  - Marker check applies only to regular files (lstat isFile() === true).
 *  - Line 2 of the hook content (split on "\n") must EXACTLY equal this
 *    constant, OR equal this constant + "\r" (narrow CRLF tolerance for
 *    CRLF-drifted hooks; D98.A11 then refreshes them to canonical LF).
 *  - NOT content.includes(MARKER). NOT a prefix check.
 */
export const MANAGED_BY_MARKER =
  "# managed-by: viberevert (https://github.com/madeinplutofabio/vibe-revert)";

/**
 * Basename prefix for --force backup files (D98.H). Install joins with
 * hooksDir to produce the full backup path; uninstall --restore filters
 * readdir entries against BACKUP_FILE_REGEX.
 */
export const BACKUP_FILE_PREFIX = "pre-commit.viberevert-backup-";

/**
 * Strict regex matching `pre-commit.viberevert-backup-YYYYMMDDTHHMMSSZ`
 * basenames. Used by uninstall --restore to filter readdir results to actual
 * backup candidates; malformed names (suffix injection, partial timestamp,
 * etc.) are silently excluded.
 */
export const BACKUP_FILE_REGEX = /^pre-commit\.viberevert-backup-\d{8}T\d{6}Z$/;

/**
 * Pure function producing `YYYYMMDDTHHMMSSZ` (UTC, colon-free, filesystem-safe,
 * lexicographically sortable equals chronologically sortable).
 *
 * Takes Date as parameter for testability (D49). Callers in hook-install.ts
 * source the date via runtime-env.ts resolveNowForCliTimestamp which honors
 * VIBEREVERT_TEST_FIXED_NOW.
 */
export function formatBackupTimestamp(date: Date): string {
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  const pad4 = (n: number): string => n.toString().padStart(4, "0");
  const yyyy = pad4(date.getUTCFullYear());
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

/**
 * The exact POSIX sh body written to .git/hooks/pre-commit by `hook install`.
 * Constructed via [...lines].join("\n") + "\n" per D98.M.14.
 *
 * Locked body content per D98.U:
 *  - Line 1: shebang.
 *  - Line 2: MANAGED_BY_MARKER (D98.A11 identification line).
 *  - Comment block: exit-code semantics, --no-verify bypass, uninstall
 *    command, risk.block_on config reference.
 *  - Logic: viberevert check --staged ; capture exit ; if exit 2 print tip and
 *    exit 1 ; otherwise exit with check's exit code.
 *
 * NO `set -e` -- D98.U lock. set -e would short-circuit before EC=$? captures
 * the exit code, breaking the conditional tip-print branch.
 *
 * Quoted "$EC" for sh-flavor portability (dash, ash, busybox sh).
 *
 * The tip-line backtick escapes: the TS source `\\\`` produces the two-char
 * sequence backslash + backtick, which in POSIX sh inside a double-quoted
 * string is the standard way to embed a literal backtick (sh would otherwise
 * treat unquoted backticks as command substitution). The rendered hook line
 * is exactly the shell text shown verbatim in D98.U.
 */
const HOOK_SCRIPT_LINES: readonly string[] = [
  "#!/bin/sh",
  MANAGED_BY_MARKER,
  "#",
  "# This pre-commit hook runs `viberevert check --staged` on every commit.",
  "# Exit code 0 allows the commit.",
  "# Exit code 2 aborts the commit and prints a prompt-fix tip.",
  "# Exit code 1 aborts the commit without a prompt-fix tip because check itself failed.",
  "#",
  "# To bypass this hook for a single commit:",
  "#   git commit --no-verify",
  "#",
  "# To remove this hook:",
  "#   viberevert hook uninstall",
  "#",
  "# vibe-revert respects your .viberevert.yml configuration. Adjust the",
  "# `risk.block_on` threshold there (default: critical) to control what",
  "# severity of findings aborts the commit.",
  "",
  "viberevert check --staged",
  "EC=$?",
  "",
  'if [ "$EC" -eq 2 ]; then',
  '  echo "" >&2',
  `  echo "Tip: run \\\`viberevert prompt-fix\\\` to generate a fix-prompt for your coding agent." >&2`,
  "  exit 1",
  "fi",
  "",
  'exit "$EC"',
];

// biome-ignore lint/style/useTemplate: D98.M.14 forbids HOOK_SCRIPT_TEMPLATE = backtick template literal assignment; string concatenation is the locked construction pattern. The unit tests verify the resulting behavior (no CR, exactly one trailing LF).
export const HOOK_SCRIPT_TEMPLATE: string = HOOK_SCRIPT_LINES.join("\n") + "\n";
