// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// restoreCheckpoint + planRestoreCheckpoint — controlled package APIs for
// CLI rollback orchestration (D73, D77).
//
// **M B history:** restoreCheckpoint was introduced as an internal helper
// for M B fixture tests proving round-trip correctness against the rollback
// test matrix. The "do not export" rule was an M B-scope lock; M D
// promotes BOTH restoreCheckpoint AND the new planRestoreCheckpoint to
// controlled package APIs consumed by CLI rollback orchestration via
// @viberevert/git's barrel export.
//
// **M D scope (locked):** these are NOT general end-user APIs. They are
// package-bound restore primitives consumed only by CLI rollback
// orchestration, enforced by D77 architectural invariants. UX concerns
// (--apply, --force, typed-confirmation, emergency pre-rollback
// checkpoint, refusal copy, exit codes) all live in the CLI layer per
// D60-D75.
//
// **Trust-validation centralization (M D Step 3):** the non-mutating
// trust-validation pipeline (manifest load, manifest path-policy,
// archive shape, patch path-policy, HEAD comparison, exclude-drift)
// lives in `./restore-preflight.ts` so both the mutation path
// (restoreCheckpoint) and the dry-run path (planRestoreCheckpoint)
// consume the SAME validation logic. The `.viberevert/**` predicate +
// patch-header scanner live one layer deeper in
// `./restore-internal-path-policy.ts` — the single source of truth
// across BOTH the evidence side (preflight) and the mutation side
// (this file). See those modules' headers for throws-vs-info contract
// + normalization rationale.
//
// =============================================================================
// Trust-critical invariants
// =============================================================================
//
// 1. **Non-mutating trust validation pre-mutation; safe extraction-path
//    cleanup post-mutation.** All trust validation runs via
//    `loadRestorePreflight` (in restore-preflight.ts) BEFORE any
//    mutation. A failure there leaves the working tree EXACTLY as it
//    was found.
//
//    Preflight validates in this order: manifest → manifest path-policy
//    (`.viberevert/**` corruption check) → artifact buffers → archive
//    shape → patch path-policy → HEAD → exclude drift. Note: this
//    REVERSES M B's original "HEAD before archives, fail cheap" order.
//    The reason (per M D Step 3 lock): corrupt evidence is a hard
//    failure regardless of mode (no receipt, throw). HEAD mismatch is
//    a preflight signal that apply-with-force may proceed against.
//    Reporting "your HEAD differs" on a checkpoint whose archives are
//    actually corrupt would be misleading — the corruption is the real
//    story. See restore-preflight.ts's header for the full rationale.
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
//      - FIFO / socket / block- or character-device anywhere relevant,
//      - `.viberevert/**` paths (TRIPWIRE — see invariant #6 below).
//    Conflicts throw `RestoreExtractionConflictError` AFTER the mutation
//    phase has run. The working tree is in a "patches replayed,
//    untracked half-restored" state at that point, and the user must
//    resolve manually before re-running restore.
//
// 2. **Read-once-use-bytes-thereafter.** Archive + patch bytes are read
//    into in-memory Buffers ONCE by `loadRestorePreflight`, then carried
//    forward via `preflight.artifacts`. The mutation phase here (patch
//    replay, archive extraction) consumes the same Buffers — never
//    re-reads from disk. This kills the TOCTOU window where an attacker
//    could swap the file between preflight and extract.
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
//    Drift between capture-time policy
//    (`manifest.untracked.exclude_patterns`) and restore-time policy
//    (`opts.rollbackExcludePatterns`) is detected by
//    `loadRestorePreflight` and surfaced as `preflight.excludeDrift`.
//    `restoreCheckpoint` converts non-null drift to
//    `RestoreExcludeDriftError` (D75 locks that `--force` does NOT
//    bypass drift — restoring against a different exclude policy than
//    capture would silently lose captured files or violate the never-
//    touch contract). `planRestoreCheckpoint` surfaces drift via a
//    `preflight_failures[]` entry on the plan so dry-run can report it
//    in the receipt.
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
//    by-entry inside `loadRestorePreflight`:
//      - No `.viberevert/**` entry (corrupt evidence per file header
//        invariant #6 and restore-preflight.ts's matching lock).
//      - Canonical relative POSIX path (no `..`, no absolute, no `\\`).
//        Same predicate as `isSafeStoredRelativePath` from
//        `@viberevert/session-format`.
//      - Regular-file entry type only. Symlinks, hardlinks, directories,
//        block/char devices, FIFOs are rejected.
//      - Exact set parity with `file_hashes` keys. Both archives are
//        required to contain EXACTLY the paths the manifest says they
//        contain — extras or missing entries are corruption (a truncated
//        archive is not "still partially trustworthy").
//    `extractUntrackedTarball` keeps a per-entry `filter` callback as
//    defense-in-depth — tar.extract has its own filter pass and we keep
//    BOTH layers in agreement, INCLUDING the `.viberevert/**` reject.
//    The filter is not the primary guarantee (preflight is) but prevents
//    future preflight drift from becoming an extraction bug.
//
// 6. **VibeRevert's own storage (`.viberevert/**`) is HARD-EXCLUDED from
//    deletion AND extraction-path cleanup AND extraction (M D Step 3
//    Blocker 2 lock, mutation-side application).** Per the M D Step 3
//    lock: `.viberevert/` is the rollback control plane (receipts,
//    sessions, locks, checkpoints, reports, future GC metadata). Once
//    rollback is running, NONE of it should be deleted/cleaned/overwritten
//    by restore logic — INCLUDING the emergency pre-rollback checkpoint
//    that the CLI creates RIGHT BEFORE invoking restoreCheckpoint.
//
//    `.viberevert/` is gitignored after `viberevert init` (M B Step 1
//    hard precondition), so `gitListUntracked` shouldn't surface it.
//    But that's not a guarantee — a manually-edited `.gitignore`, a
//    `--no-init` workflow, or a future package that creates
//    `.viberevert/` paths outside init could break it. Defense-in-depth
//    via the policy module's `isVibeRevertInternalPath` predicate at
//    FOUR mutation-side call sites:
//
//      (a) `deleteUncapturedUntracked` — SILENT SKIP. `.viberevert/**`
//          paths surfaced by `gitListUntracked` are filtered out of
//          the deletion candidate list. The mutation never happens;
//          no error, no record. Rationale: ungitignored
//          `.viberevert/**` content is a misconfiguration, not corrupt
//          evidence; the user can fix `.gitignore` and re-run.
//
//      (b) `planRestoreCheckpoint`'s deletion enumeration — SILENT
//          SKIP. Same rationale as (a); the plan's
//          `untracked_deleted` field correctly omits `.viberevert/**`
//          paths.
//
//      (c) `clearExtractionPathConflicts`'s `allPaths` builder — LOUD
//          TRIPWIRE CONFLICT. Cleanup seeing `.viberevert/**` in
//          `expectedPaths` means preflight DRIFTED — the path-policy
//          rejection in `restore-preflight.ts` (manifest +
//          tracked_dirty_paths + archive entries + patch headers all
//          reject `.viberevert/**`) should have caught this BEFORE
//          we got here. Silently skipping would hide the drift; the
//          tripwire pushes a structured conflict that bubbles up
//          through `RestoreExtractionConflictError` with the locked
//          message "restore refused to clean extraction path under
//          VibeRevert internal storage (.viberevert/**)". Non-
//          mutating either way; the tripwire makes the impossible
//          condition visible at the throw point so the regression
//          gets fixed instead of accumulating.
//
//      (d) `extractUntrackedTarball`'s tar filter — SILENT FILTER
//          REJECT. Tar.extract drops the entry; the surrounding
//          preflight archive-validation already rejected the entry
//          earlier, so this is belt-and-braces against the same
//          drift class as (c).
//
//    **Two faces of the same lock.** This file applies the rule on the
//    DELETION + EXTRACTION-CLEANUP + EXTRACTION sides.
//    `restore-preflight.ts` applies it on the EVIDENCE side (rejecting
//    `.viberevert/**` from manifest file_hashes, tracked_dirty_paths,
//    archive entries, AND patch headers as hard corruption). Both
//    pull from the same predicate
//    (`./restore-internal-path-policy.ts`) so the case-insensitive +
//    separator-insensitive + slash-collapse + root-dot-segment-strip
//    normalization is identical across all six application points.
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
//     set parity with `file_hashes` keys, regular-file entries, safe paths,
//     no `.viberevert/**`). Pure tampering detection — even though we
//     don't extract it, a manifest declaring a tampered archive is itself
//     suspicious.
//
//   - mtime / permissions metadata is NOT asserted by hash verification.
//     Acceptance is byte-content identical only. (Documented in the M B
//     plan's Risks section.)

