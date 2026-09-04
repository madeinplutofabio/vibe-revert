// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The selective-apply command result.
//
// A MAPPING LAYER over `SelectiveRestoreTransactionResult`, not a second model
// of the same events. The transaction already decides what happened inside the
// repository. This module decides what the COMMAND achieved, which is a
// different question with one extra axis: whether durable evidence of the
// attempt now exists.
//
// That axis is why there is no `succeeded` outcome. A completed, verified
// mutation whose receipt could not be persisted is NOT a success: the next
// invocation's admission gate reads an unfinalized attempt marker and fails
// closed, and the operator is told to recover. Reporting "succeeded" beside a
// failed receipt would describe the repository accurately and the operation
// misleadingly. So the command's terminal outcomes are `finalized` and
// `finalization_failed`, and whether the mutation itself succeeded is read from
// the evidence they carry.
//
// =============================================================================
// Two evidence sources for a receipt
// =============================================================================
//
// A receipt is finalizable from EITHER of two sources, and they are not
// interchangeable:
//
//   - `gate_result`: a gate outcome is in hand, either directly on the arms
//     that carry `gate`, or nested at `marker.gate` when a marker-bearing
//     failure reports `published`.
//   - `inspected_publication`: the transaction reported `possibly_published`
//     and inspecting the PREALLOCATED invocation found this attempt's marker.
//     Publication is proven, so the mutation was authorized and a receipt is
//     owed. But there is NO gate result: inspecting a marker cannot
//     retroactively produce one. The mapped receipt records the gate and the
//     first verification as unavailable, which is what
//     `gate_result_unavailable` exists for in the receipt schema.
//
// The inspection evidence therefore travels all the way through finalization
// rather than being consumed at the routing step, because the receipt mapper
// needs to know WHICH source it is working from.
//
// The `marker.gate` half of the first source is DEFENSIVE, not live. The
// exported `SelectiveRestoreTransactionResult` permits a failure arm whose
// marker is `published`, but the current transaction implementation cannot
// produce one: after it sets that marker the only remaining statement is a
// try/catch whose branches both return, so no throw can escape to the arm that
// would carry it. The routing below still handles it, exhaustively and without
// special-casing. Deleting the branch on the strength of reading another
// package's control flow would leave this module wrong the moment that flow
// changes; the sound way to remove it is to NARROW the upstream public result
// type, after which this branch stops type-checking and goes away on its own.
//
// =============================================================================
// The recovery checkpoint is OBSERVED, never inferred
// =============================================================================
//
// `RecoveryCheckpointState` is recorded by the command as it wraps the
// `createRecoveryCheckpoint` callback. It is NOT derived from the transaction's
// phase, and that is deliberate. Inferring it would mean a transaction phase
// added later, which this module has never heard of, could be classified into a
// bucket that asserts a created recovery handle, fabricating a recovery
// instruction pointing at a checkpoint that may not exist.
//
// So routing is driven by the observed recovery state, and the transaction is
// used to CHECK it. An impossible pairing becomes `internal_mapping_failure`
// carrying both halves, rather than being resolved by assumption in either
// direction. E creation has its own arm because its recovery state is `failed`
// or `indeterminate`, which is neither the `not_created` of a pre-E stop nor
// the `created` of everything afterwards.
//
// =============================================================================
// Exhaustiveness, with the strongest tool available at each level
// =============================================================================
//
// `outcome` is a real discriminant across the transaction's arms, so `epochOf`
// closes with a `never` binding: a NEW OUTCOME is a compile error.
//
// `phase` is not. It is a union-valued property on a SINGLE object type, so
// TypeScript cannot narrow the object from it and no control-flow `never` is
// reachable. `marker.status` has the same shape. Two mechanisms cover both:
//
//   - `NoMarkerPhaseCoverage` and `MarkerStatusCoverage` below are type-level
//     assertions that the groups partition each vocabulary. A NEW PHASE or a
//     NEW MARKER STATUS is a compile error there.
//   - at runtime an unclassified value becomes the `unclassified` epoch, which
//     routes to `internal_mapping_failure`.
//
// Marker status earns the same demand as phase because it decides whether the
// mutation was AUTHORIZED, which is the most consequential fact this module
// reads.
//
// Both directions of a silent default are unacceptable, which is why neither is
// available: defaulting to post-E would invent a recovery handle, and defaulting
// to pre-E would deny a real one.

