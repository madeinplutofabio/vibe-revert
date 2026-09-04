// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The rollback admission gate: the ONE command-level decision on whether a
// rollback operation may begin.
//
// It runs BEFORE the emergency checkpoint is created and BEFORE the attempt
// marker is published, which is the whole point. A gate consulted after either
// of those has already left artifacts behind for an operation it then refuses,
// and a refused operation must leave the repository exactly as it found it.
//
// It also runs UNDER the rollback lock, inheriting that requirement from
// `scanSelectiveRollbackHistory`. A verdict derived from an unlocked read could
// go stale between the decision and the first mutation, which would make the
// gate decorative.
//
// `decision: "admitted"` means every ADMISSION rule passed: no further gate
// decides whether this operation is allowed to begin. That is the contract this
// module exists to provide, and it is why the D75 policy is composed here
// rather than left to a later caller.
//
// It is NOT a prediction that the command will succeed. Loading the manifest,
// verifying the contribution's evidence chain, resolving the selection, and the
// transplant itself can each still fail or refuse on their own grounds.
// Admission answers "may this begin", not "will this work".
//
// NEVER THROWS. Every refusal and every fault is a value. The only throwing
// dependency is `collectRollbackRefusals`, whose artifact-consistency guard is
// caught and reported as the `legacy_analysis` phase.
//
// =============================================================================
// Three verdicts
// =============================================================================
//
//   admitted   every admission rule passed; the operation may begin
//   refused    a rule was evaluated and said no
//   failed     the gate could not reach a verdict
//
// `failed` is not a refusal and must never be reported as one. A refusal is
// knowledge: some rule ran and said no. A failure is the absence of knowledge,
// and the two call for different words to the user and different exit behavior.
// Collapsing them would let "I could not tell" print as "you may not", which
// teaches users to force past a condition nobody actually checked.
//
// =============================================================================
// Two dimensions, evaluated in order
// =============================================================================
//
// FIRST the selective-history dimension, which this module owns and decides
// absolutely. Its refusals are never bypassable, are never passed through force
// handling, and SHORT-CIRCUIT: when one holds, the legacy dimension is not
// evaluated at all.
//
// The short circuit is deliberate rather than an optimization.
// `collectRollbackRefusals` asserts artifact consistency and throws on a corrupt
// or foreign artifact. Evaluating it under a tainted history would let that
// fault preempt a recovery instruction the user needs first. A refusal that says
// "recover from this emergency checkpoint" must not be replaced by one that says
// "an artifact looks wrong", when the tainted tree is the more likely cause of
// both.
//
// THEN the legacy dimension, decided by its existing owners.
// `collectRollbackRefusals` walks the D76 order and `evaluateRollbackRefusals`
// applies the D75 force policy, returning the STRUCTURED decision. Neither is
// re-implemented here, and no refusal is inferred backwards from a thrown error
// class. That matters for exactly one scenario: a sixth refusal kind added to
// the legacy owner. Reverse inference would compile fine and silently treat the
// new kind as an anomaly; taking the decision as a value means this module needs
// no change at all. It is also why no refusal here carries a `bypassable`
// marker. Bypassability is D75's, and a second encoding could drift from the
// first without any test noticing.
//
// It is likewise why there is no `legacy_full_rollback_applied` reason. A
// selective apply after a full rollback IS the legacy `already_applied`
// refusal: it arrives through the evaluator, carries `writtenAt` and
// `preRollbackCheckpointId` this module never had, and D75 never bypasses it.
// Restating it here would mean two modules refusing one situation from two
// readers of one file convention, which is exactly what `rollback-history.ts`
// avoids by not reading the legacy receipt at all.
//
// =============================================================================
// The selective-history truth table
// =============================================================================
//
// Complete cross product of the two axes this dimension decides. "continue"
// means this dimension does not refuse, NOT that the operation is admitted:
// D75 is evaluated afterwards and may still refuse.
//
//   Operation  dry_run | selective_apply | full_apply
//
//   History    H0  the scan produced no report (unreadable | inconsistent)
//              H1  readable, no blockers, no selective apply ever succeeded
//              H2  readable, no blockers, at least one selective apply succeeded
//              H3  readable, at least one blocker
//
//   op               history  selective verdict
//   ---------------  -------  ---------------------------------------------
//   dry_run          H0       continue to D75, carrying the fault
//   dry_run          H1       continue to D75
//   dry_run          H2       continue to D75
//   dry_run          H3       continue to D75
//   selective_apply  H0       REFUSE  history_fault
//   selective_apply  H1       continue to D75
//   selective_apply  H2       continue to D75
//   selective_apply  H3       REFUSE  prior_apply_incomplete
//   full_apply       H0       REFUSE  history_fault
//   full_apply       H1       continue to D75
//   full_apply       H2       REFUSE  selective_apply_already_applied
//   full_apply       H3       REFUSE  prior_apply_incomplete
//
// Selective apply after selective apply is not refused by the selective-history
// dimension: the drift gate and ALREADY_AT_BEFORE already account for the prior
// work. D75 may still refuse it.
//
// `history_fault` carries the scan member whole rather than flattening it.
// "unreadable" and "inconsistent" are different findings: one says an artifact
// could not be read, the other says artifacts were read and contradict each
// other or their location. Collapsing them would tell a user to check
// permissions when the real problem is a forged receipt.
//
// `selective_apply_already_applied` refuses BEFORE D75 runs, and the ordering is
// load-bearing. After a successful selective restore the tree is legitimately
// dirty relative to the checkpoint, so a user who met `dirty_tree` first could
// `--force` past it straight into the whole-checkpoint engine, which has no way
// to reason about a tree already modified by surgical operations. The remedy is
// `--only '**'`, and the refusal has to say so before any bypassable reason
// offers a way around it.
//
// =============================================================================
// The dry-run guarantee
// =============================================================================
//
// A dry run is ALWAYS admitted. It mutates nothing, so neither an unreadable
// history nor a corrupt legacy artifact can make it unsafe, and refusing it
// would deny the user the one command that could show them what is wrong.
//
// The guarantee holds through both dimensions, and it is total only because
// every fault is carried as data instead of thrown:
//
//   - a faulted scan yields `scan: { state: "faulted" }`;
//   - a faulted legacy analysis yields `legacy: { state: "faulted" }`;
//   - `evaluateRollbackRefusals` in dry-run mode admits unconditionally.
//
// So a dry run reaches `admitted` from every cell of the table above and from a
// corrupt legacy layer as well, and the reporter can show what broke without
// the verdict pretending anything was clean. Note the consequence: a dry run
// whose legacy analysis faulted has no `RefusalCheckOutcome`, so it cannot build
// a receipt. The union makes the caller confront that rather than reach for a
// field that is not there.
//
// For an apply, both faults fail closed instead: an unusable history refuses,
// and an unusable legacy analysis returns `failed`.

