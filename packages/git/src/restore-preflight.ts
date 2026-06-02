// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// loadRestorePreflight — single source of non-mutating trust validation
// shared by restoreCheckpoint (mutation path) and planRestoreCheckpoint
// (dry-run path).
//
// Per the M D plan Step 3 design lock: both callers need the SAME trust
// validation pipeline. Duplicating it across two functions would let
// dry-run silently diverge from apply (the user's "do not let dry-run
// silently omit apply blockers" lock). This file centralizes:
//
//   1. loadCheckpoint (throws CheckpointNotFoundError / CheckpointCorruptError)
//   2. Manifest path-policy validation (rejects `.viberevert/**` in
//      file_hashes AND tracked_dirty_paths as corrupt evidence — see
//      "VibeRevert internal path is corrupt evidence" block below)
//   3. Read all 4 artifact buffers (throws CheckpointCorruptError on read failure)
//   4. Validate archive shape (throws CheckpointCorruptError on shape failure,
//      including `.viberevert/**` archive entries)
//   5. Patch path-policy validation (rejects `.viberevert/**` in
//      staged.patch / unstaged.patch headers as corrupt evidence —
//      same block below; delegates to the policy module's escape-
//      decoding header scanner to block C-quoted obfuscation attacks)
//   6. HEAD comparison (INFO — never throws; caller decides)
//   7. Exclude-pattern normalization + matcher
//   8. Exclude-drift detection (INFO — never throws; caller decides)
//   9. Manifest-expected untracked path set
//
// Contract — what throws, what returns info:
//
//   THROWS on bad evidence (no trustworthy rollback target):
//     - CheckpointNotFoundError (manifest missing/unreadable)
//     - CheckpointCorruptError (manifest schema failure, manifest path-policy
//       failure (`.viberevert/**` in file_hashes or tracked_dirty_paths),
//       archive read failure, archive shape failure including
//       `.viberevert/**` archive entries, patch path-policy failure
//       (`.viberevert/**` in patch headers, including C-quoted-escape
//       obfuscation), manifest/archive parity failure)
//
//   RETURNS info (caller decides whether to throw or surface to user):
//     - headMatch: boolean
//     - excludeDrift: ExcludeDriftDetail | null
//
// restoreCheckpoint converts both info cases to throws (HEAD mismatch
// becomes RestoreHeadMismatchError unless opts.allowHeadMismatch; exclude
// drift always becomes RestoreExcludeDriftError — D75 locks that --force
// does NOT bypass drift).
//
// planRestoreCheckpoint converts both info cases to preflight_failures[]
// entries on the RestorePlan — dry-run reports them in the persisted
// receipt rather than throwing, so the user can inspect what apply would
// refuse. EXCEPTION: when the caller passes `allowHeadMismatch: true`,
// planRestoreCheckpoint suppresses the `head_mismatch` preflight_failures
// entry (the user has explicitly accepted the mismatch — emitting it
// would contradict A6's "receipt has `failures: []`" on force-success).
//
// =============================================================================
// Why archives are ALWAYS read + validated, even when buffers aren't returned
// =============================================================================
//
// The `includeArtifactBuffers` option controls whether the result RETAINS
// the read buffers for the caller. It does NOT control whether validation
// runs. Per the user's Step 3 lock: "dry-run must validate evidence, not
// just loadCheckpoint." Skipping archive shape validation in dry-run would
// let a corrupt archive pass dry-run cleanly and then crash apply.
//
// Memory-wise: dry-run reads the buffers, validates them, then drops the
// references before return. GC reclaims them between preflight and any
// subsequent hashing the dry-run helper does. Apply keeps the buffers so
// the mutation phase can stream them without re-reading from disk (M B's
// "read once, use bytes thereafter" invariant).
//
// =============================================================================
// VibeRevert internal path is corrupt evidence (M D Step 3 Blocker 2 lock)
// =============================================================================
//
// Restore's deletion enumeration (`deleteUncapturedUntracked` and the
// equivalent dry-run classifier) hard-excludes `.viberevert/**` paths from
// removal — that protects the rollback control plane (receipts, sessions,
// locks, the emergency pre-rollback checkpoint just created by the CLI)
// from being deleted by restore regardless of `.gitignore` state.
//
// BUT a checkpoint manifest that DECLARES `.viberevert/...` paths in its
// `file_hashes` OR `tracked_dirty_paths` (or an archive that contains
// such entries, OR a patch that targets them) is corrupt evidence by
// definition — VibeRevert's capture pipeline never writes `.viberevert/**`
// to a checkpoint. `isSafeStoredRelativePath` accepts dot-prefixed paths
// (it's a path-canonicalization check, not a policy check), so without
// explicit rejects here, restore would happily extract into
// `.viberevert/**` and overwrite our own state, OR (via patch replay on
// a tampered staged.patch / unstaged.patch) destroy our own state
// without involving the archive surface at all.
//
// Rule: ANY `.viberevert/**` reference in checkpoint evidence is hard
// corruption. Rejected in THREE manifest places + ONE archive place +
// ONE patch place (covering BOTH patch buffers):
//
//   - `manifest.untracked.file_hashes` keys (step 2 below). Catches
//     untracked-side declarations.
//
//   - `manifest.snapshots.file_hashes` keys (step 2 below). Catches
//     tracked-dirty regular-file declarations.
//
//   - `manifest.snapshots.tracked_dirty_paths` entries (step 2 below).
//     This is the SUPERSET surface — by construction it contains every
//     path in `manifest.snapshots.file_hashes` PLUS tracked deletions,
//     mode-only changes, symlink changes, and type changes. A tampered
//     manifest could declare `.viberevert/...` as a deletion (no hash,
//     no archive entry) and the file_hashes + archive checks would both
//     miss it. The patch replay phase would then execute that deletion
//     against `.viberevert/...`. This check catches the manifest-
//     declared form of that attack.
//
//   - Per-entry archive paths (step 4 below). Catches the case where a
//     tampered archive carries the entry but no manifest field
//     references it.
//
//   - Per-header path references in `staged.patch` and `unstaged.patch`
//     (step 5 below). PATCH REPLAY is the ONLY restore phase that
//     CREATES OR MODIFIES paths without going through manifest
//     declaration OR archive extraction — `git apply` operates on
//     whatever paths the patch headers name, regardless of what the
//     manifest mentions. A tampered staged.patch could carry headers
//     like:
//
//       diff --git a/.viberevert/sessions/X/rollback-receipt.json b/...
//       new file mode 100644
//       @@ -0,0 +1,N @@
//       +<malicious content>
//
//     and the patch-replay phase would create/overwrite that file
//     before any post-restore parity/hash check could see it. WORSE,
//     post-restore parity might miss it entirely: `.viberevert/**`
//     is gitignored after `viberevert init`, so the corrupt file
//     wouldn't appear in `gitListTrackedDirty`'s post-restore output,
//     leaving the corruption silently effective. WORST, a deletion
//     header (`deleted file mode 100644`) targeting `.viberevert/
//     checkpoints/cp_<emergency>/manifest.json` would destroy the
//     pre-rollback emergency checkpoint that was created seconds
//     earlier — the user's safety net evaporates between checkpoint
//     creation and restore.
//
// The policy predicate (`isVibeRevertInternalPath`) and the patch-
// header scanner (`patchHeaderTargetsVibeRevertInternalPath`, with its
// C-escape decoder and token-anchored regex) live in
// `./restore-internal-path-policy.ts` — the SINGLE source of truth
// for `.viberevert/**` semantics across the restore subsystem. See
// that module's header for full normalization rationale (case
// folding, separator normalization, slash collapse, root dot-segment
// strip) + bypass-attack coverage.
//
// =============================================================================
// Locked behavior change vs M B's restoreCheckpoint body order
// =============================================================================
//
// M B's restoreCheckpoint checked HEAD-mismatch BEFORE reading any
// archives ("fail cheap" comment). Preflight reverses this: checkpoint
// evidence is validated FIRST, HEAD comparison after.
//
// Justification per the user's Step 3 lock: corrupt evidence is a hard
// failure regardless of mode (no receipt, throw). HEAD mismatch is a
// preflight signal that apply-with-force may proceed against. Reporting
// "your HEAD differs" on a checkpoint whose archives are actually corrupt
// would be misleading — the corruption is the real story. Validate
// evidence first so the throw points at the real failure.
//
// File 2 (restore.ts) header is updated to reflect this reordering — the
// "HEAD before archives, fail cheap" comment is replaced with one that
// names this lock.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  isSafeStoredRelativePath,
  type Manifest,
  normalizePathArray,
  normalizeStringArray,
} from "@viberevert/session-format";
import picomatch from "picomatch";
import * as tar from "tar";
import { loadCheckpoint } from "./checkpoint.js";
import { CheckpointCorruptError } from "./errors.js";
import { getHeadSha } from "./git-cli.js";
import {
  isVibeRevertInternalPath,
  patchHeaderTargetsVibeRevertInternalPath,
} from "./restore-internal-path-policy.js";

