// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Error classes for @viberevert/git.
//
// Naming convention matches @viberevert/core (Config*Error): each class extends
// Error, sets `this.name` to its class name (so `err.name === "..."` checks
// work reliably across module realms), and carries the contextual data needed
// to produce a useful CLI message.
//
// All classes accept an optional `cause?: unknown` argument and forward it
// via `super(msg, { cause })`. This keeps every error in this package
// wrap-capable: any callsite can surface a downstream stat/exec/IO failure
// as the cause without losing the typed top-level class.
//
// Throw these from the package's public API; CLI commands map them to
// exit codes + user-facing messages.

/**
 * Thrown when the `git` binary is missing, not on PATH, or otherwise unusable.
 *
 * Per D1, every public function in @viberevert/git that invokes `git` MUST
 * surface this error at the package boundary instead of leaking a raw
 * spawn/ENOENT failure. CLI commands surface this as a clean exit-1 error
 * with the message "git is required but was not found" (or similar).
 *
 * `cause` is the underlying exec/spawn error when available, so callers that
 * want to log the raw stderr or errno can drill in.
 */
export class GitNotAvailableError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(`git is required but was not found or is not usable: ${detail}`, { cause });
    this.name = "GitNotAvailableError";
  }
}

/**
 * Thrown by `loadCheckpoint(checkpointDir)` when:
 *   - the dir does not exist
 *   - the dir's `manifest.json` is missing
 *   - the basename starts with `.tmp-` (D13/D23 — temp dirs are construction
 *     or crash markers, never valid checkpoints, even when explicitly
 *     requested by absolute path)
 *
 * `checkpointDir` is the absolute path that was requested, included in the
 * message for diagnostics. `cause` (when supplied) is the underlying stat or
 * I/O error — e.g., the original ENOENT — kept for callers that want to log
 * raw OS context.
 */
export class CheckpointNotFoundError extends Error {
  /** The absolute path that was requested but did not resolve to a checkpoint. */
  readonly checkpointDir: string;

  constructor(checkpointDir: string, reason: string, cause?: unknown) {
    super(`Checkpoint not found at ${checkpointDir}: ${reason}`, { cause });
    this.name = "CheckpointNotFoundError";
    this.checkpointDir = checkpointDir;
  }
}

/**
 * Thrown by `loadCheckpoint(checkpointDir)` when the dir and `manifest.json`
 * exist but the manifest fails schema validation, or references archive/patch
 * paths that are missing or are not regular files.
 *
 * Distinct from `CheckpointNotFoundError`: the checkpoint IS there, but its
 * contents are corrupted or have been tampered with. CLI surfaces this as a
 * trust-critical error (exit 1, distinct message from "not found").
 *
 * `cause` is the underlying validation or I/O error.
 */
export class CheckpointCorruptError extends Error {
  /** The absolute path of the corrupt checkpoint. */
  readonly checkpointDir: string;

  constructor(checkpointDir: string, reason: string, cause?: unknown) {
    super(`Checkpoint at ${checkpointDir} is corrupt: ${reason}`, { cause });
    this.name = "CheckpointCorruptError";
    this.checkpointDir = checkpointDir;
  }
}

/**
 * Thrown by `restoreCheckpoint()` when the repo's current HEAD does not
 * match the checkpoint's captured HEAD SHA. Restore cannot safely operate
 * from a different commit — the captured patches were taken relative to
 * the checkpoint's HEAD, and applying them to a different baseline would
 * produce undefined results.
 *
 * Carries both SHAs as readonly fields so the CLI / future rollback UX can
 * render specific guidance ("you're on commit X but checkpoint expects
 * commit Y; check out Y first or pick a different checkpoint") without
 * re-parsing the message string.
 *
 * `cause` is reserved for future use (e.g., wrapping a downstream
 * head-fetch failure that delivered the actual SHA).
 */
export class RestoreHeadMismatchError extends Error {
  readonly expectedHeadSha: string;
  readonly actualHeadSha: string;

  constructor(expectedHeadSha: string, actualHeadSha: string, cause?: unknown) {
    super(
      `restore refused: checkpoint expects HEAD ${expectedHeadSha}, but repo is at ${actualHeadSha}`,
      { cause },
    );
    this.name = "RestoreHeadMismatchError";
    this.expectedHeadSha = expectedHeadSha;
    this.actualHeadSha = actualHeadSha;
  }
}

