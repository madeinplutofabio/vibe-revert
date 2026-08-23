// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// SelectiveRollbackReceipt: the result artifact for a selective rollback.
//
// M 0.8.0 step 0. Persisted at
// `.viberevert/sessions/<sess>/rollbacks/<rb_ULID>/receipt.json`.
//
// =============================================================================
// Why this is NOT an extension of ReceiptFile
// =============================================================================
//
// The legacy `ReceiptFile` describes whole-tree rollback: reset, patch replay,
// tarball extraction, uncaptured-untracked deletion. Selective rollback
// transplants BEFORE path state instead, so the two share no outcome
// vocabulary. They also differ in storage location, in lifecycle, and in
// whether a sibling attempt marker exists.
//
// Threading mode-conditional members through `ReceiptFile` would add complexity
// to a shipped, heavily-refined contract for no compatibility benefit, since
// nothing reads a selective receipt expecting the legacy shape. `ReceiptFile`
// is therefore left completely untouched by 0.8.0.
//
// =============================================================================
// Mode is a real discriminator
// =============================================================================
//
//   dry_run  reports ELIGIBILITY. Nothing was mutated, so there is no emergency
//            checkpoint, no integrity assessment, and no verification run. An
//            ineligible dry-run is a SUCCESSFUL analysis, not a failed
//            rollback, which is why it does not carry `outcome`.
//   apply    reports OUTCOME. A sibling attempt.json exists, mutation was
//            attempted, and integrity was assessed.
//
// =============================================================================
// The apply pipeline, which several refinements below encode
// =============================================================================
//
//   mutation -> first integrity -> verification commands -> second integrity
//
// Each stage is reachable only if the previous one succeeded. Two complementary
// refinements pin that:
//
//   passed | failed  =>  the pre-command stage SUCCEEDED
//   not_run          =>  the pre-command stage FAILED
//
// `not_configured` is independent of either, because commands that do not exist
// are unreachable regardless of what came before.
//
// =============================================================================
// Finalization
// =============================================================================
//
// An apply receipt exists ONLY if the integrity assessment completed. If
// VibeRevert cannot complete it, no partially-known receipt is manufactured:
// `attempt.json` stays unfinalized and subsequent applies fail closed until
// recovery. That is exactly what the marker is for.

import { z } from "zod";
import {
  CHECKPOINT_ID_REGEX,
  isSortedUniqueStringArray,
  nonBlankString,
  ROLLBACK_ID_REGEX,
  SESSION_ID_REGEX,
  safeStoredRelativePath,
  sortedUniquePathArray,
} from "./atoms.js";
import { ChangeGroupIdSchema } from "./contribution.js";
import { RollbackSelectorsSchema } from "./rollback-attempt.js";
import { ROLLBACK_OUT_OF_SCOPE_NOTICE } from "./schemas.js";

/**
 * Independent schema version for the selective rollback receipt. A SEVENTH
 * axis. Each axis corresponds to one independently evolving persisted artifact;
 * sharing one would couple unrelated evolution, which is the situation these
 * axes exist to prevent.
 */
export const SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION = "1.0" as const;
export type SelectiveRollbackReceiptSchemaVersion =
  typeof SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION;

// =============================================================================
// Per-path outcomes
// =============================================================================

/**
 * Dry-run per-path classification.
 *
 * `restored` and `already_at_before` mean "would be" here, following the legacy
 * receipt's convention that an outcome word covers both did and would.
 *
 * The three ineligible members exist ONLY in dry-run, because eligibility is
 * all-or-nothing: an apply containing any ineligible unit refuses before
 * mutation and writes no receipt at all. This mirrors the existing
 * `skipped_unrelated_dirt` dry-run-only precedent.
 *
 * `missing_evidence` is narrow. It means the contribution was verified and this
 * group's identity is known, but some referenced restore evidence -- typically
 * an object-store blob -- is unavailable. Contribution-level failures (absent,
 * corrupt, digest mismatch) and stale-or-missing report failures for `--risk`
 * or `--finding` happen BEFORE selection resolves, produce no receipt, and
 * never appear here.
 */
export const DryRunPathOutcomeSchema = z.enum([
  "restored",
  "already_at_before",
  "modified_since",
  "unsupported_state",
  "missing_evidence",
]);
export type DryRunPathOutcome = z.infer<typeof DryRunPathOutcomeSchema>;

