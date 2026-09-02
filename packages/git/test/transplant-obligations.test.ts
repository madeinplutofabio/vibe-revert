// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the execution-evidence layer (M 0.8.0 step 10F, F3).
//
// Three sections:
//   A. the frozen projection   (1-2)
//   B. derivation              (3-7)
//   C. corrupted evidence      (8-12)
//
// Deliberately separate from `transplant-schedule.test.ts`. That suite proves
// what preparation DERIVES and what the executor RECORDS; this one proves how
// raw facts are protected and classified. Keeping them together would blur the
// boundary the two modules exist to create.
//
// Section C constructs progress objects that preparation refuses before the
// marker. They are built by hand precisely because the accumulator cannot
// produce them: the point is that derivation, which runs AFTER mutation, never
// throws and never resolves a contradiction in the reassuring direction.

import { describe, expect, it } from "vitest";

import {
  type CandidateExecutionOutcome,
  type CandidateExecutionStatus,
  createTransplantProgress,
  deriveCandidateExecutionOutcomes,
  type ObligationPhase,
  type ObligationState,
  type RestoreCandidateRecord,
  type ScheduledObligationBase,
  type SelectiveTransplantProgress,
} from "../src/transplant-obligations.js";

// =============================================================================
// Fixtures
// =============================================================================

const GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000001";

/**
 * The vocabulary boundary, pinned at COMPILE time.
 *
 * `restored` belongs to step 11, which alone proves the final PathState equals
 * the oracle. If it is ever added to `CandidateExecutionStatus`, this annotation
 * resolves to `false` and the assignment stops compiling. A runtime assertion
 * could not do this: widening the union while leaving the derivation unchanged
 * would still produce outputs containing no such string.
 */
const STATUS_EXCLUDES_RESTORED: "restored" extends CandidateExecutionStatus ? false : true = true;

const obligation = (
  id: number,
  phase: ObligationPhase,
  path: string,
  candidatePaths: readonly string[],
): ScheduledObligationBase => ({ id, phase, path, candidatePaths });

const candidateRecord = (
  path: string,
  obligationIds: readonly number[],
): RestoreCandidateRecord => ({ path, changeGroupId: GROUP, obligationIds });

const progressOf = (
  obligations: readonly ScheduledObligationBase[],
  candidates: readonly RestoreCandidateRecord[],
  states: readonly ObligationState[],
): SelectiveTransplantProgress => ({ obligations, candidates, states });

const derive = deriveCandidateExecutionOutcomes;

const statusOf = (
  outcomes: readonly CandidateExecutionOutcome[],
  path: string,
): CandidateExecutionStatus => {
  const found = outcomes.find((o) => o.path === path);
  if (found === undefined) throw new Error(`fixture: no outcome for ${path}`);
  return found.status;
};

/**
 * The shape that motivated the whole obligation layer: one `mkdir` serving two
 * candidates, each of which also has its own leaf.
 */
const SHARED: readonly ScheduledObligationBase[] = [
  obligation(0, "directory", "src", ["src/a.ts", "src/b.ts"]),
  obligation(1, "leaf", "src/a.ts", ["src/a.ts"]),
  obligation(2, "leaf", "src/b.ts", ["src/b.ts"]),
];

const SHARED_CANDIDATES: readonly RestoreCandidateRecord[] = [
  candidateRecord("src/a.ts", [0, 1]),
  candidateRecord("src/b.ts", [0, 2]),
];

// =============================================================================
// Section A: the frozen projection
// =============================================================================

describe("createTransplantProgress: the evidence projection", () => {
  it("1: the snapshot carries only attribution fields, deeply frozen", () => {
    // A real phase step carries payload. `ScheduledObligationBase` hides it at
    // compile time and does nothing about it at runtime, so the projection is
    // what actually keeps scheduler internals out of receipt evidence. Bound to
    // a variable first, since a direct literal would trip excess-property
    // checking and hide the very situation being tested.
    const withPayload = {
      id: 0,
      phase: "leaf" as const,
      path: "a.ts",
      candidatePaths: ["a.ts"],
      target: { secret: "scheduler payload" },
    };

    const progress = createTransplantProgress([withPayload], [candidateRecord("a.ts", [0])]);
    const snap = progress.snapshot();

    const projected = snap.obligations[0];
    if (projected === undefined) throw new Error("fixture: expected one obligation");
    expect(Object.keys(projected).sort()).toEqual(["candidatePaths", "id", "path", "phase"]);
    expect(projected).not.toBe(withPayload);

    const candidate = snap.candidates[0];
    if (candidate === undefined) throw new Error("fixture: expected one candidate");

    // `readonly` is erased, so the runtime guarantee has to be actual freezing,
    // at every level a caller could reach.
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.obligations)).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.candidatePaths)).toBe(true);
    expect(Object.isFrozen(snap.candidates)).toBe(true);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.obligationIds)).toBe(true);
    expect(Object.isFrozen(snap.states)).toBe(true);
  });

  it("2: a snapshot is detached, and the accumulator stays writable after one", () => {
    const progress = createTransplantProgress(SHARED, SHARED_CANDIDATES);
    progress.markAttempted(0);
    const early = progress.snapshot();

    progress.markCompleted(0);
    const later = progress.snapshot();

    // Freezing the EVIDENCE must not freeze the mechanism: the executor keeps
    // recording after any snapshot is taken.
    expect(early.states).toEqual(["attempted", "pending", "pending"]);
    expect(later.states).toEqual(["completed", "pending", "pending"]);
  });
});

