// packages/git/src/path-state.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.8.0 step 3 -- two-axis path observation.
//
// Observes what a path IS, on two independent axes:
//
//   index axis      one `git ls-files --stage -z` read, covering every index
//                   entry including clean ones
//   worktree axis   per-path non-following classification plus pinned-handle
//                   reads. Every ancestor beneath repoRoot is checked as a real
//                   directory; final symlink substitution is prevented where
//                   O_NOFOLLOW exists and detected/refused by identity checks
//                   otherwise.
//
// INTERNAL. Not exported from the package barrel; step 4's contribution.ts is
// the consumer. The persisted schema for these values lives in
// @viberevert/session-format's path-state.ts. Same domain object, two layers:
// that module defines it, this one observes it.
//
// ============================================================================
// What this module is NOT
// ============================================================================
//
// It is not a differ. `git status` is deliberately unused: status answers "what
// changed", which is candidate-set work owned by step 4. An observer built on
// status would be restricted to changed paths, and the raw-byte candidate
// source depends on observing files Git considers clean.
//
// It is not atomic, and must never be described as a snapshot of both axes. The
// index is read at one instant and the filesystem afterwards. Step 4's end
// fence is what turns a set of observations into a coherent contribution; this
// module's only obligation is to fail closed rather than emit a state it knows
// to be stale.
//
// It performs no persistence and no object-store writes. It returns the exact
// bytes behind any ref it emits so step 4 can store them WITHOUT rereading the
// filesystem, which would otherwise open a window where the digest and the
// stored bytes disagree.
//
// ============================================================================
// Ancestor traversal
// ============================================================================
//
// Final-component protection alone is NOT enough. Given candidate `src/f.ts`,
// if `repo/src` is a symlink to somewhere outside the repository, the operating
// system resolves it during path resolution before any final-component rule
// applies. `O_NOFOLLOW` never sees it, and worse, if that ancestor symlink was
// already in place before observation began, the identity checks below validate
// the FOREIGN file perfectly consistently. The hole is stable, not racy, which
// is exactly what makes it dangerous.
//
// So every component beneath repoRoot is verified to be a real directory before
// the final component is touched. If any ancestor is absent, a file, a symlink,
// or anything else non-directory, there is no traversable working-tree path at
// that lexical location without following something VibeRevert must not follow,
// and the worktree state is `absent`.
//
// repoRoot ITSELF is deliberately not policed. A symlinked repository root is
// legitimate, common on macOS, and is the caller's declared root rather than
// something this module gets to second-guess.
//
// ============================================================================
// The identity sandwich, and why bigint
// ============================================================================
//
// `lstat` then `readFile(path)` is a real race, not a theoretical one: between
// the two calls the entry can become a symlink and the read follows it out of
// the repository. So content is read from a pinned FileHandle, never from the
// path, and every modeled fact is checked on both sides:
//
//   ancestors traversable
//   lstat(path, bigint)   must be regular
//   open(path, O_RDONLY | O_NOFOLLOW-when-available)
//   fh.stat(bigint)       must be regular, same dev + ino, same executable bit
//   ancestors STILL traversable
//   lstat(path, bigint)   must be regular, same dev + ino, same executable bit
//   read from the HANDLE
//
// The executable bit is fenced alongside identity because it is MODELED state,
// and `chmod` does not change an inode. Without that check the sequence
// lstat / chmod +x / open / fstat / lstat-after passes every identity test
// while the emitted state disagrees with every later observation of the same
// file.
//
// An ancestor that was traversable and stops being traversable mid-observation
// is movement, so it throws. An ancestor that was never traversable is simply
// `absent`. The two are different facts and are reported differently.
//
// `{ bigint: true }` is load-bearing rather than stylistic. A Windows inode
// observed on this project measured 46443371159672050, roughly five times
// Number.MAX_SAFE_INTEGER, so a numeric comparison compares two ROUNDED
// doubles and two genuinely different inodes can compare equal. BigIntStats
// makes the identity check exact.
//
// `O_NOFOLLOW` is undefined on win32, so it is applied opportunistically. Where
// present it prevents final-component substitution at open time. Where absent
// the open may transiently follow a substituted symlink, but `fstat` then
// reports the target's identity, the comparison fails, and the observation is
// refused. Prevention on POSIX, detection everywhere else.
//
// The same discipline guards symlinks. `readlink` does not follow its target,
// but the directory entry itself can still be swapped between classification
// and read, and its ancestors can move underneath it.
//
// What this deliberately does NOT attempt: repeated reads, content re-hashing,
// or any home-grown locking. Node exposes no `openat`, so none of this is a
// filesystem transaction. A concurrent in-place write to the same inode stays
// possible. The handle guarantees the bytes came from the object we classified;
// proving the wider observation did not move is step 4's fence.