import type { SelectiveRestoreTransactionResult } from "@viberevert/git";
import type { SelectiveRollbackReceipt } from "@viberevert/session-format";
import type { PublicationInspection } from "./rollback-history.js";

type Tx<T> = SelectiveRestoreTransactionResult<T>;

type AssertNever<T extends never> = T;

export type TransactionFailure<T> = Extract<Tx<T>, { readonly outcome: "failed" }>;

/** The failure arms that report a marker state. */
export type MarkerBearingFailure<T> = Extract<TransactionFailure<T>, { readonly marker: unknown }>;

type FailureWithoutMarker<T> = Exclude<TransactionFailure<T>, MarkerBearingFailure<T>>;

/**
 * The transaction's marker vocabulary, reached without a barrel export.
 *
 * Instantiated at `unknown` because the marker type carries no command-result
 * evidence. If it ever gains any, this alias must become generic the same way
 * `PreconditionChangedFrom` is.
 */
export type TransactionMarkerState = MarkerBearingFailure<unknown>["marker"];

/** A marker status no group below claims. Must stay `never`. */
export type MarkerStatusCoverage = AssertNever<
  Exclude<TransactionMarkerState["status"], "not_published" | "possibly_published" | "published">
>;

type MarkerOf<S extends TransactionMarkerState["status"]> = Extract<
  TransactionMarkerState,
  { readonly status: S }
>;

export type PublishedMarkerFailure<T> = MarkerBearingFailure<T> & {
  readonly marker: MarkerOf<"published">;
};
export type PossiblyPublishedFailure<T> = MarkerBearingFailure<T> & {
  readonly marker: MarkerOf<"possibly_published">;
};
export type NotPublishedMarkerFailure<T> = MarkerBearingFailure<T> & {
  readonly marker: MarkerOf<"not_published">;
};

// Phase groups. `Extract` DOES narrow here, because this is a string-literal
// union rather than a property on an object arm, so a renamed phase collapses
// the alias to `never` and surfaces at its use sites.
type PhaseWithoutMarker = FailureWithoutMarker<unknown>["phase"];
type BeforeRecoveryPhase = Extract<PhaseWithoutMarker, "capture_expected_state" | "stabilize_plan">;
type RecoveryAttemptPhase = Extract<PhaseWithoutMarker, "create_recovery_checkpoint">;
type AfterRecoveryPhase = Extract<PhaseWithoutMarker, "validate_recovery_handle">;

/** A no-marker phase no group above claims. Must stay `never`. */
export type NoMarkerPhaseCoverage = AssertNever<
  Exclude<PhaseWithoutMarker, BeforeRecoveryPhase | RecoveryAttemptPhase | AfterRecoveryPhase>
>;

type FailureAtPhase<T, P extends PhaseWithoutMarker> = FailureWithoutMarker<T> & {
  readonly phase: P;
};

export type PreRecoveryFailure<T> = FailureAtPhase<T, BeforeRecoveryPhase>;
export type RecoveryAttemptFailure<T> = FailureAtPhase<T, RecoveryAttemptPhase>;
export type AfterRecoveryValidationFailure<T> = FailureAtPhase<T, AfterRecoveryPhase>;

/**
 * Generic in `T` even though these arms carry no command-result evidence today.
 * Pinning them at a concrete instantiation would silently discard any evidence
 * added to them later.
 */
type PreconditionChangedFrom<T, S extends "stabilization" | "final_fence"> = Extract<
  Tx<T>,
  { readonly outcome: "precondition_changed"; readonly source: S }
>;