/**
 * Apply per-path outcome.
 *
 * `not_attempted` means a prior failure stopped the mutation sequence before
 * this selected path was reached. Without it, the engine would have to keep
 * mutating after a failure purely to satisfy the vocabulary, which is precisely
 * the behavior a recovery tool must not have.
 */
export const ApplyPathOutcomeSchema = z.enum([
  "restored",
  "already_at_before",
  "failed",
  "not_attempted",
]);
export type ApplyPathOutcome = z.infer<typeof ApplyPathOutcomeSchema>;

/**
 * One selected path's result. `change_group_id` is carried per path because
 * selection is group-atomic while restoration is per path: a rename group
 * legitimately produces two results sharing one group id.
 */
function pathResult<T extends z.ZodTypeAny>(outcome: T) {
  return z.strictObject({
    path: safeStoredRelativePath,
    change_group_id: ChangeGroupIdSchema,
    outcome,
    reason: nonBlankString.optional(),
  });
}

export const DryRunPathResultSchema = pathResult(DryRunPathOutcomeSchema);
export type DryRunPathResult = z.infer<typeof DryRunPathResultSchema>;

export const ApplyPathResultSchema = pathResult(ApplyPathOutcomeSchema);
export type ApplyPathResult = z.infer<typeof ApplyPathResultSchema>;

// =============================================================================
// Integrity and verification
// =============================================================================

/**
 * One integrity assessment: what was checked and whether the invariants held.
 *
 * `unselected_checked_count` is EVIDENCE about the size of the compared managed
 * domain, not a pass/fail flag. It exists so a clean run can prove the
 * comparison actually ran over a real domain without enumerating hundreds of
 * untouched paths.
 *
 * The count must be at least the number of violations, because every named
 * violation is by definition a member of the checked domain. Without that rule
 * the artifact could report zero paths checked while naming one that failed.
 *
 * "Clean" means exactly: `selected_verified === true`,
 * `unselected_violations` empty, `head_unchanged === true`.
 */
export const IntegrityAssessmentSchema = z
  .strictObject({
    selected_verified: z.boolean(),
    unselected_checked_count: z.int().nonnegative(),
    unselected_violations: sortedUniquePathArray,
    head_unchanged: z.boolean(),
  })
  .refine((i) => i.unselected_checked_count >= i.unselected_violations.length, {
    message: "unselected_checked_count must be at least the number of unselected violations",
    path: ["unselected_checked_count"],
  });
export type IntegrityAssessment = z.infer<typeof IntegrityAssessmentSchema>;

/** True iff every integrity invariant held. */
function isIntegrityClean(i: IntegrityAssessment): boolean {
  return i.selected_verified && i.unselected_violations.length === 0 && i.head_unchanged;
}

/**
 * Project verification state.
 *
 *   not_configured  the session-start snapshot configured no commands
 *   not_run         commands were configured but never reached, because
 *                   mutation or the first integrity pass failed first
 *   passed / failed  at least one configured command actually executed
 *
 * `not_run` is why three states are insufficient: without it, a receipt would
 * have to claim commands passed, failed, or were never configured, none of
 * which is true when they were configured and skipped.
 *
 * No command list is persisted here. The authoritative sequence already lives
 * in `session.evaluation_snapshot.verify_commands`, and a list carrying no
 * execution state would be ambiguous about whether those commands ran. Optional
 * per-command execution records land once exit-code and output-truncation
 * semantics are designed.
 */
export const ProjectVerificationStateSchema = z.enum([
  "not_configured",
  "not_run",
  "passed",
  "failed",
]);
export type ProjectVerificationState = z.infer<typeof ProjectVerificationStateSchema>;

// =============================================================================
// Resolved selection
// =============================================================================

const ChangeGroupIdSetSchema = z.array(ChangeGroupIdSchema).refine(isSortedUniqueStringArray, {
  message: "resolved_change_group_ids must be sorted ascending and contain no duplicates",
});

/**
 * Apply requires a non-empty resolution: an empty selection refuses before
 * mutation. Dry-run does NOT, because selectors matching nothing is a
 * legitimate, reportable analysis result. This is the one place the receipt
 * deliberately diverges from `RollbackAttemptSchema`, whose marker can only
 * exist for a non-empty resolution.
 */
