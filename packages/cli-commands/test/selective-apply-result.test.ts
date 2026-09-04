// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/cli-commands/src/selective-apply-result.ts.
//
// The subject is ROUTING: given an observed recovery-checkpoint state and a
// transaction result, which step comes next and which outcome is reported.
//
// The matrix that matters is recovery state crossed with transaction epoch,
// because that product is where a wrong answer either invents a recovery handle
// or denies a real one. Every incompatible pairing must reach
// `internal_mapping_failure` rather than being resolved by assumption.
//
// The last group covers the FAIL-CLOSED runtime companions.
// `NoMarkerPhaseCoverage` and `MarkerStatusCoverage` protect compiled
// TypeScript as the transaction evolves; they say nothing about malformed
// values arriving at runtime from JavaScript callers or a version-skewed
// dependency. Those tests cover that.

import type { SelectiveRestoreTransactionResult } from "@viberevert/git";
import { ROLLBACK_ATTEMPT_SCHEMA_VERSION, RollbackAttemptSchema } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import type { PublicationInspection } from "../src/rollback-history.js";
import {
  type CreatedRecovery,
  classifySelectiveApply,
  type PossiblyPublishedFailure,
  type RecoveryCheckpointState,
  resolveAfterInspection,
  type SelectiveApplyClassification,
  type SelectiveApplyOutcome,
} from "../src/selective-apply-result.js";

type CmdResult = { readonly ok: boolean };
type Tx = SelectiveRestoreTransactionResult<CmdResult>;
type Outcome = SelectiveApplyOutcome<CmdResult>;
type Classification = SelectiveApplyClassification<CmdResult>;

type NotAttempted = Extract<Outcome, { readonly kind: "not_attempted" }>;
type AfterEOutcome = Extract<NotAttempted, { readonly stage: "after_recovery_checkpoint" }>;

/**
 * A transaction fixture. THE ONLY CAST IN THIS FILE.
 *
 * The classifier reads ONLY discriminants: `outcome`, `phase`, `source`, and
 * `marker.status`. The real arms also carry `gate`, `verification` and
 * `commandPhase`, whose types the git barrel does not export and which a test
 * must not reach for through an internal module path. So a faithful literal
 * cannot be written here, and each fixture supplies the discriminants the
 * classifier actually reads.
 *
 * The cast lives in THIS ONE PLACE, so the unsoundness is bounded and visible.
 * It is also what lets the last group construct values the type system forbids,
 * which is exactly what the fail-closed paths must be tested with.
 *
 * These tests therefore prove routing. They do NOT prove that a receipt can be
 * mapped from a real transaction value, which is a separate test against real
 * transaction results.
 */
function tx(shape: Record<string, unknown>): Tx {
  return shape as unknown as Tx;
}

// Identities, shared so every fixture describes ONE coherent invocation.

const SESSION_ID = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ROLLBACK_ID = "rb_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const ROLLBACK_DIR = `.viberevert/sessions/${SESSION_ID}/rollbacks/${ROLLBACK_ID}`;

// Transaction fixtures, one per epoch.

const CAPTURE_FAILED = tx({ outcome: "failed", phase: "capture_expected_state", cause: "boom" });
const STABILIZE_FAILED = tx({ outcome: "failed", phase: "stabilize_plan", cause: "boom" });
const STABILIZATION_CHANGED = tx({
  outcome: "precondition_changed",
  source: "stabilization",
  differences: [],
});

const CREATE_E_FAILED = tx({ outcome: "failed", phase: "create_recovery_checkpoint", cause: "b" });

const VALIDATE_HANDLE_FAILED = tx({
  outcome: "failed",
  phase: "validate_recovery_handle",
  cause: "boom",
});
const HANDLE_MISMATCH = tx({ outcome: "recovery_handle_mismatch", mismatch: {} });
const MISSING_EVIDENCE = tx({ outcome: "missing_evidence", evidence: {}, cleanupWarnings: [] });
const FINAL_FENCE_CHANGED = tx({
  outcome: "precondition_changed",
  source: "final_fence",
  fence: {},
  cleanupWarnings: [],
});

