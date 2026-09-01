// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The mutation schedule (M 0.8.0 step 10F, §13).
//
// The first and only production caller of the 10C worktree materializers and
// the 10D index transplant. Package-internal: not exported from the barrel, and
// pinned as the single approved caller by the 10C#36 and 10D#20 source
// invariants, whose contract changes here from "no production caller" to
// "exactly one approved caller".
//
// =============================================================================
// Two functions, because the marker boundary is exact
// =============================================================================
//
// The locked ordering publishes `attempt.json` IMMEDIATELY before the first
// mutation:
//
//     oracle evidence
//     prepareSelectiveTransplant          <- all validation, all derivation
//     finalProtectedDomainFence           <- last protected-domain + HEAD
//                                            observation before the marker
//     publishRollbackAttempt              <- marker
//     executePreparedSelectiveTransplant  <- first mutation
//
// A single `execute(plan)` that validated internally would put that work AFTER
// the marker, making the boundary approximate. It would also let a plan that
// derives to no mutation, or whose shape is impossible, leave a published marker
// claiming mutation may have started when it provably could not.
//
// Preparation has no real-repository parameter and performs no mutation. That
// oracle path is still an arbitrary string, so the type system cannot prove a
// caller did not hand it the real checkout. What the API does establish is that
// preparation receives no separate real-repository path and performs only
// oracle-side reads. The 10F gate owns supplying the actual session-start
// oracle.
//
// Execution performs NO validation. Every deterministic refusal, including the
// pairing of index writes with their oracle snapshot, is encoded in the prepared
// value's shape instead. A single `if (...) throw` between the marker and the
// first removal would reintroduce exactly the window this split removes.
//
// What remains possible after the marker is a PRIMITIVE-LEVEL race: ancestry or
// a node kind changing between the fence and the mutation. That is expected, and
// is precisely why the marker records `mutation_may_have_started` rather than
// `mutation_started`. What the split removes is the class of failure that could
// have been known beforehand.
//
// =============================================================================
// The complete authority set
// =============================================================================
//
// A plan is a set of CLAIMS. Preparation consumes every field that authorizes a
// mutation, because a field the scheduler ignores is a field a fabricated plan
// can lie about for free:
//
//     eligible outcome
//     no conflicts anywhere            plan.conflicts AND every classification
//     selected change-group authority  plan.selectedChangeGroupIds
//     planner capability authority     plan.capabilities.symlinkCheckout
//     safe mutation paths              the shared mutation-path authority
//     classification <-> operation     total, in both directions
//     stage A's own relation
//     synthetic requiredBy authority
//     worktree and index shape validity
//     oracle index agreement
//     a non-empty mutation schedule
//
// `selectedChangeGroupIds` deserves particular note, because the
// operation-to-classification link does NOT cover it. That link proves evidence;
// the group set proves AUTHORIZATION. Without it:
//
//     selectedChangeGroupIds = [A]
//     classification path=x group=B restore_required
//     operation      path=x group=B
//
// passes every other check, and group B is mutated although the plan says it was
// never selected. Synthetic parents inherit this proof transitively, since
// `requiredBy` may name only candidates that already passed it.
//
// =============================================================================
// "Per operation" is not a schedule
// =============================================================================
//
//     1. removals, DEEPEST first
//     2. directory creation, SHALLOWEST first
//     3. leaf materialization
//     4. index updates, after the ENTIRE worktree phase
//
// Depth ordering is load-bearing rather than cosmetic. `removeWorktreePath`
// calls `rmdir` and refuses ENOTEMPTY explicitly, so a directory is removable
// only once its children are gone; `createWorktreeDirectory` uses a
// non-recursive `mkdir`, so a parent must exist before its child. Ties break
// lexically so a mid-transplant failure reproduces rather than depending on
// iteration order.
//
// Phase 4 exists so no index entry references a path the worktree phase has not
// finished settling. §15 also requires oracle oids to reach the real index
// before the oracle is torn down, which holds because this runs inside
// `withCheckpointOracle`'s `run`.
//
// =============================================================================
// Two axes, two independent triggers
// =============================================================================
//
//     worktree mutation  iff the worktree axis differs
//     index mutation     iff the index axis differs
//
// An operation whose index already equals its target gets no `update-index`,
// even when its bytes are rewritten. `IndexState` defines the index semantics
// being restored, so if observed equals target there is no index transition the
// plan authorized. Using `--cacheinfo` to refresh git's stat cache would mutate
// index metadata this model does not represent; once the restored bytes match
// the recorded oid, semantic correctness holds and re-stat is git's business.
//
// Throughout, `op.observed` is the plan's RECORDED phase-1 observation, not a
// fresh read. Proving the real repository still matches it is the fence's job.
//
// =============================================================================
// Evidence: the link to what was actually proven
// =============================================================================
//
// `oracle-evidence.ts` proves the oracle against the plan's CLASSIFICATIONS.
// This module mutates from the plan's OPERATIONS. Without a link, a fabricated
// operation could execute under evidence that was never about it:
//
//     classification says restore A;  oracle evidence proves A
//     operation says restore B;       preparation accepts B
//     marker, mutation, and only then does the materializer meet the oracle
//
// The link runs in BOTH directions. Every operation needs a classification, and
// every `restore_required` classification needs an operation: a plan carrying
// two such classifications but only one operation would silently execute half of
// what its evidence covers. The correspondence is total because §7's
// `writePathsOf` filters exactly `planned` + `restore_required` and narrows no
// further.
//
// Each linked classification must also satisfy the relation stage A used to
// reach that disposition:
//
//     observed == expectedAfter    (the branch returning restore_required)
//     observed != expectedBefore   (already_at_before is tested FIRST)
//
// Without those, a fabricated candidate with `observed == target` contributes no
// mutation of its own while other candidates keep the global schedule non-empty,
// so the zero-mutation check never fires and part of the plan is silently
// skipped. With them, that check becomes a final backstop rather than the only
// detector of a no-op candidate.
//
// A `create_parent_directory` has NO classification, by construction: §7 stage
// C1b derives it rather than classifying it. Its authority is `requiredBy`
// alone. Shape checks prove HOW it may mutate; only `requiredBy` proves WHY that
// path may be created at all. Without it this passes every other check:
//
//     path "totally/unrelated", observed absent, target directory,
//     index unchanged, requiredBy naming something unrelated
//
// and 10F creates that directory after the marker. So `requiredBy` must name
// real restore candidates that this synthetic parent genuinely supports. Each of
// the six conditions below is exactly what stage C1b guarantees:
//
//     no classification exists at the synthetic's own path  (C1b skips ancestors
//                                                            that are candidates)
//     requiredBy is non-empty        (the entry is created on first push)
//     each entry names a restore_candidate OPERATION, not merely a
//         classification -- the operation is what mutates, and what the
//         classification link proved against evidence
//     each such candidate passed the classification link  (pass 1)
//     the synthetic path strictly precedes each entry     (`ancestorsOf`)
//     each required candidate restores a PRESENT worktree (C1b skips candidates
//         whose expectedBefore worktree is absent, since an index-only target
//         needs no filesystem parent)
//
// This is why derivation runs in TWO PASSES. `plan.operations` is sorted
// lexically, so a synthetic parent `foo` precedes `foo/bar.txt`; validating in
// array order would fail on ordering rather than on authority, and array order
// is not part of the contract.
//
// =============================================================================
// Everything deterministic is refused before the first mutation
// =============================================================================
//
// Discovering an impossible operation halfway through phase 1, after earlier
// paths are already deleted, would convert a refusable plan into a partial
// mutation requiring recovery.
//
// Most refusals are INVARIANT VIOLATIONS: §7 stage A and stage D say an eligible
// plan cannot contain them. `already_at_before` wins ahead of everything for
// unsupported states, so an executable candidate cannot legitimately observe
// one; directories are never candidates, because directory-creation authority
// belongs exclusively to `create_parent_directory`; and an empty executable set
// is outcome `noop`, which never reaches here. Absorbing any of them would make
// the executor more permissive than the planner and hide the regression this
// boundary exists to expose.
//
// Three refusals reuse an existing authority rather than restating it, so each
// rule keeps exactly one definition:
//
//     mutationPathSafetyError   the shared lexical mutation policy, including
//                               this root's `.git/**`. 10C and 10D both refuse
//                               these paths anyway, but only AFTER the marker.
//     requireTransplantable     10D's definition of a transplantable index
//                               state, so `unmerged` and gitlink targets are
//                               refused before the worktree is rewritten.
//     indexStateEqual           against the oracle's own snapshot, which
//                               preparation has already paid to read.

