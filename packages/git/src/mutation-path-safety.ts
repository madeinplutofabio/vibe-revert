// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Mutation-only path policy, package-internal.
//
// Composes the generic lexical authority and adds ONE rule that applies to
// writing but not to looking:
//
//     path-safety.ts            generic lexical repository-path rules, and the
//                               `.viberevert/**` store. Consumed by OBSERVATION
//                               and mutation alike.
//     mutation-path-safety.ts   the above, plus this repository root's `.git`.
//                               Mutation consumers only.
//
// The split is deliberate. Refusing to LOOK at a path is a different question
// from refusing to WRITE it: observation legitimately reports what is at
// `.git/config`, while no selective-restore mutation may ever alter it. Folding
// the `.git` rule into the shared authority would change observation semantics
// for every existing consumer.
//
// It lives here rather than duplicated in each mutation module because it is
// shared POLICY across two independent mutation surfaces, the worktree
// materializers and the index transplant. Two copies of a predicate deciding
// whether a mutation may touch repository control state is exactly the drift
// this package extracts to avoid.
//
// ROOT-ANCHORED. A nested `src/.git/**` is not this repository root's control
// directory, and exact-name matching matters too: `.gitignore`, `src/.gitkeep`,
// and `src/.git-data/file` are ordinary restorable content.
//
// Nothing the planner can currently produce names `.git/**`, because capture
// never records Git's own metadata. The rule exists anyway, on the principle
// every mutation primitive in this package follows: correctness does not depend
// on upstream callers behaving perfectly.
//
// Purely lexical. It touches no filesystem and says nothing about what the
// components actually are on disk, which is `fs-ancestry.ts`'s question.

import { repoRelativePathSafetyError } from "./path-safety.js";

/**
 * Validate a repo-relative POSIX path for MUTATION.
 *
 * Returns a message rather than throwing, mirroring
 * `repoRelativePathSafetyError`. Keeping the policy separate from the error type
 * lets each mutation consumer raise whatever its own contract needs.
 *
 * @param path The candidate repo-relative path.
 * @param context Caller-supplied prefix identifying the call site. Appears
 *   verbatim at the head of the returned message.
 * @returns The violated rule's message, or `null` if the path is safe to mutate.
 */
export function mutationPathSafetyError(path: string, context: string): string | null {
  const lexical = repoRelativePathSafetyError(path, context);
  if (lexical !== null) return lexical;

  if (path === ".git" || path.startsWith(".git/")) {
    return `${context}: path under Git control metadata ${JSON.stringify(path)}`;
  }

  return null;
}
