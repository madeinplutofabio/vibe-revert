// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Severity-ordering + finding post-processing helpers.
//
// Re-exports `compareLevel` from @viberevert/session-format as the single
// source of truth for `low < medium < high < critical` ordering (D25). Adds
// the engine's D40 post-process pipeline: `clusterFindings` (4 ordered
// passes: identity dedup → per-category cap → low cap → total cap) and
// `sortFindings` (deterministic byte-stable ordering).
//
// All functions are PURE and SYNCHRONOUS per D29. NO schema validation
// here — clustering is pure transformation; the engine (engine.ts)
// validates raw check outputs AND final clustered summaries before
// returning, keeping clustering decoupled from zod.
//
// D40 LOCKED COUNTS (mirrored from the M C plan, NOT reverse-engineered):
//   - Per-category: ≤30 (29 individual + 1 summary). Schema cap = 40 (10 headroom).
//   - Low: ≤20 (19 individual + 1 summary). Schema cap = 20 (0 headroom — exact match).
//   - Total: ≤90 (89 individual + 1 summary). Schema cap = 100 (10 headroom).
//
// Cluster summaries carry `category: "summary"` (NOT a registered toggle
// key, NOT in CHECKS_TOGGLE_MAP). Their evidence is EvidenceSchema-compliant
// with each entry carrying both `detail` and (where file context exists) `file`.
//
// Persisted user-facing strings (CheckResult.title / message / evidence.detail /
// recommendation) use product-facing language ("summarized", not "clustered",
// no internal decision references). Internal jargon stays in comments and
// machine identifiers like `cluster.<category>-tail`.

import { compareLevel } from "@viberevert/session-format";
import type { CheckResult, Evidence, RiskLevel } from "./types.js";

// Re-export compareLevel so checks-internal code (engine.ts, classifier
// modules) can pull it from here instead of crossing the package boundary
// repeatedly. Single import surface per the M C plan's D25 + D29 spirit.
export { compareLevel };

/** D40 per-category cap: hard limit INCLUDING the summary entry. */
export const CLUSTER_CAP_PER_CATEGORY = 30 as const;
/** D40 low-finding global cap: hard limit INCLUDING the summary entry. */
export const CLUSTER_CAP_LOW = 20 as const;
/** D40 total findings cap: hard limit INCLUDING the summary entry. */
export const CLUSTER_CAP_TOTAL = 90 as const;

/**
 * Maximum number of representative file-evidence entries a cluster summary
 * carries IN ADDITION to the descriptive `evidence[0]` "+N more" entry.
 * Locked at 10 per D40. Cluster summary's `evidence` array therefore has at
 * most 11 entries: `evidence[0]` is the "+N more" summary and
 * `evidence[1..10]` are representative file paths from the dropped set.
 */
const CLUSTER_EVIDENCE_FILE_CAP = 10 as const;

/**
 * D40 cluster-summary recommendation length cap (chars). The summary's
 * `recommendation` is the deterministic concatenation of the first 3
 * distinct recommendations from the clustered set (sorted by
 * `[level desc, id asc]`) joined with `"; "`, then truncated to this length
 * with trailing `"…"` if exceeded.
 */
const CLUSTER_RECOMMENDATION_CAP = 280 as const;

/**
 * Comparator for finding ordering. The locked sort key is
 * `[level desc, category asc, id asc, file asc, line asc]` (D40).
 *
 * Substitutions for undefined fields (applied in the comparator ONLY; the
 * persisted findings remain unchanged):
 *   - missing `evidence[0].line` → 0 (sorts before any numbered line)
 *   - missing `evidence[0].file` → "" (sorts before any path)
 *
 * Guarantees byte-stable ordering across runs.
 */
function compareFindings(a: CheckResult, b: CheckResult): number {
  // level DESC
  const cl = -compareLevel(a.level, b.level);
  if (cl !== 0) return cl;
  // category ASC
  if (a.category < b.category) return -1;
  if (a.category > b.category) return 1;
  // id ASC
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  // file ASC (evidence[0].file)
  const af = a.evidence[0]?.file ?? "";
  const bf = b.evidence[0]?.file ?? "";
  if (af < bf) return -1;
  if (af > bf) return 1;
  // line ASC (evidence[0].line)
  const al = a.evidence[0]?.line ?? 0;
  const bl = b.evidence[0]?.line ?? 0;
  return al - bl;
}

/**
 * Returns a new array of findings sorted by the locked D40 key. Stable
 * (uses Array.prototype.sort which is stable per ES2019). Input is not
 * mutated.
 */
export function sortFindings(findings: readonly CheckResult[]): CheckResult[] {
  return [...findings].sort(compareFindings);
}

// =============================================================================
// clusterFindings — D40's 4-pass post-process
// =============================================================================

/** Identity-based dedup key per D40. */
type DedupKey = string;

function dedupKey(r: CheckResult): DedupKey {
  const e = r.evidence[0];
  const file = e?.file ?? "";
  const line = e?.line ?? 0;
  const detail = e?.detail ?? "";

  // JSON tuple encoding avoids delimiter-collision footguns if any string
  // field contains a separator-like control character.
  return JSON.stringify([r.id, r.category, file, line, detail]);
}