import type { IndexState, PathState } from "@viberevert/session-format";

import { requireTransplantable, transplantIndexPath } from "./index-transplant.js";
import { mutationPathSafetyError } from "./mutation-path-safety.js";
import {
  type IndexSnapshot,
  indexStateEqual,
  pathStateEqual,
  readIndexSnapshot,
  worktreeStateEqual,
} from "./path-state.js";
import type {
  SelectiveRestoreClassification,
  SelectiveRestoreOperation,
  SelectiveRestorePlan,
} from "./restore-selective.js";
import {
  createWorktreeDirectory,
  materializeWorktreeLeaf,
  removeWorktreePath,
} from "./worktree-materialize.js";

// =============================================================================
// Types
// =============================================================================
//
// Exported so declaration emit can name them from `PreparedSelectiveTransplant`,
// the same TS4081 constraint that governs 10D's narrowed index types. None of
// them reaches the package barrel.

export interface LeafWrite {
  readonly path: string;
  readonly target: PathState;
}

export interface IndexWrite {
  readonly path: string;
  readonly target: IndexState;
}

/**
 * Phase 4, with its snapshot attached rather than beside it.
 *
 * A separate `oracleIndex?: IndexSnapshot` next to a `writes` array would make
 * "writes exist, snapshot does not" representable, and the only place to catch
 * it would be after the marker. This shape makes it unrepresentable.
 */
