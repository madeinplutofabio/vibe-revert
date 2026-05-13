// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Package-private atomic-write + atomic-rename helpers (D17c).
//
// NOT exported from src/index.ts. Each package owns its own private
// atomic helpers — intentional duplication with @viberevert/git's
// atomic.ts and the CLI's atomic.ts to keep the public surface of each
// package describing its DOMAIN, not its file-IO primitives. The price
// of three ~15-line copies is much smaller than a cross-package
// coupling cost or a leaky public-API atomic helper.
//
// Specifically: core writes session-state files via writeFileAtomic
// (session.json, before-status.txt, after-status.txt, commands.log,
// active-session.json), and renames the outer session dir
// (.tmp-sess_<ULID>/ → sess_<ULID>/) via renameDirAtomic. git's atomic
// helper has only writeFileAtomic because git doesn't own dir renames
// (the caller hands git a checkpointDir and renames it later); cli's
// atomic helper has only renameDirAtomic because the CLI only renames
// the standalone-checkpoint outer dir.
//
// writeFileAtomic uses the random-hex-suffix temp pattern with
// `flag: "wx"` exclusivity per D13 — concurrent writes to the same
// target each pick distinct random suffixes (64 bits of entropy), so
// EEXIST collisions are astronomically unlikely; if one ever does
// occur, the helper fails loudly rather than silently overwriting an
// in-flight peer's temp file. There is no cleanup-on-failure for the
// temp file: per D13, leftover `*.tmp.<random-hex>` siblings are inert
// (loaders read only the paths the manifest references, never
// blind-iterate dir contents), and a future `viberevert gc` (deferred)
// sweeps them. M B explicitly tolerates them.

import { randomBytes } from "node:crypto";
import { lstat, rename, writeFile } from "node:fs/promises";

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
 * The locked rule for session dirs per D13: the final id-based dir
 * name must be unique. Session IDs are ULID-based (extremely high
 * uniqueness across machines and time); the D22 start-lock serializes
 * session creation; the final dir genuinely should not exist before
 * this rename. A pre-existing destination is a serious failure mode —
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
 * flows) — not a fragile concurrency attempt inside the helper
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
