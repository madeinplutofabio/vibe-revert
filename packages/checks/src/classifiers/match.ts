// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Path-classifier matcher.
//
// Wraps picomatch with the LOCKED options for VibeRevert (D32, D56):
//   - dot: true        — patterns like `.env*` match dotfiles
//   - nocase: false    — case-sensitive matching (Linux convention)
//   - posixSlashes: true — backslash inputs normalized to forward slashes
//                          (secondary guard; primary normalization is done
//                          by the CLI before paths reach checks)
//   - nonegate: true   — patterns beginning with `!` are LITERAL, NOT
//                        negations (matches the M B `rollback.exclude`
//                        semantics from D3 and the M C
//                        `getDiffSinceCheckpoint` `liveExcludePatterns`
//                        semantics from D56)
//
// These options are intended to mirror the glob semantics used by
// `@viberevert/git` for rollback/live exclude filtering. Because
// `@viberevert/git` and `@viberevert/checks` are sibling packages (per
// D16's locked dependency graph + D29's package-boundary rule), they
// cannot share a runtime constant without violating the boundary. The two
// option sets MUST stay aligned by manual review when either side changes
// — there is no compile-time check enforcing parity. Any reviewer
// touching either package's picomatch invocation should cross-check the
// other.
//
// TESTABILITY: the matcher splits into three layers:
//   - `compilePathRules(rules)` — pure compiler from any rule array
//   - `classifyPathWithCompiledRules(path, frameworks, compiled)` — pure
//     matcher taking pre-compiled rules
//   - `classifyPath(path, frameworks)` — convenience wrapper using
//     production PATH_RULES, compiled once at module load
//
// This split lets Step 2's match.test.ts validate framework gating, exclude
// patterns, multi-match, dotfile behavior, nonegate semantics, etc., using
// SYNTHETIC rule arrays — without depending on Step 3's populated
// PATH_RULES table. Production callers use `classifyPath`; tests use
// `compilePathRules` + `classifyPathWithCompiledRules`.
//
// PERFORMANCE: in production, PATH_RULES patterns AND their
// excludePatterns are compiled ONCE at module load (picomatch returns a
// closure-bound matcher function; compilation is pure computation). The
// hot path (`classifyPath` called per-file per-rule) just invokes the
// pre-compiled matchers — no per-call regex parse.
//
// PURITY: this module performs no I/O, makes no Date / random / clock
// calls, and contains no async code per D29.

import picomatch from "picomatch";
import { PATH_RULES, type PathRule } from "./path-rules.js";

/**
 * Locked picomatch options for the M C path classifier. `as const`
 * preserves literal option types at compile time; the constant is
 * module-private and never mutated.
 *
 * M B's `@viberevert/git` currently uses a narrower picomatch option set
 * for rollback.exclude matching. M C sets the path-classifier options
 * explicitly because classifier rules include dotfile-sensitive patterns
 * and because report findings must remain stable across future picomatch
 * default changes. Any future git-side live-exclude filtering added for
 * D56 must be reviewed against this option set so both packages preserve
 * the same user-visible glob semantics.
 */
const MATCH_OPTIONS = {
  dot: true,
  nocase: false,
  posixSlashes: true,
  nonegate: true,
} as const;

/**
 * Pre-compiled rule entry. Returned by `compilePathRules` for each input
 * `PathRule`. Exposed so tests can build synthetic compiled-rule arrays
 * directly when they need to test edge cases of the matcher.
 *
 * `matchAnyExclude` is the array-form picomatch matcher built from
 * `rule.excludePatterns ?? []`: returns `true` if the input matches ANY
 * exclude pattern, `false` otherwise. When the rule has no
 * excludePatterns, this is a constant `() => false`.
 */
export interface CompiledPathRule {
  readonly rule: PathRule;
  readonly matchPattern: (input: string) => boolean;
  readonly matchAnyExclude: (input: string) => boolean;
}

/**
 * Pure compiler: given any array of PathRule, returns the corresponding
 * array of pre-compiled matchers. No I/O, no module-level state — safe
 * to call repeatedly with different rule arrays in tests.
 *
 * Excludes are spread (`[...excludes]`) rather than cast (`as string[]`)
 * so picomatch receives a fresh mutable array — defensive copy that
 * protects callers from any picomatch-internal mutation of its
 * patterns argument.
 */
export function compilePathRules(rules: readonly PathRule[]): readonly CompiledPathRule[] {
  return rules.map((rule) => {
    const excludes = rule.excludePatterns ?? [];
    return {
      rule,
      matchPattern: picomatch(rule.pattern, MATCH_OPTIONS),
      matchAnyExclude:
        excludes.length === 0 ? () => false : picomatch([...excludes], MATCH_OPTIONS),
    };
  });
}

/**
 * Pure matcher: given a path, a framework list, and pre-compiled rules,
 * returns the rules whose match conditions are satisfied. Exposed so
 * tests can drive the matcher with synthetic compiled-rule arrays
 * (verifying framework gating, exclude semantics, multi-match, ordering,
 * etc.) without depending on Step 3's populated PATH_RULES table.
 *
 * Per D32:
 *   - Rules with a `framework` field are evaluated only when that
 *     framework is in `detectedFrameworks`.
 *   - Rules with `excludePatterns` are SKIPPED if any exclude pattern
 *     matches the path.
 *   - Multiple rules may match a single path — each match contributes
 *     independently to tags / findings via the engine's accumulation
 *     step.
 *   - Order is preserved from the compiled-rules array (which preserves
 *     `PATH_RULES` order from path-rules.ts).
 */
export function classifyPathWithCompiledRules(
  path: string,
  detectedFrameworks: readonly string[],
  compiledRules: readonly CompiledPathRule[],
): readonly PathRule[] {
  const matched: PathRule[] = [];
  for (const { rule, matchPattern, matchAnyExclude } of compiledRules) {
    if (rule.framework !== undefined && !detectedFrameworks.includes(rule.framework)) {
      continue;
    }
    if (matchAnyExclude(path)) {
      continue;
    }
    if (matchPattern(path)) {
      matched.push(rule);
    }
  }
  return matched;
}

/**
 * Production PATH_RULES compiled once at module load. The hot path
 * (`classifyPath` called per file per check invocation) uses this
 * pre-compiled cache so no glob is reparsed per call.
 */
const COMPILED_RULES = compilePathRules(PATH_RULES);

/**
 * Returns the production PATH_RULES that match the given path. Convenience
 * wrapper around `classifyPathWithCompiledRules` using the
 * production-defaults compiled rules.
 *
 * `path` MUST be canonical repo-relative POSIX (forward slashes only,
 * no leading slash, no `.` / `..` segments). The CLI normalizes via
 * `safeStoredRelativePath` / `normalizeRelativePath` from
 * `@viberevert/session-format` before paths reach this module. The
 * `posixSlashes: true` option is a defensive secondary guard.
 *
 * In Step 2 PATH_RULES is empty, so this function returns `[]` for
 * every input. Step 3 populates PATH_RULES with the real Laravel +
 * Next.js + Rails + generic table.
 */
export function classifyPath(
  path: string,
  detectedFrameworks: readonly string[],
): readonly PathRule[] {
  return classifyPathWithCompiledRules(path, detectedFrameworks, COMPILED_RULES);
}