/** Arms carrying a gate result directly. */
type GateBearing<T> = Extract<Tx<T>, { readonly gate: unknown }>;

/** Transaction results that already hold a gate outcome. */
export type DirectReceiptSource<T> = GateBearing<T> | PublishedMarkerFailure<T>;

/** Everything that can only have happened before E was attempted. */
export type BeforeRecoveryTransaction<T> =
  | PreRecoveryFailure<T>
  | PreconditionChangedFrom<T, "stabilization">;

/** E exists, and the transaction itself established that no marker was published. */
export type AfterRecoveryNoMarkerTransaction<T> =
  | AfterRecoveryValidationFailure<T>
  | Extract<Tx<T>, { readonly outcome: "recovery_handle_mismatch" | "missing_evidence" }>
  | PreconditionChangedFrom<T, "final_fence">
  | NotPublishedMarkerFailure<T>;

export type ReceiptFinalizationSource<T> =
  | { readonly kind: "gate_result"; readonly transaction: DirectReceiptSource<T> }
  | {
      /** Publication proven by inspection; no gate outcome exists. */
      readonly kind: "inspected_publication";
      readonly transaction: PossiblyPublishedFailure<T>;
      readonly inspection: Extract<PublicationInspection, { readonly outcome: "published" }>;
    };

export type RecoveryCheckpointState =
  | { readonly status: "not_created" }
  | { readonly status: "created"; readonly checkpointId: string; readonly checkpointDir: string }
  /**
   * A typed `RollbackEmergencyCheckpointError`. No usable handle exists either
   * way: `create` may have left nothing, `rename` left valid bytes in a
   * `.tmp-checkpoint-*` directory that every loader skips. Debris, not a handle.
   */
  | { readonly status: "failed"; readonly stage: "create" | "rename" }
  /**
   * An untyped throw. Notably reachable when the exclusive lock fails to
   * release AFTER E was fully published, so E may exist and be unnamed here.
   *
   * This never taints the working tree: E creation only writes a checkpoint. The
   * consequence is an unreferenced `pre-rollback-*` checkpoint, not a partial
   * restore.
   */
  | { readonly status: "indeterminate" };

export type CreatedRecovery = Extract<RecoveryCheckpointState, { readonly status: "created" }>;

/**
 * Why the receipt was not persisted.
 *
 * Two shapes rather than one with a shared reason enum, so the vocabularies
 * cannot cross. A mapping failure has no `intendedReceipt` because mapping is
 * what would have produced it.
 */
export type ReceiptFinalizationFailure =
  | { readonly phase: "map_receipt"; readonly cause: unknown }
  | {
      readonly phase: "write_receipt";
      /**
       * Reached ONLY when the exclusive writer REJECTS. A suppressed post-link
       * cleanup failure resolves successfully and never arrives here, because
       * publication already completed.
       *
       *   not_written    the destination is absent
       *   conflicting    a different or schema-invalid receipt is present
       *   indeterminate  the destination could not be read
       */
      readonly reason: "not_written" | "conflicting" | "indeterminate";
      readonly intendedReceipt: SelectiveRollbackReceipt;
      readonly cause: unknown;
    };