export type PreparedIndexPhase =
  | { readonly kind: "none" }
  | {
      readonly kind: "writes";
      readonly writes: readonly IndexWrite[];
      readonly oracleIndex: IndexSnapshot;
    };

/** Everything the mutation phases need, fixed before the fence and the marker. */
export interface PreparedSelectiveTransplant {
  readonly removals: readonly string[];
  readonly directories: readonly string[];
  readonly leaves: readonly LeafWrite[];
  readonly indexPhase: PreparedIndexPhase;
}

/** Internal: the pure projection, before the oracle snapshot is acquired. */
interface DerivedSchedule {
  readonly removals: readonly string[];
  readonly directories: readonly string[];
  readonly leaves: readonly LeafWrite[];
  readonly indexWrites: readonly IndexWrite[];
}

type SyntheticParentOperation = Extract<
  SelectiveRestoreOperation,
  { kind: "create_parent_directory" }
>;

// =============================================================================
// Ordering and refusal helpers
// =============================================================================

const depthOf = (path: string): number => {
  let depth = 0;
  for (const ch of path) if (ch === "/") depth += 1;
  return depth;
};

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const deepestFirst = (a: string, b: string): number => depthOf(b) - depthOf(a) || byPath(a, b);

const shallowestFirst = (a: string, b: string): number => depthOf(a) - depthOf(b) || byPath(a, b);

function invariant(path: string, detail: string): never {
  throw new Error(
    `cannot prepare the transplant at ${JSON.stringify(path)}: ${detail}, which an eligible plan cannot contain`,
  );
}

/** The shared mutation policy's own message, not a restatement of its rules. */
function requireSafeMutationPath(path: string): void {
  const message = mutationPathSafetyError(path, "prepareSelectiveTransplant");
  if (message !== null) throw new Error(message);
}

/** `"a"` strictly precedes `"a/b"`, and never itself. */
const strictlyPrecedes = (ancestor: string, descendant: string): boolean =>
  descendant.startsWith(`${ancestor}/`);

const isRestoreRequired = (classification: SelectiveRestoreClassification): boolean =>
  classification.outcome.kind === "planned" &&
  classification.outcome.disposition === "restore_required";

// =============================================================================
// Authority links
// =============================================================================

/** One classification per path, so the operation link below is unambiguous. */
function classificationsByPath(
  classifications: readonly SelectiveRestoreClassification[],
): ReadonlyMap<string, SelectiveRestoreClassification> {
  const map = new Map<string, SelectiveRestoreClassification>();
  for (const classification of classifications) {
    if (map.has(classification.path)) {
      invariant(classification.path, "two classifications name the same physical path");
    }
    map.set(classification.path, classification);
  }
  return map;
}

/**
 * Link a candidate to the classification whose evidence was validated.
 *
 * This is what makes "the oracle was proven for this state" a statement about
 * the state being mutated, rather than about a sibling the plan happens to
 * carry.
 */