import type { Stats } from "node:fs";
import { lstat, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  isSafeStoredRelativePath,
  type Manifest,
  normalizePathArray,
} from "@viberevert/session-format";
import * as tar from "tar";
import {
  RestoreExcludeDriftError,
  type RestoreExtractionConflict,
  RestoreExtractionConflictError,
  type RestoreHashMismatch,
  RestoreHeadMismatchError,
  RestoreTrackedDirtyParityError,
  type RestoreTrackedDirtyParityIssue,
  RestoreVerificationError,
} from "./errors.js";
import {
  gitApply,
  gitApplyWithIndex,
  gitListTrackedDirty,
  gitListUntracked,
  gitResetHardHead,
} from "./git-cli.js";
import { sha256File } from "./hashes.js";
import { isVibeRevertInternalPath } from "./restore-internal-path-policy.js";
import { loadRestorePreflight } from "./restore-preflight.js";

// =============================================================================
// Public API — restoreCheckpoint
// =============================================================================

/**
 * Options for `restoreCheckpoint`. Mirrors the fields the CLI orchestration
 * layer (M D) resolves from `.viberevert.yml` and passes through.
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
 *   `loadRestorePreflight` compares capture-time patterns (persisted in
 *   `manifest.untracked.exclude_patterns`) against the patterns supplied
 *   here and returns `excludeDrift: ExcludeDriftDetail | null`.
 *   `restoreCheckpoint` throws `RestoreExcludeDriftError` on non-null
 *   drift BEFORE any mutation. See file header invariant #4.
 */
