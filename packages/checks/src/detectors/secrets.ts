// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Secret-detection scanner (Step 4 file 2). Pure synchronous Check
// implementation. Reads the locked pattern set + constants from
// ./secrets-patterns.js and scans the added-line content of every
// ChangedFileInput in CheckContext.
//
// =============================================================================
// ARCHITECTURE
// =============================================================================
// Per-file flow inside secretsCheck.run:
//   1. Skip binary files (no content to scan).
//   2. Skip files with empty addedLines (no diff content).
//   3. Normalize file.path ONCE via normalizePathSeparators (shared
//      helper from ../path-normalization.js), and use the normalized
//      value EVERYWHERE downstream:
//        - picomatch suppression matching (`matchSuppressedFile`),
//        - emitted `evidence[0].file` (M B's EvidenceSchema validates
//          via `safeStoredRelativePath` which requires forward slashes),
//        - user-facing message template.
//      Single source of truth for "what path is this finding about"
//      keeps the suppression decision, the schema-validated emission,
//      and the human-readable message consistent. Although the
//      ChangedFileInput.path contract is "canonical repo-relative
//      POSIX" (per D32/D56) and the CLI's diff-parser always supplies
//      POSIX paths from git, the defensive normalization here ensures
//      the detector remains robust to any future caller (MCP adapter,
//      test fixture, etc.) that might supply a Windows-style path.
//   4. For each pattern in SECRET_PATTERNS:
//      a. Choose scan strategy: PEM (pattern.id === "pem-private-key")
//         scans contiguous-line runs as concatenated blobs;
//         everything else scans per-line.
//      b. For each hit:
//         - If pattern.entropyCheck: run passesEntropyCheck on the
//           value-group match. If FAIL → DROP ENTIRELY (no audit
//           trail). This is the entropy/placeholder suppression
//           channel per D33.
//         - Bump per-(file, pattern) occurrence counter (satisfies
//           D40's detector-side uniqueness rule for multi-finding-
//           per-file detectors).
//         - If file matches SUPPRESSION_FILE_PATTERNS OR the hit's
//           pre-computed `lineIsSuppressed` flag is true → emit at
//           level "low" (preserves audit trail). Otherwise → emit
//           at level "critical".
//         - Confidence: "medium" for env-style-assignment
//           (heuristic even after entropy filtering); "high" for
//           prefix/context patterns.
//         - Evidence detail: "<label> [occurrence N, col C]". NEVER
//           the raw secret value (D40 redaction-safety lock).
//
// =============================================================================
// SUPPRESSION ORDER (locked)
// =============================================================================
// Two channels with DIFFERENT semantics:
//
//   A. ENTROPY / PLACEHOLDER (pattern #7 only): DROPS the match
//      entirely. No finding emitted. No audit trail. Applied FIRST,
//      before any other suppression check. Intent: filter regex
//      false-positives on placeholder values like `STRIPE_SECRET=changeme`.
//
//   B. FILE / LINE SUPPRESSION: DOWNGRADES the finding to level
//      "low" (still emitted for audit). Applied AFTER the entropy
//      gate. Intent: let developers commit intentional test-fixture
//      secrets without tripping the gate, while preserving the audit
//      record.
//
// Order matters: applying suppression A first means a placeholder
// value never even gets counted as an occurrence. A real-looking
// value in a suppressed file IS counted and emitted at "low".
//
// =============================================================================
// PEM MULTI-LINE HANDLING (locked)
// =============================================================================
// Pattern #6's regex contains `[\s\S]*?` and matches across newlines.
// Per-line scanning would miss any PEM block whose BEGIN and END
// markers fall on different addedLines entries.
//
// CRITICAL: the scan groups addedLines into CONTIGUOUS line-number
// runs and scans each run as its own blob. NEVER concatenates all
// addedLines into one blob: doing so would invent false PEM matches
// across unrelated diff hunks (e.g., a BEGIN marker added at line 10
// of one hunk + an END marker added at line 80 of an unrelated hunk
// would falsely look like a single PEM block).
//
// Within each contiguous group, matches' string offsets (UTF-16 code
// units, NOT bytes — JS string operations are UTF-16-based) are
// mapped back to original line numbers via a precomputed lineOffsets
// array.
//
// CROSS-LINE INLINE SUPPRESSION: for multi-line matches, the scan
// layer determines the START line index AND the END line index of the
// match span, then sets `lineIsSuppressed` = true if ANY line in
// [startLineIdx, endLineIdx] contains an inline suppression marker.
// This means a `// viberevert-allow` marker on the END line of a PEM
// block correctly downgrades the finding to "low" — not only markers
// on the BEGIN line. Conventional placement (start vs end) varies by
// developer style; both must work.
//
// =============================================================================
// MODULE-LOAD INVARIANTS (fail-closed)
// =============================================================================
// Two invariants verified at module load:
//   1. Every pattern carries the /g flag. Required for matchAll
//      iteration; a missing /g would make matchAll throw at runtime,
//      surfacing the bug only when that pattern actually matched.
//      Module-load check surfaces it AT IMPORT, before any scan runs.
//   2. Every pattern id is unique. The per-(file, pattern) occurrence
//      counter uses pattern.id as a key; duplicates would silently
//      collide and skip occurrence-uniqueness.
// Both throw with a diagnostic naming the offending pattern(s).
//
// =============================================================================
// GLOBAL REGEXP STATE — CLONE DISCIPLINE
// =============================================================================
// SECRET_PATTERNS contains SHARED MUTABLE RegExp instances under /g.
// Per ECMA-262 §22.2.5.10 (documented exhaustively in
// secrets-patterns.ts's CRITICAL block), calling matchAll directly on
// a shared regex seeds the iterator from the regex's current
// lastIndex. The clone-first discipline is the only safe pattern.
//
// EVERY scan path in this file MUST go through cloneRegex(). Both
// scanPerLine AND scanMultiLine. Future contributors editing this
// file: do NOT bypass cloneRegex on any shared SECRET_PATTERNS
// entry.

