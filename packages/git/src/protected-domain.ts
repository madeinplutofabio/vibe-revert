// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The protected domain (M 0.8.0 step 10, §9/§10 revision 13).
//
// READ-ONLY. Captures the frozen artifact `S` describing everything the
// transaction promises not to disturb, and compares two such artifacts. It
// performs no mutation, creates no checkpoint, builds no oracle, and has no
// caller reachable from a command. 10B content; the fence that consumes it is
// 10E.
//
// =============================================================================
// Two halves, answering different questions
// =============================================================================
//
//     states           what a checkpoint is expected to REPRODUCE
//     topologyWatches  raw physical membership the REAL transaction must not
//                      accidentally disturb
//
// One giant raw inventory would answer both and cost the whole repository. It
// is also the wrong shape: state comparison over existing keys cannot express
// "a new file appeared", and membership comparison cannot express "the mode
// changed". Each half covers the other's blind spot.
//
// They are NOT interchangeable evidence. `topologyWatches` freezes gitignored
// and `rollback.exclude` content, which the emergency checkpoint deliberately
// never captures. Asking a checkpoint oracle to reproduce `node_modules/` would
// refuse a valid recovery handle in every ordinary Node repository (§9).
//
// =============================================================================
// Four phases, four different guarantees
// =============================================================================
//
//     plan stabilization    states exact  +  topologyWatches exact
//     recovery oracle       states exact  ONLY
//     final fence           states exact  +  topologyWatches exact
//     post-op isolation     frozen states and raw watches changed only by the
//                           planned deltas
//
// So BOTH capture and comparison are factored in two, rather than taking a
// boolean:
//
//     captureProtectedStateMap  /  compareProtectedStateMaps
//     captureProtectedDomain    /  compareProtectedDomainSnapshots
//
// The recovery path must not merely IGNORE watches after building them. Raw
// enumeration can throw, or depend on filesystem state the recovery contract
// has just declared irrelevant, and would reject a valid checkpoint for a
// reason that contract disclaims. Separate functions also make the differing
// guarantee visible at the call site instead of hiding it in an argument.
//
// =============================================================================
// Two capture layers, and why post-mutation gets its own (F4)
// =============================================================================
//
// Membership DERIVATION reads the live repository. Bucket 5 of
// `captureProtectedStateMap` takes tracked paths from a live index and
// untracked paths from `gitListUntracked`, filtered by `--exclude-standard` and
// the session-start exclude matcher.
//
// Before mutation that is exactly right, and it is why the fence re-captures:
// nothing has changed yet, so the current ignore, index, and exclude state ARE
// the pre-operation rules.
//
// After mutation it is unsound. Not because the comparison stops looking:
// `compareProtectedStateMaps` is bidirectional, so a path frozen in `S` that a
// re-derived capture no longer lists surfaces as `removedPaths`.
//
// The defect is that the MEANING of membership changes. Bucket 5 reads the live
// index and live ignore rules through `--exclude-standard`, including
// `.gitignore`, so after mutation the protected key set is a function of state
// the transaction may itself have rewritten:
//
//     restoring `.gitignore` moves still-existing untracked files into and out
//         of the domain, so a file nothing touched is reported as added or
//         removed
//     `removedPaths` conflates "this path was destroyed" with "this
//         still-existing path no longer satisfies the live membership rules"
//
// Step 11 would then adjudicate that churn against a yardstick the operation
// under test may have moved, which is circular. The reassuring-direction
// failure lives one level up: a destroyed path reported as `removedPaths` is
// easy to wave through as "no longer in the domain".
//
// So post-mutation observation takes `S` as the membership authority:
//
//     S decides WHAT TO LOOK AT
//     the live repository decides WHAT IS THERE NOW
//
// With the key set fixed, no bucket-5 path can appear or disappear, every real
// difference lands in `changedPaths` with an observable before and after, and
// the isolation question stays decidable.
//
// Enumerating the current children of a FROZEN watch root is observation, not
// re-derivation. The roots are frozen authority; their current membership is
// precisely the live fact being compared.
//
// =============================================================================
// What this module does NOT do
// =============================================================================
//
// It is PHASE-NEUTRAL. All three comparing phases report different refusals:
//
//     plan stabilization             -> PRECONDITION_CHANGED
//     recovery-checkpoint validation -> RECOVERY_CHECKPOINT_MISMATCH
//     final fence                    -> PRECONDITION_CHANGED
//
// Baking those in would make this module un-reusable by two of its three
// consumers. It returns structured differences; callers name the failure.
//
// It also implements ONLY exact comparison. Post-operation verification (§18)
// needs "differs from the frozen value by exactly the planned operations", and
// that comparator belongs beside the materializers that define what a planned
// delta physically is. It is not built here against operations no materializer
// yet exists for.
//
// =============================================================================
// Freshly observed, never reused (§10 plan stabilization)
// =============================================================================
//
// Selected paths are RE-OBSERVED when building `S`. `classification.observed`
// is NOT reused, even though the planner already holds it. Plan stabilization
// exists precisely to check
//
//     S[path]  ==  classification.observed
//
// and reusing the same observation would make that check compare a value with
// itself. A path edited between phase 1 and `S` must be detectable.
//
// The same principle drives topology watches (revision 12): membership is
// enumerated according to the kind `S` FRESHLY observed, never the kind the
// plan expected. A selected parent may legitimately be turning from a regular
// file into a directory, and a destructive root may have stopped being a
// directory since planning. Both are structured stabilization differences, not
// exceptions.
//
// =============================================================================
// Cost, stated rather than optimized (step 15)
// =============================================================================
//
// The managed-domain bucket observes every index path plus every non-excluded
// untracked path. That is a repository-scale lstat pass, repeated when the
// fence re-captures. It is the same order of work `createCheckpoint` already
// performs, so it is precedented rather than novel, and correctness-first is
// the deliberate choice here. Recorded for step 15 benchmarking; NOT optimized
// now, and `S` is never weakened to avoid the cost.

