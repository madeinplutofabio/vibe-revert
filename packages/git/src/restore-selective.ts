// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Selective restore, phase 1: eligibility planning (M 0.8.0 step 10A/10B).
//
// READ-ONLY and NON-MUTATING, not mathematically pure: it observes path states,
// reads the index, queries one git capability, and enumerates filesystem
// topology. What it never does is mutate -- no checkpoint, no oracle, no
// writes, and no object-store reads.
//
// Deliberately absent per the locked design: transplant, oracle construction,
// evidence validation, the protected-domain snapshot, the fence, and the
// attempt marker. Those are 10B/10E/10F. Nothing here is command-reachable.
//
// =============================================================================
// Gather, then derive (10B)
// =============================================================================
//
// The topology algebra of stages B through D is PURE given fixed observations,
// so it lives in `deriveSelectiveTopology` and the I/O that feeds it lives in
// `planSelectiveRestore`:
//
//     planSelectiveRestore   stage A, then gathers descendants and ancestor
//                            states, then calls the derivation
//     deriveSelectiveTopology  stages B/C1a/C1b/C2/D over lookup callbacks
//
// Plan stabilization (10B) runs the SAME derivation against the protected-domain
// snapshot `S`, which is why it exists as a shared function rather than being
// reimplemented there. Two definitions of selective topology would be exactly
// the drift the extraction exists to prevent.
//
// This changes WHEN observations happen, not what planning means. C1b used to
// read an ancestor lazily on reaching it; the gather phase now reads the same
// set up front, sequentially and in deterministic order. The planner never had
// an atomic-observation guarantee, and it does not gain or lose one here.
// Movement around observation windows is stabilization's problem, not this
// function's.
//
// The lookup callbacks are LOOKUP-ONLY AND COMPLETE. A path the caller did not
// gather is an internal construction error and throws. Real absence is
// `PathState.worktree.kind === "absent"`, never a missing entry.
//
// =============================================================================
// The physical transition model (design §4)
// =============================================================================
//
// The contribution is ENTRY-keyed; restoration is PATH-keyed, and for a rename
// those differ. A rename entry's `before` is the state of `previous_path` and
// its `after` is the state of `path` -- two DIFFERENT physical paths.
//
// `acceptRenameProposals` admits a rename only when all four corners hold, and
// `present` is a disjunction over BOTH axes, so `!present` means fully absent on
// worktree and index. That licenses the implicit corners:
//
//     OLD.before = entry.before        OLD.after = ABSENT_PATH_STATE
//     NEW.before = ABSENT_PATH_STATE   NEW.after = entry.after
//
// =============================================================================
// Git does not represent every real path
// =============================================================================
//
// Two consequences, and they are the same fact twice:
//
//   1. Restoring `foo/bar.txt` when `foo/` is absent needs a directory write the
//      contribution has no entry for -- hence synthetic parents, planned
//      explicitly rather than hidden in a leaf materializer.
//   2. A destructive directory transition walks intermediate directories that
//      are likewise unrepresented. They therefore cannot be REQUIRED to have
//      candidates -- but that does NOT make every physical directory disposable:
//      an unrelated empty directory beneath the transition is real state the
//      selection has no authority to destroy.
//
// `change_group_id` is selection provenance, not an ownership model for
// physical writes -- hence one flat `operations` list.

import type {
  PathState,
  SessionContributionEntry,
  SessionContributionFile,
} from "@viberevert/session-format";

import { type CurrentDescendant, enumerateDescendants } from "./fs-topology.js";
import { gitCheckoutSymlinksEnabled } from "./git-cli.js";
import {
  type IndexSnapshot,
  observePathState,
  pathStateEqual,
  readIndexSnapshot,
} from "./path-state.js";

export const ABSENT_PATH_STATE: PathState = {
  worktree: { kind: "absent" },
  index: { kind: "absent" },
};