export type SelectiveApplyOutcome<T> =
  /** Stopped before E was attempted. Nothing was created and nothing mutated. */
  | {
      readonly kind: "not_attempted";
      readonly stage: "before_recovery_checkpoint";
      readonly transaction: BeforeRecoveryTransaction<T>;
      readonly recovery: Extract<RecoveryCheckpointState, { readonly status: "not_created" }>;
    }
  /** E creation itself failed. No mutation was authorized. */
  | {
      readonly kind: "recovery_checkpoint_unavailable";
      readonly transaction: RecoveryAttemptFailure<T>;
      readonly recovery: Extract<
        RecoveryCheckpointState,
        { readonly status: "failed" | "indeterminate" }
      >;
    }
  /** E exists; the transaction itself established that no marker was published. */
  | {
      readonly kind: "not_attempted";
      readonly stage: "after_recovery_checkpoint";
      readonly source: "transaction";
      readonly transaction: AfterRecoveryNoMarkerTransaction<T>;
      readonly recovery: CreatedRecovery;
    }
  /**
   * E exists; the transaction could not tell, and INSPECTING the preallocated
   * invocation found no marker. Split from the arm above so unrelated
   * transaction and inspection evidence cannot be paired: "we looked and there
   * was nothing" is a different proof from "it never got that far".
   */
  | {
      readonly kind: "not_attempted";
      readonly stage: "after_recovery_checkpoint";
      readonly source: "inspection";
      readonly transaction: PossiblyPublishedFailure<T>;
      readonly recovery: CreatedRecovery;
      readonly inspection: Extract<PublicationInspection, { readonly outcome: "not_published" }>;
    }
  /**
   * A marker may exist and could not be shown to be this attempt's, so whether
   * mutation was authorized is unknown. Requires a created recovery checkpoint:
   * publication is only reachable after E exists.
   */
  | {
      readonly kind: "publication_indeterminate";
      readonly transaction: PossiblyPublishedFailure<T>;
      readonly recovery: CreatedRecovery;
      readonly inspection: Extract<PublicationInspection, { readonly outcome: "indeterminate" }>;
    }
  | {
      readonly kind: "finalized";
      readonly source: ReceiptFinalizationSource<T>;
      readonly recovery: CreatedRecovery;
      readonly receipt: SelectiveRollbackReceipt;
      readonly how: "written" | "already_identical";
    }
  | {
      readonly kind: "finalization_failed";
      readonly source: ReceiptFinalizationSource<T>;
      readonly recovery: CreatedRecovery;
      readonly failure: ReceiptFinalizationFailure;
    }
  /**
   * The observed recovery state and the transaction result cannot both be true,
   * or the transaction reported a value this mapping does not classify.
   * Reported rather than resolved: guessing either way would either invent a
   * recovery handle or deny one that exists.
   */
  | {
      readonly kind: "internal_mapping_failure";
      readonly transaction: Tx<T>;
      readonly recovery: RecoveryCheckpointState;
      readonly detail: string;
    };

/**
 * What the command must do next.
 *
 * Pure classification stops at every point that needs IO, mirroring the
 * sample-then-resolve split used elsewhere: this function decides, the command
 * performs, and a second pure function decides again.
 */
export type SelectiveApplyClassification<T> =
  | { readonly step: "settled"; readonly outcome: SelectiveApplyOutcome<T> }
  /** Inspect the PREALLOCATED invocation, then call `resolveAfterInspection`. */
  | {
      readonly step: "inspect_publication";
      readonly transaction: PossiblyPublishedFailure<T>;
      readonly recovery: CreatedRecovery;
    }
  /** Map and exclusively write the receipt, then build the terminal arm. */
  | {
      readonly step: "finalize_receipt";
      readonly source: ReceiptFinalizationSource<T>;
      readonly recovery: CreatedRecovery;
    };

// =============================================================================
// Exhaustive classification of the transaction's own vocabulary
// =============================================================================

/** Disjoint by construction: marker status is resolved here, not by the caller. */
type TransactionEpoch<T> =
  | { readonly epoch: "before_recovery"; readonly transaction: BeforeRecoveryTransaction<T> }
  | { readonly epoch: "recovery_attempt"; readonly transaction: RecoveryAttemptFailure<T> }
  | {
      readonly epoch: "after_recovery_no_marker";
      readonly transaction: AfterRecoveryNoMarkerTransaction<T>;
    }
  | { readonly epoch: "possibly_published"; readonly transaction: PossiblyPublishedFailure<T> }
  | { readonly epoch: "direct_receipt"; readonly transaction: DirectReceiptSource<T> }
  /** Fail-closed runtime companion to the two coverage assertions. */
  | { readonly epoch: "unclassified" };

const isPublishedMarkerFailure = <T>(f: MarkerBearingFailure<T>): f is PublishedMarkerFailure<T> =>
  f.marker.status === "published";

