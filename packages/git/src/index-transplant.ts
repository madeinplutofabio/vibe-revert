// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Index transplant (M 0.8.0 step 10D, §15).
//
// INTERNAL ONLY. No command, no public entrypoint, and no export from the
// package barrel. Its single approved production caller is
// `transplant-schedule.ts`; that module may prepare the schedule before the
// final fence, but reaches `transplantIndexPath` only from its post-marker
// execution path. Enforced by case 20 rather than asserted here, on the same
// reasoning as the worktree materializers.
//
// =============================================================================
// The oracle's index is the source. The contribution's is evidence.
// =============================================================================
//
//     oracle index entry  ->  update-index --add --cacheinfo <mode>,<oid>,<path>
//     oracle index absent ->  update-index --force-remove -- <path>
//     unmerged            ->  refused
//
// The oid is installable because the linked worktree shares the object
// database. The CONTRIBUTION's oid is never installed: it participates only in
// the equality check that proves the oracle agrees with what was asserted, and
// is never dereferenced or fetched.
//
// That distinction cannot be proven by observing the RESULT, because mutation
// only proceeds once `indexStateEqual(oracle, target)` holds, at which point the
// two carry identical mode and oid. So it is enforced STRUCTURALLY instead:
// `applyOracleIndexState` receives the oracle state and nothing else, and the
// target does not exist in the mutation half of the control flow at all. A
// future edit that wanted to build `--cacheinfo` from the target would have to
// widen that signature to do it.
//
// =============================================================================
// Shape refusals come BEFORE agreement
// =============================================================================
//
//     target unmerged | oracle unmerged   -> refuse
//     target gitlink  | oracle gitlink    -> refuse
//     indexStateEqual(oracle, target) false -> refuse the contradiction
//
// `unmerged` and mode `160000` are outside 0.8.0's transplant capability, not
// evidence problems. Checking equality first would report a capability limit as
// "the oracle disagrees with the plan", pointing a reader at the wrong question.
//
// The refusal is a RETURNING validator rather than an assertion function on
// purpose. TypeScript never checks an assertion function's body against what it
// claims, so `asserts state is Transplantable` would still compile with the
// gitlink branch deleted. `requireTransplantable` must actually produce the
// narrowed type, so deleting that branch widens `mode` back to include
// `"160000"` and the return type rejects it.
//
// =============================================================================
// The worktree is untouched, by type
// =============================================================================
//
// `target` is an `IndexState`, not a `PathState`. This function cannot see or
// alter a worktree target even by mistake, which is stronger than a comment
// promising it will not. `--force-remove` likewise drops the index entry while
// leaving the working-tree file exactly where it is; that is precisely why it is
// not `--remove`.
//
// No filesystem access, no object-store read, no checkpoint, no scheduling.
// §13's phase 4 places every index update after the worktree phase completes,
// and that ordering belongs to 10F.
//
// =============================================================================
// Absent-to-absent is a successful no-op, unlike worktree removal
// =============================================================================
//
// `removeWorktreePath` refuses an already-absent path because it destroys a
// concrete node whose existence was part of the scheduled physical transition.
// This primitive establishes an ABSTRACT state instead: "this path has no index
// entry". If the index already satisfies it, git has nothing destructive to do,
// and `--force-remove` exits zero.
//
// Adding a per-path current-index read purely to manufacture a refusal would
// cost a live git invocation per path and strengthen nothing. `update-index`
// also takes git's own index lock, so a concurrent index writer is serialized
// rather than racing; detection of unrelated movement belongs to the final fence
// and post-operation isolation, not to a per-path precondition here.
//
// =============================================================================
// Argument forms
// =============================================================================
//
// A leading-dash path is lexically valid in a repository, so the remove form
// needs `--` before the pathname or git parses it as options. The `--cacheinfo`
// form needs no separator: the path rides inside one comma-joined argument that
// git splits on the first two commas, so both a leading dash and embedded commas
// pass through intact.

import type { IndexState } from "@viberevert/session-format";

import { runGit } from "./git-cli.js";
import { mutationPathSafetyError } from "./mutation-path-safety.js";
import { type IndexSnapshot, indexStateEqual } from "./path-state.js";

export type IndexEntryState = Extract<IndexState, { kind: "entry" }>;

