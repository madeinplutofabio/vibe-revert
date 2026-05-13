// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Checkpoint create / load / list — the trust-critical core of M B.
//
// Locked flow per D17b: createCheckpoint writes INTO a caller-provided
// `checkpointDir`. The caller (CLI) chooses the dir's location (typically a
// `.tmp-checkpoint-<random>/` sibling of the final destination) and is
// responsible for the OUTER atomic rename to the final id-named dir
// (`cp_<ULID>/`) once createCheckpoint returns. checkpoint.ts itself never
// renames anything — it just writes file contents into the dir it was
// given.
//
// The returned `{ checkpointId }` is the id git generated internally; the
// caller uses it to construct the final dir name. The return type
// intentionally does NOT include `manifestPath` — any path returned during
// creation would point inside the temp dir and become stale the moment the
// caller renames the outer dir; callers compute the final manifest path as
// `<repoRoot>/.viberevert/checkpoints/<checkpointId>/manifest.json` after
// the rename completes (D17b).
//
// Symlink-strict throughout. All three public functions reject symlinks at
// the relevant boundaries:
//   - createCheckpoint refuses if `checkpointDir` resolves to anything other
//     than a real directory (lstat + isDirectory). A symlinked container
//     would silently land artifacts elsewhere on disk.
//   - loadCheckpoint refuses if `manifest.json` is not a regular file
//     (lstat + isFile), and refuses any referenced artifact (the two diff
//     patches, the two tarballs) that isn't a regular file.
//   - listCheckpoints lstats each candidate `cp_<ULID>` entry; symlinks
//     (even to real checkpoint dirs) are silently skipped at the iteration
//     boundary.
//
// loadCheckpoint and listCheckpoints honor D13's `.tmp-*` skip rule and
// D23's missing-state contract:
//   - loadCheckpoint throws CheckpointNotFoundError for missing dirs/manifests
//     AND for any path whose basename starts with `.tmp-` (temp dirs are
//     never valid checkpoints, even when explicitly requested).
//   - loadCheckpoint also throws CheckpointCorruptError on JSON parse
//     failure, schema validation failure, or missing/non-regular referenced
//     artifacts. NOT hash verification — that's restore.ts's job; this is
//     just an existence + type check that keeps CheckpointCorruptError
//     honest and catches broken checkpoints early instead of at restore time.
//   - listCheckpoints returns [] when `.viberevert/checkpoints/` is absent
//     (NOT an error — fresh repo).
//   - listCheckpoints additionally enforces D6's standalone-checkpoint
//     invariant: `manifest.session_id === <dir-name id>`. Inner-session
//     checkpoints (which legitimately have `session_id = sess_<ULID>`) live
//     under `.viberevert/sessions/...`, NOT here, so they are not affected.
//     A mismatch here is treated as CheckpointCorruptError.
//
// listCheckpoints fails loudly on a corrupt entry: if any individual
// checkpoint's manifest fails to load or validate, the error propagates.
// D13's structured-warnings shape (`{ items, warnings }`) is reserved for
// `core.listSessions` for now; `git.listCheckpoints` does not need it yet
// per the plan's locked text. Future M C/M D may extend.

import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type Manifest,
  ManifestSchema,
  normalizePathArray,
  normalizeStringArray,
  SCHEMA_VERSION,
} from "@viberevert/session-format";
import { writeFileAtomic } from "./atomic.js";
import { CheckpointCorruptError, CheckpointNotFoundError } from "./errors.js";
import {
  getBranch,
  getHeadSha,
  getStatusPorcelainText,
  gitDiffStaged,
  gitDiffUnstaged,
} from "./git-cli.js";
import { generateCheckpointId } from "./ids.js";
import { snapshotTrackedDirty, snapshotUntracked } from "./snapshots.js";

// =============================================================================
// Public types
// =============================================================================

