// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Path-classifier rule definitions.
//
// Per D32 in the M C plan: classifiers are TYPESCRIPT DATA TABLES, not
// hard-coded if/switch chains. Each PathRule maps a glob pattern (POSIX,
// case-sensitive, picomatch syntax) to a risk category, a baseline
// finding level, a set of tags that contribute to ChangedFile.risk_tags,
// and optionally a framework filter (rule applies only when that
// framework is detected) plus test-sibling patterns (used by the D36
// test-gap check) plus exclude patterns (suppression — e.g., the
// `laravel.env` rule's exclude of `.env.example` so the secrets-related
// rule does not double-fire alongside D33 detector suppression).
//
// STEP 2 STATE: this file ships as a STUB. The PathRule interface is
// fully defined here so subsequent modules (match.ts, engine.ts via
// classifyPath) can compile and unit-test against it. The PATH_RULES
// array is intentionally empty — Step 3 of M C populates it with the
// full table (Laravel + Next.js + Rails + generic git/CI/IaC rules).
//
// Until Step 3 lands, classifyPath returns `[]` for every input, the
// engine emits zero path-classifier findings, and riskTagsByPath is
// uniformly empty across every changed file. This is the intended skeleton
// behavior — the engine is wired and tested end-to-end against synthetic
// classifier inputs (via runChecks's `opts.classifyPath` injection)
// without depending on real rule data.

import type { RiskLevel } from "@viberevert/session-format";

/**
 * One classifier rule. Per D32, all fields are READONLY at the type level
 * and the table is treated as compile-time data.
 *
 * `pattern`: POSIX glob string with forward slashes. Matched
 * case-SENSITIVELY by picomatch with the locked options
 * `{ dot: true, nocase: false, posixSlashes: true, nonegate: true }` — see
 * `./match.ts`. All paths passed to picomatch are normalized to
 * repo-relative POSIX BEFORE matching (the primary normalization
 * mechanism; `posixSlashes: true` is a secondary guard).
 *
 * `category`: the M C risk-category label this rule contributes to. MUST
 * match a category value present in `CHECKS_TOGGLE_MAP` from
 * `../registry.ts` — otherwise the engine's two-layer toggle filter
 * will silently drop findings under that category. The registry-invariant
 * test enforces this at dev time.
 *
 * `framework`: when set, the rule is evaluated ONLY if `framework` is in
 * `ctx.detectedFrameworks` (resolved by the CLI per D41 + D42). When
 * omitted, the rule is always evaluated (the "Generic" tier).
 *
 * `tags`: contributes to `ChangedFile.risk_tags` when this rule matches.
 * The engine unions tags from all matching rules per file, dedupes, and
 * sorts ASCII-asc.
 *
 * `defaultLevel`: the baseline finding level the path-classifier check
 * emits when this rule matches. Step 3's path-classifier-check.ts uses
 * this as the `CheckResult.level` for the emitted finding.
 *
 * `testSiblingPatterns`: optional list of glob patterns that, if matched
 * by ANY sibling file in the same diff, satisfy the test-gap check (D36)
 * for files matching this rule. Diff-scoped: pre-existing tests in the
 * repo that weren't changed in the diff do NOT count.
 *
 * `excludePatterns`: optional suppression list. Paths matching ANY of
 * these patterns are NOT classified by this rule. Used to exclude
 * template/example files from secret-related rules (e.g., the
 * `laravel.env` rule excludes `.env.example`, `**\/.env.example`, etc.)
 * so they don't double-fire alongside D33 detector suppression. The
 * match step in `./match.ts` calls picomatch on each excludePattern;
 * if any matches the file path, the rule does NOT classify that path.
 */
export interface PathRule {
  readonly id: string;
  readonly pattern: string;
  readonly category: string;
  readonly framework?: string;
  readonly tags: readonly string[];
  readonly defaultLevel: RiskLevel;
  readonly testSiblingPatterns?: readonly string[];
  readonly excludePatterns?: readonly string[];
}

/**
 * The classifier rule table. SHIPS EMPTY IN STEP 2 — Step 3 of M C
 * populates with the full Laravel + Next.js + Rails + generic table per
 * D32's locked design.
 */
export const PATH_RULES: readonly PathRule[] = [];
