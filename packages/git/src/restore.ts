// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// restoreCheckpoint — internal byte-identical-restore helper (D7).
//
// **M B scope (locked):** this function is INTERNAL, used only by M B's
// fixture tests to prove round-trip correctness against the rollback test
// matrix. The user-facing `viberevert rollback` CLI command is M D scope —
// including --dry-run, --force, typed-confirmation, the emergency
// pre-rollback checkpoint, and all UX wording. Do NOT export this function
// from the package barrel; consumers reach for it via internal-only paths
// during M B testing.
//
// =============================================================================
// Trust-critical invariants
// =============================================================================
//
// 1. **Non-mutating trust validation pre-mutation; safe extraction-path
//    cleanup post-mutation.** Every check that can be performed without
//    touching the working tree (HEAD verification, archive shape parsing,
//    exclude-pattern drift detection) runs BEFORE any mutation. A failure
//    in any of those checks leaves the working tree EXACTLY as it was
//    found.
//
//    The one carve-out from "validate before mutate":
//    **extraction-path cleanup runs AFTER patch replay +
//    uncaptured-untracked deletion, immediately before tarball
//    extraction.** Some blockers only become safely removable after the
//    delete pass — e.g., a directory at a manifest file path becomes
//    empty (and rmdir-able) once its uncaptured contents are gone.
//    Refusing pre-mutation would turn a valid restore into a false
//    failure.
//
//    The cleanup helper (`clearExtractionPathConflicts`) auto-resolves a
//    narrow set of safe blockers:
//      - empty directory at a final file path → `rmdir` (NOT `rm -r`,
//        so non-empty dirs surface as conflicts rather than getting
//        their contents destroyed).
//      - symlink at a final file path → `unlink`.
//      - symlink at an intermediate path component → `unlink` (clears
//        the cross-tree hijack vector before tar.extract creates the
//        real directory at this path).
//    Everything else is collected as a structured conflict:
//      - non-empty directory at a final file path,
//      - regular file at an intermediate path component,
//      - FIFO / socket / block- or character-device anywhere relevant.
//    Conflicts throw `RestoreExtractionConflictError` AFTER the mutation
//    phase has run. The working tree is in a "patches replayed,
//    untracked half-restored" state at that point, and the user must
//    resolve manually before re-running restore.
//
// 2. **Read-once-use-bytes-thereafter.** Both archives and both patches are
//    read into in-memory Buffers ONCE, before any mutation. All subsequent
//    operations (preflight, extract, hash compare, parity check) operate on
//    those Buffers — never re-read from disk. This kills the TOCTOU window
//    where an attacker could swap the file between preflight and extract.
//    The path strings inside the manifest are validated by `loadCheckpoint`'s
//    schema check; the bytes inside the archives are validated here.
//
//    Stream-feeding rule: `Readable.from([buf])` (NOT `Readable.from(buf)`).
//    A bare Buffer is iterable as bytes — passing it without the array
//    wrapper makes `Readable.from` yield individual bytes, fragmenting the
//    archive into 1-byte chunks. Wrapping in `[buf]` yields the whole
//    Buffer as a single chunk, preserving binary-tar integrity.
//
//    Tar streaming rule: archives are gzipped (`.tar.gz`), so we MUST use
//    `tar.list({ onentry })` and `tar.extract({ cwd, filter })` — the
//    documented stream-based named-exports — which auto-detect and
//    decompress gzip. The lower-level `new tar.Parser()` / `new tar.Unpack()`
//    constructors do NOT auto-decompress and would silently consume gzip
//    bytes as if they were tar headers (catastrophic on a tampered archive).
//
// 3. **Symmetric set-parity (closes the tracked-deletion soundness hole).**
//    After patch replay, the tracked-dirty path set in the working tree MUST
//    exactly equal `manifest.snapshots.tracked_dirty_paths` — the FULL set
//    captured at checkpoint time (tracked deletions, symlink changes,
//    mode-only changes, regular-file changes — all of them). Without this
//    check, a tampered staged.patch or unstaged.patch could:
//      - Smuggle an unauthorized tracked deletion (wouldn't appear in
//        `file_hashes`, so the hash-verify step would never inspect it).
//      - Modify a previously-clean tracked file (same — extra dirty path
//        invisible to hash-verify).
//      - Drop hunks for paths that should be dirty post-restore (missing
//        from the post-replay dirty set).
//    The parity check uses raw equality — no lstat-narrowing, no regular-
//    file subset filtering. The manifest's `tracked_dirty_paths` is by
//    construction the verbatim output of `gitListTrackedDirty` at capture
//    time, and we compare it to the verbatim output at restore time.
//
//    Parity check runs BEFORE hash verification. Set-level mismatch ("wrong
//    PATHS are dirty") is a higher-priority signal than byte-level mismatch
//    ("right paths but wrong BYTES"); failing parity early gives a clearer
//    diagnostic AND avoids hashing files that are about to be diagnosed as
//    tampered.
//
// 4. **Symmetric exclusion on the UNTRACKED surface only (D3, narrowed).**
//    Paths matched by `rollbackExcludePatterns` are NEVER touched by
//    restore on the UNTRACKED side: not enumerated for deletion, not
//    asserted by extraction-path cleanup, not overwritten by tarball
//    extraction. This matches `snapshots.ts`'s capture-side untracked
//    exclusion: an untracked file matched by `rollback.exclude` is
//    invisible to vibe-revert's safety net.
//
//    To keep the contract honest, restore enforces a **pre-mutation
//    precondition** (`assertNoExcludeDrift`, M B Step 3e — bidirectional
//    drift detection) that compares capture-time `rollback.exclude`
//    policy (persisted in `manifest.untracked.exclude_patterns`)
//    against restore-time policy (`opts.rollbackExcludePatterns`).
//    Any drift in either direction throws `RestoreExcludeDriftError`
//    BEFORE any mutation, with a structured 5-field payload:
//      - **Pattern-set drift:** the SET of patterns differs between
//        capture and restore — catches both tightening (patterns added
//        since checkpoint, populated in `tighteningPatterns`) and
//        loosening (patterns removed, populated in
//        `looseningPatterns`). Even when no captured manifest path is
//        currently affected, a policy mismatch is itself a refusal-
//        worthy signal that the user's notion of what's safe to touch
//        has drifted between the two events.
//      - **Path-vs-matcher drift (tightening consequences):** manifest
//        untracked paths that match the current restore-time matcher
//        (populated in `tighteningPaths`). Names exactly which captured
//        files would be silently skipped or overwritten if restore
//        proceeded. Most user-actionable signal.
//    Both checks fire from the same throw. Silently filtering excluded
//    paths out of extraction would lose captured files (breaks byte-
//    identical), silently extracting over excluded paths would violate
//    the never-touch contract, and silently respecting capture-time
//    policy when it differs from current would make the "current
//    `.viberevert.yml` is the source of truth" mental model unreliable.
//    Hard refusal beats all three.
//
//    **NOT applied to the tracked surface.** Tracked-dirty paths are fully
//    visible to vibe-revert regardless of `rollback.exclude`. Patch replay
//    (`git apply`) replays the full captured diff including any path that
//    happens to match a `rollback.exclude` pattern, and the parity check
//    asserts on the full `gitListTrackedDirty` output without filtering.
//    This is consistent with `snapshots.ts.snapshotTrackedDirty`, which
//    does not accept `rollbackExcludePatterns` and captures every dirty
//    tracked path. The typical use case for `rollback.exclude`
//    (`node_modules/**`, `dist/**`) is gitignored content that lives on
//    the untracked surface; tracked-dirty exclusion is not in M B scope.
//
// 5. **Strict tarball entry validation.** Both archives are validated entry-
//    by-entry against:
//      - Canonical relative POSIX path (no `..`, no absolute, no `\\`).
//        This is the same predicate as `isSafeStoredRelativePath` from
//        `@viberevert/session-format`.
//      - Regular-file entry type only. Symlinks, hardlinks, directories,
//        block/char devices, FIFOs are rejected. Symlink tampering inside a
//        tarball is a known traversal/hijack vector and is the reason
//        `snapshots.ts` only captures regular files in the first place.
//      - Exact set parity with `file_hashes` keys. Both archives are
//        required to contain EXACTLY the paths the manifest says they
//        contain — extras or missing entries are corruption (a truncated
//        archive is not "still partially trustworthy").
//
// =============================================================================
// What does NOT happen in M B (deferred to later milestones)
// =============================================================================
//
//   - The tracked-dirty tarball is NOT extracted by restore. Tracked-side
//     restoration is patch-driven (D-restore-2): `git reset --hard HEAD`
//     wipes the tracked working tree and index, then the captured staged +
//     unstaged patches replay the dirty state. The tracked-dirty tarball's
//     bytes are evidence that the captured state was hashable; verification
//     is done against `manifest.snapshots.file_hashes`, not the archive
//     contents directly. A future milestone may use the archive as a
//     fallback when patches fail to replay.
//
//   - The tracked-dirty tarball IS still validated for shape (exact entry-
//     set parity with `file_hashes` keys, regular-file entries, safe paths).
//     Pure tampering detection — even though we don't extract it, a
//     manifest declaring a tampered archive is itself suspicious.
//
//   - mtime / permissions metadata is NOT asserted by hash verification.
//     Acceptance is byte-content identical only. (Documented in the M B
//     plan's Risks section.)