export type RestoreCheckpointOptions = {
  readonly repoRoot: string;
  readonly rollbackExcludePatterns: readonly string[];
  /**
   * M D D64 escape-hatch: when `true`, skip the `RestoreHeadMismatchError`
   * pre-check and proceed with restore against a DIFFERENT HEAD than the
   * checkpoint captured. Default `false` (preserves M B behavior).
   *
   * Locked: `allowHeadMismatch` bypasses ONLY the HEAD pre-check. It does
   * NOT bypass `RestoreExcludeDriftError`, post-restore parity, or hash
   * verification — those are restore-correctness invariants, not user-
   * consent decisions. CLI's `--force` propagates this option per D75's
   * locked override table.
   *
   * Risk acknowledged by the caller: captured patches were taken relative
   * to the checkpoint's HEAD; applying them on a different baseline may
   * produce mid-restore failures (extraction conflicts, parity drift, or
   * verification failures) which the receipt surfaces in `failures[]`.
   */
  readonly allowHeadMismatch?: boolean;
};

/**
 * Restore the working tree + index to the state captured by the checkpoint
 * at `checkpointDir`. M D-promoted package API per D73 / D77; consumed by
 * CLI rollback orchestration (and reused by M B fixture tests).
 *
 * Throws (all are typed errors from `./errors.js` or `./restore-preflight`):
 *   - `CheckpointNotFoundError` / `CheckpointCorruptError`: from
 *     `loadRestorePreflight`. Bad evidence is a hard failure regardless of
 *     `allowHeadMismatch`.
 *   - `RestoreHeadMismatchError`: HEAD does not match
 *     `manifest.git.head_sha`. Suppressed when `opts.allowHeadMismatch`
 *     is `true` (CLI's `--force` propagates this per D75).
 *   - `RestoreExcludeDriftError`: capture-time and restore-time
 *     `rollback.exclude` policies have drifted. Always throws on non-null
 *     drift — `--force` does NOT bypass per D75.
 *   - `RestoreExtractionConflictError`: AFTER patch replay +
 *     uncaptured-untracked deletion, the working tree still has
 *     unresolvable blockers at extraction paths. The working tree is in
 *     a "patches replayed, untracked half-restored" state when this
 *     fires; the user must resolve manually before re-running.
 *   - `RestoreTrackedDirtyParityError`: post-restore tracked-dirty path
 *     set does not exactly equal `manifest.snapshots.tracked_dirty_paths`.
 *     Thrown AFTER mutation and BEFORE hash verification (set-level
 *     errors precede byte-level errors per invariant #3).
 *   - `RestoreVerificationError`: post-restore hash check found one or
 *     more paths whose on-disk SHA-256 does not match the manifest's
 *     `file_hashes` entry. Thrown AFTER mutation and AFTER parity.
 *
 * Order of guarantees:
 *   1. Non-mutating trust validation first (via `loadRestorePreflight`:
 *      manifest, manifest path-policy, archive read + shape, patch
 *      path-policy, HEAD, exclude drift) — failures here leave the
 *      working tree untouched.
 *   2. Mutation phase: reset → patches → delete uncaptured untracked →
 *      auto-clear safe extraction-path blockers → THROW
 *      `RestoreExtractionConflictError` if unresolvable blockers remain
 *      (working tree IS already in the patches-replayed,
 *      untracked-half-restored state at this point) → tarball extraction.
 *   3. Post-mutation set-parity, THEN hash verification. If any step
 *      here fails, the working tree IS in the restore-attempted state —
 *      the caller decides whether to retry, abandon, or do further
 *      recovery. Restore does NOT try to roll BACK from a verification
 *      failure; that's a separate emergency-recovery concern and an
 *      actively dangerous design space (a buggy auto-rollback could
 *      destroy the restore attempt's evidence).
 */
