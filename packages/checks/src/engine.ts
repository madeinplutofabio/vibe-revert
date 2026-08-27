// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The checks engine. Pure synchronous function:
// (checks, ctx, opts) -> RunChecksResult | IdentifiedRunChecksResult.
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
//   - riskTagsByPath: union of tags from classifier-rule matches for each
//     changed file, filtered by the enabled-category set. M C only allows
//     the path-classifier to contribute tags (EvidenceSchema has no
//     `tags` field; other detectors cannot structurally contribute).
//   - riskLevelByPath: max(level) across ALL pre-cluster findings, applied
//     to every path in each finding's `affected_paths`, defaulting to "low"
//     for changed files with no matching findings. Computed PRE-clustering
//     so a critical finding that gets swept into a cluster-tail summary
//     STILL surfaces at the file level — locked invariant from D28.
//   - Sort: deterministic [level desc, category asc, id asc, file asc,
//     line asc] applied after clustering per D40.
//
// =============================================================================
// The canonical changed-file identity, and its domain
// =============================================================================
//
//   canonical changed-file identity
//     = normalizePathSeparators(raw ChangedFileInput.path)
//
// `ChangedFileInput.path` is a TRANSPORT representation and may arrive
// Windows-shaped. Detectors already canonicalize it before matching and
// before emitting evidence, because `safeStoredRelativePath` rejects
// backslashes. Step 6 makes that canonical form the IDENTITY: it is what
// detectors put in `affected_paths`, what this engine classifies, and the key
// space for both path-keyed outputs.
//
// Inside this file the rule is therefore:
//   raw file.path   transport/input only
//   canonicalPath   classifier input, affected_paths domain,
//                   riskTagsByPath key, riskLevelByPath key
//
// At the persisted boundary the two coincide: `ChangedFileSchema.path`
// requires canonical POSIX form, so a report whose `changed_files[].path`
// held a backslash could not validate at all. That is why
// `SessionReportSchema`'s `affected_paths ⊆ changed_files[].path` rule still
// holds even though this layer canonicalizes.
//
// A path outside the canonical changed-file set is a detector bug, not a
// supported case — including for a rename, whose identity is the NEW path.
//
// `DetectorResultSchema` CANNOT check this: it has no changed-file context.
// So the engine asserts it separately, at every point where it validates a
// DetectorResult — on raw detector output AND again after clustering.
//
// The post-cluster assertion is not redundant. That boundary exists to
// distrust severity transformations, and severity is precisely the layer
// that could synthesize a canonical-but-out-of-domain path set (a dedup or
// buildClusterSummary bug). Today's severity code only ever unions
// already-valid sets, so it cannot produce one; the boundary defends the
// invariant anyway rather than depending on that remaining true.
//
// On raw output the assertion runs immediately after schema validation and
// BEFORE the category toggle filter, for the same reason schema validation
// does: a finding whose category is later disabled is still not allowed to
// violate the detector contract.
//
// Enforcing this HERE rather than leaving it to the persisted-report
// validator keeps BOTH engine modes honest. A pre-identity caller never
// persists anything, so without these checks it could receive a
// `DetectorResult` that looks fine and could never become a valid report.
//
// Note the contrast with `evidence`, whose `file` is typed only as a
// canonical relative path and is therefore NOT confined to the changed-file
// domain, and which some detectors additionally cap. `evidence` therefore
// cannot be used as the source of truth for `affected_paths`.
//
// =============================================================================
// Two modes, three validation boundaries
// =============================================================================
//
// `opts.reportId` selects the mode BY VALUE, never by key presence:
// `RunChecksOptions.reportId?: undefined` deliberately admits an explicit
// `{ reportId: undefined }`, so `"reportId" in opts` would misclassify it.
//
//   reportId === undefined -> RunChecksResult            DetectorResult[]
//   reportId !== undefined -> IdentifiedRunChecksResult  IdentifiedCheckResult[]
//
// The identity-bearing path validates THREE times, and each boundary proves
// a different contract. None is redundant:
//
//   1. raw detector output, DetectorResultSchema + domain assertion
//        the DETECTOR contract: affected_paths present, canonical, and
//        within the changed-file domain; finding_id structurally impossible.
//   2. post-cluster, DetectorResultSchema + domain assertion
//        the SEVERITY contract: every survivor and every synthetic summary
//        still carries a complete canonical path set WITHIN the changed-file
//        domain, and no identity appeared during aggregation. Without this,
//        a dedup or buildClusterSummary bug would go undetected until AFTER
//        an id had already been derived from an unproven path set.
//   3. post-identity, CheckResultSchema
//        the persisted-finding SHAPE contract: finding_id and affected_paths
//        are coupled and every ordinary constraint still holds. The
//        TypeScript intersection `IdentifiedCheckResult` is a compile-time
//        claim only; it cannot assert anything about a runtime object at a
//        trust boundary. NORMATIVE report-level identity validation (that
//        each finding_id equals its derivation for the report actually being
//        persisted) remains SessionReportSchema's job.
//
// riskLevelByPath is computed from the complete `affected_paths` set rather
// than `evidence[0].file` (its pre-0.8.0 source). Aggregation stays
// PRE-cluster and per-finding at that finding's own level: doing it after
// clustering would let a summary holding one critical and one medium member
// promote the medium member's paths to critical.
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
// engine-internal bugs.