function requireClassificationFor(
  classifications: ReadonlyMap<string, SelectiveRestoreClassification>,
  path: string,
  changeGroupId: string,
  observed: PathState,
  target: PathState,
): void {
  const classification = classifications.get(path);
  if (classification === undefined) {
    invariant(path, "the operation has no matching classification");
  }
  if (classification.changeGroupId !== changeGroupId) {
    invariant(path, "the operation and its classification disagree on the change group");
  }
  if (!isRestoreRequired(classification)) {
    invariant(path, "the operation's classification is not a planned restore_required candidate");
  }
  if (!pathStateEqual(observed, classification.observed)) {
    invariant(path, "the operation's observed state differs from its classification's");
  }
  if (!pathStateEqual(target, classification.expectedBefore)) {
    invariant(path, "the operation's target differs from its classification's expectedBefore");
  }

  // Stage A's own relation. It returns `restore_required` only where the
  // observation equals the recorded AFTER state, and `already_at_before` is
  // tested first, so a restore_required classification cannot be at BEFORE.
  if (!pathStateEqual(classification.observed, classification.expectedAfter)) {
    invariant(path, "the classification's observed state is not its recorded AFTER state");
  }
  if (pathStateEqual(classification.observed, classification.expectedBefore)) {
    invariant(
      path,
      "the classification is already at its BEFORE state, which stage A classifies already_at_before",
    );
  }
}

/**
 * Establish that a synthetic parent is genuinely required by candidates this
 * preparation already validated. Runs in pass 2, against the COMPLETE candidate
 * map, so lexical operation order carries no authority.
 */
function requireParentAuthority(
  op: SyntheticParentOperation,
  classifications: ReadonlyMap<string, SelectiveRestoreClassification>,
  candidateTargets: ReadonlyMap<string, PathState>,
): void {
  // Shape: create an absent directory, touching no index.
  if (op.observed.worktree.kind !== "absent") {
    invariant(
      op.path,
      `a synthetic parent was observed as ${op.observed.worktree.kind} rather than absent`,
    );
  }
  if (op.target.worktree.kind !== "directory") {
    invariant(op.path, `a synthetic parent targets ${op.target.worktree.kind}`);
  }
  if (!indexStateEqual(op.observed.index, op.target.index)) {
    invariant(op.path, "a synthetic parent carries an index transition");
  }
  if (classifications.has(op.path)) {
    invariant(op.path, "a synthetic parent shares its path with a classification");
  }

  // Authority: why this path may be created at all. Because every entry names a
  // candidate that already passed the selected-group check, a synthetic parent
  // inherits that authorization transitively.
  if (op.requiredBy.length === 0) {
    invariant(op.path, "a synthetic parent names no candidate requiring it");
  }
  for (const required of op.requiredBy) {
    const requiredTarget = candidateTargets.get(required);
    if (requiredTarget === undefined) {
      invariant(
        op.path,
        `a synthetic parent is required by ${JSON.stringify(required)}, which is not a restore candidate`,
      );
    }
    if (!strictlyPrecedes(op.path, required)) {
      invariant(
        op.path,
        `a synthetic parent is required by ${JSON.stringify(required)}, which is not beneath it`,
      );
    }
    if (requiredTarget.worktree.kind === "absent") {
      invariant(
        op.path,
        `a synthetic parent is required by ${JSON.stringify(required)}, which restores no worktree node`,
      );
    }
  }
}

// =============================================================================
// Derivation
// =============================================================================

/**
 * Project the plan onto the four phases, refusing every shape the planner says
 * cannot exist. Pure and synchronous; it touches no filesystem at all.
 */