export async function restoreCheckpoint(
  checkpointDir: string,
  opts: RestoreCheckpointOptions,
): Promise<void> {
  // ===========================================================================
  // Non-mutating trust validation phase (centralized in loadRestorePreflight)
  // ===========================================================================

  const pre = await loadRestorePreflight(checkpointDir, {
    repoRoot: opts.repoRoot,
    rollbackExcludePatterns: opts.rollbackExcludePatterns,
    includeArtifactBuffers: true,
  });

  // HEAD must match unless explicitly overridden. Preflight returns
  // headMatch as INFO; this is where we convert to the typed throw per
  // M D D64. `opts.allowHeadMismatch === true` skips the throw and
  // proceeds best-effort — restore-correctness verification still fires
  // unconditionally.
  if (!pre.headMatch && !opts.allowHeadMismatch) {
    throw new RestoreHeadMismatchError(pre.manifest.git.head_sha, pre.actualHeadSha);
  }

  // Exclude drift always throws. Per D75: `--force` does NOT override
  // drift; restoring against a different exclude policy than capture
  // would silently lose captured files or violate the never-touch
  // contract.
  if (pre.excludeDrift !== null) {
    throw new RestoreExcludeDriftError(pre.excludeDrift);
  }

  const {
    trackedArchiveBuf: _unusedTrackedBuf,
    untrackedArchiveBuf,
    stagedPatch,
    unstagedPatch,
  } = pre.artifacts;
  void _unusedTrackedBuf; // tracked archive is shape-validated but never extracted in M B (see file header "what does NOT happen in M B").
  const expectedUntrackedSet = pre.expectedUntrackedSet;
  const isExcluded = pre.isExcluded;

  // ===========================================================================
  // Mutation phase
  // ===========================================================================

  // Wipe tracked-side state to a clean HEAD. Discards ALL tracked changes
  // (staged AND unstaged) and clears the index. Does NOT touch untracked
  // files — those are handled separately below.
  await gitResetHardHead(opts.repoRoot);

  // Replay the captured patches. Order matters:
  //   - staged.patch FIRST with --index: re-stages exactly what was staged
  //     at checkpoint time. Both index AND working tree advance to the
  //     "post-staged" state.
  //   - unstaged.patch SECOND without --index: applies only to the working
  //     tree, layering the unstaged delta on top of the staged-and-applied
  //     state. Index stays as the captured staged content; working tree
  //     now matches the captured working tree exactly.
  // Empty patch buffers are no-ops in git apply, so a clean-tracked-tree
  // checkpoint replays correctly without special-casing.
  if (stagedPatch.length > 0) {
    await gitApplyWithIndex(opts.repoRoot, stagedPatch);
  }
  if (unstagedPatch.length > 0) {
    await gitApply(opts.repoRoot, unstagedPatch);
  }

  // Untracked side: the current working tree may have files created
  // during the session that aren't in the manifest. Enumerate
  // untracked-not-excluded paths NOT in the captured set and remove them.
  // Files in the manifest are left alone — `extractUntrackedTarball` will
  // overwrite them with the captured bytes after path cleanup.
  //
  // The deletion helper hard-excludes `.viberevert/**` per file header
  // invariant #6 — defense-in-depth so the emergency pre-rollback
  // checkpoint (created by the CLI immediately before this call) can
  // never be deleted by restore, regardless of `.gitignore` state.
  const expectedUntrackedPaths = [...expectedUntrackedSet];
  await deleteUncapturedUntracked(opts.repoRoot, expectedUntrackedSet, isExcluded);

  // Extraction-path cleanup. AFTER the delete pass: some blockers that
  // looked unresolvable pre-mutation are now safely cleanable (e.g., a
  // directory at a manifest file path that contained only uncaptured
  // untracked content is now empty and rmdir-able). The helper
  // auto-resolves the safe set (empty dir at final path, symlink at
  // final path, symlink at intermediate component) and collects the
  // rest as conflicts. If any unresolvable blockers remain, throw
  // BEFORE extraction so tar.extract never runs against a hostile
  // state. The working tree is already in a patches-replayed state at
  // this point — the throw timing is post-mutation but
  // pre-extract-mutation.
  //
  // The cleanup helper applies the `.viberevert/**` policy as a LOUD
  // TRIPWIRE per file header invariant #6 (call site (c)) — preflight
  // should reject such paths from evidence, but a tripwire here makes
  // the impossible-condition visible at the throw point so the drift
  // surfaces rather than getting silently absorbed.
  const conflicts = await clearExtractionPathConflicts(
    opts.repoRoot,
    expectedUntrackedPaths,
    isExcluded,
  );
  if (conflicts.length > 0) {
    throw new RestoreExtractionConflictError(conflicts);
  }

  // Extract the untracked tarball from the in-memory Buffer. Strict
  // filters reject non-regular entries AND `.viberevert/**` paths
  // (defense in depth — already asserted in archive validation by
  // preflight, but tar.extract has its own filter pass and we keep
  // both layers in agreement).
  //
  // Skipped when the captured untracked set is empty — there's nothing
  // to extract, and tar.extract on a minimal empty archive (snapshots.ts
  // writes 2x 512-byte zero blocks gzipped, the standard tar EOF marker)
  // fails with TAR_BAD_ARCHIVE on node-tar v7.x. Preflight already
  // verified that an empty archive matches empty file_hashes (set
  // parity), so skipping extraction is sound — the buffer is provably
  // empty by the time we get here when expectedUntrackedSet is empty.
  if (expectedUntrackedSet.size > 0) {
    await extractUntrackedTarball(untrackedArchiveBuf, opts.repoRoot);
  }

  // ===========================================================================
  // Post-mutation verification (parity FIRST, hashes SECOND)
  // ===========================================================================

  // Raw set-parity verification (closes the tracked-deletion soundness
  // hole). Compare the post-restore working tree's `gitListTrackedDirty`
  // output against `manifest.snapshots.tracked_dirty_paths` VERBATIM.
  // No lstat narrowing, no regular-file filtering, no `rollback.exclude`
  // filtering — full set equality. Set-level signal precedes byte-level.
  await verifyTrackedDirtyParity(opts.repoRoot, pre.manifest);

  // Hash-verify every captured file. Both `manifest.snapshots.file_hashes`
  // (tracked-dirty regular-file subset) and `manifest.untracked.file_hashes`
  // (untracked subset) are checked. Each on-disk SHA-256 must match.
  // Collected per-path mismatches are thrown as a single structured
  // error (matches RestoreVerificationError's contract).
  const mismatches: RestoreHashMismatch[] = [];
  await collectHashMismatches(opts.repoRoot, pre.manifest.snapshots.file_hashes, mismatches);
  await collectHashMismatches(opts.repoRoot, pre.manifest.untracked.file_hashes, mismatches);
  if (mismatches.length > 0) {
    throw new RestoreVerificationError(mismatches);
  }
}

