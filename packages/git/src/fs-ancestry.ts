// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Physical ancestor traversability, package-internal.
//
// The counterpart to `path-safety.ts`, which is LEXICAL ONLY by its own header
// lock: it stops `..`, absolute paths, backslashes, empty segments, and the
// `.viberevert/**` store, and deliberately says nothing about what the
// components actually are on disk. This module answers that second question,
// and it exists separately because two consumers now need the same authority:
//
//     path-state.ts             before observing a path
//     worktree-materialize.ts   before mutating one
//
// =============================================================================
// Why final-component protection is not enough
// =============================================================================
//
// Given candidate `src/f.ts`, if `repo/src` is a symlink to somewhere outside
// the repository, the operating system resolves it during path resolution
// before any final-component rule applies. `O_NOFOLLOW` never sees it, and an
// identity check on the final component validates the FOREIGN file perfectly
// consistently.
//
// The hole is STABLE, not racy: an ancestor symlink already in place before the
// operation begins produces a self-consistent wrong answer every time. That is
// exactly what makes it dangerous, and why every component beneath `repoRoot`
// is verified individually rather than trusting a single `lstat` on the leaf.
//
// It is not a filesystem transaction. Node exposes no `openat`, so an ancestor
// can still move between this check and a later syscall. Callers that care
// re-check afterwards; this module only answers the question it is asked.

import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Kept private rather than exported. Generic errno classification is not part
 * of an ancestry API, and this predicate has no semantics that could drift from
 * the copy `path-state.ts` retains for its own remaining call site.
 */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Whether every component beneath repoRoot leading to `segments` is a real
 * directory.
 *
 * Walks outward from repoRoot one component at a time, `lstat`ing each. `lstat`
 * does not follow the component it is asked about, so a symlinked ancestor is
 * seen AS a symlink and rejected rather than silently traversed.
 *
 * `false` covers both "an ancestor does not exist" and "an ancestor is not a
 * directory". Callers translate that into `absent` on a first check and into a
 * refusal on a recheck, because the two mean different things.
 */
export async function ancestorsTraversable(
  repoRoot: string,
  segments: readonly string[],
): Promise<boolean> {
  let current = repoRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment === undefined) return false;
    current = join(current, segment);
    let st: BigIntStats;
    try {
      st = await lstat(current, { bigint: true });
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
    if (!st.isDirectory()) return false;
  }
  return true;
}
