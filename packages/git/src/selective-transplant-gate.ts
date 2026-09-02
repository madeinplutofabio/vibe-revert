// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The selective transplant gate (M 0.8.0 step 10F).
//
// Makes the locked pre-mutation ordering unskippable by owning every step:
//
//     prepareSelectiveTransplant          all validation, all derivation
//     createTransplantProgress            allocate + project, still pre-marker
//     finalProtectedDomainFence           last protected-domain + HEAD look
//     publishAttempt                      the marker, injected by the caller
//     executePreparedSelectiveTransplant  the first mutation
//
// Package-internal, like every other step-10 module. The `cli-commands`
// orchestration that owns the oracle's lifetime exports it along with its first
// real consumer.
//
// =============================================================================
// Why preparation lives INSIDE the gate
// =============================================================================
//
// Accepting an already-prepared value would make this legal:
//
//     fence -> prepare -> marker -> mutation
//
// which puts deterministic refusals back after the marker, recreating exactly
// the window the preparation/execution split removed. Nobody outside this
// function may choose where preparation happens relative to the fence.
//
// Oracle evidence validation stays outside, because it belongs to the phase-2
// composition that owns the oracle. Everything from preparation onwards is here.
//
// =============================================================================
// Why the marker writer is injected, and what the gate tells it
// =============================================================================
//
// `@viberevert/git` depends on `@viberevert/session-format` and nothing else;
// the marker writer lives in `@viberevert/core`. A gate that imported it would
// invert the package graph. So the caller supplies the publication as a
// callback, and this module still decides exactly WHEN it may run: after a
// stable fence, before the first mutation, exactly once.
//
// The gate hands the callback a complete BINDING rather than letting it decide
// what to publish. Otherwise the session, contribution, recovery checkpoint, and
// group set would live only in the caller's closure, and the gate would have
// nothing to compare the returned artifact against.
//
// =============================================================================
// Progress is constructed HERE, concretely (F3)
// =============================================================================
//
// The executor accepts a `TransplantProgressAccumulator`, and an arbitrary
// implementation of that interface could throw. So the safety property is not
// the type: it is that THIS function builds the concrete accumulator with
// `createTransplantProgress` and hands that exact object to the executor. There
// is deliberately no progress factory parameter and no caller-supplied sink,
// for the same reason the marker WRITER is injected but its BINDING is not.
// Post-marker safety must never depend on arbitrary caller code.
//
// Accumulator allocation and the immutable schedule-evidence projection happen
// immediately after preparation, BEFORE the fence and before the marker. Only
// final snapshot materialization remains post-execution; if that allocation or
// freeze fails, it propagates and is never classified as a mutation failure.
//
// The gate outlives the executor's failure, which is the entire point. A thrown
// primitive discards whatever the executor might have produced, so the facts
// must live in an object the gate already holds. Both post-marker outcomes
// therefore carry `progress.snapshot()`: a deeply frozen, self-describing view
// from which step 11 and step 12 derive candidate outcomes, without this package
// ever returning `PreparedSelectiveTransplant`.
//
// The result declares that snapshot as `RecordedTransplantProgress` rather than
// the structural type, and the distinction is load-bearing rather than
// decorative. Step 11 requires the branded type, so widening these fields would
// silently let a hand-built object reach verification as though it were an
// execution record. The brand marks provenance for ordinary typed callers; the
// gate's exclusive ownership of the accumulator, pinned by case 11 of this
// module's suite, is what establishes it at runtime.
//
// `precondition_changed` carries no progress, because nothing was published and
// nothing was mutated.
//
// =============================================================================
// What the gate validates about the returned evidence
// =============================================================================
//
// Two layers, doing different jobs.
//
// `RollbackAttemptSchema.parse` proves each field is individually VALID. That
// schema is a `strictObject` whose `state` is a single-member enum, whose
// digests and timestamp are typed atoms, and whose three refinements pin the
// `rb_`, `sess_`, and `cp_` ULID shapes. Re-checking `state` here would restate
// the schema's own authority, which is the duplication this package removes
// wherever it appears.
//
// The binding check then proves the valid artifact describes THIS TRANSACTION:
//
//     session_id                  == the session being restored
//     contribution_sha256         == the contribution the selection resolved against
//     pre_rollback_checkpoint_id  == the VALIDATED recovery handle
//     selection.resolved_change_group_ids == the plan's selected groups
//
// `pre_rollback_checkpoint_id` is the critical one. The emergency checkpoint was
// created and then independently proven to reproduce `S`, precisely so it can
// serve as the recovery handle. Without this check, a schema-valid marker naming
// some other checkpoint would authorize the mutation, and a later
// `mutation_failed` would hand an operator a recovery handle nothing ever
// validated. The session and contribution checks are less catastrophic but the
// same in kind: a valid marker for a different transaction must not authorize
// this one.
//
// The group set is compared as EXACT ARRAYS, because both sides are
// contractually canonical: the schema refines the marker's array as sorted and
// duplicate-free, and the planner builds its own through a `Set` and a `sort`. A
// fabricated plan with an unsorted or duplicated array cannot be normalized into
// agreement here -- publication's own schema validation or this exact comparison
// refuses it.
//
// `rollback_id`, `written_at`, and `state` get no analogous check: the first is
// generated by publication, the second belongs to core, and the third is wholly
// owned by the schema. So "complete binding" means the complete set of fields
// the gate can correlate with this transaction, not every field of the artifact.
//
// The binding check necessarily runs AFTER publication, and that is not a
// postponed preparation check: the evidence does not exist until the marker is
// written. A failure means no mutation occurs, while the marker conservatively
// says one may have started, which is the safe direction.
//
// It THROWS rather than returning the evidence, unlike an execution failure.
// That asymmetry is deliberate: here we have just proven the marker inconsistent
// with the transaction, and handing an untrustworthy artifact back as normal
// evidence would propagate something we refuse to vouch for. The marker itself
// remains on disk and discoverable by the rollback-history scan.
//
// `rollbackDir` is opaque passthrough. `@viberevert/git` did not create that
// path and has no filesystem semantics for it; core owns its validity, and a
// non-blank assertion here would invent a weak rule and add another
// deterministic post-marker refusal for nothing.
//
// =============================================================================
// Catch scope
// =============================================================================
//
//     preparation error   propagates. Nothing was published, nothing mutated.
//     accumulator build   propagates. Still pre-fence and pre-marker.
//     fence THROWS        propagates. We never observed the repository, which
//                         is not the same as observing that it moved.
//     fence unstable      returned as `precondition_changed`, before publication
//     publication error   propagates. No trustworthy publication result was
//                         returned, so mutation is unreachable on this
//                         invocation. The callback is injected, so the gate
//                         cannot claim no marker exists: one may have been
//                         written before the throw.
//     binding mismatch    propagates. The marker exists but is untrustworthy.
//     execution error     CAUGHT, and returned with the marker evidence AND the
//                         progress recorded up to the failure, because past this
//                         point a marker exists and the repository may be partly
//                         mutated.
//     snapshot failure    propagates. The `try` wraps the EXECUTOR ALONE, so a
//                         failure finalizing evidence after every primitive
//                         returned is never falsified into `mutation_failed`.
//                         Mutation completing and evidence finalization failing
//                         are different facts, exactly as a malformed marker is
//                         not a mutation failure.
//
// `cause` is `unknown`, not `Error`: JavaScript permits throwing any value, and
// narrowing it here would be a lie about what a primitive can raise.