import type { PathState } from "@viberevert/session-format";

import {
  type CurrentDescendant,
  enumerateDescendants,
  enumerateImmediateMembers,
} from "./fs-topology.js";
import { gitListUntracked } from "./git-cli.js";
import { isViberevertStorePath } from "./path-safety.js";
import {
  type IndexSnapshot,
  observePathState,
  pathStateEqual,
  readIndexSnapshot,
  worktreeStateEqual,
} from "./path-state.js";
import type { SelectiveRestoreOperation, SelectiveRestorePlan } from "./restore-selective.js";
import { compileExcludeMatcher } from "./rollback-exclude.js";

/**
 * Repository-root entries excluded from the ROOT topology watch only.
 *
 * `.git` and `.viberevert` are checkout control-plane entries, not
 * project-visible membership. They are excluded from the repository-root watch
 * only. A nested `vendor/something/.git` remains ordinary physical content
 * beneath `vendor/something`, and a destructive recursive transition there
 * really could destroy it.
 */
const ROOT_CONTROL_PLANE_ENTRIES: ReadonlySet<string> = new Set([".git", ".viberevert"]);

// =============================================================================
// Types
// =============================================================================

/**
 * How a watch's membership was enumerated. A later phase must re-enumerate the
 * SAME way, so the kind travels with the frozen value rather than being
 * re-derived.
 */
export type TopologyWatchKind = "recursive" | "immediate";

export interface TopologyWatch {
  readonly path: string;
  readonly kind: TopologyWatchKind;
  /** Frozen raw membership, sorted by path. Empty for a non-directory root. */
  readonly members: readonly CurrentDescendant[];
}

export interface ProtectedDomainSnapshot {
  /** Exact frozen `PathState` by protected repo-relative POSIX path. */
  readonly states: ReadonlyMap<string, PathState>;
  /** Frozen raw membership, keyed by watch root (`""` is the repository root). */
  readonly topologyWatches: ReadonlyMap<string, TopologyWatch>;
}