/**
 * Thrown by `restoreCheckpoint()` BEFORE any mutation when the
 * `rollback.exclude` policy has drifted between capture time and restore
 * time. This is the broader successor to the original
 * `RestoreExcludeMismatchError` (renamed in M B Step 3e once
 * `Manifest.untracked.exclude_patterns` made loosening-direction drift
 * detectable as well as tightening).
 *
 * Two distinct facets of drift are surfaced together — both meaningful,
 * both worth refusing on:
 *
 * 1. **Pattern-set drift** (always populated when this error fires): the
 *    SET of patterns differs between capture-time (persisted in
 *    `manifest.untracked.exclude_patterns`) and restore-time
 *    (`opts.rollbackExcludePatterns`). Even when no captured manifest
 *    path is currently affected, the policy contract is broken — a
 *    future checkpoint replay against a different captured set could
 *    surface affected paths, and the policy mismatch is itself a signal
 *    something has changed about what the user considers safe to touch.
 *
 * 2. **Path-vs-matcher drift** (populated when tightening drift would
 *    immediately damage this specific manifest): manifest untracked
 *    paths that match the current restore-time matcher. These are the
 *    paths restore would either need to skip (breaking byte-identical)
 *    or extract over (violating the never-touch contract). The most
 *    user-actionable signal — names exactly which captured files the
 *    drift affects right now.
 *
 * Both checks fire from the same throw. Pattern-set comparison without
 * affected paths is still a real policy-broken signal; affected paths
 * give the user concrete remediation context.
 *
 * Why restore refuses instead of trying to be clever:
 *   - Silently filtering captured paths out of extraction would NOT
 *     produce a byte-identical restore (the working tree would be
 *     missing captured paths) — breaks the trust-preserving promise.
 *   - Silently extracting over excluded paths would violate the
 *     contract that excluded paths are never touched by restore.
 *   - Silently respecting capture-time policy when it differs from
 *     current would make the "current `.viberevert.yml` is the source
 *     of truth" mental model unreliable.
 *
 * User remediation: revert `.viberevert.yml`'s `rollback.exclude` to
 * match the captured patterns (visible in `capturedPatterns`), OR pick
 * a different checkpoint whose captured pattern set matches the current
 * `rollback.exclude` configuration.
 *
 * **Field semantics (all five always populated; empty arrays NOT
 * undefined, for predictable JSON-consumer shape):**
 *   - `capturedPatterns` — patterns from
 *     `manifest.untracked.exclude_patterns` (capture-time policy,
 *     normalized via `normalizeStringArray` at capture time).
 *   - `currentPatterns` — patterns from
 *     `opts.rollbackExcludePatterns` (restore-time policy, normalized
 *     to the same form before comparison).
 *   - `tighteningPatterns` — patterns in `currentPatterns` but NOT in
 *     `capturedPatterns` (= newly added since checkpoint). Sorted.
 *   - `looseningPatterns` — patterns in `capturedPatterns` but NOT in
 *     `currentPatterns` (= removed since checkpoint). Sorted.
 *   - `tighteningPaths` — manifest untracked paths matching the
 *     current matcher (= the *consequences* of tightening drift on
 *     this specific manifest). May be empty even when
 *     `tighteningPatterns` is non-empty (drift exists but no captured
 *     path falls under the new patterns yet). Sorted ASCII-ascending.
 *
 * The unordered-deny-list assumption that makes pattern-set comparison
 * sound (sort + dedup are lossless transformations) is documented
 * load-bearingly in `@viberevert/session-format`'s `schemas.ts >
 * Manifest > untracked.exclude_patterns` section. If a future milestone
 * introduces order-sensitive glob semantics, this error class's
 * pattern-set fields stop being meaningful in their current form and
 * the contract here must be revisited.
 *
 * `cause` is reserved for future use.
 */
export class RestoreExcludeDriftError extends Error {
  readonly capturedPatterns: readonly string[];
  readonly currentPatterns: readonly string[];
  readonly tighteningPatterns: readonly string[];
  readonly looseningPatterns: readonly string[];
  readonly tighteningPaths: readonly string[];

  constructor(
    fields: {
      capturedPatterns: readonly string[];
      currentPatterns: readonly string[];
      tighteningPatterns: readonly string[];
      looseningPatterns: readonly string[];
      tighteningPaths: readonly string[];
    },
    cause?: unknown,
  ) {
    const t = fields.tighteningPatterns.length;
    const l = fields.looseningPatterns.length;
    const p = fields.tighteningPaths.length;
    super(
      `restore aborted: rollback.exclude policy drifted between capture and restore time (${t} added pattern(s), ${l} removed pattern(s), ${p} manifest path(s) immediately affected)`,
      { cause },
    );
    this.name = "RestoreExcludeDriftError";
    this.capturedPatterns = fields.capturedPatterns;
    this.currentPatterns = fields.currentPatterns;
    this.tighteningPatterns = fields.tighteningPatterns;
    this.looseningPatterns = fields.looseningPatterns;
    this.tighteningPaths = fields.tighteningPaths;
  }
}