/**
 * Summary of one checkpoint as returned by `listCheckpoints`. Field names
 * match D20's `--json` output contract verbatim (snake_case) so CLI's JSON
 * printer is trivial (`JSON.stringify` of the array).
 *
 * `name` is the optional `--name` label from when the checkpoint was created
 * (D15), or `null` if no label was supplied. Always present in the summary
 * (NOT omitted), per D20's "null for missing fields" rule.
 *
 * `path` is repo-relative POSIX (e.g., `.viberevert/checkpoints/cp_01JV...`).
 */
export type CheckpointSummary = {
  readonly id: string;
  readonly name: string | null;
  readonly created_at: string;
  readonly head_sha: string;
  readonly path: string;
};

// =============================================================================
// Constants
// =============================================================================

const CHECKPOINTS_DIR = ".viberevert/checkpoints";
const ROLLBACK_SUBDIR = "rollback";
const MANIFEST_FILENAME = "manifest.json";
const UNSTAGED_PATCH_REL = `${ROLLBACK_SUBDIR}/unstaged.patch`;
const STAGED_PATCH_REL = `${ROLLBACK_SUBDIR}/staged.patch`;
const TRACKED_DIRTY_ARCHIVE_REL = `${ROLLBACK_SUBDIR}/tracked-dirty.tar.gz`;
const UNTRACKED_ARCHIVE_REL = `${ROLLBACK_SUBDIR}/untracked.tar.gz`;

/** Matches `cp_<26-char Crockford base32 ULID>`. */
const CHECKPOINT_DIR_NAME_RE = /^cp_[0-9A-HJKMNP-TV-Z]{26}$/;

// =============================================================================
// createCheckpoint
// =============================================================================

/**
 * Create a checkpoint. Writes manifest + rollback artifacts into the
 * caller-provided `checkpointDir`. Locked signature per D17b; see the file
 * header for the why.
 *
 * Behavior per opts:
 *   - `repoRoot`: absolute path to the git repo root. All git invocations
 *     run with this as cwd.
 *   - `checkpointDir`: absolute path to the dir where checkpoint contents
 *     will be written. Created with `mkdir({ recursive: true })` if missing
 *     — caller may pre-create or not. **MUST be a real directory** (not a
 *     symlink, regular file, etc.) and **MUST be empty if it already
 *     exists**: any pre-existing entries (including stale `*.tmp.<hex>`
 *     siblings from a crashed prior attempt) cause a thrown Error, on the
 *     "fail loudly" trust-critical principle. NOT renamed by this function;
 *     the caller owns the OUTER atomic rename to the final `cp_<id>/` name.
 *   - `rollbackExcludePatterns`: passed through to `snapshotUntracked` for
 *     the D3 capture-side exclude. The caller (CLI) resolves these from
 *     `.viberevert.yml`; git itself never reads config (D16).
 *   - `name`: optional human label, stored verbatim in `manifest.name`
 *     (D15). Caller enforces uniqueness BEFORE calling per D5b/D22 — git
 *     does not check for collisions here.
 *   - `sessionId`: optional override for `manifest.session_id`. For
 *     standalone checkpoints, the caller omits it and git defaults to the
 *     just-generated `checkpointId` (per D6: "this manifest's parent
 *     record"). For inner-session checkpoints, the caller passes the
 *     owning session's `sess_<ULID>`.
 *
 * Returns `{ checkpointId }`. The string already includes the `cp_` prefix
 * per D5; do NOT prepend `cp_` again (per D17b's anti-pattern callout).
 */
