// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The checks engine. Pure synchronous function: (checks, ctx, opts) -> RunChecksResult.
//
// Per D28's locked architecture:
//   - Two-layer toggle enforcement:
//     1. Pre-run skip: if all of a check's emittedCategories are disabled,
//        skip the check entirely (saves work, lets multi-category checks
//        like path-classifier participate cleanly).
//     2. Post-run per-finding filter: even when a check runs, drop each
//        emitted finding whose category is disabled (handles the case
//        where SOME of a multi-category check's categories are enabled
//        but the specific emission category is not).
//   - Schema validation: every raw CheckResult from a check's run() is
//     validated against CheckResultSchema BEFORE the toggle filter runs
//     (schema violations are detector bugs, not configuration outcomes).
//     The final cluster-summary findings produced by D40 clustering are
//     ALSO validated before returning, catching summary-construction bugs.
//     This keeps severity.ts pure-transformation while ensuring no
//     schema-invalid output ever escapes the engine.
//   - riskTagsByPath: union of tags from classifier-rule matches for each
//     changed file, filtered by the enabled-category set. M C only allows
//     the path-classifier to contribute tags (EvidenceSchema has no
//     `tags` field; other detectors cannot structurally contribute).
//   - riskLevelByPath: max(level) across ALL pre-cluster findings whose
//     evidence[0].file IS A KNOWN CHANGED FILE, defaulting to "low" for
//     changed files with no matching findings. Findings whose
//     evidence[0].file points outside ctx.changedFiles (e.g., test-gap's
//     suggested-missing-test path) STILL appear in `results` — they just
//     do not contribute to riskLevelByPath, which is strictly a
//     per-changed-file aggregation. Computed PRE-clustering so a critical
//     finding that gets swept into a cluster-tail summary STILL surfaces
//     at the file level — locked invariant from D28.
//   - Sort: deterministic [level desc, category asc, id asc, file asc,
//     line asc] applied at the very end (after clustering) per D40.
//
// Dependency injection: the classifier used to compute riskTagsByPath is
// injectable via `opts.classifyPath`, defaulting to the real `classifyPath`
// from `./classifiers/match.js`. This keeps the engine generic — tests can
// inject a synthetic classifier without depending on PATH_RULES, and
// future non-default classifier configurations remain possible without
// engine surgery. Production callers omit the option; the default is used.
//
// All work is synchronous and pure (no I/O, no Date.now(), no
// Math.random()). The engine's only side effect is throwing on
// engine-internal bugs (a detector emits a CheckResult that fails schema
// validation, or a cluster summary is malformed).

import { CheckResultSchema, compareLevel } from "@viberevert/session-format";
import { classifyPath } from "./classifiers/match.js";
import { deriveEnabledCategories } from "./registry.js";
import { clusterFindings, sortFindings } from "./severity.js";
import type { Check, CheckContext, CheckResult, RiskLevel, RunChecksResult } from "./types.js";

/**
 * Options for `runChecks`. Currently exposes a single injectable: the path
 * classifier used to compute `riskTagsByPath`. Reserved for future engine
 * extension points (additional analyzers, custom sort overrides, etc.) —
 * all injectable, all optional.
 *
 * The minimum classifier shape the engine reads is
 * `{ category: string; tags: readonly string[] }`. The default
 * `classifyPath` returns `readonly PathRule[]` which satisfies this shape
 * structurally; tests may inject any object array matching it.
 */
export interface RunChecksOptions {
  readonly classifyPath?: (
    path: string,
    detectedFrameworks: readonly string[],
  ) => readonly { readonly category: string; readonly tags: readonly string[] }[];
}

/**
 * Runs the given checks against the supplied context. PURE + SYNCHRONOUS.
 *
 * Pipeline:
 *   1. Derive the enabled-category set from ctx.configChecks.
 *   2. For each check (in registry order):
 *      a. Layer-1 pre-run skip — if all of the check's emitted categories
 *         are disabled, skip the entire check.
 *      b. Invoke check.run(ctx) → raw findings.
 *      c. Validate each raw finding against CheckResultSchema (catches
 *         detector bugs even for findings later filtered away).
 *      d. Layer-2 per-finding filter — drop findings whose category is
 *         disabled.
 *      e. Accumulate surviving findings into the pre-cluster pool.
 *   3. Compute riskTagsByPath via the (injected or default) classifier +
 *      enabled-category filter (M C: path-classifier rules are the only
 *      contributor).
 *   4. Compute riskLevelByPath from the pre-cluster pool — strictly
 *      scoped to paths in ctx.changedFiles (every changed file gets at
 *      least "low"; findings whose evidence points outside the changed
 *      set do not leak keys into the map).
 *   5. Cluster the pre-cluster pool (D40 4-pass post-process).
 *   6. Validate each cluster summary against CheckResultSchema.
 *   7. Sort the clustered + validated results by the locked D40 key.
 *   8. Return RunChecksResult { results, riskTagsByPath, riskLevelByPath }.
 *
 * Throws (engine-internal bug surface):
 *   - If any raw check finding fails CheckResultSchema validation.
 *   - If any cluster summary fails CheckResultSchema validation
 *     (severity.ts construction bug).
 *
 * Detector bugs surfaced as throws are intentional: they mean a check
 * emitted invalid data, which is always a code bug (not user data).
 * Letting them propagate up forces the CLI to surface a clean exit-1
 * rather than silently producing a partial report.
 */