// =============================================================================
// Public types
// =============================================================================

export interface RestorePreflightOptions {
  readonly repoRoot: string;
  readonly rollbackExcludePatterns: readonly string[];
  /**
   * When `true`, the returned result includes raw archive + patch buffers
   * for the caller (restoreCheckpoint needs them for the mutation phase).
   * When `false`, archives + patches are still READ and SHAPE-VALIDATED
   * (dry-run MUST surface bad evidence as a hard failure), but the
   * buffers are dropped before return so dry-run doesn't retain them in
   * memory.
   */
  readonly includeArtifactBuffers: boolean;
}

/**
 * Structured details of an exclude-pattern drift between capture-time and
 * current restore-time policy. Same shape as `RestoreExcludeDriftError`'s
 * constructor input. Returned (not thrown) by `loadRestorePreflight`;
 * callers decide whether to throw (`restoreCheckpoint`) or surface to the
 * receipt (`planRestoreCheckpoint`).
 *
 * All array fields are sorted ASCII-ascending; empty arrays where the
 * corresponding direction has no drift (never undefined). `tighteningPaths`
 * is normalized via `normalizePathArray` (sorted-unique + canonical-path
 * validation) since its elements are repo-relative POSIX paths.
 */
export interface ExcludeDriftDetail {
  readonly capturedPatterns: readonly string[];
  readonly currentPatterns: readonly string[];
  readonly tighteningPatterns: readonly string[];
  readonly looseningPatterns: readonly string[];
  readonly tighteningPaths: readonly string[];
}

