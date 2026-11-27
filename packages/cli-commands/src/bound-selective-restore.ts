// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The selective-restore transaction root (M 0.8.0 step 10F).
//
// Composes verified evidence with selector intent and derives the plan from
// THAT evidence, so a transaction's identity cannot be assembled from
// independently matchable values.
//
// =============================================================================
// Why composition rather than packaging
// =============================================================================
//
// Every ingredient already existed; what did not exist was a single point where
// they are produced FROM one another. An orchestration accepting
//
//     plan, contributionSha256, sessionId, selectors
//
// as four arguments admits a plan derived from contribution X beside a digest
// and session belonging to Y. The gate would then bind a perfectly
// self-consistent marker for Y while executing X's physical plan.
//
// So this module accepts BINDINGS and untrusted artifacts, never pre-trusted
// parsed values, and derives everything downstream:
//
//     session record -> binding -> verified contribution
//                    -> session_id / checkpoint_id read FROM that contribution
//                    -> selector resolution over that contribution
//                    -> plan built from that contribution and that resolution
//
// =============================================================================
// Mode is decided before any artifact is required
// =============================================================================
//
// `full` means no selective selectors were supplied and the caller stays on the
// legacy full-rollback path. That path must remain reachable for a legacy
// session that has no contribution AT ALL, so `contributionBinding` is optional
// and the mode probe runs before anything is loaded. Requiring the binding in
// the signature would make the contribution-independent path unreachable at the
// type boundary, defeating the probe.
//
// `resolveSelection` is the authority on full-versus-selective rather than a
// duplicated local predicate, and it also already owns the refusal for
// selectors supplied without a contribution. Both are reused rather than
// restated. The second, authoritative resolution afterwards is deliberate and
// cheap: probe the mode, then verify artifacts, then resolve for real.
//
// =============================================================================
// Report provenance is owned here, and the report is untrusted on arrival
// =============================================================================
//
// `resolveSelection` is pure and never sees a digest, so it cannot decide
// whether a report describes this contribution. This module is the first place
// holding both, so it refuses BEFORE asking the report anything. A stale report
// must not produce even a negative answer:
//
//     wrong report -> --risk high    -> "empty"
//     wrong report -> --finding abc  -> FINDING_NOT_FOUND
//
// Both are conclusions drawn from untrusted evidence.
//
// `report` is typed `unknown` on purpose. A TypeScript annotation is not
// evidence that `ReportFileSchema.parse` ever ran, and the contribution side
// already refuses to trust a caller-supplied parsed value. The signature should
// not pretend otherwise.
//
// The digest lives on the ReportFile WRAPPER, not on the `SessionReport`
// payload the resolver consumes, so parsing here is also what makes the digest
// reachable at all:
//
//     ReportFileSchema.parse
//         |-> source_contribution_sha256 == verified contribution SHA
//         `-> report: SessionReport  ->  resolveSelection
//
// The wrapper's own refinement guarantees a present digest implies
// `kind === "session_bound"`, so no separate kind check belongs here.
//
// Provenance binds only when the selectors actually consult a report, which is
// `selectionRequiresReport`'s definition, shared with the resolver so the two
// cannot drift. For report-independent selectors the artifact is never parsed
// and `undefined` reaches the resolver, so even a garbage object supplied
// beside `--only` can neither influence nor block the transaction.
//
// A schema-INVALID report throws rather than becoming a refusal. A malformed
// artifact and a valid-but-unbound artifact are different facts, exactly as an
// unparseable contribution is not a selector refusal.
//
// =============================================================================
// One canonical authorization representation
// =============================================================================
//
// `resolveSelection` returns groups in contribution-entry order, deduplicated
// but unsorted; `planSelectiveRestore` canonicalizes through a `Set` and a
// `sort`. Those are two arrays denoting one authorization, so only the
// planner's survives:
//
//     bound.plan.selectedChangeGroupIds
//
// which is the form the marker binding, the gate's exact-array comparison, and
// the receipt schema all require. There is deliberately no
// `resolvedChangeGroupIds` field.