function deriveSchedule(plan: SelectiveRestorePlan): DerivedSchedule {
  if (plan.outcome !== "eligible") {
    throw new Error(
      `the transplant requires an eligible plan, received ${JSON.stringify(plan.outcome)}`,
    );
  }
  if (plan.conflicts.length > 0) {
    // Statically impossible for the `eligible` member, whose `conflicts` is the
    // empty tuple. Checked anyway: a fabricated plan is a runtime value, and an
    // eligible plan carrying an unresolved conflict must never cross into
    // mutation.
    throw new Error("an eligible plan carries unresolved conflicts, so no mutation may proceed");
  }

  const classifications = classificationsByPath(plan.classifications);
  const selectedGroups = new Set(plan.selectedChangeGroupIds);
  const removals: string[] = [];
  const directories: string[] = [];
  const leaves: LeafWrite[] = [];
  const indexWrites: IndexWrite[] = [];

  // One operation per physical path. Two operations on one path would let the
  // second act against a node the first already changed. Plan stabilization
  // cannot catch this: it keys operations by path through a `Map`, which
  // silently drops the duplicate rather than reporting it.
  const seen = new Set<string>();
  const candidateTargets = new Map<string, PathState>();
  const syntheticParents: SyntheticParentOperation[] = [];

  // ---- Pass 1: candidates, linked to their evidence and authorization ------
  for (const op of plan.operations) {
    if (seen.has(op.path)) invariant(op.path, "two operations name the same physical path");
    seen.add(op.path);

    // Lexical policy first, for BOTH kinds: a synthetic parent is `mkdir`ed too.
    requireSafeMutationPath(op.path);

    if (op.kind === "create_parent_directory") {
      syntheticParents.push(op);
      continue;
    }

    // Authorization before evidence: the plan's own selection list.
    if (!selectedGroups.has(op.changeGroupId)) {
      invariant(
        op.path,
        `the operation restores change group ${JSON.stringify(op.changeGroupId)}, which the plan did not select`,
      );
    }

    requireClassificationFor(classifications, op.path, op.changeGroupId, op.observed, op.target);

    const observed = op.observed.worktree;
    const target = op.target.worktree;
    if (observed.kind === "unsupported") {
      invariant(op.path, "the observed worktree state is unsupported");
    }
    if (target.kind === "unsupported") {
      invariant(op.path, "the target worktree state is unsupported");
    }
    if (target.kind === "directory") {
      invariant(
        op.path,
        "a restore candidate targets a directory, and directory creation belongs to create_parent_directory",
      );
    }
    if (target.kind === "symlink" && !plan.capabilities.symlinkCheckout) {
      // Stage A's own unsupported-state decision, frozen into the plan. A
      // fabricated eligible plan must not reach the materializer around it.
      invariant(
        op.path,
        "the target is a symlink, but the plan was produced without symlink-checkout capability",
      );
    }

    // 10D's own authority, so "transplantable" has one definition.
    requireTransplantable(op.observed.index, "observed", op.path);
    requireTransplantable(op.target.index, "target", op.path);

    candidateTargets.set(op.path, op.target);

    if (!worktreeStateEqual(observed, target)) {
      if (observed.kind !== "absent" && observed.kind !== target.kind) {
        removals.push(op.path);
      }
      if (target.kind !== "absent") {
        leaves.push({ path: op.path, target: op.target });
      }
    }

    if (!indexStateEqual(op.observed.index, op.target.index)) {
      indexWrites.push({ path: op.path, target: op.target.index });
    }
  }

  // ---- Pass 1b: no conflicts, and total completeness -----------------------
  //
  // The conflict scan is independent of `plan.conflicts` so a fabricated empty
  // conflicts array cannot hide a conflicted classification. The completeness
  // scan is the other direction of the evidence link: `writePathsOf` filters
  // exactly `planned` + `restore_required`, so every such classification MUST
  // have an operation, or the plan executes part of what its evidence covers and
  // silently skips the rest. Duplicates were rejected above, so presence here
  // means exactly one.
  for (const classification of plan.classifications) {
    if (classification.outcome.kind === "conflict") {
      invariant(classification.path, "an eligible plan carries a conflicted classification");
    }
    if (!isRestoreRequired(classification)) continue;
    if (!candidateTargets.has(classification.path)) {
      invariant(
        classification.path,
        "a restore_required classification has no restore-candidate operation",
      );
    }
  }

  // ---- Pass 2: synthetic parents, against the COMPLETE candidate map -------
  for (const op of syntheticParents) {
    requireParentAuthority(op, classifications, candidateTargets);
    directories.push(op.path);
  }

  return {
    removals: removals.sort(deepestFirst),
    directories: directories.sort(shallowestFirst),
    leaves: leaves.sort((a, b) => byPath(a.path, b.path)),
    indexWrites: indexWrites.sort((a, b) => byPath(a.path, b.path)),
  };
}