const NonEmptyChangeGroupIdSetSchema = ChangeGroupIdSetSchema.refine((ids) => ids.length > 0, {
  message: "an apply receipt requires a non-empty resolved selection",
});

// =============================================================================
// The receipt
// =============================================================================

/**
 * Dry-run eligibility.
 *
 * `empty_selection` gives "the selectors matched nothing" exactly one spelling,
 * rather than leaving a reader to infer it from a zero-length array.
 */
export const DryRunEligibilitySchema = z.enum(["eligible", "ineligible", "empty_selection"]);
export type DryRunEligibility = z.infer<typeof DryRunEligibilitySchema>;

const DryRunBranchSchema = z.strictObject({
  schema_version: z.literal(SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION),
  mode: z.literal("dry_run"),
  rollback_id: nonBlankString,
  session_id: nonBlankString,
  checkpoint_id: nonBlankString,
  contribution_sha256: z.hash("sha256"),
  selectors: RollbackSelectorsSchema,
  resolved_change_group_ids: ChangeGroupIdSetSchema,
  results: z.array(DryRunPathResultSchema),
  eligibility: DryRunEligibilitySchema,
  written_at: z.iso.datetime({ offset: true, precision: 0 }),
  out_of_scope_notice: z.literal(ROLLBACK_OUT_OF_SCOPE_NOTICE),
});

const ApplyBranchSchema = z.strictObject({
  schema_version: z.literal(SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION),
  mode: z.literal("apply"),
  rollback_id: nonBlankString,
  session_id: nonBlankString,
  checkpoint_id: nonBlankString,
  contribution_sha256: z.hash("sha256"),
  pre_rollback_checkpoint_id: nonBlankString,
  selectors: RollbackSelectorsSchema,
  resolved_change_group_ids: NonEmptyChangeGroupIdSetSchema,
  results: z.array(ApplyPathResultSchema),
  outcome: z.enum(["succeeded", "failed"]),
  integrity: IntegrityAssessmentSchema,
  project_verification: ProjectVerificationStateSchema,
  post_command_integrity: IntegrityAssessmentSchema.optional(),
  written_at: z.iso.datetime({ offset: true, precision: 0 }),
  out_of_scope_notice: z.literal(ROLLBACK_OUT_OF_SCOPE_NOTICE),
});

/**
 * The selective rollback receipt.
 *
 * `contribution_sha256` binds the receipt to the exact contribution bytes the
 * selection was resolved against. A consumer must independently verify those
 * bytes against `session.contribution_sha256` before trusting the binding, and
 * for an apply must additionally check the five-way correspondence with the
 * sibling `attempt.json`: rollback_id, session_id, contribution_sha256,
 * pre_rollback_checkpoint_id, and a deep-equal selection. None of that is
 * schema-enforceable across files.
 */
