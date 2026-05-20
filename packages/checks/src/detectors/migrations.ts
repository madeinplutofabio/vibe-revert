// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Migration content detector (M C Step 6 file 2). Pure synchronous Check
// implementation. Two D35-locked rule types emit `database`-category
// findings with distinct per-rule ids per D40's identity-based dedup
// convention.
//
// =============================================================================
// TWO RULE TYPES
// =============================================================================
//
//   1. migration.danger-term.<term.id> (high, confidence: medium)
//      An added line of a database-category file matches one of the
//      MIGRATION_DANGER_TERMS from migrations-danger-terms.ts.
//      The detector emits ONE finding per matched term per line.
//      Per-rule id uses the term's stable id (e.g.,
//      `migration.danger-term.sql.drop-table`).
//
//   2. migration.missing-down (high, confidence: high)
//      A NEW migration file (status: "added") contains at least one
//      danger term AND no DOWN_METHOD_PATTERNS pattern matches any
//      added line. Suggests a destructive migration without rollback
//      path. ONE finding per file. See migrations-danger-terms.ts
//      file header for the full ALL-of conditions.
//
// =============================================================================
// SCOPE: DATABASE-CATEGORY FILES ONLY (via path-classifier)
// =============================================================================
//
// The detector runs ONLY on files matching a path-classifier rule
// with category === "database" (per D35). Determination is via
// classifyPath(file.path, ctx.detectedFrameworks):
//   - laravel.migrations (database/migrations/**, framework: "laravel")
//   - rails.migrations (db/migrate/**, framework: "rails")
//   - (future) django, etc.
//
// Framework auto-detection (D41/D42) flows in via ctx.detectedFrameworks
// from the CLI. A file in `database/migrations/foo.php` does NOT
// match laravel.migrations unless "laravel" is in detectedFrameworks.
// This is the correct behavior: we shouldn't run Laravel migration
// logic against a non-Laravel project that happens to have a similar
// directory layout (e.g., a Symfony or CodeIgniter project).
//
// =============================================================================
// PER-TERM FILE-EXTENSION SCOPING (data-level)
// =============================================================================
//
// Even within database-category files, each term has its own
// fileExtensions scope per migrations-danger-terms.ts. The detector
// skips a term for a file whose extension isn't in the term's
// allowed list. Without this, `dropTable` would emit BOTH
// laravel.drop-table AND sequelize.drop-table findings on the same
// PHP file (different ids → not collapsed by D40 dedup).
//
// Terms with no fileExtensions (universal SQL keywords + the
// sql.alter-table-drop idiom) apply to all database-category files
// regardless of extension.

import picomatch from "picomatch";

import { classifyPath } from "../classifiers/match.js";
import { normalizePathSeparators } from "../path-normalization.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import {
  type DangerTerm,
  type DangerTermMatch,
  DOWN_METHOD_PATTERNS,
  MIGRATION_DANGER_TERMS,
  MISSING_DOWN_EXCLUDED_FILE_PATTERNS,
  MISSING_DOWN_FILE_EXTENSIONS,
} from "./migrations-danger-terms.js";

// =============================================================================
// Pre-compiled picomatch matcher for MISSING_DOWN_EXCLUDED_FILE_PATTERNS
// =============================================================================

/**
 * Pre-compiled picomatch matcher for the
 * MISSING_DOWN_EXCLUDED_FILE_PATTERNS glob list. Compiled once at
 * module load to avoid per-call recompilation; would throw at import
 * time on an invalid glob (locking valid pattern syntax at the
 * earliest possible point).
 *
 * Uses the SAME locked picomatch options as classifiers/match.ts
 * (`{ dot: true, nocase: false, posixSlashes: true, nonegate: true }`)
 * so glob semantics are uniform across all @viberevert/checks
 * picomatch usages.
 *
 * Spread `[...]` is the defensive-copy pattern from match.ts —
 * protects against picomatch-internal mutation of its patterns arg.
 */