import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  IndexEntryMode,
  IndexState,
  PathState,
  UnmergedStage,
  WorktreeState,
} from "@viberevert/session-format";
import { IndexStateSchema, PathStateSchema } from "@viberevert/session-format";

import { runGit, splitNulList } from "./git-cli.js";
import { repoRelativePathSafetyError } from "./path-safety.js";

/**
 * `O_NOFOLLOW` is absent on win32, where the runtime constant is simply not
 * defined. The cast states that plainly rather than trusting the ambient
 * typing, which declares it unconditionally.
 */
const O_NOFOLLOW_OR_ZERO = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

// ============================================================================
// Errors
// ============================================================================

/**
 * Raised when a path cannot be observed coherently: a malformed index record,
 * an impossible index state, or a filesystem entry whose identity, ancestry, or
 * modeled mode moved while it was being observed.
 *
 * Every one of these is a refusal, never a downgrade to a best-effort value. A
 * recovery tool that guesses about the state it is recovering from is worse
 * than one that stops.
 */
export class PathObservationError extends Error {
  override readonly name = "PathObservationError";
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

// ============================================================================
// Path safety
// ============================================================================

/**
 * Error-contract adapter over the package's shared lexical authority.
 *
 * The rules, their order, and their exact message text live once in
 * path-safety.ts. This wrapper only chooses the error type, because
 * PathObservationError additionally carries the offending `path` and callers
 * refuse on it by type.
 *
 * The duplication this replaces was deliberate while there were two copies, on
 * the reasoning that two guards fail closed twice. The comment here reserved
 * the moment for extraction: step 4b's contribution.ts is that third consumer.
 *
 * Lexical only. It stops `..` and absolute paths; it says nothing about what
 * the components actually are on disk, which is what `ancestorsTraversable`
 * exists for.
 */
function assertSafeRepoRelativePath(path: string, context: string): void {
  const message = repoRelativePathSafetyError(path, context);
  if (message !== null) {
    throw new PathObservationError(message, path);
  }
}

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
async function ancestorsTraversable(
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

// ============================================================================
// Index snapshot
// ============================================================================

/**
 * Every index entry at one instant, keyed by repo-relative POSIX path.
 *
 * Paths absent from the map are absent from the index; `observePathState`
 * resolves that to `{ kind: "absent" }` rather than storing a placeholder.
 */
export interface IndexSnapshot {
  readonly byPath: ReadonlyMap<string, IndexState>;
}

/** One raw `ls-files --stage` record, before grouping. */
interface StageRecord {
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
  readonly path: string;
}

/**
 * Parse one NUL-delimited `git ls-files --stage -z` record.
 *
 * Format: `<mode> SP <oid> SP <stage> TAB <path>`. The split is at the FIRST
 * tab only. Whitespace-splitting the whole record would corrupt any path
 * containing a space or tab, and a corrupted path in a recovery tool is worse
 * than a refusal.
 */
function parseStageRecord(record: string, index: number): StageRecord {
  const tab = record.indexOf("\t");
  if (tab === -1) {
    throw new PathObservationError(
      `git ls-files --stage -z: record ${index} has no tab separator: ${JSON.stringify(record)}`,
    );
  }
  const meta = record.slice(0, tab);
  const path = record.slice(tab + 1);
  const parts = meta.split(" ");
  if (parts.length !== 3) {
    throw new PathObservationError(
      `git ls-files --stage -z: record ${index} metadata is not 3 tokens: ${JSON.stringify(meta)}`,
    );
  }
  const [mode, oid, stageRaw] = parts;
  if (mode === undefined || oid === undefined || stageRaw === undefined) {
    throw new PathObservationError(
      `git ls-files --stage -z: record ${index} metadata is incomplete: ${JSON.stringify(meta)}`,
    );
  }
  if (!/^[0-3]$/.test(stageRaw)) {
    throw new PathObservationError(
      `git ls-files --stage -z: record ${index} has stage ${JSON.stringify(stageRaw)}, expected 0-3`,
      path,
    );
  }
  return { mode, oid, stage: Number.parseInt(stageRaw, 10), path };
}

/**
 * Build the `IndexState` for one path from its records.
 *
 * Stage 0 is a resolved entry; stages 1-3 are conflict stages. Both together is
 * impossible in a real index and is refused rather than reconciled. Stages are
 * sorted ascending because `UnmergedEntriesSchema` requires the canonical
 * representation: `contribution_sha256` is computed over deterministic bytes,
 * so one conflict state must have exactly one encoding.
 *
 * Final validation is delegated to `IndexStateSchema`, which owns the mode
 * vocabulary and the Git OID widths. Re-implementing either here would let this
 * module drift from the persisted contract.
 */
function toIndexState(path: string, records: readonly StageRecord[]): IndexState {
  const resolved = records.filter((r) => r.stage === 0);
  const conflicts = records.filter((r) => r.stage !== 0);

  if (resolved.length > 0 && conflicts.length > 0) {
    throw new PathObservationError(
      `index entry ${JSON.stringify(path)} has both a stage-0 entry and conflict stages`,
      path,
    );
  }
  if (resolved.length > 1) {
    throw new PathObservationError(
      `index entry ${JSON.stringify(path)} has ${resolved.length} stage-0 entries`,
      path,
    );
  }

  let candidate: unknown;
  const only = resolved[0];
  if (only !== undefined) {
    candidate = { kind: "entry", mode: only.mode, oid: only.oid };
  } else {
    const seen = new Set<number>();
    for (const c of conflicts) {
      if (seen.has(c.stage)) {
        throw new PathObservationError(
          `index entry ${JSON.stringify(path)} has duplicate stage ${c.stage}`,
          path,
        );
      }
      seen.add(c.stage);
    }
    const entries: UnmergedStage[] = [...conflicts]
      .sort((a, b) => a.stage - b.stage)
      .map((c) => ({
        stage: c.stage as UnmergedStage["stage"],
        mode: c.mode as IndexEntryMode,
        oid: c.oid,
      }));
    candidate = { kind: "unmerged", entries };
  }

  const parsed = IndexStateSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PathObservationError(
      `index entry ${JSON.stringify(path)} is not a valid IndexState: ${parsed.error.message}`,
      path,
    );
  }
  return parsed.data;
}

/**
 * Read the whole index once.
 *
 * One call rather than one per path: pathspec semantics are avoided entirely,
 * and step 4 gets a deterministic index instant to pair its filesystem
 * observations against.
 */
export async function readIndexSnapshot(repoRoot: string): Promise<IndexSnapshot> {
  const buf = await runGit(repoRoot, ["ls-files", "--stage", "-z"]);
  const records = splitNulList(buf).filter((r) => r.length > 0);

  const grouped = new Map<string, StageRecord[]>();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined) continue;
    const parsed = parseStageRecord(record, i);
    const bucket = grouped.get(parsed.path);
    if (bucket === undefined) grouped.set(parsed.path, [parsed]);
    else bucket.push(parsed);
  }

  const byPath = new Map<string, IndexState>();
  for (const [path, group] of grouped) {
    byPath.set(path, toIndexState(path, group));
  }
  return { byPath };
}