/**
 * Pass 1 — identity-based dedup. Two findings with identical
 * `(id, category, evidence[0].file/.line/.detail)` collapse — keep the
 * higher-level one (via `compareLevel`); same level → keep the first by
 * sort-stable order.
 *
 * Per D40 lock: this does NOT collapse distinct findings from the same
 * check on the same file. Multiple legitimately-distinct findings (e.g.,
 * path-classifier emitting via `path-classifier.<rule.id>` namespacing,
 * secrets emitting per-occurrence) all survive because their `id` or
 * `evidence[0].detail` differs.
 */
function dedupByIdentity(findings: readonly CheckResult[]): CheckResult[] {
  const seen = new Map<DedupKey, CheckResult>();
  for (const f of findings) {
    const key = dedupKey(f);
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, f);
    } else if (compareLevel(f.level, prev.level) > 0) {
      seen.set(key, f);
    }
    // Same level → keep first (already in map).
  }
  return [...seen.values()];
}

/**
 * Builds a cluster-summary CheckResult per D40's locked rules.
 *
 * `clusterId`: e.g., `"cluster.payments-tail"`, `"cluster.low-tail"`,
 * `"cluster.tail"`.
 * `clustered`: the dropped findings being summarized. MUST be non-empty.
 */
function buildClusterSummary(clusterId: string, clustered: readonly CheckResult[]): CheckResult {
  if (clustered.length === 0) {
    // Defensive — never called with empty per the callers below.
    throw new Error(`buildClusterSummary: clustered must be non-empty for ${clusterId}`);
  }

  // Level: cluster.low-tail is "low" by definition; others = max via compareLevel.
  let level: RiskLevel;
  if (clusterId === "cluster.low-tail") {
    level = "low";
  } else {
    level = clustered.reduce<RiskLevel>(
      (acc, f) => (compareLevel(f.level, acc) > 0 ? f.level : acc),
      "low",
    );
  }

  // Recommendation: required if level ∈ {high, critical} per M B
  // CheckResultSchema refine. Per D40: concatenate first 3 distinct
  // recommendations from clustered findings (sorted by [level desc, id asc])
  // joined with "; ", capped at CLUSTER_RECOMMENDATION_CAP chars with trailing
  // "…" if exceeded. For low/medium: omitted by default.
  let recommendation: string | undefined;
  if (level === "high" || level === "critical") {
    const candidates = [...clustered]
      .filter(
        (f): f is CheckResult & { recommendation: string } =>
          typeof f.recommendation === "string" && f.recommendation.length > 0,
      )
      .sort((a, b) => {
        const cl = -compareLevel(a.level, b.level);
        if (cl !== 0) return cl;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
    const seenRec = new Set<string>();
    const distinct: string[] = [];
    for (const c of candidates) {
      if (!seenRec.has(c.recommendation)) {
        seenRec.add(c.recommendation);
        distinct.push(c.recommendation);
        if (distinct.length === 3) break;
      }
    }
    // Fallback if no clustered finding carries a recommendation (shouldn't
    // happen because high/critical findings MUST carry recommendations per
    // M B refine, but be defensive so the schema doesn't reject the
    // cluster summary itself):
    const joined =
      distinct.length > 0
        ? distinct.join("; ")
        : "Review the summarized high-risk findings before proceeding.";
    recommendation =
      joined.length > CLUSTER_RECOMMENDATION_CAP
        ? `${joined.slice(0, CLUSTER_RECOMMENDATION_CAP - 1)}…`
        : joined;
  }

  // Evidence: paths sorted ASCII-asc, deduped, capped to
  // CLUSTER_EVIDENCE_FILE_CAP representative entries beyond the descriptive
  // "+N more" summary entry. Per D40 locked construction:
  //   evidence[0]:    { detail: "+N more findings summarized", file: <first dropped path> }
  //   evidence[1..N]: { detail: "representative summarized finding", file: <next paths> }
  const pathsSet = new Set<string>();
  for (const f of clustered) {
    const file = f.evidence[0]?.file;
    if (typeof file === "string" && file.length > 0) pathsSet.add(file);
  }
  const paths = [...pathsSet].sort();
  const evidence: Evidence[] = [];
  if (paths.length === 0) {
    // No file context in any clustered finding (e.g., all
    // command-evidence findings). Schema requires evidence.min(1) and
    // EvidenceSchema.detail is nonBlankString; emit a single descriptive
    // entry without `file`.
    evidence.push({ detail: `+${clustered.length} more findings summarized` });
  } else {
    const first = paths[0] as string;
    evidence.push({ detail: `+${clustered.length} more findings summarized`, file: first });
    const rest = paths.slice(1, 1 + CLUSTER_EVIDENCE_FILE_CAP);
    for (const p of rest) {
      evidence.push({ detail: "representative summarized finding", file: p });
    }
  }

  const result: CheckResult = {
    id: clusterId,
    title: `${clustered.length} additional finding${clustered.length === 1 ? "" : "s"} summarized`,
    level,
    confidence: "high",
    category: "summary",
    message: `VibeRevert summarized ${clustered.length} additional finding${
      clustered.length === 1 ? "" : "s"
    } to keep this report readable. See evidence for representative file paths.`,
    evidence,
    ...(recommendation !== undefined ? { recommendation } : {}),
  };
  return result;
}

/**
 * Pass 2 — per-category cap. For any single category with >
 * CLUSTER_CAP_PER_CATEGORY entries, keep the first
 * (CLUSTER_CAP_PER_CATEGORY - 1) by sort order and replace the rest with
 * ONE `cluster.<category>-tail` summary.
 *
 * Categories not exceeding the cap pass through unchanged.
 */
function applyPerCategoryCap(findings: readonly CheckResult[]): CheckResult[] {
  // Group by category, preserving original order within groups.
  const groups = new Map<string, CheckResult[]>();
  for (const f of findings) {
    const arr = groups.get(f.category);
    if (arr === undefined) groups.set(f.category, [f]);
    else arr.push(f);
  }
  const output: CheckResult[] = [];
  for (const [category, group] of groups) {
    if (group.length <= CLUSTER_CAP_PER_CATEGORY) {
      output.push(...group);
      continue;
    }
    // Sort the group by the locked finding order, take first (cap - 1),
    // cluster the rest into ONE summary.
    const sorted = [...group].sort(compareFindings);
    const keep = sorted.slice(0, CLUSTER_CAP_PER_CATEGORY - 1);
    const drop = sorted.slice(CLUSTER_CAP_PER_CATEGORY - 1);
    output.push(...keep, buildClusterSummary(`cluster.${category}-tail`, drop));
  }
  return output;
}

/**
 * Pass 3 — low-finding global cap. If > CLUSTER_CAP_LOW low findings
 * remain after pass 2, keep the first (CLUSTER_CAP_LOW - 1) by sort order
 * and replace the rest with ONE `cluster.low-tail` summary.
 *
 * Non-low findings pass through untouched.
 */
function applyLowCap(findings: readonly CheckResult[]): CheckResult[] {
  const lows = findings.filter((f) => f.level === "low");
  if (lows.length <= CLUSTER_CAP_LOW) return [...findings];
  const sortedLows = [...lows].sort(compareFindings);
  const keepLows = new Set(sortedLows.slice(0, CLUSTER_CAP_LOW - 1));
  const dropLows = sortedLows.slice(CLUSTER_CAP_LOW - 1);
  const output: CheckResult[] = [];
  let droppedSummaryAdded = false;
  for (const f of findings) {
    if (f.level !== "low") {
      output.push(f);
      continue;
    }
    if (keepLows.has(f)) {
      output.push(f);
    } else if (!droppedSummaryAdded) {
      output.push(buildClusterSummary("cluster.low-tail", dropLows));
      droppedSummaryAdded = true;
    }
    // else: silently drop (already captured in the summary).
  }
  return output;
}

/**
 * Pass 4 — total cap. If > CLUSTER_CAP_TOTAL findings remain after passes
 * 1-3, keep the first (CLUSTER_CAP_TOTAL - 1) by sort order and replace
 * the rest with ONE `cluster.tail` summary.
 */
function applyTotalCap(findings: readonly CheckResult[]): CheckResult[] {
  if (findings.length <= CLUSTER_CAP_TOTAL) return [...findings];
  const sorted = [...findings].sort(compareFindings);
  const keep = sorted.slice(0, CLUSTER_CAP_TOTAL - 1);
  const drop = sorted.slice(CLUSTER_CAP_TOTAL - 1);
  return [...keep, buildClusterSummary("cluster.tail", drop)];
}

/**
 * D40's full 4-pass post-process pipeline. Caller is expected to invoke
 * `sortFindings` on the result to produce the final byte-stable ordering.
 *
 * Passes (LOCKED order):
 *   1. Identity-based dedup
 *   2. Per-category cap (≤30 = 29 + 1 summary)
 *   3. Low-finding global cap (≤20 = 19 + 1 summary)
 *   4. Total cap (≤90 = 89 + 1 summary)
 *
 * Cluster summaries are EvidenceSchema-compliant: each entry carries
 * `detail` (non-blank), and where file context exists, `file` (canonical
 * relative POSIX path).
 *
 * Cluster-summary findings carry `category: "summary"`. Their `level` is
 * `"low"` for `cluster.low-tail` (by definition) and `max(...clustered)`
 * for the other two. When level ∈ {"high", "critical"}, `recommendation`
 * is populated from the first 3 distinct recommendations of clustered
 * findings, joined and truncated to CLUSTER_RECOMMENDATION_CAP chars,
 * satisfying M B's CheckResultSchema refine.
 */
export function clusterFindings(findings: readonly CheckResult[]): CheckResult[] {
  const afterDedup = dedupByIdentity(findings);
  const afterCategoryCap = applyPerCategoryCap(afterDedup);
  const afterLowCap = applyLowCap(afterCategoryCap);
  const afterTotalCap = applyTotalCap(afterLowCap);
  return afterTotalCap;
}