export interface TopologyWatchDifference {
  readonly path: string;
  readonly reason: "watch_added" | "watch_removed" | "kind_changed" | "membership_changed";
  readonly addedMembers: readonly string[];
  readonly removedMembers: readonly string[];
  /** Present in both, but the entry flipped between `directory` and `leaf`. */
  readonly changedMembers: readonly string[];
}

/**
 * State-only differences. This is the whole of what a recovery checkpoint is
 * asked to reproduce.
 */
export interface ProtectedStateDifference {
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly changedPaths: readonly string[];
}

/** State differences plus raw-membership differences. */
export interface ProtectedDomainDifference extends ProtectedStateDifference {
  readonly topologyWatchDifferences: readonly TopologyWatchDifference[];
}

export interface ProtectedDomainCaptureOptions {
  readonly repoRoot: string;
  readonly plan: SelectiveRestorePlan;
  /**
   * The SESSION-START `rollback.exclude` patterns, never live config. Applied
   * through the capture/restore matcher so the protected domain interprets
   * `rollback.exclude` exactly as the recovery machinery it validates against.
   */
  readonly rollbackExcludePatterns: readonly string[];
}

// =============================================================================
// Derived facts about the plan
// =============================================================================
//
// `operations` is the authoritative physical execution model. Both watch sets
// are PROJECTIONS of it, derived here rather than carried as extra plan fields,
// because a stored derived fact can disagree with the operations it describes
// while a projection cannot.
//
// All three helpers are pure and touch no filesystem, which is what lets the
// state-only capture use `immediateWatchParentsOf` without enumerating anything.

/**
 * Roots whose subtree the schedule intentionally destroys.
 *
 * Intrinsic to the operation, not planner policy: a directory replaced by
 * anything else takes everything beneath it. §7 stage C already reasoned about
 * every physical descendant; the watch freezes what it reasoned about so a
 * child appearing AFTER that scan cannot slip through.
 *
 * The ROOT SET is plan-derived; its MEMBERSHIP is `S`-derived (revision 12).
 */
function destructiveDirectoryRoots(plan: SelectiveRestorePlan): readonly string[] {
  const out: string[] = [];
  for (const op of plan.operations) {
    if (op.kind !== "restore_candidate") continue;
    if (op.observed.worktree.kind === "directory" && op.target.worktree.kind !== "directory") {
      out.push(op.path);
    }
  }
  return out.sort();
}

/**
 * Whether an operation can change the WORKTREE axis, and therefore needs its
 * parent neighbourhood frozen.
 *
 * A `restore_candidate` may exist purely because the INDEX differs. Such an
 * operation writes no filesystem node, so watching its parent would freeze a
 * neighbourhood nothing can disturb and invite spurious refusals. A synthetic
 * parent always changes the worktree, by construction.
 */
function affectsWorktree(op: SelectiveRestoreOperation): boolean {
  if (op.kind === "create_parent_directory") return true;
  return !worktreeStateEqual(op.observed.worktree, op.target.worktree);
}

/**
 * Parents whose immediate neighbourhood a materializer is authorized to touch.
 * May contain `""`, the repository root.
 */
function immediateWatchParentsOf(plan: SelectiveRestorePlan): ReadonlySet<string> {
  const parents = new Set<string>();
  for (const op of plan.operations) {
    if (affectsWorktree(op)) parents.add(parentOf(op.path));
  }
  return parents;
}

/** `"a/b/c.txt"` -> `"a/b"`; a root-level path -> `""`, the repository root. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

// =============================================================================
// Capture
// =============================================================================

/**
 * Freeze the protected STATE map: every path whose exact `PathState` the
 * transaction promises not to disturb, and the whole of what an emergency
 * checkpoint is asked to reproduce (§9 revision 13).
 *
 * Enumerates NO filesystem topology. That is the point of its existing
 * separately: the recovery oracle calls this and never builds a raw watch it
 * would then have to ignore.
 *
 * ONE `IndexSnapshot` feeds every `PathState` here, so the index axis and the
 * tracked-membership basis cannot disagree because of two separate Git reads.
 * It does NOT make the snapshot atomic: worktree observation is sequential, and
 * the working tree can still move underneath it. Plan stabilization and the
 * later fence are what detect drift around this observation window.
 *
 * `.viberevert/**` is excluded from the managed domain independently of
 * `.gitignore`, using the LIVE store predicate (`isViberevertStorePath`, exact
 * case, root-anchored) rather than restore-preflight's hostile-evidence
 * predicate. This inspects canonical live repository paths, where a user's real
 * `.VIBEREVERT/foo.txt` or `src/.viberevert/x` is ordinary content that must
 * stay protected. A SELECTED or synthetic path inside the store is corrupt
 * input and throws instead.
 *
 * Only an `eligible` plan may be captured. A `noop` plan creates no snapshot,
 * no emergency checkpoint, and no marker (§8); a `conflicted` plan never
 * proceeds. Accepting either would build an artifact for a transaction that
 * will not happen.
 */