export async function createCheckpoint(opts: {
  repoRoot: string;
  checkpointDir: string;
  rollbackExcludePatterns: readonly string[];
  name?: string;
  sessionId?: string;
}): Promise<{ checkpointId: string }> {
  const checkpointId = generateCheckpointId();
  const manifestSessionId = opts.sessionId ?? checkpointId;

  // Idempotent: succeeds whether or not the dir exists. Caller may
  // pre-create (e.g., as part of an outer `.tmp-checkpoint-<random>/`
  // construction) or leave it to us.
  await mkdir(opts.checkpointDir, { recursive: true });

  // Symlink-strict guard. lstat (NOT stat) so a symlink-to-dir fails
  // isDirectory(). Without this check, a caller-provided symlinked path
  // would silently land artifacts at the link target — the manifest would
  // describe one location while writes happened elsewhere on disk.
  // Matches the symlink stance of loadCheckpoint and listCheckpoints.
  const checkpointDirStat = await lstat(opts.checkpointDir);
  if (!checkpointDirStat.isDirectory()) {
    throw new Error(
      `createCheckpoint: checkpointDir is not a real directory: ${opts.checkpointDir}`,
    );
  }

  // Strict emptiness guard. A reused temp dir (e.g., leftover from a
  // crashed prior attempt the caller forgot to clean) would silently keep
  // stale junk alongside the new checkpoint — after the outer rename, the
  // final `cp_<id>/` would carry garbage the manifest doesn't reference.
  // Refuse loudly instead. Any entries (regular files, dirs, stale
  // `*.tmp.<hex>` siblings, anything) trigger the throw.
  const existingEntries = await readdir(opts.checkpointDir);
  if (existingEntries.length > 0) {
    throw new Error(
      `createCheckpoint: checkpointDir is not empty: ${opts.checkpointDir} (found: ${existingEntries.join(", ")}). Pass a fresh or empty dir.`,
    );
  }

  // Capture git state in parallel. The captured_at timestamp is sampled
  // here, AFTER mkdir but BEFORE any git invocation, so it reflects the
  // moment we begin sampling — close enough to the actual sample time
  // that the seconds-precision manifest field is meaningful.
  const capturedAt = nowIsoSecondPrecision();
  const [headSha, branchOrNull, porcelainText, unstagedPatch, stagedPatch] = await Promise.all([
    getHeadSha(opts.repoRoot),
    getBranch(opts.repoRoot),
    getStatusPorcelainText(opts.repoRoot),
    gitDiffUnstaged(opts.repoRoot),
    gitDiffStaged(opts.repoRoot),
  ]);

  // ManifestSchema requires `git.branch` to be a non-blank string. If
  // we're on a detached HEAD, getBranch returns null — fall back to the
  // literal "(detached)" so the manifest still validates. (Restore code
  // does NOT consume `branch` semantically; it's audit info only.)
  const branch = branchOrNull ?? "(detached)";

  // Write the two diff files atomically. Their parent dir is
  // `<checkpointDir>/rollback/`, which we'll also need for the tarballs;
  // mkdir it once now, even though writeTarball would mkdir it too —
  // we save the per-call check.
  const rollbackDir = join(opts.checkpointDir, ROLLBACK_SUBDIR);
  await mkdir(rollbackDir, { recursive: true });

  const unstagedPatchAbs = join(opts.checkpointDir, UNSTAGED_PATCH_REL);
  const stagedPatchAbs = join(opts.checkpointDir, STAGED_PATCH_REL);
  const trackedArchiveAbs = join(opts.checkpointDir, TRACKED_DIRTY_ARCHIVE_REL);
  const untrackedArchiveAbs = join(opts.checkpointDir, UNTRACKED_ARCHIVE_REL);

  // Patches + snapshots in parallel. The two snapshot calls each spawn
  // their own git invocations and tarball writes; running them concurrently
  // overlaps the I/O.
  const [, , trackedSnap, untrackedSnap] = await Promise.all([
    writeFileAtomic(unstagedPatchAbs, unstagedPatch),
    writeFileAtomic(stagedPatchAbs, stagedPatch),
    snapshotTrackedDirty({
      repoRoot: opts.repoRoot,
      archivePath: trackedArchiveAbs,
    }),
    snapshotUntracked({
      repoRoot: opts.repoRoot,
      archivePath: untrackedArchiveAbs,
      rollbackExcludePatterns: opts.rollbackExcludePatterns,
    }),
  ]);

  // Build the manifest. The optional `name` field is omitted (not set to
  // null) when not supplied, per ManifestSchema's `nonBlankString.optional()`
  // (the schema rejects an explicit null; only undefined / absent is OK).
  //
  // `tracked_dirty_paths` (M B step-13 amendment) is the FULL tracked-dirty
  // set returned by snapshotTrackedDirty — including deletions, symlinks,
  // and other non-regular entries that did NOT make it into the tarball
  // and therefore are NOT keys in `file_hashes`. This is what restore uses
  // for exact set-parity verification of the tracked-dirty surface (closes
  // the soundness hole where a tampered patch could smuggle an
  // unauthorized tracked deletion past file_hashes-only checks).
  //
  // `normalizePathArray` (NOT `normalizeStringArray`) is intentional: this
  // is a path array, and trimming whitespace from path entries would
  // silently rewrite legitimate filenames at the manifest boundary —
  // breaking the trust-preserving principle that what we capture is what
  // we restore. snapshotTrackedDirty's `trackedDirtyPaths` is already
  // sorted-deduped (it's the raw `gitListTrackedDirty` output); the call
  // here is defense-in-depth normalization at the persistence boundary.
  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    session_id: manifestSessionId,
    captured_at: capturedAt,
    git: {
      head_sha: headSha,
      branch,
      porcelain_v1: porcelainText,
    },
    diffs: {
      unstaged_patch_path: UNSTAGED_PATCH_REL,
      staged_patch_path: STAGED_PATCH_REL,
    },
    snapshots: {
      tracked_dirty_archive_path: TRACKED_DIRTY_ARCHIVE_REL,
      tracked_dirty_paths: normalizePathArray(trackedSnap.trackedDirtyPaths),
      file_hashes: trackedSnap.fileHashes,
    },
    untracked: {
      archive_path: UNTRACKED_ARCHIVE_REL,
      // exclude_patterns (M B Step 3e): captured restore-time policy
      // persisted as a normalized set so restore can detect
      // bidirectional `rollback.exclude` drift (RestoreExcludeDriftError).
      // normalizeStringArray (NOT normalizePathArray) — these are glob
      // STRINGS, not paths, so trim is appropriate. Sort + dedup are
      // sound under D3's unordered-deny-list contract (nonegate: true);
      // see schemas.ts's Manifest section docstring for the full
      // load-bearing reasoning.
      exclude_patterns: normalizeStringArray(opts.rollbackExcludePatterns),
      file_hashes: untrackedSnap.fileHashes,
    },
    rollback_target_description: `Restore to pre-checkpoint state captured at ${capturedAt}`,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  };

  // Validate before writing. If we ever drift the schema vs. the
  // manifest-builder code above, this is the loud failure point.
  ManifestSchema.parse(manifest);

  const manifestPath = join(opts.checkpointDir, MANIFEST_FILENAME);
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

  return { checkpointId };
}

