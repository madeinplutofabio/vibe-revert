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
  Evidence,
  Manifest,
  ReportFile,
  ReportFileKind,
  ReportFileSchemaVersion,
  RiskLevel,
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
  REPORT_FILE_SCHEMA_VERSION,
  ReportFileKindSchema,
  ReportFileSchema,
  RiskLevelSchema,
  riskLevelAtOrAbove,
  SESSION_STATE_SCHEMA_VERSION,
  SessionReportSchema,
  SessionStateSchema,
  SinceKindSchema,
} from "./schemas.js";
export { VIBEREVERT_TEST_FIXED_NOW, VIBEREVERT_TEST_FIXED_ULID_SEED } from "./test-env-names.js";
export { toIsoSecondString } from "./time.js";
export type { SchemaVersion } from "./version.js";
export { SCHEMA_VERSION } from "./version.js";
