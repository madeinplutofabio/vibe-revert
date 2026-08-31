// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The final fence (M 0.8.0 step 10E, §10).
//
// The last read-only check before selective rollback becomes irreversible. It
// answers one question:
//
//     is the repository still, right now, the thing the transaction was
//     approved against?
//
// Only on an exact yes may the caller publish `attempt.json` and let 10F mutate.
//
// READ-ONLY. It publishes nothing, allocates no rollback id, and imports
// neither `worktree-materialize.ts` nor `index-transplant.ts`. Like every other
// step-10 module it is absent from the package barrel; 10F exports it along with
// its first real consumer.
//
// =============================================================================
// The fence owns the final observation. The caller owns only the baseline.
// =============================================================================
//
// This is why it is not a pure two-snapshot comparator like
// `stabilizeSelectiveRestorePlan`, and why it does not receive an already
// captured artifact like `validateRecoveryHandle`. Both of those answer
// timeless questions about values. This one asserts something about WHEN:
//
//     observe the protected domain as late as possible
//     compare it against frozen S
//     only if equal may the marker be published
//
// A signature taking both `S` and `S'` cannot tell a true final fence from two
// snapshots captured five seconds apart, so the module would promise a timing
// guarantee its type does not hold. Taking only the frozen baseline and owning
// the live capture makes that guarantee structural.
//
// The options interface EXTENDS `ProtectedDomainCaptureOptions`, and the
// re-capture forwards the rest object rather than a rebuilt literal, so a
// capture option added later cannot be silently dropped at this call site and
// leave the two observations incomparable.
//
// =============================================================================
// HEAD is fence evidence, not protected-domain membership
// =============================================================================
//
// `S` provably cannot see a commit. Verified directly:
//
//     staged, pre-commit    100644 6178079... 0  f.txt      HEAD 6753d06
//     same index, post-commit
//                           100644 6178079... 0  f.txt      HEAD eda029b
//
// Same mode, same oid, same stage, worktree untouched. So both axes of every
// `PathState` are unchanged, every topology watch has identical membership, and
// `compareProtectedDomainSnapshots` reports an empty difference while HEAD has
// moved underneath the transaction.
//
// That is a real transactional hole rather than a tidiness point:
//
//     S captured at HEAD A;  E created at HEAD A
//     another actor commits; HEAD becomes B
//     domain comparator says equal -> marker -> mutation begins
//
// The emergency checkpoint that is supposed to represent the recoverable
// pre-mutation state belongs to HEAD A, while the repository crossed the
// mutation boundary at HEAD B. If recovery later restores E, that concurrent
// commit is at risk of being swept into the rollback event even though it landed
// before our marker.
//
// So HEAD is carried SEPARATELY rather than widening `ProtectedDomainSnapshot`,
// which plan stabilization also consumes and which has no business holding a
// commit id:
//
//     ProtectedDomainSnapshot   filesystem and index protection domain only
//     final fence               protected-domain equality + HEAD continuity
//
// The expected value is the HEAD captured WITH `S`, never E's manifest HEAD.
// Normally they agree, but S's HEAD is what preserves the actual transactional
// claim: nothing transaction-relevant changed since the protected pre-rollback
// snapshot. E remains the recovery handle, not the authority defining the
// baseline.
//
// =============================================================================
// HEAD is read AFTER the domain capture, deliberately
// =============================================================================
//
// The capture is a repository-scale lstat pass, so a commit can land while it
// runs. Reading HEAD first would record A, and the capture would see nothing,
// precisely because a commit leaves both axes untouched: the fence would pass
// with the live repository at B. Reading it last catches exactly that window.
//
// The observations are sequential, not atomic. Reading HEAD after the protected
// domain closes the otherwise-invisible commit-during-capture window, because a
// commit may move HEAD without changing either `PathState` axis or topology
// membership.
//
// Repository state can still change after its relevant final observation and
// before `attempt.json` is published, and that is true of every observation
// here rather than only HEAD: a path observed early in the capture pass can move
// while the pass is still running. Node and Git provide no transaction spanning
// these observations and arbitrary external repository writers. The fence
// narrows that race window; it does not claim to eliminate it.
//
// A transient excursion that RETURNS to A (commit then `reset --soft`) is
// invisible to either ordering, and is correctly benign: E is pinned to A and the
// repository is back at A, so the transactional claim still holds.
//
// An unborn HEAD makes `getHeadSha` throw. That is right, and is not laundered
// into a mismatch: a repository with no commits has no checkpoint to restore, so
// the failure is that we could not read the repository, not that it moved.
//
// =============================================================================
// Plan stabilization is NOT re-run here
// =============================================================================
//
// `stabilizeSelectiveRestorePlan` is pure over `(plan, snapshot)`, and the
// fields `compareProtectedDomainSnapshots` compares are exactly the fields the
// stabilizer reads. An empty difference therefore means the live domain is
// value-equal to `S` on every input that function consumes, so re-running it
// would recompute a known answer.
//
// Worse, it would read as a second independent safety check when it is not.
// The complete pre-mutation sequence has one stabilization, and it happens
// against `S`:
//
//     plan  ->  capture S + HEAD_S  ->  stabilize plan against S
//           ->  create E  ->  validate E against S.states
//           ->  oracle evidence  ->  FINAL FENCE  ->  attempt.json  ->  10F
//
// =============================================================================
// A failure is not a mismatch
// =============================================================================
//
// There is no `catch`. A failed enumeration, an unreadable index, or a git
// invocation error throws. Reporting those as `precondition_changed` would tell
// the operator the repository moved when the truth is that we never managed to
// observe it, and the two demand different responses.
//
// Both difference kinds are reported together rather than short-circuited. They
// are independent evidence about different failures, neither derives from the
// other, both observations have already been paid for, and an operator deciding
// how to recover wants both facts. Order is fixed: protected domain, then HEAD.
//
// The result is a MODULE-LOCAL structured union, matching every sibling phase
// module (`plan-stabilization.ts`, `recovery-handle.ts`, `oracle-evidence.ts`)
// and `protected-domain.ts`'s rule that these modules return structured
// differences while callers name the failure. 10F owns the single mapping onto
// the orchestration taxonomy, where this becomes `PRECONDITION_CHANGED`.