import type { Stats } from "node:fs";
import { lstat, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type Manifest,
  isSafeStoredRelativePath,
  normalizeStringArray,
} from "@viberevert/session-format";
import picomatch from "picomatch";
import * as tar from "tar";
import { loadCheckpoint } from "./checkpoint.js";
import {
  type RestoreExtractionConflict,
  type RestoreHashMismatch,
  type RestoreTrackedDirtyParityIssue,
  CheckpointCorruptError,
  RestoreExcludeDriftError,
  RestoreExtractionConflictError,
  RestoreHeadMismatchError,
  RestoreTrackedDirtyParityError,
  RestoreVerificationError,
} from "./errors.js";
import {
  getHeadSha,
  gitApply,
  gitApplyWithIndex,
  gitListTrackedDirty,
  gitListUntracked,
  gitResetHardHead,
} from "./git-cli.js";
import { sha256File } from "./hashes.js";

// =============================================================================
// Public API
// =============================================================================

/**
 * Options for `restoreCheckpoint`. Mirrors the fields the CLI orchestration
 * layer (M D) will resolve from `.viberevert.yml` and pass through.
 *
 * - `repoRoot`: absolute path to the git repo root.
 * - `rollbackExcludePatterns`: the SAME pattern list passed to
 *   `snapshotUntracked` at capture time (D3 symmetric exclusion, narrowed
 *   to the untracked surface only — see file header invariant #4).
 *   Untracked paths matched here are never enumerated for deletion, never
 *   touched by extraction-path cleanup, never overwritten by extraction.
 *   **Tracked-dirty paths are NOT filtered by these patterns**; patch
 *   replay and the tracked-dirty parity check operate on the full
 *   tracked-dirty surface regardless of this list.
 *
 *   The precondition `assertNoExcludeDrift` (M B Step 3e) compares
 *   capture-time patterns (persisted in
 *   `manifest.untracked.exclude_patterns`) against the patterns supplied
 *   here, and throws `RestoreExcludeDriftError` on any drift in either
 *   direction (tightening or loosening) plus a path-vs-matcher arm
 *   that populates `tighteningPaths` when drift would immediately damage
 *   this specific manifest. See file header invariant #4 for the full
 *   contract.
 */
