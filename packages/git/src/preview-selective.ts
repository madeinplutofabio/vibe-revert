// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The read-only selective preview.
//
// The SOLE public read-only selective entry point, as
// `runSelectiveRestoreTransaction` is the sole public mutating one. Both
// materialize the session-start oracle privately; neither exposes it, the
// evidence check, or any other part they order.
//
// READ ONLY, and structurally so. This module opens a scratch oracle and
// observes it. It never touches the project's worktree, index, or HEAD: it
// imports no transplant, no gate, no protected-domain capture and no scheduler,
// so there is nothing here that could write. Cleanup runs on every path because
// `withCheckpointOracle` owns the lifecycle.
//
// =============================================================================
// Why a preview needs the oracle at all
// =============================================================================
//
// Four of the five outcomes come from the plan. The fifth, `missing_evidence`,
// cannot: whether the checkpoint can reconstruct a path's asserted BEFORE state
// is a fact about the checkpoint, discoverable only by materializing it.
//
// Omitting it would not make the preview weaker, it would make it FALSE. A path
// whose evidence is absent would be reported `restored`, and the user would
// learn otherwise only when the apply refused. So the preview pays for an
// oracle rather than promise something it has not checked.
//
// =============================================================================
// Precedence: evidence wins
// =============================================================================
//
// Each path gets exactly one outcome, and missing evidence takes priority over
// a planning conflict. If a conflict won instead, evidence found on a conflicted
// path would vanish from the observable preview, which would make the
// exhaustive pass pointless for exactly the paths most likely to have problems.
//
// `already_at_before` is checked like everything else. Exempting it would make
// evidence validity depend on the live checkout, and would let the preview
// promise a path the apply then refuses. See `oracle-evidence.ts`.

import { withCheckpointOracle } from "./checkpoint-oracle.js";
import { collectMissingEvidence } from "./oracle-evidence.js";
import type { SelectiveRestoreClassification, SelectiveRestorePlan } from "./restore-selective.js";

const PREVIEW_ORACLE_PREFIX = "viberevert-preview-oracle-";

/**
 * One selected path's preview classification.
 *
 * The member names match the receipt's dry-run vocabulary exactly, so a caller
 * assigns rather than translates. Same arrangement as `VerifiedCandidate`.
 */
export type SelectivePreviewOutcome =
  | "restored"
  | "already_at_before"
  | "modified_since"
  | "unsupported_state"
  | "missing_evidence";

export interface SelectivePreviewPath {
  readonly path: string;
  /** Paths can repeat across groups, so a caller joins on the PAIR. */
  readonly changeGroupId: string;
  readonly outcome: SelectivePreviewOutcome;
  /** Present where the outcome has something to say beyond its name. */
  readonly detail?: string;
}

export type SelectiveRestorePreviewResult =
  | {
      readonly outcome: "previewed";
      /** One entry per classification, in the plan's own order. */
      readonly paths: readonly SelectivePreviewPath[];
      readonly cleanupWarnings: readonly string[];
    }
  /**
   * Nothing was previewed.
   *
   * Deliberately NOT called "the oracle could not be opened": the throw may come
   * from materialization OR from reading the evidence afterwards, and
   * `withCheckpointOracle` does not distinguish them. Claiming the narrower
   * cause would be an invention.
   */
  | {
      readonly outcome: "failed";
      readonly cause: unknown;
      readonly cleanupWarnings: readonly string[];
    };

export interface PreviewSelectiveRestoreOptions {
  readonly repoRoot: string;
  /** The checkpoint the restore would read FROM. Materialized, never written. */
  readonly sessionCheckpointDir: string;
  readonly plan: SelectiveRestorePlan;
}

/**
 * NUL, built rather than written as a literal.
 *
 * A space would not do: path "a b" in group "c" and path "a" in group "b c"
 * would produce the same key, and a space is legal inside a git path. NUL is
 * legal in neither component. Constructed with `fromCharCode` because a raw NUL
 * in source makes git treat the file as binary.
 */
const PAIR_DELIMITER = String.fromCharCode(0);

