// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Selective-rollback selection algebra (M 0.8.0 step 9).
//
// Pure and I/O-free. Takes already-loaded artifacts and returns which change
// groups the user's selectors resolve to.
//
// NOT this module's job: loading artifacts, discovering reports, or proving
// report provenance. The caller that composes verified contribution evidence
// with selector intent must prove a consulted report's
// `source_contribution_sha256` matches that contribution BEFORE calling this
// resolver; receipt serialization happens later and cannot establish
// selection-time provenance retroactively. How an empty result is presented is
// also not decided here.
//
// =============================================================================
// Locked semantics
// =============================================================================
//
// 1. **Two different path relations, deliberately.**
//
//      --only / --except  -> aliases(g) = every entry's `path` PLUS
//                            `previous_path`, so `--only 'payments/**'` still
//                            matches a file renamed out of payments/.
//      --finding / --risk -> currentPaths(g) = entry `path` only.
//
//    Findings are already alias-aware in the right way: a rule matched on a
//    rename's OLD path still records the NEW path in `affected_paths`, and
//    `SessionReportSchema` enforces that. Re-matching findings against aliases
//    would re-apply a translation that already happened. Aliases influence
//    classification; they never influence identity.
//
// 2. **A group no finding touches has NO risk, not "low".** `--risk low`
//    therefore does not mean "everything"; it means every group some
//    low-or-higher finding touches.
//
// 3. **Presence gates intersection, not resolved size.** Every SUPPLIED
//    positive family participates even when it resolves to nothing, so
//    `--only 'does/not/exist/**' --risk critical` is empty rather than the
//    critical groups.
//
// 4. **Failure to resolve a named finding is invalid, never empty.** An
//    unknown id, an ambiguous prefix, or an explicitly-named pathless finding
//    fails the WHOLE resolution, so `--finding typo` stays distinguishable
//    from a finding that legitimately selects nothing.
//
// 5. **No selectors returns `mode: "full"`, and needs no contribution.**
//    Full-session rollback is a different engine that has never required
//    selective-recovery evidence, so discovering that it applies must not
//    depend on loading any. `contribution` is therefore optional, and its
//    absence is only an error once a selector has been supplied.
//
// 6. **Group-atomic throughout.** Matching any alias selects the whole group;
//    excluding any alias excludes the whole group.
//
// The contribution schema does the heavy lifting: each alias belongs to at
// most one change group, and every `change_group_id` equals the id re-derived
// from its complete alias set. So `alias -> group` and `currentPath -> group`
// are unambiguous and need no collision handling. `SessionReportSchema`
// likewise guarantees `finding_id` uniqueness, so multiple prefix matches mean
// genuine ambiguity rather than duplicate rows.

import {
  type RiskLevel,
  riskLevelAtOrAbove,
  type SessionContributionFile,
  type SessionReport,
} from "@viberevert/session-format";
import picomatch from "picomatch";

import { PICOMATCH_OPTIONS } from "./check-orchestration.js";

type ReportFinding = SessionReport["results"][number];

/**
 * A 0.8.0 finding: both identity fields present. Mirrors the schema's coupling
 * refine, which makes a half-populated persisted finding unrepresentable, so
 * this guard cannot disagree with what the schema admits.
 */
type IdentifiedFinding = ReportFinding & {
  readonly finding_id: string;
  readonly affected_paths: readonly string[];
};

function isIdentifiedFinding(finding: ReportFinding): finding is IdentifiedFinding {
  return finding.finding_id !== undefined && finding.affected_paths !== undefined;
}

export interface SelectionSelectors {
  /** Globs matched against group ALIASES. Repeated values union. */
  readonly only: readonly string[];
  /** Globs matched against group ALIASES. Union, then subtracted last. */
  readonly except: readonly string[];
  /** Full `fnd_<64 hex>` ids or unambiguous prefixes. Repeated values union. */
  readonly finding: readonly string[];
  /** A single AT-OR-ABOVE threshold, never a repeatable family. */
  readonly risk?: RiskLevel;
}

export type SelectionInvalidReason =
  | { readonly code: "CONTRIBUTION_REQUIRED" }
  | { readonly code: "REPORT_REQUIRED" }
  | { readonly code: "FINDING_NOT_FOUND"; readonly selector: string }
  | {
      readonly code: "FINDING_PREFIX_AMBIGUOUS";
      readonly selector: string;
      readonly matches: readonly string[];
    }
  | { readonly code: "FINDING_HAS_NO_RESTORABLE_PATH"; readonly findingId: string }
  /**
   * The three below are reachable only through `resolveChangeGroupSelection`,
   * the M 0.9.0 scope-violation bridge. Each means the evaluator and the bound
   * contribution disagree, which is a producer bug rather than user error.
   */
  | { readonly code: "EMPTY_CHANGE_GROUP_SELECTION" }
  | { readonly code: "UNKNOWN_CHANGE_GROUP"; readonly changeGroupId: string }
  | { readonly code: "DUPLICATE_CHANGE_GROUP"; readonly changeGroupId: string };

