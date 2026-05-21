// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/core.
//
// Consumers import from here only — not from internal module paths. Internal
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
//   Config (M A):
//     - Config (type), ConfigSchema (zod value), loadConfig
//     - ConfigNotFoundError, ConfigParseError, ConfigValidationError
//
//   Framework detection (M A + M C — D42 single source of truth):
//     - detectFramework (M A): returns the structured DetectionResult
//       used by init's profile selection and ambiguity-prompt path
//     - detectFrameworks (M C): returns Promise<readonly string[]> of
//       matches, consumed by `viberevert check` to populate
//       ctx.detectedFrameworks and SessionReport.detected_frameworks
//     - KnownProfile, DetectionResult, Resolution types
//
//   Identity generators (M B + M C — D5/D16/D27):
//     - generateSessionId (M B — `sess_<ULID>`; core owns session IDs;
//       git owns checkpoint IDs `cp_<ULID>` separately)
//     - generateReportId (M C — `rpt_<ULID>` for ad-hoc reports;
//       independent monotonic factory from generateSessionId per D27)
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
//     @viberevert/session-format (where they live) — same way core does
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

// Runtime values: identity generators (M B + M C — D5/D16/D27).
export { generateReportId, generateSessionId } from "./ids.js";
// Path helpers + repo-root resolution.
export {
  ensureViberevertDirs,
  RepoRootNotFoundError,
  resolveRepoRoot,
  viberevertDir,
} from "./paths.js";
// Redaction (stub for v0.7.0-beta; reserved for future cloud-sync seam).
export { redact, SECRET_PATTERN_COUNT } from "./redact.js";
export type {
  EndSessionOpts,
  ListSessionsResult,
  ListSessionsWarning,
  SessionSummary,
  StartSessionOpts,
} from "./session.js";
export {
  endSession,
  listSessions,
  loadActiveSessionLock,
  loadSession,
  NoActiveSessionError,
  SessionAlreadyActiveError,
  SessionNotFoundError,
  startSession,
} from "./session.js";
