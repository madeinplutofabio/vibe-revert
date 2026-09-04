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
 * How a resolved launch target was classified.
 *
 * OWNED HERE because it is persisted. The CLI's launcher imports this type
 * rather than declaring a parallel one: two enums plus a synchronization
 * invariant would be strictly worse than one definition, and a kind the
 * launcher could produce but the receipt could not record would be a silent
 * gap rather than a loud failure.
 */
export const ResolvedTargetKindSchema = z.enum([
  "native",
  "cmd-shim",
  "batch-file",
  "powershell-script",
  "script",
  "extensionless",
  "unknown",
]);
export type ResolvedTargetKind = z.infer<typeof ResolvedTargetKindSchema>;

/**
 * A rendered summary of an INFRASTRUCTURE failure.
 *
 * Deliberately not `RollbackFailureSchema`: that carries `affected_paths`,
 * which is meaningful for a restore failure and meaningless for a runner,
 * observation, or classification fault. The codes are limited to what can
 * actually be determined from an unknown thrown value: a syscall error carries
 * an errno, and everything else does not.
 */
export const FailureSummarySchema = z.strictObject({
  error_code: z.enum(["io", "internal"]),
  message: nonBlankString,
});
export type FailureSummary = z.infer<typeof FailureSummarySchema>;

/** One configured command's outcome. Mirrors the runner's own result surface. */
export const VerifyCommandResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("exited"), exit_code: z.int() }),
  z.strictObject({ outcome: z.literal("signalled"), signal: nonBlankString }),
  /** The name resolved to nothing. No spawn was attempted. */
  z.strictObject({ outcome: z.literal("unresolved") }),
  /** Resolved, but not native. No spawn was attempted. */
  z.strictObject({
    outcome: z.literal("unsupported_target"),
    resolved_target: nonBlankString,
    kind: ResolvedTargetKindSchema,
  }),
  z.strictObject({
    outcome: z.literal("not_run"),
    reason: z.literal("earlier_command_did_not_pass"),
  }),
]);
export type VerifyCommandResult = z.infer<typeof VerifyCommandResultSchema>;

/**
 * The command as configured, beside what it did.
 *
 * The argv is echoed rather than referenced, because a reader holding only the
 * receipt must be able to see what ran without resolving the session's
 * evaluation snapshot, and because a snapshot recovered later could disagree.
 */
export const VerifyCommandRecordSchema = z.strictObject({
  command: nonBlankString,
  args: z.array(z.string()),
  result: VerifyCommandResultSchema,
});
export type VerifyCommandRecord = z.infer<typeof VerifyCommandRecordSchema>;

/** Why configured commands never ran. */
export const CommandsSkippedReasonSchema = z.enum([
  "transplant_failed",
  "transplant_not_clean",
  "pre_command_observation_unusable",
]);
export type CommandsSkippedReason = z.infer<typeof CommandsSkippedReasonSchema>;

const ProjectVerificationVariantSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not_configured") }),
  z.strictObject({ state: z.literal("skipped"), reason: CommandsSkippedReasonSchema }),
  z.strictObject({
    state: z.literal("completed"),
    commands: z.array(VerifyCommandRecordSchema),
  }),
  /** The runner itself faulted. NOT a command reporting failure. */
  z.strictObject({ state: z.literal("runner_failed"), failure: FailureSummarySchema }),
]);

const commandPassed = (record: VerifyCommandRecord): boolean =>
  record.result.outcome === "exited" && record.result.exit_code === 0;

/**
 * Project verification.
 *
 * No `all_passed` field: it is derivable from `commands`, and a stored copy
 * could contradict the records it summarizes. `projectVerificationPassed`
 * derives it, mirroring `isIntegrityClean`.
 *
 * The refinement encodes the runner's fail-fast contract, so a record set that
 * could not have been produced is rejected at the persistence boundary:
 * `not_run` may appear only AFTER the first non-passing command, the
 * non-passing command itself is never `not_run`, and once one appears every
 * later record is `not_run` too.
 */
