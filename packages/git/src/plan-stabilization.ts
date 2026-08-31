// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Plan stabilization (M 0.8.0 step 10B, §10).
//
// PURE AND SYNCHRONOUS. No git, no filesystem, no config, no `await`. It
// receives the already-approved plan and the already-captured protected-domain
// snapshot `S`, and answers one phase-bound question:
//
//     does the approved plan still describe THIS repository snapshot?
//
// It never captures `S`, creates a checkpoint, builds an oracle, or reloads
// policy. The caller owns that sequence:
//
//     capture S  ->  stabilize the approved plan against S  ->  only then E
//
// =============================================================================
// Why it cannot re-plan
// =============================================================================
//
// Calling `planSelectiveRestore` again would open a second observation window
// after `S`, and would produce a plan competing with the approved one for
// authority. Test 14c requires the opposite: a changed footprint is a REFUSAL,
// never a silent recomputation.
//
// So the approved `SelectiveRestorePlan` stays authoritative and this module
// derives only a NON-AUTHORITATIVE projection, using the planner's own
// `deriveSelectiveTopology` so the topology algebra has exactly one owner. What
// changes between the two callers is the observation source, never the rules.
//
// =============================================================================
// Three independent invariants, evaluated in order
// =============================================================================
//
//     A  selected prestate      S[path] == classification.observed
//     B  topology dependency    derived deps == approved deps
//     C  executable projection  derived operations == approved operations
//
// A SHORT-CIRCUITS. The derivation consumes the approved classifications, whose
// `observed` states are only sound inputs once A has proven them equal to `S`.
// A useful consequence: if a destructive root stopped being a directory since
// planning, A fails on that classification before `descendantsOf` is consulted,
// so revision 12's deliberately-empty recursive watch for a now-non-directory
// root can never enter the algebra dressed as the approved directory state.
//
// A is not sufficient on its own. It only covers classification paths, and two
// things live outside them: a new untracked child changes a recursive watch's
// membership without touching any classification, and a synthetic parent has a
// state in `S` but no classification at all. B and C cover exactly that gap.
//
// Any derived conflict means the conditions under which the plan was accepted no
// longer hold. It is reported as `PRECONDITION_CHANGED`, never as a newly
// authoritative `conflicted` plan the caller might adopt. The planner's
// machine-readable `reason` is preserved rather than flattened into prose, so a
// later phase can render it into its own `detail`.
//
// =============================================================================
// Lookups over S
// =============================================================================
//
//     descendantsOf(root)    S.topologyWatches[root], REQUIRED to exist and to
//                            be `recursive`. An immediate watch is not an
//                            acceptable partial answer to C1a, and a missing or
//                            wrong-kind watch is a construction error, never an
//                            empty subtree.
//     ancestorStateOf(path)  S.states[path]. Complete for an eligible plan:
//                            every non-classification ancestor C1b can request
//                            was, at planning time, either observed a directory
//                            (so a topologyDependencyPath) or observed absent
//                            (so a synthetic parent). Any other kind would have
//                            made the plan conflicted. Both land in `S`.
//     indexPopulation        every `S.states` entry whose index axis is not
//                            absent. Built from the STATE map only. Raw topology
//                            watches deliberately contain ignored and excluded
//                            paths and are not evidence about index occupancy.
//
// `S` omits index entries under the live `.viberevert/**` store. This cannot
// change the selective C2 result for a valid eligible plan: store paths can
// never be selected candidates, and an index D/F collision newly introduced by
// restoration must involve a selected side.

import type { PathState } from "@viberevert/session-format";

import { pathStateEqual } from "./path-state.js";
import type { ProtectedDomainSnapshot } from "./protected-domain.js";
import {
  deriveSelectiveTopology,
  type SelectiveRestoreConflict,
  type SelectiveRestoreOperation,
  type SelectiveRestorePlan,
} from "./restore-selective.js";

// =============================================================================
// Types
// =============================================================================