export const SelectiveRollbackReceiptSchema = z
  .discriminatedUnion("mode", [DryRunBranchSchema, ApplyBranchSchema])
  .refine((r) => ROLLBACK_ID_REGEX.test(r.rollback_id), {
    message: "rollback_id must be a rb_<26-char Crockford ULID>",
    path: ["rollback_id"],
  })
  .refine((r) => SESSION_ID_REGEX.test(r.session_id), {
    message: "session_id must be a sess_<26-char Crockford ULID>",
    path: ["session_id"],
  })
  .refine((r) => CHECKPOINT_ID_REGEX.test(r.checkpoint_id), {
    message: "checkpoint_id must be a cp_<26-char Crockford ULID>",
    path: ["checkpoint_id"],
  })
  .refine((r) => r.mode !== "apply" || CHECKPOINT_ID_REGEX.test(r.pre_rollback_checkpoint_id), {
    message: "pre_rollback_checkpoint_id must be a cp_<26-char Crockford ULID>",
    path: ["pre_rollback_checkpoint_id"],
  })
  // Results are canonical and address the selected path domain exactly.
  .refine((r) => isSortedUniqueStringArray(r.results.map((x) => x.path)), {
    message: "results must be sorted by path ascending and contain no duplicate paths",
    path: ["results"],
  })
  .refine(
    (r) => {
      const resolved = new Set(r.resolved_change_group_ids);
      return r.results.every((x) => resolved.has(x.change_group_id));
    },
    {
      message: "every result's change_group_id must appear in resolved_change_group_ids",
      path: ["results"],
    },
  )
  .refine(
    (r) => {
      const covered = new Set(r.results.map((x) => x.change_group_id));
      return r.resolved_change_group_ids.every((id) => covered.has(id));
    },
    {
      message: "every resolved change group must appear in at least one result",
      path: ["resolved_change_group_ids"],
    },
  )
  // Dry-run eligibility coupling.
  .refine(
    (r) =>
      r.mode !== "dry_run" ||
      (r.eligibility === "empty_selection") ===
        (r.resolved_change_group_ids.length === 0 && r.results.length === 0),
    {
      message:
        "eligibility 'empty_selection' holds if and only if both resolved_change_group_ids and results are empty",
      path: ["eligibility"],
    },
  )
  .refine(
    (r) =>
      r.mode !== "dry_run" ||
      r.eligibility !== "eligible" ||
      (r.resolved_change_group_ids.length > 0 &&
        r.results.every((x) => x.outcome === "restored" || x.outcome === "already_at_before")),
    {
      message:
        "eligibility 'eligible' requires a non-empty resolved selection and only restored / already_at_before results",
      path: ["eligibility"],
    },
  )
  .refine(
    (r) =>
      r.mode !== "dry_run" ||
      r.eligibility !== "ineligible" ||
      (r.resolved_change_group_ids.length > 0 &&
        r.results.some(
          (x) =>
            x.outcome === "modified_since" ||
            x.outcome === "unsupported_state" ||
            x.outcome === "missing_evidence",
        )),
    {
      message:
        "eligibility 'ineligible' requires a non-empty resolved selection and at least one ineligible result",
      path: ["eligibility"],
    },
  )
  // Project verification coupling: a second integrity pass exists exactly when
  // commands actually ran.
  .refine(
    (r) =>
      r.mode !== "apply" ||
      (r.project_verification === "passed" || r.project_verification === "failed") ===
        (r.post_command_integrity !== undefined),
    {
      message:
        "post_command_integrity is present if and only if project_verification is 'passed' or 'failed'",
      path: ["post_command_integrity"],
    },
  )
  // Pipeline order, forward direction: commands are reachable only after
  // mutation and the first integrity pass both succeeded.
  .refine(
    (r) => {
      if (
        r.mode !== "apply" ||
        (r.project_verification !== "passed" && r.project_verification !== "failed")
      ) {
        return true;
      }
      const pathsOk = r.results.every(
        (x) => x.outcome === "restored" || x.outcome === "already_at_before",
      );
      return pathsOk && isIntegrityClean(r.integrity);
    },
    {
      message:
        "project verification can run only after all selected paths were restored / already_at_before and the first integrity assessment was clean",
      path: ["project_verification"],
    },
  )
  // Pipeline order, inverse direction: `not_run` asserts the commands were
  // configured but unreachable, so the pre-command stage MUST have failed.
  // Without this, a receipt could report a clean transplant and clean integrity
  // while still claiming its configured commands were never reached.
  .refine(
    (r) => {
      if (r.mode !== "apply" || r.project_verification !== "not_run") return true;
      const pathsOk = r.results.every(
        (x) => x.outcome === "restored" || x.outcome === "already_at_before",
      );
      return !pathsOk || !isIntegrityClean(r.integrity);
    },
    {
      message:
        "project_verification 'not_run' requires mutation or the first integrity assessment to have failed before commands were reachable",
      path: ["project_verification"],
    },
  )
  // Success is the conjunction of every guarantee the operation claims.
  .refine(
    (r) => {
      if (r.mode !== "apply" || r.outcome !== "succeeded") return true;
      const pathsOk = r.results.every(
        (x) => x.outcome === "restored" || x.outcome === "already_at_before",
      );
      const verifyOk =
        r.project_verification === "not_configured" || r.project_verification === "passed";
      const postOk =
        r.post_command_integrity === undefined || isIntegrityClean(r.post_command_integrity);
      return pathsOk && isIntegrityClean(r.integrity) && verifyOk && postOk;
    },
    {
      message:
        "outcome 'succeeded' requires all results restored / already_at_before, clean integrity, project verification not_configured or passed, and clean post-command integrity when present",
      path: ["outcome"],
    },
  );
export type SelectiveRollbackReceipt = z.infer<typeof SelectiveRollbackReceiptSchema>;
