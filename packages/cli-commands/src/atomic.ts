// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Package-private atomic helpers for the CLI orchestration layer (D17c).
//
// NOT exported from any public CLI surface. NOT registered as a command.
// This file is the THIRD copy of the package-private atomic helpers across
// the codebase — one each in @viberevert/git, @viberevert/core, and the CLI.
// The duplication is INTENTIONAL per D17c: a few duplicated lines per package
// are far cheaper than a cross-package coupling cost OR a leaky public-API
// atomic helper. Each package's atomic surface should describe its DOMAIN,
// not the file-IO primitives it happens to need.
//
// Specifically: the CLI uses `renameDirAtomic` to rename the
// standalone-checkpoint outer dir (`.viberevert/checkpoints/.tmp-checkpoint-<random-hex>/`
// → `.viberevert/checkpoints/<checkpointId>/`) per D13/D17b after git has
// finished writing the checkpoint contents into the temp dir. M C adds a
// SECOND use of `renameDirAtomic`: renaming the ad-hoc-report outer dir
// (`.viberevert/reports/.tmp-rpt-<random-hex>/` →
// `.viberevert/reports/<rpt_ULID>/`) per D26's ad-hoc-storage path for
// `viberevert check` reports that are not session-bound. Inner-session
// checkpoints land inside a session dir whose outer rename is owned by
// core (which has its own private `renameDirAtomic` for that purpose).
//
// M C also adds `writeFileAtomic` to this file. It is used to write
// `report.json` artifacts for `viberevert check` per D26 / D13. Two
// storage paths per D26:
//   - session-bound: `.viberevert/sessions/<sess>/report.json` — direct
//     file-level atomic temp+rename. Re-running check overwrites
//     atomically; last-writer-wins per D44; no `.tmp-*` artifact left
//     behind.
//   - ad-hoc: `.viberevert/reports/<rpt_ULID>/report.json` — the OUTER
//     dir rename uses `renameDirAtomic` (above); the INNER report.json
//     is written via this helper INTO the temp dir BEFORE the outer
//     rename, so a partial inner write cannot become visible to readers.
//
// Session-state files (session.json, before-status.txt, commands.log,
// after-status.txt, active-session.json) continue to be written by core
// using core's private `writeFileAtomic`. Checkpoint files (manifest.json,
// tarballs, patches) continue to be written by git using git's private
// `writeFileAtomic`. The CLI does NOT call into core's or git's private
// helpers for those artifacts; this file is the SOLE atomic surface the
// CLI orchestration layer needs.
//
// M 0.8.0 adds `writeFileExclusiveAtomic`, which is atomic AND no-overwrite.
// It exists because the selective-rollback receipt is recovery EVIDENCE:
// silently replacing one destroys the record of what a prior invocation
// actually did. `writeFileAtomic` cannot serve that case, since its `wx` flag
// protects only the temp path while the final `rename()` overwrites an existing
// destination on POSIX. The new helper is CLI-only and is deliberately outside
// the byte-identical set described below.
//
// Drift warning: the body of `writeFileAtomic` below is BYTE-IDENTICAL
// to the version in `packages/core/src/atomic.ts`, and per D17c
// must remain byte-identical to
// `packages/git/src/atomic.ts`'s `writeFileAtomic` (the three-way
// match across all packages that implement this helper). The body of
// `renameDirAtomic` below is BYTE-IDENTICAL to the version in
// `packages/core/src/atomic.ts` (a two-way match — git does not
// implement `renameDirAtomic`). Any future semantic change to the
// locked D13 atomicity model — e.g., a switch to platform-specific
// renameex on Windows for true rename-overwrite atomicity, a bump in
// temp-suffix entropy, a change to the `wx` flag, etc. — MUST be
// applied to every private copy in lockstep. The duplication is
// intentional; drift is the failure mode.

import { randomBytes } from "node:crypto";
import { link, lstat, rename, unlink, writeFile } from "node:fs/promises";

/**
 * Atomically write `data` to `targetPath`.
 *
 * Writes to a sibling temp path with a random hex suffix
 * (`<targetPath>.tmp.<random-hex>`), then `rename()`s into the final
 * position. `rename()` is atomic on the same filesystem on both POSIX
 * and NTFS — readers see either fully-old or fully-new content, never
 * partial.
 *
 * `flag: "wx"` enforces "create new file or fail with EEXIST" on the
 * temp path: two concurrent writes to the same `targetPath` each pick
 * distinct random suffixes (64 bits of entropy), so EEXIST is
 * astronomically unlikely; if one ever does occur, the write fails
 * loudly rather than silently overwriting an in-flight peer's temp
 * file.
 */
export async function writeFileAtomic(targetPath: string, data: Buffer | string): Promise<void> {
  const suffix = randomBytes(8).toString("hex");
  const tempPath = `${targetPath}.tmp.${suffix}`;
  await writeFile(tempPath, data, { flag: "wx" });
  await rename(tempPath, targetPath);
}