// ============================================================================
// Worktree observation
// ============================================================================

/** Exact bytes behind a ref this module emitted, so step 4 need not reread. */
export interface ObservedObject {
  readonly digest: string;
  readonly data: Buffer;
}

/**
 * One path's observed state plus the payload for whatever ref it carries.
 *
 * `worktreeObject.digest` is ALWAYS the `content_ref` or `target_ref` inside
 * `state.worktree`. Singular and optional rather than an array: today a
 * worktree state carries at most one ref, and a speculative array would invite
 * callers to guess which element matched which ref.
 */
export interface PathStateObservation {
  readonly state: PathState;
  readonly worktreeObject?: ObservedObject;
}

interface WorktreeObservation {
  readonly worktree: WorktreeState;
  readonly object?: ObservedObject;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The modeled executable bit for a worktree mode.
 *
 * `null` on win32 means UNOBSERVABLE, never `false`. Factored out so the same
 * derivation feeds every side of the observation fence; comparing raw modes
 * instead would refuse on bits this model does not claim to track.
 */
function executableFromMode(mode: bigint): boolean | null {
  return process.platform === "win32" ? null : (mode & 0o111n) !== 0n;
}

/**
 * Read a regular file through a pinned handle, verifying ancestry, identity,
 * and the modeled executable bit on both sides. See the identity-sandwich
 * section in this file's header.
 */
async function observeRegular(
  repoRoot: string,
  segments: readonly string[],
  absPath: string,
  relPath: string,
  before: BigIntStats,
): Promise<WorktreeObservation> {
  const executableBefore = executableFromMode(before.mode);

  const fh = await open(absPath, constants.O_RDONLY | O_NOFOLLOW_OR_ZERO);
  try {
    const handleStat = await fh.stat({ bigint: true });
    if (!handleStat.isFile()) {
      throw new PathObservationError(
        `${relPath}: opened object is no longer a regular file`,
        relPath,
      );
    }
    if (handleStat.dev !== before.dev || handleStat.ino !== before.ino) {
      throw new PathObservationError(
        `${relPath}: opened a different filesystem object than the one classified`,
        relPath,
      );
    }

    // Modeled state, so it is fenced like identity. `chmod` preserves the
    // inode, which is exactly why dev/ino alone cannot catch this.
    const executableHandle = executableFromMode(handleStat.mode);
    if (executableHandle !== executableBefore) {
      throw new PathObservationError(
        `${relPath}: executable state changed during observation`,
        relPath,
      );
    }

    // Ancestry was traversable when this observation started. Losing it now is
    // movement, not an initial absence, so it refuses rather than reporting
    // `absent`.
    if (!(await ancestorsTraversable(repoRoot, segments))) {
      throw new PathObservationError(
        `${relPath}: an ancestor stopped being a traversable directory during observation`,
        relPath,
      );
    }

    const after = await lstat(absPath, { bigint: true });
    if (!after.isFile() || after.dev !== handleStat.dev || after.ino !== handleStat.ino) {
      throw new PathObservationError(
        `${relPath}: path stopped naming the observed object during observation`,
        relPath,
      );
    }
    const executableAfter = executableFromMode(after.mode);
    if (executableAfter !== executableHandle) {
      throw new PathObservationError(
        `${relPath}: executable state changed during observation`,
        relPath,
      );
    }

    const data = await fh.readFile();
    const digest = sha256(data);
    // Executability comes from the WORKTREE's own mode. Deriving it from the
    // index mode would collapse the two axes this model exists to separate.
    return {
      worktree: { kind: "regular", content_ref: digest, executable: executableHandle },
      object: { digest, data },
    };
  } finally {
    await fh.close();
  }
}

/**
 * Read a symlink's raw target bytes, verifying ancestry and identity on both
 * sides.
 *
 * The digest is over the exact bytes `readlink` returned, with no UTF-8 decode
 * and re-encode. Normalizing the target as text would make the recorded ref
 * disagree with the bytes step 4 stores. Hashing happens only after every
 * validation has passed.
 */
async function observeSymlink(
  repoRoot: string,
  segments: readonly string[],
  absPath: string,
  relPath: string,
  before: BigIntStats,
): Promise<WorktreeObservation> {
  const target = await readlink(absPath, { encoding: "buffer" });

  if (!(await ancestorsTraversable(repoRoot, segments))) {
    throw new PathObservationError(
      `${relPath}: an ancestor stopped being a traversable directory during observation`,
      relPath,
    );
  }

  const after = await lstat(absPath, { bigint: true });
  if (!after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new PathObservationError(
      `${relPath}: path stopped naming the observed symlink during observation`,
      relPath,
    );
  }

  const digest = sha256(target);
  return {
    worktree: { kind: "symlink", target_ref: digest },
    object: { digest, data: target },
  };
}

async function observeWorktree(
  repoRoot: string,
  segments: readonly string[],
  absPath: string,
  relPath: string,
): Promise<WorktreeObservation> {
  // Before anything touches the final component: if the lexical location is not
  // reachable without following a non-directory, there is no worktree state
  // here to observe.
  if (!(await ancestorsTraversable(repoRoot, segments))) {
    return { worktree: { kind: "absent" } };
  }

  let st: BigIntStats;
  try {
    st = await lstat(absPath, { bigint: true });
  } catch (err) {
    if (isEnoent(err)) return { worktree: { kind: "absent" } };
    throw err;
  }

  if (st.isFile()) return observeRegular(repoRoot, segments, absPath, relPath, st);
  if (st.isSymbolicLink()) return observeSymlink(repoRoot, segments, absPath, relPath, st);
  if (st.isDirectory()) return { worktree: { kind: "directory" } };

  // Everything else is observed but not modeled as restorable state. The
  // vocabulary is a closed enum in the schema, so a genuinely new kind lands on
  // `unknown` rather than inventing a member.
  if (st.isFIFO()) return { worktree: { kind: "unsupported", fs_kind: "fifo" } };
  if (st.isSocket()) return { worktree: { kind: "unsupported", fs_kind: "socket" } };
  if (st.isBlockDevice()) return { worktree: { kind: "unsupported", fs_kind: "block_device" } };
  if (st.isCharacterDevice()) {
    return { worktree: { kind: "unsupported", fs_kind: "character_device" } };
  }
  return { worktree: { kind: "unsupported", fs_kind: "unknown" } };
}

// ============================================================================
// The observation
// ============================================================================

/**
 * Observe both axes for one repo-relative POSIX path.
 *
 * The returned state is validated against `PathStateSchema` before it is handed
 * back, so a caller never receives something the persisted format would reject.
 */
export async function observePathState(
  repoRoot: string,
  path: string,
  index: IndexSnapshot,
): Promise<PathStateObservation> {
  assertSafeRepoRelativePath(path, "observePathState.path");
  const segments = path.split("/");
  const absPath = join(repoRoot, ...segments);

  const { worktree, object } = await observeWorktree(repoRoot, segments, absPath, path);
  const indexState: IndexState = index.byPath.get(path) ?? { kind: "absent" };

  const parsed = PathStateSchema.safeParse({ worktree, index: indexState });
  if (!parsed.success) {
    throw new PathObservationError(
      `${path}: observed state is not a valid PathState: ${parsed.error.message}`,
      path,
    );
  }

  return object === undefined
    ? { state: parsed.data }
    : { state: parsed.data, worktreeObject: object };
}

// ============================================================================
// Structural equality (explicit, never JSON.stringify)
// ============================================================================
//
// Key order in a Zod-parsed object follows its input, so stringify-based
// comparison would be order-sensitive on values this code compares for
// EQUALITY to decide whether the world moved. These are written out.
//
// Moved here from contribution.ts (M 0.8.0 step 10A) as a literal move: same
// bodies, same semantics, no renaming. They were private to a CAPTURE module,
// but selective restore needs the identical notion of equality for plan
// stabilization, oracle evidence validation, the protected-domain fence, and
// post-operation verification. Two independent definitions of "the same
// PathState" is exactly the drift that would let the contribution fence and the
// restore fence disagree about whether the world moved.
//
// Package-internal: NOT barrel-exported. Siblings import relatively.

export function worktreeStateEqual(a: WorktreeState, b: WorktreeState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "regular" && b.kind === "regular") {
    return a.content_ref === b.content_ref && a.executable === b.executable;
  }
  if (a.kind === "symlink" && b.kind === "symlink") return a.target_ref === b.target_ref;
  if (a.kind === "unsupported" && b.kind === "unsupported") return a.fs_kind === b.fs_kind;
  return true; // absent | directory carry no further fields
}

