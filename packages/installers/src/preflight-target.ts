// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Pre-mutation target preflight per D101.R + D101.S + rule 14.
//
// Before the engine writes or merges any target file, it calls
// assertSafeTarget to verify four safety categories:
//   1. (rule 14, no global writes) `targetPath` resolves UNDER
//      `repoRoot`, not outside it and not equal to it. PathSpecSchema
//      should already prevent outside-repo targets, but this
//      preflight is the last pre-mutation safety gate; refuse here
//      too so a caller bug cannot become a global write.
//   2. (D101.R) NO existing path component from inside `repoRoot`
//      down to `targetPath` is a symbolic link. The walk uses lstat
//      (NOT stat) so symlinks are detected, not followed. Any
//      symlinked component causes a hard refusal — VibeRevert never
//      writes through symlinks, full stop.
//   3. (file-kind check on every existing component)
//      - Intermediate components (between repoRoot and target) MUST
//        be directories. A regular file / socket / FIFO / device at
//        a non-final position would otherwise cause a generic
//        filesystem error during the next lstat or write; preflight
//        refuses explicitly with
//        IntegrationTargetParentNotDirectoryError.
//      - The target component (if it exists) MUST be a regular file.
//        A directory / socket / FIFO / device at the target is
//        refused with IntegrationTargetNotFileError. Every installer
//        target is file-shaped by design.
//      Symlinked components (at any position) are refused earlier
//      under category 2.
//   4. (D101.S, "merge" op only) the existing target file size is
//      ≤ 1 MiB. Config files are KB-scale; a multi-MB target is
//      overwhelmingly likely to be a misidentified non-config file.
//      Refusing prevents accidental mutation + unbounded memory use
//      during the read-modify-write cycle of json-key-merge /
//      sentinel-block ops. op === "write" skips this size check
//      because the engine doesn't read existing content for
//      write-new / backup-and-write ops; "merge" enables size
//      preflight because the engine will read and merge existing
//      content.
//
// Order of checks: lexical normalize via resolve() → outside-root
// refusal → walk existing components (symlink + intermediate-kind
// per component) → file-kind check on existing target → size check
// on existing merge target. We do NOT lstat anything if the lexical
// path is already outside the repo.
//
// Lexical normalization uses `resolve()`, NOT `realpath()`.
// realpath() would follow symlinks, which is exactly what this
// function is trying to detect and refuse.
//
// repoRoot itself is NOT walked for symlink-ness. Repos hosted in
// /home/user/projects -> /mnt/projects (or symlinked monorepo roots
// in CI) are normal; requiring repoRoot to be a regular directory
// would refuse routine setups. Symlinks AT OR INSIDE repoRoot (such
// as a malicious .cursor -> /tmp/other) are the actual concern.
//
// The precise outside-root check refuses rel === "", rel === "..",
// rel.startsWith(`..${sep}`), or isAbsolute(rel). A naive
// rel.startsWith("..") would false-positive on legitimate
// directories named with a leading double-dot (e.g. "..evil/file"
// stays inside repo).
//
// ENOENT on any component is fine: it just means that part of the
// path doesn't exist yet (the engine is about to create it). Only
// EXISTING components are checked for symlink-ness, file-kind, and
// size.
//
// Single-pass design: the same lstat used for symlink detection
// returns Stats, which the kind and size checks reuse. No
// double-stat.
//
// This is a pre-mutation safety gate, NOT a full TOCTOU-proof
// sandbox. Mutating code must still avoid global paths and should
// create parents carefully. The goal here is to refuse existing
// symlink escapes (and outside-root targets, non-directory parents,
// non-file targets, oversized merge targets) before any installer
// write path runs; a race where another process swaps a parent dir
// to a symlink AFTER this check and BEFORE the engine's write is out
// of scope for v1.

import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  IntegrationTargetNotFileError,
  IntegrationTargetParentNotDirectoryError,
  IntegrationTargetTooLargeError,
  SymlinkTargetRefusal,
  TargetOutsideRepoRootError,
} from "./errors.js";

/**
 * 1 MiB per D101.S. Exported so tests can reference the symbol
 * rather than duplicating the magic number.
 */
export const MAX_MERGE_BYTES = 1024 * 1024;

/**
 * Verify that `targetPath` is safe to write or merge under `repoRoot`.
 *
 * Throws:
 *   - TargetOutsideRepoRootError if targetPath (after lexical
 *     resolve) is outside or equal to repoRoot.
 *   - SymlinkTargetRefusal if any existing path component from
 *     repoRoot down to targetPath is a symbolic link.
 *   - IntegrationTargetParentNotDirectoryError if any existing
 *     intermediate path component is not a directory.
 *   - IntegrationTargetNotFileError if the existing target is not a
 *     regular file (directory, socket, FIFO, device, etc.).
 *   - IntegrationTargetTooLargeError if op === "merge" and the
 *     existing target file exceeds 1 MiB.
 *
 * Returns silently when all checks pass (including when the target
 * does not yet exist).
 */
export async function assertSafeTarget(args: {
  readonly repoRoot: string;
  readonly targetPath: string;
  readonly op: "write" | "merge";
}): Promise<void> {
  // Lexical normalization — resolve() is purely lexical and never
  // follows symlinks (that's what the lstat walk below is for).
  const repoRoot = resolve(args.repoRoot);
  const targetPath = resolve(args.targetPath);

  // Refuse outside-repo or equal-to-repoRoot targets BEFORE any fs
  // access. relative() returns "" for equal, ".." for parent,
  // "..<sep>..." for further-outside, absolute on cross-drive Windows.
  // Plain startsWith("..") would false-positive on "..evil/file"
  // (a legitimately named directory beginning with two dots).
  const rel = relative(repoRoot, targetPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TargetOutsideRepoRootError({ repoRoot, targetPath });
  }

  // Walk existing components inside repoRoot. repoRoot itself is
  // intentionally NOT lstat'd (see top comment). Intermediate
  // components must be directories; the final target component is
  // allowed to be a file (or not yet exist).
  const segments = rel.split(sep).filter((s) => s.length > 0);
  let acc = repoRoot;
  let lastStat: Stats | null = null;
  for (const [i, seg] of segments.entries()) {
    acc = join(acc, seg);
    lastStat = await checkComponentForSymlink(acc, targetPath);
    const isTargetComponent = i === segments.length - 1;
    if (!isTargetComponent && lastStat !== null && !lastStat.isDirectory()) {
      throw new IntegrationTargetParentNotDirectoryError({
        targetPath,
        parentPath: acc,
      });
    }
  }

  // If the target exists, enforce file-kind + (for merge) size.
  // Nested in the non-null branch so TS narrows lastStat correctly
  // across both checks.
  if (lastStat !== null) {
    if (!lastStat.isFile()) {
      throw new IntegrationTargetNotFileError({ targetPath });
    }
    if (args.op === "merge" && lastStat.size > MAX_MERGE_BYTES) {
      throw new IntegrationTargetTooLargeError({
        targetPath,
        sizeBytes: lastStat.size,
        limitBytes: MAX_MERGE_BYTES,
      });
    }
  }
}

/**
 * lstat one component; throw on symlink, return Stats on regular
 * file/dir, return null on ENOENT.
 */
async function checkComponentForSymlink(
  componentPath: string,
  originalTargetPath: string,
): Promise<Stats | null> {
  let st: Stats;
  try {
    st = await lstat(componentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new SymlinkTargetRefusal({
      targetPath: originalTargetPath,
      symlinkedComponentPath: componentPath,
    });
  }
  return st;
}