/**
 * The target of a synthetic parent.
 *
 * A synthetic parent exists ONLY because a worktree directory is needed. It has
 * no authority to alter that path's INDEX state, which may legitimately hold an
 * unrelated entry:
 *
 *     current:  foo.worktree = absent,  foo.index = entry
 *     selected: foo/bar.txt.worktree = regular
 *
 * Coherent, and `foo/` must be created while PRESERVING that index entry.
 *
 *     restore_candidate        restores BOTH axes to historical BEFORE
 *     create_parent_directory  worktree topology support only;
 *                              PRESERVES the current index axis
 */
function parentDirectoryTarget(observed: PathState): PathState {
  return { worktree: { kind: "directory" }, index: observed.index };
}

// =============================================================================
// Types
// =============================================================================

export interface PhysicalRestoreCandidate {
  readonly path: string;
  readonly changeGroupId: string;
  readonly expectedBefore: PathState;
  readonly expectedAfter: PathState;
}

export type SelectiveRestoreDisposition = "restore_required" | "already_at_before";

export type PlanningConflictReason =
  | { readonly code: "MODIFIED_SINCE" }
  | { readonly code: "UNSUPPORTED_STATE"; readonly detail: string };

export interface SelectiveRestoreClassification {
  readonly path: string;
  readonly changeGroupId: string;
  readonly expectedBefore: PathState;
  readonly expectedAfter: PathState;
  /**
   * Exact phase-1 observation. Retained for PLAN STABILIZATION against the
   * protected-domain snapshot (design §10), not merely diagnostic or preview
   * data. Do not remove it as redundant with `expectedAfter`.
   */
  readonly observed: PathState;
  readonly outcome:
    | { readonly kind: "planned"; readonly disposition: SelectiveRestoreDisposition }
    | { readonly kind: "conflict"; readonly reason: PlanningConflictReason };
}

export interface SelectiveRestoreConflict {
  readonly changeGroupId: string;
  readonly path: string;
  readonly reason: PlanningConflictReason;
}

export type SelectiveRestoreOperation =
  | {
      readonly kind: "restore_candidate";
      readonly path: string;
      readonly changeGroupId: string;
      readonly target: PathState;
      readonly observed: PathState;
    }
  | {
      readonly kind: "create_parent_directory";
      readonly path: string;
      readonly target: PathState;
      readonly observed: PathState;
      readonly requiredBy: readonly string[];
    };

/**
 * Preconditions under which eligibility was decided, frozen into the plan so a
 * later slice can tell whether it was produced under symlink-capable semantics.
 */
export interface SelectiveRestoreCapabilities {
  readonly symlinkCheckout: boolean;
}

export type SelectiveRestorePlan =
  | {
      readonly outcome: "eligible";
      readonly capabilities: SelectiveRestoreCapabilities;
      readonly selectedChangeGroupIds: readonly string[];
      readonly classifications: readonly SelectiveRestoreClassification[];
      /** Paths that must REMAIN directories though nothing writes them. */
      readonly topologyDependencyPaths: readonly string[];
      readonly operations: readonly SelectiveRestoreOperation[];
      readonly conflicts: readonly [];
    }
  | {
      readonly outcome: "noop";
      readonly capabilities: SelectiveRestoreCapabilities;
      readonly selectedChangeGroupIds: readonly string[];
      readonly classifications: readonly SelectiveRestoreClassification[];
      readonly topologyDependencyPaths: readonly string[];
      readonly operations: readonly [];
      readonly conflicts: readonly [];
    }
  | {
      readonly outcome: "conflicted";
      readonly capabilities: SelectiveRestoreCapabilities;
      readonly selectedChangeGroupIds: readonly string[];
      readonly classifications: readonly SelectiveRestoreClassification[];
      readonly topologyDependencyPaths: readonly string[];
      readonly operations: readonly [];
      readonly conflicts: readonly SelectiveRestoreConflict[];
    };