const markerFailure = (marker: Record<string, unknown>): Tx =>
  tx({
    outcome: "failed",
    phase: "oracle_callback",
    marker,
    cause: "boom",
    cleanupWarnings: [],
  });

const MARKER_NOT_PUBLISHED = markerFailure({ status: "not_published" });
const MARKER_POSSIBLY_PUBLISHED = markerFailure({ status: "possibly_published" });
const MARKER_PUBLISHED = markerFailure({ status: "published", gate: {} });

const SETTLED = tx({
  outcome: "settled",
  gate: {},
  verification: {},
  commandPhase: {},
  cleanupWarnings: [],
});

// Values the TYPE system forbids, reachable only through `tx`.
const UNKNOWN_PHASE = tx({ outcome: "failed", phase: "phase_from_the_future", cause: "boom" });
const UNKNOWN_MARKER_STATUS = markerFailure({ status: "status_from_the_future" });
const UNKNOWN_OUTCOME = tx({ outcome: "outcome_from_the_future" });

// Recovery states.

const NOT_CREATED: RecoveryCheckpointState = { status: "not_created" };
const CREATED: CreatedRecovery = {
  status: "created",
  checkpointId: "cp_01ARZ3NDEKTSV4RRFFQ69G5FB1",
  checkpointDir: ".viberevert/checkpoints/cp_01ARZ3NDEKTSV4RRFFQ69G5FB1",
};
const E_FAILED_CREATE: RecoveryCheckpointState = { status: "failed", stage: "create" };
const E_FAILED_RENAME: RecoveryCheckpointState = { status: "failed", stage: "rename" };
const E_INDETERMINATE: RecoveryCheckpointState = { status: "indeterminate" };

// Inspection fixtures. The published arm carries a REAL attempt marker, parsed
// through its own schema, so no cast is needed to produce one. Its identities
// match `ROLLBACK_DIR` and the recovery checkpoint, so the inspection is
// coherent evidence rather than merely schema-valid.

const ATTEMPT = RollbackAttemptSchema.parse({
  schema_version: ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  rollback_id: ROLLBACK_ID,
  session_id: SESSION_ID,
  contribution_sha256: "a".repeat(64),
  pre_rollback_checkpoint_id: CREATED.checkpointId,
  selection: {
    selectors: { only: ["src/**"] },
    resolved_change_group_ids: [`cg_${"0".repeat(63)}1`],
  },
  state: "mutation_may_have_started",
  written_at: "2026-01-01T00:00:00Z",
});

const INSPECTED_PUBLISHED: Extract<PublicationInspection, { outcome: "published" }> = {
  outcome: "published",
  rollbackDir: ROLLBACK_DIR,
  attempt: ATTEMPT,
};
const INSPECTED_NOT_PUBLISHED: Extract<PublicationInspection, { outcome: "not_published" }> = {
  outcome: "not_published",
  rollbackDir: ROLLBACK_DIR,
};
const INSPECTED_INDETERMINATE: Extract<PublicationInspection, { outcome: "indeterminate" }> = {
  outcome: "indeterminate",
  rollbackDir: ROLLBACK_DIR,
  path: `${ROLLBACK_DIR}/attempt.json`,
  detail: "unreadable",
};

// Narrowing helpers. Each delegates to a user-defined type guard, so no
// assertion appears in this file outside `tx`.

const outcomeHasKind = <K extends Outcome["kind"]>(
  outcome: Outcome,
  kind: K,
): outcome is Extract<Outcome, { readonly kind: K }> => outcome.kind === kind;

const classificationHasStep = <S extends Classification["step"]>(
  classification: Classification,
  step: S,
): classification is Extract<Classification, { readonly step: S }> => classification.step === step;

const afterEHasSource = <S extends AfterEOutcome["source"]>(
  outcome: AfterEOutcome,
  source: S,
): outcome is Extract<AfterEOutcome, { readonly source: S }> => outcome.source === source;

function expectStep<S extends Classification["step"]>(
  classification: Classification,
  step: S,
): Extract<Classification, { readonly step: S }> {
  if (!classificationHasStep(classification, step)) {
    throw new Error(`expected step ${step}, got ${classification.step}`);
  }
  return classification;
}

