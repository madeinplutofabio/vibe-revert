// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Sentinel-block helpers for text files modified by `@viberevert/installers`.
 *
 * A sentinel block is a span of text enclosed by two marker lines:
 *
 *   # viberevert:begin:<blockId>
 *   <user content written by VibeRevert>
 *   # viberevert:end:<blockId>
 *
 * Markers MUST sit on their own lines (LF-delimited; CRLF normalization is
 * the installer's responsibility per D101.Q). The `blockId` is adapter-
 * namespaced (e.g. `cursor-mcp-server`, `husky-pre-commit`,
 * `github-action-workflow`) to prevent false-positive collisions with
 * unrelated user content.
 *
 * These helpers are PURE: no filesystem access; no global state. The
 * installer engine (`@viberevert/installers`) reads host file bytes,
 * passes them through these helpers, and writes the result atomically.
 *
 * Per D101.A, this module lives in `@viberevert/adapters` and is exposed
 * via the package barrel; both adapters and installers consume it.
 */

export const SENTINEL_BEGIN_PREFIX = "# viberevert:begin:";
export const SENTINEL_END_PREFIX = "# viberevert:end:";

/**
 * Where to insert a new sentinel block when the target file does not yet
 * contain a block with the given `blockId`. (When a block IS already
 * present, the anchor is ignored and the existing block's content is
 * replaced in place by `replaceOrAppendSentinelBlock`.)
 */
export type SentinelAnchor =
  | { readonly mode: "append" }
  | { readonly mode: "after-marker"; readonly marker: string };

/**
 * Render a sentinel block as a self-contained string. Output shape:
 *
 *   # viberevert:begin:<blockId>
 *   <content>
 *   # viberevert:end:<blockId>
 *
 * Trailing newlines in `content` are normalized to exactly one separator
 * before the END marker. The rendered block itself ends with a trailing
 * newline.
 */
export function renderSentinelBlock(blockId: string, content: string): string {
  const normalizedContent = content.replace(/\n+$/, "");
  return `${SENTINEL_BEGIN_PREFIX}${blockId}\n${normalizedContent}\n${SENTINEL_END_PREFIX}${blockId}\n`;
}

/**
 * Locate a sentinel block by `blockId` in `haystack`. Returns:
 *
 *   - `start` / `end`: string indices covering the full block (BEGIN
 *     marker line through END marker line, inclusive of the END marker's
 *     trailing newline if present). `haystack.slice(start, end)` gives the
 *     full removable region.
 *   - `content`: the bytes between the markers (excluding both marker lines
 *     and the single newline separators that hug them).
 *
 * Returns `null` if no block with `blockId` is found, OR if an orphan
 * BEGIN marker exists without a matching END marker (or vice versa) --
 * orphan markers are silently treated as "not our sentinel" to keep
 * removal idempotent and to avoid mangling user content that happens to
 * contain a stray marker-shaped line.
 */
export function findSentinelBlock(
  haystack: string,
  blockId: string,
): { readonly start: number; readonly end: number; readonly content: string } | null {
  const beginLine = `${SENTINEL_BEGIN_PREFIX}${blockId}`;
  const endLine = `${SENTINEL_END_PREFIX}${blockId}`;
  const beginIdx = findWholeLine(haystack, beginLine);
  if (beginIdx < 0) return null;
  const beginLineEnd = beginIdx + beginLine.length;
  const endIdx = findWholeLine(haystack, endLine, beginLineEnd);
  if (endIdx < 0) return null;
  const contentStart = beginLineEnd + 1; // skip the newline after the BEGIN marker
  const contentRaw = haystack.slice(contentStart, endIdx);
  const content = contentRaw.endsWith("\n") ? contentRaw.slice(0, -1) : contentRaw;
  const blockEnd = endIdx + endLine.length;
  const blockEndInclusive = haystack[blockEnd] === "\n" ? blockEnd + 1 : blockEnd;
  return { start: beginIdx, end: blockEndInclusive, content };
}

/**
 * Replace the content of an existing sentinel block, OR insert a new
 * sentinel block per `anchor` if none exists with the given `blockId`.
 *
 * When `anchor.mode === "after-marker"` and the marker line is not found
 * in `existing`, the new block is appended at the end (the helper never
 * throws; the adapter is expected to refuse upstream when an expected
 * marker is absent, per D101.A `RefusedPlan` semantics).
 */
export function replaceOrAppendSentinelBlock(
  existing: string,
  blockId: string,
  content: string,
  anchor: SentinelAnchor,
): string {
  const found = findSentinelBlock(existing, blockId);
  const renderedBlock = renderSentinelBlock(blockId, content);
  if (found !== null) {
    return existing.slice(0, found.start) + renderedBlock + existing.slice(found.end);
  }
  if (anchor.mode === "after-marker") {
    const markerIdx = findWholeLine(existing, anchor.marker);
    if (markerIdx >= 0) {
      const markerLineEnd = existing.indexOf("\n", markerIdx);
      const insertAt = markerLineEnd < 0 ? existing.length : markerLineEnd + 1;
      return existing.slice(0, insertAt) + renderedBlock + existing.slice(insertAt);
    }
  }
  if (existing.length === 0) return renderedBlock;
  return existing.endsWith("\n") ? existing + renderedBlock : `${existing}\n${renderedBlock}`;
}

/**
 * Remove a sentinel block by `blockId`. Returns `existing` unchanged if no
 * matching block is present (idempotent uninstall).
 */
export function removeSentinelBlock(existing: string, blockId: string): string {
  const found = findSentinelBlock(existing, blockId);
  if (found === null) return existing;
  return existing.slice(0, found.start) + existing.slice(found.end);
}

/**
 * Find the string index where a whole line equal to `line` begins. A
 * "whole line" is delimited by `\n` or string boundaries -- a marker-
 * shaped substring appearing inside a longer line is NOT a match.
 *
 * Internal helper; not exported.
 */
function findWholeLine(haystack: string, line: string, fromIndex = 0): number {
  let searchFrom = fromIndex;
  while (searchFrom <= haystack.length) {
    const idx = haystack.indexOf(line, searchFrom);
    if (idx < 0) return -1;
    const before = idx === 0 || haystack[idx - 1] === "\n";
    const afterIdx = idx + line.length;
    const after = afterIdx === haystack.length || haystack[afterIdx] === "\n";
    if (before && after) return idx;
    searchFrom = idx + 1;
  }
  return -1;
}