/**
 * Fixed observations the topology algebra runs over.
 *
 * Both callbacks are LOOKUP-ONLY AND COMPLETE: they answer from data the caller
 * already gathered and throw for anything else. `deriveSelectiveTopology` cannot
 * tell a silently-empty callback from a genuinely empty directory, so that
 * contract lives with the caller who builds them.
 */
export interface SelectiveTopologyInputs {
  readonly classifications: readonly SelectiveRestoreClassification[];
  /** Every CURRENT descendant of a destructive-directory root. */
  readonly descendantsOf: (path: string) => readonly CurrentDescendant[];
  /** Observed state of an ancestor that is NOT itself a classification. */
  readonly ancestorStateOf: (path: string) => PathState;
  /** Every path the index currently holds an entry for. */
  readonly indexPopulation: ReadonlySet<string>;
}

export interface SelectiveTopologyDerivation {
  readonly topologyDependencyPaths: readonly string[];
  /** Empty when `conflicts` is non-empty, mirroring the plan's refusal shape. */
  readonly operations: readonly SelectiveRestoreOperation[];
  readonly conflicts: readonly SelectiveRestoreConflict[];
}

// =============================================================================
// Invariant accessors
// =============================================================================
//
// An impossible lookup is a planner bug, never a reason to shrink the
// executable footprint or fabricate evidence. It throws rather than falling
// back, so a broken invariant cannot become a synthetic operation built on
// invented state.

function requireClassification(
  byPath: ReadonlyMap<string, SelectiveRestoreClassification>,
  path: string,
): SelectiveRestoreClassification {
  const value = byPath.get(path);
  if (value === undefined) {
    throw new Error(`missing selective-restore classification for ${JSON.stringify(path)}`);
  }
  return value;
}

// =============================================================================
// Candidate derivation (§4)
// =============================================================================

export function derivePhysicalCandidates(
  entry: SessionContributionEntry,
): readonly PhysicalRestoreCandidate[] {
  if (entry.operation === "renamed") {
    if (entry.previous_path === undefined) {
      // NEVER reinterpret malformed rename evidence as an ordinary entry: that
      // would plan one physical endpoint of a two-endpoint change and leave the
      // other alias untouched. A validated contribution cannot reach here.
      throw new Error(
        `contribution entry ${JSON.stringify(entry.path)} has operation "renamed" but no previous_path`,
      );
    }
    return [
      {
        path: entry.previous_path,
        changeGroupId: entry.change_group_id,
        expectedBefore: entry.before,
        expectedAfter: ABSENT_PATH_STATE,
      },
      {
        path: entry.path,
        changeGroupId: entry.change_group_id,
        expectedBefore: ABSENT_PATH_STATE,
        expectedAfter: entry.after,
      },
    ];
  }
  return [
    {
      path: entry.path,
      changeGroupId: entry.change_group_id,
      expectedBefore: entry.before,
      expectedAfter: entry.after,
    },
  ];
}

// =============================================================================
// Predicates
// =============================================================================

const worktreePresent = (s: PathState): boolean => s.worktree.kind !== "absent";

/**
 * A write that must create an OS symlink.
 *
 * WORKTREE AXIS ONLY. An index entry with mode `120000` does NOT require one:
 *
 *     BEFORE: worktree absent, index entry { mode: 120000 }
 *
 * restores with `update-index --cacheinfo 120000,<oid>,path` and touches no
 * filesystem link. Same for the mixed case `worktree regular / index 120000`,
 * where the materializer writes a regular file. `core.symlinks` is a worktree
 * MATERIALIZATION capability, not an index REPRESENTATION capability, and
 * conflating them would refuse coherent states this planner can restore.
 */
function requiresSymlinkCreation(target: PathState): boolean {
  return target.worktree.kind === "symlink";
}

