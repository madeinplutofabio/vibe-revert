// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Execution obligations and progress (M 0.8.0 step 10F, F3).
//
// The evidence layer between a prepared schedule and a receipt. It records what
// the executor ATTEMPTED and COMPLETED, and nothing else.
//
// =============================================================================
// Execution status vocabulary stops before "restored"
// =============================================================================
//
// A completed obligation proves a mutation primitive returned successfully. It
// does not prove the repository reached the state the plan intended. So the
// vocabulary here stops at `execution_complete`, and step 11 owns the final
// transition once it has proven the live PathState equals the oracle:
//
//     execution_complete + verified final state  ->  restored
//
// Collapsing those would let a receipt claim a restoration that nothing
// verified, which is the exact failure this layer exists to prevent.
//
// =============================================================================
// Why obligations sit UNDERNEATH candidates
// =============================================================================
//
// A receipt is path-oriented; execution is phase-oriented. Neither a change
// group nor a physical path is the right unit for the raw facts:
//
//     a rename group holds several candidate paths, and OLD can complete while
//     NEW fails, so a group-keyed record cannot name what failed;
//
//     one `create_parent_directory` serves several candidates through
//     `requiredBy`, so a path-keyed counter cannot express that a single failed
//     `mkdir` leaves BOTH of them incomplete.
//
// So the obligation is the atom, and attribution is many-to-many. Candidate
// outcomes aggregate from obligations; group outcomes aggregate from candidates.
// Information only ever flows in the widening direction, and nothing is ever
// reverse-engineered from a coarser unit.
//
// =============================================================================
// Two views of one schedule
// =============================================================================
//
//     prepared.obligations   an INDEX over the execution program: the same
//                            phase-step objects, payloads included
//     progress.obligations   an immutable evidence PROJECTION of that program
//
// The projection introduces no second authority. It copies the four attribution
// fields and deep-freezes them, for two runtime reasons a type cannot cover.
// `readonly` is erased at compile time, so an unfrozen snapshot could be mutated
// after execution and the gate's returned evidence would drift. And a phase step
// carries payload such as `target`, which a static `ScheduledObligationBase`
// annotation hides without removing, so handing back those references would leak
// scheduler internals into receipt evidence.
//
// Projection happens once, at construction, before the marker.
//
// =============================================================================
// Obligation ids are TRANSACTION-LOCAL and are never persisted
// =============================================================================
//
// An id is a dense index into one prepared schedule, assigned in execution
// order. It exists solely to make in-process bookkeeping cheap and total.
//
// It carries NO durable identity. A receipt or diagnostic naming a failed
// operation must render `phase`, `path`, and `candidatePaths`, never `17`.
// Adding a mutation phase in a later milestone will renumber every obligation
// after it, and that must have exactly zero persisted semantic consequence.
//
// =============================================================================
// Where correctness is actually established
// =============================================================================
//
// Writing a state is an array assignment, and a wrong numeric index would
// silently extend the array rather than fail. That is acceptable ONLY because
// the safety property is positional rather than defensive:
//
//     the prepared schedule validates every id before the marker
//     the executor obtains ids only from that prepared schedule
//     post-marker bookkeeping performs no validation and no lookup
//
// The progress bookkeeping in the post-marker region is WRITE-ONLY: it records
// state transitions without validation or lookup, so it cannot discover a new
// invalid condition. Progress evidence is read only after execution has
// succeeded or thrown. The executor of course still reads its own schedule after
// the marker; it is the bookkeeping, not the region, that asks no questions.
//
// =============================================================================
// Derivation fails toward "failed"
// =============================================================================
//
// `deriveCandidateExecutionOutcomes` runs after the repository is already in
// whatever state it reached, so throwing there would destroy a receipt rather
// than protect anything. It is therefore total.
//
// It reaches `not_attempted` only when every obligation is affirmatively
// `pending`, and it reaches `execution_complete` only when a non-empty
// obligation set is entirely `completed` under attribution proven reciprocal in
// BOTH directions. Anything else, including evidence that contradicts itself, is
// `failed`.
//
// The reverse direction is not symmetry for its own sake. Checking only that
// each listed id names this candidate would let a record that OMITS a shared
// parent report `not_attempted` while that parent was already attempted, which
// is the single most dangerous wrong answer available here. A false "you may
// need to recover" is cheap; a false "nothing happened" is not.
//
// `prepareSelectiveTransplant` remains responsible for proving these conditions
// BEFORE the marker. The checks here are defense against corrupted evidence, not
// a second validation gate, which is why they classify rather than throw.

/** The four phases of the §13 schedule, in execution order. */
export type ObligationPhase = "removal" | "directory" | "leaf" | "index";

/**
 * What every scheduled step is, independent of its phase-specific payload.
 *
 * The progress layer sees exactly this projection. It never needs a `target`,
 * and typing it against the payload union would invert the package's internal
 * dependency direction for no gain.
 */
export interface ScheduledObligationBase {
  /** Dense index into this transaction's schedule. NOT durable identity. */
  readonly id: number;
  readonly phase: ObligationPhase;
  /** The physical path this step mutates. */
  readonly path: string;
  /**
   * The candidate paths this step serves.
   *
   * Exactly one for a restore candidate's own removal, leaf, or index write.
   * Possibly several for a synthetic parent directory, which is the whole
   * reason attribution is a list rather than a single value.
   */
  readonly candidatePaths: readonly string[];
}

/**
 * One physical restore candidate.
 *
 * Identity is the PATH. `changeGroupId` rides along as metadata so a receipt can
 * group without the execution layer ever keying on it, since one group may hold
 * several candidates whose outcomes diverge.
 */
