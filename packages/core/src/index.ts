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
// Path helpers + repo-root resolution.
export {
  ensureViberevertDirs,
  RepoRootNotFoundError,
  resolveRepoRoot,
  viberevertDir,
} from "./paths.js";

// Redaction (stub for v0.7.0-beta; reserved for future cloud-sync seam).
export { redact, SECRET_PATTERN_COUNT } from "./redact.js";