/**
 * An index state this slice can actually transplant.
 *
 * Derived from `IndexState` rather than restated, and it genuinely EXCLUDES the
 * gitlink mode rather than only `unmerged`. That is what lets the validator's
 * return type catch a deleted refusal.
 */
export type TransplantableIndexState =
  | Extract<IndexState, { kind: "absent" }>
  | (Omit<IndexEntryState, "mode"> & {
      readonly mode: Exclude<IndexEntryState["mode"], "160000">;
    });

/** This module's error contract over the shared mutation policy. */
function assertSafeMutationPath(path: string, context: string): void {
  const message = mutationPathSafetyError(path, context);
  if (message !== null) throw new Error(message);
}

/**
 * Narrow to a state 0.8.0 can transplant, or refuse, naming which side carried
 * the unsupported shape.
 *
 * `unmerged` is refused at planning and recorded but never restored; a gitlink
 * is likewise recorded but never restored. Reaching either here means the plan
 * and the oracle disagree with the capability, which is worth saying plainly.
 *
 * The `absent` return precedes the gitlink check so `state` is definitely the
 * entry member when `mode` is examined. TypeScript then narrows `mode` reliably
 * in the flow below, rather than depending on it splitting a negated compound
 * condition across a nested property.
 */
export function requireTransplantable(
  state: IndexState,
  side: "target" | "oracle" | "observed",
  path: string,
): TransplantableIndexState {
  if (state.kind === "unmerged") {
    throw new Error(
      `cannot transplant the index at ${JSON.stringify(path)}: the ${side} entry is unmerged`,
    );
  }
  if (state.kind === "absent") return state;
  if (state.mode === "160000") {
    throw new Error(
      `cannot transplant the index at ${JSON.stringify(path)}: the ${side} entry is a gitlink (submodule)`,
    );
  }
  // Reconstructed so the narrowed `mode` is CHECKED against the return type,
  // instead of being trusted through an assertion signature.
  return { ...state, mode: state.mode };
}

/**
 * Install the ORACLE's index state. The target is deliberately not a parameter.
 *
 * This is where "sourced from the oracle, never the contribution" is enforced:
 * with no target in scope, `--cacheinfo` cannot be built from one.
 */
async function applyOracleIndexState(
  repoRoot: string,
  path: string,
  oracle: TransplantableIndexState,
): Promise<void> {
  if (oracle.kind === "absent") {
    // `--` because a leading-dash path is a valid repository path.
    // `--force-remove` drops the entry without touching the working tree, and
    // exits zero when there is no entry to drop.
    await runGit(repoRoot, ["update-index", "--force-remove", "--", path]);
    return;
  }

  // One comma-joined argument: git splits on the first two commas, so a path
  // with a leading dash or embedded commas survives intact.
  await runGit(repoRoot, [
    "update-index",
    "--add",
    "--cacheinfo",
    `${oracle.mode},${oracle.oid},${path}`,
  ]);
}

/**
 * Transplant one path's index axis from the oracle's index.
 *
 * `oracleIndex` is the SUPPLIED snapshot and the only source consulted: 10F
 * reads one `IndexSnapshot` for the whole transplant rather than invoking
 * `git ls-files --stage` per path. A path the snapshot does not hold is
 * `absent`, which is a real state rather than missing data.
 *
 * The oracle is re-verified against `target` here even though 10B's evidence
 * validation already proved the two agree. A mutation primitive does not depend
 * on an upstream check having run.
 */
export async function transplantIndexPath(
  repoRoot: string,
  path: string,
  target: IndexState,
  oracleIndex: IndexSnapshot,
): Promise<void> {
  assertSafeMutationPath(path, "transplantIndexPath");

  const observed: IndexState = oracleIndex.byPath.get(path) ?? { kind: "absent" };

  // Shape before agreement: an unsupported state is a capability limit, not an
  // evidence disagreement.
  const targetState = requireTransplantable(target, "target", path);
  const oracleState = requireTransplantable(observed, "oracle", path);

  if (!indexStateEqual(oracleState, targetState)) {
    throw new Error(
      `cannot transplant the index at ${JSON.stringify(path)}: the oracle's entry does not match the state the contribution asserts`,
    );
  }

  await applyOracleIndexState(repoRoot, path, oracleState);
}
