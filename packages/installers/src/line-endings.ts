// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Line-ending detection + normalization per D101.Q.
//
// Policy for the installer engine:
//   - New files (write-new, backup-and-write): always LF.
//   - Modifying an existing file (sentinel-block-insert / -replace,
//     json-key-merge): preserve the existing line ending IF it can be
//     cleanly detected as all-LF or all-CRLF. If mixed, lone-CR,
//     empty, or unknown: write LF.
//
// Recommended caller flow:
//   const detected = detectLineEnding(existingContent);
//   const target = detected === "CRLF" ? "CRLF" : "LF";
//   const out = normalizeToWriteFormat(newContent, target);
//
// detectLineEnding(content): "LF" | "CRLF" | "mixed-or-unknown"
//   - "LF": one or more lone \n, no \r\n, no lone \r.
//   - "CRLF": one or more \r\n, no lone \n, no lone \r.
//   - "mixed-or-unknown": any mix of \r\n + lone \n or lone \r, OR
//     content with no newlines at all (no signal to preserve).
//
// normalizeToWriteFormat(content, target): string
//   - Normalizes ALL existing line breaks (\r\n, \r, \n) to LF first,
//     then converts to the target. Lone CRs (old-Mac classic) become
//     LF or CRLF per target.
//   - Idempotent: passing already-target-formatted content returns
//     identical bytes.

// Local type aliases. Not exported: keep the public surface tight.
// The string-literal unions in the function signatures still flow
// through to callers via TypeScript inference; these names just keep
// the implementation readable.
type WriteLineEnding = "LF" | "CRLF";
type DetectedLineEnding = WriteLineEnding | "mixed-or-unknown";

/**
 * Detect the line-ending style of `content`. Returns "LF" or "CRLF"
 * only when content is purely one style; otherwise "mixed-or-unknown"
 * (mixed, lone-CR, or no newlines at all).
 */
export function detectLineEnding(content: string): DetectedLineEnding {
  let crlf = 0;
  let loneCR = 0;
  let loneLF = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === 0x0d) {
      // \r — check if followed by \n (pair) or alone (old-Mac).
      if (i + 1 < content.length && content.charCodeAt(i + 1) === 0x0a) {
        crlf++;
        i++; // skip the \n we just paired with \r
      } else {
        loneCR++;
      }
    } else if (c === 0x0a) {
      // \n not preceded by \r (those were skipped above).
      loneLF++;
    }
  }
  if (crlf > 0 && loneCR === 0 && loneLF === 0) return "CRLF";
  if (loneLF > 0 && crlf === 0 && loneCR === 0) return "LF";
  return "mixed-or-unknown";
}

/**
 * Convert `content` to the target line-ending style. All existing line
 * breaks (\r\n, \r, \n) are normalized to LF first, then converted to
 * target. Idempotent on already-target-formatted content.
 */
export function normalizeToWriteFormat(content: string, target: WriteLineEnding): string {
  // Normalize to pure LF first. Order matters: handle \r\n before
  // lone \r so we don't expand \r\n into \n\n.
  const lfOnly = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (target === "LF") return lfOnly;
  return lfOnly.replace(/\n/g, "\r\n");
}