// =============================================================================
// Public API — planRestoreCheckpoint (M D dry-run sibling)
//
// Returns a structured classification of what `restoreCheckpoint` WOULD
// do against the same checkpoint + opts. Read-only — no mutation, no
// patch application, no archive extraction. Used by the CLI's
// `viberevert rollback` dry-run path to populate the receipt's
// `results[]` field; reused by the apply path as the pre-mutation
// classification source (single source of truth, no second algorithm).
//
// Honest classification per the M D Step 3 lock — NEVER overclaims:
//   - `tracked_restored`: paths in `manifest.snapshots.tracked_dirty_paths`
//     whose current bytes differ from captured (hash-compared for the
//     `file_hashes` subset; conservative-include for paths that have no
//     captured hash — deletions, mode-only changes, symlinks, type changes
//     — since we can't predict patch no-op without simulating).
//   - `untracked_restored`: captured untracked paths whose current bytes
//     differ from captured (hash-compared).
//   - `untracked_deleted`: current untracked paths NOT in the manifest
//     AND NOT excluded AND a REGULAR FILE (mirrors
//     `deleteUncapturedUntracked`'s filtering — symlinks/FIFOs/sockets
//     are preserved). `.viberevert/**` paths are hard-excluded
//     defense-in-depth per file header invariant #6.
//   - `skipped_excluded`: current untracked paths matching the resolved
//     exclude matcher — restricted to paths NOT also in the captured
//     set (captured paths are classified by the manifest-side loops
//     above; the disjoint-bucket invariant prevents double-classification
//     during exclude drift).
//   - `skipped_unchanged`: captured paths whose current FILE BYTES match
//     the captured bytes. Content-level only — for tracked paths, apply
//     may still affect index state even when bytes match.
//
// Preflight failures (HEAD mismatch, exclude drift) surface as
// `preflight_failures[]` entries on the plan. The CLI maps each to a
// receipt `failures[]` entry per the M D D69 schema. The plan helper
// itself never throws on HEAD/drift — the CLI decides whether dry-run
// surfaces (writes receipt with failures[]) or apply refuses (throws).
//
// When `opts.allowHeadMismatch` is `true`, the `head_mismatch`
// `preflight_failures[]` entry is SUPPRESSED (caller has explicitly
// accepted the mismatch — emitting it would contradict A6's "receipt
// has `failures: []`" on force-success). `head_match` still reports
// the actual state for callers that want to inspect it.
// =============================================================================

/**
 * The classification of what `restoreCheckpoint` would do if invoked
 * with the same checkpoint + opts. All path arrays are normalized via
 * `normalizePathArray` (sorted ASCII-ascending, deduped, canonical
 * relative POSIX) so the plan is byte-stable across runs — A9 protection
 * for the persisted receipt's `results[]` field.
 */
export interface RestorePlan {
  /**
   * `true` iff current HEAD equals `manifest.git.head_sha`. Reported as
   * the actual state regardless of `opts.allowHeadMismatch` — the
   * suppression only affects whether the mismatch surfaces as a
   * `preflight_failures[]` entry.
   */
  readonly head_match: boolean;
  /** Captured paths whose current content differs from captured (would be patched). */
  readonly tracked_restored: readonly string[];
  /** Captured untracked paths whose current content differs from captured (would be extracted). */
  readonly untracked_restored: readonly string[];
  /** Current untracked regular files not in the manifest and not excluded (would be deleted). */
  readonly untracked_deleted: readonly string[];
  /**
   * Current untracked paths matching the resolved exclude matcher
   * (preserved). Restricted to paths NOT also in the captured set —
   * captured paths are classified by the manifest-side loops; this
   * bucket is disjoint from `tracked_restored`, `untracked_restored`,
   * and `skipped_unchanged` even when exclude drift exists.
   */
  readonly skipped_excluded: readonly string[];
  /**
   * Captured paths whose current FILE BYTES already match the captured
   * bytes. Content-level only — for tracked paths, restore may still
   * affect index state (e.g., the path is currently staged with the
   * same bytes but in a different index entry) even when this
   * classifier names them as unchanged. This is acceptable for receipt
   * surfacing: the receipt is a user-facing summary of file-content
   * outcomes, not an index-state diff.
   */
  readonly skipped_unchanged: readonly string[];
  /**
   * Soft-failure signals surfaced by preflight (HEAD mismatch and/or
   * exclude drift). CLI maps these to receipt `failures[]` entries.
   * Empty when both preflight info fields indicate no problem. When
   * `opts.allowHeadMismatch` is `true`, the `head_mismatch` entry is
   * suppressed even if HEAD actually mismatches.
   */
  readonly preflight_failures: readonly RestorePreflightFailure[];
}

