// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/core.
//
// Consumers import from here only -- not from internal module paths. Internal
// module reorganization is allowed without a major version bump as long as
// this surface stays stable.
//
// Naming convention (matches @viberevert/session-format):
//   - <Thing>Schema is the runtime zod value.
//   - <Thing> is the inferred TypeScript type.
//
// =============================================================================
// Public surface
// =============================================================================
//
// The list below is grouped by domain. Export declarations later in this
// file are sorted by Biome/source path, not by this narrative order.
//
//   Config (M A):
//     - Config (type), ConfigSchema (zod value), loadConfig
//     - ConfigNotFoundError, ConfigParseError, ConfigValidationError
//
//   Framework detection (M A + M C -- D42 single source of truth):
//     - detectFramework (M A): returns the structured DetectionResult
//       used by init's profile selection and ambiguity-prompt path
//     - detectFrameworks (M C): returns Promise<readonly string[]> of
//       matches, consumed by `viberevert check` to populate
//       ctx.detectedFrameworks and SessionReport.detected_frameworks
//     - KnownProfile, DetectionResult, Resolution types
//
//   Policy resolution (M G1a Step 3.5a -- promoted from cli-commands):
//     - mergeChecksConfig: applies M C defaults (D57) to a parsed
//       Config and returns a fully-concrete ResolvedChecksConfig.
//       Consumed by `viberevert check` (production CLI) and by
//       `@viberevert/mcp`'s get_policy tool (slice 3.5).
//     - ResolvedChecksConfig, ChecksToggleKey types
//     - DEFAULT_RISK_BLOCK_ON, DEFAULT_RISK_WARN_ON,
//       DEFAULT_CHECKS_CONFIG, DEFAULT_FRAMEWORKS_POLICY
//
//   Identity generators (M B + M C + M D -- D5/D16/D27/D71):
//     - generateSessionId (M B -- `sess_<ULID>`; core owns session IDs;
//       git owns checkpoint IDs `cp_<ULID>` separately)
//     - generateReportId (M C -- `rpt_<ULID>` for ad-hoc reports;
//       independent monotonic factory from generateSessionId per D27)
//     - generateRollbackId (M D -- `rb_<ULID>` for rollback receipts;
//       independent monotonic factory per D71. Does NOT currently
//       drive storage paths -- receipts are session-bound per D68 --
//       but the id is recorded inside the receipt's `rollback_id`
//       field and is shape-enforced by `ReceiptFileSchema` per D69.)
//
//   Path helpers + repo-root resolution (M A):
//     - resolveRepoRoot, viberevertDir, ensureViberevertDirs
//     - RepoRootNotFoundError
//
//   Redaction (M A; stub for v0.7.0-beta, reserved for future cloud-sync seam):
//     - redact, SECRET_PATTERN_COUNT
//
//   Session lifecycle (M B Step 4):
//     - startSession, endSession, loadSession, listSessions,
//       loadActiveSessionLock
//     - SessionNotFoundError, SessionAlreadyActiveError, NoActiveSessionError
//     - Plus types: StartSessionOpts, EndSessionOpts, SessionSummary,
//       ListSessionsWarning, ListSessionsResult
//
// =============================================================================
// Deliberately NOT exported (locked)
// =============================================================================
//
//   - writeFileAtomic, renameDirAtomic from atomic.ts (D17c):
//     package-private. Each package owns its own private atomic helpers
//     (intentional duplication across @viberevert/git, @viberevert/core,
//     and the CLI) to keep the public surface of each package describing
//     its DOMAIN, not its file-IO primitives.
//
//   - SessionState, ActiveSessionLock (and their *Schema / *JsonSchema
//     companions): defined in @viberevert/session-format, not in core.
//     Consumers needing these types import directly from
//     @viberevert/session-format (where they live) -- same way core does
//     not re-export Manifest, SchemaVersion, etc.

// Inferred TypeScript types from the schema.
export type { Config } from "./config.js";

// Config schema, loader, and error subclasses.
export {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchema,
  ConfigValidationError,
  loadConfig,
} from "./config.js";

// Inferred TypeScript types: framework detection (M A + M C).
export type { DetectionResult, KnownProfile, Resolution } from "./framework-detect.js";
// Runtime values: framework detection (D42 single source of truth).
export { detectFramework, detectFrameworks } from "./framework-detect.js";
// Runtime values: identity generators (M B + M C + M D -- D5/D16/D27/D71).
export { generateReportId, generateRollbackId, generateSessionId } from "./ids.js";
// Path helpers + repo-root resolution.
export {
  ensureViberevertDirs,
  RepoRootNotFoundError,
  resolveRepoRoot,
  viberevertDir,
} from "./paths.js";
// Policy resolution (M G1a Step 3.5a -- promoted from cli-commands).
export type { ChecksToggleKey, ResolvedChecksConfig } from "./policy-resolve.js";
export {
  DEFAULT_CHECKS_CONFIG,
  DEFAULT_FRAMEWORKS_POLICY,
  DEFAULT_RISK_BLOCK_ON,
  DEFAULT_RISK_WARN_ON,
  mergeChecksConfig,
} from "./policy-resolve.js";
// Redaction (stub for v0.7.0-beta; reserved for future cloud-sync seam).
export { redact, SECRET_PATTERN_COUNT } from "./redact.js";
export type {
  AppendCommandsLogEntryOpts,
  EndSessionOpts,
  ListSessionsResult,
  ListSessionsWarning,
  SessionSummary,
  StartSessionOpts,
} from "./session.js";
export {
  appendCommandsLogEntry,
  endSession,
  listSessions,
  loadActiveSessionLock,
  loadSession,
  NoActiveSessionError,
  SessionAlreadyActiveError,
  SessionNotFoundError,
  startSession,
} from "./session.js";
