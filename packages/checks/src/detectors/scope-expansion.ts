// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Scope-expansion detector (M C Step 7b file 1). Pure synchronous Check
// implementation. ONE D37-locked rule type emits `scope-expansion`-
// category findings keyed per affected risky-category per D40's
// identity-based dedup convention.
//
// =============================================================================
// ONE RULE TYPE
// =============================================================================
//
//   scope-expansion.<category> (high, confidence: medium)
//   At least one changed file is classified into a RISKY_CATEGORY
//   (auth, payments, database, infra, deployment) AND its
//   tokenized path has LOW OVERLAP (< 0.1) with the task tokens.
//   ONE aggregated finding per affected risky category. Up to 5
//   file-evidence entries per category; "+N more" tail in the
//   message when truncated.
//
// =============================================================================
// TRIGGER GATES (D37 — multiple short-circuit guards)
// =============================================================================
//
// Per D37, the detector skips outright (returns []) when:
//   (a) ctx.task is undefined/empty (no task context → algorithm is
//       meaningless)
//   (b) trimmed task length < MIN_TASK_LENGTH (8): extremely short
//       tasks like "Fix" or "wip" (and their padded variants like
//       "   fix   ") give meaningless overlap; a vague user is not
//       the same signal as a specific cosmetic task producing
//       risky-category changes
//   (c) tokenizing ctx.task yields ZERO tokens (e.g., "!!!  !!!"
//       or "  ab  cd  " — characters present but each token < 3
//       chars) — zero-token guard
//
// Per-file guard inside the loop:
//   (d) tokenizing a file path yields ZERO tokens (e.g., path
//       "_/_.png" with no extractable tokens) — divide-by-zero
//       protection in the overlap calculation. The file may still
//       receive findings from OTHER checks (path-classifier, etc.);
//       only scope-expansion's per-file overlap step is skipped.
//
// =============================================================================
// ALGORITHM (D37 — deterministic, NO NLP libraries)
// =============================================================================
//
// 1. Extract task tokens (tokenizeTask): lowercase, split on
//    non-alphanumeric runs, keep ≥3 chars, deduped via Set.
// 2. Extract path tokens (tokenizePath): lowercase, split on
//    `/`, `_`, `-`, `.` separators (D37 lock), keep ≥3 chars,
//    deduped via Set. CamelCase identifiers do NOT split — known
//    heuristic limitation (e.g., `BillingCheckoutController` is
//    ONE token, won't match task token "billing"). Acceptable
//    per D37; documented FP/FN risk.
// 3. For each changed file: compute `overlap = |fileTokens ∩
//    taskTokens| / |fileTokens|`.
// 4. Skip files where `overlap >= OVERLAP_THRESHOLD` (file IS
//    aligned with the task).
// 5. Classify the file. If it's classified into ANY RISKY_CATEGORY
//    (only auth/payments/database/infra/deployment trigger
//    scope-expansion per D37), contribute it to EVERY risky
//    category it's classified under. Files matched only by
//    non-risky path categories (e.g., secrets, dependencies) do
//    NOT contribute even at zero overlap.
// 6. Per risky category: sort by `[overlap asc, file asc]`, emit
//    ONE finding with up to 5 file-evidence entries; remainder
//    counted in the message tail.
//
// =============================================================================
// RISKY CATEGORIES (D37)
// =============================================================================
//
// LOCKED set: { auth, payments, database, infra, deployment }.
// Files classified ONLY into non-risky path categories (e.g.,
// secrets via laravel.env, dependencies via generic.manifests) do
// NOT contribute even under low overlap. Those categories are
// reserved for the OTHER detectors (secrets check, dependencies
// check, etc.) — scope-expansion's signal is specifically "you
// ventured into a risky AREA without announcing it," not "you
// touched a secret." Future non-risky path categories should
// follow the same rule.
//
// =============================================================================
// TOGGLE-OWNERSHIP NOTE
// =============================================================================
//
// `checks.scope_expansion` in `.viberevert.yml` (note underscore,
// per CHECKS_TOGGLE_MAP) toggles this detector. The toggle is
// enforced by the engine's D28 two-layer filter — the detector
// itself does NOT inspect ctx.configChecks (per D28 lock:
// individual checks must not own toggle decisions).

import { classifyPath } from "../classifiers/match.js";
import { normalizePathSeparators } from "../path-normalization.js";
import type { Check, CheckContext, CheckResult } from "../types.js";

// =============================================================================
// Locked tuning constants
// =============================================================================

/**
 * Minimum task character length to enable the detector. Tasks
 * shorter than this (e.g., "Fix", "wip", "tweak") give meaningless
 * overlap signal and trigger D37's locked short-circuit.
 */
const MIN_TASK_LENGTH = 8;