export type RestoreCheckpointOptions = {
  readonly repoRoot: string;
  readonly rollbackExcludePatterns: readonly string[];
};

/**
 * Restore the working tree + index to the state captured by the checkpoint
 * at `checkpointDir`. Internal M B helper (per D7); exposed for fixture
 * tests, NOT for end-user CLI use.
 *
 * Throws (all are typed errors from `./errors.js`):
 *   - `CheckpointNotFoundError` / `CheckpointCorruptError`: from
 *     `loadCheckpoint`. The error message identifies the failing artifact.
 *   - `RestoreHeadMismatchError`: HEAD does not match
 *     `manifest.git.head_sha`. Restore cannot proceed safely on a different
 *     baseline; the captured patches were taken relative to the checkpoint's
 *     HEAD and would produce undefined results otherwise.
 *   - `RestoreExcludeDriftError`: capture-time and restore-time
 *     `rollback.exclude` policies have drifted (in either direction —
 *     pattern-set comparison covers tightening AND loosening; path-vs-
 *     matcher comparison populates `tighteningPaths` when drift would
 *     immediately affect this manifest). Restore refuses BEFORE any
 *     mutation. See the error class's docstring for the structured
 *     5-field payload.
 *   - `RestoreExtractionConflictError`: AFTER patch replay +
 *     uncaptured-untracked deletion, the working tree still has
 *     unresolvable blockers at extraction paths (non-empty directory at a
 *     final path, regular file at an intermediate component, or
 *     FIFO/socket/device anywhere relevant). Safe blockers (empty dir at
 *     final path, symlink at final path, symlink at intermediate
 *     component) were already auto-cleared by
 *     `clearExtractionPathConflicts`. The working tree is in a "patches
 *     replayed, untracked half-restored" state when this fires; the user
 *     must resolve manually before re-running.
 *   - `RestoreTrackedDirtyParityError`: post-restore tracked-dirty path
 *     set does not exactly equal `manifest.snapshots.tracked_dirty_paths`.
 *     Issues are split into `unexpected_dirty` (the patch introduced a
 *     dirty path NOT captured at checkpoint) and `missing_dirty` (a
 *     captured dirty path is no longer dirty post-restore). Thrown AFTER
 *     mutation and BEFORE hash verification (set-level errors precede
 *     byte-level errors per invariant #3).
 *   - `RestoreVerificationError`: post-restore hash check found one or more
 *     paths whose on-disk SHA-256 does not match the manifest's
 *     `file_hashes` entry. Thrown AFTER mutation and AFTER parity, so it
 *     surfaces only if the path-set is correct but bytes are not.
 *
 * Order of guarantees:
 *   1. Non-mutating trust validation first (HEAD, archive shape, exclude
 *      drift) — failures here leave the working tree untouched.
 *   2. Mutation phase: reset → patches → delete uncaptured untracked →
 *      auto-clear safe extraction-path blockers → THROW
 *      `RestoreExtractionConflictError` if unresolvable blockers remain
 *      (working tree IS already in the patches-replayed,
 *      untracked-half-restored state at this point) → tarball extraction.
 *   3. Post-mutation set-parity, THEN hash verification. If any step here
 *      fails, the working tree IS in the restore-attempted state — the
 *      caller decides whether to retry, abandon, or do further recovery.
 *      Restore does NOT try to roll BACK from a verification failure;
 *      that's a separate emergency-recovery concern and an actively
 *      dangerous design space (a buggy auto-rollback could destroy the
 *      restore attempt's evidence).
 */
