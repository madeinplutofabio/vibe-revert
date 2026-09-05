// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Session-start oracle evidence validation (M 0.8.0 step 10B, §12).
//
// Answers one question about the SESSION-START checkpoint:
//
//     can it actually reconstruct the BEFORE state every selected candidate
//     asserts?
//
// The contribution DESCRIBES what BEFORE was. The oracle SUPPLIES it. Those are
// different claims, and §2 keeps them apart deliberately: the oracle is
// authoritative as a restoration source, never as an unverified source of
// historical truth. This module is where the two are required to agree, before
// anything is transplanted from one to the other.
//
// =============================================================================
// This module does NOT own an oracle (F1)
// =============================================================================
//
// It takes an ALREADY MATERIALIZED oracle worktree. A self-opening entry point
// used to live here, and it was the last place in step 10 where evidence could
// be proven ABOUT one materialization while the mutation READ FROM another:
//
//     validation   -> oracle A -> "the checkpoint reproduces BEFORE"
//     transplant   -> oracle B -> writes bytes out of B
//
// Nothing related A to B. They are built from the same checkpoint, so they
// normally agree, and "normally" is not what a restoration guarantee means.
//
// So the transaction owner materializes ONE oracle and threads its path through
// every phase that consults it:
//
//     withCheckpointOracle(...)
//         findMissingEvidence(worktreePath, plan)
//         runSelectiveTransplantGate({ oracleWorktree: worktreePath, ... })
//         step 11 verification, against that same worktreePath
//
// Consequently this file has no temp-directory prefix and the verdict carries no
// `cleanupWarnings`. Oracle lifecycle, and every warning it produces, belongs
// entirely to whoever owns the oracle.
//
// The eligible-plan guard stays HERE, because eligibility is this function's
// semantic precondition rather than an orchestration convenience. Hoisting it
// upward would let some later caller hand this module a non-eligible plan while
// the evidence layer quietly stopped defending its own contract.
//
// =============================================================================
// Every classification, not just the write footprint
// =============================================================================
//
// `already_at_before` candidates are checked too. The question is not "what will
// the materializer write?" but "can the checkpoint reconstruct the asserted
// BEFORE state of every selected physical candidate?". Exempting a path merely
// because the current checkout happens not to need a write would make evidence
// validity depend on the live tree, which is precisely the coupling Step 10
// exists to remove. Only mutation SCHEDULING narrows to `restore_required`;
// protected `S`, stabilization invariant A, and this check all take the whole
// selected footprint.
//
// =============================================================================
// First mismatch, deterministically chosen
// =============================================================================
//
// Once one selected candidate cannot be reconstructed as its asserted BEFORE,
// the checkpoint has already failed as sufficient restoration evidence.
// Inspecting the rest cannot make the transaction eligible, so the refusal stays
// singular: one path, one detail.
//
// The candidate order is a LOCAL SORTED COPY by path, then change group. A plan
// produced by `planSelectiveRestore` already arrives path-sorted, but a
// hand-built or internal plan need not, and "which path is the culprit" must not
// depend on whatever ordering happened to reach this function. The approved plan
// itself is never mutated.
//
// =============================================================================
// A read failure is not a mismatch
// =============================================================================
//
// There is no `catch`. A corrupt checkpoint or an observation error throws. "We
// could not read the evidence" and "the evidence contradicts the plan" are
// different failures demanding different recovery advice, and collapsing them
// would tell the user their contribution is unrestorable when the truth is that
// we never managed to look.
//
// =============================================================================
// What this module deliberately never touches
// =============================================================================
//
// No topology watches. No protected-domain capture or comparison. No
// recovery-handle validation. No object store: `IndexState.oid` and
// `content_ref` are COMPARISON EVIDENCE here, never fetch keys. The entire
// evidence chain is
//
//     the caller's oracle worktree -> one IndexSnapshot -> observePathState
//         -> pathStateEqual
//
// with no content-ref dereference anywhere in it.

import type { PathState } from "@viberevert/session-format";

import {
  type IndexSnapshot,
  observePathState,
  pathStateEqual,
  readIndexSnapshot,
} from "./path-state.js";
import type { SelectiveRestoreClassification, SelectiveRestorePlan } from "./restore-selective.js";

// =============================================================================
// Two walks, one verdict
// =============================================================================
//
// `findMissingEvidence` is FAIL-FAST and serves the transaction, which is about
// to refuse anyway: the first unreconstructable path is enough, and walking the
// rest would be work spent on a decision already made.
//
// `collectMissingEvidence` is EXHAUSTIVE and serves the read-only preview,
// whose job is the opposite. A preview that stopped at the first gap would
// label every later path from a check that never ran, which is the false
// promise the preview exists to prevent.
//
// They share `evidenceGap`, so the two can differ in how far they walk and
// never in what counts as missing evidence or how it is described.

/** Evidence semantics only. Oracle lifecycle is the caller's concern. */
export type OracleEvidenceVerdict =
  | { readonly outcome: "sufficient" }
  | {
      readonly outcome: "missing_evidence";
      /** The machine-readable fact. */
      readonly path: string;
      /** A compact hint for rendering; `path` is what a caller keys on. */
      readonly detail: string;
    };