export interface RestorePreflightArtifacts {
  readonly trackedArchiveBuf: Buffer;
  readonly untrackedArchiveBuf: Buffer;
  readonly stagedPatch: Buffer;
  readonly unstagedPatch: Buffer;
}

/**
 * Fields shared by both result variants. Discriminated solely by the
 * `artifacts` field's type, narrowed via the overloaded
 * `loadRestorePreflight` signatures below.
 */
interface RestorePreflightResultBase {
  /** The loaded + validated checkpoint manifest. */
  readonly manifest: Manifest;
  /**
   * `true` iff current HEAD sha equals `manifest.git.head_sha`. INFO
   * field — never causes preflight to throw. `restoreCheckpoint` converts
   * `headMatch: false` to `RestoreHeadMismatchError` unless
   * `opts.allowHeadMismatch` is true; `planRestoreCheckpoint` surfaces it
   * via `RestorePlan.head_match` + a `preflight_failures[]` entry.
   */
  readonly headMatch: boolean;
  /** Current HEAD sha as returned by `getHeadSha(repoRoot)`. */
  readonly actualHeadSha: string;
  /** Normalized form of `opts.rollbackExcludePatterns` (sorted, deduped, trimmed). */
  readonly normalizedExcludePatterns: readonly string[];
  /** Matcher derived from the normalized patterns. Returns `false` for empty patterns. */
  readonly isExcluded: (path: string) => boolean;
  /** Manifest-side captured untracked paths as a Set for membership lookup. */
  readonly expectedUntrackedSet: ReadonlySet<string>;
  /**
   * `null` iff no drift detected between capture-time
   * (`manifest.untracked.exclude_patterns`) and current
   * (`opts.rollbackExcludePatterns`) policy. Otherwise a structured
   * detail caller converts to `RestoreExcludeDriftError` (apply) or a
   * `preflight_failures[]` entry (dry-run).
   */
  readonly excludeDrift: ExcludeDriftDetail | null;
}

/**
 * Result when called with `includeArtifactBuffers: true`. `artifacts` is
 * guaranteed non-null at the type level — apply-path consumers can use
 * `pre.artifacts.trackedArchiveBuf` directly without runtime null checks.
 */
export interface RestorePreflightResultWithArtifacts extends RestorePreflightResultBase {
  readonly artifacts: RestorePreflightArtifacts;
}

/**
 * Result when called with `includeArtifactBuffers: false`. `artifacts` is
 * statically `null` — dry-run-path consumers can't accidentally rely on
 * buffers that weren't retained.
 */
export interface RestorePreflightResultWithoutArtifacts extends RestorePreflightResultBase {
  readonly artifacts: null;
}

/**
 * Union form for code that legitimately handles both modes (e.g., test
 * helpers, callers with a widened `boolean` rather than a literal). The
 * matching overload of `loadRestorePreflight` returns this type and
 * forces consumers to narrow via `result.artifacts === null` before
 * dereferencing buffers.
 */
