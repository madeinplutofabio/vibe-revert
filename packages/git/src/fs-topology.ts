// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Raw filesystem topology enumeration (M 0.8.0 step 10).
//
// Deliberately NOT git-aware. Selective restore reasons about physical state
// that git does not represent: an ignored or untracked child is destroyed by a
// directory removal just the same, and git never records directories at all.
// Anything git-visible is answered by `git-cli.ts` / `path-state.ts` instead.
//
// Two operations, kept separate rather than one function with a depth flag,
// because they answer different questions:
//
//   enumerateDescendants      what a destructive directory transition destroys
//   enumerateImmediateMembers what a materializer's neighbourhood contains
//
// A flag toggling recursion would make call sites read as configuration rather
// than intent, and the two have different cost profiles.
//
// Both FAIL CLOSED on every enumeration error, with no exceptions and no error
// code translated into a value. Neither may be handed a path whose kind has not
// already been established by the caller's observed state. Both are also
// deterministic. Those properties are load-bearing for the protected domain,
// not incidental.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface CurrentDescendant {
  readonly path: string;
  /** `directory` may be a structural container; `leaf` bears user content. */
  readonly kind: "directory" | "leaf";
}

/**
 * Every CURRENT filesystem descendant of `dirPath`, repo-relative POSIX.
 *
 * Raw filesystem, not git-aware: an ignored or untracked child is physically
 * destroyed by a directory removal just the same.
 *
 * FAILS CLOSED on every enumeration error, INCLUDING ENOENT. A path vanishing
 * mid-plan means this plan was not built against a coherent topology; later
 * stabilization is not a licence to plan from knowingly incomplete observation.
 *
 * `withFileTypes` carries lstat semantics, so a symlink reports
 * `isSymbolicLink()` and never `isDirectory()`. A symlinked directory is a LEAF
 * and is never traversed -- its target lives elsewhere.
 *
 * Traversal itself is deterministic, not just the output: entries are sorted and
 * child directories pushed in REVERSE order so `pop()` visits lexical-first.
 * Otherwise a fail-closed throw could surface from a different subtree run to
 * run.
 */
export async function enumerateDescendants(
  repoRoot: string,
  dirPath: string,
): Promise<readonly CurrentDescendant[]> {
  const found: CurrentDescendant[] = [];
  const stack: string[] = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const dirents = await readdir(join(repoRoot, ...current.split("/")), { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const childDirs: string[] = [];
    for (const dirent of dirents) {
      const child = `${current}/${dirent.name}`;
      const isDir = dirent.isDirectory();
      found.push({ path: child, kind: isDir ? "directory" : "leaf" });
      if (isDir) childDirs.push(child);
    }
    for (let i = childDirs.length - 1; i >= 0; i -= 1) {
      const dir = childDirs[i];
      if (dir !== undefined) stack.push(dir);
    }
  }
  return found;
}

/**
 * The IMMEDIATE members of `dirPath`, repo-relative POSIX, sorted. No recursion.
 *
 * This is the topology-watch primitive: it freezes the neighbourhood a
 * materializer is authorized to touch, so a stray file appearing beside a
 * planned write is detectable without inventorying the whole repository.
 *
 * Same lstat semantics and the same unconditional fail-closed contract as
 * `enumerateDescendants`: every `readdir` error propagates, ENOENT included.
 * ENOENT is NOT translated to an empty list, because it does not reliably mean
 * "this directory is genuinely absent" -- an ancestor that is a non-directory
 * surfaces as ENOENT on some platforms where others report ENOTDIR, so a
 * tolerant reading here would turn an invalid topology into an empty
 * neighbourhood.
 *
 * A caller whose observed state ALREADY says the parent is absent freezes empty
 * membership directly and never invokes this function. A caller whose observed
 * state says the parent is a regular file, a symlink, or unsupported has a
 * topology refusal to raise, not a directory to enumerate. This function is
 * therefore only ever called for a parent observed to be a directory, and any
 * error it sees is genuine incoherence.
 *
 * `dirPath` may be `""`, meaning the repository root: a planned write to a
 * root-level path such as `README.md` has the root as its immediate parent, and
 * its members must be named `README.md`, not `/README.md`.
 */
export async function enumerateImmediateMembers(
  repoRoot: string,
  dirPath: string,
): Promise<readonly CurrentDescendant[]> {
  const dirents = await readdir(join(repoRoot, ...dirPath.split("/")), { withFileTypes: true });
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return dirents.map((dirent) => ({
    path: dirPath === "" ? dirent.name : `${dirPath}/${dirent.name}`,
    kind: dirent.isDirectory() ? ("directory" as const) : ("leaf" as const),
  }));
}