export type PlanStabilizationDifference =
  | {
      readonly invariant: "selected_prestate";
      readonly path: string;
      readonly detail: string;
    }
  | {
      readonly invariant: "derived_conflict";
      readonly path: string;
      /** The planner's own reason, preserved structurally for the caller. */
      readonly reason: SelectiveRestoreConflict["reason"];
    }
  | {
      readonly invariant: "topology_dependency";
      readonly addedPaths: readonly string[];
      readonly removedPaths: readonly string[];
    }
  | {
      readonly invariant: "executable_projection";
      readonly addedPaths: readonly string[];
      readonly removedPaths: readonly string[];
      readonly changedPaths: readonly string[];
    };

export type PlanStabilizationResult =
  | { readonly outcome: "stable" }
  | {
      readonly outcome: "precondition_changed";
      readonly differences: readonly PlanStabilizationDifference[];
    };

// =============================================================================
// Executable identity
// =============================================================================

/**
 * The part of an operation that decides what executes and under whose authority.
 *
 * `observed` is deliberately EXCLUDED. It is precondition evidence, checked by
 * invariant A for candidates and by the topology derivation for synthetic
 * parents. Treating it as executable identity would report a difference for a
 * plan whose instructions are unchanged.
 *
 * Keyed by path, which is sound because Stage D's two sources are disjoint:
 * `restore_candidate` covers write-footprint candidates, `create_parent_directory`
 * covers ancestors that are NOT candidates. No path can carry both.
 */
interface OperationProjection {
  readonly kind: SelectiveRestoreOperation["kind"];
  readonly changeGroupId: string | undefined;
  readonly target: PathState;
  readonly requiredBy: readonly string[] | undefined;
}

const sortedUnique = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();

function projectOperation(op: SelectiveRestoreOperation): OperationProjection {
  return op.kind === "restore_candidate"
    ? {
        kind: op.kind,
        changeGroupId: op.changeGroupId,
        target: op.target,
        requiredBy: undefined,
      }
    : {
        kind: op.kind,
        changeGroupId: undefined,
        target: op.target,
        requiredBy: sortedUnique(op.requiredBy),
      };
}

function projectionsEqual(a: OperationProjection, b: OperationProjection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.changeGroupId !== b.changeGroupId) return false;
  if (!pathStateEqual(a.target, b.target)) return false;
  if (a.requiredBy === undefined || b.requiredBy === undefined) {
    return a.requiredBy === b.requiredBy;
  }
  if (a.requiredBy.length !== b.requiredBy.length) return false;
  return a.requiredBy.every((value, i) => value === b.requiredBy?.[i]);
}

const projectionsByPath = (
  operations: readonly SelectiveRestoreOperation[],
): ReadonlyMap<string, OperationProjection> =>
  new Map(operations.map((op) => [op.path, projectOperation(op)] as const));

// =============================================================================
// Invariant accessors
// =============================================================================

function requireState(snapshot: ProtectedDomainSnapshot, path: string): PathState {
  const state = snapshot.states.get(path);
  if (state === undefined) {
    // `S` was captured from this very plan, so absence is a construction error
    // in the caller's sequence, never evidence that the path is gone. Real
    // absence is `worktree.kind === "absent"`.
    throw new Error(`protected domain has no observed state for ${JSON.stringify(path)}`);
  }
  return state;
}

// =============================================================================
// Stabilization
// =============================================================================

