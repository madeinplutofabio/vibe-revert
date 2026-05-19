// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The path-classifier check.
//
// Wraps the pure `classifyPath` matcher (from ./match.ts) as a `Check`
// the engine can invoke per-file in its main pipeline. The check emits
// ONE CheckResult per (matched rule, changed file) pair so that:
//   - Multiple rules matching the same path produce multiple distinct
//     findings (D40 identity-based dedup: per-rule id prevents accidental
//     collapse — see D40 lock + classifiers/multi-match.test.ts regression).
//   - Each finding's `id` is `path-classifier.<rule.id>` so the
//     (id, category, file, line, detail) dedup tuple is unique even
//     when several path rules touch the same file.
//
// CATEGORY vs EMITTED CATEGORIES (D28 lock):
//   - `category` is a check-family label used for sort/cluster purposes
//     and engine-internal grouping. It is NOT a toggle key. The literal
//     "path-classifier" value does NOT appear in CHECKS_TOGGLE_MAP.
//   - `emittedCategories` is the authoritative toggle/routing surface.
//     The engine's two-layer toggle filter (D28) reads emittedCategories
//     to decide which findings survive. For the path-classifier — an
//     umbrella check that fans out across auth, payments, database,
//     infra, deployment, secrets, dependencies — emittedCategories is
//     REQUIRED so layer 1 (pre-run skip) and layer 2 (per-finding filter)
//     both have the full fan-out picture.
//   - The registry invariant (registry.test.ts) enforces two prongs:
//     (a) if a check's `category` is itself a toggle key, that category
//         must appear in emittedCategories;
//     (b) if a check's `category` is NOT a toggle key (umbrella case),
//         emittedCategories must be explicitly defined, non-empty, and
//         every entry must be a real toggle key.
//
// EMITTED_CATEGORIES_UNION is derived from PATH_RULES at module load
// (not hand-listed) so adding a new path rule with a new category
// automatically updates the union — single source of truth, no drift
// risk.
//
// FAIL-CLOSED RECOMMENDATIONS (two layers, both required):
//   1. MODULE-LOAD invariant: at import time, this module computes the
//      set of high/critical-emitting categories from PATH_RULES and
//      asserts that every one of them has a registered entry in
//      RECOMMENDATIONS_BY_CATEGORY. If any are missing, the module
//      THROWS at load. This catches drift the moment ANY code path
//      imports the module — every unit test in this package, the
//      registry's BUILTIN_CHECKS import, the CLI command pipeline. A
//      new high/critical path rule with a forgotten recommendation is
//      impossible to ship past this gate; the failure does not depend
//      on a test happening to exercise the offending rule.
//   2. RUNTIME function: `recommendationForCategory` throws if invoked
//      with a category that has no entry. This is defense-in-depth for
//      any future code path that might emit a high/critical finding
//      with a category not present in PATH_RULES (a contract violation
//      in its own right, but cheap to keep the local call site
//      fail-closed).
//   - Title fallback is intentionally permissive: `title` is
//     schema-OPTIONAL on CheckResult, so a missing TITLES_BY_CATEGORY
//     entry degrades to a generic human-readable label rather than
//     throwing. The consequence of a missing title entry is purely
//     cosmetic.
//
// PURITY: this check performs no I/O, makes no Date / random / clock
// calls, and contains no async code per D29.

import type { Check, CheckContext, CheckResult } from "../types.js";
import { classifyPath } from "./match.js";
import { PATH_RULES } from "./path-rules.js";

/**
 * Per-category recommendation strings. REQUIRED for any category whose
 * rules can emit high/critical findings — `CheckResultSchema` in
 * `@viberevert/session-format` refines that high/critical findings
 * carry a non-empty `recommendation`. Fail-closed at TWO layers:
 *   - Module-load invariant immediately below this map asserts every
 *     high/critical category in PATH_RULES has an entry here, or the
 *     module throws on import.
 *   - `recommendationForCategory` throws at call time as a second
 *     defense.
 * Adding a new high/critical-emitting category MUST extend this map in
 * the same edit; the module-load check makes that contract
 * unmissable.
 */
const RECOMMENDATIONS_BY_CATEGORY: Readonly<Record<string, string>> = {
  auth: "Auth-related code is a common source of access-control regressions. Review the change carefully, confirm a corresponding test exists, and verify behavior against your auth model before deploying.",
  payments:
    "Payment-related code is high-impact: bugs here can charge or refund the wrong amounts. Review the change against the payment-flow spec, verify with a sandbox transaction, and confirm webhook idempotency where relevant.",
  database:
    "Database/migration changes can be destructive and hard to roll back. Run the migration locally, confirm a rollback path exists, and consider splitting destructive operations into a forward-only deploy plus a separate cleanup migration.",
  infra:
    "Infrastructure-as-code changes can affect production deployment topology. Review the diff carefully, plan/dry-run the change if possible, and confirm the deployment pipeline can roll forward and back.",
  deployment:
    "Deployment configuration changes affect how and where the app runs. Verify the change in a non-production environment first, and confirm CI gates still pass before merging.",
  secrets:
    "Credentials and environment configuration require special handling. Confirm no real secrets are committed, verify any rotation is coordinated with consumers, and ensure secret-management policy is followed.",
  dependencies:
    "Dependency changes can pull in unexpected transitive code. Review the new package versions, verify upstream provenance, and confirm install-time scripts (if any) are expected.",
};