/**
 * Atomically rename `tmpDir` → `finalDir`. Fails loudly if `finalDir`
 * already exists in non-racing/stale states.
 *
 * The locked rule for the standalone-checkpoint outer dir per D13: the
 * final id-based dir name must be unique. Checkpoint IDs are ULID-based
 * (extremely high uniqueness across machines and time); the D22
 * checkpoint-name lock serializes name-uniqueness scans (when --name is
 * supplied); the final dir genuinely should not exist before this
 * rename. A pre-existing destination is a serious failure mode —
 * possibly a ULID collision (astronomically unlikely), possibly stale
 * leftover from a previous crash — and the right response is loud
 * failure, NOT silent overwrite.
 *
 * Cross-platform note: Node's `rename()` behavior on existing
 * destinations differs between POSIX (often overwrites) and Windows
 * (often fails). To get consistent fail-if-exists semantics under
 * non-racing conditions, this helper pre-checks via `lstat`.
 *
 * **This helper is NOT a standalone no-replace primitive under
 * arbitrary concurrent callers.** The no-collision guarantee comes
 * from the caller's D22 exclusive lock where one is acquired, plus
 * ULID uniqueness for id-based destinations. This helper provides
 * the final same-filesystem atomic visibility step and a defensive
 * fail-if-destination-already-exists check for non-racing/stale
 * states.
 *
 * Portably closing the `lstat`→`rename` TOCTOU at this layer is not
 * straightforward in Node: `fs.promises` operations are not
 * synchronized under concurrent modification, and while exclusive
 * file creation flags (`wx`) cover the `writeFileAtomic` case, no
 * equivalent portable primitive exists for atomic-no-replace
 * directory rename. The right place to enforce no-racing-callers
 * is at the call-site (e.g., a future grep/invariant test asserting
 * that `renameDirAtomic` is only invoked inside `withExclusiveLock`
 * flows, plus auditing nameless-checkpoint flows for ULID-uniqueness
 * sufficiency) — not a fragile concurrency attempt inside the helper
 * itself.
 *
 * `rename()` itself is atomic on the same filesystem on both POSIX and
 * NTFS (per the locked D13 cross-filesystem caveat: `.viberevert/`
 * lives at the repo root, so all temp-and-final paths are siblings on
 * the same mount).
 */
export async function renameDirAtomic(tmpDir: string, finalDir: string): Promise<void> {
  let destExists = false;
  try {
    await lstat(finalDir);
    destExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (destExists) {
    throw new Error(`renameDirAtomic: destination already exists: ${finalDir}`);
  }
  await rename(tmpDir, finalDir);
}

/**
 * Write `data` to `targetPath` atomically AND exclusively: the destination is
 * created only if it does not already exist, and readers never see a partial
 * file.
 *
 * `writeFileAtomic` above provides only the first half. Its `wx` flag protects
 * the TEMP path, and the final `rename()` overwrites an existing destination on
 * POSIX, per the cross-platform note on `renameDirAtomic`. For an artifact that
 * is evidence rather than a cache, a silent replacement destroys the record of
 * what happened, so `rename` is not usable here and there is deliberately NO
 * fallback to it. On a filesystem without hard links this helper fails loudly
 * instead of quietly degrading to overwrite semantics.
 *
 * The sequence:
 *
 *   1. write the temp file with `wx`, as a SIBLING of the destination so the
 *      link cannot fail with EXDEV;
 *   2. `link(tempPath, targetPath)`, which fails with EEXIST when the
 *      destination exists and is atomic when it does not;
 *   3. remove the temp path, best effort.
 *
 * Cleanup on failure, per step, because "whose file is it" differs:
 *
 *   - step 1 EEXIST: the temp path was NOT created by this call, so it belongs
 *     to a concurrent writer and is left ALONE. Removing it would destroy a
 *     peer's in-flight write.
 *   - step 1, any other error: this call may have created a partial file at the
 *     temp path, so it is removed best effort.
 *   - step 2, any error: the temp file is this call's and nothing was
 *     published, so it is removed best effort.
 *
 * In every case the ORIGINAL error is rethrown with its `code` intact. `EEXIST`
 * from step 2 means the DESTINATION already existed and was left untouched,
 * which is the refusal this helper exists to provide.
 *
 * Step 3 is best effort BY CONTRACT. Once the link succeeds the destination IS
 * published; a failure to unlink the temp path leaves a `.tmp.<hex>` sibling and
 * nothing else. Reporting that as a write failure would tell the caller the
 * artifact is missing when it is present, which for a recovery receipt is the
 * dangerous direction for the error to point.
 *
 * Windows note: hard links require NTFS. Not a durability primitive: like every
 * other helper here it does not fsync, matching the project's existing
 * persistence model.
 *
 * DELIBERATELY NOT part of the three-way byte-identical set described in the
 * drift warning above. `@viberevert/core` and `@viberevert/git` do not
 * implement it and must not have it copied into them speculatively.
 */
export async function writeFileExclusiveAtomic(
  targetPath: string,
  data: Buffer | string,
): Promise<void> {
  const suffix = randomBytes(8).toString("hex");
  const tempPath = `${targetPath}.tmp.${suffix}`;

  try {
    await writeFile(tempPath, data, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      await unlink(tempPath).catch(() => {});
    }
    throw err;
  }

  try {
    await link(tempPath, targetPath);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }

  await unlink(tempPath).catch(() => {});
}
