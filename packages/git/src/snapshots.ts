// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tarball creation for VibeRevert checkpoint snapshots (D2/D3).
//
// Two snapshots per checkpoint:
//   1. tracked-dirty.tar.gz — raw working-tree bytes of every PRESENT tracked
//      regular file (NOT only the dirty ones), captured as of checkpoint time.
//      The filename is historical: the archive's contents were broadened from
//      the dirty subset to all present tracked regular files WITHOUT a format
//      rename (kept to avoid a schema change). Capturing clean tracked files'
//      bytes too is what lets restore reproduce a file's EXACT pre-session
//      content even when Git would re-materialize it differently on
//      `reset --hard` (e.g. under core.autocrlf, LF<->CRLF) — a file Git treats
//      as clean can still have on-disk bytes a HEAD checkout would not
//      reproduce, so those bytes must be recorded now or they are lost.
//   2. untracked.tar.gz — bytes of every untracked file that is NOT
//      gitignored AND NOT matched by `rollback.exclude` patterns.
//
// Per D2: node-tar with gzip, no native deps, zstd deferred. Per D3:
// `rollback.exclude` is symmetric — what's excluded from capture is also
// the same set restore is forbidden to mutate. snapshotUntracked enforces
// the capture half here; restore.ts enforces the mutation half there.
// **D3 applies to the UNTRACKED surface only — the tracked archive is never
// filtered by `rollback.exclude`.**
//
// Per D4: file hashes are SHA-256 (lowercase hex) computed via streaming.
// Returned in the result so the caller (checkpoint.ts) can build the
// manifest without re-reading any file.
//
// **M B scope: regular file bytes only.** Symlinks, directories, sockets,
// FIFOs, block/char devices, and any other non-regular filesystem entries
// are skipped from both the tarball AND the fileHashes record. Symlink
// snapshot/restore semantics (especially cross-OS) are deferred — capturing
// a symlink as a tar entry while hashing the resolved target bytes would
// produce divergent archive-vs-manifest contents on restore. Excluding
// symlinks entirely is the safest M B contract.
//
// **Tracked-dirty path set (M B step-13 amendment).** snapshotTrackedDirty
// also returns `trackedDirtyPaths` — the FULL set of tracked-dirty paths
// reported by `gitListTrackedDirty`, INCLUDING tracked deletions, symlink
// changes, mode-only changes, and any other dirty tracked entry that is
// NOT a regular file on disk and therefore NOT captured into the tarball.
// This is what gets stored in `manifest.snapshots.tracked_dirty_paths`
// and what restore uses for exact set-parity verification (closes the
// tampering hole where a malicious patch could smuggle an unauthorized
// tracked deletion past file_hashes-only checks). The `files` / `fileHashes`
// pair is a SEPARATE surface: the regular-file subset of ALL present tracked
// files (dirty AND clean), used for raw-byte restoration + content hash
// verification. The two answer different questions and are NOT constrained to
// be subsets of each other — `trackedDirtyPaths` is the git-dirty parity set;
// `fileHashes` keys are every archived regular file.
//
// Path conventions: git emits POSIX paths (forward slashes). node-tar
// stores archive members with the same POSIX paths. Node's `lstat` on
// Windows accepts forward-slash paths joined to an absolute repoRoot. We
// keep POSIX strings end-to-end without translating to OS separators —
// which would be a bug on extract (archives must be portable).