export function runChecks(
  checks: readonly Check[],
  ctx: CheckContext,
  opts: RunChecksOptions = {},
): RunChecksResult {
  const enabledCategories = deriveEnabledCategories(ctx.configChecks);
  const classify = opts.classifyPath ?? classifyPath;

  // Pre-compute the changed-path set so step 4's riskLevelByPath update is
  // strictly scoped to known changed files (findings with evidence pointing
  // outside the diff, e.g. test-gap's suggested-missing-test path, still
  // appear in `results` but do not leak unknown keys into the map).
  const changedPathSet = new Set(ctx.changedFiles.map((file) => file.path));

  // ---- Steps 2a-2e: run checks, validate, two-layer toggle filter ---------
  const preClusterFindings: CheckResult[] = [];
  for (const check of checks) {
    const emitted = check.emittedCategories ?? [check.category];

    // Layer 1: pre-run skip — every emitted category disabled → skip whole check.
    const anyEnabled = emitted.some((cat) => enabledCategories.has(cat));
    if (!anyEnabled) continue;

    // Invoke the check (synchronous).
    const raw = check.run(ctx);

    for (const finding of raw) {
      // Schema validation FIRST (catches detector bugs even when category
      // is later filtered away).
      const parsed = CheckResultSchema.parse(finding);

      // Layer 2: per-finding filter on category.
      if (!enabledCategories.has(parsed.category)) continue;

      preClusterFindings.push(parsed);
    }
  }

  // ---- Step 3: riskTagsByPath (classifier rules, M C: path-classifier only) ----
  // Tag aggregation per changed file: union of tags from rules that
  // matched, filtered by enabled-category. Files with zero
  // matched-and-enabled rules map to an empty array. Tags within a file
  // are sorted ASCII-asc + deduped to satisfy ChangedFile.risk_tags's
  // schema constraint (sortedUniqueStringArray).
  const riskTagsByPath = new Map<string, readonly string[]>();
  for (const file of ctx.changedFiles) {
    const matchedRules = classify(file.path, ctx.detectedFrameworks);
    const tags = new Set<string>();
    for (const rule of matchedRules) {
      if (!enabledCategories.has(rule.category)) continue;
      for (const t of rule.tags) tags.add(t);
    }
    riskTagsByPath.set(file.path, [...tags].sort());
  }

  // ---- Step 4: riskLevelByPath (POST-toggle PRE-cluster max across ALL detectors) ----
  // Initialize every changed file to "low" (the default for files with no
  // matching findings, per D28 lock).
  const riskLevelByPath = new Map<string, RiskLevel>();
  for (const file of ctx.changedFiles) {
    riskLevelByPath.set(file.path, "low");
  }
  // Walk pre-cluster findings; for each finding whose evidence[0].file is
  // a KNOWN changed file, bump that file's level to max(current, finding.level).
  // Findings pointing at non-changed paths (e.g., test-gap's
  // suggested-missing-test path) are SILENTLY SKIPPED here — they still
  // surface via `results`, but riskLevelByPath is strictly a
  // per-changed-file aggregation.
  for (const f of preClusterFindings) {
    const file = f.evidence[0]?.file;
    if (typeof file !== "string" || file.length === 0) continue;
    if (!changedPathSet.has(file)) continue;
    const current = riskLevelByPath.get(file) ?? "low";
    if (compareLevel(f.level, current) > 0) {
      riskLevelByPath.set(file, f.level);
    }
  }

  // ---- Steps 5-7: cluster, validate summaries, sort -----------------------
  const clustered = clusterFindings(preClusterFindings);

  // Re-validate the final result set so cluster-summary construction bugs
  // surface as throws rather than producing schema-invalid persisted output
  // downstream. The pre-cluster findings were already validated above, but
  // cluster summaries are constructed by severity.ts and have NOT been
  // schema-checked yet. Validating ONLY the summary entries would require
  // identity-based filtering against the pre-cluster set; re-validating the
  // entire post-cluster set is simpler and the CPU cost is negligible at
  // M C's noise-budget caps (≤90 total findings per report).
  const validated = clustered.map((r) => CheckResultSchema.parse(r));

  const sorted = sortFindings(validated);

  return {
    results: sorted,
    riskTagsByPath,
    riskLevelByPath,
  };
}