// =============================================================================
// loadCheckpoint
// =============================================================================

/**
 * Read a checkpoint's manifest, validate it, and verify that the artifacts
 * it references actually exist as regular files. Throws:
 *   - `CheckpointNotFoundError` if `checkpointDir` does not exist, OR its
 *     `manifest.json` is missing, OR `basename(checkpointDir)` starts with
 *     `.tmp-` (D13/D23 — temp dirs are construction/crash markers, never
 *     valid checkpoints, even when explicitly requested by absolute path).
 *   - `CheckpointCorruptError` if `manifest.json` exists but is not a
 *     regular file (symlink/dir/etc.), cannot be parsed as JSON, fails
 *     `ManifestSchema` validation, OR references an artifact path (one of
 *     the two diff patches or the two tarballs) that does not exist or is
 *     not a regular file. The artifact check uses `lstat` + `isFile()` —
 *     symlink tampering counts as corruption.
 *
 * Does NOT verify file hashes — that's restore.ts's job (the rollback
 * verify step). loadCheckpoint stays cheap: lstat + parse + schema + 4 lstats.
 *
 * Does NOT enforce `manifest.session_id === <dir-name id>` — that's the
 * standalone-checkpoint invariant per D6 and only applies to entries under
 * `.viberevert/checkpoints/`. Inner-session checkpoints legitimately have
 * `session_id = sess_<ULID>` (the parent session's id). listCheckpoints,
 * which knows it's iterating standalone checkpoints, enforces the
 * invariant; loadCheckpoint stays location-agnostic.
 */