/**
 * A soft-failure detail surfaced by `planRestoreCheckpoint` for receipt
 * persistence. The CLI converts each entry to a receipt `failures[]`
 * entry per the M D D69 schema.
 *
 * `affected_paths` is normalized via `normalizePathArray` for byte
 * stability (matches the receipt schema's `sortedUniquePathArray`
 * enforcement on the persisted field).
 */
export interface RestorePreflightFailure {
  readonly error_code: "head_mismatch" | "exclude_drift";
  readonly message: string;
  readonly affected_paths: readonly string[];
}

export type PlanRestoreCheckpointOptions = {
  readonly repoRoot: string;
  readonly rollbackExcludePatterns: readonly string[];
  /**
   * Mirrors `RestoreCheckpointOptions.allowHeadMismatch` so the apply
   * and dry-run code paths can be driven by the same `--force` flag.
   *
   * **Effect on `RestorePlan.preflight_failures[]`:** when `true`,
   * suppresses the `head_mismatch` entry. The user has explicitly
   * accepted the mismatch via `--force`; emitting a `head_mismatch`
   * failure in the receipt would contradict A6's "receipt has
   * `failures: []`" guarantee on force-success.
   *
   * **No effect on `RestorePlan.head_match`:** that field always
   * reports the actual HEAD comparison result (`true` if matching,
   * `false` if not). Callers that need to inspect the actual state
   * read `head_match` directly; callers that drive receipt
   * `failures[]` honor the suppression via `preflight_failures[]`.
   *
   * **No effect on classification buckets** (`tracked_restored`,
   * `untracked_restored`, etc.). Plan computation runs identically;
   * only the preflight-failure surfacing changes.
   */
  readonly allowHeadMismatch?: boolean;
};

/**
 * Compute a `RestorePlan` describing what `restoreCheckpoint` would do
 * against the same `checkpointDir` + `opts`. Read-only — no mutation, no
 * patch application, no archive extraction.
 *
 * Throws on bad evidence (CheckpointNotFoundError / CheckpointCorruptError
 * from `loadRestorePreflight`). Per the M D Step 3 lock: corrupt evidence
 * = no plan, same as `restoreCheckpoint`. CLI exits 1 without writing a
 * dry-run receipt — the receipt would imply there was a valid rollback
 * target.
 *
 * Does NOT throw on HEAD mismatch or exclude drift — those surface via
 * `RestorePlan.preflight_failures[]` so the CLI can write a dry-run
 * receipt with structured `failures[]`. `opts.allowHeadMismatch`
 * suppresses the `head_mismatch` entry (see option JSDoc).
 *
 * Pure-functional + idempotent: safe to call multiple times consecutively
 * (the apply path calls it BEFORE invoking `restoreCheckpoint` to capture
 * the success classification per D76 step 17).
 */