// =============================================================================
// Rendering
// =============================================================================
//
// Richer than stabilization's `describe`, and deliberately so: there, the
// machine-readable evidence is a whole `changedPaths` array and the detail is
// incidental. Here `detail` is the ONLY diagnostic beside the path, so a
// kind-pair alone would render "expected regular/entry, oracle has
// regular/entry" for the most common failure of all -- same shape, different
// content.

const shortRef = (ref: string): string => ref.slice(0, 8);

function describeWorktree(state: PathState["worktree"]): string {
  switch (state.kind) {
    case "absent":
      return "absent";
    case "directory":
      return "directory";
    case "regular":
      return `regular(${shortRef(state.content_ref)}${state.executable ? ", executable" : ""})`;
    case "symlink":
      return `symlink(${shortRef(state.target_ref)})`;
    default:
      return `unsupported(${state.fs_kind})`;
  }
}

function describeIndex(state: PathState["index"]): string {
  switch (state.kind) {
    case "absent":
      return "absent";
    case "entry":
      return `entry(${state.mode} ${shortRef(state.oid)})`;
    default:
      return "unmerged";
  }
}

const describe = (state: PathState): string =>
  `worktree ${describeWorktree(state.worktree)}, index ${describeIndex(state.index)}`;

// =============================================================================
// Validation
// =============================================================================

/** Deterministic candidate order, over a copy. The plan is immutable input. */
function orderedCandidates(plan: SelectiveRestorePlan): readonly SelectiveRestoreClassification[] {
  return [...plan.classifications].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.changeGroupId === b.changeGroupId) return 0;
    return a.changeGroupId < b.changeGroupId ? -1 : 1;
  });
}

/**
 * The gap between what the contribution asserts and what the checkpoint
 * reconstructs, or `null` when there is none.
 *
 * ONE authority for both the verdict and its wording, so the fail-fast and
 * exhaustive walks cannot drift on what counts as missing evidence.
 */
function evidenceGap(candidate: SelectiveRestoreClassification, state: PathState): string | null {
  return pathStateEqual(state, candidate.expectedBefore)
    ? null
    : `the contribution asserts ${describe(candidate.expectedBefore)}, but the session-start checkpoint reconstructs ${describe(state)}`;
}

/**
 * Require an already-materialized session-start oracle to reproduce every
 * selected candidate's asserted BEFORE state.
 *
 * `oracleWorktree` must be the SAME materialization the transplant will later
 * read from, which is what makes this evidence about the transaction rather
 * than about a sibling checkout built from the same checkpoint.
 *
 * ONE `IndexSnapshot` serves every observation, so the index axis cannot
 * disagree with itself across the walk. Observation is sequential. Unlike the
 * live checkout, this is VibeRevert-owned scratch state materialized for the
 * transaction, so Step 10 adds no separate live-checkout fence around this read.
 */
export async function findMissingEvidence(
  oracleWorktree: string,
  plan: SelectiveRestorePlan,
): Promise<OracleEvidenceVerdict> {
  if (plan.outcome !== "eligible") {
    throw new Error(
      `oracle evidence validation requires an eligible plan, received ${JSON.stringify(plan.outcome)}`,
    );
  }

  const index: IndexSnapshot = await readIndexSnapshot(oracleWorktree);
  for (const candidate of orderedCandidates(plan)) {
    const { state } = await observePathState(oracleWorktree, candidate.path, index);
    const gap = evidenceGap(candidate, state);
    if (gap === null) continue;
    return { outcome: "missing_evidence", path: candidate.path, detail: gap };
  }
  return { outcome: "sufficient" };
}

/** One selected path whose asserted BEFORE state the checkpoint cannot rebuild. */
export interface MissingEvidencePath {
  readonly path: string;
  /** Carried so a caller joins on the (path, group) PAIR: paths can repeat. */
  readonly changeGroupId: string;
  readonly detail: string;
}

/**
 * Every selected classification the checkpoint cannot reconstruct.
 *
 * Accepts ANY plan, including a mixed or ineligible one, and that is the point.
 * A planning conflict on one path says nothing about whether another path's
 * evidence exists, so refusing to look would leave the preview asserting
 * `restored` for paths it never checked.
 *
 * Checks EVERY classification, `already_at_before` included, for the reason
 * given at the top of this file: exempting a path because the current checkout
 * happens not to need a write would make evidence validity depend on the live
 * tree. It also keeps preview and apply aligned, since the transaction's own
 * check makes no such exemption.
 *
 * Ordering is `orderedCandidates`, so the result is deterministic and its first
 * entry is the one the fail-fast walk would have reported.
 */
export async function collectMissingEvidence(
  oracleWorktree: string,
  plan: SelectiveRestorePlan,
): Promise<readonly MissingEvidencePath[]> {
  const index: IndexSnapshot = await readIndexSnapshot(oracleWorktree);
  const missing: MissingEvidencePath[] = [];
  for (const candidate of orderedCandidates(plan)) {
    const { state } = await observePathState(oracleWorktree, candidate.path, index);
    const gap = evidenceGap(candidate, state);
    if (gap !== null) {
      missing.push({ path: candidate.path, changeGroupId: candidate.changeGroupId, detail: gap });
    }
  }
  return missing;
}
