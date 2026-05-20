// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Test-gap detector (M C Step 7a). Pure synchronous Check
// implementation. One D36-locked rule type emits `test-gap`-category
// findings keyed per matched path rule per D40's identity-based dedup
// convention.
//
// =============================================================================
// ONE RULE TYPE
// =============================================================================
//
//   test-gap.<rule.id> (high, confidence: medium)
//   A changed file matches a PATH_RULES entry with non-empty
//   testSiblingPatterns AND no OTHER path in the SAME diff matches
//   any of those patterns. ONE finding per (file, matched-rule)
//   pair. The per-rule id mirrors path-classifier-check.ts so D40
//   dedup correctly preserves multiple distinct findings when a
//   single file matches multiple path rules each with their own
//   testSiblingPatterns.
//
// =============================================================================
// DIFF-SCOPED SIBLING-TEST DETECTION (D36)
// =============================================================================
//
// Per D36, this detector checks that the agent changed tests
// ALONGSIDE risky code in the SAME diff. A pre-existing test file
// in the repo that wasn't changed in the diff does NOT count as
// covering a new code change. (We're checking that the agent paired
// test changes with risky code, not that any test exists somewhere
// in the repo. Existing-test detection without diff scope is a
// v0.8.x+ stretch.)
//
// "Sibling test change" includes ANY changedFiles entry whose path
// matches a rule's testSiblingPatterns, regardless of status —
// added, modified, deleted, renamed, or type-changed. Any of these
// counts as coverage. The user-facing message and recommendation
// therefore say "test change," not "test addition." (See the
// deletion rationale in the run-function JSDoc for why this matters
// for paired-deletion suppression.)
//
// The sibling search excludes the file under inspection itself
// (`j === i` skip). A file cannot satisfy its own test-gap by
// coincidentally matching its own testSiblingPattern — "sibling"
// means a DIFFERENT file in the same diff. Without this exclusion
// the invariant in the section header above would silently weaken.
//
// =============================================================================
// PATH-CLASSIFIER COMPOSITION
// =============================================================================
//
// The detector uses `classifyPath` (same pattern as migrations.ts)
// to get matched rules for each changed file, then iterates
// `rule.testSiblingPatterns` for each. Test-sibling matchers are
// compiled lazily once per rule id per `run()` invocation and reused
// across files in the same diff. This keeps the detector standalone
// while avoiding repeated picomatch compilation on large diffs.
//
// Framework auto-detection (D41/D42) flows in via ctx.detectedFrameworks
// from the CLI. Framework-gated rules (e.g., laravel.middleware)
// only participate when the framework is detected — classifyPath
// itself enforces this.

import picomatch from "picomatch";

import { classifyPath } from "../classifiers/match.js";
import { normalizePathSeparators } from "../path-normalization.js";
import type { Check, CheckContext, CheckResult } from "../types.js";

// =============================================================================
// Locked picomatch options (uniform across @viberevert/checks usages)
// =============================================================================

/**
 * The SAME locked picomatch options as classifiers/match.ts and
 * migrations.ts (`{ dot: true, nocase: false, posixSlashes: true,
 * nonegate: true }`) so glob semantics are uniform across all
 * @viberevert/checks picomatch usages.
 */
const PICOMATCH_OPTIONS = {
  dot: true,
  nocase: false,
  posixSlashes: true,
  nonegate: true,
} as const;

// =============================================================================
// Locked recommendation string
// =============================================================================

/**
 * Recommendation text for test-gap findings. Per D36-equivalent
 * (M B's CheckResultSchema refine enforces non-blank recommendation
 * when level is "high" or "critical"), required on every emission.
 *
 * Wording deliberately says "Add or update" and "paired test changes"
 * (not "additions") to match the detector's actual semantics: any
 * sibling-test change in the diff — add, modify, delete, rename —
 * counts as coverage. See the DIFF-SCOPED block in the file header
 * for the full rationale.
 */
const TEST_GAP_RECOMMENDATION =
  "Add or update sibling tests for this change in the same diff. " +
  "Risky-area changes without paired test changes are difficult to verify " +
  "and easy to regress. If the change is intentionally test-exempt (e.g., a " +
  "pure config tweak), document the exemption in the change description.";