export async function captureProtectedStateMap(
  opts: ProtectedDomainCaptureOptions,
): Promise<ReadonlyMap<string, PathState>> {
  const { repoRoot, plan } = opts;
  if (plan.outcome !== "eligible") {
    throw new Error(
      `protected-domain capture requires an eligible plan, received ${JSON.stringify(plan.outcome)}`,
    );
  }

  const index: IndexSnapshot = await readIndexSnapshot(repoRoot);
  const protectedPaths = new Set<string>();

  // 1. The selected physical footprint, BOTH rename aliases. Every
  //    classification, including `already_at_before` ones -- a path that needs
  //    no write is still a path the transaction must not let move.
  for (const classification of plan.classifications) {
    assertNotStorePath(classification.path, "selected footprint");
    protectedPaths.add(classification.path);
  }

  // 2. Synthetic parent directories.
  for (const op of plan.operations) {
    if (op.kind !== "create_parent_directory") continue;
    assertNotStorePath(op.path, "synthetic parent");
    protectedPaths.add(op.path);
  }

  // 3. Parents that must REMAIN directories though nothing writes them.
  for (const path of plan.topologyDependencyPaths) {
    assertNotStorePath(path, "topology dependency");
    protectedPaths.add(path);
  }

  // 4. Non-root immediate-watch parents. Every watch root must have a frozen
  //    `PathState`, because revision 12 reads the watch's kind from `states`.
  //    Stage C1b skips ancestor processing for an operation whose BEFORE
  //    worktree is absent, so the parent of a pure REMOVAL reaches none of the
  //    buckets above. Adding it widens `S`, which is the correct direction: a
  //    watched neighbourhood is by definition something the transaction
  //    promises not to disturb. The set is a pure plan projection, so this
  //    costs no enumeration.
  for (const parent of immediateWatchParentsOf(plan)) {
    if (parent === "") continue; // the repository root is never a `states` key
    assertNotStorePath(parent, "topology watch parent");
    protectedPaths.add(parent);
  }

  // 5. The unselected managed domain:
  //
  //        tracked
  //      + untracked not matching the session-start rollback.exclude
  //      - gitignored content        (gitListUntracked --exclude-standard)
  //      - .viberevert/**
  //
  //    Tracked paths come from the SAME `IndexSnapshot` observed above rather
  //    than a second `ls-files` call: the key sets are identical, and one read
  //    cannot produce a tracked population that disagrees with the index states
  //    recorded beside it.
  //
  //    An `unsupported` worktree state does NOT remove a path here (revision
  //    11). Step 10 cannot recreate a socket or FIFO, but it can notice that
  //    one stopped being `unsupported { fs_kind: X }`. Unsupported for
  //    RESTORATION is not unworthy of PROTECTION while unselected.
  for (const path of index.byPath.keys()) {
    if (isViberevertStorePath(path)) continue;
    protectedPaths.add(path);
  }
  const isExcluded = compileExcludeMatcher(opts.rollbackExcludePatterns);
  for (const path of await gitListUntracked(repoRoot)) {
    if (isViberevertStorePath(path)) continue;
    if (isExcluded(path)) continue;
    protectedPaths.add(path);
  }

  // Fresh observation for every path; `classification.observed` deliberately
  // not reused.
  const states = new Map<string, PathState>();
  for (const path of [...protectedPaths].sort()) {
    const { state } = await observePathState(repoRoot, path, index);
    states.set(path, state);
  }
  return states;
}