function expectOutcomeKind<K extends Outcome["kind"]>(
  outcome: Outcome,
  kind: K,
): Extract<Outcome, { readonly kind: K }> {
  if (!outcomeHasKind(outcome, kind)) {
    throw new Error(`expected outcome ${kind}, got ${outcome.kind}`);
  }
  return outcome;
}

/**
 * `not_attempted` after E, narrowed to ONE evidence source.
 *
 * Generic in the source so the returned arm carries only that source's fields:
 * the inspection-backed arm has an `inspection`, the transaction-backed arm
 * does not, and a caller must not be able to reach for one on the other.
 */
function expectNotAttemptedAfterE<S extends AfterEOutcome["source"]>(
  outcome: Outcome,
  source: S,
): Extract<AfterEOutcome, { readonly source: S }> {
  const notAttempted = expectOutcomeKind(outcome, "not_attempted");
  if (notAttempted.stage !== "after_recovery_checkpoint") {
    throw new Error(`expected the after-E stage, got ${notAttempted.stage}`);
  }
  if (!afterEHasSource(notAttempted, source)) {
    throw new Error(`expected source ${source}, got ${notAttempted.source}`);
  }
  return notAttempted;
}

function classify(transaction: Tx, recovery: RecoveryCheckpointState): Classification {
  return classifySelectiveApply({ transaction, recovery });
}

function settledOutcome(transaction: Tx, recovery: RecoveryCheckpointState): Outcome {
  return expectStep(classify(transaction, recovery), "settled").outcome;
}

/** The typed possibly-published failure, obtained rather than asserted. */
function possiblyPublishedFailure(): PossiblyPublishedFailure<CmdResult> {
  return expectStep(classify(MARKER_POSSIBLY_PUBLISHED, CREATED), "inspect_publication")
    .transaction;
}

describe("classifySelectiveApply: no recovery checkpoint was created", () => {
  it.each([
    ["capture", CAPTURE_FAILED],
    ["stabilize", STABILIZE_FAILED],
    ["stabilization precondition", STABILIZATION_CHANGED],
  ])("%s: not_attempted before the recovery checkpoint", (_label, transaction) => {
    const outcome = expectOutcomeKind(settledOutcome(transaction, NOT_CREATED), "not_attempted");
    expect(outcome.stage).toBe("before_recovery_checkpoint");
  });

  it.each([
    ["the E attempt", CREATE_E_FAILED],
    ["handle validation", VALIDATE_HANDLE_FAILED],
    ["a marker-bearing failure", MARKER_POSSIBLY_PUBLISHED],
    ["a gate-bearing result", SETTLED],
  ])("%s with no checkpoint is an internal mapping failure", (_label, transaction) => {
    // Reaching E creation or later without a checkpoint means the observed
    // state and the transaction disagree. Neither may be believed over the
    // other.
    expectOutcomeKind(settledOutcome(transaction, NOT_CREATED), "internal_mapping_failure");
  });
});

describe("classifySelectiveApply: recovery-checkpoint creation did not succeed", () => {
  it.each([
    ["create stage", E_FAILED_CREATE],
    ["rename stage", E_FAILED_RENAME],
    ["indeterminate", E_INDETERMINATE],
  ])("%s with the matching transaction reports it unavailable", (_label, recovery) => {
    const outcome = expectOutcomeKind(
      settledOutcome(CREATE_E_FAILED, recovery),
      "recovery_checkpoint_unavailable",
    );
    expect(outcome.recovery).toBe(recovery);
  });

  it.each([
    ["a capture failure", CAPTURE_FAILED],
    ["a validation failure", VALIDATE_HANDLE_FAILED],
    ["a gate-bearing result", SETTLED],
  ])("%s is NOT accepted as a failed E attempt", (_label, transaction) => {
    // A condition of "any marker-less failure" would have reported an
    // unrelated stopping point as an E-creation failure.
    expectOutcomeKind(settledOutcome(transaction, E_FAILED_CREATE), "internal_mapping_failure");
  });
});