// =============================================================================
// The test-gap check
// =============================================================================

/**
 * The test-gap check. Toggleable via `checks.tests` in
 * `.viberevert.yml` (which maps to category "test-gap" per
 * CHECKS_TOGGLE_MAP). Emits findings under per-rule
 * `test-gap.<rule.id>` ids per D40's identity-based dedup
 * convention. Pure synchronous, no I/O, no async per D29/D48.
 *
 * Scope: ONLY files matched by a path rule with non-empty
 * `testSiblingPatterns`. The classifier itself enforces framework
 * gating (a Laravel rule only matches when "laravel" is in
 * detectedFrameworks).
 *
 * Deletions are intentionally NOT skipped: a deleted Laravel
 * controller without a paired test deletion in the same diff is a
 * legitimate test-gap signal (the corresponding test file should
 * have been deleted too). When a deletion IS accompanied by the
 * corresponding test deletion, the sibling search finds the deleted
 * test file (still present in changedFiles) and suppresses the
 * finding correctly.
 */
export const testGapCheck: Check = {
  id: "test-gap",
  category: "test-gap",
  run: (ctx: CheckContext): readonly CheckResult[] => {
    const results: CheckResult[] = [];

    // -----------------------------------------------------------
    // Pre-pass: normalize every changed file's path ONCE
    // -----------------------------------------------------------
    //
    // The sibling-test search iterates the entire diff for each
    // (file, rule) pair, so normalizing inside the inner loop
    // would multiply work N*M*K times. Cached here.
    const normalizedPaths: string[] = ctx.changedFiles.map((f) => normalizePathSeparators(f.path));

    // Per-run matcher cache keyed by rule.id. Each rule's
    // testSiblingPatterns compile to a picomatch matcher exactly
    // ONCE per run() invocation; subsequent (file, rule) iterations
    // reuse the cached matcher. Bounded by |PATH_RULES| entries with
    // non-empty testSiblingPatterns (currently ~10 across all
    // frameworks) — small memory footprint, large CPU savings on
    // multi-file diffs.
    const siblingMatcherByRuleId = new Map<string, (path: string) => boolean>();

    for (const [i, normalized] of normalizedPaths.entries()) {
      // Classify this file against the path-rule table. Returns
      // empty array for files that don't match any rule — natural
      // early-skip via the empty for-loop body.
      const matchedRules = classifyPath(normalized, ctx.detectedFrameworks);

      for (const rule of matchedRules) {
        // Skip rules with no testSiblingPatterns (e.g., laravel.migrations,
        // generic.lockfiles — these have risk surface but no canonical
        // sibling-test convention).
        if (rule.testSiblingPatterns === undefined || rule.testSiblingPatterns.length === 0) {
          continue;
        }

        // Get-or-compile the matcher for this rule's testSiblingPatterns.
        // Spread `[...]` is the defensive-copy pattern from match.ts —
        // protects against picomatch-internal mutation of its patterns arg.
        let matcher = siblingMatcherByRuleId.get(rule.id);
        if (matcher === undefined) {
          matcher = picomatch([...rule.testSiblingPatterns], PICOMATCH_OPTIONS);
          siblingMatcherByRuleId.set(rule.id, matcher);
        }

        // Diff-scoped sibling search: scan all OTHER normalized
        // changed file paths (the `j === i` skip enforces the
        // "sibling means a different file" invariant from D36; see
        // the header block). Exit on first hit.
        let siblingFound = false;
        for (const [j, candidatePath] of normalizedPaths.entries()) {
          if (j === i) continue;
          if (matcher(candidatePath)) {
            siblingFound = true;
            break;
          }
        }

        if (!siblingFound) {
          results.push({
            id: `test-gap.${rule.id}`,
            category: "test-gap",
            level: "high",
            confidence: "medium", // diff-scoped: may miss pre-existing tests outside the diff
            title: `Risky change without paired test: ${rule.id}`,
            message: `Changes to ${normalized} were not paired with a sibling test change in the same diff`,
            evidence: [
              {
                file: normalized,
                detail: `path-rule: ${rule.id}`,
              },
            ],
            recommendation: TEST_GAP_RECOMMENDATION,
          });
        }
      }
    }

    return results;
  },
};