export async function restoreCheckpoint(
  checkpointDir: string,
  opts: RestoreCheckpointOptions,
): Promise<void> {
  const manifest = await loadCheckpoint(checkpointDir);

  // ===========================================================================
  // Non-mutating trust validation phase
  // ===========================================================================

  // 1. HEAD must match. Restore cannot safely operate on a different commit;
  //    the captured patches are relative to the checkpoint's HEAD. Compare
  //    against the manifest BEFORE reading any archives — fail cheap.
  const actualHeadSha = await getHeadSha(opts.repoRoot);
  if (actualHeadSha !== manifest.git.head_sha) {
    throw new RestoreHeadMismatchError(manifest.git.head_sha, actualHeadSha);
  }

  // 2. Read all artifact bytes ONCE, into in-memory Buffers. From here on,
  //    every operation that needs archive/patch contents reads the Buffer
  //    rather than re-reading the file. Read-once invariant; kills TOCTOU.
  const trackedArchiveAbs = join(checkpointDir, manifest.snapshots.tracked_dirty_archive_path);
  const untrackedArchiveAbs = join(checkpointDir, manifest.untracked.archive_path);
  const stagedPatchAbs = join(checkpointDir, manifest.diffs.staged_patch_path);
  const unstagedPatchAbs = join(checkpointDir, manifest.diffs.unstaged_patch_path);

  let trackedArchiveBuf: Buffer;
  let untrackedArchiveBuf: Buffer;
  let stagedPatch: Buffer;
  let unstagedPatch: Buffer;
  try {
    [trackedArchiveBuf, untrackedArchiveBuf, stagedPatch, unstagedPatch] = await Promise.all([
      readFile(trackedArchiveAbs),
      readFile(untrackedArchiveAbs),
      readFile(stagedPatchAbs),
      readFile(unstagedPatchAbs),
    ]);
  } catch (err) {
    // loadCheckpoint already lstat'd these paths, but we re-surface a read
    // failure as CheckpointCorruptError for symmetry: an artifact that
    // existed at lstat time but is unreadable now is corrupt-equivalent.
    throw new CheckpointCorruptError(
      checkpointDir,
      `failed to read referenced artifact: ${(err as Error).message}`,
      err,
    );
  }

  // 3. Validate archive shape. BOTH archives must contain only regular-file
  //    entries with safe canonical paths AND have entry-sets that EXACTLY
  //    equal their respective `file_hashes` keys. A truncated archive
  //    missing entries is corruption, not "partially trustworthy".
  await assertArchiveEntries(
    checkpointDir,
    untrackedArchiveBuf,
    "untracked",
    Object.keys(manifest.untracked.file_hashes),
  );
  await assertArchiveEntries(
    checkpointDir,
    trackedArchiveBuf,
    "tracked-dirty",
    Object.keys(manifest.snapshots.file_hashes),
  );

  // 4. Exclude-pattern precondition (D3 narrowed, file header invariant #4).
  //    Normalize the current restore-time patterns once (via
  //    normalizeStringArray — same shape as capture-time persisted in
  //    manifest.untracked.exclude_patterns). All downstream uses of the
  //    exclude policy (this precondition, deleteUncapturedUntracked,
  //    clearExtractionPathConflicts) consume the normalized form so
  //    behavior stays consistent with the captured contract — a user
  //    pattern like "  dist/**  " (stray whitespace) becomes "dist/**"
  //    here AND was "dist/**" at capture time, so matching is symmetric.
  //
  //    The precondition itself (assertNoExcludeDrift, M B Step 3e) does
  //    bidirectional drift detection between capture-time policy
  //    (manifest.untracked.exclude_patterns) and restore-time policy.
  //    Throws RestoreExcludeDriftError on any drift in either direction
  //    (tightening = patterns added since checkpoint, loosening =
  //    patterns removed) plus a path-vs-matcher arm that populates
  //    tighteningPaths when drift would immediately damage this manifest.
  const normalizedExcludePatterns = normalizeStringArray([
    ...opts.rollbackExcludePatterns,
  ]);
  const isExcluded = compileExcludeMatcher(normalizedExcludePatterns);
  const expectedUntrackedSet = Object.keys(manifest.untracked.file_hashes);
  assertNoExcludeDrift(
    manifest.untracked.exclude_patterns,
    normalizedExcludePatterns,
    expectedUntrackedSet,
  );

  // ===========================================================================
  // Mutation phase
  // ===========================================================================

  // 5. Wipe tracked-side state to a clean HEAD. Discards ALL tracked
  //    changes (staged AND unstaged) and clears the index. Does NOT touch
  //    untracked files — those are handled separately below.
  await gitResetHardHead(opts.repoRoot);

  // 6. Replay the captured patches. Order matters:
  //    - staged.patch FIRST with --index: re-stages exactly what was staged
  //      at checkpoint time. Both index AND working tree advance to the
  //      "post-staged" state.
  //    - unstaged.patch SECOND without --index: applies only to the working
  //      tree, layering the unstaged delta on top of the staged-and-applied
  //      state. Index stays as the captured staged content; working tree
  //      now matches the captured working tree exactly.
  //    Empty patch buffers are no-ops in git apply, so a clean-tracked-tree
  //    checkpoint replays correctly without special-casing.
  if (stagedPatch.length > 0) {
    await gitApplyWithIndex(opts.repoRoot, stagedPatch);
  }
  if (unstagedPatch.length > 0) {
    await gitApply(opts.repoRoot, unstagedPatch);
  }

  // 7. Untracked side: the current working tree may have files created
  //    during the session that aren't in the manifest. Enumerate
  //    untracked-not-excluded paths NOT in the captured set and remove
  //    them. Files in the manifest are left alone — `extractUntrackedTarball`
  //    will overwrite them with the captured bytes after path cleanup.
  await deleteUncapturedUntracked(
    opts.repoRoot,
    new Set(expectedUntrackedSet),
    isExcluded,
  );

  // 8. Extraction-path cleanup. AFTER the delete pass: some blockers that
  //    looked unresolvable pre-mutation are now safely cleanable (e.g., a
  //    directory at a manifest file path that contained only uncaptured
  //    untracked content is now empty and rmdir-able). The helper
  //    auto-resolves the safe set (empty dir at final path, symlink at
  //    final path, symlink at intermediate component) and collects the
  //    rest as conflicts. If any unresolvable blockers remain, throw
  //    BEFORE extraction so tar.extract never runs against a hostile
  //    state. The working tree is already in a patches-replayed state at
  //    this point — the throw timing is post-mutation but
  //    pre-extract-mutation.
  const conflicts = await clearExtractionPathConflicts(
    opts.repoRoot,
    expectedUntrackedSet,
    isExcluded,
  );
  if (conflicts.length > 0) {
    throw new RestoreExtractionConflictError(conflicts);
  }

  // 9. Extract the untracked tarball from the in-memory Buffer. Strict
  //    filters reject non-regular entries (defense in depth — already
  //    asserted in archive validation, but tar.extract has its own filter
  //    pass and we keep both layers in agreement).
  //
  //    Skipped when the captured untracked set is empty — there's
  //    nothing to extract, and tar.extract on a minimal empty archive
  //    (snapshots.ts writes 2x 512-byte zero blocks gzipped, the
  //    standard tar EOF marker) fails with TAR_BAD_ARCHIVE on
  //    node-tar v7.x. assertArchiveEntries above already verified that
  //    an empty archive matches empty file_hashes (set parity), so
  //    skipping extraction is sound — the buffer is provably empty by
  //    the time we get here when expectedUntrackedSet is empty.
  if (expectedUntrackedSet.length > 0) {
    await extractUntrackedTarball(untrackedArchiveBuf, opts.repoRoot);
  }

  // ===========================================================================
  // Post-mutation verification (parity FIRST, hashes SECOND)
  // ===========================================================================

  // 10. Raw set-parity verification (closes the tracked-deletion soundness
  //     hole). Compare the post-restore working tree's `gitListTrackedDirty`
  //     output against `manifest.snapshots.tracked_dirty_paths` VERBATIM.
  //     No lstat narrowing, no regular-file filtering, no `rollback.exclude`
  //     filtering — full set equality. Set-level signal precedes byte-level.
  await verifyTrackedDirtyParity(opts.repoRoot, manifest);

  // 11. Hash-verify every captured file. Both `manifest.snapshots.file_hashes`
  //     (tracked-dirty regular-file subset) and `manifest.untracked.file_hashes`
  //     (untracked subset) are checked. Each on-disk SHA-256 must match.
  //     Collected per-path mismatches are thrown as a single structured
  //     error (matches RestoreVerificationError's contract).
  const mismatches: RestoreHashMismatch[] = [];
  await collectHashMismatches(opts.repoRoot, manifest.snapshots.file_hashes, mismatches);
  await collectHashMismatches(opts.repoRoot, manifest.untracked.file_hashes, mismatches);
  if (mismatches.length > 0) {
    throw new RestoreVerificationError(mismatches);
  }
}

