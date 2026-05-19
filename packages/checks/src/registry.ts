// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The built-in check registry + the config-key → emitted-categories map
// the engine consults for D28's two-layer toggle enforcement.
//
// `BUILTIN_CHECKS` is the deterministic list of all Check implementations
// that ship with VibeRevert. Order in this array IS the order in which
// `runChecks` invokes them; the engine then sorts findings deterministically
// at the end per the locked D40 sort key, so registry order does NOT affect
// the persisted report's finding order — but it DOES affect:
//   - which check's `run()` fires first (visible via test spies and useful
//     for deterministic diagnostics)
//   - future composition room: the path-classifier is intentionally first
//     in the registry, but in the current Step 3 engine, riskTagsByPath is
//     populated by the engine's direct classifier call, not by this check's
//     run() side effects. Content detectors do NOT consume prior check
//     output today.
//
// `CHECKS_TOGGLE_MAP` is the SINGLE SOURCE OF TRUTH mapping each
// `.viberevert.yml` `checks.*` config key to the set of categories that
// key's `true` / `false` toggles. The map is REVERSE-LOOKED-UP by
// `deriveEnabledCategories` to compute the enabled-category set the engine
// uses for its two-layer toggle filter. The map is array-valued because
// some keys toggle MULTIPLE categories (e.g., `infra` → `["infra",
// "deployment"]`) — the lock that prevents the path-classifier's
// `emittedCategories` from going stale relative to the toggle config.
//
// LOCKED ENGINE-ONLY CATEGORY: the literal `"summary"` category is
// produced ONLY by the D40 cluster post-process pass. It is NOT
// user-toggleable and is NOT in CHECKS_TOGGLE_MAP. The
// architectural-invariants test in `registry.test.ts` asserts both
// directions:
//   (a) every category in every check's emittedCategories appears as a
//       value in CHECKS_TOGGLE_MAP
//   (b) NO check in BUILTIN_CHECKS has `category === "summary"` and NO
//       check lists "summary" in emittedCategories (clusters live in the
//       engine, never in the registry)
//
// LOCKED UMBRELLA-CHECK EXCEPTION: a check whose primary `category` is a
// check-family LABEL (not itself a toggle key) — `path-classifier` is
// the canonical example, with `category: "path-classifier"` and
// `emittedCategories` fanning out across multiple real toggle keys
// (auth / payments / database / infra / deployment / secrets /
// dependencies) — is permitted. The registry.test.ts invariant accepts
// this umbrella pattern via a TWO-PRONGED branch:
//   (a) Toggleable-primary case: check.category appears in
//       CHECKS_TOGGLE_MAP values → emittedCategories must be a superset
//       of [category] (single-category checks satisfy trivially by
//       omitting the field).
//   (b) Umbrella case: check.category does NOT appear in
//       CHECKS_TOGGLE_MAP values → emittedCategories MUST be declared
//       explicitly (no [category] default — that would emit findings
//       under an unmapped category which the engine's post-toggle
//       filter would silently drop), MUST be non-empty, and every
//       entry MUST itself be a toggle category.

import { pathClassifierCheck } from "./classifiers/path-classifier-check.js";
import { secretsCheck } from "./detectors/secrets.js";
import type { Check, ChecksToggleConfig } from "./types.js";

/**
 * The deterministic list of built-in checks shipped with VibeRevert.
 *
 * Step 3 has landed: `pathClassifierCheck` is at index 0. It emits
 * path-classifier findings first in registry invocation order and locks
 * the architectural intent that path classification is the first
 * built-in analysis family.
 *
 * Step 4 has landed: `secretsCheck` at index 1. Single-category
 * detector with `category: "secrets"` — the toggleable-primary case
 * (no umbrella exception needed; "secrets" is itself a toggle key in
 * CHECKS_TOGGLE_MAP). Scans addedLines for the 8 locked regex
 * patterns from D33; drops matches that fail entropy/placeholder
 * checks (pattern #7 only) without an audit trail; downgrades
 * matches in `*.example` / `*.template` files or on lines with
 * `# pragma: viberevert-allow` / `// viberevert-allow` markers to
 * `level: "low"` (preserves audit trail). See
 * `./detectors/secrets-patterns.ts` + `./detectors/secrets.ts` for
 * full architecture (including the clone-first RegExp discipline
 * and PEM multi-line handling).
 *
 * Important: `riskTagsByPath` is populated by the engine's direct call
 * to the classifier, not as a side effect of
 * `pathClassifierCheck.run()`. Likewise, content detectors do not
 * currently consume prior check output. The index-0 placement is still
 * intentional for deterministic invocation order, diagnostics, and
 * future composition room.
 *
 * Subsequent steps append to this array in order:
 *   - Step 5: dependency detector
 *   - Step 6: migration content detector
 *   - Step 7: test-gap + scope-expansion detectors
 *
 * Order matters per the architectural intent (path-classifier first);
 * the engine preserves array order when invoking `check.run(ctx)`.
 */
export const BUILTIN_CHECKS: readonly Check[] = [pathClassifierCheck, secretsCheck];

/**
 * SINGLE SOURCE OF TRUTH for the `.viberevert.yml` `checks.*` key →
 * emitted-categories mapping. Per D28 in the M C plan.
 *
 * Array-valued because some keys toggle MULTIPLE categories
 * (`infra` → `["infra", "deployment"]`). Reverse-looked-up by
 * `deriveEnabledCategories` to compute the enabled-category set the
 * engine uses for its two-layer toggle filter.
 *
 * Categories NOT listed here (`permissions`, `admin`, `user-data`,
 * `network`, `unknown-large-change`) are reserved for later milestones
 * and are NOT emitted by any check in M C.
 *
 * LOCKED ENGINE-ONLY CATEGORY: the literal `"summary"` category
 * produced by D40's cluster post-process pass is NOT in this map. It
 * is NOT user-toggleable. The engine's post-toggle filter (D28 layer
 * 2) runs BEFORE clustering, so cluster summaries always survive
 * regardless of which `checks.*` keys are enabled.
 */
export const CHECKS_TOGGLE_MAP: Readonly<Record<string, readonly string[]>> = {
  secrets: ["secrets"],
  dependencies: ["dependencies"],
  migrations: ["database"],
  auth: ["auth"],
  payments: ["payments"],
  infra: ["infra", "deployment"],
  tests: ["test-gap"],
  scope_expansion: ["scope-expansion"],
};

/**
 * Reverse-lookup helper: given the resolved toggle config from the CLI,
 * return the SET of categories that are currently enabled.
 *
 * A toggle key that's missing from `configChecks` is treated as `false`
 * (disabled) — defaults are applied UPSTREAM by `mergeChecksConfig` in
 * `cli/src/check-orchestration.ts` per D57. The engine treats the input
 * as the already-fully-defaulted config.
 *
 * A toggle key that's `true` enables ALL categories it maps to.
 *
 * Toggle keys NOT in CHECKS_TOGGLE_MAP are silently ignored (forward-
 * compatible with future config additions that the user might write
 * before checks ships its handler).
 *
 * Returns a fresh ReadonlySet (no caching across invocations) so callers
 * cannot mutate the engine's internal state via the returned reference.
 */
export function deriveEnabledCategories(configChecks: ChecksToggleConfig): ReadonlySet<string> {
  const enabled = new Set<string>();
  for (const [key, categories] of Object.entries(CHECKS_TOGGLE_MAP)) {
    if (configChecks[key] === true) {
      for (const c of categories) enabled.add(c);
    }
  }
  return enabled;
}