// =============================================================================
// Section B: derivation
// =============================================================================

describe("deriveCandidateExecutionOutcomes: well-formed evidence", () => {
  it("3: every obligation completed is execution_complete, and never restored", () => {
    const outcomes = derive(
      progressOf(SHARED, SHARED_CANDIDATES, ["completed", "completed", "completed"]),
    );
    expect(outcomes.map((o) => o.status)).toEqual(["execution_complete", "execution_complete"]);
    expect(outcomes.map((o) => o.changeGroupId)).toEqual([GROUP, GROUP]);

    // Compile-time, not string matching: see the constant's own comment.
    expect(STATUS_EXCLUDES_RESTORED).toBe(true);
  });

  it("4: every obligation pending is not_attempted", () => {
    const outcomes = derive(
      progressOf(SHARED, SHARED_CANDIDATES, ["pending", "pending", "pending"]),
    );
    expect(outcomes.map((o) => o.status)).toEqual(["not_attempted", "not_attempted"]);
  });

  it("5: a completed shared parent denies not_attempted to every candidate under it", () => {
    // Two distinct facts in one state vector.
    //
    // src/a.ts has an obligation entered but not completed: the primitive may
    // have mutated and then failed, which is why `attempted` is recorded before
    // the call.
    //
    // src/b.ts has NO attempted operation of its own, yet is still not
    // `not_attempted`, because the shared parent it depends on already mutated.
    // That is the shared-parent form of the subtlety F3 exists to preserve.
    const outcomes = derive(
      progressOf(SHARED, SHARED_CANDIDATES, ["completed", "attempted", "pending"]),
    );
    expect(statusOf(outcomes, "src/a.ts")).toBe("failed");
    expect(statusOf(outcomes, "src/b.ts")).toBe("failed");
  });

  it("6: a failed SHARED parent marks every candidate beneath it failed", () => {
    // Neither candidate's own leaf was reached, so a path-keyed model would say
    // `not_attempted` for both. Attribution through `requiredBy` is what makes
    // this answer correct.
    const outcomes = derive(
      progressOf(SHARED, SHARED_CANDIDATES, ["attempted", "pending", "pending"]),
    );
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed"]);
  });

  it("7: a finished candidate is unaffected by a later unrelated failure", () => {
    // src/a.ts completed everything attributed to it before src/b.ts failed.
    // There is no last-writer rule and no transaction-wide downgrade.
    const outcomes = derive(
      progressOf(SHARED, SHARED_CANDIDATES, ["completed", "completed", "attempted"]),
    );
    expect(statusOf(outcomes, "src/a.ts")).toBe("execution_complete");
    expect(statusOf(outcomes, "src/b.ts")).toBe("failed");
  });
});

// =============================================================================
// Section C: corrupted evidence
// =============================================================================
//
// Every case here is refused by `prepareSelectiveTransplant` before the marker.
// These prove the second line of defense: after mutation, derivation classifies
// rather than throwing, and always toward `failed`.

describe("deriveCandidateExecutionOutcomes: corrupted evidence", () => {
  it("8: a candidate with no obligations is failed, not vacuously complete", () => {
    const outcomes = derive(progressOf([], [candidateRecord("src/a.ts", [])], []));
    expect(statusOf(outcomes, "src/a.ts")).toBe("failed");
  });

  it("9: a record that OMITS a shared parent is failed, never not_attempted", () => {
    // THE dangerous case. The parent was attempted, so mutation attributable to
    // this candidate may already have happened. A forward-only check would read
    // only obligation 1, see `pending`, and report `not_attempted`.
    const outcomes = derive(
      progressOf(
        SHARED,
        [candidateRecord("src/a.ts", [1]), candidateRecord("src/b.ts", [0, 2])],
        ["attempted", "pending", "pending"],
      ),
    );
    expect(statusOf(outcomes, "src/a.ts")).toBe("failed");
  });

  it("10: an id that names no matching obligation is failed", () => {
    const outcomes = derive(
      progressOf(
        SHARED,
        [candidateRecord("src/a.ts", [0, 9]), candidateRecord("src/b.ts", [0, 2])],
        ["completed", "completed", "completed"],
      ),
    );
    expect(statusOf(outcomes, "src/a.ts")).toBe("failed");
  });

  it("11: reordered ids are failed, because order is evidence", () => {
    const outcomes = derive(
      progressOf(
        SHARED,
        [candidateRecord("src/a.ts", [1, 0]), candidateRecord("src/b.ts", [0, 2])],
        ["completed", "completed", "completed"],
      ),
    );
    expect(statusOf(outcomes, "src/a.ts")).toBe("failed");
  });

  it("12: a table not indexed by its own ids is failed", () => {
    // Same obligations, array order swapped, so `obligations[0]` is not the
    // obligation whose id is 0.
    const swapped: readonly ScheduledObligationBase[] = [
      obligation(1, "leaf", "src/a.ts", ["src/a.ts"]),
      obligation(0, "directory", "src", ["src/a.ts"]),
    ];
    const outcomes = derive(
      progressOf(swapped, [candidateRecord("src/a.ts", [0, 1])], ["completed", "completed"]),
    );
    expect(statusOf(outcomes, "src/a.ts")).toBe("failed");
  });
});