export function stabilizeSelectiveRestorePlan(
  plan: SelectiveRestorePlan,
  snapshot: ProtectedDomainSnapshot,
): PlanStabilizationResult {
  if (plan.outcome !== "eligible") {
    throw new Error(
      `plan stabilization requires an eligible plan, received ${JSON.stringify(plan.outcome)}`,
    );
  }

  // ---- Invariant A ---------------------------------------------------------
  const prestateDifferences: PlanStabilizationDifference[] = [];
  for (const classification of plan.classifications) {
    const current = requireState(snapshot, classification.path);
    if (pathStateEqual(current, classification.observed)) continue;
    prestateDifferences.push({
      invariant: "selected_prestate",
      path: classification.path,
      detail: `observed ${describe(classification.observed)} when the plan was approved, now ${describe(current)}`,
    });
  }
  if (prestateDifferences.length > 0) {
    // Short-circuit: the derivation consumes these classifications, so running
    // it against states already known to disagree would report downstream noise
    // rather than the cause.
    return {
      outcome: "precondition_changed",
      differences: prestateDifferences.sort(byPath),
    };
  }

  // ---- Derivation over S ---------------------------------------------------
  const indexPopulation = new Set<string>();
  for (const [path, state] of snapshot.states) {
    if (state.index.kind !== "absent") indexPopulation.add(path);
  }

  const derived = deriveSelectiveTopology({
    classifications: plan.classifications,
    descendantsOf: (path) => {
      const watch = snapshot.topologyWatches.get(path);
      if (watch === undefined) {
        throw new Error(`protected domain has no topology watch for ${JSON.stringify(path)}`);
      }
      if (watch.kind !== "recursive") {
        throw new Error(
          `topology watch for ${JSON.stringify(path)} is ${watch.kind}, but C1a requires recursive membership`,
        );
      }
      return watch.members;
    },
    ancestorStateOf: (path) => requireState(snapshot, path),
    indexPopulation,
  });

  if (derived.conflicts.length > 0) {
    // The approved plan is never replaced by this derivation. A conflict here
    // means the conditions under which it was accepted no longer hold.
    return {
      outcome: "precondition_changed",
      differences: derived.conflicts
        .map(
          (conflict): PlanStabilizationDifference => ({
            invariant: "derived_conflict",
            path: conflict.path,
            reason: conflict.reason,
          }),
        )
        .sort(byPathThenReason),
    };
  }

  const differences: PlanStabilizationDifference[] = [];

  // ---- Invariant B ---------------------------------------------------------
  const approvedDependencies = new Set(plan.topologyDependencyPaths);
  const derivedDependencies = new Set(derived.topologyDependencyPaths);
  const dependencyAdded = [...derivedDependencies].filter((p) => !approvedDependencies.has(p));
  const dependencyRemoved = [...approvedDependencies].filter((p) => !derivedDependencies.has(p));
  if (dependencyAdded.length > 0 || dependencyRemoved.length > 0) {
    differences.push({
      invariant: "topology_dependency",
      addedPaths: sortedUnique(dependencyAdded),
      removedPaths: sortedUnique(dependencyRemoved),
    });
  }

  // ---- Invariant C ---------------------------------------------------------
  const approvedOperations = projectionsByPath(plan.operations);
  const derivedOperations = projectionsByPath(derived.operations);
  const operationAdded: string[] = [];
  const operationRemoved: string[] = [];
  const operationChanged: string[] = [];
  for (const [path, approved] of approvedOperations) {
    const candidate = derivedOperations.get(path);
    if (candidate === undefined) {
      operationRemoved.push(path);
      continue;
    }
    if (!projectionsEqual(approved, candidate)) operationChanged.push(path);
  }
  for (const path of derivedOperations.keys()) {
    if (!approvedOperations.has(path)) operationAdded.push(path);
  }
  if (operationAdded.length > 0 || operationRemoved.length > 0 || operationChanged.length > 0) {
    differences.push({
      invariant: "executable_projection",
      addedPaths: sortedUnique(operationAdded),
      removedPaths: sortedUnique(operationRemoved),
      changedPaths: sortedUnique(operationChanged),
    });
  }

  // B precedes C by construction above.
  return differences.length === 0
    ? { outcome: "stable" }
    : { outcome: "precondition_changed", differences };
}

// =============================================================================
// Ordering and rendering helpers
// =============================================================================

function byPath(a: PlanStabilizationDifference, b: PlanStabilizationDifference): number {
  const left = "path" in a ? a.path : "";
  const right = "path" in b ? b.path : "";
  return left < right ? -1 : left > right ? 1 : 0;
}

function byPathThenReason(a: PlanStabilizationDifference, b: PlanStabilizationDifference): number {
  const positional = byPath(a, b);
  if (positional !== 0) return positional;
  const left = a.invariant === "derived_conflict" ? a.reason.code : "";
  const right = b.invariant === "derived_conflict" ? b.reason.code : "";
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compact human rendering of a state, for `selected_prestate` detail only. */
function describe(state: PathState): string {
  return `${state.worktree.kind}/${state.index.kind}`;
}