// =============================================================================
// Internal helpers — non-mutating trust validation
// =============================================================================

/**
 * Compile an excluder function from `rollback.exclude` patterns. Identical
 * shape to snapshots.ts's helper (intentional duplication — both files own
 * their independent capture/restore policy enforcement; sharing a helper
 * would couple them in a way that obscures the symmetry).
 *
 * Empty list → matcher that excludes nothing. `nonegate: true` disables `!`
 * re-include semantics, matching the M B `rollback.exclude` contract.
 *
 * Used ONLY on the untracked surface (D3 narrowed — see file header
 * invariant #4).
 */
function compileExcludeMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matcher = picomatch(patterns as string[], { nonegate: true });
  return (path: string) => matcher(path);
}

/**
 * Pre-mutation precondition (M B Step 3e — bidirectional drift detection):
 * compares the manifest's captured `rollback.exclude` patterns against
 * the current restore-time patterns AND checks whether the current
 * matcher hits any captured manifest path. Throws
 * `RestoreExcludeDriftError` with the full 5-field structured payload
 * if either check finds drift. Implements file header invariant #4.
 *
 * **Both pattern lists are normalized inside this helper** (via
 * `normalizeStringArray` from session-format) before comparison —
 * defense-in-depth: producers SHOULD pre-normalize (`checkpoint.ts`
 * does at capture time; `restoreCheckpoint`'s body does at the call
 * site), but the helper canonicalizes both sides so hand-edited
 * manifests, recovery flows, future non-checkpoint producers, and
 * direct test callers all get a sound comparison without caller-side
 * preconditions. Idempotent on already-normalized input.
 *
 * The unordered-deny-list assumption that makes set comparison sound
 * (sort + dedup are lossless transformations) is documented load-
 * bearingly in `@viberevert/session-format`'s `schemas.ts > Manifest >
 * untracked.exclude_patterns` section.
 *
 * Drift surfaces as a SINGLE throw carrying all five fields:
 *   - `capturedPatterns` — normalized manifest patterns
 *   - `currentPatterns` — normalized opts.rollbackExcludePatterns
 *   - `tighteningPatterns` — in current ∖ captured (newly added)
 *   - `looseningPatterns` — in captured ∖ current (newly removed)
 *   - `tighteningPaths` — manifest untracked paths matching the
 *     current matcher (the consequences of tightening drift on THIS
 *     specific manifest)
 * All arrays sorted ASCII-ascending (pattern arrays inherit their sort
 * from `normalizeStringArray`; `tighteningPaths` is sorted defensively
 * since `manifestUntrackedPaths` order is producer-dependent). Empty
 * arrays where the corresponding direction has no drift, never
 * undefined — predictable shape for JSON consumers.
 */
function assertNoExcludeDrift(
  capturedPatternsInput: readonly string[],
  currentPatternsInput: readonly string[],
  manifestUntrackedPaths: readonly string[],
): void {
  // Defensive normalization on both sides — see docstring. Idempotent
  // when callers have already normalized; sound when they haven't.
  const capturedPatterns = normalizeStringArray([...capturedPatternsInput]);
  const currentPatterns = normalizeStringArray([...currentPatternsInput]);

  const capturedSet = new Set(capturedPatterns);
  const currentSet = new Set(currentPatterns);

  // Pattern-set drift: symmetric difference between the two normalized
  // sets. Inherits sort order from the normalized inputs (filter is
  // order-preserving), so no additional .sort() needed.
  const tighteningPatterns = currentPatterns.filter((p) => !capturedSet.has(p));
  const looseningPatterns = capturedPatterns.filter((p) => !currentSet.has(p));

  // Path-vs-matcher drift: which manifest paths does the current matcher
  // hit? Build the matcher from the normalized current patterns so
  // matching is symmetric with how snapshotUntracked saw paths at
  // capture time (snapshotUntracked also matches against trimmed
  // patterns via the same picomatch + nonegate setup).
  const isExcluded = compileExcludeMatcher(currentPatterns);
  const tighteningPaths = manifestUntrackedPaths.filter(isExcluded).sort();

  if (
    tighteningPatterns.length === 0 &&
    looseningPatterns.length === 0 &&
    tighteningPaths.length === 0
  ) {
    return;
  }

  throw new RestoreExcludeDriftError({
    capturedPatterns,
    currentPatterns,
    tighteningPatterns,
    looseningPatterns,
    tighteningPaths,
  });
}

