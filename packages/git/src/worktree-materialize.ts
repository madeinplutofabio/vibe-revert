// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Worktree materialization primitives (M 0.8.0 step 10C, §14).
//
// INTERNAL ONLY. No command, no public entrypoint, no production caller until
// 10F, and no export from the package barrel. Enforced by a test rather than
// asserted here: no code path in a shipped build can reach these functions,
// which is what lets mutation-capable code land before the attempt marker and
// the final fence exist (10E).
//
// =============================================================================
// Primitives, not a schedule
// =============================================================================
//
// §13's four-phase order is 10F's to execute:
//
//     1. removals, deepest first
//     2. directory creation, shallowest first
//     3. leaf materialization
//     4. index updates, after the entire worktree phase
//
// Phase 1 removes paths whose target is absent AND incompatible existing nodes
// standing where something else must be materialized, so "which primitive runs"
// is not a function of target kind alone. Bundling the schedule into one
// dispatching entry point would hide that.
//
// =============================================================================
// Every primitive performs the requested transition or refuses it
// =============================================================================
//
// None of these normalize, retry, or tolerate. By the time 10F calls them the
// final fence has established the exact pre-mutation state and the attempt
// marker is written, so a surprise means the world moved after the fence or the
// scheduler violated its own projection. A mutation primitive that smooths over
// a contradiction destroys the evidence that something is wrong.
//
//   - Removal is NON-RECURSIVE and refuses an absent path.
//   - Directory creation is NON-RECURSIVE and refuses a path that already
//     exists, a directory included.
//   - Leaf materialization NEVER creates parents.
//
// The one legitimate replacement is a COMPATIBLE existing leaf: regular over
// regular, symlink over symlink.
//
// =============================================================================
// Path safety is this module's own responsibility
// =============================================================================
//
// Every entry point validates its repo-relative path LEXICALLY through
// `mutationPathSafetyError`: the generic repository-path rules and the
// `.viberevert/**` store, plus this repository root's `.git`. A mutation
// primitive is therefore structurally incapable of touching VibeRevert's own
// store, this repository root's Git control metadata, or anything reached by
// `..`, an absolute path, or a backslash path. See `mutation-path-safety.ts`
// for why the `.git` rule is mutation-only and root-anchored.
//
// It then validates PHYSICAL ancestry through `ancestorsTraversable`. Final-
// component protection alone is insufficient: if `repo/src` is a symlink out of
// the repository, path resolution follows it before any rule about `src/f.ts`
// applies, and the hole is stable rather than racy.
//
// =============================================================================
// Source evidence first, destruction last
// =============================================================================
//
//     validate the leaf target and this host's capability
//     lexically validate the path
//     read and validate ALL oracle evidence
//     validate destination ancestry
//     classify the destination
//     perform the transition
//
// Reading the oracle before touching the destination means malformed source
// evidence is discovered while the real checkout is still untouched.
//
// `O_TRUNC` is NEVER used: it acts during `open()`, so a file would be destroyed
// before there was any opportunity to check that the opened object is the one
// that was classified. What each regular-file branch actually guarantees:
//
//     existing regular  NO DESTRUCTIVE MUTATION before identity validation.
//                       lstat identity, open without truncation, fstat must
//                       agree on regular + dev + ino, ancestry rechecked, lstat
//                       re-agrees, and only then truncate and write.
//
//     new regular       creation ITSELF is unavoidable: `open` with `O_CREAT`
//                       makes the empty file, and Node exposes no `openat` to
//                       bind that to a validated directory. But NO BYTES are
//                       written until the created object is revalidated through
//                       ancestry plus handle/path identity. `O_EXCL` covers the
//                       final component; the revalidation covers the ancestors
//                       it cannot.
//
// A failed revalidation does NOT delete the file it just created. Once ancestry
// is suspect, a pathname-based cleanup could resolve somewhere else and make the
// failure worse.
//
// `O_NOFOLLOW` prevents final-component substitution where it exists and is
// absent on win32, where the identity checks detect it instead. None of this is
// a filesystem transaction, and no resistance to arbitrary concurrent namespace
// mutation is claimed. `symlink()` and `mkdir()` have no pinned-creation
// equivalent at all, so they carry the unavoidable race without mitigation; the
// regular-file path is hardened precisely because it DOES yield a handle, and
// leaving that unused would be leaving available safety on the table.
//
// The mode change goes through the pinned `FileHandle` too, so the executable
// bit lands on the same inode whose bytes were written rather than on whatever
// the pathname resolves to afterwards.
//
// =============================================================================
// The executable bit is three-valued, and minimal (session-format lock)
// =============================================================================
//
// `WorktreeState.regular.executable` is `boolean | null`, and `null` means
// UNKNOWN: "neither `false` nor a wildcard", with no code permitted to turn it
// into an assertion.
//
// The observer reduces an entire mode to `(mode & 0o111) !== 0`, so `true`
// asserts only that AT LEAST ONE execute bit exists. The transition applied here
// is the minimum satisfying exactly that fact, preserving every other bit:
//
//     null   -> nothing
//     true   -> already executable? nothing. otherwise add owner-execute (0o100)
//     false  -> already non-executable? nothing. otherwise clear 0o111
//
//     0644 + true  -> 0744        0755 + false -> 0644
//     0600 + true  -> 0700        0710 + false -> 0600
//     0750 + true  -> 0750  (unchanged)
//
// Neither `mode | 0o111` nor mirroring execute onto readable classes is used:
// both invent permission structure the artifact never recorded. A new file is
// created under the ordinary process umask and then adjusted the same way.
//
// On a host that cannot establish or observe the bit, a KNOWN value is refused
// BEFORE any filesystem work. Returning success would mean "materialized" no
// longer matches the type.

