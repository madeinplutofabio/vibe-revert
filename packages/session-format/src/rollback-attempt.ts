// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// RollbackAttempt: the pre-mutation crash-recovery marker.
//
// M 0.8.0 step 0. Persisted at
// `.viberevert/sessions/<sess>/rollbacks/<rb_ULID>/attempt.json`, written
// BEFORE the first worktree or index mutation of a selective apply.
//
// =============================================================================
// Why a separate artifact exists
// =============================================================================
//
// A receipt-only history model has a crash gap, and the shipped code already
// has this class of gap: the emergency checkpoint is created before mutation,
// but its linkage (`pre_rollback_checkpoint_id`) is recorded only in the
// receipt, which is written afterwards. A process death in between leaves no
// record that a mutation was ever attempted, so the next invocation would see
// no failed receipt and wrongly conclude there was no prior partial apply.
//
// The marker closes that window. It is written first, and it names the recovery
// handle, so an interrupted apply is always discoverable.
//
// =============================================================================
// Completion is signaled EXTERNALLY (locked)
// =============================================================================
//
// This artifact is IMMUTABLE once written. It is never rewritten to record an
// outcome, which is what keeps the sibling receipt a completed-result artifact
// rather than a mutable journal. The rule for readers:
//
//   attempt.json, NO sibling receipt.json  -> mutation MAY have started and did
//                                             not complete. Fails further apply
//                                             closed; recover via
//                                             pre_rollback_checkpoint_id.
//   attempt.json WITH sibling receipt.json -> the invocation finalized. The
//                                             receipt says whether it succeeded.
//
// A marker without successful finalization is treated as a potentially partial
// mutation even if the process died between writing this file and touching the
// first byte of the worktree. That is deliberately conservative: a false "you
// may need to recover" costs a glance, a false "nothing happened" costs the
// user's work.

import { z } from "zod";
import {
  CHECKPOINT_ID_REGEX,
  isSortedUniqueStringArray,
  nonBlankString,
  ROLLBACK_ID_REGEX,
  SESSION_ID_REGEX,
} from "./atoms.js";
import { ChangeGroupIdSchema } from "./contribution.js";
import { FindingIdSchema } from "./finding-identity.js";
import { RiskLevelSchema } from "./risk-level.js";

/**
 * Independent schema version for the rollback attempt marker. A SIXTH axis,
 * alongside SCHEMA_VERSION, SESSION_STATE_SCHEMA_VERSION,
 * REPORT_FILE_SCHEMA_VERSION, RECEIPT_FILE_SCHEMA_VERSION, and
 * CONTRIBUTION_FILE_SCHEMA_VERSION.
 *
 * Deliberately NOT shared with the receipt despite the two being written by the
 * same operation. They have different lifecycles: this is a pre-mutation
 * crash-recovery primitive, the receipt is a completed-result record. 0.8.0
 * gives selective rollback its own receipt artifact, and that receipt's
 * evolution must not force a migration of crash-recovery state that a stranded
 * marker on someone's disk depends on.
 */
export const ROLLBACK_ATTEMPT_SCHEMA_VERSION = "1.0" as const;
export type RollbackAttemptSchemaVersion = typeof ROLLBACK_ATTEMPT_SCHEMA_VERSION;

// =============================================================================
// Selection
// =============================================================================

/**
 * Non-emptiness is load-bearing for every repeatable selector family below,
 * rather than tidiness. Without it, `{ only: [] }` would satisfy the "at least
 * one selector present" refinement while carrying no actual selector,
 * producing two on-disk spellings of the same nothing and letting the marker
 * claim a selective rollback it cannot describe. Absence is the only way to say
 * "this family was not used".
 */
const NON_EMPTY_SELECTOR_MESSAGE =
  "selector set must contain at least one value, sorted ascending, with no duplicates";

/** `--only` / `--except`: path globs as supplied by the user. */
const NonEmptyGlobSetSchema = z
  .array(nonBlankString)
  .min(1)
  .refine(isSortedUniqueStringArray, { message: NON_EMPTY_SELECTOR_MESSAGE });

/**
 * `--finding`: finding ids, validated against the shared `FindingIdSchema`
 * rather than accepted as arbitrary strings.
 *
 * The CLI may accept an unambiguous short prefix from the user, but what is
 * PERSISTED here is always the resolved full id. A marker recording a prefix
 * would be re-resolvable only against the report that produced it, which
 * defeats the point of an artifact meant to be readable after a crash.
 */
const NonEmptyFindingIdSetSchema = z
  .array(FindingIdSchema)
  .min(1)
  .refine(isSortedUniqueStringArray, { message: NON_EMPTY_SELECTOR_MESSAGE });