const isPossiblyPublishedFailure = <T>(
  f: MarkerBearingFailure<T>,
): f is PossiblyPublishedFailure<T> => f.marker.status === "possibly_published";

const isNotPublishedMarkerFailure = <T>(
  f: MarkerBearingFailure<T>,
): f is NotPublishedMarkerFailure<T> => f.marker.status === "not_published";

const isPreRecoveryFailure = <T>(f: FailureWithoutMarker<T>): f is PreRecoveryFailure<T> =>
  f.phase === "capture_expected_state" || f.phase === "stabilize_plan";

const isRecoveryAttemptFailure = <T>(f: FailureWithoutMarker<T>): f is RecoveryAttemptFailure<T> =>
  f.phase === "create_recovery_checkpoint";

const isAfterRecoveryValidationFailure = <T>(
  f: FailureWithoutMarker<T>,
): f is AfterRecoveryValidationFailure<T> => f.phase === "validate_recovery_handle";

function epochOfFailureWithoutMarker<T>(failure: FailureWithoutMarker<T>): TransactionEpoch<T> {
  if (isPreRecoveryFailure(failure)) return { epoch: "before_recovery", transaction: failure };
  if (isRecoveryAttemptFailure(failure)) return { epoch: "recovery_attempt", transaction: failure };
  if (isAfterRecoveryValidationFailure(failure)) {
    return { epoch: "after_recovery_no_marker", transaction: failure };
  }
  // `NoMarkerPhaseCoverage` makes this unreachable at compile time. It is still
  // handled rather than thrown, so a build that somehow admitted a new phase
  // fails closed instead of crashing.
  return { epoch: "unclassified" };
}

function epochOfMarkerBearing<T>(failure: MarkerBearingFailure<T>): TransactionEpoch<T> {
  if (isPublishedMarkerFailure(failure)) return { epoch: "direct_receipt", transaction: failure };
  if (isPossiblyPublishedFailure(failure)) {
    return { epoch: "possibly_published", transaction: failure };
  }
  if (isNotPublishedMarkerFailure(failure)) {
    return { epoch: "after_recovery_no_marker", transaction: failure };
  }
  // Unreachable at compile time per `MarkerStatusCoverage`; fails closed anyway.
  return { epoch: "unclassified" };
}

/** Exhaustive over the transaction's outcomes: a new one is a compile error. */
function epochOf<T>(transaction: Tx<T>): TransactionEpoch<T> {
  switch (transaction.outcome) {
    case "failed":
      return "marker" in transaction
        ? epochOfMarkerBearing(transaction)
        : epochOfFailureWithoutMarker(transaction);
    case "precondition_changed":
      // Stabilization runs before E; the final fence runs after it.
      return transaction.source === "stabilization"
        ? { epoch: "before_recovery", transaction }
        : { epoch: "after_recovery_no_marker", transaction };
    case "recovery_handle_mismatch":
    case "missing_evidence":
      return { epoch: "after_recovery_no_marker", transaction };
    case "verification_failed":
    case "post_marker_failed":
    case "observation_failed":
    case "observation_torn":
    case "settled":
      return { epoch: "direct_receipt", transaction };
    default: {
      // A new transaction outcome fails to compile at this binding. The runtime
      // path still fails closed rather than assuming an epoch.
      const _unhandled: never = transaction;
      return { epoch: "unclassified" };
    }
  }
}

function mismatch<T>(
  transaction: Tx<T>,
  recovery: RecoveryCheckpointState,
  detail: string,
): SelectiveApplyClassification<T> {
  return {
    step: "settled",
    outcome: { kind: "internal_mapping_failure", transaction, recovery, detail },
  };
}

/**
 * Route an observed recovery state and a transaction result to the next step.
 *
 * PURE, and never throws. The recovery state leads; the transaction is checked
 * against it.
 */