export interface RestoreCandidateRecord {
  readonly path: string;
  readonly changeGroupId: string;
  /** Ascending, in execution order. May include a shared synthetic parent. */
  readonly obligationIds: readonly number[];
}

export type ObligationState = "pending" | "attempted" | "completed";

/**
 * A self-describing, deeply frozen snapshot of execution facts.
 *
 * It carries its own schedule description so downstream layers can interpret
 * `states` without the gate returning `PreparedSelectiveTransplant`. Leaking the
 * prepared value would export the scheduler's execution representation purely so
 * a receipt could read three fields off it.
 */
export interface SelectiveTransplantProgress {
  readonly obligations: readonly ScheduledObligationBase[];
  readonly candidates: readonly RestoreCandidateRecord[];
  /** Indexed by obligation id. */
  readonly states: readonly ObligationState[];
}

/**
 * The live accumulator, owned by the gate.
 *
 * Deliberately not a caller-supplied callback: post-marker safety must not
 * depend on arbitrary code choosing not to throw. Both mark methods are
 * synchronous, total, and do nothing but assign.
 */
export interface TransplantProgressAccumulator {
  markAttempted(id: number): void;
  markCompleted(id: number): void;
  /** Detached and frozen, so returned evidence cannot drift or be edited. */
  snapshot(): SelectiveTransplantProgress;
}

export function createTransplantProgress(
  obligations: readonly ScheduledObligationBase[],
  candidates: readonly RestoreCandidateRecord[],
): TransplantProgressAccumulator {
  // Projected and frozen ONCE, before the marker: field-by-field so no phase
  // payload survives, and deeply so `readonly` is backed at runtime.
  const evidenceObligations: readonly ScheduledObligationBase[] = Object.freeze(
    obligations.map((obligation) =>
      Object.freeze({
        id: obligation.id,
        phase: obligation.phase,
        path: obligation.path,
        candidatePaths: Object.freeze([...obligation.candidatePaths]),
      }),
    ),
  );

  const evidenceCandidates: readonly RestoreCandidateRecord[] = Object.freeze(
    candidates.map((candidate) =>
      Object.freeze({
        path: candidate.path,
        changeGroupId: candidate.changeGroupId,
        obligationIds: Object.freeze([...candidate.obligationIds]),
      }),
    ),
  );

  const states: ObligationState[] = evidenceObligations.map(() => "pending");

  return {
    markAttempted(id) {
      states[id] = "attempted";
    },
    markCompleted(id) {
      states[id] = "completed";
    },
    snapshot() {
      // Only `states` is live, so only it is copied; the projections above are
      // already immutable and are shared across snapshots deliberately.
      return Object.freeze({
        obligations: evidenceObligations,
        candidates: evidenceCandidates,
        states: Object.freeze([...states]),
      });
    },
  };
}

export type CandidateExecutionStatus = "execution_complete" | "failed" | "not_attempted";

export interface CandidateExecutionOutcome {
  readonly path: string;
  readonly changeGroupId: string;
  readonly status: CandidateExecutionStatus;
}

/**
 * Classify one candidate from the obligations attributed to it.
 *
 * Total by construction. Every path out of here is a status, never a throw,
 * because this runs after mutation and a lost receipt is worse than a
 * conservative one.
 */
function statusFor(
  progress: SelectiveTransplantProgress,
  candidate: RestoreCandidateRecord,
): CandidateExecutionStatus {
  // Preparation forbids a zero-obligation candidate. If one appears anyway, the
  // vacuous reading of the loop below would be `execution_complete`, which is
  // the one direction this layer must never fail in.
  if (candidate.obligationIds.length === 0) return "failed";

  // Attribution, recomputed from the obligation table rather than trusted from
  // the candidate record. This is the direction that catches an OMITTED id: a
  // record dropping a shared parent that was already attempted would otherwise
  // classify as `not_attempted`.
  const attributed = progress.obligations.filter((obligation) =>
    obligation.candidatePaths.includes(candidate.path),
  );
  if (attributed.length !== candidate.obligationIds.length) return "failed";

  let allCompleted = true;
  let allPending = true;

  // Both sides are in execution order, so exact positional correspondence
  // catches omitted, extra, duplicated, and reordered ids without normalizing
  // either side. The identity comparison additionally proves the table really is
  // indexed by its own ids.
  for (let i = 0; i < attributed.length; i += 1) {
    const obligation = attributed[i];
    const id = candidate.obligationIds[i];
    if (obligation === undefined || id === undefined) return "failed";

    const state = progress.states[id];
    if (obligation.id !== id || progress.obligations[id] !== obligation || state === undefined) {
      return "failed";
    }

    if (state !== "completed") allCompleted = false;
    if (state !== "pending") allPending = false;
  }

  if (allCompleted) return "execution_complete";
  if (allPending) return "not_attempted";
  return "failed";
}

/**
 * Reduce raw obligation states to one status per candidate.
 *
 * Pure and total. There is no last-writer rule and no phase precedence: a
 * candidate is complete only when EVERY obligation attributed to it completed,
 * which is what makes a failed shared parent, a failed index write after a
 * successful worktree phase, and an unreached candidate all fall out of the
 * same conditions.
 *
 * Attribution order is significant evidence: preparation records obligation ids
 * in execution order, and a reordered candidate record is inconsistent and
 * therefore classifies as `failed`.
 *
 * A candidate that finished before an unrelated later candidate threw stays
 * `execution_complete`. Its own obligations all completed, and the transaction's
 * overall failure is not evidence about it.
 */
export function deriveCandidateExecutionOutcomes(
  progress: SelectiveTransplantProgress,
): readonly CandidateExecutionOutcome[] {
  return progress.candidates.map((candidate) => ({
    path: candidate.path,
    changeGroupId: candidate.changeGroupId,
    status: statusFor(progress, candidate),
  }));
}
