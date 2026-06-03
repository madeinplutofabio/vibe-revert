// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/git.
//
// Consumers (the CLI orchestration layer in `viberevert`; M C's check engine;
// M D's rollback CLI) import from this barrel ONLY — never from internal
// module paths. Internal module reorganization is allowed without a major
// version bump as long as this surface stays stable.
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
//     - getStatusPorcelainZRaw (raw -z bytes for M B's `end` persistence
//       of after-status.z per Step 4a — M D's dirty-tree comparison
//       feeds the persisted bytes through parseStatusPorcelainZ)
//     - parseStatusPorcelainZ (pure parser shared between live status
//       and persisted after-status.z; single-source guarantee per
//       Step 4a)
//     - getCommitTimestamp (M C — committer date for ad-hoc git-ref
//       report.started_at per D56; delegates ref-to-SHA resolution to
//       resolveCommitRef below)
//     - resolveCommitRef (M C — single source of truth across the package
//       for resolving a user-supplied ref/SHA to a canonical 40-char
//       lowercase commit SHA. Combines commit-peel + --end-of-options
//       option-injection defense + output-shape validation. The
//       architectural invariant in
//       `packages/git/test/architectural-invariants.test.ts` enforces
//       at CI time that no other module in `packages/git/src` carries
//       the literal commit-peel suffix; every other call site that
//       needs ref-to-SHA resolution MUST go through this helper.)
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
//   Restore APIs (M B → M D promotion per D73; controlled package APIs
//   per D77 — consumed only by CLI rollback orchestration, enforced by
//   the architectural-invariants test):
//     - restoreCheckpoint, RestoreCheckpointOptions (M B-introduced
//       byte-identical restore primitive; M D extends with the new
//       `allowHeadMismatch?: boolean` option per D64 so CLI's `--force`
//       can propagate as a real HEAD-mismatch override into restore).
//       Throws typed errors on refusal / verification failure (see
//       Error classes below).
//     - planRestoreCheckpoint, RestorePlan, PlanRestoreCheckpointOptions,
//       RestorePreflightFailure (M D D76 dry-run sibling). Returns a
//       structured classification of what `restoreCheckpoint` WOULD do
//       against the same checkpoint + opts; never mutates. CLI uses
//       the plan to synthesize the receipt's results[] in dry-run mode
//       AND in apply mode (single source of truth — no second
//       classification algorithm). HEAD/exclude-drift soft failures
//       surface via `RestorePlan.preflight_failures[]` for CLI to map
//       into the receipt's `failures[]` per the M D D69 schema.
//
//   Error classes (all extend Error and set `this.name` per the package's
//   error convention):
//     - GitNotAvailableError (D1 — git binary missing/unusable)
//     - CheckpointNotFoundError, CheckpointCorruptError (D23 — read-side)
//     - RestoreHeadMismatchError, RestoreExcludeDriftError,
//       RestoreExtractionConflictError, RestoreVerificationError,
//       RestoreTrackedDirtyParityError (restore-side; M B step 13 +
//       Step 3e)
//     - CommitRefNotFoundError (M C — raised by `resolveCommitRef` when
//       a ref does not resolve to a commit-ish object, or when git's
//       `rev-parse` output fails the canonical 40-char-lowercase-hex
//       SHA-shape validation. `getDiffSinceRef` wraps this as
//       `DiffRefNotFoundError` for backwards compatibility with M C
//       callers that catch the diff-specific error type; other callers
//       see `CommitRefNotFoundError` directly.)
//     - DiffRefNotFoundError, DiffParseError (M C — diff helper failures;
//       DiffRefNotFoundError wraps CommitRefNotFoundError per above)
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
//   - `loadRestorePreflight` and its result types
//     (`RestorePreflightOptions`, `RestorePreflightResult` +
//     `RestorePreflightResultWithArtifacts` +
//     `RestorePreflightResultWithoutArtifacts`,
//     `RestorePreflightArtifacts`, `ExcludeDriftDetail`) from
//     `restore-preflight.ts`: internal. `loadRestorePreflight` is the
//     non-mutating trust-validation pipeline consumed by
//     `restoreCheckpoint` (apply path) and `planRestoreCheckpoint`
//     (dry-run path). CLI rollback orchestration calls those two
//     public helpers directly; it never needs the raw preflight
//     result. Keeping preflight internal means the trust-validation
//     contract (validation order, INFO-vs-throws split, archive vs
//     patch path-policy enforcement) can be refactored without a
//     major version bump.
//
//   - `clearExtractionPathConflicts` from `restore.ts`: test-surface
//     concession. Exported from the source module so package-local
//     tests can verify the `.viberevert/**` tripwire branch
//     (`restore.ts` file header invariant #6 call site (c)) without
//     setting up a full restore lifecycle or bypassing preflight.
//     NOT a controlled CLI orchestration API; no D77 invariant binds
//     it. Test imports use
//     `import { clearExtractionPathConflicts } from "../src/restore.js"`.
//
//   - Restore-internal-path-policy primitives
//     (`VIBEREVERT_INTERNAL_STORAGE_ROOT`, `isVibeRevertInternalPath`,
//     `decodeGitQuotedEscapesForPolicyScan`,
//     `patchHeaderTargetsVibeRevertInternalPath`) from
//     `restore-internal-path-policy.ts`: internal to the restore
//     subsystem (consumed by `restore.ts` mutation side +
//     `restore-preflight.ts` evidence side). NOT a public utility
//     surface — if another package ever needs `.viberevert/**` path
//     policy (which has not happened in M A through M D), the right
//     move is to lift the policy module into a dedicated shared
//     package rather than widening this barrel. Package-local tests
//     import via
//     `import { ... } from "../src/restore-internal-path-policy.js"`.
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

// Runtime values: git subprocess wrappers (D17c single owner) +
// commit-ref resolution single source of truth (resolveCommitRef) and
// its typed error (CommitRefNotFoundError) — both M C additions.
export {
  CommitRefNotFoundError,
  getBranch,
  getCommitTimestamp,
  getHeadSha,
  getStatusPorcelainText,
  getStatusPorcelainZ,
  getStatusPorcelainZRaw,
  parseStatusPorcelainZ,
  probeGitVersion,
  resolveCommitRef,
} from "./git-cli.js";

// Runtime values: identity generators.
export { generateCheckpointId } from "./ids.js";

// Inferred TypeScript types: restore APIs (M D — D73 promotion of
// restoreCheckpoint from M B internal; D76 new planRestoreCheckpoint).
export type {
  PlanRestoreCheckpointOptions,
  RestoreCheckpointOptions,
  RestorePlan,
  RestorePreflightFailure,
} from "./restore.js";
// Runtime values: restore APIs (M D — D73 promotion + D76 dry-run sibling).
export { planRestoreCheckpoint, restoreCheckpoint } from "./restore.js";