import { type RollbackAttempt, RollbackAttemptSchema } from "@viberevert/session-format";

import { type FinalProtectedDomainFenceResult, finalProtectedDomainFence } from "./final-fence.js";
import type { ProtectedDomainSnapshot } from "./protected-domain.js";
import type { SelectiveRestorePlan } from "./restore-selective.js";
import {
  createTransplantProgress,
  type RecordedTransplantProgress,
} from "./transplant-obligations.js";
import {
  executePreparedSelectiveTransplant,
  prepareSelectiveTransplant,
} from "./transplant-schedule.js";

// =============================================================================
// Types
// =============================================================================

/**
 * The transaction the marker must describe.
 *
 * Constructed by the gate and handed to the publication callback, so the values
 * the marker records and the values the mutation is authorized against come from
 * one source rather than from the caller's closure.
 */
export interface AttemptPublicationBinding {
  readonly sessionId: string;
  readonly contributionSha256: string;
  /** The emergency checkpoint already proven to reproduce `S`. */
  readonly preRollbackCheckpointId: string;
  readonly resolvedChangeGroupIds: readonly string[];
}

/**
 * What a marker publication must return.
 *
 * Deliberately a SUBSET of core's `PublishedRollbackAttempt`, which also carries
 * `rollbackId`. Core's result is a call expression rather than a fresh object
 * literal, so no excess-property check applies and the production callback needs
 * no adapter.
 */
export interface PublishedAttemptEvidence {
  readonly attempt: RollbackAttempt;
  readonly rollbackDir: string;
}

export interface SelectiveTransplantGateOptions {
  readonly repoRoot: string;
  /** The live session-start oracle worktree. */
  readonly oracleWorktree: string;
  readonly plan: SelectiveRestorePlan;
  /** SESSION-START patterns, matching how the frozen snapshot was captured. */
  readonly rollbackExcludePatterns: readonly string[];
  /** `S`, frozen before the emergency checkpoint was created. */
  readonly frozenSnapshot: ProtectedDomainSnapshot;
  /** HEAD as observed when `S` was captured. Not the checkpoint's manifest HEAD. */
  readonly expectedHeadSha: string;
  readonly sessionId: string;
  readonly contributionSha256: string;
  /** The recovery handle validated against `S`, which the marker must name. */
  readonly preRollbackCheckpointId: string;
  /**
   * Publishes the immutable attempt marker. Invoked exactly once, only after a
   * stable fence, and only before the first mutation.
   */
  readonly publishAttempt: (
    binding: AttemptPublicationBinding,
  ) => Promise<PublishedAttemptEvidence>;
}

