// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// EvaluationSnapshot: the resolved evaluation rules captured at session start.
//
// M 0.8.0 step 0. Embedded in SessionState, never written standalone.
//
// =============================================================================
// Why this exists (safety, not convenience)
// =============================================================================
//
// `.viberevert.yml` is a file in the repository, which means THE AGENT CAN EDIT
// IT DURING ITS OWN SESSION. If VibeRevert read live config at recovery time,
// two inversions follow:
//
//   1. `verify.commands` would let an agent arrange for VibeRevert to execute
//      an agent-chosen command at the exact moment the human tries to recover.
//   2. `checks: { payments: false }` written mid-session would weaken
//      `viberevert check` before the session even ends.
//
// So session-bound evaluation reads THIS snapshot, taken at `viberevert start`
// from an already-validated config, for both active and ended sessions and for
// selective rollback. The legacy no-selector full rollback keeps its existing
// live-config plus exclude-drift behavior, which is a separate contract.
//
// This is configuration snapshotting. It is not the 0.9.0 policy engine, and
// deliberately carries no policy decisions, no reason codes, and no digest of
// the source config file.
//
// =============================================================================
// Vocabulary ownership
// =============================================================================
//
// The `checks.*` toggle names are owned by `Config["checks"]` in
// `@viberevert/core`, which this package cannot import without inverting the
// dependency graph. The duplication below is therefore deliberate rather than
// incidental: a persisted snapshot must pin the vocabulary AS IT WAS AT WRITE
// TIME, independent of whatever the live config schema later becomes.
//
// Adding a ninth check toggle means adding an OPTIONAL field here with a
// documented default, per this package's rule that new optional fields may land
// within an unchanged schema_version. It does not mean making the existing
// eight optional.

import { z } from "zod";
import { nonBlankString, sortedUniqueStringArray } from "./atoms.js";
import { RiskLevelSchema } from "./risk-level.js";

// =============================================================================
// Resolved check toggles
// =============================================================================

/**
 * Every `checks.*` toggle, RESOLVED: defaults already applied, so each key is
 * a concrete boolean rather than an optional override.
 *
 * All eight are required precisely because this is the resolved view. A sparse
 * snapshot would reintroduce the ambiguity the resolution step exists to remove
 * -- a reader could not tell "explicitly disabled" from "not mentioned".
 */
export const ResolvedChecksSchema = z.strictObject({
  secrets: z.boolean(),
  dependencies: z.boolean(),
  migrations: z.boolean(),
  auth: z.boolean(),
  payments: z.boolean(),
  infra: z.boolean(),
  tests: z.boolean(),
  scope_expansion: z.boolean(),
});
export type ResolvedChecks = z.infer<typeof ResolvedChecksSchema>;

// =============================================================================
// Frameworks
// =============================================================================

/**
 * How the framework set was determined at session start.
 *
 * `explicit` means the project pinned `frameworks` in config; those values are
 * used verbatim and detection is never consulted, at start or at end.
 * "Verbatim" here is semantic -- the configured set is authoritative -- not
 * byte-preserving: the values are stored sorted and deduped like every other
 * persisted set.
 *
 * `auto` means config omitted `frameworks`, so `detectFrameworks` ran. Only the
 * START detection is recorded here, because it is the only part that belongs to
 * the session-start snapshot. The END detection is an observation of the
 * coherent end state and lives on the contribution as
 * `detected_frameworks_at_end`.
 *
 * Evaluation then unions the two ends under `auto`, so a framework introduced
 * mid-session activates its rules while deleting a framework signature cannot
 * deactivate them. Freezing the start set alone would let an agent introduce a
 * framework whose checks never run.
 */
export const SnapshotFrameworksSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("explicit"),
    // Non-empty by construction: `mergeChecksConfig` treats an omitted OR EMPTY
    // `frameworks` list as auto-detect, so an empty explicit set describes a
    // resolution that cannot occur. Recording it would misrepresent what ran.
    values: sortedUniqueStringArray.refine((values) => values.length > 0, {
      message: "explicit frameworks must be non-empty; an empty list resolves as auto-detect",
    }),
  }),
  z.strictObject({
    mode: z.literal("auto"),
    // MAY be empty: detecting no frameworks is a legitimate outcome.
    detected_at_start: sortedUniqueStringArray,
  }),
]);
export type SnapshotFrameworks = z.infer<typeof SnapshotFrameworksSchema>;

// =============================================================================
// Verification commands
// =============================================================================

/**
 * One project verification command, as structured argv.
 *
 * Structured rather than a single string because VibeRevert launches without a
 * shell, where `"npm test"` is not an executable and something would have to
 * tokenize it. The object form also leaves room for future `name`, `cwd`, and
 * `timeout` without another format change.
 *
 * `args` is required but may be empty, and individual args may be empty
 * strings: `--flag=` is a legitimate argument.
 */
export const VerifyCommandSchema = z.strictObject({
  command: nonBlankString,
  args: z.array(z.string()),
});
export type VerifyCommand = z.infer<typeof VerifyCommandSchema>;

/**
 * The configured verification commands, in execution order.
 *
 * **This list is a SEQUENCE, not a set, and is deliberately NOT canonicalized.**
 * Every other list in these schemas is sorted and deduped for digest
 * stability; this one is not, because the commands run in the order given and
 * sorting them would silently change behavior. Duplicates are likewise
 * permitted: running the same command twice is a legitimate, if unusual,
 * configuration.
 *
 * MAY be empty, meaning the project configured no verification.
 */
const VerifyCommandsSchema = z.array(VerifyCommandSchema);

// =============================================================================
// The snapshot
// =============================================================================

/**
 * The resolved evaluation rules in force when `viberevert start` ran.
 *
 * Nested inside SessionState, so it carries no `schema_version` of its own and
 * evolves under `SESSION_STATE_SCHEMA_VERSION`, matching the Evidence /
 * ChangedFile / PathState precedent.
 *
 * `rollback_exclude` uses the same `sortedUniqueStringArray` shape as
 * `Manifest.untracked.exclude_patterns`, so the snapshot policy and the
 * capture-time policy can be compared directly rather than through a
 * normalization step. Per D3 it is an unordered deny-list, which is what makes
 * sorting lossless here and lossy for `verify_commands`.
 */
export const EvaluationSnapshotSchema = z.strictObject({
  risk_block_on: RiskLevelSchema,
  risk_warn_on: RiskLevelSchema,
  checks: ResolvedChecksSchema,
  frameworks: SnapshotFrameworksSchema,
  rollback_exclude: sortedUniqueStringArray,
  verify_commands: VerifyCommandsSchema,
});
export type EvaluationSnapshot = z.infer<typeof EvaluationSnapshotSchema>;