import {
  type BlockingInvocation,
  primaryBlocker,
  type RollbackHistoryReport,
  type RollbackHistoryScan,
} from "./rollback-history.js";
import {
  type CollectRollbackRefusalsParams,
  collectRollbackRefusals,
  evaluateRollbackRefusals,
  type RollbackRefusal as LegacyRollbackRefusal,
  type RefusalCheckOutcome,
  type RollbackRefusalAnalysis,
} from "./rollback-orchestration.js";

/**
 * The scan outcomes that produced no report, carried whole.
 *
 * Keeping the member intact preserves `outcome`, `path` and `detail` together.
 * A reason code recording only "the history failed" would force the reporter to
 * invent a message for a fault it cannot see.
 */
export type RollbackHistoryFault = Extract<
  RollbackHistoryScan,
  { outcome: "unreadable" | "inconsistent" }
>;

export type RollbackOperation = "dry_run" | "selective_apply" | "full_apply";

/** This module's own refusals. Absolute: `--force` is never consulted for them. */
export type SelectiveHistoryRefusal =
  | { readonly kind: "history_fault"; readonly fault: RollbackHistoryFault }
  /**
   * A prior apply may have mutated the tree without finalizing. `blocker` is the
   * EARLIEST one, whose emergency checkpoint is the last state before any
   * damage; `allBlockers` carries the rest so a report never implies the
   * earliest is the only one.
   */
  | {
      readonly kind: "prior_apply_incomplete";
      readonly blocker: BlockingInvocation;
      readonly allBlockers: readonly BlockingInvocation[];
    }
  /**
   * Surgical recovery has begun, and control never returns to the
   * whole-checkpoint engine. Ids rather than a count, because the `--only '**'`
   * hint is more credible when the user can see what it refers to.
   */
  | {
      readonly kind: "selective_apply_already_applied";
      readonly appliedInvocations: readonly string[];
    };

/** One entry in the refusal set, tagged by which dimension produced it. */
export type RollbackAdmissionRefusal =
  | { readonly source: "selective_history"; readonly refusal: SelectiveHistoryRefusal }
  | { readonly source: "legacy"; readonly refusal: LegacyRollbackRefusal };

/**
 * The legacy analysis as an input.
 *
 * A union rather than plain params because the caller loads the legacy apply
 * receipt itself, and that load can fail before these params can be built. The
 * same rule then applies to a load fault and to a collector fault: a dry run
 * carries it, an apply fails closed. Making the caller express the failure here
 * keeps that rule in one place instead of at every call site.
 */
export type LegacyAnalysisInput =
  | { readonly state: "loaded"; readonly params: CollectRollbackRefusalsParams }
  | { readonly state: "faulted"; readonly cause: unknown };