/**
 * List entries in a gzipped tarball Buffer, validate each entry's path and
 * type, and assert exact set parity against `expectedPaths`.
 *
 * Throws `CheckpointCorruptError` on:
 *   - Non-canonical path (fails `isSafeStoredRelativePath`).
 *   - Non-regular entry type (symlink, hardlink, directory, device, FIFO).
 *   - Duplicate entries (same path twice — tarballs we generate never have
 *     duplicates, so seeing one is a tampering signal).
 *   - Entry-set diverges from expected (extras present OR captured paths
 *     missing).
 *
 * Iterates the archive ONCE via `tar.list`'s stream form, which auto-
 * decompresses gzip. Entries are collected in the `onentry` callback (just
 * header info — entry bodies are auto-drained by node-tar's default
 * `noResume: false`); validation is performed synchronously after the
 * stream completes. Collect-then-validate is simpler than throwing from
 * inside the stream callback.
 *
 * Buffer is fed via `Readable.from([buf])` (NOT `Readable.from(buf)`) to
 * yield the entire Buffer as a single chunk — see file header invariant #2.
 */
async function assertArchiveEntries(
  checkpointDir: string,
  buf: Buffer,
  archiveLabel: "tracked-dirty" | "untracked",
  expectedPaths: readonly string[],
): Promise<void> {
  const seen: { path: string; type: string }[] = [];

  try {
    await pipeline(
      Readable.from([buf]),
      tar.list({
        onentry: (entry: tar.ReadEntry) => {
          seen.push({ path: entry.path, type: entry.type });
        },
      }),
    );
  } catch (err) {
    throw new CheckpointCorruptError(
      checkpointDir,
      `${archiveLabel} archive failed to parse: ${(err as Error).message}`,
      err,
    );
  }

  // Validate each entry synchronously.
  const seenPaths = new Set<string>();
  for (const { path, type } of seen) {
    if (!isSafeStoredRelativePath(path)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `${archiveLabel} archive contains non-canonical path: ${JSON.stringify(path)}`,
      );
    }
    if (type !== "File") {
      throw new CheckpointCorruptError(
        checkpointDir,
        `${archiveLabel} archive contains non-regular entry of type ${JSON.stringify(type)} at path: ${path}`,
      );
    }
    if (seenPaths.has(path)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `${archiveLabel} archive contains duplicate entry: ${path}`,
      );
    }
    seenPaths.add(path);
  }

  // Exact set parity in both directions.
  const fileHashesField = archiveLabel === "tracked-dirty" ? "snapshots" : "untracked";
  const expected = new Set(expectedPaths);
  for (const seenPath of seenPaths) {
    if (!expected.has(seenPath)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `${archiveLabel} archive contains entry NOT in manifest.${fileHashesField}.file_hashes: ${seenPath}`,
      );
    }
  }
  for (const expectedPath of expected) {
    if (!seenPaths.has(expectedPath)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `${archiveLabel} archive is missing manifest-declared entry: ${expectedPath}`,
      );
    }
  }
}

// =============================================================================
// Internal helpers — mutation
// =============================================================================

/**
 * Delete every untracked-not-excluded REGULAR FILE currently in the working
 * tree that is NOT in `capturedSet`. Files in `capturedSet` are left alone
 * — `extractUntrackedTarball` will overwrite them with captured bytes in
 * the next step. Excluded paths are left alone unconditionally (D3
 * narrowed).
 *
 * Symlink-strict per the M B regular-file-only policy: lstat each
 * candidate, skip on ENOENT (race with concurrent process), skip if not a
 * regular file (symlink, FIFO, socket, device — preserved). Only after
 * those guards pass do we `rm`.
 *
 * The `rm` call carries the SAME ENOENT skip guard as the `lstat` above
 * it: between `lstat` returning "regular file" and `rm` being called, a
 * concurrent process can delete the file. Treating that ENOENT as benign
 * (continue) is correct — the end state matches our intent (the file is
 * gone). Without this guard, a benign race would crash the entire restore.
 *
 * This matches the symmetric capture-side policy in
 * `snapshots.ts.filterRegularFiles`.
 */
