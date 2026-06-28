// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Collision-resistant backup filename encoding per D101.E.
//
// The integrations-backup directory layout is:
//   .viberevert/integration-backups/<recordKey>/<backupGroupId>/<sha256-12>--<basename>
//
// This helper produces the trailing "<sha256-12>--<basename>" leaf;
// the engine prepends the directory path. backupGroupId must be unique
// per install transaction, typically "<UTC>--<transactionId>" — plain
// UTC seconds are NOT sufficient (CI/test loops can run two install
// transactions in the same second).
//
// Two distinct pathRelative inputs with overlapping basenames (e.g.
// ".cursor/mcp.json" and ".mcp.json", which both share basename
// "mcp.json") cannot collide on the leaf because the sha256-12 prefix
// is computed over the FULL pathRelative, not just the basename.
//
// 48 bits of deterministic hash prefix; collision probability between
// distinct pathRelative values is negligible for the
// ~100s-of-backups-per-transaction scale we expect. Repeated backups of
// the same pathRelative produce the same leaf, so the engine must place
// each install transaction in a unique backup directory (per
// backupGroupId above) OR refuse if the destination leaf already
// exists. The latter is the right belt-and-braces: backup writes
// should use `{ flag: "wx" }` create-new semantics so a stale or
// duplicate destination becomes a hard safety refusal, not a silent
// last-writer-wins.

import { createHash } from "node:crypto";
import { posix } from "node:path";

/**
 * Compute the collision-proof backup-file leaf name for an
 * `originalPathRelative` (POSIX form, as stored in PathSpec).
 *
 * Returns `"<sha256-12>--<basename>"`, e.g.:
 *   encodeBackupPath(".cursor/mcp.json")
 *     // → "8a4f3b9c1e2d--mcp.json"
 *
 * The output is DETERMINISTIC: same input always produces same leaf.
 * Transaction-level uniqueness lives in the engine's backupGroupId
 * directory, not in this helper.
 *
 * Composed by the engine into:
 *   .viberevert/integration-backups/<recordKey>/<backupGroupId>/<this-leaf>
 */
export function encodeBackupPath(originalPathRelative: string): string {
  const sha12 = createHash("sha256")
    .update(originalPathRelative, "utf8")
    .digest("hex")
    .slice(0, 12);
  const basename = posix.basename(originalPathRelative);
  return `${sha12}--${basename}`;
}
