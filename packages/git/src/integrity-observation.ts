// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Coherent acquisition of an integrity observation.
//
// `classifyPostCommandIntegrity` compares two observations. It can only be as
// sound as they are, and an observation is three facts gathered over a nonzero
// interval. If the repository changes DURING that interval, the domain snapshot
// is derived partly under one world and partly under another, while the scalars
// recorded beside it can still equal the other side's. The comparison would
// then report `clean` for two snapshots neither of which ever existed.
//
// This is a different failure from `basis_changed`. That one is a statement
// about what the verification commands did. A tear is a statement about our own
// observation, and it can happen on the pre-command side before any command has
// run.
//
// WHY BRACKETING SCALARS IS NOT ENOUGH. The obvious design samples the basis
// and HEAD on both sides of the domain capture. It is insufficient, and the
// reason is specific: a TRACKED `.gitignore` is deliberately absent from
// `ExclusionBasisFingerprint`, because the protected domain already covers
// tracked paths. If such a file changes mid-capture, both basis samples agree,
// both HEAD samples agree, and membership was still derived under changing
// rules. The same applies to any file changing during the walk.
//
// So the domain is bracketed by the DOMAIN. Two consecutive full captures that
// compare equal are what licenses the word "coherent":
//
//     basisBefore, headBefore
//     domainBefore = captureProtectedDomain(...)
//     domainAfter  = captureProtectedDomain(...)
//     headAfter, basisAfter
//
// COST. Two full domain captures per observation, so four per transaction. That
// is the price of the guarantee actually being supported rather than asserted.
//
// A-B-A REMAINS UNDETECTABLE, for every sampled component. A value that changes
// and changes back between two samples reads as unchanged. No finite sampling
// excludes it, and this is written down rather than implied away.
//
// NOT exported from `./index.ts`.

import {
  captureExclusionBasis,
  type ExclusionBasisFingerprint,
  exclusionBasisChanged,
} from "./exclusion-basis.js";
import { getHeadSha } from "./git-cli.js";
import type { PostCommandObservation } from "./post-command-integrity.js";
import {
  captureProtectedDomain,
  compareProtectedDomainSnapshots,
  type ProtectedDomainCaptureOptions,
  type ProtectedDomainSnapshot,
  protectedDomainUnchanged,
} from "./protected-domain.js";

/** One acquisition attempt, with no verdict attached. */
export interface ObservationSample {
  readonly basisBefore: ExclusionBasisFingerprint;
  readonly basisAfter: ExclusionBasisFingerprint;
  readonly headShaBefore: string;
  readonly headShaAfter: string;
  readonly domainBefore: ProtectedDomainSnapshot;
  readonly domainAfter: ProtectedDomainSnapshot;
}

/**
 * What the two domain captures established.
 *
 * `not_comparable` is not a hedge. When the basis moved, the two captures were
 * derived under different membership rules, so their comparison carries no
 * information about whether the project moved. Reporting `moved` there would be
 * a claim the evidence cannot support, and reporting `unchanged` would be
 * worse.
 */
export type SampledDomainStatus = "not_comparable" | "unchanged" | "moved";

export type ObservationResolution =
  | { readonly outcome: "coherent"; readonly observation: PostCommandObservation }
  | {
      /**
       * Something moved while we were looking. Deliberately carries NO domain
       * snapshot: shipping untrustworthy evidence beside trustworthy scalars
       * invites a caller to read the whole result as evidence, which is the same
       * reasoning that keeps differences out of `basis_changed`.
       */
      readonly outcome: "torn";
      readonly basisMoved: boolean;
      readonly headMoved: boolean;
      readonly domainStatus: SampledDomainStatus;
      readonly basisBefore: ExclusionBasisFingerprint;
      readonly basisAfter: ExclusionBasisFingerprint;
      readonly headShaBefore: string;
      readonly headShaAfter: string;
    };

/**
 * Take one sample. Impure, and deliberately verdict-free so the entire tear
 * rule lives in a pure function that can be exercised exhaustively.
 *
 * Both domain captures use the SAME `opts`, which satisfies within one sample
 * the requirement that compared captures share plan and exclusion inputs. The
 * caller carries the other half: the pre-command and post-command acquisitions
 * must be given identical options too, or the eventual comparison measures two
 * different domains.
 */
export async function sampleObservation(
  opts: ProtectedDomainCaptureOptions,
): Promise<ObservationSample> {
  const { repoRoot } = opts;
  const basisBefore = await captureExclusionBasis(repoRoot);
  const headShaBefore = await getHeadSha(repoRoot);
  const domainBefore = await captureProtectedDomain(opts);
  const domainAfter = await captureProtectedDomain(opts);
  const headShaAfter = await getHeadSha(repoRoot);
  const basisAfter = await captureExclusionBasis(repoRoot);
  return { basisBefore, basisAfter, headShaBefore, headShaAfter, domainBefore, domainAfter };
}

/**
 * Decide whether a sample describes one world.
 *
 * BASIS FIRST, exactly as the post-command classification does, and for the
 * same reason: a domain comparison across changed membership rules is
 * meaningless rather than merely weaker. When the basis moved, the domain is
 * reported as `not_comparable` and is never compared at all.
 *
 * HEAD is still reported in that arm, because HEAD sampling does not depend on
 * the ignore rules and stays trustworthy. Naming every axis that can be trusted
 * matters for diagnosis: "the basis and HEAD both moved" and "only HEAD moved"
 * point at very different culprits.
 *
 * The coherent observation is built from the CLOSING samples. They compare
 * equal to the opening ones by construction, so the choice has no effect, but
 * taking them consistently from one end keeps the observation a description of
 * a single moment rather than a mixture.
 */
export function resolveObservationSample(sample: ObservationSample): ObservationResolution {
  const basisMoved = exclusionBasisChanged(sample.basisBefore, sample.basisAfter);
  const headMoved = sample.headShaBefore !== sample.headShaAfter;

  if (basisMoved) {
    return {
      outcome: "torn",
      basisMoved: true,
      headMoved,
      domainStatus: "not_comparable",
      basisBefore: sample.basisBefore,
      basisAfter: sample.basisAfter,
      headShaBefore: sample.headShaBefore,
      headShaAfter: sample.headShaAfter,
    };
  }

  const domainMoved = !protectedDomainUnchanged(
    compareProtectedDomainSnapshots(sample.domainBefore, sample.domainAfter),
  );

  if (headMoved || domainMoved) {
    return {
      outcome: "torn",
      basisMoved: false,
      headMoved,
      domainStatus: domainMoved ? "moved" : "unchanged",
      basisBefore: sample.basisBefore,
      basisAfter: sample.basisAfter,
      headShaBefore: sample.headShaBefore,
      headShaAfter: sample.headShaAfter,
    };
  }

  return {
    outcome: "coherent",
    observation: {
      domain: sample.domainAfter,
      basis: sample.basisAfter,
      headSha: sample.headShaAfter,
    },
  };
}

/**
 * Acquire one coherent observation, or report that the repository would not
 * hold still.
 *
 * TERMINAL, NOT RETRIED. A tear means something mutated the repository while
 * the rollback lock was held, which is exactly when retrying is least
 * appropriate: the mutator is a user's editor or a runaway verification
 * command, and looping would either mask it or spin. The bounded retry the plan
 * specifies for end-of-session capture answers a different situation, where the
 * competing writer is the user's own ongoing work and the session simply stays
 * active.
 */
export async function acquireIntegrityObservation(
  opts: ProtectedDomainCaptureOptions,
): Promise<ObservationResolution> {
  return resolveObservationSample(await sampleObservation(opts));
}