/**
 * Require the oracle to actually hold what every index write installs.
 *
 * 10D re-checks this per path at mutation time, which is correct for a primitive
 * that must not depend on an upstream check. Doing it here as well moves the
 * discovery of a contradiction to before the marker, at no extra cost: the
 * snapshot is already in hand.
 */
function requireOracleAgreement(writes: readonly IndexWrite[], oracleIndex: IndexSnapshot): void {
  for (const write of writes) {
    // The absent-entry convention used by `index-transplant.ts` and
    // `path-state.ts`: a path the snapshot does not hold is a real `absent`
    // state, not missing data.
    const oracleState: IndexState = oracleIndex.byPath.get(write.path) ?? { kind: "absent" };
    requireTransplantable(oracleState, "oracle", write.path);
    if (!indexStateEqual(oracleState, write.target)) {
      throw new Error(
        `cannot prepare the transplant at ${JSON.stringify(write.path)}: the oracle's index entry does not match the state the plan restores`,
      );
    }
  }
}

/**
 * Validate and derive everything the mutation needs, reading only the oracle.
 *
 * Safe to call before the final fence: the oracle worktree is stable for the
 * whole transaction and is never a mutation target.
 */
export async function prepareSelectiveTransplant(
  oracleWorktree: string,
  plan: SelectiveRestorePlan,
): Promise<PreparedSelectiveTransplant> {
  const schedule = deriveSchedule(plan);

  const mutations =
    schedule.removals.length +
    schedule.directories.length +
    schedule.leaves.length +
    schedule.indexWrites.length;
  if (mutations === 0) {
    // A backstop rather than the primary detector: per-candidate checks above
    // already reject a no-op candidate. An empty executable set is outcome
    // `noop`, which never reaches here, and a marker published for this would
    // claim mutation may have started when nothing could have.
    throw new Error(
      "the transplant derived no mutations from an eligible plan, so the plan disagrees with itself",
    );
  }

  let indexPhase: PreparedIndexPhase = { kind: "none" };
  if (schedule.indexWrites.length > 0) {
    // Evidence before destruction, as in 10C: a malformed or disagreeing oracle
    // index surfaces while the real checkout is untouched. Read once for the
    // whole transplant (§15).
    const oracleIndex = await readIndexSnapshot(oracleWorktree);
    requireOracleAgreement(schedule.indexWrites, oracleIndex);
    indexPhase = { kind: "writes", writes: schedule.indexWrites, oracleIndex };
  }

  return {
    removals: schedule.removals,
    directories: schedule.directories,
    leaves: schedule.leaves,
    indexPhase,
  };
}

// =============================================================================
// Execution
// =============================================================================

/**
 * Execute §13's schedule. THIS MUTATES THE REPOSITORY, and must run only after
 * the fence has passed and the attempt marker has been published.
 *
 * Contains no refusal of its own, deliberately: every deterministic failure was
 * settled by `prepareSelectiveTransplant` before the marker existed, and the
 * prepared value's shape carries the rest. The primitives keep their own safety
 * validation and may still throw here; that is a race, not a decision this
 * schedule could have made earlier.
 *
 * Phases run sequentially. Within a phase the operations are independent and
 * could overlap, but a deterministic order makes a mid-transplant failure
 * reproducible and attributable to one path, which matters far more here than
 * throughput.
 *
 * Returns nothing. The plan already describes what was to be done and each
 * primitive's error names its own path, so a progress report would duplicate the
 * plan without adding recoverable information. Recovery after a failure goes
 * through the marker's `pre_rollback_checkpoint_id`.
 */
export async function executePreparedSelectiveTransplant(
  repoRoot: string,
  oracleWorktree: string,
  prepared: PreparedSelectiveTransplant,
): Promise<void> {
  for (const path of prepared.removals) {
    await removeWorktreePath(repoRoot, path);
  }

  for (const path of prepared.directories) {
    await createWorktreeDirectory(repoRoot, path);
  }

  for (const leaf of prepared.leaves) {
    await materializeWorktreeLeaf(repoRoot, oracleWorktree, leaf.path, leaf.target);
  }

  if (prepared.indexPhase.kind === "writes") {
    const { writes, oracleIndex } = prepared.indexPhase;
    for (const write of writes) {
      await transplantIndexPath(repoRoot, write.path, write.target, oracleIndex);
    }
  }
}