const pairKey = (path: string, changeGroupId: string): string =>
  `${path}${PAIR_DELIMITER}${changeGroupId}`;

interface PlannedClassification {
  readonly outcome: SelectivePreviewOutcome;
  readonly detail?: string;
}

/**
 * The plan's own verdict for a path, before evidence is consulted.
 *
 * Exhaustive at BOTH levels. A future disposition or conflict code must be
 * classified rather than fall into whichever branch a ternary happened to
 * default to.
 */
function plannedOutcome(classification: SelectiveRestoreClassification): PlannedClassification {
  const outcome = classification.outcome;
  switch (outcome.kind) {
    case "planned":
      switch (outcome.disposition) {
        case "already_at_before":
          return { outcome: "already_at_before" };
        case "restore_required":
          return { outcome: "restored" };
        default: {
          const unhandled: never = outcome.disposition;
          return unhandled;
        }
      }
    case "conflict":
      switch (outcome.reason.code) {
        case "MODIFIED_SINCE":
          return { outcome: "modified_since" };
        case "UNSUPPORTED_STATE":
          return { outcome: "unsupported_state", detail: outcome.reason.detail };
        default: {
          const unhandled: never = outcome.reason;
          return unhandled;
        }
      }
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/**
 * Cleanup warnings a throw carried out with it.
 *
 * `withCheckpointOracle` attaches them to the error when cleanup produced any,
 * which is the only route by which they survive a failure. Dropping them would
 * lose the record of a stranded worktree or temp directory precisely when
 * something already went wrong.
 */
function warningsFrom(cause: unknown): readonly string[] {
  const attached = (cause as { readonly cleanupWarnings?: unknown } | null | undefined)
    ?.cleanupWarnings;
  return Array.isArray(attached) ? (attached as readonly string[]) : [];
}

/**
 * Classify every selected path without touching the project.
 *
 * Eligibility is deliberately NOT returned. It is a three-way derivation the
 * caller owns, and a stored copy could disagree with the list beside it:
 *
 *     paths.length === 0
 *       ? "empty_selection"
 *       : paths.every(isRestorable)
 *         ? "eligible"
 *         : "ineligible"
 *
 * `every` alone would call an empty selection eligible, which is a different
 * claim from having nothing to do.
 */
export async function previewSelectiveRestore(
  opts: PreviewSelectiveRestoreOptions,
): Promise<SelectiveRestorePreviewResult> {
  const { repoRoot, sessionCheckpointDir, plan } = opts;

  let oracle: {
    readonly value: ReadonlyMap<string, string>;
    readonly cleanupWarnings: readonly string[];
  };
  try {
    // The callback returns a MAP, so the oracle closes before any classification
    // work begins and only strings escape the scratch worktree.
    oracle = await withCheckpointOracle<ReadonlyMap<string, string>>(
      repoRoot,
      sessionCheckpointDir,
      {
        tempDirPrefix: PREVIEW_ORACLE_PREFIX,
        run: async ({ worktreePath }) => {
          const missing = await collectMissingEvidence(worktreePath, plan);
          return new Map(missing.map((m) => [pairKey(m.path, m.changeGroupId), m.detail]));
        },
      },
    );
  } catch (cause) {
    return { outcome: "failed", cause, cleanupWarnings: warningsFrom(cause) };
  }

  const gaps = oracle.value;
  const paths = plan.classifications.map((classification): SelectivePreviewPath => {
    const gap = gaps.get(pairKey(classification.path, classification.changeGroupId));
    if (gap !== undefined) {
      // Evidence wins over the plan's verdict, including over a conflict.
      return {
        path: classification.path,
        changeGroupId: classification.changeGroupId,
        outcome: "missing_evidence",
        detail: gap,
      };
    }
    const planned = plannedOutcome(classification);
    return {
      path: classification.path,
      changeGroupId: classification.changeGroupId,
      outcome: planned.outcome,
      ...(planned.detail === undefined ? {} : { detail: planned.detail }),
    };
  });

  return { outcome: "previewed", paths, cleanupWarnings: oracle.cleanupWarnings };
}
