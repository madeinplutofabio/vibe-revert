// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/session-format.
//
// Consumers import schemas, type aliases, and helpers from here only — not
// from internal module paths. Internal module reorganization is allowed
// without a major version bump as long as this surface stays stable.

export { SCHEMA_VERSION } from "./version.js";
export type { SchemaVersion } from "./version.js";

export {
  // Schemas (zod runtime validators)
  Evidence,
  ChangedFile,
  ChangedFileStatus,
  CheckResult,
  Confidence,
  Manifest,
  RiskLevel,
  SessionReport,
  // Helpers
  isSafeStoredRelativePath,
  isSortedUniqueStringArray,
  normalizeRelativePath,
  normalizeStringArray,
} from "./schemas.js";

export {
  EvidenceJsonSchema,
  ChangedFileJsonSchema,
  CheckResultJsonSchema,
  ManifestJsonSchema,
  SessionReportJsonSchema,
} from "./json-schema.js";