import { loadVerifiedSessionContribution, type SessionContributionBinding } from "@viberevert/core";
import { planSelectiveRestore, type SelectiveRestorePlan } from "@viberevert/git";
import {
  ReportFileSchema,
  type RollbackSelectionSource,
  type RollbackSelectors,
  type SessionContributionFile,
  type SessionReport,
} from "@viberevert/session-format";

import {
  resolveChangeGroupSelection,
  resolveSelection,
  type SelectionInvalidReason,
  type SelectionSelectors,
  selectionRequiresReport,
} from "./selection-resolver.js";

/**
 * What a verified contribution establishes about a selection, whatever that
 * selection resolved to.
 *
 * `sessionId` and `checkpointId` are DERIVED from the verified contribution and
 * are never parameters. Fields are limited to what downstream phases consume;
 * this is not a copy of every available contribution field.
 *
 * Split out so the EMPTY resolution carries exactly the same identities the
 * resolved one does. A dry run whose selectors matched nothing still owes a
 * receipt, and that receipt still has to name the session, the checkpoint and
 * the contribution its answer was computed against. Sharing one interface is
 * what keeps the two arms from drifting into different notions of identity.
 */
export interface VerifiedSelectionIdentity {
  /** Proven to be the digest of the exact parsed bytes. */
  readonly contributionSha256: string;
  readonly sessionId: string;
  readonly checkpointId: string;
  /**
   * WHY this selection exists, in the exact shape both persisted artifacts
   * record (M 0.9.0 step 3).
   *
   * Retained because resolution discards intent and both the attempt marker and
   * the receipt record it. Carried as the PERSISTED union rather than the
   * in-memory selectors so the conversion happens once, here, where the
   * contribution has just been verified. Converting at each writer instead would
   * put two copies of one mapping in two files, and the attempt and the receipt
   * must agree on this field exactly.
   */
  readonly source: RollbackSelectionSource;
}

/**
 * The transaction root: one verified contribution, the intent that selected
 * from it, and the plan derived from both.
 */
export interface BoundSelectiveRestore extends VerifiedSelectionIdentity {
  readonly contribution: SessionContributionFile;
  /** `plan.selectedChangeGroupIds` is the sole canonical authorization list. */
  readonly plan: SelectiveRestorePlan;
}

/**
 * The resolver's reasons plus the one it structurally cannot determine.
 *
 * `STALE_OR_MISSING_REPORT` is not added to `SelectionInvalidReason`, because
 * that module never receives a digest and a code it could never emit would
 * misstate its own contract.
 */
export type BoundSelectionInvalidReason =
  | SelectionInvalidReason
  | { readonly code: "STALE_OR_MISSING_REPORT"; readonly detail: string };

export type PrepareBoundSelectiveRestoreResult =
  | { readonly mode: "full" }
  /**
   * The selectors resolved to no change group.
   *
   * Carries `identity` because this is a RESULT, not a dead end: a dry run
   * records it as `eligibility: "empty_selection"`, and a receipt asserting
   * "these selectors matched nothing" is only meaningful if it also says what
   * they were matched against. There is no plan, because there is nothing to
   * plan.
   */
  | {
      readonly mode: "selective";
      readonly outcome: "empty";
      readonly identity: VerifiedSelectionIdentity;
    }
  | {
      readonly mode: "selective";
      readonly outcome: "invalid";
      readonly reason: BoundSelectionInvalidReason;
    }
  | {
      readonly mode: "selective";
      readonly outcome: "resolved";
      readonly bound: BoundSelectiveRestore;
    };

/**
 * What drove this selection, as the caller supplies it (M 0.9.0 step 3).
 *
 * Distinct from the persisted `RollbackSelectionSource`: the `scope_violation`
 * arm carries the change-group ids here because they are the INPUT to
 * resolution, and carries only its discriminant once persisted because the ids
 * then live in `resolved_change_group_ids` on the artifact itself. Recording
 * them twice would create a second copy that could disagree.
 */
