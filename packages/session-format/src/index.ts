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
  RiskLevel,
  SessionReport,
  SessionState,
  SessionStateSchemaVersion,
} from "./schemas.js";

// Runtime zod schema values + helpers.
export {
  ActiveSessionLockSchema,
  ChangedFileSchema,
  ChangedFileStatusSchema,
  CheckResultSchema,
  ConfidenceSchema,
  EvidenceSchema,
  isSafeStoredRelativePath,
  isSortedUniqueStringArray,
  ManifestSchema,
  normalizeRelativePath,
  normalizeStringArray,
  RiskLevelSchema,
  SESSION_STATE_SCHEMA_VERSION,
  SessionReportSchema,
  SessionStateSchema,
} from "./schemas.js";
export type { SchemaVersion } from "./version.js";
export { SCHEMA_VERSION } from "./version.js";
