// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/session-format.
//
// Consumers import schemas, type aliases, and helpers from here only — not
// from internal module paths. Internal module reorganization is allowed
// without a major version bump as long as this surface stays stable.
//
// Naming convention:
//   - <Thing>Schema is the runtime zod value (use for .parse(), .safeParse(),
//     .partial(), etc.).
//   - <Thing> is the inferred TypeScript type (use for type annotations and
//     generic parameters).
//   - <Thing>JsonSchema is the derived JSON Schema object (use for tooling /
//     external publication).
//
// Note the risk level and its ordering (`RiskLevel`, `RiskLevelSchema`,
// `compareLevel`, `riskLevelAtOrAbove`) are exported through `./schemas.js`,
// which re-exports them from `./risk-level.js`. That keeps exactly one public
// path for them even though the implementation moved.

// JSON Schema exports. ALL of them live in this one block, including the M
// 0.8.0 artifacts declared further down, so the D21 invariant has a single
// place to check.
export {
  ActiveSessionLockJsonSchema,
  ChangedFileJsonSchema,
  CheckResultJsonSchema,
  EvidenceJsonSchema,
  ManifestJsonSchema,
  ReceiptFileJsonSchema,
  ReportFileJsonSchema,
  RollbackAttemptJsonSchema,
  SelectiveRollbackReceiptJsonSchema,
  SessionContributionFileJsonSchema,
  SessionReportJsonSchema,
  SessionStateJsonSchema,
} from "./json-schema.js";
// Inferred TypeScript types.
export type {
  ActiveSessionLock,
  ChangedFile,
  ChangedFileStatus,
  CheckResult,
  Confidence,
  DetectorResult,
  DirtyTreeCheckOutcome,
  Evidence,
  Manifest,
  ReceiptFile,
  ReceiptFileSchemaVersion,
  ReportFile,
  ReportFileKind,
  ReportFileSchemaVersion,
  RiskLevel,
  RollbackFailure,
  RollbackFileOutcome,
  RollbackFileResult,
  RollbackMode,
  SessionReport,
  SessionState,
  SessionStateSchemaVersion,
  SinceKind,
} from "./schemas.js";

// Runtime zod schema values + helpers.
export {
  ActiveSessionLockSchema,
  ChangedFileSchema,
  ChangedFileStatusSchema,
  CheckResultSchema,
  ConfidenceSchema,
  compareLevel,
  DetectorResultSchema,
  DirtyTreeCheckOutcomeSchema,
  EvidenceSchema,
  isSafeStoredRelativePath,
  isSortedUniqueStringArray,
  ManifestSchema,
  NOISE_BUDGET_MAX_LOW,
  NOISE_BUDGET_MAX_PER_CATEGORY,
  NOISE_BUDGET_MAX_TOTAL,
  normalizePathArray,
  normalizeRelativePath,
  normalizeStringArray,
  RECEIPT_FILE_SCHEMA_VERSION,
  REPORT_FILE_SCHEMA_VERSION,
  ReceiptFileSchema,
  ReportFileKindSchema,
  ReportFileSchema,
  RiskLevelSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  RollbackFailureSchema,
  RollbackFileOutcomeSchema,
  RollbackFileResultSchema,
  RollbackModeSchema,
  riskLevelAtOrAbove,
  SESSION_STATE_SCHEMA_VERSION,
  SessionReportSchema,
  SessionStateSchema,
  SinceKindSchema,
} from "./schemas.js";

// -----------------------------------------------------------------------------
// M 0.8.0 -- the durable session-history substrate.
//
// Five artifact families land here: the session contribution and its PathState,
// finding identity, the session-start evaluation snapshot, the pre-mutation
// rollback attempt marker, and the selective rollback receipt.
//
// The two DERIVATION helpers are exported deliberately. `deriveChangeGroupId`
// and `deriveFindingId` are persisted-format CONTRACTS, not conveniences:
// exporting the single implementation is what stops a producer reimplementing
// the byte algorithm and drifting from what the schemas verify.
//
// Their derived JSON Schema exports (`SessionContributionFileJsonSchema`,
// `RollbackAttemptJsonSchema`, `SelectiveRollbackReceiptJsonSchema`) are NOT
// repeated in this section; they are grouped with every other `*JsonSchema` at
// the top of this file.
// -----------------------------------------------------------------------------

