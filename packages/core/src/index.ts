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
//   Framework detection (M A + M C + M 0.8.0 -- D42 single source of truth):
//     - detectFramework (M A): returns the structured DetectionResult
//       used by init's profile selection and ambiguity-prompt path
//     - detectFrameworks (M C): returns Promise<readonly string[]> of
//       matches, consumed by `viberevert check` to populate
//       ctx.detectedFrameworks and SessionReport.detected_frameworks
//     - detectFrameworksFromObservedStates (M 0.8.0): the same
//       signatures evaluated against captured WorktreeStates instead
//       of the live tree, so end-capture derives
//       detected_frameworks_at_end from the coherent observation set
//       it fenced rather than from a fresh read that could disagree
//       with everything else the contribution asserts. Refuses an
//       observation map missing any FRAMEWORK_OBSERVATION_PATHS
//       member instead of reporting "not detected".
//     - FRAMEWORK_OBSERVATION_PATHS (M 0.8.0): the derived set of
//       signature paths end-capture must add to its observation set.
//       Exported because the caller assembling that set needs to know
//       what to observe; deriving the list at the call site instead
//       would recreate exactly the duplicate detector D42 forbids.
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
//   Object store (M 0.8.0):
//     - putObject, getObject, hasObject: content-addressed storage for
//       session-contribution content. Every operation verifies bytes
//       against the digest they were addressed by, which is what makes
//       this an evidence store rather than a cache.
//     - objectPath, objectRelPath: pure path helpers
//     - ObjectNotFoundError, ObjectCorruptionError: exported because a
//       caller MUST distinguish them. Missing evidence and damaged
//       evidence call for different refusals, and collapsing the two
//       would let a corrupt store read as an absent one.
//
//   Path helpers + repo-root resolution (M A; objects dir M 0.8.0):
//     - resolveRepoRoot, viberevertDir, viberevertObjectsDir,
//       ensureViberevertDirs
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
//   Session contribution reader (M 0.8.0 step 8 B2):
//     - loadVerifiedSessionContribution: reads the persisted contribution
//       named by a session's binding, verifies the raw bytes against the
//       recorded SHA-256 BEFORE parsing, then proves the artifact belongs to
//       that session, checkpoint, and end timestamp.
//     - ContributionBindingError, ContributionNotFoundError,
//       ContributionDigestMismatchError: three typed evidence-binding
//       failures, kept distinct so a consumer can tell "evidence missing"
//       from "evidence altered" from "wrong terminal artifact".
//       Malformed JSON and schema-invalid contribution files are NOT
//       collapsed into these classes: they raise a wrapped parse Error or the
//       underlying Zod error, matching how loadSession reports a corrupt
//       session.json. ContributionBindingError was previously internal to
//       endSession; the read side needs it too.
//     - Plus type: SessionContributionBinding
//
//       Does NOT walk content_ref objects. Object verification follows object
//       CONSUMPTION, and getObject already rehashes on every read.
//
// =============================================================================
// Deliberately NOT exported (locked)
// =============================================================================
//
//   - writeFileAtomic, renameDirAtomic from atomic.ts (D17c):
//     package-private. Each package owns its own private atomic helpers
//     (intentional duplication across @viberevert/git, @viberevert/core,
//     and the CLI) to keep the public surface of each package describing
//     its DOMAIN, not its file-IO primitives. M 0.8.0's object store
//     consumes writeFileAtomic internally and does NOT re-export it: the
//     store's public contract is content addressing, not file IO.
//
//   - _detectorsForTests from framework-detect.ts (M 0.8.0): the
//     detector registry is an implementation detail. It is reachable
//     from the package's own tests through the internal module path so
//     they can assert the declared-paths invariant, and publishing it
//     would invite a consumer to evaluate signatures itself, which is
//     the duplicate detector D42 exists to prevent.
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
// Runtime values: framework detection (D42 single source of truth), live
// acquisition (M A + M C) and observed-state acquisition (M 0.8.0).
export {
  detectFramework,
  detectFrameworks,
  detectFrameworksFromObservedStates,
  FRAMEWORK_OBSERVATION_PATHS,
} from "./framework-detect.js";
// Runtime values: identity generators (M B + M C + M D -- D5/D16/D27/D71).
export { generateReportId, generateRollbackId, generateSessionId } from "./ids.js";
// Content-addressed object store (M 0.8.0).
export {
  getObject,
  hasObject,
  ObjectCorruptionError,
  ObjectNotFoundError,
  objectPath,
  objectRelPath,
  putObject,
} from "./object-store.js";
// Path helpers + repo-root resolution.
export {
  ensureViberevertDirs,
  RepoRootNotFoundError,
  resolveRepoRoot,
  viberevertDir,
  viberevertObjectsDir,
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
// Selective rollback invocation layout (M 0.8.0). Semantic path helpers only:
// the storage filenames stay private to core, so a consumer asks for a
// directory or for an invocation's artifacts and never for a filename.
export type {
  PublishedRollbackAttempt,
  PublishRollbackAttemptOpts,
} from "./rollback-attempt.js";
export {
  publishRollbackAttempt,
  rollbackInvocationDir,
  rollbackInvocationPaths,
  sessionRollbacksDir,
} from "./rollback-attempt.js";
export type {
  AppendCommandsLogEntryOpts,
  EndSessionOpts,
  ListSessionsResult,
  ListSessionsWarning,
  SessionContributionBinding,
  SessionSummary,
  StartSessionOpts,
} from "./session.js";
export {
  appendCommandsLogEntry,
  ContributionBindingError,
  ContributionDigestMismatchError,
  ContributionNotFoundError,
  endSession,
  listSessions,
  loadActiveSessionLock,
  loadSession,
  loadVerifiedSessionContribution,
  NoActiveSessionError,
  SessionAlreadyActiveError,
  SessionNotFoundError,
  startSession,
} from "./session.js";