export type RestorePreflightResult =
  | RestorePreflightResultWithArtifacts
  | RestorePreflightResultWithoutArtifacts;

// =============================================================================
// Public API
// =============================================================================

/**
 * Run all non-mutating trust validation for a restore operation. Returns
 * a structured result both `restoreCheckpoint` (mutation path) and
 * `planRestoreCheckpoint` (dry-run path) consume.
 *
 * Throws on bad evidence; returns info on HEAD/drift. See file header for
 * the locked contract.
 *
 * Always reads + shape-validates the four artifact buffers AND
 * path-policy-validates both patch buffers. When
 * `opts.includeArtifactBuffers` is `false`, the buffers are dropped from
 * the returned result (validation still happens) — dry-run validates
 * evidence the same way apply does, but doesn't carry buffers it won't
 * use.
 *
 * Type overloads narrow `artifacts` based on the option literal so
 * apply-path callers don't need runtime null checks on the buffers and
 * dry-run-path callers can't accidentally rely on buffers that weren't
 * retained. A third overload accepts the widened `boolean` form for
 * callers that legitimately handle both modes (test helpers, callers
 * that branch on runtime config).
 */
export function loadRestorePreflight(
  checkpointDir: string,
  opts: RestorePreflightOptions & { readonly includeArtifactBuffers: true },
): Promise<RestorePreflightResultWithArtifacts>;
export function loadRestorePreflight(
  checkpointDir: string,
  opts: RestorePreflightOptions & { readonly includeArtifactBuffers: false },
): Promise<RestorePreflightResultWithoutArtifacts>;
export function loadRestorePreflight(
  checkpointDir: string,
  opts: RestorePreflightOptions,
): Promise<RestorePreflightResult>;
export async function loadRestorePreflight(
  checkpointDir: string,
  opts: RestorePreflightOptions,
): Promise<RestorePreflightResult> {
  // 1. Load manifest. Throws CheckpointNotFoundError / CheckpointCorruptError.
  const manifest = await loadCheckpoint(checkpointDir);

  // 2. Manifest path-policy validation: ANY `.viberevert/**` reference in
  //    `file_hashes` keys OR `tracked_dirty_paths` is corrupt evidence —
  //    VibeRevert's capture pipeline never stores its own internal paths
  //    as checkpoint content. See file header "VibeRevert internal path
  //    is corrupt evidence" block for the full lock.
  //
  //    THREE loops because `tracked_dirty_paths` is by construction a
  //    SUPERSET of `manifest.snapshots.file_hashes` keys (it covers
  //    deletions, mode-only changes, symlinks, type changes — none of
  //    which have hash entries or archive entries). A tampered manifest
  //    declaring `.viberevert/...` as a deletion would slip through
  //    file_hashes + archive validation entirely; the patch replay phase
  //    would then execute that deletion against VibeRevert's own
  //    storage. This loop is the only thing that catches the manifest-
  //    declared form of that attack. (The patch-direct form is caught
  //    by step 5 below.)
  //
  //    Runs BEFORE artifact reads + archive validation so the throw
  //    points at the declaring manifest field rather than at a
  //    downstream symptom.
  for (const path of Object.keys(manifest.untracked.file_hashes)) {
    if (isVibeRevertInternalPath(path)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `manifest.untracked.file_hashes declares VibeRevert internal storage path: ${path}`,
      );
    }
  }
  for (const path of Object.keys(manifest.snapshots.file_hashes)) {
    if (isVibeRevertInternalPath(path)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `manifest.snapshots.file_hashes declares VibeRevert internal storage path: ${path}`,
      );
    }
  }
  for (const path of manifest.snapshots.tracked_dirty_paths) {
    if (isVibeRevertInternalPath(path)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `manifest.snapshots.tracked_dirty_paths declares VibeRevert internal storage path: ${path}`,
      );
    }
  }

  // 3. Read all artifact bytes ONCE. Throws CheckpointCorruptError if any
  //    read fails — loadCheckpoint already lstat'd these paths, but an
  //    artifact unreadable now is corrupt-equivalent.
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
    throw new CheckpointCorruptError(
      checkpointDir,
      `failed to read referenced artifact: ${(err as Error).message}`,
      err,
    );
  }

  // 4. Validate archive shape — both archives must contain only regular-
  //    file entries with safe canonical paths AND no `.viberevert/**`
  //    references AND entry-sets that EXACTLY equal their respective
  //    `file_hashes` keys. Throws CheckpointCorruptError on any failure.
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

  // 5. Patch path-policy validation — neither staged.patch nor
  //    unstaged.patch may target `.viberevert/**` paths. See file header
  //    "VibeRevert internal path is corrupt evidence" block for the
  //    patch-replay attack vector this closes (including the C-quoted
  //    escape obfuscation case). Header-line scanner with escape-
  //    decoding + separator-normalization + slash-collapse lives in
  //    the policy module; empty patches pass without inspection.
  //    Synchronous (pure buffer scan, no I/O).
  assertPatchDoesNotTargetVibeRevertInternalPaths(checkpointDir, stagedPatch, "staged.patch");
  assertPatchDoesNotTargetVibeRevertInternalPaths(checkpointDir, unstagedPatch, "unstaged.patch");

  // 6. HEAD status. INFO field — never throws; caller decides.
  const actualHeadSha = await getHeadSha(opts.repoRoot);
  const headMatch = actualHeadSha === manifest.git.head_sha;

  // 7. Normalize exclude patterns once + compile matcher. Both restore
  //    paths consume the normalized form so behavior stays consistent
  //    with the captured contract (a pattern like "  dist/**  " becomes
  //    "dist/**" here AND was "dist/**" at capture time, so matching is
  //    symmetric).
  const normalizedExcludePatterns = normalizeStringArray([...opts.rollbackExcludePatterns]);
  const isExcluded = compileExcludeMatcher(normalizedExcludePatterns);

  // 8. Expected untracked set (manifest-side captured paths).
  const expectedUntrackedSet = new Set(Object.keys(manifest.untracked.file_hashes));

  // 9. Exclude drift. INFO field — never throws; caller decides.
  const excludeDrift = computeExcludeDrift(
    manifest.untracked.exclude_patterns,
    normalizedExcludePatterns,
    Object.keys(manifest.untracked.file_hashes),
  );

  if (opts.includeArtifactBuffers) {
    return {
      manifest,
      headMatch,
      actualHeadSha,
      normalizedExcludePatterns,
      isExcluded,
      expectedUntrackedSet,
      excludeDrift,
      artifacts: { trackedArchiveBuf, untrackedArchiveBuf, stagedPatch, unstagedPatch },
    };
  }

  // Drop buffer references before return so dry-run doesn't retain them.
  // GC reclaims after this scope exits; the local bindings above go out
  // of scope on return.
  return {
    manifest,
    headMatch,
    actualHeadSha,
    normalizedExcludePatterns,
    isExcluded,
    expectedUntrackedSet,
    excludeDrift,
    artifacts: null,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Compile an excluder function from `rollback.exclude` patterns. Identical
 * shape to snapshots.ts's helper (intentional duplication per the file
 * header invariant #4 of restore.ts — both files own their independent
 * capture/restore policy enforcement; sharing a helper would couple them
 * in a way that obscures the symmetry).
 *
 * Empty list → matcher that excludes nothing. `nonegate: true` disables
 * `!` re-include semantics, matching the M B `rollback.exclude` contract.
 *
 * Used ONLY on the untracked surface (D3 narrowed — see restore.ts file
 * header invariant #4).
 */
function compileExcludeMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matcher = picomatch(patterns as string[], { nonegate: true });
  return (path: string) => matcher(path);
}