import { getHeadSha } from "./git-cli.js";
import {
  captureProtectedDomain,
  compareProtectedDomainSnapshots,
  type ProtectedDomainCaptureOptions,
  type ProtectedDomainDifference,
  type ProtectedDomainSnapshot,
  protectedDomainUnchanged,
} from "./protected-domain.js";

// =============================================================================
// Types
// =============================================================================

export interface FinalProtectedDomainFenceOptions extends ProtectedDomainCaptureOptions {
  /** `S`, frozen before E was created. The caller supplies it and nothing else. */
  readonly frozenSnapshot: ProtectedDomainSnapshot;
  /**
   * HEAD as observed when `S` was captured.
   *
   * Deliberately not E's manifest HEAD: `S` defines the baseline this fence
   * asserts continuity with, and E is the recovery handle rather than the
   * authority over what "unchanged" means.
   */
  readonly expectedHeadSha: string;
}

export type FinalFenceDifference =
  | {
      readonly kind: "protected_domain";
      readonly difference: ProtectedDomainDifference;
    }
  | {
      /**
       * HEAD moved. Reported on its own terms, with both SHAs, rather than as a
       * fabricated changed path: no protected path need have changed for this to
       * be a refusal.
       */
      readonly kind: "head_moved";
      readonly expectedHeadSha: string;
      readonly observedHeadSha: string;
    };

export type FinalProtectedDomainFenceResult =
  | { readonly outcome: "stable" }
  | {
      /**
       * 10F names this `PRECONDITION_CHANGED`. A HEAD-only difference is a full
       * refusal, not a warning.
       */
      readonly outcome: "precondition_changed";
      readonly differences: readonly FinalFenceDifference[];
    };

// =============================================================================
// The fence
// =============================================================================

/**
 * Re-observe the repository and require it to still be `S` at `expectedHeadSha`.
 *
 * Returns `stable` only on exact equality across protected states, topology
 * watches, and HEAD. Any difference is a refusal; nothing here is advisory, and
 * there is no force path.
 */
export async function finalProtectedDomainFence(
  opts: FinalProtectedDomainFenceOptions,
): Promise<FinalProtectedDomainFenceResult> {
  const { frozenSnapshot, expectedHeadSha, ...captureOptions } = opts;

  // Domain first, HEAD second: see the ordering note in this file's header.
  const current = await captureProtectedDomain(captureOptions);
  const observedHeadSha = await getHeadSha(captureOptions.repoRoot);

  const differences: FinalFenceDifference[] = [];

  const difference = compareProtectedDomainSnapshots(frozenSnapshot, current);
  if (!protectedDomainUnchanged(difference)) {
    differences.push({ kind: "protected_domain", difference });
  }
  if (observedHeadSha !== expectedHeadSha) {
    differences.push({ kind: "head_moved", expectedHeadSha, observedHeadSha });
  }

  return differences.length === 0
    ? { outcome: "stable" }
    : { outcome: "precondition_changed", differences };
}