import {
  CheckResultSchema,
  DetectorResultSchema,
  deriveFindingId,
} from "@viberevert/session-format";
import { classifyPath } from "./classifiers/match.js";
import { normalizePathSeparators } from "./path-normalization.js";
import { deriveEnabledCategories } from "./registry.js";
import { clusterFindings, compareLevel, sortFindings } from "./severity.js";
import type {
  Check,
  CheckContext,
  DetectorResult,
  IdentifiedCheckResult,
  IdentifiedRunChecksOptions,
  IdentifiedRunChecksResult,
  RiskLevel,
  RunChecksOptions,
  RunChecksResult,
} from "./types.js";

/**
 * Assert the contextual half of the detector contract, which
 * `DetectorResultSchema` structurally cannot check: every affected path must
 * be a changed-file identity.
 *
 * Reports `finding.id` rather than the owning check's id — for multi-rule
 * checks like path-classifier, the rule-namespaced finding id names the
 * actual offender, and for a cluster summary it names the synthesizing pass.
 */
function assertAffectedPathsWithinChangedFiles(
  finding: DetectorResult,
  changedPathSet: ReadonlySet<string>,
): void {
  for (const path of finding.affected_paths) {
    if (!changedPathSet.has(path)) {
      throw new Error(`finding ${finding.id} has affected path outside the changed files: ${path}`);
    }
  }
}

/**
 * Attach report identity to one finalized finding.
 *
 * The object is statically an `IdentifiedCheckResult` by construction, so no
 * cast is needed. `CheckResultSchema.parse` runs as an INDEPENDENT runtime
 * assertion whose return value is deliberately discarded: it validates the
 * persisted-finding shape, and using its result instead would erase the
 * stronger type back to legacy-compatible `CheckResult`, where both fields
 * are optional again.
 */