export async function loadCheckpoint(checkpointDir: string): Promise<Manifest> {
  if (basename(checkpointDir).startsWith(".tmp-")) {
    throw new CheckpointNotFoundError(
      checkpointDir,
      "checkpoint dir name starts with '.tmp-' (reserved for in-progress or crash-interrupted writes per D13)",
    );
  }

  const manifestPath = join(checkpointDir, MANIFEST_FILENAME);

  // Pre-check: manifest.json must exist as a regular file. Without this,
  // readFile would happily follow a symlinked manifest, opening the door
  // to silent tampering. Symlink/dir/socket/etc. → CheckpointCorruptError.
  let manifestStat: Stats;
  try {
    manifestStat = await lstat(manifestPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CheckpointNotFoundError(checkpointDir, `manifest.json not found`, err);
    }
    throw err;
  }
  if (!manifestStat.isFile()) {
    throw new CheckpointCorruptError(checkpointDir, "manifest.json is not a regular file");
  }

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // TOCTOU: manifest.json existed at lstat time but was deleted before
      // readFile completed (race with a concurrent process). Surface as
      // not-found rather than an opaque ENOENT.
      throw new CheckpointNotFoundError(
        checkpointDir,
        `manifest.json not found (raced concurrent deletion)`,
        err,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CheckpointCorruptError(checkpointDir, "manifest.json is not valid JSON", err);
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new CheckpointCorruptError(
      checkpointDir,
      `manifest.json failed schema validation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      result.error,
    );
  }

  // Verify the four artifacts referenced by the manifest exist as regular
  // files. Existence + type check only; hashes are restore's concern.
  // Symlinks fail the check (lstat does not follow), matching snapshots.ts's
  // "regular files only" stance — symlink tampering counts as corruption.
  const artifactPaths: readonly string[] = [
    result.data.diffs.unstaged_patch_path,
    result.data.diffs.staged_patch_path,
    result.data.snapshots.tracked_dirty_archive_path,
    result.data.untracked.archive_path,
  ];
  await Promise.all(
    artifactPaths.map(async (rel) => {
      const abs = join(checkpointDir, rel);
      let st: Stats;
      try {
        st = await lstat(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new CheckpointCorruptError(
            checkpointDir,
            `referenced artifact missing: ${rel}`,
            err,
          );
        }
        throw err;
      }
      if (!st.isFile()) {
        throw new CheckpointCorruptError(
          checkpointDir,
          `referenced artifact is not a regular file: ${rel}`,
        );
      }
    }),
  );

  return result.data;
}

// =============================================================================
// listCheckpoints
// =============================================================================

/**
 * List all checkpoints under `<repoRoot>/.viberevert/checkpoints/`. Returns
 * an array of summaries sorted by id DESCENDING (newest first per D12 —
 * works because ULIDs are timestamp-prefixed).
 *
 * Per D23: returns `[]` if `.viberevert/checkpoints/` is absent (fresh repo
 * — NOT an error). Per D13: skips entries whose name starts with `.tmp-`
 * AND entries that don't match the `cp_<ULID>` shape (anything malformed
 * sitting in the dir is ignored as garbage at directory-iteration time, NOT
 * later in parsing).
 *
 * Each surviving candidate is then lstat'd: only real directories pass.
 * Symlinks (even to real checkpoint dirs) are silently skipped — symlinked
 * containers should not masquerade as standalone checkpoints under
 * `.viberevert/checkpoints/`.
 *
 * Enforces D6's standalone-checkpoint invariant: for each kept entry, the
 * loaded manifest's `session_id` MUST equal the directory name (the
 * `cp_<ULID>` id). A mismatch surfaces as `CheckpointCorruptError`. (Inner-
 * session checkpoints legitimately have `session_id = sess_<ULID>` and
 * live under `.viberevert/sessions/...`, NOT here, so the invariant holds.)
 *
 * Fails loudly if any kept entry's manifest fails to load or validate, or
 * violates the session_id-equals-dir-id invariant — the error from
 * `loadCheckpoint` (or the explicit invariant check) propagates. D13's
 * structured-warnings shape is reserved for `core.listSessions` for now;
 * when `git.listCheckpoints` grows similar concerns, switch to a
 * `{ items, warnings }` return shape.
 */
export async function listCheckpoints(repoRoot: string): Promise<readonly CheckpointSummary[]> {
  const checkpointsDirAbs = join(repoRoot, CHECKPOINTS_DIR);

  let entries: readonly string[];
  try {
    entries = await readdir(checkpointsDirAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const validIds = entries.filter((name) => CHECKPOINT_DIR_NAME_RE.test(name));

  // Per D13: blind-scan code MUST skip `.tmp-*` siblings at iteration time.
  // The CHECKPOINT_DIR_NAME_RE check above already excludes them (they
  // don't match the cp_<ULID> shape), but a defensive belt-and-braces
  // assertion costs nothing and documents the intent at the iteration
  // boundary.
  const safeIds = validIds.filter((name) => !name.startsWith(".tmp-"));

  // Confirm each entry is a REAL directory (not a symlink, not a regular
  // file named `cp_xyz`). Skip non-dir entries silently; they're garbage
  // at this iteration boundary. lstat (NOT stat) so symlinks-to-dirs fail
  // the isDirectory() check — symlinked containers should not masquerade
  // as standalone checkpoints.
  const summaries: CheckpointSummary[] = [];
  for (const id of safeIds) {
    const dirAbs = join(checkpointsDirAbs, id);
    const st = await lstat(dirAbs);
    if (!st.isDirectory()) continue;

    const manifest = await loadCheckpoint(dirAbs);

    // D6 standalone invariant: dir id must equal manifest.session_id. This
    // check belongs HERE (location-aware), not in loadCheckpoint (which is
    // location-agnostic and may legitimately load inner-session checkpoints
    // whose session_id is the parent session's sess_<ULID>).
    if (manifest.session_id !== id) {
      throw new CheckpointCorruptError(
        dirAbs,
        `standalone checkpoint invariant violation per D6: manifest.session_id (${manifest.session_id}) does not match dir id (${id})`,
      );
    }

    summaries.push({
      id,
      name: manifest.name ?? null,
      created_at: manifest.captured_at,
      head_sha: manifest.git.head_sha,
      path: `${CHECKPOINTS_DIR}/${id}`,
    });
  }

  // ULIDs are lexicographically sortable AND chronologically sortable, so
  // a descending string sort gives newest-first per D12.
  summaries.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  return summaries;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Returns the current time as an ISO 8601 string with seconds precision and
 * `Z` offset (e.g., `2026-05-04T10:30:11Z`). Matches the `precision: 0,
 * offset: true` constraint on `ManifestSchema.captured_at`.
 *
 * Date.toISOString() always emits `YYYY-MM-DDTHH:mm:ss.sssZ` form, so we
 * can deterministically chop the `.sss` to get seconds precision.
 */
function nowIsoSecondPrecision(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