/**
 * Minimum token length to consider during tokenization. Below this
 * threshold, tokens like "a", "of", "to", "in" produce noise; D37
 * locks the 3-char floor for both task and path tokens.
 */
const MIN_TOKEN_LENGTH = 3;

/**
 * Overlap threshold: a file with overlap STRICTLY LESS than this
 * value triggers scope-expansion (when classified into a risky
 * category). D37-locked at 0.1 (10%).
 */
const OVERLAP_THRESHOLD = 0.1;

/**
 * Maximum evidence entries per per-category finding. Additional
 * suspicious files in the same category are reported in the
 * message tail as "+N more". D37-locked at 5.
 */
const MAX_EVIDENCE_PER_CATEGORY = 5;

/**
 * The set of path-classifier categories that trigger
 * scope-expansion under low overlap. D37-locked. Files classified
 * ONLY into non-risky path categories (e.g., secrets,
 * dependencies) do NOT contribute — those are owned by other
 * detectors.
 */
const RISKY_CATEGORIES: ReadonlySet<string> = new Set([
  "auth",
  "payments",
  "database",
  "infra",
  "deployment",
]);

// =============================================================================
// Locked recommendation string
// =============================================================================

/**
 * Recommendation text for scope-expansion findings. Per D37-equivalent
 * (M B's CheckResultSchema refine enforces non-blank recommendation
 * when level is "high" or "critical"), required on every emission.
 */
const SCOPE_EXPANSION_RECOMMENDATION =
  "Review the listed files against the original task. If they are " +
  "intentional, document the scope expansion in the change description. " +
  "If they were unintentional (e.g., the agent over-edited), revert or " +
  "split into a separate change.";

// =============================================================================
// Tokenization helpers (pure, deterministic)
// =============================================================================

/**
 * Tokenize a task string: lowercase, split on non-alphanumeric
 * runs, keep ≥3-char tokens, dedupe via Set.
 *
 *   "Fix the login button"      → {"fix", "the", "login", "button"}
 *   "Update PR #123"            → {"update", "123"}
 *   "!!!"                       → {}  (zero-token guard fires upstream)
 *   "   wip   "                 → {"wip"}  (caller filters MIN_TASK_LENGTH first)
 *
 * Stop words ("the", "and", etc.) are NOT filtered — D37 does not
 * mandate NLP-style stop-word filtering, and a fixed list would be
 * locale-specific. The 3-char floor + dedup is the locked rule.
 */
function tokenizeTask(task: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of task.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH) tokens.add(raw);
  }
  return tokens;
}

/**
 * Tokenize a repo-relative POSIX path: lowercase, split on `/`,
 * `_`, `-`, `.` separators (D37-locked separator set), keep ≥3-char
 * tokens, dedupe via Set.
 *
 *   "app/billing/checkout.php"
 *     → {"app", "billing", "checkout", "php"}
 *   "app/Http/Controllers/BillingCheckoutController.php"
 *     → {"app", "http", "controllers", "billingcheckoutcontroller", "php"}
 *     (camelCase identifier is ONE token — known limitation per D37)
 *
 * NOTE: caller MUST pass a POSIX-normalized path (use
 * `normalizePathSeparators` first). The separator set does NOT
 * include backslash because path normalization is the canonical
 * cross-platform mechanism (matches the rest of @viberevert/checks).
 */
function tokenizePath(path: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of path.toLowerCase().split(/[/_\-.]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH) tokens.add(raw);
  }
  return tokens;
}

// =============================================================================
// The scope-expansion check
// =============================================================================

/**
 * The scope-expansion check. Toggleable via `checks.scope_expansion`
 * in `.viberevert.yml` (which maps to category "scope-expansion"
 * per CHECKS_TOGGLE_MAP — note the underscore-vs-hyphen split). Emits
 * findings under per-category ids `scope-expansion.<category>` per
 * D40's identity-based dedup convention. Pure synchronous, no I/O,
 * no async per D29/D48.
 *
 * Scope: files classified into RISKY_CATEGORIES (auth / payments /
 * database / infra / deployment) AND with task-path token overlap
 * STRICTLY LESS than OVERLAP_THRESHOLD (0.1). Files matched only by
 * non-risky categories don't contribute even at zero overlap — those
 * categories are owned by other detectors.
 *
 * The detector emits ONE finding per AFFECTED risky category. A
 * single file matching multiple risky-category rules contributes
 * to ALL of those category findings — its own evidence appears
 * under each affected category.
 */
