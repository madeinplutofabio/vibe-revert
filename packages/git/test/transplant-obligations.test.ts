// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the execution-evidence layer (M 0.8.0 step 10F, F3).
//
// Five sections:
//   A. the frozen projection    (1-2)
//   B. derivation               (3-7)
//   C. corrupted evidence       (8-12)
//   D. the recorded brand       (13-14)
//   E. attribution consistency  (15-16)
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
  candidateAttributionIsConsistent,
  createTransplantProgress,
  deriveCandidateExecutionOutcomes,
  type ObligationPhase,
  type ObligationState,
  type RecordedTransplantProgress,
  type RestoreCandidateRecord,
  type ScheduledObligationBase,
  type SelectiveTransplantProgress,
} from "../src/transplant-obligations.js";

// =============================================================================
// Fixtures
// =============================================================================

const GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000001";

/**
 * The brand is a REAL narrowing, pinned at compile time.
 *
 * If it were ever erased, the structural type would extend the branded one and
 * this annotation would resolve to `false`. That is the property step 11 relies
 * on: an ordinary `SelectiveTransplantProgress` must not satisfy its signature.
 */
const BRAND_NARROWS: SelectiveTransplantProgress extends RecordedTransplantProgress ? false : true =
  true;

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

// =============================================================================
// Section D: the recorded brand
// =============================================================================
//
// The brand is a compile-time provenance marker with a runtime carrier, not a
// security boundary: a cast forges it and any holder can recover the symbol.
// What these cases pin is that it EXISTS at runtime, that it adds no enumerable
// data, and that it genuinely narrows the type.

describe("createTransplantProgress: the recorded brand", () => {
  it("13: a snapshot is frozen and carries exactly one non-enumerable symbol", () => {
    const snap = createTransplantProgress(SHARED, SHARED_CANDIDATES).snapshot();

    expect(Object.isFrozen(snap)).toBe(true);

    const symbols = Object.getOwnPropertySymbols(snap);
    expect(symbols).toHaveLength(1);
    const brand = symbols[0];
    if (brand === undefined) throw new Error("fixture: expected a brand symbol");

    // Pin the brand's final observable descriptor. It must remain inert during
    // ordinary enumeration and immutable with the rest of the snapshot.
    expect(Object.getOwnPropertyDescriptor(snap, brand)).toEqual({
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });

    // Compile-time: the branded type is strictly narrower.
    expect(BRAND_NARROWS).toBe(true);
  });

  it("14: the brand adds no enumerable data", () => {
    const snap = createTransplantProgress(SHARED, SHARED_CANDIDATES).snapshot();

    // Non-enumerable, so it does not travel through a spread. This is why the
    // existing structural expectations in this file are unaffected.
    expect(Object.getOwnPropertySymbols({ ...snap })).toEqual([]);
    expect(Object.keys(snap)).toEqual(["obligations", "candidates", "states"]);
    expect(JSON.parse(JSON.stringify(snap))).toEqual({
      obligations: [...SHARED],
      candidates: [...SHARED_CANDIDATES],
      states: ["pending", "pending", "pending"],
    });

    // A structurally identical hand-built value carries no brand. Its ordinary
    // enumerable representation still equals the genuine snapshot's spread.
    const structural = progressOf(SHARED, SHARED_CANDIDATES, ["pending", "pending", "pending"]);
    expect(Object.getOwnPropertySymbols(structural)).toEqual([]);
    expect(structural).toEqual({ ...snap });
  });
});

// =============================================================================
// Section E: attribution consistency
// =============================================================================
//
// The distinction `deriveCandidateExecutionOutcomes` deliberately collapses.
// `failed` is both a legitimate execution answer and the conservative answer for
// corrupt evidence, so step 11 needs a second question to tell them apart: it
// owes a normal outcome to the first and an evidence violation to the second.

describe("candidateAttributionIsConsistent", () => {
  it("15: a genuine mixed execution is CONSISTENT, and still classifies as failed", () => {
    // A completed shared parent, an attempted own leaf, an untouched sibling.
    // Nothing about this graph contradicts itself; the candidate simply did not
    // finish. Collapsing the two questions would make this indistinguishable
    // from corruption.
    const progress = progressOf(SHARED, SHARED_CANDIDATES, ["completed", "attempted", "pending"]);
    const candidate = SHARED_CANDIDATES[0];
    if (candidate === undefined) throw new Error("fixture: expected a candidate");

    expect(candidate.path).toBe("src/a.ts");
    expect(candidateAttributionIsConsistent(progress, candidate)).toBe(true);
    expect(statusOf(derive(progress), "src/a.ts")).toBe("failed");
  });

  it("16: every corrupt attribution shape is rejected, and still derives failed", () => {
    // Same obligations, array order swapped, so `obligations[0]` is not the
    // obligation whose id is 0.
    const swapped: readonly ScheduledObligationBase[] = [
      obligation(1, "leaf", "src/a.ts", ["src/a.ts"]),
      obligation(0, "directory", "src", ["src/a.ts"]),
    ];

    // One obligation naming this candidate twice. The count comparison alone
    // would see a single match and accept it.
    const doubled: readonly ScheduledObligationBase[] = [
      obligation(0, "directory", "src", ["src/a.ts", "src/a.ts"]),
      obligation(1, "leaf", "src/a.ts", ["src/a.ts"]),
    ];

    const ALL_PENDING: readonly ObligationState[] = ["pending", "pending", "pending"];

    /**
     * The corrupt candidate is the one stored in `progress.candidates`, which is
     * how step 11 will actually reach it: both projections must then agree that
     * the same record is unusable.
     */
    const row = (
      label: string,
      obligations: readonly ScheduledObligationBase[],
      candidate: RestoreCandidateRecord,
      states: readonly ObligationState[],
    ): readonly [string, SelectiveTransplantProgress, RestoreCandidateRecord] => [
      label,
      progressOf(obligations, [candidate], states),
      candidate,
    ];

    const rows = [
      row("no obligation ids", SHARED, candidateRecord("src/a.ts", []), ALL_PENDING),
      row("an omitted shared parent", SHARED, candidateRecord("src/a.ts", [1]), ALL_PENDING),
      row("an extra id", SHARED, candidateRecord("src/a.ts", [0, 1, 2]), ALL_PENDING),
      row("reordered ids", SHARED, candidateRecord("src/a.ts", [1, 0]), ALL_PENDING),
      row("a duplicated id", SHARED, candidateRecord("src/a.ts", [0, 0]), ALL_PENDING),
      row("an id outside the table", SHARED, candidateRecord("src/a.ts", [0, 9]), ALL_PENDING),
      row("a table not indexed by its own ids", swapped, candidateRecord("src/a.ts", [0, 1]), [
        "pending",
        "pending",
      ]),
      row("a missing state", SHARED, candidateRecord("src/a.ts", [0, 1]), ["pending"]),
      row("a state outside the vocabulary", SHARED, candidateRecord("src/a.ts", [0, 1]), [
        "pending",
        // The runtime hazard the TypeScript type cannot express.
        "definitely-not-a-state" as ObligationState,
        "pending",
      ]),
      row(
        "the candidate named twice by one obligation",
        doubled,
        candidateRecord("src/a.ts", [0, 1]),
        ["pending", "pending"],
      ),
    ];

    for (const [label, progress, candidate] of rows) {
      // The new predicate exposes the defect...
      expect(candidateAttributionIsConsistent(progress, candidate), label).toBe(false);
      // ...while the unchanged derivation API still degrades it conservatively.
      expect(statusOf(derive(progress), candidate.path), label).toBe("failed");
    }
  });
});