import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rmdir, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { PathState } from "@viberevert/session-format";

import { ancestorsTraversable } from "./fs-ancestry.js";
import { mutationPathSafetyError } from "./mutation-path-safety.js";
import { type IndexSnapshot, type ObservedObject, observePathState } from "./path-state.js";

/** `O_NOFOLLOW` is absent on win32, so it is applied opportunistically. */
const O_NOFOLLOW_OR_ZERO = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Creating: `O_EXCL` refuses anything that appeared at the final component. */
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_OR_ZERO;

/** Replacing: deliberately WITHOUT `O_TRUNC`, which would destroy before checking. */
const REPLACE_FLAGS = constants.O_WRONLY | O_NOFOLLOW_OR_ZERO;

/** The index axis is irrelevant to a worktree source read. */
const EMPTY_INDEX: IndexSnapshot = { byPath: new Map() };

/** The only worktree states a leaf materializer can produce. */
type LeafWorktreeState = Extract<PathState["worktree"], { kind: "regular" | "symlink" }>;

/** What is physically at a path right now. `lstat`, so links are not followed. */
type NodeKind = "absent" | "regular" | "symlink" | "directory" | "other";

const abs = (root: string, path: string): string => join(root, ...path.split("/"));

/**
 * Only ENOENT becomes `absent`. Every other error propagates, so an unreadable
 * ancestor or a permission failure can never be mistaken for "nothing there".
 */