/** States Step 10 cannot materialize, checked on BOTH the observed and target sides. */
function unsupportedStateDetail(observed: PathState, target: PathState): string | undefined {
  for (const [label, state] of [
    ["current", observed],
    ["target", target],
  ] as const) {
    if (state.index.kind === "unmerged") return `${label} index entry is unmerged`;
    if (state.index.kind === "entry" && state.index.mode === "160000") {
      return `${label} index entry is a gitlink (submodule)`;
    }
    if (state.worktree.kind === "unsupported") {
      return `${label} worktree state is unsupported (${state.worktree.fs_kind})`;
    }
  }
  return undefined;
}

/** `"a/b/c.txt"` -> `["a", "a/b"]`, outermost first. */
function ancestorsOf(path: string): readonly string[] {
  const segments = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i += 1) out.push(segments.slice(0, i).join("/"));
  return out;
}

/** A directory replaced by anything else destroys everything beneath it. */
function destroysDescendants(observed: PathState, target: PathState): boolean {
  return observed.worktree.kind === "directory" && target.worktree.kind !== "directory";
}

/** The write footprint: candidates that actually require a write, sorted. */
function writePathsOf(
  classifications: readonly SelectiveRestoreClassification[],
): readonly string[] {
  return classifications
    .filter((c) => c.outcome.kind === "planned" && c.outcome.disposition === "restore_required")
    .map((c) => c.path)
    .sort();
}

// =============================================================================
// Stage A
// =============================================================================

function classify(
  observed: PathState,
  candidate: PhysicalRestoreCandidate,
  symlinkCheckout: boolean,
): SelectiveRestoreClassification["outcome"] {
  // Exact BEFORE wins FIRST: a repeat restore is a no-op even for a shape we
  // could not otherwise materialize, because no write is required. That is why
  // the symlink-capability check sits BELOW this branch.
  if (pathStateEqual(observed, candidate.expectedBefore)) {
    return { kind: "planned", disposition: "already_at_before" };
  }
  if (!symlinkCheckout && requiresSymlinkCreation(candidate.expectedBefore)) {
    return {
      kind: "conflict",
      reason: {
        code: "UNSUPPORTED_STATE",
        detail: "restoring this path would create a symlink, but core.symlinks is false",
      },
    };
  }
  const detail = unsupportedStateDetail(observed, candidate.expectedBefore);
  if (detail !== undefined) {
    return { kind: "conflict", reason: { code: "UNSUPPORTED_STATE", detail } };
  }
  if (pathStateEqual(observed, candidate.expectedAfter)) {
    return { kind: "planned", disposition: "restore_required" };
  }
  // Fallback, so an unrecognized shape is never silently treated as safe.
  return { kind: "conflict", reason: { code: "MODIFIED_SINCE" } };
}

// =============================================================================
// Stages B through D: the topology algebra
// =============================================================================

/**
 * Derive the executable footprint from FIXED observations.
 *
 * Pure and synchronous. Shared verbatim between phase-1 planning, which feeds it
 * live observations, and plan stabilization, which feeds it the protected-domain
 * snapshot `S`. Neither owns a private copy of these rules.
 *
 * Stage-A conflicts are NOT re-reported here: the caller already holds them on
 * the classifications. What this returns are the conflicts topology itself
 * discovers.
 */