// Inferred TypeScript types.
export type {
  ContentDelta,
  ContributionFacet,
  ContributionFileSchemaVersion,
  ContributionOperation,
  DiffHunk,
  DiffLine,
  DiffLineKind,
  SessionContributionEntry,
  SessionContributionFile,
} from "./contribution.js";
// Runtime zod schema values + the normative change-group derivation.
export {
  ChangeGroupIdSchema,
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  ContentDeltaSchema,
  ContributionFacetSchema,
  ContributionOperationSchema,
  DiffHunkSchema,
  DiffLineKindSchema,
  DiffLineSchema,
  deriveChangeGroupId,
  SessionContributionEntrySchema,
  SessionContributionFileSchema,
} from "./contribution.js";
// Inferred TypeScript types.
export type {
  EvaluationSnapshot,
  ResolvedChecks,
  SnapshotFrameworks,
  VerifyCommand,
} from "./evaluation-snapshot.js";
// Runtime zod schema values.
export {
  EvaluationSnapshotSchema,
  ResolvedChecksSchema,
  SnapshotFrameworksSchema,
  VerifyCommandSchema,
} from "./evaluation-snapshot.js";

// Finding identity: the shape validator and the normative derivation.
export { deriveFindingId, FindingIdSchema } from "./finding-identity.js";
// Inferred TypeScript types.
export type {
  IndexEntryMode,
  IndexState,
  PathState,
  UnmergedStage,
  UnsupportedFsKind,
  WorktreeState,
} from "./path-state.js";
// Runtime zod schema values.
export {
  IndexEntryModeSchema,
  IndexStateSchema,
  PathStateSchema,
  UnmergedStageSchema,
  UnsupportedFsKindSchema,
  WorktreeStateSchema,
} from "./path-state.js";

// Inferred TypeScript types.
export type {
  RollbackAttempt,
  RollbackAttemptSchemaVersion,
  RollbackAttemptState,
  RollbackSelection,
  RollbackSelectors,
} from "./rollback-attempt.js";
// Runtime zod schema values.
export {
  ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  RollbackAttemptSchema,
  RollbackAttemptStateSchema,
  RollbackSelectionSchema,
  RollbackSelectorsSchema,
} from "./rollback-attempt.js";

// Inferred TypeScript types.
export type {
  ApplyPathOutcome,
  ApplyPathResult,
  CommandsSkippedReason,
  DryRunEligibility,
  DryRunPathOutcome,
  DryRunPathResult,
  FailureSummary,
  IntegrityAssessment,
  PostCommandIntegrity,
  PostCommandIntegrityNotRunReason,
  ProjectVerification,
  ResolvedTargetKind,
  SelectiveRollbackReceipt,
  SelectiveRollbackReceiptSchemaVersion,
  VerifyCommandRecord,
  VerifyCommandResult,
} from "./selective-rollback-receipt.js";
// Runtime zod schema values.
export {
  ApplyPathOutcomeSchema,
  ApplyPathResultSchema,
  CommandsSkippedReasonSchema,
  DryRunEligibilitySchema,
  DryRunPathOutcomeSchema,
  DryRunPathResultSchema,
  FailureSummarySchema,
  IntegrityAssessmentSchema,
  PostCommandIntegrityNotRunReasonSchema,
  PostCommandIntegritySchema,
  ProjectVerificationSchema,
  projectVerificationPassed,
  ResolvedTargetKindSchema,
  SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
  SelectiveRollbackReceiptSchema,
  VerifyCommandRecordSchema,
  VerifyCommandResultSchema,
} from "./selective-rollback-receipt.js";

export { VIBEREVERT_TEST_FIXED_NOW, VIBEREVERT_TEST_FIXED_ULID_SEED } from "./test-env-names.js";
export { toIsoSecondString } from "./time.js";
export type { SchemaVersion } from "./version.js";
export { SCHEMA_VERSION } from "./version.js";
