// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Post-transplant state verification (M 0.8.0 step 11).
//
// The final interpreter of what the transaction actually did. It runs AFTER
// mutation, against the same session-start oracle the transplant read from, and
// answers one question per selected candidate plus one about everything the
// transaction promised not to disturb.
//
// =============================================================================
// It runs after mutation, so it CLASSIFIES rather than refuses
// =============================================================================
//
// Every contradiction here becomes a violation in the result, never a throw.
// The repository is already in whatever state it reached; a throw would destroy
// the receipt describing it. Genuine I/O failures still propagate, and the
// transaction's own catch boundary preserves them.
//
// =============================================================================
// Three independent authorities, deliberately not collapsed
// =============================================================================
//
//     frozen S    decides WHICH paths and watch roots are judged
//     the plan    describes WHAT was authorized
//     progress    says WHICH obligations execution may actually have reached
//
// The third is what makes this more than a plan-versus-reality diff. A planned
// removal whose obligation never left `pending` does NOT authorize a member to
// have vanished: nothing entered that mutation, so its disappearance is
// unattributed. Symmetrically, `attempted` counts as authorization, because a
// primitive may mutate and then fail.
//
// =============================================================================
// Topology authorization is MEMBER-SPECIFIC and TARGET-SENSITIVE
// =============================================================================
//
// An attempted removal of `dir` does not excuse the disappearance of
// `dir/unrelated.txt`. The 10C primitives are not recursive deletion authority:
// `removeWorktreePath` refuses ENOTEMPTY, so every removed node is separately
// scheduled and separately accountable.
//
// Authorization is a CONJUNCTION, and both halves are needed:
//
//     the plan authorizes this membership effect at exactly this member
//         disappear    observed present, target absent
//         appear       observed absent, target present
//         kind_change  both present, TOPOLOGY kinds differ
//     AND
//     an obligation whose phase can produce the authorized TARGET reached
//     attempted or completed
//         disappear              -> removal
//         to a directory         -> directory
//         to a leaf              -> leaf
//
// The obligation alone is not enough: this function accepts progress it did not
// build, so an extra obligation must not manufacture authority the plan never
// granted. The plan alone is not enough either: intent is not evidence that
// anything ran.
//
// Kind comparison is TOPOLOGICAL. A regular-to-symlink transition changes
// `WorktreeState.kind` but leaves both sides leaves, so it cannot explain a
// watch member's kind flip. An `unsupported` state has no topology at all and
// therefore authorizes nothing, on any of the three effects.
//
// Contradictory authority is NOT the same as absent authority. A path named by
// two records cannot resolve to an operation, but one of those records may well
// have authorized the transition, so it is reported as inconsistent evidence
// rather than as an unauthorized change.
//
// =============================================================================
// What it assumes, and what it therefore does not re-prove
// =============================================================================
//
// `progress` is `RecordedTransplantProgress`: recorded by an accumulator during
// execution. This function validates each candidate's ATTRIBUTION defensively,
// because a corrupt graph must never become a false `restored`. It does NOT
// establish that progress was derived from this plan's schedule, nor that the
// plan is internally coherent. Both were settled before mutation, by preparation
// and the gate, and are preconditions of calling this at all.
//
// `postTransplantStateConsistent` therefore means: consistent with the accepted
// execution evidence. It is not independent validation of that evidence's
// completeness.
//
// =============================================================================
// What it never does
// =============================================================================
//
// No checkpoint manifest, no contribution, no selectors. Which checkpoint was
// chosen and which selection produced this plan are transaction-composition
// questions, settled before the oracle opened.
//
// Membership is never re-derived either:
// `observeProtectedDomainFromFrozenMembership` takes `S` as the authority, so no
// protected path can drop out of the comparison because the transaction changed
// the rules that define membership.
//
// =============================================================================
// "Consistent" is not "succeeded"
// =============================================================================
//
// A transaction can have a `failed` candidate and NO violations: the primitive
// failure is already known from progress, and the final state can be entirely
// consistent with that evidence. So the predicate here answers only whether the
// observed state contradicts the evidence. Overall restore success is
//
//     postTransplantStateConsistent(result) && everyCandidateSettled(result)
//
// and the two are kept separate so neither silently becomes the other.