export async function planRestoreCheckpoint(
  checkpointDir: string,
  opts: PlanRestoreCheckpointOptions,
): Promise<RestorePlan> {
  const pre = await loadRestorePreflight(checkpointDir, {
    repoRoot: opts.repoRoot,
    rollbackExcludePatterns: opts.rollbackExcludePatterns,
    includeArtifactBuffers: false,
  });

  // ---------------------------------------------------------------------------
  // Tracked classification: hash-compare for paths with captured hashes;
  // conservative-include for the rest.
  // ---------------------------------------------------------------------------

  const tracked_restored: string[] = [];
  const skipped_unchanged: string[] = [];

  // Subset with captured hashes (regular files). Compare current bytes
  // against captured hash.
  for (const [path, expectedHash] of Object.entries(pre.manifest.snapshots.file_hashes)) {
    const abs = join(opts.repoRoot, path);
    const actualHash = await hashFileIfRegular(abs);
    if (actualHash === expectedHash) {
      skipped_unchanged.push(path);
    } else {
      tracked_restored.push(path);
    }
  }

  // Tracked-dirty paths NOT in file_hashes (deletions, mode-only,
  // symlinks, type changes). Can't predict patch no-op without
  // simulating; classify conservatively as tracked_restored. This is
  // the locked "would be patched" interpretation per the M D Step 3
  // contract.
  const trackedFileHashKeys = new Set(Object.keys(pre.manifest.snapshots.file_hashes));
  for (const path of pre.manifest.snapshots.tracked_dirty_paths) {
    if (!trackedFileHashKeys.has(path)) {
      tracked_restored.push(path);
    }
  }

  // ---------------------------------------------------------------------------
  // Untracked classification: hash-compare every captured entry.
  // ---------------------------------------------------------------------------

  const untracked_restored: string[] = [];
  for (const [path, expectedHash] of Object.entries(pre.manifest.untracked.file_hashes)) {
    const abs = join(opts.repoRoot, path);
    const actualHash = await hashFileIfRegular(abs);
    if (actualHash === expectedHash) {
      skipped_unchanged.push(path);
    } else {
      untracked_restored.push(path);
    }
  }

  // ---------------------------------------------------------------------------
  // Current untracked enumeration → untracked_deleted + skipped_excluded.
  // Mirrors `deleteUncapturedUntracked`'s exact filtering: regular files
  // only, ENOENT-tolerant, .viberevert/** hard-excluded (silent skip per
  // file header invariant #6 call site (b)).
  //
  // DISJOINT-BUCKET INVARIANT: captured paths are classified above
  // (untracked_restored / skipped_unchanged). The captured-check fires
  // BEFORE the exclude-check so a captured path that now matches an
  // excluded pattern (exclude drift) is NOT double-classified. Exclude
  // drift still surfaces via preflight_failures[] — see
  // restore-preflight.ts.
  // ---------------------------------------------------------------------------

  const currentUntracked = await gitListUntracked(opts.repoRoot);
  const untracked_deleted: string[] = [];
  const skipped_excluded: string[] = [];

  for (const p of currentUntracked) {
    if (isVibeRevertInternalPath(p)) continue; // never delete VibeRevert's own storage

    // Captured paths are classified by the manifest-side loops above.
    // Skip here BEFORE the exclude-check so exclude drift doesn't
    // double-classify them into skipped_excluded.
    if (pre.expectedUntrackedSet.has(p)) continue;

    if (pre.isExcluded(p)) {
      skipped_excluded.push(p);
      continue;
    }

    // Match deleteUncapturedUntracked's behavior: lstat-guarded
    // regular-file-only filtering. Non-regular entries are preserved at
    // apply time, so dry-run must NOT claim they'd be deleted.
    const abs = join(opts.repoRoot, p);
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (!st.isFile()) continue;
    untracked_deleted.push(p);
  }

  // ---------------------------------------------------------------------------
  // Preflight failures (HEAD + drift). CLI maps each to receipt failures[].
  //
  // head_mismatch is SUPPRESSED when opts.allowHeadMismatch is true —
  // see the option JSDoc for the A6 rationale. excludeDrift is never
  // suppressed (D75: --force does NOT bypass exclude drift; the message
  // reflects that there's no force-equivalent for this signal).
  // ---------------------------------------------------------------------------

  const preflight_failures: RestorePreflightFailure[] = [];
  if (!pre.headMatch && !opts.allowHeadMismatch) {
    preflight_failures.push({
      error_code: "head_mismatch",
      message: `current HEAD ${pre.actualHeadSha} does not match checkpoint-captured ${pre.manifest.git.head_sha}`,
      affected_paths: [],
    });
  }
  if (pre.excludeDrift !== null) {
    preflight_failures.push({
      error_code: "exclude_drift",
      message:
        "rollback.exclude patterns differ between capture and current config; restore would refuse",
      affected_paths: normalizePathArray([...pre.excludeDrift.tighteningPaths]),
    });
  }

  // ---------------------------------------------------------------------------
  // Normalize all path arrays before returning. A9 byte-stability.
  // ---------------------------------------------------------------------------

  return {
    head_match: pre.headMatch,
    tracked_restored: normalizePathArray(tracked_restored),
    untracked_restored: normalizePathArray(untracked_restored),
    untracked_deleted: normalizePathArray(untracked_deleted),
    skipped_excluded: normalizePathArray(skipped_excluded),
    skipped_unchanged: normalizePathArray(skipped_unchanged),
    preflight_failures,
  };
}

// =============================================================================
// Internal helpers — file-state inspection
// =============================================================================

/**
 * Compute the SHA-256 of a file IF it's a regular file. Returns `null`
 * when the path is absent or non-regular — semantics tuned for
 * `planRestoreCheckpoint`'s skipped-unchanged classification (the
 * "expected hash" would only match for a regular file with the right
 * bytes).
 *
 * Three null sources match `collectHashMismatches` exactly:
 *   - `lstat` returns ENOENT (file absent at lstat time).
 *   - `lstat` succeeds but `!st.isFile()` (path is a symlink/dir/FIFO/
 *     socket/device — any non-regular entry).
 *   - `sha256File` throws ENOENT (file vanished between the lstat and
 *     the streaming open — benign TOCTOU race).
 *
 * Any non-ENOENT error from either `lstat` or `sha256File` propagates
 * as a real I/O failure — same defensive surface as
 * `collectHashMismatches`.
 *
 * Inline helper (not exported, not in `./hashes.ts`): semantics are
 * restore-specific (the three null sources are tuned for restore dry-run
 * classification), not a general-purpose hash primitive.
 */
