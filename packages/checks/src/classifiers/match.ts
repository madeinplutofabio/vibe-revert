// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Path-classifier matcher.
//
// Wraps picomatch with the LOCKED options for VibeRevert (D32, D56):
//   - dot: true        — patterns like `.env*` match dotfiles
//   - nocase: false    — case-sensitive matching (Linux convention)
//   - posixSlashes: true — defense-in-depth only. The cross-platform
//                          guarantee for backslash normalization is
//                          provided EXPLICITLY by `normalizePathSeparators`
//                          (imported from ../path-normalization.ts) —
//                          picomatch's own posixSlashes flag is
//                          platform-dependent in practice (normalizes
//                          on Windows; treats `\` as a literal escape
//                          character on Linux), so the matcher cannot
//                          rely on it for OS-independent behavior.
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
// TESTABILITY: the matcher splits into layers. Single-path first:
//   - `compilePathRules(rules)` — pure compiler from any rule array
//   - `classifyPathWithCompiledRules(path, frameworks, compiled)` — pure
//     matcher taking pre-compiled rules
//   - `classifyPath(path, frameworks)` — convenience wrapper using
//     production PATH_RULES, compiled once at module load
//
// and the M 0.8.0 step 7 changed-file layers built on those:
//   - `canonicalChangedFilePath(file)` — the changed-file identity
//   - `changedFilePathCandidates(file)` — rename-alias semantics, the SOLE
//     definition of what an alias is
//   - `classifyChangedFileWithCompiledRules(file, frameworks, compiled)` —
//     alias-aware matcher with provenance; the test seam
//   - `classifyChangedFile(file, frameworks)` — production wrapper
//
// `test-gap` deliberately stays on plain `classifyPath(currentPath, …)`; see
// the rename-alias section below for why.
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

