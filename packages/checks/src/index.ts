// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/checks.
//
// Consumers import the engine, registry, types, and stable helpers from
// here. Internal implementation modules (classifier matcher, severity
// internals, registry detail) may move without a public API break.
//
// Naming convention (consistent with @viberevert/session-format):
//   - <Thing>: TypeScript type.
//   - <THING>_CONSTANT: locked numeric / string literal.
//   - lowerCamelFunction: callable helper.
//
// What's public in Step 2 of M C:
//   - The check engine: runChecks, in the two lifecycle modes selected by
//     `reportId` — RunChecksOptions/RunChecksResult (pre-identity) and
//     IdentifiedRunChecksOptions/IdentifiedRunChecksResult (identity-bearing).
//   - The check interface + context types: Check, CheckContext,
//     ChangedFileInput, LineChunk, ChecksToggleConfig.
//   - The finding lifecycle types: DetectorResult (what a check emits, with
//     affected_paths required and finding_id structurally absent) and
//     IdentifiedCheckResult (a final finding carrying both).
//   - Re-exports of session-format types frequently used by check
//     authors: ChangedFile, ChangedFileStatus, CheckResult, Confidence,
//     Evidence, RiskLevel.
//   - The registry: BUILTIN_CHECKS (empty in Step 2), CHECKS_TOGGLE_MAP,
//     deriveEnabledCategories.
//   - Stable severity helpers and cluster caps: compareLevel,
//     sortFindings, clusterFindings, CLUSTER_CAP_LOW,
//     CLUSTER_CAP_PER_CATEGORY, CLUSTER_CAP_TOTAL.
//   - The PathRule type (so check authors can compose against the
//     classifier's rule shape).
//
// What is NOT public (intentionally — test/internal implementation
// detail; tests import from internal module paths):
//   - classifyPath / classifyPathWithCompiledRules / compilePathRules /
//     CompiledPathRule (classifier implementation; runChecks is the
//     public abstraction over it).
//   - PATH_RULES (data table whose shape may evolve in Step 3+).

export type { PathRule } from "./classifiers/path-rules.js";
export { runChecks } from "./engine.js";

export { BUILTIN_CHECKS, CHECKS_TOGGLE_MAP, deriveEnabledCategories } from "./registry.js";

export {
  CLUSTER_CAP_LOW,
  CLUSTER_CAP_PER_CATEGORY,
  CLUSTER_CAP_TOTAL,
  clusterFindings,
  compareLevel,
  sortFindings,
} from "./severity.js";
export type {
  ChangedFile,
  ChangedFileInput,
  ChangedFileStatus,
  Check,
  CheckContext,
  CheckResult,
  ChecksToggleConfig,
  Confidence,
  DetectorResult,
  Evidence,
  IdentifiedCheckResult,
  IdentifiedRunChecksOptions,
  IdentifiedRunChecksResult,
  LineChunk,
  RiskLevel,
  RunChecksOptions,
  RunChecksResult,
} from "./types.js";
