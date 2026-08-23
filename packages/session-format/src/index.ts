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

// JSON Schema exports.
export {
  ActiveSessionLockJsonSchema,
  ChangedFileJsonSchema,
  CheckResultJsonSchema,
  EvidenceJsonSchema,
  ManifestJsonSchema,
  ReceiptFileJsonSchema,
  ReportFileJsonSchema,
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
// M 0.8.0 -- session contribution and path state.
//
// PathState is nested inside the contribution and is never written standalone,
// but its schemas are exported because producers (@viberevert/git) build
// PathState values directly and consumers (selective restore, verification)
// compare them.
//
// `deriveChangeGroupId` is exported deliberately: the change-group derivation
// is a persisted-format CONTRACT, and exporting the one implementation is what
// stops a producer from reimplementing it and drifting.
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

export { VIBEREVERT_TEST_FIXED_NOW, VIBEREVERT_TEST_FIXED_ULID_SEED } from "./test-env-names.js";
export { toIsoSecondString } from "./time.js";
export type { SchemaVersion } from "./version.js";
export { SCHEMA_VERSION } from "./version.js";