import { normalizePathSeparators } from "../path-normalization.js";
import type { ChangedFileInput } from "../types.js";
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
  const normalizedPath = normalizePathSeparators(path);
  const matched: PathRule[] = [];
  for (const { rule, matchPattern, matchAnyExclude } of compiledRules) {
    if (rule.framework !== undefined && !detectedFrameworks.includes(rule.framework)) {
      continue;
    }
    if (matchAnyExclude(normalizedPath)) {
      continue;
    }
    if (matchPattern(normalizedPath)) {
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
 * `path` must be repo-relative, but may contain either `/` or `\`
 * separators. The matcher normalizes backslashes to POSIX slashes
 * before include/exclude matching (see `normalizePathSeparators`).
 * Callers should still avoid absolute paths and `.` / `..` segments —
 * the matcher does not canonicalize those, and patterns are written
 * assuming neither is present.
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

// =============================================================================
// Rename aliases (M 0.8.0 step 7)
// =============================================================================
//
// A rename must not erase where code came from: `payments/webhook.ts` moved to
// `utils/webhook.ts` should retain its payments risk. But the alias influences
// CLASSIFICATION ONLY — never identity. The canonical CURRENT path stays the
// changed-file identity, and remains the sole value any consumer puts in
// `affected_paths` or uses as a path-keyed map key.
//
// `changedFilePathCandidates` is the single definition of what a rename alias
// IS. The richer classifier below builds on it, and so does the engine's tag
// union, so alias semantics cannot drift between them.
//
// `test-gap` deliberately does NOT use any of this. It asks whether THIS diff
// paired a risky change with a test change, so a pure move would otherwise
// start emitting a high-severity finding it never emitted before. If moved
// risky code should require moved tests, that deserves its own rule with a
// trigger distinguishing a pure rename from a substantive edit.

/** Which changed-file alias a path or match came from. */
export type ChangedFilePathSource = "current" | "previous" | "both";

/** One canonical path to classify, tagged with the alias it represents. */
export interface ChangedFilePathCandidate {
  readonly path: string;
  readonly source: ChangedFilePathSource;
}

/**
 * A matched rule plus the provenance a consumer needs to describe it
 * truthfully. `path-classifier-check` emits "File 'X' matches rule 'Y'"; when
 * the match came from the previous path, X does not match Y, and the message
 * must say so rather than assert something false.
 *
 * `currentPath` is the identity. `previousPath` is present only for a rename
 * and is provenance, never identity.
 */
export interface ChangedFilePathRuleMatch {
  readonly rule: PathRule;
  readonly source: ChangedFilePathSource;
  readonly currentPath: string;
  readonly previousPath?: string;
}

/** The canonical changed-file identity for a file. */
export function canonicalChangedFilePath(file: Pick<ChangedFileInput, "path">): string {
  return normalizePathSeparators(file.path);
}

/**
 * The canonical paths a changed file should be classified under.
 *
 * Sole owner of rename-alias semantics: a non-rename yields one candidate; a
 * rename yields current and previous; and if the two canonicalize to the same
 * value they collapse to a single `"both"` candidate rather than classifying
 * the same path twice.
 */
export function changedFilePathCandidates(
  file: Pick<ChangedFileInput, "path" | "previous_path">,
): readonly ChangedFilePathCandidate[] {
  const current = canonicalChangedFilePath(file);
  if (file.previous_path === undefined) {
    return [{ path: current, source: "current" }];
  }
  const previous = normalizePathSeparators(file.previous_path);
  if (previous === current) {
    return [{ path: current, source: "both" }];
  }
  return [
    { path: current, source: "current" },
    { path: previous, source: "previous" },
  ];
}

/** `current` + `previous` collapse to `both`; matching values keep their own. */
function mergeSource(a: ChangedFilePathSource, b: ChangedFilePathSource): ChangedFilePathSource {
  return a === b ? a : "both";
}

/**
 * Alias-aware classification over pre-compiled rules. Test seam, mirroring
 * `classifyPathWithCompiledRules`.
 *
 * Deduped by rule OBJECT identity rather than `rule.id`: both classify calls
 * draw from the same compiled-rule array, so a rule matching both aliases
 * yields the same reference. That is collision-proof without assuming
 * `PATH_RULES` ids are unique, an assumption this module cannot verify. The
 * emit loop additionally guards against the same rule object appearing twice
 * in a supplied compiled-rule array, since `compilePathRules` accepts
 * arbitrary arrays and "no object repeats" would be the same class of
 * unverifiable assumption.
 *
 * Results are emitted in COMPILED-RULE-ARRAY order, not current-then-previous
 * concatenation order. Each `classifyPathWithCompiledRules` call preserves
 * rule order individually, but concatenating them does not: with a table of
 * [A, B], where only the current path matches B and only the previous matches
 * A, naive concatenation yields [B, A].
 */
export function classifyChangedFileWithCompiledRules(
  file: Pick<ChangedFileInput, "path" | "previous_path">,
  detectedFrameworks: readonly string[],
  compiledRules: readonly CompiledPathRule[],
): readonly ChangedFilePathRuleMatch[] {
  const sourceByRule = new Map<PathRule, ChangedFilePathSource>();
  for (const candidate of changedFilePathCandidates(file)) {
    for (const rule of classifyPathWithCompiledRules(
      candidate.path,
      detectedFrameworks,
      compiledRules,
    )) {
      const prior = sourceByRule.get(rule);
      sourceByRule.set(
        rule,
        prior === undefined ? candidate.source : mergeSource(prior, candidate.source),
      );
    }
  }

  const currentPath = canonicalChangedFilePath(file);
  const previousPath =
    file.previous_path === undefined ? undefined : normalizePathSeparators(file.previous_path);

  const matches: ChangedFilePathRuleMatch[] = [];
  const emittedRules = new Set<PathRule>();
  for (const { rule } of compiledRules) {
    if (emittedRules.has(rule)) continue;
    const source = sourceByRule.get(rule);
    if (source === undefined) continue;
    emittedRules.add(rule);
    matches.push({
      rule,
      source,
      currentPath,
      ...(previousPath !== undefined ? { previousPath } : {}),
    });
  }
  return matches;
}

/**
 * Alias-aware classification against production PATH_RULES. The changed-file
 * counterpart to `classifyPath`.
 */
export function classifyChangedFile(
  file: Pick<ChangedFileInput, "path" | "previous_path">,
  detectedFrameworks: readonly string[],
): readonly ChangedFilePathRuleMatch[] {
  return classifyChangedFileWithCompiledRules(file, detectedFrameworks, COMPILED_RULES);
}