export function deriveSelectiveTopology(
  inputs: SelectiveTopologyInputs,
): SelectiveTopologyDerivation {
  const { classifications, descendantsOf, ancestorStateOf, indexPopulation } = inputs;
  const byPath = new Map(classifications.map((c) => [c.path, c] as const));
  const conflicts: SelectiveRestoreConflict[] = [];

  // ---- Stage B -------------------------------------------------------------
  const writePaths = writePathsOf(classifications);

  // ---- Stage C1a: destructive-directory descendants ------------------------
  //
  // Group id is irrelevant: the selection is atomic. Compatibility is PER-AXIS,
  // so a descendant whose BEFORE worktree is absent but whose BEFORE index is an
  // entry is coherent here, and C2 decides it.
  //
  // Three passes, because a directory's safety depends on what lies BENEATH it
  // and that is not known until every leaf has been classified.
  for (const path of writePaths) {
    const c = requireClassification(byPath, path);
    if (!destroysDescendants(c.observed, c.expectedBefore)) continue;
    const descendants = descendantsOf(path);

    // Pass 1: leaves, and directories that ARE selected candidates. "Covered"
    // means the transition legitimately accounts for this path's removal.
    const covered = new Set<string>();
    for (const descendant of descendants) {
      const candidate = byPath.get(descendant.path);
      if (candidate === undefined) {
        if (descendant.kind === "leaf") {
          conflicts.push({
            changeGroupId: c.changeGroupId,
            path,
            reason: {
              code: "UNSUPPORTED_STATE",
              detail: `removing or replacing ${path} would destroy ${descendant.path}, which the resolved selection does not cover`,
            },
          });
        }
        continue; // directories are decided in pass 3
      }
      if (worktreePresent(candidate.expectedBefore)) {
        conflicts.push({
          changeGroupId: candidate.changeGroupId,
          path: descendant.path,
          reason: {
            code: "UNSUPPORTED_STATE",
            detail: `${descendant.path} has a present BEFORE worktree state but ${path} restores to a non-directory, so it cannot exist beneath it`,
          },
        });
        continue;
      }
      covered.add(descendant.path);
    }

    // Pass 2: mark every intermediate directory that contains covered state.
    const containsCovered = new Set<string>();
    for (const coveredPath of covered) {
      for (const ancestor of ancestorsOf(coveredPath)) {
        if (ancestor.startsWith(`${path}/`)) containsCovered.add(ancestor);
      }
    }

    // Pass 3: an unrepresented directory is STRUCTURAL only when it contains
    // covered state. Git not representing intermediate directories means they
    // cannot be REQUIRED to have candidates -- not that any physical directory
    // may vanish unaccounted for. `a/sub/selected-file` justifies `a/sub`;
    // nothing justifies a sibling `a/unrelated-empty-dir`.
    for (const descendant of descendants) {
      if (descendant.kind !== "directory") continue;
      if (byPath.has(descendant.path)) continue; // decided in pass 1
      if (containsCovered.has(descendant.path)) continue;
      conflicts.push({
        changeGroupId: c.changeGroupId,
        path,
        reason: {
          code: "UNSUPPORTED_STATE",
          detail: `removing or replacing ${path} would destroy the directory ${descendant.path}, which contains no state the resolved selection accounts for`,
        },
      });
    }
  }

  // ---- Stage C1b: ancestor support -----------------------------------------
  //
  // Only leaves whose BEFORE worktree is PRESENT need filesystem parents; an
  // index-only target needs none.
  const dependencyPaths = new Set<string>();
  const parentRequiredBy = new Map<string, string[]>();
  for (const path of writePaths) {
    const c = requireClassification(byPath, path);
    if (!worktreePresent(c.expectedBefore)) continue;
    for (const ancestor of ancestorsOf(path)) {
      const asCandidate = byPath.get(ancestor);
      if (asCandidate !== undefined) {
        if (asCandidate.expectedBefore.worktree.kind !== "directory") {
          conflicts.push({
            changeGroupId: c.changeGroupId,
            path: ancestor,
            reason: {
              code: "UNSUPPORTED_STATE",
              detail: `${path} requires ${ancestor} to be a directory, but its BEFORE state is not`,
            },
          });
        }
        continue;
      }
      const observed = ancestorStateOf(ancestor);
      if (observed.worktree.kind === "directory") {
        // No write, but LOAD-BEARING: if an external process replaces it with a
        // file after planning, the child transplant fails. It joins the
        // protected domain so the fence covers it.
        dependencyPaths.add(ancestor);
        continue;
      }
      if (observed.worktree.kind === "absent") {
        const list = parentRequiredBy.get(ancestor) ?? [];
        list.push(path);
        parentRequiredBy.set(ancestor, list);
        continue;
      }
      conflicts.push({
        changeGroupId: c.changeGroupId,
        path: ancestor,
        reason: {
          code: "UNSUPPORTED_STATE",
          detail: `${path} requires ${ancestor} to be a directory, but it is currently ${observed.worktree.kind}`,
        },
      });
    }
  }

  // ---- Stage C2: index D/F topology ----------------------------------------
  //
  // `git update-index --add --cacheinfo` REFUSES a prefix collision in either
  // direction, and runs after the worktree phase -- so it must never be the
  // first component to notice.
  const projectedIndex = new Set<string>();
  for (const indexPath of indexPopulation) {
    if (!byPath.has(indexPath)) projectedIndex.add(indexPath);
  }
  for (const c of classifications) {
    // ANY non-absent expected index state occupies the namespace. `unmerged`
    // counts: exact-BEFORE permits it as a no-op, so it can survive.
    if (c.expectedBefore.index.kind !== "absent") projectedIndex.add(c.path);
  }
  for (const entryPath of [...projectedIndex].sort()) {
    for (const ancestor of ancestorsOf(entryPath)) {
      if (!projectedIndex.has(ancestor)) continue;
      // A NEW collision must involve a selected candidate: the existing git
      // index cannot already contain a D/F collision, so one side changed.
      const selectedSide = byPath.get(entryPath) ?? byPath.get(ancestor);
      if (selectedSide === undefined) {
        throw new Error(
          `projected index collision between ${JSON.stringify(ancestor)} and ${JSON.stringify(entryPath)} has no selected participant`,
        );
      }
      conflicts.push({
        changeGroupId: selectedSide.changeGroupId,
        path: entryPath,
        reason: {
          code: "UNSUPPORTED_STATE",
          detail: `the restored index would hold entries at both ${ancestor} and ${entryPath}; git refuses that file/directory collision`,
        },
      });
    }
  }

  const topologyDependencyPaths = [...dependencyPaths].sort();

  if (conflicts.length > 0) {
    conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { topologyDependencyPaths, operations: [], conflicts };
  }

  // ---- Stage D -------------------------------------------------------------
  //
  // Candidate writes plus synthetic parents. NO reconstruction term: destruction
  // only occurs when an ancestor's BEFORE worktree is a non-directory, and
  // nothing can exist beneath a regular file in the BEFORE world.
  const operations: SelectiveRestoreOperation[] = [];
  for (const path of writePaths) {
    const c = requireClassification(byPath, path);
    operations.push({
      kind: "restore_candidate",
      path: c.path,
      changeGroupId: c.changeGroupId,
      target: c.expectedBefore,
      observed: c.observed,
    });
  }
  for (const [ancestor, requiredBy] of parentRequiredBy) {
    const observed = ancestorStateOf(ancestor);
    operations.push({
      kind: "create_parent_directory",
      path: ancestor,
      // PRESERVES the current index axis: a synthetic parent has no authority
      // to alter an unrelated index entry at that path.
      target: parentDirectoryTarget(observed),
      observed,
      requiredBy: [...requiredBy].sort(),
    });
  }
  operations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { topologyDependencyPaths, operations, conflicts: [] };
}