/**
 * Module-load invariant: compute the set of categories that have at
 * least one high/critical PATH_RULES entry but no recommendation
 * registered, and throw if non-empty. This runs ONCE at module import
 * — fires before any check runs, before any test executes, before any
 * finding is emitted. A forgotten recommendation entry for a new
 * high/critical path rule is impossible to ship past this gate.
 */
const MISSING_HIGH_IMPACT_RECOMMENDATION_CATEGORIES: readonly string[] = Array.from(
  new Set(
    PATH_RULES.filter((rule) => rule.defaultLevel === "high" || rule.defaultLevel === "critical")
      .map((rule) => rule.category)
      .filter((category) => RECOMMENDATIONS_BY_CATEGORY[category] === undefined),
  ),
).sort();

if (MISSING_HIGH_IMPACT_RECOMMENDATION_CATEGORIES.length > 0) {
  throw new Error(
    `path-classifier high/critical categories missing recommendations: ${MISSING_HIGH_IMPACT_RECOMMENDATION_CATEGORIES.join(
      ", ",
    )}`,
  );
}

/**
 * Per-category short titles for emitted findings. `title` is
 * schema-OPTIONAL on `CheckResult`, so a missing entry degrades to
 * `FALLBACK_TITLE` rather than throwing. The cost of a missing title
 * is purely cosmetic, so a generic fallback is acceptable here (in
 * contrast to recommendations, where a missing entry is a schema-level
 * bug — see the module-load invariant above plus
 * `recommendationForCategory`).
 */
const TITLES_BY_CATEGORY: Readonly<Record<string, string>> = {
  auth: "Auth-related path changed",
  payments: "Payments-related path changed",
  database: "Database/migration path changed",
  infra: "Infrastructure path changed",
  deployment: "Deployment path changed",
  secrets: "Secrets/env path changed",
  dependencies: "Dependency path changed",
};
const FALLBACK_TITLE = "Risky path changed";

/**
 * Fail-closed recommendation lookup. Throws if invoked with a category
 * that has no registered recommendation. The module-load invariant
 * above guarantees this cannot fire for any category present in
 * PATH_RULES; this function exists as a second layer of defense
 * against any future code path that might emit a high/critical
 * finding with a category constructed dynamically or not present in
 * PATH_RULES.
 *
 * Callers MUST only invoke this for rules whose `defaultLevel` is
 * "high" or "critical"; lower levels do not require a recommendation
 * per `CheckResultSchema`.
 */
function recommendationForCategory(category: string): string {
  const recommendation = RECOMMENDATIONS_BY_CATEGORY[category];
  if (recommendation === undefined) {
    throw new Error(
      `path-classifier category '${category}' has a high/critical rule but no recommendation`,
    );
  }
  return recommendation;
}

/**
 * Derived from `PATH_RULES` at module load time so adding a new rule
 * with a new category automatically updates the union. Sorted for
 * stable cross-run output (engine sort is independent, but a stable
 * `emittedCategories` order keeps debug output and architectural-
 * invariants assertions consistent).
 */
const EMITTED_CATEGORIES_UNION: readonly string[] = Array.from(
  new Set(PATH_RULES.map((r) => r.category)),
).sort();

/**
 * The path-classifier check. Fans out across multiple risk categories
 * (auth / payments / database / infra / deployment / secrets /
 * dependencies) per the `PATH_RULES` table. Registered at the FRONT of
 * `BUILTIN_CHECKS` so its risk tags populate `riskTagsByPath` before
 * content-detectors fire.
 *
 * `id` is the stable check identifier used by the engine. Per-finding
 * ids are `path-classifier.<rule.id>` (constructed in `run` below) so
 * the D40 identity-based dedup tuple is genuinely distinct when
 * multiple rules match the same file.
 *
 * `category` is the check-family label (NOT a toggle key — see file
 * header). `emittedCategories` is the toggle/routing surface and is
 * the authoritative fan-out set for D28's two-layer toggle filter.
 *
 * `confidence` is hard-coded to "high" on every emitted finding:
 * path-classifier matches are deterministic rule-against-glob hits
 * against a curated table, with no inference or heuristics involved.
 */
export const pathClassifierCheck: Check = {
  id: "path-classifier",
  category: "path-classifier",
  emittedCategories: EMITTED_CATEGORIES_UNION,
  run: (ctx: CheckContext): readonly CheckResult[] => {
    const results: CheckResult[] = [];
    for (const file of ctx.changedFiles) {
      const matchedRules = classifyPath(file.path, ctx.detectedFrameworks);
      for (const rule of matchedRules) {
        const isHighOrCritical = rule.defaultLevel === "high" || rule.defaultLevel === "critical";
        const recommendation = isHighOrCritical
          ? recommendationForCategory(rule.category)
          : undefined;
        const title = TITLES_BY_CATEGORY[rule.category] ?? FALLBACK_TITLE;
        const message = `File '${file.path}' matches path-classifier rule '${rule.id}' for category '${rule.category}'.`;
        const finding: CheckResult = {
          id: `path-classifier.${rule.id}`,
          category: rule.category,
          level: rule.defaultLevel,
          confidence: "high",
          title,
          message,
          evidence: [{ file: file.path, detail: rule.id }],
          ...(recommendation !== undefined ? { recommendation } : {}),
        };
        results.push(finding);
      }
    }
    return results;
  },
};