import type { PathState } from "@viberevert/session-format";

import { getHeadSha } from "./git-cli.js";
import {
  type IndexSnapshot,
  observePathState,
  pathStateEqual,
  readIndexSnapshot,
} from "./path-state.js";
import {
  compareProtectedDomainSnapshots,
  observeProtectedDomainFromFrozenMembership,
  type ProtectedDomainSnapshot,
} from "./protected-domain.js";
import type { SelectiveRestoreOperation, SelectiveRestorePlan } from "./restore-selective.js";
import {
  type CandidateExecutionOutcome,
  candidateAttributionIsConsistent,
  deriveCandidateExecutionOutcomes,
  type ObligationPhase,
  type ObligationState,
  type RecordedTransplantProgress,
  type RestoreCandidateRecord,
} from "./transplant-obligations.js";

// =============================================================================
// Types
// =============================================================================

export type VerificationViolationKind =
  /** An `execution_complete` candidate does not match the oracle. */
  | "candidate_not_restored"
  /** A completed non-candidate operation did not produce its target state. */
  | "planned_effect_not_verified"
  /** Something moved that no reached obligation accounts for. */
  | "unattributed_change"
  /** A watch member appeared, vanished, or changed kind without authority. */
  | "unauthorized_topology_change"
  | "head_moved"
  /** The frozen artifacts contradict each other or the execution record. */
  | "inconsistent_evidence";

export interface VerificationViolation {
  readonly kind: VerificationViolationKind;
  /** Repo-relative POSIX path. `""` is the repository itself, as for HEAD. */
  readonly path: string;
  readonly detail: string;
}

/**
 * One receipt-ready fact per SELECTED classification, including defective ones.
 *
 * A discriminated union rather than optional fields, so `oracleState` exists
 * exactly where a comparison against the oracle happened. Step 12 renders these;
 * it does not re-interpret progress.
 *
 * The defect arm carries no `disposition` on purpose: when the evidence
 * contradicts itself we do not know which disposition to claim.
 */
export type VerifiedCandidate =
  | {
      readonly path: string;
      readonly changeGroupId: string;
      readonly disposition: "already_at_before";
      /** `failed` when the path drifted after `S` was frozen. */
      readonly outcome: "already_at_before" | "failed";
      readonly observedState: PathState;
    }
  | {
      readonly path: string;
      readonly changeGroupId: string;
      readonly disposition: "restore_required";
      readonly executionStatus: "execution_complete";
      readonly outcome: "restored" | "failed";
      readonly observedState: PathState;
      /** Required here: the oracle is gone by the time a receipt is written. */
      readonly oracleState: PathState;
    }
  | {
      readonly path: string;
      readonly changeGroupId: string;
      readonly disposition: "restore_required";
      readonly executionStatus: "failed";
      readonly outcome: "failed";
      readonly observedState: PathState;
    }
  | {
      readonly path: string;
      readonly changeGroupId: string;
      readonly disposition: "restore_required";
      /**
       * Stays `not_attempted` even when drift is separately reported: no
       * obligation was entered, which is the useful execution fact. The
       * `unattributed_change` violation carries the drift.
       */
      readonly executionStatus: "not_attempted";
      readonly outcome: "not_attempted";
      readonly observedState: PathState;
    }
  | {
      readonly path: string;
      readonly changeGroupId: string;
      readonly evidenceStatus: "inconsistent";
      readonly outcome: "failed";
      /**
       * Absent when no live observation exists: normally because `S` lacked the
       * selected path, or because frozen-membership observation violated its
       * contract. A frozen state is never substituted, since that would label a
       * historical value as a live observation.
       */
      readonly observedState?: PathState;
    };

export interface PostTransplantVerificationResult {
  readonly candidates: readonly VerifiedCandidate[];
  readonly violations: readonly VerificationViolation[];
  readonly observedHeadSha: string;
  /**
   * How many UNSELECTED managed paths this verification actually compared.
   *
   * Evidence about the size of the compared domain, not a pass/fail signal. A
   * receipt reporting no unselected violations means little without it, because
   * "nothing moved" and "nothing was looked at" would otherwise read alike.
   *
   * Produced by pass 2, which walks `S`'s own path set and skips the plan's
   * classifications. So it counts PATHS: `S` is keyed by path, obligations and
   * candidates never enter it, and a selected path cannot be counted however
   * many obligations it carries.
   */
  readonly unselectedCheckedCount: number;
}