export const ProjectVerificationSchema = ProjectVerificationVariantSchema.refine(
  (v) => {
    if (v.state !== "completed") {
      return true;
    }
    const firstNonPassing = v.commands.findIndex((record) => !commandPassed(record));
    if (firstNonPassing === -1) {
      return v.commands.every((record) => record.result.outcome !== "not_run");
    }
    if (v.commands[firstNonPassing]?.result.outcome === "not_run") {
      return false;
    }
    return v.commands
      .slice(firstNonPassing + 1)
      .every((record) => record.result.outcome === "not_run");
  },
  {
    message:
      "not_run records may appear only after the first non-passing command, which is itself never not_run, and every later record must also be not_run",
    path: ["commands"],
  },
);
export type ProjectVerification = z.infer<typeof ProjectVerificationSchema>;

/** True iff commands ran and every one of them exited zero. */
export function projectVerificationPassed(verification: ProjectVerification): boolean {
  return verification.state === "completed" && verification.commands.every(commandPassed);
}

/**
 * Why the post-command comparison never ran.
 *
 * Deliberately NOT sharing `CommandsSkippedReasonSchema`. A pre-command
 * observation that could not be taken is recorded as `observation_failed` or
 * `observation_torn`, which says what actually happened; folding it into
 * `not_run` would describe a failure to observe as a decision not to.
 */
export const PostCommandIntegrityNotRunReasonSchema = z.enum([
  "commands_not_configured",
  "transplant_failed",
  "transplant_not_clean",
]);
export type PostCommandIntegrityNotRunReason = z.infer<
  typeof PostCommandIntegrityNotRunReasonSchema
>;

const PostCommandIntegrityVariantSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("not_run"),
    reason: PostCommandIntegrityNotRunReasonSchema,
  }),
  z.strictObject({ state: z.literal("clean") }),
  z.strictObject({
    state: z.literal("project_mutated"),
    added_paths: sortedUniquePathArray.default([]),
    removed_paths: sortedUniquePathArray.default([]),
    changed_paths: sortedUniquePathArray.default([]),
    topology_changed_roots: sortedUniquePathArray.default([]),
    head_moved: z.boolean(),
  }),
  /** The ignore rules moved, so the domain comparison is not interpretable. */
  z.strictObject({ state: z.literal("basis_changed") }),
  z.strictObject({
    state: z.literal("observation_failed"),
    side: z.enum(["before_commands", "after_commands"]),
    failure: FailureSummarySchema,
  }),
  z.strictObject({
    state: z.literal("observation_torn"),
    side: z.enum(["before_commands", "after_commands"]),
    basis_moved: z.boolean(),
    head_moved: z.boolean(),
    domain_status: z.enum(["not_comparable", "unchanged", "moved"]),
  }),
  /** Both observations were coherent; comparing them faulted. */
  z.strictObject({ state: z.literal("classification_failed"), failure: FailureSummarySchema }),
]);

/**
 * Post-command integrity. REQUIRED on an apply receipt.
 *
 * Optionality would be ambiguous exactly where precision matters: an absent
 * field could mean "never run" or "could not be observed", and those are
 * different facts with different recovery advice.
 *
 * The refinements reject records that could not have been produced.
 * `project_mutated` must name something, or it asserts a mutation it cannot
 * point at. `observation_torn` must agree with the acquisition rule it reports:
 * a moved basis makes the domain not comparable, a stable basis makes it
 * comparable, and with a stable basis something must actually have moved, or
 * the sample was coherent and would not be torn at all.
 */
