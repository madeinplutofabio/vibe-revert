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
//     - generateSessionId (D5/D16 — core owns session IDs; git owns
//       checkpoint IDs separately)
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
// Session lifecycle (M B Step 4).
export { generateSessionId } from "./ids.js";
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