export type BoundSelectionInput =
  | { readonly kind: "selectors"; readonly selectors: SelectionSelectors }
  | {
      readonly kind: "scope_violation";
      /**
       * Validated against the bound contribution before any mutation: every id
       * must exist, none may repeat, and the resolved set may neither narrow nor
       * widen. There is no CLI flag that reaches this arm.
       */
      readonly changeGroupIds: readonly string[];
    };

export interface PrepareBoundSelectiveRestoreOptions {
  readonly repoRoot: string;
  /**
   * Assembled from ONE persisted session record, never field by field.
   *
   * Optional because `full` mode must be reachable for a legacy session that
   * has no contribution at all.
   */
  readonly contributionBinding?: SessionContributionBinding;
  readonly selection: BoundSelectionInput;
  /** UNTRUSTED. Parsed here, and only when the selectors consult it. */
  readonly report?: unknown;
}

/**
 * Convert the in-memory selectors into the persisted selector object.
 *
 * Sets are sorted and deduped because repeating a flag unions its values, and an
 * empty family is OMITTED rather than written as `[]`: the schema rejects an
 * empty array precisely so an artifact cannot claim a selector it does not
 * carry.
 *
 * Lives here, beside the one place the identity is built, so exactly one mapping
 * from in-memory to persisted exists.
 */
function persistedSelectorsOf(selectors: SelectionSelectors): RollbackSelectors {
  const set = (values: readonly string[]): string[] => [...new Set(values)].sort();
  return {
    ...(selectors.only.length > 0 ? { only: set(selectors.only) } : {}),
    ...(selectors.except.length > 0 ? { except: set(selectors.except) } : {}),
    ...(selectors.finding.length > 0 ? { finding: set(selectors.finding) } : {}),
    ...(selectors.risk !== undefined ? { risk: selectors.risk } : {}),
  };
}

/** The persisted source for a given input. One mapping, one place. */
function persistedSourceOf(selection: BoundSelectionInput): RollbackSelectionSource {
  return selection.kind === "selectors"
    ? { kind: "selectors", selectors: persistedSelectorsOf(selection.selectors) }
    : { kind: "scope_violation" };
}

const staleReport = (detail: string): PrepareBoundSelectiveRestoreResult => ({
  mode: "selective",
  outcome: "invalid",
  reason: { code: "STALE_OR_MISSING_REPORT", detail },
});