/**
 * Freeze the whole protected domain as `S`: the state map plus raw topology
 * watches.
 *
 * Used by plan stabilization and the final fence, which operate against the
 * REAL checkout where raw membership is meaningful evidence. The recovery
 * oracle uses `captureProtectedStateMap` instead and never reaches this.
 */
export async function captureProtectedDomain(
  opts: ProtectedDomainCaptureOptions,
): Promise<ProtectedDomainSnapshot> {
  const { repoRoot, plan } = opts;
  const states = await captureProtectedStateMap(opts);

  // Recursive first: where a root is BOTH a destructive root and the parent of
  // an operation, the recursive watch strictly contains the immediate one, so
  // the stronger watch wins and the weaker is never installed over it.
  const topologyWatches = new Map<string, TopologyWatch>();
  for (const root of destructiveDirectoryRoots(plan)) {
    const members = isObservedDirectory(states, root)
      ? await enumerateDescendants(repoRoot, root)
      : [];
    topologyWatches.set(root, { path: root, kind: "recursive", members: sortMembers(members) });
  }

  for (const parent of [...immediateWatchParentsOf(plan)].sort()) {
    if (topologyWatches.has(parent)) continue;
    topologyWatches.set(parent, {
      path: parent,
      kind: "immediate",
      members: sortMembers(await immediateMembership(repoRoot, parent, states)),
    });
  }

  return { states, topologyWatches };
}

/**
 * Immediate membership of a watched parent, per revision 12.
 *
 * The repository root always exists and is always a directory, so it is
 * enumerated unconditionally -- and it is not a `states` key, since
 * `observePathState` rejects `""` as a repo-relative path. Its control-plane
 * entries are filtered so the watch describes project-visible membership.
 *
 * Every other parent is enumerated only when `S` freshly observed it as a
 * directory. A non-directory has no filesystem children, so empty membership is
 * the truthful answer rather than a fail-open one: `states` records exactly what
 * that node currently is, and plan stabilization decides whether the observed
 * kind is still compatible with the approved plan. This is also what keeps
 * `enumerateImmediateMembers` fail-closed -- it is only ever called for a node
 * already established to be a directory, so any error it raises is genuine.
 */
async function immediateMembership(
  repoRoot: string,
  parent: string,
  states: ReadonlyMap<string, PathState>,
): Promise<readonly CurrentDescendant[]> {
  if (parent === "") {
    const members = await enumerateImmediateMembers(repoRoot, "");
    return members.filter((m) => !ROOT_CONTROL_PLANE_ENTRIES.has(m.path));
  }
  if (!isObservedDirectory(states, parent)) return [];
  return enumerateImmediateMembers(repoRoot, parent);
}

/**
 * Whether `S` freshly observed `path` as a worktree directory.
 *
 * A missing key is a construction bug, not a runtime condition: every non-root
 * watch root is added to the protected path set before observation.
 */
function isObservedDirectory(states: ReadonlyMap<string, PathState>, path: string): boolean {
  const state = states.get(path);
  if (state === undefined) {
    throw new Error(`topology watch root ${JSON.stringify(path)} has no observed PathState in S`);
  }
  return state.worktree.kind === "directory";
}

function assertNotStorePath(path: string, bucket: string): void {
  if (isViberevertStorePath(path)) {
    throw new Error(
      `${bucket} path ${JSON.stringify(path)} is VibeRevert's own store, which is never restorable content`,
    );
  }
}