export type SelectionResolution =
  | { readonly mode: "full" }
  | {
      readonly mode: "selective";
      readonly outcome: "resolved";
      readonly changeGroupIds: readonly string[];
    }
  | { readonly mode: "selective"; readonly outcome: "empty" }
  | {
      readonly mode: "selective";
      readonly outcome: "invalid";
      readonly reason: SelectionInvalidReason;
    };

/**
 * Whether these selectors consult report evidence.
 *
 * Exported so the provenance layer binds a report's origin under exactly the
 * condition this module consults one. Two copies of this rule would let a
 * future report-backed selector be consumed without its provenance proven.
 */
export const selectionRequiresReport = (selectors: SelectionSelectors): boolean =>
  selectors.finding.length > 0 || selectors.risk !== undefined;

interface GroupRelations {
  /** Group id -> every path it owns, current and previous. */
  readonly aliasesByGroup: ReadonlyMap<string, ReadonlySet<string>>;
  /** Current path -> its group id. Previous paths are absent by design. */
  readonly groupByCurrentPath: ReadonlyMap<string, string>;
  /**
   * Every group id, in first-appearance order over `entries`, which the schema
   * guarantees is path-sorted. This is the CANONICAL resolved order and the
   * reason no consumer needs a second sort.
   */
  readonly universe: readonly string[];
}

/**
 * Build the two group relations and the canonical group order, once.
 *
 * Extracted in M 0.9.0 step 3 so the scope-violation entry point below resolves
 * against exactly the same relations and the same ordering as selector-driven
 * resolution. A second inline copy is how two selection authorities would
 * silently disagree about group membership or order, and this project has
 * already paid twice for two authorities over one fact.
 */
function buildGroupRelations(contribution: SessionContributionFile): GroupRelations {
  const aliasesByGroup = new Map<string, Set<string>>();
  const groupByCurrentPath = new Map<string, string>();
  const universe: string[] = [];
  for (const entry of contribution.entries) {
    let aliases = aliasesByGroup.get(entry.change_group_id);
    if (aliases === undefined) {
      aliases = new Set<string>();
      aliasesByGroup.set(entry.change_group_id, aliases);
      universe.push(entry.change_group_id);
    }
    aliases.add(entry.path);
    if (entry.previous_path !== undefined) aliases.add(entry.previous_path);
    groupByCurrentPath.set(entry.path, entry.change_group_id);
  }
  return { aliasesByGroup, groupByCurrentPath, universe };
}

/**
 * Resolve a selection supplied as change-group ids rather than selectors.
 *
 * The M 0.9.0 bridge from a scope violation into selective recovery. A second
 * entry point BESIDE `resolveSelection`, sharing its relations, its ordering and
 * its result type, so everything downstream (`planSelectiveRestore`,
 * `requireAuthorizationPreserved`, the attempt marker, the receipt) is reached
 * through one unchanged path.
 *
 * It is deliberately NOT a widening of `SelectionSelectors`. A raw group id is
 * not a user-facing selector and there is no CLI flag for one; admitting it into
 * the selector type would put an unvalidated internal identifier on the public
 * surface.
 *
 * Returns ids in CANONICAL order, not the caller's. A violation detector has no
 * reason to know the contribution's entry order, and returning its order would
 * make the receipt's group list depend on who asked.
 *
 * Every refusal is a producer bug, not user error: a violation naming a group
 * outside the bound contribution, or naming one twice, means the evaluator and
 * the contribution disagree. Refusing loudly is the point.
 */
export function resolveChangeGroupSelection(input: {
  readonly contribution: SessionContributionFile;
  readonly changeGroupIds: readonly string[];
}): SelectionResolution {
  const { contribution, changeGroupIds } = input;
  const { universe } = buildGroupRelations(contribution);

  if (changeGroupIds.length === 0) {
    // Unlike selectors, which may legitimately match nothing, a violation-driven
    // selection naming no group is incoherent: there would be no violation.
    return {
      mode: "selective",
      outcome: "invalid",
      reason: { code: "EMPTY_CHANGE_GROUP_SELECTION" },
    };
  }

  const known = new Set(universe);
  const seen = new Set<string>();
  for (const groupId of changeGroupIds) {
    if (!known.has(groupId)) {
      return {
        mode: "selective",
        outcome: "invalid",
        reason: { code: "UNKNOWN_CHANGE_GROUP", changeGroupId: groupId },
      };
    }
    if (seen.has(groupId)) {
      return {
        mode: "selective",
        outcome: "invalid",
        reason: { code: "DUPLICATE_CHANGE_GROUP", changeGroupId: groupId },
      };
    }
    seen.add(groupId);
  }

  // Canonical order, and group-atomic by construction: a group id names its
  // whole group, so there is no per-path narrowing to guard against here.
  const resolved = universe.filter((groupId) => seen.has(groupId));
  if (resolved.length !== changeGroupIds.length) {
    // Unreachable given the checks above. Kept because a silent narrowing is the
    // one failure this bridge must never produce.
    throw new Error(
      `change-group selection resolved ${resolved.length} of ${changeGroupIds.length} requested groups`,
    );
  }
  return { mode: "selective", outcome: "resolved", changeGroupIds: resolved };
}