const matchExcludedFromMissingDown = picomatch([...MISSING_DOWN_EXCLUDED_FILE_PATTERNS], {
  dot: true,
  nocase: false,
  posixSlashes: true,
  nonegate: true,
});

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Extract the file extension (including the leading dot) from a
 * POSIX path, matching Node's `path.extname` semantics WITHOUT the
 * `node:path` import (per D29/D48 ban on Node built-ins in
 * @viberevert/checks).
 *
 *   "package.json"        → ".json"
 *   "apps/yarn.lock"      → ".lock"
 *   "Gemfile"             → ""        (no dot in basename)
 *   ".env"                → ""        (dot at basename position 0: dotfile, no extension)
 *   "apps/.env.local"     → ".local"  (multi-dot dotfile: segment after final dot)
 *
 * The path is assumed already normalized to POSIX (callers pass
 * `normalizePathSeparators(file.path)`).
 */
function getExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const lastDot = basename.lastIndexOf(".");
  if (lastDot <= 0) return ""; // no dot, OR dot at position 0 (dotfile with no extension)
  return basename.slice(lastDot);
}

/**
 * Test whether a line of text matches a DangerTermMatch. Handles both
 * "substring" (case-sensitive or case-insensitive) and "regex"
 * variants of the discriminated union.
 *
 * Stateless: regex patterns are used with .test() (no /g flag per
 * the DangerTermMatch contract); substring matching uses includes()
 * which is stateless by definition. Safe to call any number of times
 * across invocations.
 */
function matchesTerm(text: string, match: DangerTermMatch): boolean {
  if (match.kind === "substring") {
    if (match.caseInsensitive) {
      return text.toLowerCase().includes(match.needle.toLowerCase());
    }
    return text.includes(match.needle);
  }
  // match.kind === "regex"
  return match.pattern.test(text);
}

/**
 * Test whether a path classifies as a database-category file via the
 * path-classifier matcher. Returns true if ANY matched rule has
 * category === "database".
 *
 * The detector runs ONLY on such files per D35. Calling classifyPath
 * here duplicates the engine's classifier invocation (the engine
 * also calls it for risk-tag computation), but the call is cheap
 * (pre-compiled rule matchers in classifiers/match.ts) and keeps
 * this detector standalone — it doesn't depend on engine internals
 * passing classifier output through ctx (matching the architectural
 * pattern from Step 5's dependencies.ts).
 */
function isDatabaseCategoryFile(path: string, detectedFrameworks: readonly string[]): boolean {
  const matchedRules = classifyPath(path, detectedFrameworks);
  return matchedRules.some((rule) => rule.category === "database");
}

// =============================================================================
// Locked recommendation strings
// =============================================================================

/**
 * Recommendation text for danger-term findings. Per D35, required on
 * high-level findings (M B's CheckResultSchema refine enforces
 * non-blank recommendation when level is "high" or "critical").
 */
const DANGER_TERM_RECOMMENDATION =
  "Run the migration locally before deploying. Confirm a rollback path exists. " +
  "Consider splitting destructive operations into a forward-only deploy + a separate cleanup migration.";

/**
 * Recommendation text for missing-down findings.
 */
const MISSING_DOWN_RECOMMENDATION =
  "Add a down() method to enable rollback of this migration. If the destructive operation is intentional " +
  "and irreversible, document the no-rollback decision in the migration body and confirm with the team " +
  "before deploying.";

// =============================================================================
// The migrations check
// =============================================================================

/**
 * The migration content check. Toggleable via `checks.migrations` in
 * `.viberevert.yml` (which maps to category "database" per
 * CHECKS_TOGGLE_MAP). Emits findings under per-term + missing-down
 * ids per D40's identity-based dedup convention. Pure synchronous,
 * no I/O, no async per D29/D48.
 *
 * Scope: ONLY files classified as database-category by the
 * path-classifier (typically migration files in framework-recognized
 * directories like Laravel's `database/migrations/**` or Rails's
 * `db/migrate/**`).
 *
 * Per-term fileExtensions filtering applies on top of database-
 * category scoping — see migrations-danger-terms.ts FILE-EXTENSION
 * SCOPING block for the rationale.
 */
