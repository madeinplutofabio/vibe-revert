// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Repo-relative path safety: this package's single lexical authority.
//
// M 0.8.0 step 4b. `diff.ts` and `path-state.ts` each carried a private copy
// of this guard, and path-state.ts's copy said plainly why the duplication was
// tolerable at the time: "Step 4 adds a third consumer, which is the point to
// extract this into a shared internal module rather than now." That third
// consumer is `contribution.ts`, so this is that extraction.
//
// Two copies of a security invariant fail closed twice, which is why the
// duplication was safe. THREE copies is where drift starts to be likelier than
// vigilance: a rule added to one and missed in another produces a guard that
// silently protects less than its siblings, and nothing in the type system
// would notice.
//
// =============================================================================
// Why this returns a message instead of throwing
// =============================================================================
//
// The two existing guards are semantically identical: same six checks, same
// order, same message text. They differ ONLY in the error they raise.
//
//   diff.ts        throws DiffParseError, which M C callers catch by type
//   path-state.ts  throws PathObservationError, which also carries `path`
//
// Collapsing those into one thrown type would change which error reaches a
// call site, and a deduplication is not permitted to do that. So the shared
// authority is a pure function returning the violated rule's message, or null
// when the path is safe, and each consumer keeps a thin wrapper that throws
// its own type. The rules live once; the error contracts stay where they are.
//
// =============================================================================
// One store boundary, two decisions
// =============================================================================
//
// The `.viberevert/` ban is defense in depth and deliberately independent of
// `.gitignore`: removing that line from a project's ignore file must not let
// VibeRevert observe, mirror, or diff its own store.
//
// Two policies act on that boundary, and they act DIFFERENTLY:
//
//   diff.ts, path-state.ts   REFUSE. A store path arriving from git output
//                            or a caller is a misconfiguration signal.
//   contribution capture     EXCLUDE. A tracked or force-added store path
//                            must not make `end` fail outright; it simply
//                            falls outside the recovery domain.
//
// `isViberevertStorePath` is exported so the excluding policy asks exactly the
// question the refusing policy asks, and `repoRelativePathSafetyError` is
// implemented in terms of it. One definition of the boundary; two decisions
// about what to do when a path crosses it.
//
// =============================================================================
// Scope
// =============================================================================
//
// LEXICAL ONLY. This stops `..`, absolute paths, backslashes, and empty
// segments. It says nothing about what the components actually are on disk,
// which is what `path-state.ts`'s `ancestorsTraversable` exists for. A path
// passing this check may still be a symlink, a directory, or absent.
//
// CHECK ORDER IS SIGNIFICANT. The message names the FIRST violated rule, and
// existing tests in diff.test.ts and path-state.test.ts pin those exact
// strings. Reordering the checks would change messages for paths that violate
// more than one rule, which is why the order below is preserved verbatim from
// the two originals rather than tidied.
//
// Package-internal. Never exported from the git barrel: these are shared
// invariants, not public API.

const VIBEREVERT_DIR = ".viberevert";
const VIBEREVERT_DIR_PREFIX = `${VIBEREVERT_DIR}/`;

/**
 * Whether a repo-relative POSIX path names VibeRevert's own store.
 *
 * ROOT-ONLY, deliberately. The store lives at the repository root, so anything
 * that merely shares the name elsewhere is someone's data:
 *
 *   ".viberevert"                  true
 *   ".viberevert/objects/ab/cd"    true
 *   "src/.viberevert/x"            FALSE, a nested user directory
 *   ".viberevertx"                 FALSE, a different name
 *   ".viberevert-backup/x"         FALSE, a different directory
 *
 * Exported so the two policies described in this file's header share one
 * definition of the boundary. `repoRelativePathSafetyError` calls it rather
 * than repeating the comparison, which is the whole point of centralizing it.
 */
export function isViberevertStorePath(path: string): boolean {
  return path === VIBEREVERT_DIR || path.startsWith(VIBEREVERT_DIR_PREFIX);
}

/**
 * Validate a repo-relative POSIX path lexically.
 *
 * @param path The candidate repo-relative path.
 * @param context Caller-supplied prefix identifying the call site, e.g.
 *   `"parseNameStatus.previous_path"`. Appears verbatim at the head of the
 *   returned message.
 * @returns The violated rule's message, or `null` if the path is safe.
 */
export function repoRelativePathSafetyError(path: string, context: string): string | null {
  if (path.length === 0) {
    return `${context}: empty path`;
  }
  if (path.includes("\\")) {
    return `${context}: backslash in path ${JSON.stringify(path)}`;
  }
  if (path.startsWith("/")) {
    return `${context}: absolute path ${JSON.stringify(path)}`;
  }
  if (/^[A-Za-z]:/.test(path)) {
    return `${context}: Windows-drive path ${JSON.stringify(path)}`;
  }
  if (isViberevertStorePath(path)) {
    return `${context}: path under .viberevert/ ${JSON.stringify(path)}`;
  }
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      return `${context}: unsafe segment ${JSON.stringify(seg)} in ${JSON.stringify(path)}`;
    }
  }
  return null;
}