async function hashFileIfRegular(absPath: string): Promise<string | null> {
  let st: Stats;
  try {
    st = await lstat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!st.isFile()) return null;
  try {
    return await sha256File(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
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
 * narrowed). `.viberevert/**` paths are hard-excluded per file header
 * invariant #6 (defense-in-depth so the emergency pre-rollback checkpoint
 * created by the CLI immediately before this function runs can never be
 * deleted regardless of `.gitignore` state).
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
  capturedSet: ReadonlySet<string>,
  isExcluded: (path: string) => boolean,
): Promise<void> {
  const candidates = await gitListUntracked(repoRoot);
  for (const p of candidates) {
    if (isVibeRevertInternalPath(p)) continue; // file header invariant #6 call site (a) — hard-exclude VibeRevert's own storage
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
 *   - **`.viberevert/**` paths (LOUD TRIPWIRE).** Preflight rejects
 *     such paths from manifest/archive/patch evidence, so by the time
 *     `expectedPaths` reaches this helper, no `.viberevert/**` entry
 *     should be present. If one is, preflight has DRIFTED — the
 *     tripwire pushes a structured conflict with the locked reason
 *     "restore refused to clean extraction path under VibeRevert
 *     internal storage (.viberevert/**)" and skips both the path AND
 *     its ancestors from the cleanup walk. Non-mutating (no rmdir /
 *     unlink touches `.viberevert/**`); the conflict bubbles up
 *     through `RestoreExtractionConflictError` so the impossible
 *     condition is visible at the throw point rather than silently
 *     absorbed. See file header invariant #6 call site (c).
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
 * the call site, preflight's drift check has already guaranteed none of
 * `expectedPaths` matches `isExcluded`, so the skip is effectively a
 * no-op — kept for defense-in-depth + clarity.
 *
 * **Export scope (controlled internal).** Exported from this module so
 * package-local tests can call it directly with synthetic `expectedPaths`
 * — specifically to verify the `.viberevert/**` tripwire branch (file
 * header invariant #6 call site (c)) without setting up a full
 * restore lifecycle or bypassing preflight. NOT re-exported from
 * `@viberevert/git`'s barrel — this is a test-surface concession, NOT a
 * controlled CLI orchestration API, and no D77 architectural-invariant
 * binds it. Package-local test imports use the source module path:
 * `import { clearExtractionPathConflicts } from "../src/restore.js"`.
 */
export async function clearExtractionPathConflicts(
  repoRoot: string,
  expectedPaths: readonly string[],
  isExcluded: (path: string) => boolean,
): Promise<RestoreExtractionConflict[]> {
  const conflicts: RestoreExtractionConflict[] = [];

  // Collect every path we'd touch (final paths + ancestor dirs).
  // `.viberevert/**` paths surface as TRIPWIRE conflicts (see helper
  // JSDoc) and are skipped from the walk entirely — neither the path
  // nor its ancestors are added to `allPaths`, so no rmdir/unlink can
  // touch VibeRevert's own storage even if preflight drifts.
  const allPaths = new Set<string>();
  for (const p of expectedPaths) {
    if (isVibeRevertInternalPath(p)) {
      conflicts.push({
        manifestPath: p,
        conflictingPath: p,
        reason:
          "restore refused to clean extraction path under VibeRevert internal storage (.viberevert/**)",
      });
      continue;
    }
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
 * filters reject anything that isn't a regular file with a safe path AND
 * not under `.viberevert/**`, mirroring the preflight assertions. Runs
 * from the in-memory Buffer; never touches the on-disk archive after it
 * was first read by preflight.
 *
 * Uses `tar.extract` (the documented stream-based named export) which
 * auto-detects and decompresses gzip. Buffer fed via `Readable.from([buf])`
 * (single-chunk) per file header invariant #2.
 *
 * The `.viberevert/**` reject in the filter is defense-in-depth — preflight
 * already rejected such entries during archive validation, so this filter
 * should never fire in practice. Kept as belt-and-braces against future
 * preflight drift: if someone refactors preflight and accidentally drops
 * the `.viberevert/**` archive-entry check, this filter still prevents
 * VibeRevert's own storage from being overwritten by extraction. See file
 * header invariant #6 call site (d).
 */
async function extractUntrackedTarball(buf: Buffer, repoRoot: string): Promise<void> {
  await pipeline(
    Readable.from([buf]),
    tar.extract({
      cwd: repoRoot,
      // Per-entry guard: refuse anything not a regular file with a safe
      // path, AND refuse `.viberevert/**` entries (defense-in-depth).
      // tar v7's filter signature is `(path, ReadEntry | Stats)` — Stats
      // is for the create-side; extract always passes ReadEntry. Widen
      // the parameter type to satisfy the assignability check, then
      // narrow via the `"type" in entry` discriminator (fs.Stats has no
      // `.type` field; ReadEntry does).
      filter: (path: string, entry: tar.ReadEntry | Stats) =>
        "type" in entry &&
        entry.type === "File" &&
        isSafeStoredRelativePath(path) &&
        !isVibeRevertInternalPath(path),
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