export const scopeExpansionCheck: Check = {
  id: "scope-expansion",
  category: "scope-expansion",
  run: (ctx: CheckContext): readonly CheckResult[] => {
    // -----------------------------------------------------------
    // Trigger gates (D37 short-circuits)
    // -----------------------------------------------------------

    // Gate (a) + (b): no task OR trimmed task too short → skip
    // entirely. Trim BEFORE the length check so padded short tasks
    // (e.g., "   fix   " — length 9, would otherwise bypass the
    // floor) are correctly rejected. The task-length floor (8) runs
    // BEFORE tokenization on purpose: it catches "Fix" / "wip" /
    // "tweak" (and their padded variants) without spending
    // tokenization cycles.
    const task = ctx.task?.trim() ?? "";
    if (task.length < MIN_TASK_LENGTH) {
      return [];
    }

    // Gate (c): task with no extractable tokens (e.g., "!!!  !!!"
    // or "  ab  cd  " — characters present but each token < 3 chars).
    const taskTokens = tokenizeTask(task);
    if (taskTokens.size === 0) {
      return [];
    }

    // -----------------------------------------------------------
    // Per-file overlap + bucketing
    // -----------------------------------------------------------
    //
    // Map<category, evidence-list> — populated as we walk files.
    // Each entry's value carries the file path AND its overlap
    // value (for stable sort + evidence-detail formatting).
    interface SuspiciousFile {
      readonly file: string;
      readonly overlap: number;
    }
    const filesByCategory = new Map<string, SuspiciousFile[]>();

    for (const file of ctx.changedFiles) {
      const normalized = normalizePathSeparators(file.path);
      const fileTokens = tokenizePath(normalized);

      // Gate (d): per-file zero-token guard. A path with no
      // extractable tokens would yield NaN from the divide step.
      // Skip silently — other checks may still emit findings for
      // this file.
      if (fileTokens.size === 0) {
        continue;
      }

      // Compute |fileTokens ∩ taskTokens| / |fileTokens|.
      let intersectionSize = 0;
      for (const token of fileTokens) {
        if (taskTokens.has(token)) intersectionSize++;
      }
      const overlap = intersectionSize / fileTokens.size;

      // High overlap → file IS aligned with the task → skip.
      if (overlap >= OVERLAP_THRESHOLD) {
        continue;
      }

      // Classify the file. Determine which RISKY_CATEGORIES it
      // belongs to. A file matched only by non-risky path
      // categories (e.g., secrets, dependencies) contributes
      // NOTHING even at zero overlap.
      const matchedRules = classifyPath(normalized, ctx.detectedFrameworks);
      const fileRiskyCategories = new Set<string>();
      for (const rule of matchedRules) {
        if (RISKY_CATEGORIES.has(rule.category)) {
          fileRiskyCategories.add(rule.category);
        }
      }
      if (fileRiskyCategories.size === 0) {
        continue;
      }

      // Contribute to every matched risky category.
      for (const category of fileRiskyCategories) {
        let arr = filesByCategory.get(category);
        if (arr === undefined) {
          arr = [];
          filesByCategory.set(category, arr);
        }
        arr.push({ file: normalized, overlap });
      }
    }

    // -----------------------------------------------------------
    // Emit one finding per affected risky category
    // -----------------------------------------------------------
    //
    // Sort the category keys for deterministic emission order.
    // Map iteration is insertion-order, which depends on which
    // file was scanned first → would be sensitive to changedFiles
    // ordering; explicit sort is the locked invariant.
    const results: CheckResult[] = [];
    const categories = [...filesByCategory.keys()].sort();
    for (const category of categories) {
      const files = filesByCategory.get(category);
      if (files === undefined) continue; // Defensive; impossible by construction.

      // Sort by [overlap asc, file asc] — lowest overlap first
      // (most suspicious), then alphabetical for stability.
      files.sort((a, b) => {
        if (a.overlap !== b.overlap) return a.overlap - b.overlap;
        if (a.file < b.file) return -1;
        if (a.file > b.file) return 1;
        return 0;
      });

      const evidence = files.slice(0, MAX_EVIDENCE_PER_CATEGORY).map((f) => ({
        file: f.file,
        detail: `overlap: ${f.overlap.toFixed(2)}`,
      }));

      const totalCount = files.length;
      const moreCount = Math.max(0, totalCount - MAX_EVIDENCE_PER_CATEGORY);
      const fileWord = totalCount === 1 ? "file" : "files";
      const message =
        moreCount > 0
          ? `${totalCount} ${fileWord} in the ${category} area had low overlap with the task (showing first ${MAX_EVIDENCE_PER_CATEGORY}; +${moreCount} more)`
          : `${totalCount} ${fileWord} in the ${category} area had low overlap with the task`;

      results.push({
        id: `scope-expansion.${category}`,
        category: "scope-expansion",
        level: "high",
        confidence: "medium", // heuristic with documented FP/FN risk per D37
        title: `Suspicious scope expansion: ${category}`,
        message,
        evidence,
        recommendation: SCOPE_EXPANSION_RECOMMENDATION,
      });
    }

    return results;
  },
};