/**
 * The selectors the user actually supplied, recorded for diagnostics and audit.
 *
 * Every family is optional because any ONE of them puts rollback into selective
 * mode. At least one must be present: a rollback with no selectors is the
 * legacy full-session path, which never writes this marker.
 *
 * `only`, `except`, and `finding` are SETS -- repeating a flag unions its values
 * -- so they are stored sorted and deduped. `risk` is a single at-or-above
 * threshold rather than a repeatable family, which is why it is one value and
 * not an array.
 */
export const RollbackSelectorsSchema = z
  .strictObject({
    only: NonEmptyGlobSetSchema.optional(),
    except: NonEmptyGlobSetSchema.optional(),
    risk: RiskLevelSchema.optional(),
    finding: NonEmptyFindingIdSetSchema.optional(),
  })
  .refine(
    (s) =>
      s.only !== undefined ||
      s.except !== undefined ||
      s.risk !== undefined ||
      s.finding !== undefined,
    {
      message:
        "at least one selector must be present; a rollback with no selectors is the legacy full-session path and writes no attempt marker",
    },
  );
export type RollbackSelectors = z.infer<typeof RollbackSelectorsSchema>;

/**
 * The change groups the selectors resolved to, sorted and deduped.
 *
 * Non-empty by construction: an empty resolution refuses BEFORE mutation, so no
 * marker is ever written for one. If a reader finds an empty set here, the
 * producer is broken, not the user's repository.
 *
 * Note the selective RECEIPT does not share this cardinality rule: a dry-run
 * whose selectors match nothing is a legitimate, reportable result, so that
 * artifact permits an empty resolution while this one cannot.
 */
const ResolvedChangeGroupIdsSchema = z
  .array(ChangeGroupIdSchema)
  .min(1)
  .refine(isSortedUniqueStringArray, {
    message: "resolved_change_group_ids must be sorted ascending and contain no duplicates",
  });

/**
 * What was asked for, and what it resolved to.
 *
 * Both halves are recorded because they answer different questions after a
 * crash. The selectors say what the user intended; the resolved group ids say
 * which changes were actually about to be mutated, which is what someone
 * assessing a half-applied tree needs.
 */
export const RollbackSelectionSchema = z.strictObject({
  selectors: RollbackSelectorsSchema,
  resolved_change_group_ids: ResolvedChangeGroupIdsSchema,
});
export type RollbackSelection = z.infer<typeof RollbackSelectionSchema>;

// =============================================================================
// The marker
// =============================================================================

/**
 * Marker state.
 *
 * Currently a single member, and therefore carries no varying information
 * today. It exists so the artifact is self-describing on disk and so a future
 * finer-grained state can be added without changing the file's shape.
 *
 * It is NOT updated on completion. See the file header: finalization is
 * signaled by the presence of a sibling `receipt.json`, not by mutating this
 * field.
 */
export const RollbackAttemptStateSchema = z.enum(["mutation_may_have_started"]);
export type RollbackAttemptState = z.infer<typeof RollbackAttemptStateSchema>;

/**
 * The pre-mutation attempt marker.
 *
 * `contribution_sha256` binds the attempt to the exact contribution bytes the
 * selection was resolved against, so a marker cannot be silently reinterpreted
 * against different evidence. It is a plain `z.hash("sha256")` rather than the
 * `sha256ObjectRef` atom: that atom means "a reference into
 * `.viberevert/objects/`", and this is a digest OF A FILE. Same shape, different
 * meaning, and there is no hand-written pattern here to drift.
 *
 * `pre_rollback_checkpoint_id` is the recovery handle, and is required. An
 * attempt marker that does not name a way back would defeat its own purpose:
 * the emergency checkpoint is created before this file is written precisely so
 * this field can be populated.
 *
 * `written_at` records when the attempt began, so an operator meeting a stranded
 * marker can tell an interruption from minutes ago from one from last month.
 */
export const RollbackAttemptSchema = z
  .strictObject({
    schema_version: z.literal(ROLLBACK_ATTEMPT_SCHEMA_VERSION),
    rollback_id: nonBlankString,
    session_id: nonBlankString,
    contribution_sha256: z.hash("sha256"),
    pre_rollback_checkpoint_id: nonBlankString,
    selection: RollbackSelectionSchema,
    state: RollbackAttemptStateSchema,
    written_at: z.iso.datetime({ offset: true, precision: 0 }),
  })
  .refine((a) => ROLLBACK_ID_REGEX.test(a.rollback_id), {
    message: "rollback_id must be a rb_<26-char Crockford ULID>",
    path: ["rollback_id"],
  })
  .refine((a) => SESSION_ID_REGEX.test(a.session_id), {
    message: "session_id must be a sess_<26-char Crockford ULID>",
    path: ["session_id"],
  })
  .refine((a) => CHECKPOINT_ID_REGEX.test(a.pre_rollback_checkpoint_id), {
    message: "pre_rollback_checkpoint_id must be a cp_<26-char Crockford ULID>",
    path: ["pre_rollback_checkpoint_id"],
  });
export type RollbackAttempt = z.infer<typeof RollbackAttemptSchema>;