export interface PostTransplantVerificationOptions {
  readonly repoRoot: string;
  /** The SAME oracle the evidence check and the transplant used. */
  readonly oracleWorktree: string;
  readonly plan: SelectiveRestorePlan;
  /** Recorded by an accumulator during execution; see the header's contract. */
  readonly progress: RecordedTransplantProgress;
  /** `S`, frozen before the emergency checkpoint was created. */
  readonly frozenSnapshot: ProtectedDomainSnapshot;
  /** HEAD as observed when `S` was captured. */
  readonly expectedHeadSha: string;
}

/** Whether the observed state contradicts the evidence. NOT "the restore worked". */
export const postTransplantStateConsistent = (r: PostTransplantVerificationResult): boolean =>
  r.violations.length === 0;

/** Whether every selected candidate reached a terminal, non-failing outcome. */
export const everyCandidateSettled = (r: PostTransplantVerificationResult): boolean =>
  r.candidates.every((c) => c.outcome === "restored" || c.outcome === "already_at_before");

// =============================================================================
// Small helpers
// =============================================================================

type SyntheticParentOperation = Extract<
  SelectiveRestoreOperation,
  { kind: "create_parent_directory" }
>;

/** Membership deltas a watch can report, as observable transitions. */
type MembershipEffect = "disappear" | "appear" | "kind_change";

/** What a watch member IS, which is coarser than `WorktreeState.kind`. */
type TopologyKind = "directory" | "leaf";

const topologyKindOf = (state: PathState["worktree"]): TopologyKind | undefined => {
  if (state.kind === "directory") return "directory";
  if (state.kind === "regular" || state.kind === "symlink") return "leaf";
  // `absent` has no topology; `unsupported` is refused by the scheduler and must
  // never authorize anything here.
  return undefined;
};

const isObligationStateValue = (value: unknown): value is ObligationState =>
  value === "pending" || value === "attempted" || value === "completed";

/** Paths appearing more than once, which no lookup may then resolve. */
function duplicatedPaths(items: readonly { readonly path: string }[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const item of items) {
    if (seen.has(item.path)) duplicated.add(item.path);
    else seen.add(item.path);
  }
  return duplicated;
}

/** Unique paths are indexed; poisoned paths resolve to nothing at all. */
function indexByPath<T extends { readonly path: string }>(
  items: readonly T[],
  poisoned: ReadonlySet<string>,
): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (poisoned.has(item.path)) continue;
    if (!map.has(item.path)) map.set(item.path, item);
  }
  return map;
}

/**
 * The state of the single obligation of `phase` at `path`.
 *
 * `absent` means nothing was scheduled to do that. `inconsistent` covers every
 * shape that contradicts preparation: more than one match, an id outside the
 * table, a table not indexed by its own ids, and a state outside the vocabulary.
 */
function obligationStateAt(
  progress: RecordedTransplantProgress,
  phase: ObligationPhase,
  path: string,
): ObligationState | "absent" | "inconsistent" {
  const matches = progress.obligations.filter((o) => o.phase === phase && o.path === path);
  if (matches.length === 0) return "absent";
  if (matches.length > 1) return "inconsistent";
  const only = matches[0];
  if (only === undefined) return "inconsistent";
  if (progress.obligations[only.id] !== only) return "inconsistent";
  const state = progress.states[only.id];
  return isObligationStateValue(state) ? state : "inconsistent";
}

/** `attempted` counts: a primitive may mutate and then fail. */
const mayHaveMutated = (state: ObligationState | "absent" | "inconsistent"): boolean =>
  state === "attempted" || state === "completed";

/**
 * The obligation phase that could produce `effect` at `op`'s path, or
 * `undefined` when the plan authorizes no such transition there.
 *
 * This reads the plan's own `(observed, target)` pair. It describes the intended
 * observable delta, not when §13 emits which phase, so it is not a second copy
 * of the scheduling algebra.
 *
 * Every branch routes through `topologyKindOf`, so an `unsupported` state on
 * either side authorizes nothing.
 */