/**
 * Bidirectional exclude-drift detection. Returns `null` when no drift,
 * otherwise an `ExcludeDriftDetail`. Pure function — never throws.
 *
 * Pattern-set drift: symmetric difference between captured-time
 * `manifest.untracked.exclude_patterns` and current-time
 * `opts.rollbackExcludePatterns`. Catches both tightening (newly added
 * patterns) AND loosening (newly removed patterns). Even when no
 * captured manifest path is currently affected, policy mismatch is
 * itself a drift signal — the user's notion of what's safe to touch
 * has shifted between the two events.
 *
 * Path-vs-matcher drift (tightening consequences): manifest untracked
 * paths that match the current restore-time matcher. Names exactly
 * which captured files would be silently skipped or overwritten if
 * restore proceeded against the current policy. Most user-actionable
 * signal. Normalized via `normalizePathArray` (sorted-unique +
 * canonical-path) since these are repo-relative POSIX paths.
 *
 * Both pattern lists are normalized inside this helper via
 * `normalizeStringArray` — defense-in-depth so direct test callers
 * and recovery flows that bypass producer-side normalization still
 * get a sound comparison.
 *
 * Pattern arrays in the returned detail inherit sort order from
 * `normalizeStringArray`; `tighteningPaths` is normalized via
 * `normalizePathArray` (path-canonical + sorted-unique).
 */
