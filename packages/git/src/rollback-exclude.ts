// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `rollback.exclude` pattern compilation, package-internal.
//
// One owner for the glob semantics of ONE configuration field. Not a general
// glob utility: `diff.ts` exports `PICOMATCH_OPTIONS` for a DIFFERENT domain
// and the two must not be conflated.
//
//     PICOMATCH_OPTIONS   { dot: true, nocase: false,
//                           posixSlashes: true, nonegate: true }
//     rollback.exclude    { nonegate: true }
//
// `rollback.exclude` CURRENTLY uses `{ nonegate: true }` only. This matches the
// shipped capture/restore behaviour being extracted here.
//
// It differs from `PICOMATCH_OPTIONS`, notably because it does not set
// `dot: true`. That divergence predates Step 10 and is recorded as a separate
// issue. This extraction MUST preserve the existing behaviour exactly; it does
// not resolve or legitimize that divergence.
//
// Any future reconciliation must change capture and restore together and be
// treated as an explicit behavioural change, not slipped into an unrelated
// refactor.
//
// =============================================================================
// The symmetry this module must not obscure (restore.ts invariant #4)
// =============================================================================
//
// Capture and restore enforce `rollback.exclude` INDEPENDENTLY, on the
// UNTRACKED surface ONLY:
//
//     snapshots.ts          excludes matching untracked paths from capture
//     restore-preflight.ts  never enumerates, asserts, or overwrites them
//
// Tracked paths stay fully visible regardless of `rollback.exclude`.
//
// `restore-preflight.ts` previously carried a local copy and a note that the
// duplication was intentional, so that symmetry stayed visible at both sites.
// That note is relocated here rather than dropped. Sharing the COMPILER does
// not merge the two policies: this module decides only how a pattern list
// becomes a predicate. Which patterns are supplied, and which surface the
// predicate is applied to, remain entirely the caller's, and each call site
// still states its own surface.
//
// The extraction happens now because a third consumer arrives with the step 10
// protected domain. At two copies, duplication kept the symmetry legible; at
// three, silent divergence between them is the larger risk.
//
// Package-internal. NOT in the barrel: `rollback.exclude` enforcement is a
// @viberevert/git internal policy, and no consumer outside this package should
// be able to compile its own excluder and claim the same semantics.

import picomatch from "picomatch";

/**
 * Compile an excluder function from `rollback.exclude` patterns.
 *
 * An empty list yields a matcher that excludes nothing, so every path passes.
 *
 * `{ nonegate: true }` disables picomatch's leading-`!` re-include semantics.
 * For a field named `rollback.exclude`, implicit re-include via `!pattern` is
 * more dangerous than helpful; a user who needs conditional inclusion should
 * write tighter positive patterns. `!pattern` syntax is NOT supported in
 * `rollback.exclude`.
 *
 * Patterns are matched against repo-relative POSIX paths.
 *
 * Used ONLY on the untracked surface (restore.ts file header invariant #4).
 */
export function compileExcludeMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matcher = picomatch(patterns as string[], { nonegate: true });
  return (path: string) => matcher(path);
}