import picomatch from "picomatch";

import { normalizePathSeparators } from "../path-normalization.js";
import type {
  Check,
  CheckContext,
  CheckResult,
  Confidence,
  LineChunk,
  RiskLevel,
} from "../types.js";
import {
  ENTROPY_THRESHOLD,
  INLINE_SUPPRESSION_MARKERS,
  MIN_SECRET_LENGTH,
  PLACEHOLDER_VALUES,
  SECRET_PATTERNS,
  type SecretPattern,
  SUPPRESSION_FILE_PATTERNS,
} from "./secrets-patterns.js";

// =============================================================================
// Module-load invariants (fail-closed)
// =============================================================================

// Invariant 1: every pattern carries /g. Required for matchAll
// iteration. Without /g, matchAll throws at runtime; this surfaces
// the violation at import time instead, with a precise diagnostic.
const NON_GLOBAL_PATTERN_IDS: readonly string[] = SECRET_PATTERNS.filter(
  (p) => !p.regex.global,
).map((p) => p.id);
if (NON_GLOBAL_PATTERN_IDS.length > 0) {
  throw new Error(
    `SECRET_PATTERNS contains entries missing the /g flag (required for matchAll iteration): ${NON_GLOBAL_PATTERN_IDS.join(", ")}`,
  );
}

// Invariant 2: every pattern id is unique. The per-(file, pattern)
// occurrence counter uses pattern.id as a key; duplicates would
// collide and skip occurrence-uniqueness.
const DUPLICATE_PATTERN_IDS: readonly string[] = (() => {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const p of SECRET_PATTERNS) {
    if (seen.has(p.id)) dups.add(p.id);
    else seen.add(p.id);
  }
  return [...dups].sort();
})();
if (DUPLICATE_PATTERN_IDS.length > 0) {
  throw new Error(
    `SECRET_PATTERNS contains duplicate ids (would collide in per-(file, pattern) occurrence counter): ${DUPLICATE_PATTERN_IDS.join(", ")}`,
  );
}

// =============================================================================
// File-suppression matcher (compiled once at module load)
// =============================================================================

// Same locked picomatch options used by ../classifiers/match.ts.
// Spread `[...]` is the defensive-copy pattern from match.ts —
// protects against any picomatch-internal mutation of its patterns
// argument.
const matchSuppressedFile = picomatch([...SUPPRESSION_FILE_PATTERNS], {
  dot: true,
  nocase: false,
  posixSlashes: true,
  nonegate: true,
});

// =============================================================================
// Exported helpers (test-friendly, pure)
// =============================================================================