export type RollbackAdmissionVerdict =
  | {
      /** Every admission rule passed. The operation may begin. */
      readonly decision: "admitted";
      readonly scan:
        | { readonly state: "readable"; readonly history: RollbackHistoryReport }
        /** Reachable for `dry_run` only. */
        | { readonly state: "faulted"; readonly fault: RollbackHistoryFault };
      readonly legacy:
        | {
            readonly state: "evaluated";
            /**
             * The D76 list as collected, for reporting only. Every member here
             * was either not enforced (dry-run mode) or bypassed under
             * `--force`; a member D75 would enforce cannot appear on this arm,
             * because the operation would have been refused instead.
             */
            readonly refusals: readonly LegacyRollbackRefusal[];
            /** So the receipt builders need no second policy walk. */
            readonly outcome: RefusalCheckOutcome;
          }
        /** Reachable for `dry_run` only. No outcome exists, so no receipt can be built. */
        | { readonly state: "faulted"; readonly cause: unknown };
    }
  | {
      readonly decision: "refused";
      /** The reason to act on. */
      readonly primary: RollbackAdmissionRefusal;
      /**
       * The refusal set, ordered.
       *
       * For a selective-history refusal this holds exactly that one member: the
       * legacy dimension was short-circuited and never evaluated, so listing it
       * as empty would be a claim, not an observation.
       *
       * For a legacy refusal this holds the whole D76 list in its own order,
       * with `primary` naming the member D75 actually enforced.
       */
      readonly refusals: readonly RollbackAdmissionRefusal[];
    }
  | {
      /**
       * No verdict could be reached. NOT a refusal: nothing said no, the gate
       * could not ask. Apply operations only.
       */
      readonly decision: "failed";
      readonly phase: "legacy_analysis";
      readonly cause: unknown;
    };

export interface RollbackAdmissionParams {
  readonly operation: RollbackOperation;
  readonly scan: RollbackHistoryScan;
  /**
   * The legacy analysis input. `mode` is DERIVED from `operation` rather than
   * accepted, so a caller cannot pair `full_apply` with `mode: "dry_run"`.
   */
  readonly legacy: LegacyAnalysisInput;
  readonly force: boolean;
}

/** Rollback ids of invocations that finalized as succeeded, in scan order. */
function succeededInvocations(report: RollbackHistoryReport): readonly string[] {
  return report.invocations
    .filter((i) => i.kind === "finalized" && i.outcome === "succeeded")
    .map((i) => i.rollbackId);
}

function refuseSelective(refusal: SelectiveHistoryRefusal): RollbackAdmissionVerdict {
  const entry: RollbackAdmissionRefusal = { source: "selective_history", refusal };
  return { decision: "refused", primary: entry, refusals: [entry] };
}

/**
 * Decide whether this rollback operation may begin.
 *
 * Never throws: every refusal and every fault is returned as a value.
 */
export function deriveRollbackAdmission(params: RollbackAdmissionParams): RollbackAdmissionVerdict {
  const { operation, scan, legacy, force } = params;
  const isDryRun = operation === "dry_run";

  // ---------------------------------------------------------------------
  // Dimension 1: selective history. Short-circuits; never sees `force`.
  // ---------------------------------------------------------------------
  let admittedScan: Extract<RollbackAdmissionVerdict, { decision: "admitted" }>["scan"];

  if (scan.outcome !== "readable") {
    // A faulted scan dominates. Everything below reads the report, and a report
    // that does not exist cannot support any claim, including the claim that
    // there are no blockers.
    if (!isDryRun) {
      return refuseSelective({ kind: "history_fault", fault: scan });
    }
    admittedScan = { state: "faulted", fault: scan };
  } else {
    const report = scan.report;
    admittedScan = { state: "readable", history: report };

    if (!isDryRun) {
      // A partly mutated tree outranks any question of mode, and outranks every
      // legacy rule computed against that same tree.
      const blocker = primaryBlocker(report);
      if (blocker !== null) {
        return refuseSelective({
          kind: "prior_apply_incomplete",
          blocker,
          allBlockers: report.blocking,
        });
      }

      if (operation === "full_apply") {
        const applied = succeededInvocations(report);
        if (applied.length > 0) {
          return refuseSelective({
            kind: "selective_apply_already_applied",
            appliedInvocations: applied,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Dimension 2, phase 1: legacy analysis. A fault here is not a refusal.
  // ---------------------------------------------------------------------
  const faultedLegacy = (cause: unknown): RollbackAdmissionVerdict =>
    isDryRun
      ? { decision: "admitted", scan: admittedScan, legacy: { state: "faulted", cause } }
      : { decision: "failed", phase: "legacy_analysis", cause };

  if (legacy.state === "faulted") {
    return faultedLegacy(legacy.cause);
  }

  let analysis: RollbackRefusalAnalysis;
  try {
    analysis = collectRollbackRefusals(legacy.params);
  } catch (cause) {
    return faultedLegacy(cause);
  }

  // ---------------------------------------------------------------------
  // Dimension 2, phase 2: D75 policy, decided by its owner.
  // ---------------------------------------------------------------------
  const decision = evaluateRollbackRefusals(analysis, isDryRun ? "dry_run" : "apply", force);

  if (decision.decision === "refused") {
    return {
      decision: "refused",
      primary: { source: "legacy", refusal: decision.refusal },
      refusals: analysis.refusals.map(
        (refusal): RollbackAdmissionRefusal => ({ source: "legacy", refusal }),
      ),
    };
  }

  return {
    decision: "admitted",
    scan: admittedScan,
    legacy: { state: "evaluated", refusals: analysis.refusals, outcome: decision.outcome },
  };
}