export async function prepareBoundSelectiveRestore(
  opts: PrepareBoundSelectiveRestoreOptions,
): Promise<PrepareBoundSelectiveRestoreResult> {
  const { repoRoot, contributionBinding, selection } = opts;

  // Mode first, on the selectors alone: a legacy full rollback must not depend
  // on the health, or even the existence, of a contribution it never reads.
  //
  // A scope-violation selection skips the probe because it is selective by
  // construction. There is no "no violation" input that should silently become
  // a full rollback; an empty violation set is refused by the resolver instead.
  if (selection.kind === "selectors") {
    const probe = resolveSelection({ selectors: selection.selectors });
    if (probe.mode === "full") return { mode: "full" };

    if (contributionBinding === undefined) {
      // With no contribution supplied, the probe can only be
      // `invalid / CONTRIBUTION_REQUIRED`. Step 9 already owns that refusal, so
      // it is reused rather than restated as a new composer-level error.
      if (probe.outcome !== "invalid") {
        throw new Error(
          `selection resolution without a contribution returned ${probe.outcome}, but only an invalid outcome is reachable there`,
        );
      }
      return { mode: "selective", outcome: "invalid", reason: probe.reason };
    }
  } else if (contributionBinding === undefined) {
    // A violation is computed FROM a contribution, so arriving here without one
    // is a caller bug rather than a user-visible refusal. Reusing the resolver's
    // reason keeps one vocabulary for the condition.
    return {
      mode: "selective",
      outcome: "invalid",
      reason: { code: "CONTRIBUTION_REQUIRED" },
    };
  }
  if (contributionBinding === undefined) {
    throw new Error("unreachable: contributionBinding absence is handled by both arms above");
  }

  // Identity becomes a fact here: digest, schema, session, checkpoint, ended_at.
  const contribution = await loadVerifiedSessionContribution(repoRoot, contributionBinding);

  let consulted: SessionReport | undefined;
  if (selection.kind === "selectors" && selectionRequiresReport(selection.selectors)) {
    if (opts.report === undefined) {
      return staleReport("report-backed selectors require a report; none was supplied");
    }
    // Throws on a malformed artifact: that is not a selector refusal.
    const reportFile = ReportFileSchema.parse(opts.report);

    const digest = reportFile.source_contribution_sha256;
    if (digest === undefined) {
      // Two different situations produce an absent binding, and they have
      // different remedies. Saying only "re-run check" was impossible advice
      // for the second: a session with no evaluation snapshot never gains
      // report-backed selectors, because its authoritative session-start
      // configuration was never recorded, so no amount of re-running helps.
      return staleReport(
        "this report is not bound to the session contribution. " +
          "If it was generated by VibeRevert 0.8.0-beta.0 or 0.8.0-beta.1, upgrade and re-run " +
          "`viberevert check --since <session>`. If the session started before 0.8.0 and has no " +
          "evaluation snapshot, report-backed selectors are unavailable; use --only, --except, " +
          "or whole-session rollback",
      );
    }
    if (digest !== contributionBinding.sha256) {
      return staleReport(
        `the report was computed from contribution ${digest}, but this session's contribution is ${contributionBinding.sha256}`,
      );
    }
    consulted = reportFile.report;
  }

  const resolution =
    selection.kind === "selectors"
      ? resolveSelection({
          contribution,
          ...(consulted !== undefined ? { report: consulted } : {}),
          selectors: selection.selectors,
        })
      : resolveChangeGroupSelection({
          contribution,
          changeGroupIds: selection.changeGroupIds,
        });

  if (resolution.mode === "full") {
    // The probe already established selective mode from these same immutable
    // selectors, and `resolveSelection` is pure. A disagreement is an internal
    // contradiction, and silently falling back to legacy full rollback would be
    // an authorization widening. `resolveChangeGroupSelection` never returns
    // full at all.
    throw new Error("selection resolution changed from selective to full for the same selectors");
  }
  // Built from the verified contribution, exactly as the resolved arm's is, so
  // both arms name the same session, checkpoint and bytes.
  const identity: VerifiedSelectionIdentity = {
    contributionSha256: contributionBinding.sha256,
    sessionId: contribution.session_id,
    checkpointId: contribution.checkpoint_id,
    source: persistedSourceOf(selection),
  };

  if (resolution.outcome === "empty") return { mode: "selective", outcome: "empty", identity };
  if (resolution.outcome === "invalid") {
    return { mode: "selective", outcome: "invalid", reason: resolution.reason };
  }

  // Derived from the SAME contribution the resolution ran over.
  const plan = await planSelectiveRestore({
    repoRoot,
    contribution,
    selectedChangeGroupIds: resolution.changeGroupIds,
  });
  requireAuthorizationPreserved(resolution.changeGroupIds, plan.selectedChangeGroupIds);

  return { mode: "selective", outcome: "resolved", bound: { ...identity, contribution, plan } };
}

/**
 * The planner canonicalizes; it must not also change what was authorized.
 *
 * Compared as SETS. Both sides are duplicate-free at this point -- the resolver
 * pushes each group once on first appearance, the planner builds through a
 * `Set` -- so equal cardinality plus one-way membership proves set equality
 * without normalizing either representation.
 */
function requireAuthorizationPreserved(
  resolved: readonly string[],
  canonical: readonly string[],
): void {
  const inPlan = new Set(canonical);
  const missing = resolved.filter((id) => !inPlan.has(id));
  if (missing.length > 0 || canonical.length !== resolved.length) {
    throw new Error(
      `the planner changed the resolved authorization: resolution selected ${resolved.length} change group(s), the plan carries ${canonical.length}${
        missing.length > 0 ? `, and ${JSON.stringify([...missing].sort())} did not survive` : ""
      }`,
    );
  }
}