/**
 * Clones a RegExp via the constructor. The clone has `lastIndex = 0`
 * (per the RegExp constructor's initialization) regardless of the
 * source regex's state. Mandatory before scanning to avoid lastIndex
 * carryover hazards from prior consumers — see the CRITICAL block at
 * the top of secrets-patterns.ts.
 *
 * Every scan path in this file goes through cloneRegex. Future
 * contributors: do NOT bypass it.
 */
export function cloneRegex(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags);
}

/**
 * Pure-JS Shannon entropy in bits per character. O(n) two-pass:
 * frequency count, then -sum(p * log2(p)). No node:crypto import
 * per D29.
 *
 * Returns 0 for the empty string (no information).
 *
 * Reference values for fixture authors:
 *   - Random base62 (e.g. "A7kLm9PqR2sTuV8wXyZaB3cD4eF5gH"): ~4.5-5.0
 *     bits/char in 30-char samples; ~5.95 in the limit.
 *   - English phrases: ~2-3 bits/char.
 *   - Repeated chars (e.g. "xxxxxxxxxxxxxxxxxxxx"): 0 bits/char.
 * Locked: tests that exercise entropy-passing values MUST use diverse
 * deterministic strings, not repeated chars (repeated chars have
 * zero entropy by construction and would test the wrong thing).
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Combined gate for pattern #7's value-group match. Returns true if
 * ALL three conditions pass:
 *   1. value.length >= MIN_SECRET_LENGTH (20)
 *   2. shannonEntropy(value) > ENTROPY_THRESHOLD (4.0 bits/char)
 *   3. value.toLowerCase() is NOT in PLACEHOLDER_VALUES
 * If ANY fails, the match should be SUPPRESSED ENTIRELY by the
 * caller (per D33: this is a different channel from the file/line
 * downgrade-to-low channel — entropy/placeholder suppression DROPS
 * the match without an audit trail).
 */
export function passesEntropyCheck(value: string): boolean {
  return (
    value.length >= MIN_SECRET_LENGTH &&
    shannonEntropy(value) > ENTROPY_THRESHOLD &&
    !PLACEHOLDER_VALUES.has(value.toLowerCase())
  );
}

/**
 * Returns true if the line text contains any
 * INLINE_SUPPRESSION_MARKERS substring. Case-sensitive (markers are
 * language-specific comment syntax). Matching lines have their
 * secret findings downgraded to level "low" — NOT dropped — per
 * D33's locked suppression-channel split.
 */
export function hasInlineSuppression(line: string): boolean {
  return INLINE_SUPPRESSION_MARKERS.some((m) => line.includes(m));
}

/**
 * Groups addedLines into runs of contiguous line numbers. PEM scanning
 * concatenates each group separately, so a private-key block split
 * across unrelated diff hunks (e.g. lines 10-20 in one hunk + line
 * 80 in another) does NOT produce a false multi-hunk match.
 *
 * Exported for direct unit testing of the contiguity-grouping
 * behavior in file 4 (a key correctness property — a regression
 * here would silently invent secrets out of unrelated hunks).
 *
 * Example: lines [{line:5}, {line:6}, {line:10}, {line:11}, {line:12}]
 *   → [[{line:5}, {line:6}], [{line:10}, {line:11}, {line:12}]]
 */