export function resolveSelection(input: {
  readonly contribution?: SessionContributionFile;
  readonly report?: SessionReport;
  readonly selectors: SelectionSelectors;
}): SelectionResolution {
  const { contribution, report, selectors } = input;
  const risk = selectors.risk;

  const onlySupplied = selectors.only.length > 0;
  const exceptSupplied = selectors.except.length > 0;
  const findingSupplied = selectors.finding.length > 0;

  if (!onlySupplied && !exceptSupplied && !findingSupplied && risk === undefined) {
    return { mode: "full" };
  }
  if (contribution === undefined) {
    // Reachable only if a caller supplies selectors without evidence. Step 12
    // normally prevents it, but the resolver stays total rather than trusting
    // that.
    return { mode: "selective", outcome: "invalid", reason: { code: "CONTRIBUTION_REQUIRED" } };
  }

  const { aliasesByGroup, groupByCurrentPath, universe } = buildGroupRelations(contribution);

  const matchByAlias = (patterns: readonly string[]): Set<string> => {
    const matchers = patterns.map((p) => picomatch(p, PICOMATCH_OPTIONS));
    const hit = new Set<string>();
    for (const [groupId, aliases] of aliasesByGroup) {
      for (const alias of aliases) {
        if (matchers.some((m) => m(alias))) {
          hit.add(groupId);
          break;
        }
      }
    }
    return hit;
  };

  const positives: Set<string>[] = [];
  if (onlySupplied) positives.push(matchByAlias(selectors.only));

  if (selectionRequiresReport(selectors)) {
    if (report === undefined) {
      // Not empty: without a report there is no evidence from which to derive
      // group risk or finding identity, and "nothing matched" would read as
      // "there are no critical groups".
      return { mode: "selective", outcome: "invalid", reason: { code: "REPORT_REQUIRED" } };
    }
    const identified = report.results.filter(isIdentifiedFinding);

    if (findingSupplied) {
      const selected = new Set<string>();
      for (const selector of selectors.finding) {
        const [first, ...rest] = identified.filter((f) => f.finding_id.startsWith(selector));
        if (first === undefined) {
          return {
            mode: "selective",
            outcome: "invalid",
            reason: { code: "FINDING_NOT_FOUND", selector },
          };
        }
        if (rest.length > 0) {
          return {
            mode: "selective",
            outcome: "invalid",
            reason: {
              code: "FINDING_PREFIX_AMBIGUOUS",
              selector,
              matches: [first, ...rest].map((f) => f.finding_id),
            },
          };
        }
        if (first.affected_paths.length === 0) {
          // Real finding, but advisory-only: it names no changed-file identity,
          // so there is nothing to restore.
          return {
            mode: "selective",
            outcome: "invalid",
            reason: { code: "FINDING_HAS_NO_RESTORABLE_PATH", findingId: first.finding_id },
          };
        }
        for (const path of first.affected_paths) {
          const groupId = groupByCurrentPath.get(path);
          if (groupId !== undefined) selected.add(groupId);
        }
      }
      positives.push(selected);
    }

    if (risk !== undefined) {
      // groupRisk = max level over findings touching a CURRENT path. A group
      // no finding touches stays absent from this map, hence unselectable at
      // every threshold.
      const riskByGroup = new Map<string, RiskLevel>();
      for (const finding of identified) {
        for (const path of finding.affected_paths) {
          const groupId = groupByCurrentPath.get(path);
          if (groupId === undefined) continue;
          const current = riskByGroup.get(groupId);
          if (current === undefined || riskLevelAtOrAbove(finding.level, current)) {
            riskByGroup.set(groupId, finding.level);
          }
        }
      }
      const selected = new Set<string>();
      for (const [groupId, level] of riskByGroup) {
        if (riskLevelAtOrAbove(level, risk)) selected.add(groupId);
      }
      positives.push(selected);
    }
  }

  // Presence, not size, decides participation (locked semantics 3).
  const start =
    positives.length > 0
      ? universe.filter((groupId) => positives.every((set) => set.has(groupId)))
      : [...universe];

  const excluded = exceptSupplied ? matchByAlias(selectors.except) : new Set<string>();
  const changeGroupIds = start.filter((groupId) => !excluded.has(groupId));

  return changeGroupIds.length === 0
    ? { mode: "selective", outcome: "empty" }
    : { mode: "selective", outcome: "resolved", changeGroupIds };
}