async function deleteUncapturedUntracked(
  repoRoot: string,
  capturedSet: Set<string>,
  isExcluded: (path: string) => boolean,
): Promise<void> {
  const candidates = await gitListUntracked(repoRoot);
  for (const p of candidates) {
    if (isExcluded(p)) continue;
    if (capturedSet.has(p)) continue;
    const abs = join(repoRoot, p);
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (!st.isFile()) continue;
    try {
      await rm(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
}

/**
 * Walk `expectedPaths` (untracked paths the tarball will write) and every
 * ancestor directory component, auto-clearing safely-resolvable blockers
 * and collecting the rest as structured conflicts. Called AFTER patch
 * replay + uncaptured-untracked deletion (the delete pass may make
 * previously-blocked paths safely clearable — e.g., a directory at a
 * manifest file path that contained only uncaptured untracked content is
 * now empty and rmdir-able).
 *
 * **Auto-resolved (safe to clear, no data loss):**
 *   - Empty directory at a final file path → `rmdir` (NOT `rm -r`; if the
 *     dir is non-empty, `rmdir` fails and we surface the conflict instead
 *     of destroying contents).
 *   - Symlink at a final file path → `unlink` (snapshots.ts only captures
 *     regular files, so a symlink at a manifest path is always wrong;
 *     unlinking it clears the way for tar.extract to write the regular
 *     file).
 *   - Symlink at an intermediate path component → `unlink` (cross-tree
 *     hijack vector; clearing it lets tar.extract create the real
 *     directory at this path).
 *
 * **Collected as conflicts (cannot safely auto-resolve):**
 *   - Non-empty directory at a final file path (auto-resolution would
 *     mean recursive delete of user content — refused).
 *   - Regular file at an intermediate path component (deletion would
 *     destroy user data).
 *   - FIFO / socket / block- or character-device anywhere relevant
 *     (out-of-policy entries; not safe to assume removable).
 *
 * **Iteration order: ancestors before descendants** (paths sorted by
 * depth ascending). This matters because clearing a symlink ancestor
 * before lstat'ing its descendant prevents a hijack scenario where
 * lstat-of-descendant would follow a malicious intermediate symlink into
 * a different subtree. Conflicts are collected in (depth-then-lex) order
 * — naturally deterministic for test/CLI output without a separate sort.
 *
 * Untracked paths matched by `isExcluded` are skipped — restore won't
 * extract over them, so blockers there are not relevant (D3 narrowed). At
 * the call site, `assertNoManifestPathExcluded` has already guaranteed
 * none of `expectedPaths` matches `isExcluded`, so the skip is effectively
 * a no-op — kept for defense-in-depth + clarity.
 */
async function clearExtractionPathConflicts(
  repoRoot: string,
  expectedPaths: readonly string[],
  isExcluded: (path: string) => boolean,
): Promise<RestoreExtractionConflict[]> {
  // Collect every path we'd touch (final paths + ancestor dirs).
  const allPaths = new Set<string>();
  for (const p of expectedPaths) {
    if (isExcluded(p)) continue;
    allPaths.add(p);
    let parent = p;
    for (;;) {
      const slash = parent.lastIndexOf("/");
      if (slash <= 0) break;
      parent = parent.slice(0, slash);
      allPaths.add(parent);
    }
  }

  // Sort ancestors-before-descendants. Within the same depth, lexicographic
  // for determinism. Critical for the symlink-ancestor-clear ordering
  // described in the docstring.
  const ordered = [...allPaths].sort((a, b) => {
    const depthA = a.split("/").length;
    const depthB = b.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const expectedSet = new Set(expectedPaths);
  const conflicts: RestoreExtractionConflict[] = [];

  for (const rel of ordered) {
    const abs = join(repoRoot, rel);
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    const isFinalPath = expectedSet.has(rel);

    if (isFinalPath) {
      // Final paths: tar.extract will write a regular file here.
      if (st.isFile()) continue; // No conflict, will be overwritten.

      if (st.isDirectory()) {
        // Try rmdir (succeeds only if empty). Non-empty surfaces as
        // conflict — DO NOT recursive-delete here; that would lose
        // contents the user may want.
        try {
          await rmdir(abs);
          continue;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") continue; // Race; nothing to do.
          // Any other failure (ENOTEMPTY, EPERM, etc.) → treat as
          // unresolvable. Include the underlying code in the message so
          // the user can debug platform-specific issues.
          conflicts.push({
            manifestPath: rel,
            conflictingPath: rel,
            reason: `destination path exists as a directory that could not be removed (${code ?? "unknown error"}: ${(err as Error).message})`,
          });
          continue;
        }
      }

      if (st.isSymbolicLink()) {
        // Snapshots.ts only captures regular files — a symlink at a
        // manifest path is always wrong. Safe to unlink: removing a
        // symlink doesn't touch the symlink's target.
        try {
          await rm(abs);
          continue;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          conflicts.push({
            manifestPath: rel,
            conflictingPath: rel,
            reason: `destination path exists as a symlink that could not be removed (${(err as NodeJS.ErrnoException).code ?? "unknown error"}: ${(err as Error).message})`,
          });
          continue;
        }
      }

      // FIFO / socket / device at a final file path. Not safe to assume
      // removable — push conflict.
      conflicts.push({
        manifestPath: rel,
        conflictingPath: rel,
        reason: `destination path exists as a non-regular entry (${describeStat(st)})`,
      });
      continue;
    }

    // Intermediate path component: must be a real directory to allow
    // descent.
    if (st.isDirectory() && !st.isSymbolicLink()) continue; // OK.

    if (st.isSymbolicLink()) {
      // Symlink at an intermediate component is a cross-tree hijack
      // vector. Safe to unlink — tar.extract will then create the real
      // directory at this path.
      try {
        await rm(abs);
        continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        const blocked = expectedPaths.find((p) => p === rel || p.startsWith(`${rel}/`));
        conflicts.push({
          manifestPath: blocked ?? rel,
          conflictingPath: rel,
          reason: `intermediate path component is a symlink that could not be removed (${(err as NodeJS.ErrnoException).code ?? "unknown error"}: ${(err as Error).message})`,
        });
        continue;
      }
    }

    // Regular file, FIFO, socket, or device at an intermediate component.
    // Cannot safely auto-resolve — removing would destroy user data.
    const blocked = expectedPaths.find((p) => p === rel || p.startsWith(`${rel}/`));
    conflicts.push({
      manifestPath: blocked ?? rel,
      conflictingPath: rel,
      reason: `intermediate path component is a non-directory (${describeStat(st)})`,
    });
  }

  return conflicts;
}

function describeStat(st: Stats): string {
  if (st.isFile()) return "regular file";
  if (st.isDirectory()) return "directory";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFIFO()) return "FIFO";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice()) return "block device";
  if (st.isCharacterDevice()) return "character device";
  return "unknown filesystem entry";
}

/**
 * Extract a gzipped tarball Buffer into `cwd` (the repo root). Strict tar
 * filters reject anything that isn't a regular file with a safe path,
 * mirroring the preflight assertions. Runs from the in-memory Buffer; never
 * touches the on-disk archive after it was first read in the validate
 * phase.
 *
 * Uses `tar.extract` (the documented stream-based named export) which
 * auto-detects and decompresses gzip. Buffer fed via `Readable.from([buf])`
 * (single-chunk) per file header invariant #2.
 */
async function extractUntrackedTarball(buf: Buffer, repoRoot: string): Promise<void> {
  await pipeline(
    Readable.from([buf]),
    tar.extract({
      cwd: repoRoot,
      // Per-entry guard: refuse anything not a regular file with a safe
      // path. This duplicates the preflight assertion intentionally —
      // tar.extract has its own filter pass; keeping both in agreement is
      // belt-and-braces for trust-critical extraction.
      // tar v7's filter signature is `(path, ReadEntry | Stats)` — Stats is
      // for the create-side; extract always passes ReadEntry. Widen the
      // parameter type to satisfy the assignability check, then narrow via
      // the `"type" in entry` discriminator (fs.Stats has no `.type` field;
      // ReadEntry does).
      filter: (path: string, entry: tar.ReadEntry | Stats) =>
        "type" in entry && entry.type === "File" && isSafeStoredRelativePath(path),
      // Strip system-specific metadata on extraction too (mirrors capture-
      // side `portable: true`). Doesn't affect file contents.
      preservePaths: false,
    }),
  );
}

// =============================================================================
// Internal helpers — verification
// =============================================================================

/**
 * Compare post-restore tracked-dirty path set against
 * `manifest.snapshots.tracked_dirty_paths`. The two sets MUST be exactly
 * equal — this is the M B step-13 amendment that closes the tracked-
 * deletion soundness hole.
 *
 * Raw set comparison, no narrowing:
 *   - Manifest's `tracked_dirty_paths` is by construction the verbatim
 *     output of `gitListTrackedDirty` at capture time (snapshots.ts
 *     returns it as-is from `gitListTrackedDirty`, with normalizePathArray
 *     defense-in-depth at the persistence boundary in checkpoint.ts).
 *   - The post-restore actual set is the verbatim output of
 *     `gitListTrackedDirty` right now.
 *   - Comparing them apples-to-apples means raw set equality.
 *   - **No `rollback.exclude` filtering is applied to either side** (D3
 *     narrowed — file header invariant #4). Tracked-dirty paths are
 *     fully visible to vibe-revert regardless of `rollback.exclude`.
 *
 * Categorizes diffs into:
 *   - `unexpected_dirty`: in actual, not in manifest. Tampered patch
 *     introduced an unauthorized dirty path.
 *   - `missing_dirty`: in manifest, not in actual. Patch failed to replay
 *     a captured dirty state.
 *
 * Both flavors go into a single throw of `RestoreTrackedDirtyParityError`
 * with structured per-path issues — same collected-and-throw-once pattern
 * as `RestoreVerificationError`.
 */
async function verifyTrackedDirtyParity(repoRoot: string, manifest: Manifest): Promise<void> {
  const actual = await gitListTrackedDirty(repoRoot);
  const expected = manifest.snapshots.tracked_dirty_paths;
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  const issues: RestoreTrackedDirtyParityIssue[] = [];
  for (const p of actual) {
    if (!expectedSet.has(p)) {
      issues.push({ path: p, kind: "unexpected_dirty" });
    }
  }
  for (const p of expected) {
    if (!actualSet.has(p)) {
      issues.push({ path: p, kind: "missing_dirty" });
    }
  }
  if (issues.length > 0) {
    // Sort for deterministic error output. Group by kind first (unexpected
    // before missing — matches the order they were collected) then by path.
    issues.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "unexpected_dirty" ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    throw new RestoreTrackedDirtyParityError(issues);
  }
}

/**
 * Hash every entry in `fileHashes`, comparing on-disk SHA-256 against the
 * manifest-recorded hash. Append-only into `mismatches` — caller throws
 * after both tracked and untracked checks have been collected, so the user
 * sees the FULL diff on a single error rather than just the first failure.
 *
 * `null` actualSha256 means the file is missing or non-regular at
 * verification time. Three sources can produce that null:
 *   - `lstat` returns ENOENT (file absent at lstat time).
 *   - `lstat` succeeds but `!st.isFile()` (path exists but is a symlink,
 *     directory, FIFO, socket, device — any non-regular entry).
 *   - `sha256File` throws ENOENT (file vanished between the lstat and the
 *     streaming open — benign TOCTOU window). Without this defense the
 *     race would leak as a raw filesystem error, crashing the verification
 *     phase instead of producing a structured missing-file mismatch.
 *
 * Any non-ENOENT error from either `lstat` or `sha256File` propagates as a
 * real I/O failure (permission denied, EIO, etc.) — those are signals the
 * caller's environment is broken in a way restore can't paper over.
 *
 * Distinguishing "missing" (`null`) from "wrong content" (non-null) gives
 * the CLI (M D) a tighter message.
 */
async function collectHashMismatches(
  repoRoot: string,
  fileHashes: Readonly<Record<string, string>>,
  mismatches: RestoreHashMismatch[],
): Promise<void> {
  for (const [path, expectedSha256] of Object.entries(fileHashes)) {
    const abs = join(repoRoot, path);
    let actualSha256: string | null;
    try {
      const st = await lstat(abs);
      if (!st.isFile()) {
        actualSha256 = null;
      } else {
        try {
          actualSha256 = await sha256File(abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            actualSha256 = null;
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        actualSha256 = null;
      } else {
        throw err;
      }
    }
    if (actualSha256 !== expectedSha256) {
      mismatches.push({ path, expectedSha256, actualSha256 });
    }
  }
}