describe("classifySelectiveApply: a recovery checkpoint exists", () => {
  it.each([
    ["a capture failure", CAPTURE_FAILED],
    ["a stabilization precondition change", STABILIZATION_CHANGED],
    ["an E-creation failure", CREATE_E_FAILED],
  ])("%s cannot coexist with a created checkpoint", (_label, transaction) => {
    expectOutcomeKind(settledOutcome(transaction, CREATED), "internal_mapping_failure");
  });

  it.each([
    ["handle validation", VALIDATE_HANDLE_FAILED],
    ["handle mismatch", HANDLE_MISMATCH],
    ["missing evidence", MISSING_EVIDENCE],
    ["the final fence", FINAL_FENCE_CHANGED],
    ["a not_published marker", MARKER_NOT_PUBLISHED],
  ])("%s: not_attempted after E, decided by the transaction", (_label, transaction) => {
    expectNotAttemptedAfterE(settledOutcome(transaction, CREATED), "transaction");
  });

  it.each([
    ["a gate-bearing result", SETTLED],
    ["a published marker", MARKER_PUBLISHED],
  ])("%s finalizes from a gate result", (_label, transaction) => {
    const step = expectStep(classify(transaction, CREATED), "finalize_receipt");
    expect(step.source.kind).toBe("gate_result");
  });

  it("a possibly_published marker asks for inspection rather than guessing", () => {
    expectStep(classify(MARKER_POSSIBLY_PUBLISHED, CREATED), "inspect_publication");
  });
});

describe("resolveAfterInspection", () => {
  it("a matching marker finalizes from the INSPECTED source, not a gate result", () => {
    const step = expectStep(
      resolveAfterInspection<CmdResult>({
        transaction: possiblyPublishedFailure(),
        recovery: CREATED,
        inspection: INSPECTED_PUBLISHED,
      }),
      "finalize_receipt",
    );
    // Load-bearing: inspecting a marker proves publication but supplies no gate
    // outcome, so the receipt mapper must be told which source this is.
    expect(step.source.kind).toBe("inspected_publication");
    if (step.source.kind !== "inspected_publication") throw new Error("unreachable");
    expect(step.source.inspection).toBe(INSPECTED_PUBLISHED);
  });

  it("an absent marker keeps the inspection evidence on the outcome", () => {
    const classification = resolveAfterInspection<CmdResult>({
      transaction: possiblyPublishedFailure(),
      recovery: CREATED,
      inspection: INSPECTED_NOT_PUBLISHED,
    });
    const outcome = expectNotAttemptedAfterE(
      expectStep(classification, "settled").outcome,
      "inspection",
    );
    expect(outcome.inspection).toBe(INSPECTED_NOT_PUBLISHED);
  });

  it("only an unidentifiable marker becomes publication_indeterminate", () => {
    const classification = resolveAfterInspection<CmdResult>({
      transaction: possiblyPublishedFailure(),
      recovery: CREATED,
      inspection: INSPECTED_INDETERMINATE,
    });
    const outcome = expectOutcomeKind(
      expectStep(classification, "settled").outcome,
      "publication_indeterminate",
    );
    expect(outcome.inspection).toBe(INSPECTED_INDETERMINATE);
    expect(outcome.recovery).toBe(CREATED);
  });
});

describe("classifySelectiveApply: fail-closed on values the types forbid", () => {
  // The coverage assertions in the source protect compiled TypeScript as the
  // transaction evolves. They cannot protect against a malformed value arriving
  // at runtime, which is what these three cover.
  it.each([
    ["an unknown no-marker phase", UNKNOWN_PHASE],
    ["an unknown marker status", UNKNOWN_MARKER_STATUS],
    ["an unknown transaction outcome", UNKNOWN_OUTCOME],
  ])("%s becomes an internal mapping failure", (_label, transaction) => {
    expectOutcomeKind(settledOutcome(transaction, CREATED), "internal_mapping_failure");
  });

  it("an unknown value fails closed regardless of the recovery state", () => {
    for (const recovery of [NOT_CREATED, E_FAILED_CREATE, E_INDETERMINATE, CREATED]) {
      expectOutcomeKind(settledOutcome(UNKNOWN_OUTCOME, recovery), "internal_mapping_failure");
    }
  });
});