function requiredPhaseFor(
  op: SelectiveRestoreOperation,
  effect: MembershipEffect,
): ObligationPhase | undefined {
  const observedKind = topologyKindOf(op.observed.worktree);
  const targetKind = topologyKindOf(op.target.worktree);

  if (effect === "disappear") {
    const vanishes = observedKind !== undefined && op.target.worktree.kind === "absent";
    return vanishes ? "removal" : undefined;
  }
  if (effect === "appear") {
    const appears = op.observed.worktree.kind === "absent" && targetKind !== undefined;
    return appears ? targetKind : undefined;
  }
  const flips =
    observedKind !== undefined && targetKind !== undefined && observedKind !== targetKind;
  return flips ? targetKind : undefined;
}

// =============================================================================
// Verification
// =============================================================================

export async function verifyPostTransplantState(
  opts: PostTransplantVerificationOptions,
): Promise<PostTransplantVerificationResult> {
  const { repoRoot, oracleWorktree, plan, progress, frozenSnapshot, expectedHeadSha } = opts;

  const violations: VerificationViolation[] = [];
  const candidates: VerifiedCandidate[] = [];
  const flag = (kind: VerificationViolationKind, path: string, detail: string): void => {
    violations.push({ kind, path, detail });
  };

  if (plan.outcome !== "eligible") {
    flag(
      "inconsistent_evidence",
      "",
      `verification received a ${JSON.stringify(plan.outcome)} plan, but only an eligible plan can have been executed`,
    );
  }

  // ---- Duplicates POISON their path, they do not pick a winner -------------
  //
  // A silently overwritten key is exactly how contradictory evidence becomes a
  // reassuring answer: two execution records for one path could derive
  // `execution_complete` and `failed`, and a last-writer map would keep
  // whichever appeared last.
  const poisoned = new Set<string>();
  const report = (paths: ReadonlySet<string>, what: string): void => {
    for (const path of paths) {
      poisoned.add(path);
      flag("inconsistent_evidence", path, `two ${what} name this path, so neither can be trusted`);
    }
  };
  report(duplicatedPaths(plan.classifications), "classifications");
  report(duplicatedPaths(plan.operations), "plan operations");
  report(duplicatedPaths(progress.candidates), "execution records");

  const classificationPaths = new Set(plan.classifications.map((c) => c.path));
  const syntheticParentPaths = new Set(
    plan.operations.filter((op) => op.kind === "create_parent_directory").map((op) => op.path),
  );
  for (const path of syntheticParentPaths) {
    if (!classificationPaths.has(path)) continue;
    poisoned.add(path);
    flag(
      "inconsistent_evidence",
      path,
      "a synthetic parent shares its path with a classification, which the scheduler forbids",
    );
  }

  const operationByPath = indexByPath(plan.operations, poisoned);
  const progressByPath = indexByPath(progress.candidates, poisoned);
  const executionByPath: ReadonlyMap<string, CandidateExecutionOutcome> = indexByPath(
    deriveCandidateExecutionOutcomes(progress),
    poisoned,
  );

  const syntheticParentByPath = new Map<string, SyntheticParentOperation>();
  for (const [path, op] of operationByPath) {
    if (op.kind === "create_parent_directory") syntheticParentByPath.set(path, op);
  }

  // ---- One live observation, membership taken from S (F4) ------------------
  const observed = await observeProtectedDomainFromFrozenMembership(repoRoot, frozenSnapshot);

  // ---- Pass 1: exactly one candidate record per selected classification ----
  //
  // Driven by the plan rather than by `S`, because a selected path missing from
  // `S` must still produce a record. Duplicated classifications each emit their
  // own defect record; they are never collapsed.
  let oracleIndex: IndexSnapshot | undefined;

  for (const classification of plan.classifications) {
    const path = classification.path;
    const observedState = observed.states.get(path);
    const frozenState = frozenSnapshot.states.get(path);

    const inconsistentCandidate = (): void => {
      candidates.push({
        path,
        changeGroupId: classification.changeGroupId,
        evidenceStatus: "inconsistent",
        outcome: "failed",
        ...(observedState !== undefined ? { observedState } : {}),
      });
    };
    const defect = (detail: string): void => {
      flag("inconsistent_evidence", path, detail);
      inconsistentCandidate();
    };

    if (poisoned.has(path)) {
      // The duplication itself was already reported; the record still owes a
      // candidate fact so step 12 never has to rediscover the gap.
      inconsistentCandidate();
      continue;
    }
    if (classification.outcome.kind !== "planned") {
      defect("an eligible plan carries a conflicted classification");
      continue;
    }
    if (frozenState === undefined) {
      defect("a selected path is absent from the frozen protected domain");
      continue;
    }
    if (observedState === undefined) {
      defect("the frozen-membership observation returned no state for a selected path");
      continue;
    }

    if (classification.outcome.disposition === "already_at_before") {
      const unchanged = pathStateEqual(observedState, frozenState);
      if (!unchanged) {
        flag(
          "unattributed_change",
          path,
          "an already_at_before candidate moved after S was frozen, so it is no longer at its BEFORE state",
        );
      }
      candidates.push({
        path,
        changeGroupId: classification.changeGroupId,
        disposition: "already_at_before",
        outcome: unchanged ? "already_at_before" : "failed",
        observedState,
      });
      continue;
    }

    const record: RestoreCandidateRecord | undefined = progressByPath.get(path);
    if (record === undefined) {
      defect("a restore_required classification has no execution record");
      continue;
    }
    if (record.changeGroupId !== classification.changeGroupId) {
      defect(
        `the execution record names change group ${JSON.stringify(record.changeGroupId)}, but the plan classified it as ${JSON.stringify(classification.changeGroupId)}`,
      );
      continue;
    }
    // A `failed` status is both a legitimate execution answer and the
    // conservative answer for corrupt attribution. Asking separately is what
    // keeps those two from producing the same receipt.
    if (!candidateAttributionIsConsistent(progress, record)) {
      defect("the execution record's own attribution contradicts itself");
      continue;
    }
    const execution = executionByPath.get(path);
    if (execution === undefined) {
      defect("no execution outcome was derived for this candidate");
      continue;
    }

    if (execution.status === "execution_complete") {
      if (oracleIndex === undefined) oracleIndex = await readIndexSnapshot(oracleWorktree);
      const { state: oracleState } = await observePathState(oracleWorktree, path, oracleIndex);
      const restored = pathStateEqual(observedState, oracleState);
      if (!restored) {
        flag(
          "candidate_not_restored",
          path,
          "every obligation completed, but the live state does not equal the oracle the transplant read from",
        );
      }
      candidates.push({
        path,
        changeGroupId: classification.changeGroupId,
        disposition: "restore_required",
        executionStatus: "execution_complete",
        outcome: restored ? "restored" : "failed",
        observedState,
        oracleState,
      });
      continue;
    }

    if (execution.status === "not_attempted") {
      if (!pathStateEqual(observedState, frozenState)) {
        flag(
          "unattributed_change",
          path,
          "no obligation for this candidate was entered, yet the path moved after S was frozen",
        );
      }
      candidates.push({
        path,
        changeGroupId: classification.changeGroupId,
        disposition: "restore_required",
        executionStatus: "not_attempted",
        outcome: "not_attempted",
        observedState,
      });
      continue;
    }

    // `failed`: a primitive was entered and did not complete, so no target
    // state is assertable. The observed state is retained as the fact.
    candidates.push({
      path,
      changeGroupId: classification.changeGroupId,
      disposition: "restore_required",
      executionStatus: "failed",
      outcome: "failed",
      observedState,
    });
  }

  // ---- Pass 2: every frozen path the plan did not claim --------------------
  //
  // Classification paths were adjudicated above; synthetic parents get the
  // planned-effect rule; everything else must be untouched. Mutually exclusive
  // branches over one loop are what make "exactly one treatment per frozen path"
  // structural rather than a rule to re-check.
  //
  // This loop is also where `unselectedCheckedCount` comes from, incremented
  // for every path it adjudicates. Counting HERE rather than deriving a size
  // afterwards is the point: the reported number is what was compared, and
  // cannot drift from it.
  let unselectedCheckedCount = 0;
  for (const [path, frozenState] of frozenSnapshot.states) {
    if (classificationPaths.has(path)) continue;
    unselectedCheckedCount += 1;

    const live = observed.states.get(path);
    if (live === undefined) {
      flag("inconsistent_evidence", path, "the frozen-membership observation lost a frozen path");
      continue;
    }

    if (syntheticParentPaths.has(path)) {
      const parent = syntheticParentByPath.get(path);
      // Poisoned: the duplication was already reported, and no assertion can be
      // made against a record we refuse to resolve.
      if (parent === undefined) continue;

      const state = obligationStateAt(progress, "directory", path);
      if (state === "absent" || state === "inconsistent") {
        flag(
          "inconsistent_evidence",
          path,
          `a synthetic parent has ${state === "absent" ? "no" : "an unusable"} directory obligation`,
        );
        continue;
      }
      if (state === "completed" && !pathStateEqual(live, parent.target)) {
        flag(
          "planned_effect_not_verified",
          path,
          "the synthetic parent's directory obligation completed, but the live state is not its planned target",
        );
      } else if (state === "pending" && !pathStateEqual(live, frozenState)) {
        flag(
          "unattributed_change",
          path,
          "the synthetic parent's obligation was never entered, yet the path moved",
        );
      }
      // `attempted`: the primitive may have partly acted before failing, so no
      // final-state assertion is possible. The observation stands as the fact.
      continue;
    }

    // Topology dependencies and the whole unselected managed domain.
    if (!pathStateEqual(live, frozenState)) {
      flag("unattributed_change", path, "a protected path the transaction never selected moved");
    }
  }

  // ---- Topology, member by member ------------------------------------------
  const authorize = (member: string, effect: MembershipEffect, watchPath: string): void => {
    const unauthorized = (why: string): void => {
      flag(
        "unauthorized_topology_change",
        member,
        `membership beneath watched ${JSON.stringify(watchPath)} changed (${effect}), but ${why}`,
      );
    };

    if (poisoned.has(member)) {
      // The duplicate was already reported. Contradictory authority cannot be
      // resolved, but it is not evidence that the transition was unauthorized:
      // one of the conflicting records may well have permitted it.
      return;
    }
    const op = operationByPath.get(member);
    if (op === undefined) {
      unauthorized("the plan contains no operation at this path");
      return;
    }
    const phase = requiredPhaseFor(op, effect);
    if (phase === undefined) {
      unauthorized("the plan authorizes no such transition at this path");
      return;
    }
    const state = obligationStateAt(progress, phase, member);
    if (state === "inconsistent") {
      flag("inconsistent_evidence", member, `the ${phase} obligation at this path is unusable`);
      return;
    }
    if (!mayHaveMutated(state)) {
      unauthorized(`no ${phase} obligation that could produce it was entered`);
    }
  };

  for (const difference of compareProtectedDomainSnapshots(frozenSnapshot, observed)
    .topologyWatchDifferences) {
    if (difference.reason !== "membership_changed") {
      // Frozen-membership observation copies S's roots and kinds verbatim, so
      // these three reasons are structurally unreachable.
      flag(
        "inconsistent_evidence",
        difference.path,
        `the observation reported ${difference.reason}, which frozen-membership observation cannot produce`,
      );
      continue;
    }
    for (const member of difference.removedMembers) authorize(member, "disappear", difference.path);
    for (const member of difference.addedMembers) authorize(member, "appear", difference.path);
    for (const member of difference.changedMembers) {
      authorize(member, "kind_change", difference.path);
    }
  }

  // ---- HEAD ----------------------------------------------------------------
  const observedHeadSha = await getHeadSha(repoRoot);
  if (observedHeadSha !== expectedHeadSha) {
    flag(
      "head_moved",
      "",
      `HEAD is ${observedHeadSha}, but S was frozen at ${expectedHeadSha}; the transplant never moves HEAD`,
    );
  }

  return { candidates, violations, observedHeadSha, unselectedCheckedCount };
}