/**
 * One per-file mismatch surfaced by `RestoreVerificationError`. `path` is
 * repo-relative POSIX (matches the manifest's path conventions).
 * `actualSha256` is `null` when the file is missing entirely (vs. present
 * with the wrong content).
 */
export type RestoreHashMismatch = {
  readonly path: string;
  readonly expectedSha256: string;
  readonly actualSha256: string | null;
};

/**
 * Thrown by `restoreCheckpoint()` when, after the restore sequence
 * completes, one or more files do not match the SHA-256 hashes recorded in
 * the manifest's `snapshots.file_hashes` / `untracked.file_hashes` records.
 *
 * Locked plan calls this out: "Restore verifies final hashes against the
 * manifest's `snapshots.file_hashes`. Mismatches abort with a structured
 * diff." This is the structured diff. CLI's `--json` output (M D) renders
 * the `mismatches` array verbatim; human output renders one line per
 * mismatch.
 *
 * The verification step is what proves the byte-identical restore promise
 * — without it, a silent partial-restore could produce a working tree that
 * looks plausible but isn't actually what the checkpoint captured.
 *
 * `cause` is reserved for future use (e.g., wrapping an underlying I/O
 * failure that prevented hashing).
 */
export class RestoreVerificationError extends Error {
  readonly mismatches: readonly RestoreHashMismatch[];

  constructor(mismatches: readonly RestoreHashMismatch[], cause?: unknown) {
    super(`restore verification failed for ${mismatches.length} path(s)`, { cause });
    this.name = "RestoreVerificationError";
    this.mismatches = mismatches;
  }
}

/**
 * One per-path conflict surfaced by `RestoreExtractionConflictError`.
 *
 * `manifestPath` is the path the untracked tarball would write (a key in
 * `manifest.untracked.file_hashes`). `conflictingPath` is the path on disk
 * that's blocking — often equal to `manifestPath`, but can be a PREFIX of
 * it when an intermediate path component is the wrong type (e.g., a
 * regular file at `a` blocks creating `a/b.txt`). `reason` is a human-
 * readable description of why the cleanup couldn't auto-resolve the
 * conflict.
 */
export type RestoreExtractionConflict = {
  readonly manifestPath: string;
  readonly conflictingPath: string;
  readonly reason: string;
};

/**
 * Thrown by `restoreCheckpoint()` when, after `clearExtractionPathConflicts`
 * has auto-resolved every safely-clearable blocker (empty directory at a
 * final path → `rmdir`; symlink at a final path → `unlink`; symlink at
 * an intermediate path component → `unlink`), one or more paths in the
 * working tree still prevent the untracked tarball from extracting
 * cleanly. Typical residual examples:
 *   - A non-empty directory at a manifest file path. The cleanup pass
 *     uses `rmdir` (NOT `rm -r`) precisely so non-empty dirs surface
 *     here as conflicts rather than getting their contents destroyed.
 *   - A regular file at an intermediate path component of a manifest
 *     path (e.g., file `a` blocking `a/b.txt`'s parent directory) —
 *     deleting it would lose user data.
 *   - A non-regular entry (FIFO, socket, block- or character-device) at
 *     a final or intermediate path.
 *
 * Distinct from `CheckpointCorruptError`: the checkpoint itself is valid
 * — this is a CURRENT WORKING TREE state conflict that the user must
 * resolve manually before re-running restore.
 *
 * **Timing (locked, post-mutation but pre-extract):** thrown AFTER
 * `git reset --hard HEAD`, AFTER patch replay (both staged and
 * unstaged), AFTER `deleteUncapturedUntracked`, AFTER
 * `clearExtractionPathConflicts`'s auto-clear pass — and BEFORE
 * `tar.extract` runs. The extraction itself never partial-runs, but the
 * working tree IS in a "patches replayed, untracked half-restored"
 * state when this fires: the tracked side is fully restored, the
 * uncaptured untracked files are gone, the safely-clearable blockers
 * have been removed, and only the untracked tarball extraction remains
 * undone. The user must resolve the residual conflicts and re-run; the
 * partial state is preserved on disk so they can inspect it.
 *
 * (Earlier M B drafts of `restoreCheckpoint` ran a stricter
 * pre-mutation conflict check that would refuse before any mutation.
 * That version turned legitimate restores into false failures: a
 * directory at a manifest file path containing only uncaptured
 * untracked content would be flagged as a conflict pre-mutation, even
 * though the delete pass would have made it empty and rmdir-able. The
 * locked design moves cleanup post-delete-pass, which means the
 * mutation has begun by the time conflicts are surfaced.)
 *
 * All conflicts are collected into the `conflicts` array — the user
 * sees the full list in one structured payload, same pattern as
 * `RestoreVerificationError`. Conflicts are added in
 * (depth-ascending, then lexicographic) order by `clearExtractionPathConflicts`,
 * which is naturally deterministic for test/CLI rendering.
 *
 * `cause` is reserved for future use.
 */