export const migrationsCheck: Check = {
  id: "migrations",
  category: "database",
  run: (ctx: CheckContext): readonly CheckResult[] => {
    const results: CheckResult[] = [];

    for (const file of ctx.changedFiles) {
      // Early skips: binary files have no scannable content; empty
      // addedLines means nothing was added (could be a pure deletion
      // diff or a status-change with no line additions).
      if (file.isBinary || file.addedLines.length === 0) continue;

      const normalized = normalizePathSeparators(file.path);

      // SCOPE GATE: only database-category files. The framework
      // gating in path-classifier rules (laravel.migrations requires
      // framework: "laravel" in detectedFrameworks, etc.) is enforced
      // by classifyPath itself.
      if (!isDatabaseCategoryFile(normalized, ctx.detectedFrameworks)) continue;

      const ext = getExtension(normalized);

      // Collect matched danger terms (per-line) and track whether a
      // down() method definition appears anywhere in addedLines.
      // Both scans share the per-file loop to avoid iterating
      // addedLines twice.
      interface MatchedTerm {
        readonly term: DangerTerm;
        readonly line: number;
      }
      const matchedTerms: MatchedTerm[] = [];
      let downMethodFound = false;

      for (const addedLine of file.addedLines) {
        // Danger-term scan
        for (const term of MIGRATION_DANGER_TERMS) {
          // File-extension scope check: term-level scope per
          // migrations-danger-terms.ts. Undefined fileExtensions
          // means "applies to all database-category files".
          if (term.fileExtensions !== undefined && !term.fileExtensions.includes(ext)) {
            continue;
          }
          if (matchesTerm(addedLine.text, term.match)) {
            matchedTerms.push({ term, line: addedLine.line });
          }
        }

        // down()-method-definition scan. Once found, skip further
        // pattern checks for this file (presence is binary — we only
        // need to know IF down() exists, not how many times).
        if (!downMethodFound) {
          for (const pattern of DOWN_METHOD_PATTERNS) {
            if (pattern.test(addedLine.text)) {
              downMethodFound = true;
              break;
            }
          }
        }
      }

      // -----------------------------------------------------------
      // Emit one finding per matched danger term
      // -----------------------------------------------------------
      for (const { term, line } of matchedTerms) {
        results.push({
          id: `migration.danger-term.${term.id}`,
          category: "database",
          level: "high",
          confidence: "medium", // line-grep with documented FP risk per D35
          title: `Destructive migration: ${term.description}`,
          message: `${term.description} detected at ${normalized}:${line}`,
          evidence: [
            {
              file: normalized,
              line,
              detail: `danger-term: ${term.id}`,
            },
          ],
          recommendation: DANGER_TERM_RECOMMENDATION,
        });
      }

      // -----------------------------------------------------------
      // Missing-down evaluation (ONE finding per file when eligible)
      // -----------------------------------------------------------
      //
      // ALL conditions must hold per migrations-danger-terms.ts header:
      //   - file.status === "added"
      //   - extension in MISSING_DOWN_FILE_EXTENSIONS (positive gate)
      //   - path NOT matched by MISSING_DOWN_EXCLUDED_FILE_PATTERNS
      //     (defense-in-depth exclusion, e.g., Django)
      //   - at least one danger term matched
      //   - no DOWN_METHOD_PATTERNS pattern matched
      if (
        file.status === "added" &&
        MISSING_DOWN_FILE_EXTENSIONS.includes(ext) &&
        !matchExcludedFromMissingDown(normalized) &&
        matchedTerms.length > 0 &&
        !downMethodFound
      ) {
        results.push({
          id: "migration.missing-down",
          category: "database",
          level: "high",
          confidence: "high", // structural: status + multi-condition
          title: "New migration has destructive operation without down() method",
          message: `New migration ${normalized} contains a destructive operation but has no down() method for rollback`,
          evidence: [
            {
              file: normalized,
              detail: "missing-down",
            },
          ],
          recommendation: MISSING_DOWN_RECOMMENDATION,
        });
      }
    }

    return results;
  },
};
