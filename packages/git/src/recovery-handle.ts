// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Recovery-handle validation (M 0.8.0 step 10B, §9 revision 13).
//
// Answers one question about the emergency checkpoint E:
//
//     is E a trustworthy recovery handle for THIS transaction?
//
// The §10 fence answers "is the repository still S?". It CANNOT answer this
// one. `createCheckpoint` has no fence, no retry, and no stability mechanism,
// so E can capture a transient state that the fence never sees:
//
//     snapshot sees A
//     createCheckpoint begins
//         external writer: A -> B
//         checkpoint captures B
//         external writer: B -> A
//     final fence sees A, matches S  -> PASS
//     marker, mutation, crash
//     recovery from E restores B
//
// Both questions must hold, because `pre_rollback_checkpoint_id` is the one
// artifact the user is told to trust after a half-completed mutation.
//
// =============================================================================
// Two axes, because a checkpoint is more than the states it reproduces
// =============================================================================
//
//     protected states     oracle(E).states  ==  S.states
//     checkpoint identity  E.manifest.git.head_sha  ==  HEAD_S
//
// The HEAD binding is not decoration. A commit moves HEAD without changing any
// `PathState` axis, which this project proved directly: staging a change and
// committing it leaves the index entry's mode, oid, and stage identical and the
// worktree untouched. So this sequence passes every other check:
//
//     S captured at HEAD A;  HEAD_S = A
//     an external commit moves HEAD to B
//     E is created, and its manifest records HEAD B
//     an external reset returns HEAD to A
//     state comparison passes, because states never moved
//     the final fence compares LIVE HEAD to HEAD_S and passes
//
// and the marker then names a recovery handle pinned to a HEAD the transaction
// never occupied. Recovering from E would restore B. The fence cannot catch
// this: it compares the live repository, not the checkpoint's own manifest.
//
// The manifest arrives free. `withCheckpointOracle` already loads it to
// bootstrap the worktree and passes it into `run`, so this costs no extra I/O.
//
// =============================================================================
// Still states-only against RAW TOPOLOGY (revision 13)
// =============================================================================
//
// This module takes `protectedStates`, never a `ProtectedDomainSnapshot`. Raw
// topology watches deliberately contain gitignored and `rollback.exclude`
// content, which the checkpoint format never captures. Requiring E to reproduce
// `node_modules/` would refuse a valid recovery handle in every ordinary Node
// repository.
//
// "States only" was always a contrast with raw topology enumeration. It never
// meant "ignore the checkpoint's own identity", and adding the HEAD comparison
// does not weaken it: with no snapshot in scope there is still no watch to
// enumerate, and `captureProtectedDomain` is still not imported.
//
// =============================================================================
// It does not create E
// =============================================================================
//
// `createCheckpoint` requires its caller to own the outer atomic rename to
// `cp_<id>/` and to enforce name uniqueness first, and that convention lives in
// the orchestration layer. Reaching for it from here would either duplicate a
// publication protocol or invert the package graph. This module knows how to
// VALIDATE an already-published E; it does not know how E gets published.
//
// =============================================================================
// A failure is not a mismatch
// =============================================================================
//
// There is no `catch`. A corrupt manifest, a failed worktree add, or a capture
// error throws, carrying `withCheckpointOracle`'s cleanup warnings on the error
// when cleanup produced any. Laundering those into `outcome: "mismatch"` would
// report "your checkpoint disagrees with the snapshot" when the truth is that we
// never managed to read the checkpoint at all, and the two demand different
// recovery advice.
//
// =============================================================================
// Two exclude policies meet here, deliberately
// =============================================================================
//
//     the oracle RESTORES E using E's own CAPTURED exclude patterns
//     we CAPTURE its state map using the SESSION-START patterns
//
// That asymmetry is intended. `captureProtectedStateMap` must interpret
// `rollback.exclude` exactly as S did, or the two maps would not be comparable.
// If E's captured policy omitted something S protects, the path surfaces in
// `removedPaths`, which is the correct verdict: E genuinely cannot reproduce it.
//
// =============================================================================
// Reading the differences (locked, so the caller need not reverse-engineer it)
// =============================================================================
//
//     protected_states  membership mismatch  ->  addedPaths ∪ removedPaths
//                       state mismatch       ->  changedPaths
//     head_mismatch     E was captured at a different HEAD than S
//
// With `compareProtectedStateMaps(protectedStates, oracleStates)`:
//
//     removedPaths   S protects the path; E could not reproduce it
//     addedPaths     the oracle materialized a protected-state member S lacks
//     changedPaths   both hold it, and the full PathState differs on some axis
//
// Both axes are reported together when both fail. They are independent facts
// about the same artifact, and neither derives from the other. We deliberately
// do not short-circuit on a HEAD mismatch: the oracle is already materialized,
// and completing the protected-state capture gives the caller the full reason
// the recovery handle is untrustworthy in one validation pass.