export const PostCommandIntegritySchema = PostCommandIntegrityVariantSchema.superRefine(
  (value, ctx) => {
    if (value.state === "project_mutated") {
      const named =
        value.added_paths.length +
        value.removed_paths.length +
        value.changed_paths.length +
        value.topology_changed_roots.length;
      if (named === 0 && !value.head_moved) {
        ctx.addIssue({
          code: "custom",
          message:
            "project_mutated must name at least one changed path or root, or report head_moved",
          path: ["head_moved"],
        });
      }
      return;
    }
    if (value.state !== "observation_torn") {
      return;
    }
    if (value.basis_moved && value.domain_status !== "not_comparable") {
      ctx.addIssue({
        code: "custom",
        message: "a moved basis makes the domain comparison not_comparable",
        path: ["domain_status"],
      });
    }
    if (!value.basis_moved && value.domain_status === "not_comparable") {
      ctx.addIssue({
        code: "custom",
        message: "not_comparable requires a moved basis",
        path: ["domain_status"],
      });
    }
    if (!value.basis_moved && !value.head_moved && value.domain_status !== "moved") {
      ctx.addIssue({
        code: "custom",
        message: "a torn sample with a stable basis requires a moved HEAD or a moved domain",
        path: ["domain_status"],
      });
    }
  },
);
export type PostCommandIntegrity = z.infer<typeof PostCommandIntegritySchema>;

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
  project_verification: ProjectVerificationSchema,
  post_command_integrity: PostCommandIntegritySchema,
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
  // Command / integrity coupling. `post_command_integrity` is REQUIRED, so the
  // rule is about which STATE it holds, not whether it is present.
  //
  // The post-command observation is taken whenever the commands were REACHED,
  // including when the runner itself faulted: what the commands did to the
  // repository is a different question from whether the runner survived asking.
  // So `not_run` belongs exactly to the cases where commands never started, and
  // its reason must name the same cause the skip did.
  //
  // The exception is a pre-command observation that could not be taken. There
  // the commands were skipped AND there is an observation to report, so the
  // integrity record says what happened rather than claiming nothing ran.
  .refine(
    (r) => {
      if (r.mode !== "apply") return true;
      const verification = r.project_verification;
      const integrity = r.post_command_integrity;
      if (verification.state === "not_configured") {
        return integrity.state === "not_run" && integrity.reason === "commands_not_configured";
      }
      if (verification.state === "skipped") {
        if (verification.reason === "pre_command_observation_unusable") {
          return (
            (integrity.state === "observation_failed" || integrity.state === "observation_torn") &&
            integrity.side === "before_commands"
          );
        }
        return integrity.state === "not_run" && integrity.reason === verification.reason;
      }
      // completed or runner_failed: the commands were reached, so an
      // observation was attempted and `not_run` would be false.
      return integrity.state !== "not_run";
    },
    {
      message:
        "post_command_integrity must be 'not_run' with the skip's own reason when commands never started, a before_commands observation record when the pre-command observation was unusable, and anything else once commands were reached",
      path: ["post_command_integrity"],
    },
  )
  // Pipeline order, forward direction: commands are reachable only after
  // mutation and the first integrity pass both succeeded.
  .refine(
    (r) => {
      if (r.mode !== "apply") return true;
      const state = r.project_verification.state;
      const reached =
        state === "completed" ||
        state === "runner_failed" ||
        (state === "skipped" &&
          r.project_verification.reason === "pre_command_observation_unusable");
      if (!reached) return true;
      const pathsOk = r.results.every(
        (x) => x.outcome === "restored" || x.outcome === "already_at_before",
      );
      return pathsOk && isIntegrityClean(r.integrity);
    },
    {
      message:
        "commands become reachable only after all selected paths were restored / already_at_before and the first integrity assessment was clean",
      path: ["project_verification"],
    },
  )
  // Pipeline order, inverse direction: a skip for a transplant reason asserts
  // the pre-command stage FAILED, so a receipt cannot report a clean transplant
  // and clean integrity while claiming its configured commands were unreachable.
  .refine(
    (r) => {
      if (r.mode !== "apply" || r.project_verification.state !== "skipped") return true;
      if (r.project_verification.reason === "pre_command_observation_unusable") return true;
      const pathsOk = r.results.every(
        (x) => x.outcome === "restored" || x.outcome === "already_at_before",
      );
      return !pathsOk || !isIntegrityClean(r.integrity);
    },
    {
      message:
        "a 'transplant_failed' or 'transplant_not_clean' skip requires mutation or the first integrity assessment to have failed",
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
        r.project_verification.state === "not_configured" ||
        projectVerificationPassed(r.project_verification);
      // `not_run` is clean here only because it is reachable under success
      // solely via not_configured; every other route to it requires a failed
      // transplant, which the path and integrity checks already reject.
      const postOk =
        r.post_command_integrity.state === "clean" || r.post_command_integrity.state === "not_run";
      return pathsOk && isIntegrityClean(r.integrity) && verifyOk && postOk;
    },
    {
      message:
        "outcome 'succeeded' requires all results restored / already_at_before, clean integrity, project verification not_configured or every command passing, and clean post-command integrity",
      path: ["outcome"],
    },
  );
export type SelectiveRollbackReceipt = z.infer<typeof SelectiveRollbackReceiptSchema>;