export class RestoreExtractionConflictError extends Error {
  readonly conflicts: readonly RestoreExtractionConflict[];

  constructor(conflicts: readonly RestoreExtractionConflict[], cause?: unknown) {
    super(`restore aborted: ${conflicts.length} extraction conflict(s) in working tree`, { cause });
    this.name = "RestoreExtractionConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * One per-path issue surfaced by `RestoreTrackedDirtyParityError`.
 *
 * `path` is repo-relative POSIX (matches the manifest's path conventions
 * and the rest of the package's path fields).
 *
 * `kind` distinguishes the two failure flavors:
 *   - "unexpected_dirty": the path is dirty in the post-restore working
 *     tree but is NOT in `manifest.snapshots.tracked_dirty_paths`. Most
 *     likely caused by a tampered staged.patch or unstaged.patch that
 *     introduced a hunk affecting a previously-clean tracked file.
 *   - "missing_dirty": the path IS in `manifest.snapshots.tracked_dirty_paths`
 *     (was dirty at checkpoint time) but is NOT dirty in the post-restore
 *     working tree. Either the patch failed to fully replay the captured
 *     changes, or hunks were dropped from the patch artifacts.
 *
 * The two flavors get distinct values so callers (M D's rollback CLI, JSON
 * consumers) can render differentiated guidance — extra-dirty is a
 * tampering signal worth investigating, missing-dirty points at patch-
 * replay drift.
 *
 * The full tracked-dirty surface is verified by `RestoreTrackedDirtyParityError`,
 * including tracked deletions, symlink changes, mode-only changes, and any
 * other entry git considers dirty (anything `git diff --name-only` would
 * report). See that error's docstring for the full verification contract.
 */
export type RestoreTrackedDirtyParityIssue = {
  readonly path: string;
  readonly kind: "unexpected_dirty" | "missing_dirty";
};

/**
 * Thrown by `restoreCheckpoint()` when, after patch replay and untracked
 * archive extraction, the set of currently-dirty tracked paths in the
 * working tree does NOT exactly match
 * `manifest.snapshots.tracked_dirty_paths`.
 *
 * **Scope: full set parity.** The manifest's `tracked_dirty_paths` is the
 * verbatim output of `gitListTrackedDirty` at capture time — the FULL set
 * of dirty tracked paths INCLUDING tracked deletions, symlink changes,
 * mode-only changes, and regular-file content changes. The post-restore
 * actual side is the verbatim output of `gitListTrackedDirty` right now.
 * Comparison is raw set equality with no narrowing, no regular-file
 * filtering, no `rollback.exclude` filtering (per restore.ts's narrowed
 * D3 — `rollback.exclude` is enforced on the untracked surface only).
 *
 * Why this exists: tracked-side restore is patch-driven (patches handle
 * the index + working tree, NOT the tracked-dirty tarball). Without an
 * exact set-parity check on the tracked-dirty paths, a tampered
 * staged.patch or unstaged.patch could:
 *   - Smuggle an unauthorized tracked deletion. Deletions don't appear in
 *     `snapshots.file_hashes` (no bytes to hash), so a hash-only check
 *     would never inspect them. They DO appear in `tracked_dirty_paths`,
 *     and the parity check catches them.
 *   - Modify a previously-clean tracked file. The extra path isn't in
 *     `snapshots.file_hashes` (was clean at checkpoint) and isn't in
 *     `untracked.file_hashes` (it's tracked), so hash verification would
 *     never inspect it. The parity check catches it.
 *   - Drop hunks for paths that should be dirty post-restore. Hash
 *     verification would catch this for the dropped path's bytes, but a
 *     dedicated parity check fails earlier and with a clearer signal
 *     (set-level "wrong PATHS are dirty" beats byte-level "path X has
 *     wrong content").
 *
 * Distinct from `RestoreVerificationError`: that one is content-level
 * (file exists with wrong bytes / type). This one is set-level (wrong
 * paths are dirty). Both are collected-and-throw-once for full structured
 * diagnostics.
 *
 * Per restore.ts's invariant #3, the parity check runs BEFORE hash
 * verification, so this error precedes `RestoreVerificationError` when
 * both would fail.
 *
 * `cause` is reserved for future use.
 */
export class RestoreTrackedDirtyParityError extends Error {
  readonly issues: readonly RestoreTrackedDirtyParityIssue[];

  constructor(issues: readonly RestoreTrackedDirtyParityIssue[], cause?: unknown) {
    super(
      `restore tracked-dirty parity check failed: ${issues.length} path(s) differ from checkpoint`,
      { cause },
    );
    this.name = "RestoreTrackedDirtyParityError";
    this.issues = issues;
  }
}