async function currentKind(absPath: string): Promise<NodeKind> {
  try {
    const stat = await lstat(absPath);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "regular";
    return "other";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
}

/** This module's error contract over the shared mutation policy. */
function assertSafeMutationPath(path: string, context: string): void {
  const message = mutationPathSafetyError(path, context);
  if (message !== null) throw new Error(message);
}

/**
 * An untraversable ancestor is a REFUSAL, not `absent`: these primitives never
 * conclude anything about a path they could not reach safely.
 */
async function assertAncestry(repoRoot: string, path: string, context: string): Promise<void> {
  if (!(await ancestorsTraversable(repoRoot, path.split("/")))) {
    throw new Error(
      `${context}: an ancestor of ${JSON.stringify(path)} is missing, a file, or a symlink, so the path is not safely reachable`,
    );
  }
}

async function assertReachable(repoRoot: string, path: string, context: string): Promise<void> {
  assertSafeMutationPath(path, context);
  await assertAncestry(repoRoot, path, context);
}

// =============================================================================
// Removal
// =============================================================================

/**
 * Remove exactly one node: a regular file, a symlink, or an EMPTY directory.
 *
 * Deliberately not idempotent. An absent path means a precondition the fence
 * signed off on no longer holds.
 *
 * A symlink is unlinked, never followed, so its target is untouched. An `other`
 * kind (socket, FIFO, device) is refused: phase 1 already declared such a node
 * unsupported, so removing one would destroy something the plan never
 * accounted for.
 */
export async function removeWorktreePath(repoRoot: string, path: string): Promise<void> {
  await assertReachable(repoRoot, path, "removeWorktreePath");

  const target = abs(repoRoot, path);
  const kind = await currentKind(target);

  switch (kind) {
    case "absent":
      throw new Error(
        `cannot remove ${JSON.stringify(path)}: it is already absent, so the planned pre-mutation state no longer holds`,
      );
    case "other":
      throw new Error(
        `cannot remove ${JSON.stringify(path)}: it is an unsupported filesystem node, which phase 1 refuses`,
      );
    case "directory":
      try {
        await rmdir(target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          throw new Error(
            `cannot remove the directory ${JSON.stringify(path)}: it is not empty, and removal is never recursive`,
          );
        }
        throw err;
      }
      return;
    default:
      await unlink(target);
  }
}

// =============================================================================
// Directory creation
// =============================================================================

/**
 * Create exactly one directory, whose parent must already exist.
 *
 * Refuses a path that exists in ANY form, an existing directory included. A
 * creation operation is planned only for a path observed absent, or for one
 * whose incompatible node phase 1 removed, so anything present here is a
 * contradiction rather than a no-op.
 *
 * `ancestorsTraversable` already proved the parent is a real directory, so the
 * non-recursive `mkdir` needs no separate parent check.
 */
export async function createWorktreeDirectory(repoRoot: string, path: string): Promise<void> {
  await assertReachable(repoRoot, path, "createWorktreeDirectory");

  const target = abs(repoRoot, path);
  const kind = await currentKind(target);
  if (kind !== "absent") {
    throw new Error(
      `cannot create the directory ${JSON.stringify(path)}: a ${kind} already exists there`,
    );
  }
  await mkdir(target);
}

// =============================================================================
// Oracle source
// =============================================================================

/**
 * Verify the object the oracle produced is the one `wantedRef` names.
 *
 * The digest is re-checked even though `observePathState` promises it matches
 * the state's own ref: one comparison at a mutation boundary, so this primitive
 * never silently depends on a producer invariant.
 */
function verifiedBytes(
  path: string,
  wantedRef: string,
  observedRef: string,
  object: ObservedObject | undefined,
): Buffer {
  if (observedRef !== wantedRef) {
    throw new Error(
      `the oracle's ${JSON.stringify(path)} does not match the target: expected ${wantedRef}, observed ${observedRef}`,
    );
  }
  if (object === undefined) {
    throw new Error(`the oracle produced no bytes for ${JSON.stringify(path)}`);
  }
  if (object.digest !== wantedRef) {
    throw new Error(
      `the oracle's bytes for ${JSON.stringify(path)} digest to ${object.digest}, not the requested ${wantedRef}`,
    );
  }
  return object.data;
}

/**
 * The oracle's bytes for `path`, proven to be the ones `wanted` names.
 *
 * `observePathState` supplies the hardened read: lexical validation, its own
 * ancestry check, a pinned handle with `O_NOFOLLOW` where available, and
 * identity checks otherwise. For a symlink, `data` is the RAW link-target bytes,
 * never a UTF-8 round trip.
 *
 * The executable bit is deliberately NOT compared: it is not sourced from the
 * oracle as bytes, it is a separate modeled property applied to the destination,
 * and the oracle host may observe a value the contribution recorded as `null`.
 *
 * The two arms are written out rather than sharing a ternary, so each `ref` is
 * reached through its own narrowed member instead of relying on a relational
 * comparison to discriminate two unions at once.
 */
async function readOracleLeaf(
  oracleWorktree: string,
  path: string,
  wanted: LeafWorktreeState,
): Promise<Buffer> {
  const { state, worktreeObject } = await observePathState(oracleWorktree, path, EMPTY_INDEX);
  const observed = state.worktree;

  if (wanted.kind === "regular") {
    if (observed.kind !== "regular") {
      throw new Error(
        `the oracle holds a ${observed.kind} at ${JSON.stringify(path)}, but the target asserts a regular file`,
      );
    }
    return verifiedBytes(path, wanted.content_ref, observed.content_ref, worktreeObject);
  }

  if (observed.kind !== "symlink") {
    throw new Error(
      `the oracle holds a ${observed.kind} at ${JSON.stringify(path)}, but the target asserts a symlink`,
    );
  }
  return verifiedBytes(path, wanted.target_ref, observed.target_ref, worktreeObject);
}

// =============================================================================
// Leaf materialization
// =============================================================================

/**
 * Apply ONLY the modeled executable fact, preserving every other mode bit, on
 * the PINNED handle rather than by pathname.
 *
 * `null` never reaches here. `true` is satisfied by any execute bit, so an
 * already-executable file is left exactly as it is and a non-executable one
 * gains owner-execute alone. `false` clears all three only when one is set.
 */
async function applyExecutable(
  handle: FileHandle,
  mode: number,
  executable: boolean,
): Promise<void> {
  const permissions = mode & 0o7777;
  const isExecutable = (permissions & 0o111) !== 0;
  if (executable === isExecutable) return;
  await handle.chmod(executable ? permissions | 0o100 : permissions & ~0o111);
}

/** Same object, still a regular file. `bigint` so large Windows inodes compare exactly. */
function sameRegularFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Create a NEW regular file and prove the created object is still reachable
 * through the validated repository path before any bytes are written.
 *
 * `O_EXCL` covers the final component. It does NOT cover ancestors: `repo/a`
 * could become a symlink after `assertAncestry` and before `open`, and the file
 * would be created outside the repository. Node has no `openat`, so creation
 * itself cannot be bound to a validated directory; what it can do is refuse to
 * WRITE into an object it can no longer vouch for.
 *
 * A failure here deliberately leaves the created file in place. Deleting by
 * pathname when ancestry is already suspect could resolve somewhere else.
 */
async function openNewRegular(
  repoRoot: string,
  path: string,
  destination: string,
): Promise<FileHandle> {
  const handle = await open(destination, CREATE_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new Error(
        `refusing to write ${JSON.stringify(path)}: the created object is not a regular file`,
      );
    }
    await assertAncestry(repoRoot, path, "materializeWorktreeLeaf");
    const after = await lstat(destination, { bigint: true });
    if (!sameRegularFile(opened, after)) {
      throw new Error(
        `refusing to write ${JSON.stringify(path)}: the path stopped naming the object that was created`,
      );
    }
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

/**
 * Open an EXISTING regular file for replacement without destroying it first.
 *
 * `O_TRUNC` is deliberately absent: it acts during `open()`, so the file would
 * be gone before the opened object could be checked. The caller truncates only
 * after this returns.
 */
async function openExistingRegular(
  repoRoot: string,
  path: string,
  destination: string,
): Promise<FileHandle> {
  const before = await lstat(destination, { bigint: true });
  if (!before.isFile()) {
    throw new Error(`cannot replace ${JSON.stringify(path)}: it stopped being a regular file`);
  }

  const handle = await open(destination, REPLACE_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameRegularFile(before, opened)) {
      throw new Error(
        `refusing to write ${JSON.stringify(path)}: the opened object is not the regular file that was classified`,
      );
    }
    // The ancestry that made this pathname meaningful must still hold, and the
    // pathname must still name the same object, before anything is destroyed.
    await assertAncestry(repoRoot, path, "materializeWorktreeLeaf");
    const after = await lstat(destination, { bigint: true });
    if (!sameRegularFile(opened, after)) {
      throw new Error(
        `refusing to write ${JSON.stringify(path)}: it stopped naming the object that was opened`,
      );
    }
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

/**
 * Materialize one regular file or symlink at `path`, sourced from the ORACLE
 * worktree.
 *
 * ALL source evidence is acquired and validated before the destination is
 * touched. In particular, an existing symlink is never unlinked until the
 * oracle's replacement target is in hand.
 */
export async function materializeWorktreeLeaf(
  repoRoot: string,
  oracleWorktree: string,
  path: string,
  target: PathState,
): Promise<void> {
  const wanted = target.worktree;
  if (wanted.kind !== "regular" && wanted.kind !== "symlink") {
    throw new Error(
      `cannot materialize ${JSON.stringify(path)} as a leaf: ${wanted.kind} is not a leaf target`,
    );
  }

  // Before ANY filesystem work: a known bit this host cannot establish means the
  // requested transition is impossible, not merely partially applicable.
  if (wanted.kind === "regular" && process.platform === "win32" && wanted.executable !== null) {
    throw new Error(
      `cannot materialize ${JSON.stringify(path)}: it asserts executable=${wanted.executable}, which this platform cannot establish or observe`,
    );
  }

  assertSafeMutationPath(path, "materializeWorktreeLeaf");

  // Source evidence first, so a malformed oracle is discovered while the real
  // checkout is still untouched.
  const data = await readOracleLeaf(oracleWorktree, path, wanted);

  await assertAncestry(repoRoot, path, "materializeWorktreeLeaf");

  const destination = abs(repoRoot, path);
  const destinationKind = await currentKind(destination);
  const compatible = wanted.kind === "regular" ? "regular" : "symlink";
  if (destinationKind !== "absent" && destinationKind !== compatible) {
    throw new Error(
      `cannot materialize the ${wanted.kind} ${JSON.stringify(path)}: a ${destinationKind} is in the way, which phase 1 should have removed`,
    );
  }

  if (wanted.kind === "symlink") {
    // Unlink only now that the replacement bytes are in hand, and never follow
    // the existing link. `symlink` then fails closed if anything reappeared.
    if (destinationKind === "symlink") await unlink(destination);
    await symlink(data, destination);
    return;
  }

  const handle =
    destinationKind === "absent"
      ? await openNewRegular(repoRoot, path, destination)
      : await openExistingRegular(repoRoot, path, destination);
  try {
    // Nothing has been written through this handle, so its position is 0 and
    // the truncation is the first destructive act of the whole operation.
    if (destinationKind !== "absent") await handle.truncate(0);
    await handle.writeFile(data);
    if (wanted.executable !== null) {
      // Unreachable on win32: a known bit threw above.
      const { mode } = await handle.stat();
      await applyExecutable(handle, mode, wanted.executable);
    }
  } finally {
    await handle.close();
  }
}