// =============================================================================
// The planner
// =============================================================================

export async function planSelectiveRestore(opts: {
  readonly repoRoot: string;
  readonly contribution: SessionContributionFile;
  readonly selectedChangeGroupIds: readonly string[];
}): Promise<SelectiveRestorePlan> {
  const { repoRoot, contribution } = opts;
  const selected = new Set(opts.selectedChangeGroupIds);
  // Metadata matches the Set actually used, so duplicated input cannot yield two
  // interpretations of one selection.
  const selectedChangeGroupIds = [...selected].sort();

  // ONE capability read per plan, frozen into the result.
  const symlinkCheckout = await gitCheckoutSymlinksEnabled(repoRoot);
  const capabilities: SelectiveRestoreCapabilities = { symlinkCheckout };

  const candidates: PhysicalRestoreCandidate[] = [];
  for (const entry of contribution.entries) {
    if (!selected.has(entry.change_group_id)) continue;
    candidates.push(...derivePhysicalCandidates(entry));
  }
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const index: IndexSnapshot = await readIndexSnapshot(repoRoot);
  const conflicts: SelectiveRestoreConflict[] = [];

  // ---- Stage A -------------------------------------------------------------
  const classifications: SelectiveRestoreClassification[] = [];
  const byPath = new Map<string, SelectiveRestoreClassification>();
  for (const candidate of candidates) {
    // `worktreeObject` carries { digest, data }. Only `state` is retained:
    // holding the bytes would rebuild a whole-selection memory problem on the
    // CURRENT side for a broad selection such as --only '**'.
    const { state: observed } = await observePathState(repoRoot, candidate.path, index);
    const classification: SelectiveRestoreClassification = {
      path: candidate.path,
      changeGroupId: candidate.changeGroupId,
      expectedBefore: candidate.expectedBefore,
      expectedAfter: candidate.expectedAfter,
      observed,
      outcome: classify(observed, candidate, symlinkCheckout),
    };
    classifications.push(classification);
    byPath.set(candidate.path, classification);
    if (classification.outcome.kind === "conflict") {
      conflicts.push({
        changeGroupId: classification.changeGroupId,
        path: classification.path,
        reason: classification.outcome.reason,
      });
    }
  }

  // ---- Gather ---------------------------------------------------------------
  //
  // EXACTLY the observations the derivation can request, no convenience set.
  // Sequential and in sorted order, so a fail-closed enumeration error surfaces
  // from the same subtree run to run.
  const writePaths = writePathsOf(classifications);

  const descendantsByRoot = new Map<string, readonly CurrentDescendant[]>();
  for (const path of writePaths) {
    const c = requireClassification(byPath, path);
    if (!destroysDescendants(c.observed, c.expectedBefore)) continue;
    descendantsByRoot.set(path, await enumerateDescendants(repoRoot, path));
  }

  const ancestorStates = new Map<string, PathState>();
  for (const path of writePaths) {
    const c = requireClassification(byPath, path);
    if (!worktreePresent(c.expectedBefore)) continue;
    for (const ancestor of ancestorsOf(path)) {
      if (byPath.has(ancestor)) continue; // C1b answers these from the classifications
      if (ancestorStates.has(ancestor)) continue;
      ancestorStates.set(ancestor, (await observePathState(repoRoot, ancestor, index)).state);
    }
  }

  // ---- Derive ---------------------------------------------------------------
  const derived = deriveSelectiveTopology({
    classifications,
    descendantsOf: (path) => {
      const found = descendantsByRoot.get(path);
      if (found === undefined) {
        throw new Error(`descendants of ${JSON.stringify(path)} were never gathered`);
      }
      return found;
    },
    ancestorStateOf: (path) => {
      const found = ancestorStates.get(path);
      if (found === undefined) {
        throw new Error(`ancestor state for ${JSON.stringify(path)} was never gathered`);
      }
      return found;
    },
    indexPopulation: new Set(index.byPath.keys()),
  });

  conflicts.push(...derived.conflicts);
  const { topologyDependencyPaths } = derived;

  if (conflicts.length > 0) {
    conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      outcome: "conflicted",
      capabilities,
      selectedChangeGroupIds,
      classifications,
      topologyDependencyPaths,
      operations: [],
      conflicts,
    };
  }

  if (derived.operations.length === 0) {
    return {
      outcome: "noop",
      capabilities,
      selectedChangeGroupIds,
      classifications,
      topologyDependencyPaths,
      operations: [],
      conflicts: [],
    };
  }
  return {
    outcome: "eligible",
    capabilities,
    selectedChangeGroupIds,
    classifications,
    topologyDependencyPaths,
    operations: derived.operations,
    conflicts: [],
  };
}