export function classifySelectiveApply<T>(args: {
  readonly transaction: Tx<T>;
  readonly recovery: RecoveryCheckpointState;
}): SelectiveApplyClassification<T> {
  const { transaction, recovery } = args;
  const classified = epochOf(transaction);

  if (classified.epoch === "unclassified") {
    return mismatch(
      transaction,
      recovery,
      "the transaction reported an outcome, phase, or marker status this mapping does not classify",
    );
  }

  if (recovery.status === "not_created") {
    return classified.epoch === "before_recovery"
      ? {
          step: "settled",
          outcome: {
            kind: "not_attempted",
            stage: "before_recovery_checkpoint",
            transaction: classified.transaction,
            recovery,
          },
        }
      : mismatch(
          transaction,
          recovery,
          "the transaction reached recovery-checkpoint creation or later, but no checkpoint was created",
        );
  }

  if (recovery.status === "failed" || recovery.status === "indeterminate") {
    // The ONLY compatible result is the failure the callback's own throw
    // produced. A capture, stabilization or validation failure reaching here
    // would mean the two disagree about where the transaction stopped.
    return classified.epoch === "recovery_attempt"
      ? {
          step: "settled",
          outcome: {
            kind: "recovery_checkpoint_unavailable",
            transaction: classified.transaction,
            recovery,
          },
        }
      : mismatch(
          transaction,
          recovery,
          "recovery-checkpoint creation did not succeed, but the transaction reports a different stopping point",
        );
  }

  switch (classified.epoch) {
    case "before_recovery":
      return mismatch(
        transaction,
        recovery,
        "a recovery checkpoint exists, but the transaction stopped before it could have been created",
      );
    case "recovery_attempt":
      return mismatch(
        transaction,
        recovery,
        "a recovery checkpoint exists, but the transaction reports that creating it failed",
      );
    case "after_recovery_no_marker":
      return {
        step: "settled",
        outcome: {
          kind: "not_attempted",
          stage: "after_recovery_checkpoint",
          source: "transaction",
          transaction: classified.transaction,
          recovery,
        },
      };
    case "direct_receipt":
      return {
        step: "finalize_receipt",
        source: { kind: "gate_result", transaction: classified.transaction },
        recovery,
      };
    case "possibly_published":
      return { step: "inspect_publication", transaction: classified.transaction, recovery };
  }
}

/**
 * Decide after inspecting the preallocated invocation.
 *
 * PURE. Only an inspection that could NOT identify the marker becomes
 * `publication_indeterminate`. A matching marker proves the mutation was
 * authorized and a receipt is owed, WITHOUT supplying a gate result; an absent
 * marker proves it never was, and that evidence stays on the outcome.
 *
 * `T` is NOT inferable here and must be supplied explicitly:
 *
 *     resolveAfterInspection<MyCommandResult>({ transaction, recovery, inspection })
 *
 * That is a consequence of the same fact this function exists for. A
 * possibly-published failure stopped before any command ran, so its arm carries
 * no command-result evidence, so nothing in these arguments mentions `T` in a
 * position TypeScript can infer from. `classifySelectiveApply` needs no such
 * annotation because `Tx<T>` does mention `T` on the gate-bearing arms.
 */
export function resolveAfterInspection<T>(args: {
  readonly transaction: PossiblyPublishedFailure<T>;
  readonly recovery: CreatedRecovery;
  readonly inspection: PublicationInspection;
}): SelectiveApplyClassification<T> {
  const { transaction, recovery, inspection } = args;

  switch (inspection.outcome) {
    case "published":
      return {
        step: "finalize_receipt",
        source: { kind: "inspected_publication", transaction, inspection },
        recovery,
      };
    case "not_published":
      return {
        step: "settled",
        outcome: {
          kind: "not_attempted",
          stage: "after_recovery_checkpoint",
          source: "inspection",
          transaction,
          recovery,
          inspection,
        },
      };
    case "indeterminate":
      return {
        step: "settled",
        outcome: { kind: "publication_indeterminate", transaction, recovery, inspection },
      };
  }
}