import { lstat, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import picomatch from "picomatch";
import * as tar from "tar";
import { gitListTracked, gitListTrackedDirty, gitListUntracked } from "./git-cli.js";
import { sha256File } from "./hashes.js";

/**
 * Promisified zlib.gzip — used to write empty tar.gz archives without going
 * through `tar.create`, which rejects empty file lists in tar v7+ with
 * "no paths specified to add to archive".
 */
const gzipAsync = promisify(gzipCallback);

/**
 * Result shape for snapshotUntracked. Matches the schema for
 * `Manifest.untracked.file_hashes`: a record from canonical relative POSIX
 * path → lowercase 64-char SHA-256.
 *
 * `files` is the same key set as `fileHashes`, returned as a sorted array
 * for determinism; convenient for the manifest builder which sometimes
 * needs the list separately.
 */
export type SnapshotResult = {
  readonly files: readonly string[];
  readonly fileHashes: Readonly<Record<string, string>>;
};

/**
 * Result shape for snapshotTrackedDirty. Extends `SnapshotResult` with the
 * `trackedDirtyPaths` field — the FULL git-dirty tracked path set from
 * `gitListTrackedDirty` (sorted, deduped), including paths that did NOT make
 * it into the tarball or the `fileHashes` record because they weren't regular
 * files on disk at capture time (deletions, symlink changes, mode-only
 * changes). Stored verbatim in `manifest.snapshots.tracked_dirty_paths`;
 * consumed by restore's set-parity check.
 *
 * `trackedDirtyPaths` and `fileHashes` are INDEPENDENT sets: with the
 * broadened capture, `files`/`fileHashes` cover ALL present tracked regular
 * files, so `trackedDirtyPaths` is no longer a superset of `fileHashes` keys
 * (nor vice versa). Neither the schema nor restore-preflight constrains them
 * to a subset relationship.
 */
export type SnapshotTrackedDirtyResult = SnapshotResult & {
  readonly trackedDirtyPaths: readonly string[];
};

/**
 * Snapshot the raw working-tree bytes of EVERY present tracked regular file
 * (not only the dirty ones), and separately return the git-dirty tracked path
 * set for restore's parity check.
 *
 * Archive/hash source = `gitListTracked()` (all tracked paths from
 * `git ls-files`) filtered to regular files. Capturing clean tracked files'
 * bytes too is deliberate and load-bearing: a file Git considers clean can
 * still have on-disk bytes that a HEAD checkout would not reproduce (e.g. under
 * core.autocrlf), so those bytes must be recorded at checkpoint or they are
 * lost — restore reproduces them exactly from this archive.
 *
 * Filters out (via filterRegularFiles' `lstat`):
 *   - Non-existent paths (ENOENT) — e.g. a tracked file deleted on disk, or a
 *     staged-as-deleted path. The deleted path still appears in
 *     `trackedDirtyPaths` (it is dirty) so restore can verify it; it simply has
 *     no bytes to archive.
 *   - Symbolic links, gitlinks/submodule directories, and other non-regular
 *     entries — per the M B "regular file bytes only" policy. Dirty non-regular
 *     entries still appear in `trackedDirtyPaths`.
 *
 * Writes a gzipped tarball at `archivePath` (parent dir created if missing).
 * `rollback.exclude` is NOT applied here — it governs the untracked surface
 * only. Returns:
 *   - `files` / `fileHashes`: the regular-file set captured into the tarball
 *     (used for raw-byte restoration + content-level hash verification). NOT a
 *     subset or superset of `trackedDirtyPaths`.
 *   - `trackedDirtyPaths`: the FULL git-dirty tracked set from
 *     `gitListTrackedDirty`, sorted-deduped (used for exact set-parity
 *     verification at restore — closes the soundness hole where a tampered
 *     patch could smuggle an unauthorized tracked deletion).
 *
 * An empty result still produces a valid empty .tar.gz at `archivePath`
 * (restore code relies on the file existing).
 */
export async function snapshotTrackedDirty(opts: {
  repoRoot: string;
  archivePath: string;
}): Promise<SnapshotTrackedDirtyResult> {
  // Two independent git surfaces, fetched together:
  //   - dirtyPaths: the git-DIRTY tracked set (parity). Returned verbatim as
  //     trackedDirtyPaths; restore compares it against gitListTrackedDirty() at
  //     restore time. Includes deletions/symlink/mode/type changes that are not
  //     regular files on disk and therefore are NOT archived.
  //   - trackedPaths: EVERY tracked path (git ls-files). Filtered to regular
  //     files below → the archive/hash source.
  const [dirtyPaths, trackedPaths] = await Promise.all([
    gitListTrackedDirty(opts.repoRoot),
    gitListTracked(opts.repoRoot),
  ]);

  // Archive + hash the EXACT same regular-file list. filterRegularFiles lstat's
  // each candidate, so symlinks, gitlinks/submodule dirs, and missing paths
  // (tracked-but-deleted) are skipped — never archived as regular files. Raw
  // bytes come from the working tree (writeTarball's cwd + hashAll), never from
  // Git blobs. Deterministic order: gitListTracked returns sorted-deduped paths
  // (same contract as gitListTrackedDirty), so `files` is stable across runs.
  const files = await filterRegularFiles(opts.repoRoot, trackedPaths);
  await writeTarball(opts.repoRoot, opts.archivePath, files);
  const fileHashes = await hashAll(opts.repoRoot, files);

  // `dirtyPaths` is the raw gitListTrackedDirty output — already sorted and
  // deduped, covering ALL dirty tracked paths (deletions, symlinks, mode-only
  // changes, etc.). Returned verbatim as trackedDirtyPaths so checkpoint.ts can
  // populate manifest.snapshots.tracked_dirty_paths directly (with one final
  // defense-in-depth normalization at the persistence boundary in checkpoint.ts)
  // without re-fetching. NOT constrained to be a superset of `fileHashes` keys.
  return { files, fileHashes, trackedDirtyPaths: dirtyPaths };
}

/**
 * Snapshot all untracked files that are NOT gitignored, NOT matched by
 * `rollbackExcludePatterns`, AND are regular files on disk.
 *
 * Three-layer exclusion:
 *   1. gitignore: handled upstream by `git ls-files --others --exclude-standard`.
 *   2. `rollback.exclude` from .viberevert.yml: applied here via picomatch
 *      (D3). Patterns matched against repo-relative POSIX paths.
 *   3. Non-regular files (symlinks, dirs, etc.): skipped per the M B
 *      "regular file bytes only" policy — see file header comment.
 *
 * D3 locks layer 2 as SYMMETRIC: paths excluded from capture here are the
 * same paths restore.ts is forbidden to mutate. The CLI passes the same
 * `rollbackExcludePatterns` to both call sites.
 *
 * Writes a gzipped tarball at `archivePath`. Creates the parent directory
 * of `archivePath` if missing. Returns the file list + SHA-256 hashes.
 * Empty result still produces a valid empty .tar.gz.
 */
export async function snapshotUntracked(opts: {
  repoRoot: string;
  archivePath: string;
  rollbackExcludePatterns: readonly string[];
}): Promise<SnapshotResult> {
  const candidates = await gitListUntracked(opts.repoRoot);
  const isExcluded = compileExcludeMatcher(opts.rollbackExcludePatterns);
  const afterConfigExclude = candidates.filter((p) => !isExcluded(p));
  // Apply the regular-file filter LAST so we lstat as few entries as possible
  // (config-excluded paths are skipped without touching the disk).
  const files = await filterRegularFiles(opts.repoRoot, afterConfigExclude);
  await writeTarball(opts.repoRoot, opts.archivePath, files);
  const fileHashes = await hashAll(opts.repoRoot, files);
  return { files, fileHashes };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Filter `posixPaths` to entries that exist AND are regular files. Skipped:
 *   - Non-existent paths (ENOENT from lstat).
 *   - Symbolic links (live or dangling). lstat does NOT follow symlinks,
 *     so `st.isFile()` returns false for symlinks even if their target is
 *     a regular file. This is intentional per the M B "regular file bytes
 *     only" policy — symlinks are skipped from both tarball and hashes,
 *     guaranteeing those two contracts agree.
 *   - Directories, sockets, FIFOs, block/char devices.
 *
 * Sequential `await` (not Promise.all): bounds filesystem concurrency and
 * keeps error surfacing simple. If profiling ever shows this is a bottleneck,
 * switch to a bounded-pool pattern.
 */
async function filterRegularFiles(
  repoRoot: string,
  posixPaths: readonly string[],
): Promise<readonly string[]> {
  const out: string[] = [];
  for (const p of posixPaths) {
    try {
      const st = await lstat(`${repoRoot}/${p}`);
      if (st.isFile()) out.push(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return out;
}

/**
 * Compile an excluder function from `rollback.exclude` patterns. Empty list
 * → matcher that excludes nothing (every path passes). Patterns use
 * picomatch with `{ nonegate: true }` — the leading `!` re-include
 * semantics are disabled. For a field named `rollback.exclude`, implicit
 * re-include via `!pattern` is more dangerous than helpful; users who need
 * conditional inclusion should write tighter positive patterns. (M B does
 * NOT support `!pattern` syntax in `rollback.exclude`; doc it in the
 * config schema's notes when it lands.)
 *
 * Patterns are matched against repo-relative POSIX paths.
 */
function compileExcludeMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matcher = picomatch(patterns as string[], { nonegate: true });
  return (path: string) => matcher(path);
}

/**
 * Write a gzipped tarball at `archivePath` containing `files` (repo-relative
 * POSIX paths). Empty `files` produces a valid empty .tar.gz.
 *
 * Creates the parent directory of `archivePath` if missing (mkdir recursive
 * — idempotent). snapshots.ts owns the archive write end-to-end, including
 * the mkdir; callers do NOT need to pre-create the parent.
 *
 * `portable: true` strips system-specific metadata from archive entries —
 * uid/gid/uname/gname/atime/ctime/dev/ino/nlink — so the archive doesn't
 * leak the snapshotting user's account info and stays portable across
 * machines on extraction. Note: mtime IS still encoded per node-tar's
 * portable mode, so two runs of the same input produce byte-identical
 * archives only if the source files' mtimes also match. This is fine for
 * M B because restore correctness depends on per-file SHA-256 hashes from
 * the manifest, NOT on tarball-level byte equality across runs.
 */
async function writeTarball(
  repoRoot: string,
  archivePath: string,
  files: readonly string[],
): Promise<void> {
  // node-tar wants the parent dir to exist for the output file. Use a
  // separator search that handles both POSIX `/` and Windows `\` without
  // depending on path.dirname (which is OS-conditional and would mishandle
  // a POSIX-form absolute path on Windows).
  const lastSlash = archivePath.lastIndexOf("/");
  const lastBackslash = archivePath.lastIndexOf("\\");
  const sepIndex = Math.max(lastSlash, lastBackslash);
  if (sepIndex > 0) {
    await mkdir(archivePath.slice(0, sepIndex), { recursive: true });
  }

  // tar v7's tar.create rejects empty file lists with "no paths specified
  // to add to archive". For the empty case (e.g., no present tracked regular
  // files), write a minimal valid empty tar.gz directly: an empty tar archive
  // is two consecutive 512-byte blocks of zeros (the standard EOF marker),
  // gzipped. tar.list reads this as zero entries — exactly what restore's
  // assertArchiveEntries expects when the corresponding file_hashes is
  // also empty.
  if (files.length === 0) {
    const emptyTar = Buffer.alloc(1024);
    const gz = await gzipAsync(emptyTar);
    await writeFile(archivePath, gz);
    return;
  }

  await tar.create(
    {
      file: archivePath,
      gzip: true,
      cwd: repoRoot,
      portable: true,
    },
    files as string[],
  );
}

/**
 * Compute SHA-256 hashes for every file in `files` sequentially. Returns a
 * record from path → lowercase hex. Path keys match the input paths
 * (repo-relative POSIX), preserving the canonical form used by the manifest
 * schema's `safeStoredRelativePath` validator.
 *
 * Sequential (not `Promise.all`): the tracked-file list can now span the whole
 * repository, so a bounded, one-at-a-time walk avoids opening thousands of hash
 * streams at once. If profiling ever shows checkpointing is too slow, switch to
 * a bounded-pool pattern.
 */
async function hashAll(
  repoRoot: string,
  files: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const entries: Array<readonly [string, string]> = [];
  for (const p of files) {
    entries.push([p, await sha256File(`${repoRoot}/${p}`)] as const);
  }
  return Object.fromEntries(entries);
}
