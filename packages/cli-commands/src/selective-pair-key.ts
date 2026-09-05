// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The (path, change group) pair key, and set comparison over strings.
//
// Selection is group-atomic while restoration is per path, so a rename group
// legitimately produces two entries sharing one group id, and one path can
// appear under two groups. Every cross-check between a plan and what a
// transaction or a preview reported is therefore a comparison of PAIRS, never
// of paths alone.
//
// ONE authority, because both receipt mappers ask the same question. A second
// copy of the delimiter could drift into something a git path can contain, and
// the failure would be silent: two different selections would compare equal.

/**
 * NUL, built rather than written as a literal.
 *
 * A space would not do: path "a b" in group "c" and path "a" in group "b c"
 * would produce the same key, and a space is legal inside a git path. NUL is
 * legal in neither component. Constructed with `fromCharCode` because a raw NUL
 * in source makes git treat the whole file as binary, which costs every future
 * diff and blame on it.
 */
const PAIR_DELIMITER = String.fromCharCode(0);

export const pairKey = (path: string, changeGroupId: string): string =>
  `${path}${PAIR_DELIMITER}${changeGroupId}`;

/**
 * Set equality over strings.
 *
 * Deliberately NOT named for pairs: the algorithm has no pair-specific
 * semantics, and the same comparison serves the authorized-group check.
 */
export function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