/** Reused from the fence so the two cannot drift apart. */
type FencePreconditionChanged = Extract<
  FinalProtectedDomainFenceResult,
  { outcome: "precondition_changed" }
>;

export type SelectiveTransplantGateResult =
  | FencePreconditionChanged
  | {
      /** Every scheduled primitive returned. NOT a claim that anything is restored. */
      readonly outcome: "mutation_completed";
      readonly attempt: RollbackAttempt;
      readonly rollbackDir: string;
      readonly progress: RecordedTransplantProgress;
    }
  | {
      /** A marker exists and the repository may be partly mutated. */
      readonly outcome: "mutation_failed";
      readonly attempt: RollbackAttempt;
      readonly rollbackDir: string;
      readonly cause: unknown;
      readonly progress: RecordedTransplantProgress;
    };

// =============================================================================
// The marker/transaction binding
// =============================================================================

/**
 * Require the published artifact to describe the transaction it authorizes.
 *
 * Complements rather than duplicates the schema: the schema proves each field is
 * valid in isolation, this proves the valid artifact is about THIS restore.
 */
function requireAttemptMatchesBinding(
  attempt: RollbackAttempt,
  binding: AttemptPublicationBinding,
): void {
  if (attempt.session_id !== binding.sessionId) {
    throw new Error(
      `the published attempt names session ${JSON.stringify(attempt.session_id)}, but this transaction is restoring ${JSON.stringify(binding.sessionId)}`,
    );
  }
  if (attempt.contribution_sha256 !== binding.contributionSha256) {
    throw new Error(
      `the published attempt names contribution ${JSON.stringify(attempt.contribution_sha256)}, but this transaction resolved its selection against ${JSON.stringify(binding.contributionSha256)}`,
    );
  }
  if (attempt.pre_rollback_checkpoint_id !== binding.preRollbackCheckpointId) {
    throw new Error(
      `the published attempt names recovery checkpoint ${JSON.stringify(attempt.pre_rollback_checkpoint_id)}, but the validated recovery handle is ${JSON.stringify(binding.preRollbackCheckpointId)}`,
    );
  }

  // Exact array equality: both sides are contractually sorted and unique, and
  // set comparison would erase a malformed marker rather than refuse it.
  const marker = attempt.selection.resolved_change_group_ids;
  const expected = binding.resolvedChangeGroupIds;
  const equal = marker.length === expected.length && marker.every((id, i) => id === expected[i]);
  if (!equal) {
    throw new Error(
      `the published attempt records ${JSON.stringify(marker)} but this transaction selected ${JSON.stringify(expected)}, so the marker misdescribes the mutation it authorizes`,
    );
  }
}

// =============================================================================
// The gate
// =============================================================================

/**
 * Run the whole pre-mutation sequence, then mutate.
 *
 * Returns `precondition_changed` without publishing anything when the fence
 * refuses. Otherwise publishes the marker and mutates, returning the marker
 * evidence and the recorded progress on either outcome so the caller can derive
 * candidate execution outcomes and record a receipt.
 */
export async function runSelectiveTransplantGate(
  opts: SelectiveTransplantGateOptions,
): Promise<SelectiveTransplantGateResult> {
  const { repoRoot, oracleWorktree, plan } = opts;

  // Everything deterministic, decided before the fence and before the marker.
  const prepared = await prepareSelectiveTransplant(oracleWorktree, plan);

  // Concrete, built here, from this transaction's own validated schedule. The
  // executor never receives an accumulator this function did not construct.
  const progress = createTransplantProgress(prepared.obligations, prepared.candidates);

  const fence = await finalProtectedDomainFence({
    repoRoot,
    plan,
    rollbackExcludePatterns: opts.rollbackExcludePatterns,
    frozenSnapshot: opts.frozenSnapshot,
    expectedHeadSha: opts.expectedHeadSha,
  });
  if (fence.outcome !== "stable") return fence;

  const binding: AttemptPublicationBinding = {
    sessionId: opts.sessionId,
    contributionSha256: opts.contributionSha256,
    preRollbackCheckpointId: opts.preRollbackCheckpointId,
    resolvedChangeGroupIds: plan.selectedChangeGroupIds,
  };

  const published = await opts.publishAttempt(binding);
  const attempt = RollbackAttemptSchema.parse(published.attempt);
  requireAttemptMatchesBinding(attempt, binding);

  // The `try` covers the EXECUTOR ALONE. Widening it to include the success
  // return would let a snapshot failure, after every primitive completed, be
  // reported as a mutation failure.
  try {
    await executePreparedSelectiveTransplant(repoRoot, oracleWorktree, prepared, progress);
  } catch (cause) {
    return {
      outcome: "mutation_failed",
      attempt,
      rollbackDir: published.rollbackDir,
      cause,
      // Taken AFTER the failure, so it holds the attempted-not-completed
      // obligation that names where execution stopped.
      progress: progress.snapshot(),
    };
  }

  return {
    outcome: "mutation_completed",
    attempt,
    rollbackDir: published.rollbackDir,
    progress: progress.snapshot(),
  };
}
