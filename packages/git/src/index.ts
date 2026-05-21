// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/git.
//
// Consumers (the CLI orchestration layer in `viberevert`; M C's check engine;
// future M D's rollback CLI) import from this barrel ONLY — never from
// internal module paths. Internal module reorganization is allowed without a
// major version bump as long as this surface stays stable.
//
// =============================================================================
// Public surface
// =============================================================================
//
//   Checkpoint primitives (M B + M C):
//     - createCheckpoint, loadCheckpoint, listCheckpoints
//     - findCheckpointByName (M C — D56 name resolution for
//       `viberevert check --since <name>`)
//     - CheckpointSummary (the listCheckpoints return shape)
//
//   Git subprocess wrappers (D17c — this package is the single owner of
//   git invocation across the entire vibe-revert codebase):
//     - probeGitVersion (consumed by CLI's doctor.ts)
//     - getHeadSha, getBranch
//     - getStatusPorcelainText (raw v1 for audit storage, per D8)
//     - getStatusPorcelainZ + StatusEntry (parsed -z for machine logic, D8)
//     - getCommitTimestamp (M C — committer date for ad-hoc git-ref
//       report.started_at per D56)
//
//   Diff helpers (M C — D30 + D56). Two distinct entry points (NOT a
//   single dispatcher); CLI selects per the resolved base kind:
//     - getDiffSinceRef (git-ref base: HEAD, main, SHA, tag; supports --staged)
//     - getDiffSinceCheckpoint (checkpoint/session base via worktree +
//       sanitized mirror dirs, with liveExcludePatterns filtering per D3
//       symmetry)
//   Plus structured diff types consumed by @viberevert/checks:
//     - RawDiff, RawDiffEntry, RawDiffHunk, LineChunk, ChangedFileStatus
//     - DiffResult (the {diff, cleanupWarnings} return shape per D29 +
//       D17c — cleanup failures populate warnings, never thrown)
//     - DiffSinceCheckpointOptions
//
//   Error classes (all extend Error and set `this.name` per the package's
//   error convention):
//     - GitNotAvailableError (D1 — git binary missing/unusable)
//     - CheckpointNotFoundError, CheckpointCorruptError (D23 — read-side)
//     - RestoreHeadMismatchError, RestoreExcludeDriftError,
//       RestoreExtractionConflictError, RestoreVerificationError,
//       RestoreTrackedDirtyParityError (restore-side; M B step 13 +
//       Step 3e)
//     - DiffRefNotFoundError, DiffParseError (M C — diff helper failures)
//   Plus structured-payload type aliases consumed by the error classes:
//     - RestoreExtractionConflict, RestoreHashMismatch,
//       RestoreTrackedDirtyParityIssue
//
//   Identity generators:
//     - generateCheckpointId (D5/D17b — git owns checkpoint IDs;
//       sessions own session IDs in @viberevert/core, separately)
//
// =============================================================================
// Deliberately NOT exported (locked)
// =============================================================================
//
//   - `restoreCheckpoint` and `RestoreCheckpointOptions` (D7): restore is
//     an INTERNAL helper used by M B's fixture tests to prove round-trip
//     correctness AND by M C's `getDiffSinceCheckpoint` to materialize the
//     checkpoint base inside a scratch worktree. The user-facing
//     `viberevert rollback` CLI is M D scope (--dry-run, --force,
//     typed-confirmation, emergency pre-rollback checkpoint). M B tests
//     reach for restoreCheckpoint via `../src/restore.js` directly. Do NOT
//     widen this barrel to include it without M D orchestration in place.
//
//   - `writeFileAtomic` from `atomic.ts` (D17c): package-private. Each
//     package owns its own private atomic-write helpers (intentional
//     duplication across @viberevert/git, @viberevert/core, and the CLI)
//     to keep the public surface of each package describing its DOMAIN,
//     not its file-IO primitives.
//
//   - Internal git-cli helpers (`gitDiffUnstaged`, `gitDiffStaged`,
//     `gitListUntracked`, `gitListTrackedDirty`, `gitApply`,
//     `gitApplyWithIndex`, `gitResetHardHead`, `runGit`, `runGitText`,
//     `splitNulList`): used by `snapshots.ts`, `checkpoint.ts`,
//     `restore.ts`, and M C's `diff.ts` only. Higher-level primitives
//     above are the public surface; internal helpers stay internal so
//     git CLI conventions (--no-pager, maxBuffer, GIT_OPTIONAL_LOCKS=0,
//     env vars) live in one place.
//
//   - `sha256File` from `hashes.ts`: internal. Consumers that need
//     SHA-256 should use Node's `crypto.createHash` directly — we don't
//     promote our local streaming helper as a public utility.
//
//   - Snapshot internals (`snapshotTrackedDirty`, `snapshotUntracked`,
//     `SnapshotResult`, `SnapshotTrackedDirtyResult`): used only by
//     `createCheckpoint` to materialize archives + hash maps. Callers
//     that want snapshot data read it from the materialized manifest
//     after `loadCheckpoint`.
//
//   - Diff parser internals (`_parseUnifiedDiffForTests`,
//     `_parseNameStatusForTests`, `_assertSafeRepoRelativePathForTests`)
//     from `diff.ts`: test-only, name-prefixed with `_` per convention.
//
//   - `_resetAvailabilityCacheForTests` from `git-cli.ts`: test-only,
//     name-prefixed with `_` to signal package-internal-test use only.

// Inferred TypeScript types.
export type { CheckpointSummary } from "./checkpoint.js";
// Runtime values: checkpoint primitives.
export {
  createCheckpoint,
  findCheckpointByName,
  listCheckpoints,
  loadCheckpoint,
} from "./checkpoint.js";

// Inferred TypeScript types: diff helpers (M C).
export type {
  ChangedFileStatus,
  DiffResult,
  DiffSinceCheckpointOptions,
  LineChunk,
  RawDiff,
  RawDiffEntry,
  RawDiffHunk,
} from "./diff.js";
// Runtime values: diff helpers (M C).
export {
  DiffParseError,
  DiffRefNotFoundError,
  getDiffSinceCheckpoint,
  getDiffSinceRef,
} from "./diff.js";

export type {
  RestoreExtractionConflict,
  RestoreHashMismatch,
  RestoreTrackedDirtyParityIssue,
} from "./errors.js";
// Runtime values: error classes.
export {
  CheckpointCorruptError,
  CheckpointNotFoundError,
  GitNotAvailableError,
  RestoreExcludeDriftError,
  RestoreExtractionConflictError,
  RestoreHeadMismatchError,
  RestoreTrackedDirtyParityError,
  RestoreVerificationError,
} from "./errors.js";
export type { StatusEntry } from "./git-cli.js";

// Runtime values: git subprocess wrappers (D17c single owner).
export {
  getBranch,
  getCommitTimestamp,
  getHeadSha,
  getStatusPorcelainText,
  getStatusPorcelainZ,
  probeGitVersion,
} from "./git-cli.js";

// Runtime values: identity generators.
export { generateCheckpointId } from "./ids.js";
