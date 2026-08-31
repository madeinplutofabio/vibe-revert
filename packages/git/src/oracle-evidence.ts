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
// There is no `catch`. A corrupt checkpoint, a failed worktree add, or an
// observation error throws. "We could not read the evidence" and "the evidence
// contradicts the plan" are different failures demanding different recovery
// advice, and collapsing them would tell the user their contribution is
// unrestorable when the truth is that we never managed to look.
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
//     checkpoint oracle -> one IndexSnapshot -> observePathState -> pathStateEqual
//
// with no content-ref dereference anywhere in it.

import type { PathState } from "@viberevert/session-format";

import { withCheckpointOracle } from "./checkpoint-oracle.js";
import {
  type IndexSnapshot,
  observePathState,
  pathStateEqual,
  readIndexSnapshot,
} from "./path-state.js";
import type { SelectiveRestoreClassification, SelectiveRestorePlan } from "./restore-selective.js";

/**
 * Prefix for the oracle's scratch directory. Required by
 * `withCheckpointOracle` rather than defaulted, because it appears verbatim in
 * cleanup warnings and a shared default would mislabel whichever consumer did
 * not choose it.
 */
const TEMP_DIR_PREFIX = "viberevert-evidence-oracle-";

export interface OracleEvidenceValidationOptions {
  readonly repoRoot: string;
  /** The SESSION-START checkpoint: the restoration source, per §2. */
  readonly checkpointDir: string;
  readonly plan: SelectiveRestorePlan;
}

export type OracleEvidenceValidationResult =
  | {
      readonly outcome: "sufficient";
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "missing_evidence";
      /** The machine-readable fact. */
      readonly path: string;
      /** A compact hint for rendering; `path` is what a caller keys on. */
      readonly detail: string;
      readonly cleanupWarnings: readonly string[];
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

interface MissingEvidence {
  readonly path: string;
  readonly detail: string;
}

/** Deterministic candidate order, over a copy. The plan is immutable input. */
function orderedCandidates(plan: SelectiveRestorePlan): readonly SelectiveRestoreClassification[] {
  return [...plan.classifications].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.changeGroupId === b.changeGroupId) return 0;
    return a.changeGroupId < b.changeGroupId ? -1 : 1;
  });
}

/**
 * Require the session-start checkpoint to reproduce every selected candidate's
 * asserted BEFORE state.
 *
 * ONE `IndexSnapshot` serves every observation, so the index axis cannot
 * disagree with itself across the walk. Observation is sequential over a
 * disposable oracle worktree. Unlike the live checkout, this is
 * VibeRevert-owned scratch state materialized for this validation, so Step 10
 * does not add a separate live-checkout fence around this read.
 *
 * The verdict is computed INSIDE the oracle callback, while the materialized
 * worktree is alive, and the lifecycle warnings are joined afterwards.
 */
export async function validateOracleEvidence(
  opts: OracleEvidenceValidationOptions,
): Promise<OracleEvidenceValidationResult> {
  const { repoRoot, checkpointDir, plan } = opts;
  if (plan.outcome !== "eligible") {
    throw new Error(
      `oracle evidence validation requires an eligible plan, received ${JSON.stringify(plan.outcome)}`,
    );
  }

  const { value: missing, cleanupWarnings } = await withCheckpointOracle(repoRoot, checkpointDir, {
    tempDirPrefix: TEMP_DIR_PREFIX,
    run: async ({ worktreePath }): Promise<MissingEvidence | null> => {
      const index: IndexSnapshot = await readIndexSnapshot(worktreePath);
      for (const candidate of orderedCandidates(plan)) {
        const { state } = await observePathState(worktreePath, candidate.path, index);
        if (pathStateEqual(state, candidate.expectedBefore)) continue;
        return {
          path: candidate.path,
          detail: `the contribution asserts ${describe(candidate.expectedBefore)}, but the session-start checkpoint reconstructs ${describe(state)}`,
        };
      }
      return null;
    },
  });

  return missing === null
    ? { outcome: "sufficient", cleanupWarnings }
    : { outcome: "missing_evidence", path: missing.path, detail: missing.detail, cleanupWarnings };
}