function sortMembers(members: readonly CurrentDescendant[]): readonly CurrentDescendant[] {
  return [...members].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// =============================================================================
// Post-mutation observation, from frozen membership (F4)
// =============================================================================

/**
 * Current members of one FROZEN watch root.
 *
 * Mirrors `immediateMembership`'s rules exactly, extended to the recursive kind,
 * and reads the kind from the frozen watch rather than re-deciding it. A root
 * that is no longer a directory has no filesystem children, so empty membership
 * is the truthful answer; the state comparison is what reports the kind change.
 */
async function observeWatchMembers(
  repoRoot: string,
  root: string,
  kind: TopologyWatchKind,
  states: ReadonlyMap<string, PathState>,
): Promise<readonly CurrentDescendant[]> {
  if (root === "" && kind === "immediate") {
    const members = await enumerateImmediateMembers(repoRoot, "");
    return members.filter((m) => !ROOT_CONTROL_PLANE_ENTRIES.has(m.path));
  }
  // A recursive watch on the repository root is a shape capture cannot produce,
  // and `isObservedDirectory` refuses it here exactly as it would there.
  if (!isObservedDirectory(states, root)) return [];
  return kind === "recursive"
    ? enumerateDescendants(repoRoot, root)
    : enumerateImmediateMembers(repoRoot, root);
}

/**
 * Re-observe the protected domain AFTER mutation, taking every membership
 * decision from the frozen `S`.
 *
 * This is the post-op counterpart of `captureProtectedDomain`, and the ONLY
 * capture-shaped function that is sound once the repository has been mutated.
 * It derives nothing:
 *
 *     state paths   exactly `S.states`' keys, freshly observed
 *     watch roots   exactly `S.topologyWatches`' keys, with their frozen kinds,
 *                   freshly enumerated
 *
 * It takes no `SelectiveRestorePlan` ON PURPOSE. Post-operation verification
 * must not need the plan to decide WHAT is protected. Step 11 needs the plan
 * separately to decide which observed differences are PERMITTED, which is a
 * later and different question.
 *
 * The index read is observation input, never a membership source: it supplies
 * each frozen path's current index axis, and its key set is deliberately unused.
 * That distinction is the whole of F4, so it is worth stating plainly rather
 * than banning index reads outright.
 *
 * Returns a `ProtectedDomainSnapshot` so `compareProtectedDomainSnapshots(S,
 * observed)` consumes it directly. A distinct result type would buy nothing
 * under structural typing and would force Step 11 to adapt or cast.
 */
export async function observeProtectedDomainFromFrozenMembership(
  repoRoot: string,
  frozen: ProtectedDomainSnapshot,
): Promise<ProtectedDomainSnapshot> {
  const index: IndexSnapshot = await readIndexSnapshot(repoRoot);

  const states = new Map<string, PathState>();
  for (const path of [...frozen.states.keys()].sort()) {
    const { state } = await observePathState(repoRoot, path, index);
    states.set(path, state);
  }

  // The map KEY is the root authority; the frozen value contributes only its
  // kind, so a snapshot whose watch value disagreed with its key cannot widen
  // what gets enumerated.
  const entries = [...frozen.topologyWatches.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const topologyWatches = new Map<string, TopologyWatch>();
  for (const [root, watch] of entries) {
    topologyWatches.set(root, {
      path: root,
      kind: watch.kind,
      members: sortMembers(await observeWatchMembers(repoRoot, root, watch.kind, states)),
    });
  }

  return { states, topologyWatches };
}

// =============================================================================
// Comparison
// =============================================================================

/**
 * Exact comparison of two protected STATE maps, in both directions.
 *
 * This is the recovery oracle's whole comparison (§9 revision 13). A
 * non-ignored untracked protected file is a `states` member, so an emergency
 * checkpoint that loses it still fails here -- the raw watch is not needed to
 * prove it.
 *
 * Membership is the load-bearing half. Comparison restricted to keys present in
 * both could not express "an unselected file appeared" or "a protected path
 * vanished", which are exactly the cases that make an emergency checkpoint a
 * stale recovery handle.
 *
 * Pure: it re-reads nothing.
 */
export function compareProtectedStateMaps(
  expected: ReadonlyMap<string, PathState>,
  actual: ReadonlyMap<string, PathState>,
): ProtectedStateDifference {
  const addedPaths: string[] = [];
  const removedPaths: string[] = [];
  const changedPaths: string[] = [];

  for (const [path, expectedState] of expected) {
    const actualState = actual.get(path);
    if (actualState === undefined) {
      removedPaths.push(path);
      continue;
    }
    if (!pathStateEqual(expectedState, actualState)) changedPaths.push(path);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) addedPaths.push(path);
  }

  return {
    addedPaths: addedPaths.sort(),
    removedPaths: removedPaths.sort(),
    changedPaths: changedPaths.sort(),
  };
}

/**
 * Exact comparison of two whole protected domains: the state comparison above
 * plus raw membership.
 *
 * Used by plan stabilization and the final fence. The caller re-captures
 * against the CURRENT repository and passes both artifacts. At the fence that
 * is sound precisely because nothing has mutated yet, so the current
 * `.gitignore`, index, and exclude state ARE the pre-operation rules. After
 * mutation, the frozen snapshot is compared and membership is NEVER re-derived
 * (§10).
 */
export function compareProtectedDomainSnapshots(
  expected: ProtectedDomainSnapshot,
  actual: ProtectedDomainSnapshot,
): ProtectedDomainDifference {
  const stateDifference = compareProtectedStateMaps(expected.states, actual.states);

  const topologyWatchDifferences: TopologyWatchDifference[] = [];
  for (const [path, expectedWatch] of expected.topologyWatches) {
    const actualWatch = actual.topologyWatches.get(path);
    if (actualWatch === undefined) {
      topologyWatchDifferences.push(emptyWatchDifference(path, "watch_removed"));
      continue;
    }
    if (actualWatch.kind !== expectedWatch.kind) {
      topologyWatchDifferences.push(emptyWatchDifference(path, "kind_changed"));
      continue;
    }
    const membership = diffMembership(path, expectedWatch.members, actualWatch.members);
    if (membership !== undefined) topologyWatchDifferences.push(membership);
  }
  for (const path of actual.topologyWatches.keys()) {
    if (!expected.topologyWatches.has(path)) {
      topologyWatchDifferences.push(emptyWatchDifference(path, "watch_added"));
    }
  }

  return {
    ...stateDifference,
    topologyWatchDifferences: topologyWatchDifferences.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
}

/** `true` iff no protected path was added, removed, or changed. */
export function protectedStatesUnchanged(difference: ProtectedStateDifference): boolean {
  return (
    difference.addedPaths.length === 0 &&
    difference.removedPaths.length === 0 &&
    difference.changedPaths.length === 0
  );
}

/** `true` iff the difference is empty in every field, watches included. */
export function protectedDomainUnchanged(difference: ProtectedDomainDifference): boolean {
  return protectedStatesUnchanged(difference) && difference.topologyWatchDifferences.length === 0;
}

/**
 * `undefined` when membership is identical. A member present in both whose kind
 * flipped between `directory` and `leaf` is a CHANGE, not a coincidence: the
 * same name now denotes a different physical object.
 */
function diffMembership(
  watchPath: string,
  expected: readonly CurrentDescendant[],
  actual: readonly CurrentDescendant[],
): TopologyWatchDifference | undefined {
  const expectedByPath = new Map(expected.map((m) => [m.path, m.kind]));
  const actualByPath = new Map(actual.map((m) => [m.path, m.kind]));

  const addedMembers: string[] = [];
  const removedMembers: string[] = [];
  const changedMembers: string[] = [];

  for (const [path, kind] of expectedByPath) {
    const actualKind = actualByPath.get(path);
    if (actualKind === undefined) {
      removedMembers.push(path);
      continue;
    }
    if (actualKind !== kind) changedMembers.push(path);
  }
  for (const path of actualByPath.keys()) {
    if (!expectedByPath.has(path)) addedMembers.push(path);
  }

  if (addedMembers.length === 0 && removedMembers.length === 0 && changedMembers.length === 0) {
    return undefined;
  }
  return {
    path: watchPath,
    reason: "membership_changed",
    addedMembers: addedMembers.sort(),
    removedMembers: removedMembers.sort(),
    changedMembers: changedMembers.sort(),
  };
}

function emptyWatchDifference(
  path: string,
  reason: TopologyWatchDifference["reason"],
): TopologyWatchDifference {
  return { path, reason, addedMembers: [], removedMembers: [], changedMembers: [] };
}