function identifyFinding(finding: DetectorResult, reportId: string): IdentifiedCheckResult {
  const identified: IdentifiedCheckResult = {
    ...finding,
    finding_id: deriveFindingId(reportId, finding.id, finding.affected_paths),
  };
  CheckResultSchema.parse(identified);
  return identified;
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
 *      c. Validate each raw finding against DetectorResultSchema.
 *      d. Assert its affected paths are changed files.
 *      e. Layer-2 per-finding filter — drop findings whose category is
 *         disabled.
 *      f. Accumulate surviving findings into the pre-cluster pool.
 *   3. Compute riskTagsByPath via the (injected or default) classifier +
 *      enabled-category filter (M C: path-classifier rules are the only
 *      contributor).
 *   4. Compute riskLevelByPath from the pre-cluster pool — every path in
 *      each finding's affected_paths, with every changed file starting at
 *      "low".
 *   5. Cluster the pre-cluster pool (D40 4-pass post-process).
 *   6. Re-validate the clustered set: DetectorResultSchema + the same
 *      affected-path domain assertion.
 *   7. Sort by the locked D40 key.
 *   8. Pre-identity mode: return the sorted DetectorResults.
 *      Identity mode: derive finding_id per finding, validate each against
 *      CheckResultSchema, and return IdentifiedCheckResults.
 *
 * Throws (engine-internal bug surface):
 *   - If any raw check finding fails DetectorResultSchema validation.
 *   - If any raw check finding names an affected path that is not a changed
 *     file.
 *   - If any clustered finding or cluster summary fails DetectorResultSchema
 *     validation, or names an affected path that is not a changed file
 *     (severity.ts construction bug).
 *   - If any identified finding fails CheckResultSchema validation.
 *   - If `deriveFindingId` rejects a blank reportId or rule id.
 *
 * Detector bugs surfaced as throws are intentional: they mean a check
 * emitted invalid data, which is always a code bug (not user data).
 * Letting them propagate up forces the CLI to surface a clean exit-1
 * rather than silently producing a partial report.
 */
export function runChecks(
  checks: readonly Check[],
  ctx: CheckContext,
  opts: IdentifiedRunChecksOptions,
): IdentifiedRunChecksResult;
export function runChecks(
  checks: readonly Check[],
  ctx: CheckContext,
  opts?: RunChecksOptions,
): RunChecksResult;
export function runChecks(
  checks: readonly Check[],
  ctx: CheckContext,
  opts: RunChecksOptions | IdentifiedRunChecksOptions = {},
): RunChecksResult | IdentifiedRunChecksResult {
  const enabledCategories = deriveEnabledCategories(ctx.configChecks);
  const classify = opts.classifyPath ?? classifyPath;
  // BY VALUE, not `"reportId" in opts` — see this file's header.
  const reportId = opts.reportId;

  // ONE canonical projection of the changed files, used for the domain
  // assertion at both DetectorResult boundaries AND as the key space for both
  // path-keyed outputs. Keying the maps by the raw path while findings carry
  // the canonical one would silently yield two entries for one Windows-shaped
  // file, and a wrong ChangedFile.risk_level rather than a throw.
  const changedFiles = ctx.changedFiles.map((file) => ({
    file,
    canonicalPath: normalizePathSeparators(file.path),
  }));
  const changedPathSet = new Set(changedFiles.map(({ canonicalPath }) => canonicalPath));

  // ---- Steps 2a-2f: run checks, validate, enforce domain, toggle filter ---
  const preClusterFindings: DetectorResult[] = [];
  for (const check of checks) {
    const emitted = check.emittedCategories ?? [check.category];

    // Layer 1: pre-run skip — every emitted category disabled → skip whole check.
    const anyEnabled = emitted.some((cat) => enabledCategories.has(cat));
    if (!anyEnabled) continue;

    // Invoke the check (synchronous).
    const raw = check.run(ctx);

    for (const finding of raw) {
      // Schema validation FIRST (catches detector bugs even when category
      // is later filtered away), then the contextual domain assertion the
      // schema structurally cannot make. Both precede the toggle filter: a
      // finding whose category is later disabled is still not allowed to
      // violate the detector contract.
      const parsed = DetectorResultSchema.parse(finding);
      assertAffectedPathsWithinChangedFiles(parsed, changedPathSet);

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
  //
  // Feed the canonical path to the classifier hook as well. The built-in
  // classifyPath normalizes internally, but injected classifiers are only
  // guaranteed the engine hook contract. Passing the same canonical identity
  // to both keeps default and injected classifier behavior
  // separator-independent.
  const riskTagsByPath = new Map<string, readonly string[]>();
  for (const { canonicalPath } of changedFiles) {
    const matchedRules = classify(canonicalPath, ctx.detectedFrameworks);
    const tags = new Set<string>();
    for (const rule of matchedRules) {
      if (!enabledCategories.has(rule.category)) continue;
      for (const t of rule.tags) tags.add(t);
    }
    riskTagsByPath.set(canonicalPath, [...tags].sort());
  }

  // ---- Step 4: riskLevelByPath (POST-toggle PRE-cluster max across ALL detectors) ----
  // Initialize every changed file to "low" (the default for files with no
  // matching findings, per D28 lock).
  const riskLevelByPath = new Map<string, RiskLevel>();
  for (const { canonicalPath } of changedFiles) {
    riskLevelByPath.set(canonicalPath, "low");
  }
  // Walk pre-cluster findings; for every path in a finding's complete
  // affected_paths, bump that file's level to max(current, finding.level).
  // M 0.8.0 step 6 replaced the former `evidence[0].file` source: evidence is
  // capped presentation data, so a finding spanning six files used to raise
  // only one of them.
  //
  // Every path here is already known to be a changed file, asserted at the
  // detector boundary above, so no membership guard is needed.
  //
  // Advisory findings carry an empty affected_paths and contribute nothing,
  // which is correct — they have no path subject to raise.
  for (const f of preClusterFindings) {
    for (const path of f.affected_paths) {
      const current = riskLevelByPath.get(path) ?? "low";
      if (compareLevel(f.level, current) > 0) {
        riskLevelByPath.set(path, f.level);
      }
    }
  }

  // ---- Steps 5-7: cluster, re-validate, sort -----------------------------
  const clustered = clusterFindings(preClusterFindings);

  // Re-validate the whole clustered set so severity-pipeline construction
  // bugs surface as throws rather than producing schema-invalid output.
  // The pre-cluster findings were already checked, but dedup survivors carry
  // recomputed path unions and cluster summaries are constructed wholesale by
  // severity.ts — neither has been validated yet, and this is the boundary
  // that exists to distrust exactly those transformations.
  const validated = clustered.map((r) => {
    const parsed = DetectorResultSchema.parse(r);
    assertAffectedPathsWithinChangedFiles(parsed, changedPathSet);
    return parsed;
  });

  const sorted = sortFindings(validated);

  // ---- Step 8: return in the mode the caller selected ---------------------
  if (reportId === undefined) {
    return { results: sorted, riskTagsByPath, riskLevelByPath };
  }
  return {
    results: sorted.map((f) => identifyFinding(f, reportId)),
    riskTagsByPath,
    riskLevelByPath,
  };
}