export function groupContiguousLines(
  lines: readonly LineChunk[],
): readonly (readonly LineChunk[])[] {
  if (lines.length === 0) return [];
  const groups: LineChunk[][] = [];
  let current: LineChunk[] = [];
  let prevLineNum = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    if (line.line === prevLineNum + 1) {
      current.push(line);
    } else {
      if (current.length > 0) groups.push(current);
      current = [line];
    }
    prevLineNum = line.line;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Per-line scan record: one match from one regex against one
 * position. `lineIsSuppressed` is pre-computed by the scan layer so
 * the call site doesn't need to know whether the hit came from a
 * single-line scan (suppression depends on one line) or a multi-line
 * scan (suppression depends on ANY line in the match span). Single
 * source of truth for "was this match suppressed by inline marker".
 */
interface ScanHit {
  readonly lineNumber: number; // 1-indexed line number in the original file
  readonly col: number; // 1-indexed column where the match starts in the line
  readonly value: string; // for non-entropy patterns: the entire match; for entropy patterns: the valueGroup
  readonly lineIsSuppressed: boolean; // any line overlapped by the match contains an INLINE_SUPPRESSION_MARKERS substring
}

/**
 * Per-line scan: clones the regex (lastIndex=0) per line and runs
 * matchAll against each added line individually. col is 1-indexed
 * within the line. Single-line scans: `lineIsSuppressed` is simply
 * the suppression-check result for THAT line.
 */
function scanPerLine(lines: readonly LineChunk[], pattern: SecretPattern): readonly ScanHit[] {
  const hits: ScanHit[] = [];
  for (const line of lines) {
    const localRegex = cloneRegex(pattern.regex);
    const lineIsSuppressed = hasInlineSuppression(line.text);
    for (const match of line.text.matchAll(localRegex)) {
      const value = pattern.entropyCheck ? (match[pattern.valueGroup] ?? "") : match[0];
      hits.push({
        lineNumber: line.line,
        col: (match.index ?? 0) + 1,
        value,
        lineIsSuppressed,
      });
    }
  }
  return hits;
}

/**
 * Multi-line scan (PEM only): groups addedLines into contiguous
 * runs, concatenates each run with `\n`, clones the regex, runs
 * matchAll against the blob, maps each match back to its
 * originating line by linear scan of a precomputed lineOffsets
 * array. For cross-line inline-suppression: computes the start AND
 * end line indices of the match span and sets `lineIsSuppressed` =
 * true if ANY line in [startLineIdx, endLineIdx] contains a
 * suppression marker. So a `// viberevert-allow` marker on the END
 * line of a PEM block correctly downgrades the finding.
 *
 * NEVER concatenates non-contiguous lines (would invent false PEM
 * matches across unrelated diff hunks — see file-header PEM
 * MULTI-LINE HANDLING block).
 */
function scanMultiLine(lines: readonly LineChunk[], pattern: SecretPattern): readonly ScanHit[] {
  const hits: ScanHit[] = [];
  for (const group of groupContiguousLines(lines)) {
    const blob = group.map((l) => l.text).join("\n");
    // lineOffsets[i] = string offset (UTF-16 code units) in blob
    // where group[i].text starts. JS string indexing is UTF-16
    // code-unit-based, NOT byte-based; PEM content is ASCII so the
    // distinction is moot in practice, but the comment must not
    // teach the wrong model to future contributors who might apply
    // a similar pattern to non-ASCII content.
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const l of group) {
      lineOffsets.push(offset);
      offset += l.text.length + 1; // +1 for the joining "\n"
    }
    const localRegex = cloneRegex(pattern.regex);
    for (const match of blob.matchAll(localRegex)) {
      const matchStart = match.index ?? 0;
      // matchEndExclusive = first position AFTER the match (per
      // standard JS substring conventions).
      // matchEndInclusive = last position WITHIN the match. Used
      // below so the "overlapped lines" check matches the
      // documented contract — a line starting at exactly
      // matchEndExclusive does NOT overlap the match (it starts
      // one position past the last matched code unit).
      // Math.max guards against zero-width matches
      // (matchEndExclusive === matchStart): keep inclusive end at
      // matchStart rather than letting it drop to matchStart - 1
      // (which would underflow the bounds logic).
      const matchEndExclusive = matchStart + match[0].length;
      const matchEndInclusive = Math.max(matchStart, matchEndExclusive - 1);
      // Single linear scan to find both startLineIdx (largest i
      // where lineOffsets[i] <= matchStart) AND endLineIdx (largest
      // i where lineOffsets[i] <= matchEndInclusive). Single pass
      // since lineOffsets is monotonically increasing: once
      // off > matchEndInclusive we can break (no more candidate
      // lines for either bound).
      let startLineIdx = 0;
      let endLineIdx = 0;
      for (let i = 0; i < lineOffsets.length; i++) {
        const off = lineOffsets[i];
        if (off === undefined) break;
        if (off <= matchStart) startLineIdx = i;
        if (off <= matchEndInclusive) endLineIdx = i;
        if (off > matchEndInclusive) break;
      }
      const originLine = group[startLineIdx];
      if (originLine === undefined) continue; // defensive; group is non-empty by construction
      const lineStart = lineOffsets[startLineIdx] ?? 0;
      // Cross-line suppression: scan all lines in the match span
      // (inclusive). A marker anywhere in [startLineIdx, endLineIdx]
      // downgrades the finding. Per file-header PEM block.
      const lineIsSuppressed = group
        .slice(startLineIdx, endLineIdx + 1)
        .some((l) => hasInlineSuppression(l.text));
      hits.push({
        lineNumber: originLine.line,
        col: matchStart - lineStart + 1,
        value: pattern.entropyCheck ? (match[pattern.valueGroup] ?? "") : match[0],
        lineIsSuppressed,
      });
    }
  }
  return hits;
}