export function indexStateEqual(a: IndexState, b: IndexState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "entry" && b.kind === "entry") return a.mode === b.mode && a.oid === b.oid;
  if (a.kind === "unmerged" && b.kind === "unmerged") {
    if (a.entries.length !== b.entries.length) return false;
    return a.entries.every((e, i) => {
      const other = b.entries[i];
      return (
        other !== undefined &&
        e.stage === other.stage &&
        e.mode === other.mode &&
        e.oid === other.oid
      );
    });
  }
  return true; // absent
}

export function pathStateEqual(a: PathState, b: PathState): boolean {
  return worktreeStateEqual(a.worktree, b.worktree) && indexStateEqual(a.index, b.index);
}

/**
 * Membership AND value equality in one pass: the size check plus the
 * `b.get(key)` miss together prove the key sets are identical, so a path
 * appearing or vanishing is caught, not only a path changing.
 *
 * Generic rather than PathState-specific, which sits a little loosely under
 * this filename. Its only callers compare PathState / IndexState maps, and a
 * separate module for a four-line comparator would be worse than the mild
 * mismatch.
 */
export function mapsEqual<V>(
  a: ReadonlyMap<string, V>,
  b: ReadonlyMap<string, V>,
  equal: (x: V, y: V) => boolean,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || !equal(value, other)) return false;
  }
  return true;
}

// ============================================================================
// Test-only exports (NOT in barrel; _*ForTests convention)
// ============================================================================

export const _parseStageRecordForTests = parseStageRecord;
export const _toIndexStateForTests = toIndexState;
