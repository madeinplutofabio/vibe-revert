// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Package-private atomic-rename helper for the CLI orchestration layer (D17c).
//
// NOT exported from any public CLI surface. NOT registered as a command.
// This file is the THIRD copy of the package-private atomic helpers across
// the codebase — one each in @viberevert/git, @viberevert/core, and the CLI.
// The duplication is INTENTIONAL per D17c: a few duplicated lines per package
// are far cheaper than a cross-package coupling cost OR a leaky public-API
// atomic helper. Each package's atomic surface should describe its DOMAIN,
// not the file-IO primitives it happens to need.
//
// Specifically: the CLI uses `renameDirAtomic` exactly once — to rename the
// standalone-checkpoint outer dir (`.viberevert/checkpoints/.tmp-checkpoint-<random-hex>/`
// → `.viberevert/checkpoints/<checkpointId>/`) per D13/D17b after git has
// finished writing the checkpoint contents into the temp dir. That's the
// only orchestration-level rename the CLI owns. Inner-session checkpoints
// land inside a session dir whose outer rename is owned by core (which has
// its own private `renameDirAtomic` for that purpose).
//
// The CLI does NOT need `writeFileAtomic`: the CLI never writes individual
// trust-critical files. Session-state files (session.json, before-status.txt,
// commands.log, after-status.txt, active-session.json) are written by core
// using core's private `writeFileAtomic`. Checkpoint files (manifest.json,
// tarballs, patches) are written by git using git's private `writeFileAtomic`.
//
// The body of `renameDirAtomic` is BYTE-IDENTICAL to the version in
// `packages/core/src/atomic.ts` — D17c warns against drift, so any future
// semantic change to the locked D13 atomicity model (e.g., a switch to
// platform-specific renameex on Windows for true rename-overwrite atomicity)
// MUST be applied to every private copy that implements this helper
// (currently core + CLI) in lockstep.

import { lstat, rename } from "node:fs/promises";

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
