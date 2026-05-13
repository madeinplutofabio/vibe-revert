// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Display-formatting helpers for the CLI's listing commands.
//
// NOT exported from any public CLI surface. NOT registered as a
// command. Consumed by `commands/checkpoints.ts` and
// `commands/sessions.ts` for HUMAN-mode column rendering only.
//
// **Critical rule: --json output MUST bypass these helpers.** D20
// locks the JSON shape as full values, with `null` for missing
// fields, and full IDs / full SHAs / untruncated task strings. Any
// truncation in the JSON path would silently break downstream tools
// that depend on the contract. The two listing commands branch on
// `--json` BEFORE reaching the formatters; this file's helpers are
// strictly the human-format side of that branch.
//
// Each helper encodes a locked plan decision:
//   - `truncateIdForDisplay`: D5 ("Display: Human-facing tables
//     truncate to first ~14 chars after the prefix") + D12.
//   - `truncateShaForDisplay`: D12 ("HEAD_SHA truncated to 7 chars
//     (matches `git log --oneline`)").
//   - `truncateTaskForDisplay`: D18 (fixed 48-char max with ellipsis;
//     `-` for absent task per D12's "TASK is truncated... `-` if no
//     task" rule).
//
// All helpers are pure: same input → same output, no I/O, no
// terminal awareness. Trivially unit-testable in `format.test.ts`.

/**
 * Truncate a `<prefix>_<ULID>` id to its display form for human-mode
 * tables. Returns the prefix-and-underscore plus the first 14 chars
 * of the ULID body — e.g.,
 *   `"cp_01JV8Y7W2M7ABCDEFGHJKMNPQR"` → `"cp_01JV8Y7W2M7ABC"`
 *   `"sess_01JV8Z0N6E7ABCDEFGHJKMNPQR"` → `"sess_01JV8Z0N6E7ABC"`
 *
 * Defensive on shape: if the input has no underscore separator, the
 * input is returned unchanged (rather than slicing the first 14 chars
 * blindly). If the post-prefix portion is shorter than 14 chars, the
 * full input is returned (slice past end is a no-op).
 *
 * **NEVER use this for --json output** — D20 requires full prefixed
 * IDs.
 */
export function truncateIdForDisplay(prefixedId: string): string {
  const sepIdx = prefixedId.indexOf("_");
  if (sepIdx === -1) return prefixedId;
  return prefixedId.slice(0, sepIdx + 1 + 14);
}

/**
 * Truncate a Git SHA (SHA-1 or SHA-256) to 7 chars for human-mode
 * tables — matches the convention used by `git log --oneline` and
 * locked by D12 for the `viberevert checkpoints` HEAD_SHA column.
 *
 * Inputs shorter than 7 chars are returned unchanged (slice past end).
 *
 * **NEVER use this for --json output** — D20 requires full SHAs.
 */
export function truncateShaForDisplay(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Truncate a task description for the `viberevert sessions` TASK
 * column. Locked rules per D12 + D18:
 *   - `null` / `undefined` → `"-"` (D12: "`-` if no task").
 *   - String of 48 chars or fewer → returned unchanged.
 *   - Longer → first 47 chars + `…` (single horizontal-ellipsis
 *     character `U+2026`), totalling 48 display chars (D18: "fixed
 *     maximum of 48 characters with an ellipsis").
 *
 * Note on Unicode: `slice(0, 47)` operates on UTF-16 code units, not
 * graphemes. A multi-byte / surrogate-pair character at position 46
 * could theoretically be split. Acceptable for M B — task strings are
 * typically ASCII, and the only consequence of a split surrogate is
 * a single replacement-character glyph (`�`) at the truncation
 * boundary, not a crash or schema violation.
 *
 * **NEVER use this for --json output** — D20 requires the full task
 * string or `null`, never `"-"` and never truncated.
 */
export function truncateTaskForDisplay(task: string | null | undefined): string {
  if (task === null || task === undefined) return "-";
  if (task.length <= 48) return task;
  return `${task.slice(0, 47)}…`;
}
