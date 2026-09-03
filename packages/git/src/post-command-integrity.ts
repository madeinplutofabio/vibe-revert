// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Post-command integrity classification.
//
// Between the verified post-transplant state and the state after the project's
// own verification commands ran, exactly three things can have happened that
// the transaction must distinguish:
//
//   - the ignore RULES moved, in which case the two protected-domain
//     observations do not describe the same domain and comparing them proves
//     nothing;
//   - the domain itself moved, meaning a command changed managed worktree or
//     index state;
//   - HEAD moved, for example because a command committed, reset, or checked
//     out another revision.
//
// This module decides which, from observations the CALLER supplies. It reads
// nothing, spawns nothing, and captures nothing, so it can be exercised
// exhaustively as a pure function and reused unchanged wherever the
// orchestration eventually lives.
//
// ORDER IS LOAD-BEARING. The basis is compared FIRST and short-circuits. A
// domain comparison across a changed basis is not a weaker signal, it is a
// meaningless one: a path can leave the domain untouched, purely because the
// rules that define membership changed. Reporting `project_mutated` from such a
// comparison would name files that were never written, and reporting `clean`
// would hide ones that were.
//
// The converse is what makes the design work. Because the basis is checked
// first, the two domain observations may be INDEPENDENT full captures rather
// than one re-observation of the other's membership. That is what lets an added
// or removed member count as evidence.
//
// NOT exported from `./index.ts`. Package-internal until the boundary slice
// decides what the cli-commands layer sees.

import { type ExclusionBasisFingerprint, exclusionBasisChanged } from "./exclusion-basis.js";
import {
  compareProtectedDomainSnapshots,
  type ProtectedDomainDifference,
  type ProtectedDomainSnapshot,
  protectedDomainUnchanged,
} from "./protected-domain.js";

/**
 * One coherent observation of everything the comparison needs.
 *
 * CALLER OBLIGATION: both domains must be COMPLETE captures via
 * `captureProtectedDomain`, taken with IDENTICAL plan and session-start
 * `rollback.exclude` inputs.
 *
 * Specifically NOT `observeProtectedDomainFromFrozenMembership`. That helper
 * exists for the transplant boundary, where the transaction must not move the
 * yardstick it is judged by, and it can only re-observe paths that were already
 * members. Here that would be a hole rather than a safeguard: a managed
 * untracked path CREATED by a verification command is a new member, and it is
 * one of the mutations this classification exists to catch.
 *
 * Independently derived membership is comparable precisely because the basis is
 * compared first. Membership is computed FROM the ignore rules, so two fresh
 * captures agree on what membership means exactly when the basis is unchanged.
 * The basis check is therefore a precondition of the comparison, not an extra
 * signal beside it.
 */
export interface PostCommandObservation {
  readonly domain: ProtectedDomainSnapshot;
  readonly basis: ExclusionBasisFingerprint;
  /** Canonical 40-character lowercase commit SHA. */
  readonly headSha: string;
}

export type PostCommandIntegrity =
  | { readonly outcome: "clean" }
  | {
      readonly outcome: "basis_changed";
      readonly before: ExclusionBasisFingerprint;
      readonly after: ExclusionBasisFingerprint;
    }
  | {
      readonly outcome: "project_mutated";
      readonly differences: ProtectedDomainDifference;
      readonly headMoved: boolean;
    };

/**
 * Classify what happened between two observations.
 *
 * `basis_changed` deliberately reports NEITHER the domain differences nor HEAD
 * movement. Both are computable, and both would be unsound to present: the
 * differences are uninterpretable, and pairing a trustworthy HEAD fact with an
 * untrustworthy domain fact in one result invites a caller to read the whole
 * result as evidence. The outcome is terminal for the transaction either way,
 * so nothing actionable is lost by refusing to guess.
 *
 * `project_mutated` covers HEAD movement even when the domain is untouched. A
 * command that runs `git commit` leaves every managed path exactly as verified
 * while changing history, which is precisely the case a bytes-only check would
 * pass. `headMoved` is carried separately so a receipt can say which of the two
 * fired without re-deriving it.
 *
 * There is no `not_run` outcome here. "The commands were never configured" is a
 * fact about the command phase, not a classification of two observations, and
 * belongs to the phase union that the orchestration owns.
 */
export function classifyPostCommandIntegrity(
  before: PostCommandObservation,
  after: PostCommandObservation,
): PostCommandIntegrity {
  if (exclusionBasisChanged(before.basis, after.basis)) {
    return { outcome: "basis_changed", before: before.basis, after: after.basis };
  }

  const differences = compareProtectedDomainSnapshots(before.domain, after.domain);
  const headMoved = before.headSha !== after.headSha;
  if (protectedDomainUnchanged(differences) && !headMoved) {
    return { outcome: "clean" };
  }
  return { outcome: "project_mutated", differences, headMoved };
}