// =============================================================================
// The secrets check
// =============================================================================

/**
 * Locked recommendation text for emitted secret findings. M B's
 * CheckResultSchema refine requires non-blank recommendation on
 * high/critical findings; "critical" is the default level for secrets
 * (downgraded to "low" only by file/line suppression channels), so
 * the recommendation is required for every default-level finding.
 * Including it on suppressed "low" findings too keeps the emission
 * shape uniform and is harmless (recommendation is optional at "low").
 */
const RECOMMENDATION =
  "Rotate the credential immediately if real. Remove from git history (git filter-repo / BFG). " +
  "If this is a test fixture, move it to a `.example`/`.template` file or add " +
  "`# pragma: viberevert-allow` / `// viberevert-allow` to the line.";

export const secretsCheck: Check = {
  id: "secrets.regex",
  category: "secrets",
  run: (ctx: CheckContext): readonly CheckResult[] => {
    const results: CheckResult[] = [];
    for (const file of ctx.changedFiles) {
      if (file.isBinary) continue;
      if (file.addedLines.length === 0) continue;

      // Normalize file.path ONCE and use throughout: suppression
      // matching, schema-validated evidence.file emission, and the
      // user-facing message template. Shared helper from
      // ../path-normalization.js keeps the discipline identical
      // across all detectors (D17c single source of truth).
      const normalizedFilePath = normalizePathSeparators(file.path);
      const fileIsSuppressed = matchSuppressedFile(normalizedFilePath);
      // Per-(file, pattern) occurrence counter — satisfies D40's
      // detector-side uniqueness rule for multi-finding-per-file
      // detectors. Two GitHub PATs on the same line get occurrences
      // 1 and 2 with different col values → distinct evidence.detail
      // strings → distinct D40 dedup tuples → both survive.
      const occurrenceCounter = new Map<string, number>();

      for (const pattern of SECRET_PATTERNS) {
        const hits =
          pattern.id === "pem-private-key"
            ? scanMultiLine(file.addedLines, pattern)
            : scanPerLine(file.addedLines, pattern);

        for (const hit of hits) {
          // SUPPRESSION CHANNEL A (entropy/placeholder, pattern #7
          // only): DROPS the match entirely. No occurrence counted,
          // no finding emitted, no audit trail.
          if (pattern.entropyCheck && !passesEntropyCheck(hit.value)) continue;

          // Bump per-(file, pattern) occurrence counter AFTER the
          // entropy gate. A dropped match doesn't count.
          const n = (occurrenceCounter.get(pattern.id) ?? 0) + 1;
          occurrenceCounter.set(pattern.id, n);

          // SUPPRESSION CHANNEL B (file/line): DOWNGRADES to "low".
          // Preserves audit trail. Distinct from channel A by intent.
          // hit.lineIsSuppressed was pre-computed by the scan layer
          // (single line for scanPerLine; any line in the match span
          // for scanMultiLine — see PEM MULTI-LINE HANDLING).
          const level: RiskLevel = fileIsSuppressed || hit.lineIsSuppressed ? "low" : "critical";

          // Confidence: env-style is heuristic (NAME ending in
          // SECRET/TOKEN/etc. + 8+ char value, entropy-filtered).
          // Prefix/context patterns are strict (sk_live_, ghp_,
          // PEM markers, `google_api_key` literal context).
          const confidence: Confidence = pattern.id === "env-style-assignment" ? "medium" : "high";

          // D40 redaction-safety: detail string carries pattern
          // identity + occurrence + column. NEVER the raw secret
          // value. The detector reads the secret once to compute
          // the entropy and emits no derivative of it.
          const detail = `${pattern.label} [occurrence ${n}, col ${hit.col}]`;

          results.push({
            id: "secrets.regex",
            category: "secrets",
            level,
            confidence,
            title: "Possible secret committed",
            message: `Possible ${pattern.label} at ${normalizedFilePath}:${hit.lineNumber}`,
            evidence: [
              {
                file: normalizedFilePath,
                line: hit.lineNumber,
                detail,
              },
            ],
            recommendation: RECOMMENDATION,
          });
        }
      }
    }
    return results;
  },
};
