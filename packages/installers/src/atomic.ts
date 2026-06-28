// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Package-private atomic-write helper for @viberevert/installers (D17c).
//
// NOT exported from src/index.ts. This file is the FOURTH copy of the
// package-private writeFileAtomic helper across the codebase — one each
// in @viberevert/git, @viberevert/core, @viberevert/cli-commands, and
// now @viberevert/installers (M G1b Step 2). The duplication is
// INTENTIONAL per D17c: a few duplicated lines per package are far
// cheaper than a cross-package coupling cost OR a leaky public-API
// atomic helper. Each package's atomic surface should describe its
// DOMAIN, not the file-IO primitives it happens to need.
//
// Specifically: @viberevert/installers uses this helper to write
//   - target user-config files (.cursor/mcp.json, .mcp.json,
//     .github/workflows/viberevert.yml, .git/hooks/pre-commit, etc.)
//   - .viberevert/integrations.json (the integrations store, per D101.C)
//   - .viberevert/integration-journal/<txn-id>.json (recovery journal
//     entries, per D101.M; journal writes are atomic per D101.M's
//     "writeJournal/updateJournal use the same writeFileAtomic" rule)
//   - .viberevert/integration-backups/<recordKey>/<UTC>/<sha-12>--<basename>
//     (pre-mutation backups, per D101.E)
// All of these go through writeFileAtomic so a crash mid-write can
// never leave a half-written file visible to readers. The lock dir
// (.viberevert/integrations.lock/) is acquired via mkdir and released
// via rmdir; that flow does not use writeFileAtomic. Installers never
// renames a directory, so the renameDirAtomic helper present in
// core's/cli-commands' copies is intentionally absent here.
//
// Drift warning: the body of `writeFileAtomic` below is BYTE-IDENTICAL
// to the version in `packages/core/src/atomic.ts`,
// `packages/git/src/atomic.ts`, and `packages/cli-commands/src/atomic.ts`
// per D17c. Any future semantic change to the locked D13 atomicity
// model — e.g., a switch to platform-specific renameex on Windows for
// true rename-overwrite atomicity, a bump in temp-suffix entropy, a
// change to the `wx` flag, etc. — MUST be applied to every private
// copy in lockstep. The duplication is intentional; drift is the
// failure mode.

import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

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