import type { PathState } from "@viberevert/session-format";

import { withCheckpointOracle } from "./checkpoint-oracle.js";
import {
  captureProtectedStateMap,
  compareProtectedStateMaps,
  type ProtectedStateDifference,
  protectedStatesUnchanged,
} from "./protected-domain.js";
import type { SelectiveRestorePlan } from "./restore-selective.js";

/**
 * Prefix for the oracle's scratch directory. Required by
 * `withCheckpointOracle` rather than defaulted, because it appears verbatim in
 * cleanup warnings and a shared default would mislabel whichever consumer did
 * not choose it.
 */
const TEMP_DIR_PREFIX = "viberevert-recovery-oracle-";

export interface RecoveryHandleValidationOptions {
  readonly repoRoot: string;
  /** E, already created and published by the orchestration layer. */
  readonly checkpointDir: string;
  /** The approved eligible plan, so the oracle capture covers the same domain. */
  readonly plan: SelectiveRestorePlan;
  /** SESSION-START patterns, matching how `protectedStates` was captured. */
  readonly rollbackExcludePatterns: readonly string[];
  /** `S.states` ONLY. No snapshot, so no topology watch is reachable here. */
  readonly protectedStates: ReadonlyMap<string, PathState>;
  /**
   * HEAD as observed when `S` was captured.
   *
   * E must have been captured at this same commit, or it is a recovery handle
   * for a different repository state than the one this transaction froze.
   */
  readonly expectedHeadSha: string;
}

/** Independent machine facts, never collapsed into one another. */
export type RecoveryHandleDifference =
  | {
      readonly kind: "protected_states";
      readonly difference: ProtectedStateDifference;
    }
  | {
      readonly kind: "head_mismatch";
      readonly expectedHeadSha: string;
      /** `manifest.git.head_sha` recorded when E was captured. */
      readonly observedHeadSha: string;
    };

export type RecoveryHandleValidationResult =
  | {
      readonly outcome: "valid";
      readonly cleanupWarnings: readonly string[];
    }
  | {
      readonly outcome: "mismatch";
      /** Ordered: protected states, then HEAD. */
      readonly differences: readonly RecoveryHandleDifference[];
      readonly cleanupWarnings: readonly string[];
    };

/**
 * Materialize E as a disposable worktree and require it to reproduce
 * `protectedStates` exactly, at `expectedHeadSha`.
 *
 * The comparison runs INSIDE the oracle callback, while the materialized
 * worktree is still alive, and the lifecycle warnings are joined afterwards.
 * `withCheckpointOracle` only assembles those warnings once cleanup has
 * finished, so a verdict built outside `run` could not carry them and a
 * warnings value read inside it would always be empty.
 */
export async function validateRecoveryHandle(
  opts: RecoveryHandleValidationOptions,
): Promise<RecoveryHandleValidationResult> {
  const { repoRoot, checkpointDir, plan, rollbackExcludePatterns, protectedStates } = opts;

  const { value: differences, cleanupWarnings } = await withCheckpointOracle(
    repoRoot,
    checkpointDir,
    {
      tempDirPrefix: TEMP_DIR_PREFIX,
      run: async ({ worktreePath, manifest }): Promise<readonly RecoveryHandleDifference[]> => {
        const found: RecoveryHandleDifference[] = [];

        // The oracle worktree is the repository root for this capture: its
        // index, its untracked surface, and its `.gitignore` are the ones E
        // reconstructed. Only the exclude PATTERNS come from the session start.
        const oracleStates = await captureProtectedStateMap({
          repoRoot: worktreePath,
          plan,
          rollbackExcludePatterns,
        });
        const difference = compareProtectedStateMaps(protectedStates, oracleStates);
        if (!protectedStatesUnchanged(difference)) {
          found.push({ kind: "protected_states", difference });
        }

        // The checkpoint's own identity, read from the manifest the oracle
        // already loaded. A commit is invisible to every PathState axis, so
        // nothing above can detect a checkpoint captured at another HEAD.
        if (manifest.git.head_sha !== opts.expectedHeadSha) {
          found.push({
            kind: "head_mismatch",
            expectedHeadSha: opts.expectedHeadSha,
            observedHeadSha: manifest.git.head_sha,
          });
        }

        return found;
      },
    },
  );

  return differences.length === 0
    ? { outcome: "valid", cleanupWarnings }
    : { outcome: "mismatch", differences, cleanupWarnings };
}