function computeExcludeDrift(
  capturedPatternsInput: readonly string[],
  currentPatternsInput: readonly string[],
  manifestUntrackedPaths: readonly string[],
): ExcludeDriftDetail | null {
  const capturedPatterns = normalizeStringArray([...capturedPatternsInput]);
  const currentPatterns = normalizeStringArray([...currentPatternsInput]);

  const capturedSet = new Set(capturedPatterns);
  const currentSet = new Set(currentPatterns);

  const tighteningPatterns = currentPatterns.filter((p) => !capturedSet.has(p));
  const looseningPatterns = capturedPatterns.filter((p) => !currentSet.has(p));

  const isExcluded = compileExcludeMatcher(currentPatterns);
  const tighteningPaths = normalizePathArray(manifestUntrackedPaths.filter(isExcluded));

  if (
    tighteningPatterns.length === 0 &&
    looseningPatterns.length === 0 &&
    tighteningPaths.length === 0
  ) {
    return null;
  }

  return {
    capturedPatterns,
    currentPatterns,
    tighteningPatterns,
    looseningPatterns,
    tighteningPaths,
  };
}

/**
 * List entries in a gzipped tarball Buffer, validate each entry's path
 * and type, and assert exact set parity against `expectedPaths`.
 *
 * Throws `CheckpointCorruptError` on:
 *   - `.viberevert/**` entry (case-insensitive, via the policy module's
 *     `isVibeRevertInternalPath`): corrupt evidence per the file header
 *     lock — VibeRevert never archives its own storage. Checked BEFORE
 *     `isSafeStoredRelativePath` so the message names the actual policy
 *     violation rather than the more general canonical-path failure
 *     (which `.viberevert/...` happens to pass).
 *   - Non-canonical path (fails `isSafeStoredRelativePath`).
 *   - Non-regular entry type (symlink, hardlink, directory, device, FIFO).
 *   - Duplicate entries (tampering signal — our tarballs never have
 *     duplicates).
 *   - Entry-set diverges from expected (extras OR missing).
 *
 * Iterates the archive ONCE via `tar.list`'s stream form (auto-
 * decompresses gzip). Entries are collected in the `onentry` callback;
 * validation is performed synchronously after the stream completes.
 * Collect-then-validate is simpler than throwing from inside the stream
 * callback.
 *
 * Buffer fed via `Readable.from([buf])` (NOT `Readable.from(buf)`) to
 * yield the entire Buffer as a single chunk per restore.ts file header
 * invariant #2.
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

  const seenPaths = new Set<string>();
  for (const { path, type } of seen) {
    if (isVibeRevertInternalPath(path)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `${archiveLabel} archive contains VibeRevert internal storage path: ${path}`,
      );
    }
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

/**
 * Iterate over `patch`'s lines and throw `CheckpointCorruptError` on the
 * first header line that targets `.viberevert/**`. Synchronous — pure
 * buffer/string scan, no I/O. Empty patches pass without inspection.
 *
 * The per-line "is this a VibeRevert-targeting header" decision is
 * delegated entirely to the policy module's
 * `patchHeaderTargetsVibeRevertInternalPath` predicate — that helper
 * owns:
 *   - Line classification (hunk-content vs header detection).
 *   - C-quoted escape decoding (closes `\056viberevert` bypass).
 *   - Separator normalization + slash-collapse (closes Windows-form
 *     and combined-escape bypasses).
 *   - Token-anchored path-root regex (blocks nested-path false
 *     positives).
 *
 * See `./restore-internal-path-policy.ts` for the full predicate
 * specification, attack-vector documentation, and locked test
 * obligations.
 *
 * The error message shows the RAW (encoded) form of the violating
 * line via `line.trim()` so the user sees what's actually in their
 * patch — not a synthetic decoded form they'd have to re-encode to
 * find in the file.
 */
function assertPatchDoesNotTargetVibeRevertInternalPaths(
  checkpointDir: string,
  patch: Buffer,
  label: string,
): void {
  if (patch.length === 0) return;

  const text = patch.toString("utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (patchHeaderTargetsVibeRevertInternalPath(line)) {
      throw new CheckpointCorruptError(
        checkpointDir,
        `${label} references VibeRevert internal storage path in patch header: ${line.trim()}`,
      );
    }
  }
}
