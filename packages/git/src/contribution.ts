// packages/git/src/contribution.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.8.0 step 4b -- session contribution capture.
//
// Produces the durable record of what a session CONTRIBUTED, as opposed to the
// checkpoint's record of what existed before it. Before 0.8.0 the after-state
// was two status files: path sets with no content, no digests, and no index
// state, gone the moment the user edited again.
//
// ============================================================================
// What this module owns, and what it deliberately does not
// ============================================================================
//
// OWNS: candidate assembly, path observation, mirror population, rename
// acceptance, entry derivation, the end-state fence, and validation against
// SessionContributionFileSchema.
//
// DOES NOT own:
//   object storage        `putObject` lives in @viberevert/core, and git must
//                         not import core or the package graph stops being
//                         acyclic. Bytes leave through an injected sink.
//   contribution writing  core publishes the artifact; this module never
//                         computes `contribution_sha256`, preserving the
//                         canonicalize-once-at-orchestration invariant.
//   the end lock          cli-commands holds it around the whole transaction.
//   framework rules       core owns D42. This module observes the paths and
//                         hands the states to the caller; it never evaluates
//                         a signature.
//   the clock             capture NEVER samples time. `ended_at` is supplied
//                         by the caller, once, inside `publish`.
//
// The last two are why `captureContribution` takes a generic `publish`
// callback rather than returning a finished artifact: the caller evaluates
// frameworks with core, samples `ended_at` exactly once, builds the
// contribution through `buildContributionFile`, and calls `core.endSession`,
// all while the oracle is still alive and the fenced state still holds.
//
// ============================================================================
// Attempt sequencing (locked)
// ============================================================================
//
//   ONCE inside the oracle:
//     validate manifest.session_id against the caller's session id
//     read the immutable BEFORE index
//     read the immutable oracle tracked status (a BEFORE candidate source)
//
//   FOR attempt 1..MAX_CAPTURE_ATTEMPTS:
//     fresh before-<n> / after-<n> mirrors
//     Pass A     complete live acquisition; eager object storage; after-<n>
//     BEFORE     observe every candidate and extra once; storage; before-<n>
//     derive     renames, entries, elision, classification, content_delta
//     Pass B     recompute the complete live vector; NO storage, NO mirrors
//     compare    mismatch -> abandon this attempt and retry
//                match    -> assemble and publish IMMEDIATELY
//
// Pass B is the LAST live observation before publication, on purpose. Doing
// derivation after the fence would reopen the window the fence exists to
// close: the world could move between "proven stable" and "published".
//
// A failed attempt leaves stored objects on both sides. That is inside the
// locked orphan model, and it is the price of never deriving after the fence.
//
// ============================================================================
// Observe once, per path, per side, per attempt
// ============================================================================
//
// The live side needs real cache machinery because of an ordering constraint
// that is easy to get wrong. The raw-byte inventory is ITSELF a candidate
// source, so it must run before the candidate set is final; but the inventory
// scan must not retain bytes, or memory becomes O(sum of tracked files)
// instead of O(largest observed file).
//
// The resolution is ordering: every CHEAP candidate source runs first, so by
// the time the inventory scan holds a file's bytes, that file's candidacy is
// already fully determined and the storage decision can be made on the spot.
//
// **The cache therefore holds PathState only, never PathStateObservation.**
// An observation carries the payload Buffer; caching it would defeat the whole
// ordering exercise silently, since nothing would fail, memory would simply
// scale with repository size. Payloads are consumed the moment they are
// produced and then dropped.
//
// ============================================================================
// Storage eligibility is NOT mirror eligibility
// ============================================================================
//
// Mirrors exist to produce hunks, so they take regular files only. The OBJECT
// STORE exists to make the evidence chain resolvable, so it takes every
// payload a candidate's PathState references. A symlink's `target_ref` names
// the raw link-target bytes; persisting that digest without storing the bytes
// would leave every symlink unrecoverable while looking perfectly valid.
//
//   candidate, any payload    -> sink
//   candidate, regular only   -> sink AND mirror
//   observation-only extra    -> neither
//   Pass B                    -> neither, ever

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ContentDelta,
  ContributionFacet,
  ContributionOperation,
  DiffHunk,
  IndexState,
  Manifest,
  PathState,
  SessionContributionEntry,
  SessionContributionFile,
  WorktreeState,
} from "@viberevert/session-format";
import {
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  deriveChangeGroupId,
  SessionContributionFileSchema,
} from "@viberevert/session-format";
import picomatch from "picomatch";

import { withCheckpointOracle } from "./checkpoint-oracle.js";
import {
  diffPreparedMirrors,
  type NameStatusEntry,
  PICOMATCH_OPTIONS,
  type PreparedMirrorDiffEntry,
  parseNameStatus,
  type RawDiffHunk,
} from "./diff.js";
import {
  getHeadSha,
  getStatusPorcelainText,
  getStatusPorcelainZ,
  getStatusPorcelainZRaw,
  parseStatusPorcelainZ,
  runGit,
  type StatusEntry,
  splitNulList,
} from "./git-cli.js";
import { isViberevertStorePath, repoRelativePathSafetyError } from "./path-safety.js";
import { type IndexSnapshot, observePathState, readIndexSnapshot } from "./path-state.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Attempts allowed before capture gives up and leaves the session ACTIVE.
 *
 * Fixed rather than an option. How many times capture re-proves stability is
 * an integrity property of the artifact, not a policy a caller should be able
 * to relax to 1 or stretch to 50.
 */
const MAX_CAPTURE_ATTEMPTS = 3;

/** mkdtemp prefix for this module's oracle scratch root. */
const CONTRIBUTION_TEMP_DIR_PREFIX = "viberevert-contribution-";

/** Index modes that both denote a regular file, differing only in the exec bit. */
const REGULAR_INDEX_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

// ============================================================================
// Errors
// ============================================================================

/**
 * The working tree moved while it was being captured, on every attempt.
 *
 * Carries EVERY differing fence member rather than the first, because one
 * edit routinely moves HEAD, status, the index, the inventory, and the
 * candidate set together. Reporting only the first would make the diagnostic
 * depend on comparison order rather than on what actually happened.
 */
export class EndStateChangedDuringCaptureError extends Error {
  override readonly name = "EndStateChangedDuringCaptureError";
  constructor(
    readonly attemptCount: number,
    readonly changedMembers: readonly string[],
  ) {
    super(
      `end-state capture did not stabilize after ${attemptCount} attempts; these observations changed: ${changedMembers.join(", ")}`,
    );
  }
}

/**
 * Two accepted rename pairs compete for one path.
 *
 * Raised only AFTER four-state acceptance and after compatible duplicates have
 * been collapsed. A proposal that fails acceptance is not a conflict, it is
 * simply not a session rename, and its paths fall through to ordinary
 * derivation.
 *
 * No declared constructor: the message already names both claimants and their
 * sources, and inventing structured fields no caller reads would be scope
 * rather than error design.
 */
export class ConflictingRenameProposalError extends Error {
  override readonly name = "ConflictingRenameProposalError";
}

/** The checkpoint does not belong to the session being captured. */
export class SessionCheckpointBindingError extends Error {
  override readonly name = "SessionCheckpointBindingError";
  constructor(
    readonly sessionId: string,
    readonly manifestSessionId: string,
  ) {
    super(
      `checkpoint belongs to session ${JSON.stringify(manifestSessionId)}, not ${JSON.stringify(sessionId)}`,
    );
  }
}

// ============================================================================
// Public types
// ============================================================================

/** Bytes plus the digest they must be stored under. */
export interface ContributionObject {
  readonly digest: string;
  readonly data: Buffer;
}

/**
 * Storage adapter. Git supplies bytes and the expected digest; the caller
 * proves it stored those bytes under that digest, or throws.
 *
 * Returns void deliberately. `putObject`'s return contract belongs to
 * @viberevert/core, and asserting on it here would drag core's API across a
 * package boundary that exists to stay one-directional.
 */
export type ContributionObjectSink = (object: ContributionObject) => Promise<void>;

/**
 * Everything a publisher needs, proven stable by a matching fence.
 *
 * `capturedAt` is the CHECKPOINT's timestamp, never re-sampled, so a retry
 * cannot change it. `endedAt` is absent on purpose: capture does not read a
 * clock.
 */
export interface StableContributionCapture {
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly capturedAt: string;
  readonly beforeHeadSha: string;
  readonly afterHeadSha: string;
  /** Sorted by path, duplicate-free, content_delta already attached. */
  readonly entries: readonly SessionContributionEntry[];
  /**
   * End-side state for the WHOLE observation set, including additional
   * observation paths that never became candidates. That superset is the
   * point: framework signatures must be evaluable from paths that did not
   * change.
   */
  readonly endWorktreeStates: ReadonlyMap<string, WorktreeState>;
  /** `git status --porcelain=v1`, audit form. Never parsed (D8). */
  readonly afterStatusText: string;
  /** `git status --porcelain=v1 -z`, the machine surface. */
  readonly afterStatusZRaw: Buffer;
}

export interface CaptureContributionOptions<T> {
  readonly sessionId: string;
  readonly checkpointId: string;
  /**
   * Paths to observe at end even when they never change, unioned into the
   * observation set on BOTH sides. Sorted, deduped, and path-validated before
   * use; naming the store here is a caller bug and throws.
   *
   * The framework-signature set arrives this way rather than being imported,
   * because those rules live in @viberevert/core and git must not depend on
   * core.
   */
  readonly additionalObservationPaths: readonly string[];
  /**
   * `rollback.exclude` patterns, applied to the END UNTRACKED SURFACE ONLY.
   * Tracked paths are never dropped for matching an exclude pattern; that
   * asymmetry is the shipped restore contract, and breaking it here would
   * break the `--only '**'` equivalence property.
   */
  readonly untrackedExcludePatterns: readonly string[];
  readonly storeObject: ContributionObjectSink;
  /**
   * Invoked once, inside the oracle, immediately after a matching fence.
   * Whatever it returns is returned to the caller unchanged.
   */
  readonly publish: (capture: StableContributionCapture) => Promise<T>;
}

export interface ContributionCaptureResult<T> {
  readonly value: T;
  /** Oracle cleanup warnings. NEVER causes a throw. */
  readonly cleanupWarnings: readonly string[];
}

export interface BuildContributionOptions {
  /** Sampled ONCE by the caller. Capture never reads a clock. */
  readonly endedAt: string;
  /**
   * Present for `auto` framework mode, absent for `explicit`, where detection
   * is not consulted at all.
   */
  readonly detectedFrameworksAtEnd?: readonly string[];
}

// ============================================================================
// Path policy
// ============================================================================

/**
 * Validator for `parseNameStatus` that tolerates store paths structurally.
 *
 * The store exclusion is applied at candidate assembly, not here, so that a
 * rename `src/a.ts -> .viberevert/a.ts` still surfaces both aliases and
 * `src/a.ts` survives as an ordinary deletion. See diff.ts.
 */
function validatePathAllowingStore(path: string, context: string): void {
  if (isViberevertStorePath(path)) return;
  const message = repoRelativePathSafetyError(path, context);
  if (message !== null) throw new Error(message);
}

/**
 * Add a path to the candidate set under the capture policy: store paths are
 * EXCLUDED, everything else unsafe REFUSES.
 *
 * A tracked or force-added store path must not make `end` fail; it simply
 * falls outside the recovery domain. Any other unsafe path is a real signal.
 */
function addCandidate(into: Set<string>, path: string, context: string): void {
  if (isViberevertStorePath(path)) return;
  const message = repoRelativePathSafetyError(path, context);
  if (message !== null) throw new Error(message);
  into.add(path);
}

/**
 * Sort, dedupe, and validate caller-supplied observation paths.
 *
 * Unlike candidates, a store path here THROWS. These come from the caller
 * rather than from git output, so naming the store is a programming error,
 * and silently treating it as a framework observation surface would hide it.
 */
function normalizeObservationPaths(paths: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const path of paths) {
    if (isViberevertStorePath(path)) {
      throw new Error(
        `captureContribution: additionalObservationPaths must not name the VibeRevert store, got ${JSON.stringify(path)}`,
      );
    }
    const message = repoRelativePathSafetyError(
      path,
      "captureContribution.additionalObservationPaths",
    );
    if (message !== null) throw new Error(message);
    out.add(path);
  }
  return [...out].sort();
}

// ============================================================================
// Structural equality (explicit, never JSON.stringify)
// ============================================================================
//
// Key order in a Zod-parsed object follows its input, so stringify-based
// comparison would be order-sensitive on values this code compares for
// EQUALITY to decide whether the world moved. These are written out.

function worktreeStateEqual(a: WorktreeState, b: WorktreeState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "regular" && b.kind === "regular") {
    return a.content_ref === b.content_ref && a.executable === b.executable;
  }
  if (a.kind === "symlink" && b.kind === "symlink") return a.target_ref === b.target_ref;
  if (a.kind === "unsupported" && b.kind === "unsupported") return a.fs_kind === b.fs_kind;
  return true; // absent | directory carry no further fields
}

function indexStateEqual(a: IndexState, b: IndexState): boolean {
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

function pathStateEqual(a: PathState, b: PathState): boolean {
  return worktreeStateEqual(a.worktree, b.worktree) && indexStateEqual(a.index, b.index);
}

function statusEntriesEqual(a: readonly StatusEntry[], b: readonly StatusEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      e.statusXY === other.statusXY &&
      e.path === other.path &&
      e.previousPath === other.previousPath
    );
  });
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function mapsEqual<V>(
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

function indexSnapshotEqual(a: IndexSnapshot, b: IndexSnapshot): boolean {
  return mapsEqual(a.byPath, b.byPath, indexStateEqual);
}

// ============================================================================
// Classification (the locked derivation contract)
// ============================================================================

/** A path exists in the supported model if EITHER axis has it. */
function present(state: PathState): boolean {
  return state.worktree.kind !== "absent" || state.index.kind !== "absent";
}

/**
 * Worktree type class. `unsupported` is refined by `fs_kind` so a fifo
 * becoming a socket reads as a type change rather than as no change.
 */
function worktreeTypeClass(state: WorktreeState): string {
  return state.kind === "unsupported" ? `unsupported:${state.fs_kind}` : state.kind;
}

/**
 * Index type EVIDENCE, or null when the index cannot testify.
 *
 * `absent` and `unmerged` yield null rather than a class. `absent -> entry` is
 * staging an untracked file, which is `index_changed`, not a type change, and
 * an unmerged path has three candidate modes with no basis to pick one.
 */
function indexTypeClass(state: IndexState): "regular" | "symlink" | "gitlink" | null {
  if (state.kind !== "entry") return null;
  if (state.mode === "120000") return "symlink";
  if (state.mode === "160000") return "gitlink";
  return "regular";
}

function classifyOperation(
  before: PathState,
  after: PathState,
  isAcceptedRename: boolean,
): ContributionOperation {
  if (isAcceptedRename) return "renamed";

  const beforePresent = present(before);
  const afterPresent = present(after);
  if (!beforePresent && afterPresent) return "added";
  if (beforePresent && !afterPresent) return "deleted";

  const beforeClass = worktreeTypeClass(before.worktree);
  const afterClass = worktreeTypeClass(after.worktree);
  if (beforeClass !== "absent" && afterClass !== "absent" && beforeClass !== afterClass) {
    return "type_changed";
  }

  const beforeIndexClass = indexTypeClass(before.index);
  const afterIndexClass = indexTypeClass(after.index);
  if (
    beforeIndexClass !== null &&
    afterIndexClass !== null &&
    beforeIndexClass !== afterIndexClass
  ) {
    return "type_changed";
  }

  return "modified";
}

function deriveFacets(before: PathState, after: PathState): ContributionFacet[] {
  const facets: ContributionFacet[] = [];
  const bw = before.worktree;
  const aw = after.worktree;

  const contentChanged =
    (bw.kind === "regular" && aw.kind === "regular" && bw.content_ref !== aw.content_ref) ||
    (bw.kind === "symlink" && aw.kind === "symlink" && bw.target_ref !== aw.target_ref);
  if (contentChanged) facets.push("content_changed");

  // Either axis may establish a mode change. The index clause is what makes
  // `100644 -> 100755` observable on Windows, where both worktree `executable`
  // values are null and the worktree axis can say nothing at all.
  const worktreeModeChanged =
    bw.kind === "regular" &&
    aw.kind === "regular" &&
    bw.executable !== null &&
    aw.executable !== null &&
    bw.executable !== aw.executable;
  const indexModeChanged =
    before.index.kind === "entry" &&
    after.index.kind === "entry" &&
    REGULAR_INDEX_MODES.has(before.index.mode) &&
    REGULAR_INDEX_MODES.has(after.index.mode) &&
    before.index.mode !== after.index.mode;
  if (worktreeModeChanged || indexModeChanged) facets.push("mode_changed");

  if (!indexStateEqual(before.index, after.index)) facets.push("index_changed");

  const beforeClass = worktreeTypeClass(bw);
  const afterClass = worktreeTypeClass(aw);
  if (beforeClass !== "absent" && afterClass !== "absent" && beforeClass !== afterClass) {
    facets.push("worktree_kind_changed");
  }

  return facets.sort();
}

// ============================================================================
// Content delta
// ============================================================================

/** git's in-memory camelCase hunks to the persisted snake_case form. */
function toPersistedHunks(hunks: readonly RawDiffHunk[]): DiffHunk[] {
  return hunks.map((h) => ({
    old_start: h.oldStart,
    old_lines: h.oldLines,
    new_start: h.newStart,
    new_lines: h.newLines,
    lines: h.lines.map((l) => ({ kind: l.kind, text: l.text })),
  }));
}

/**
 * Eligibility gates the mirror analysis; the analysis decides the value.
 *
 * Only the four absent/regular transitions are eligible. `absent -> absent`
 * has no content on either side and is `none` by definition. For the other
 * three the mirror decides, and eligible does NOT mean `text`: a mode-only
 * change, an added empty file, and a deleted empty file are all eligible and
 * all resolve to `none`, which is what the schema requires since `text` must
 * carry at least one hunk.
 */
function deriveContentDelta(
  before: PathState,
  after: PathState,
  mirror: PreparedMirrorDiffEntry | undefined,
): ContentDelta {
  const beforeKind = before.worktree.kind;
  const afterKind = after.worktree.kind;
  const eligible =
    (beforeKind === "absent" || beforeKind === "regular") &&
    (afterKind === "absent" || afterKind === "regular");
  if (!eligible) return { kind: "none" };
  if (beforeKind === "absent" && afterKind === "absent") return { kind: "none" };
  if (mirror === undefined) return { kind: "none" };
  if (mirror.isBinary) return { kind: "binary" };
  if (mirror.hunks.length === 0) return { kind: "none" };
  return { kind: "text", hunks: toPersistedHunks(mirror.hunks) };
}

// ============================================================================
// Rename proposals
// ============================================================================

interface RenameProposal {
  readonly path: string;
  readonly previousPath: string;
  readonly source: string;
}

/**
 * Collect proposals from the two authorities.
 *
 * Committed-delta renames come from `parseNameStatus`, which fails closed on
 * copy tokens. End-status renames are accepted only for a literal `R` in
 * either position: `parseStatusPorcelainZ` also populates `previousPath` for
 * `C`, and a copy is not a rename because the source still exists.
 */
function collectRenameProposals(
  committedDelta: readonly NameStatusEntry[],
  trackedStatus: readonly StatusEntry[],
): RenameProposal[] {
  const proposals: RenameProposal[] = [];
  for (const entry of committedDelta) {
    if (entry.status === "renamed" && entry.previous_path !== undefined) {
      proposals.push({
        path: entry.path,
        previousPath: entry.previous_path,
        source: "committed-delta",
      });
    }
  }
  for (const entry of trackedStatus) {
    if (entry.previousPath === undefined) continue;
    const x = entry.statusXY[0];
    const y = entry.statusXY[1];
    if (x !== "R" && y !== "R") continue; // copies are never rename authority
    proposals.push({
      path: entry.path,
      previousPath: entry.previousPath,
      source: "end-status",
    });
  }
  return proposals;
}

/**
 * Collapse compatible duplicates: the SAME pair proposed by both authorities
 * is one rename, not two.
 *
 * Order is preserved so the surviving proposal reports the first source that
 * offered it, keeping diagnostics deterministic. Incompatible claims are not
 * touched here; those are the conflict check's business.
 */
function dedupeRenameProposals(proposals: readonly RenameProposal[]): RenameProposal[] {
  const seen = new Set<string>();
  const out: RenameProposal[] = [];
  for (const proposal of proposals) {
    const key = JSON.stringify([proposal.previousPath, proposal.path]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proposal);
  }
  return out;
}

/**
 * Keep only proposals describing a clean one-to-one SESSION-relative rename.
 *
 * Git proposes an alias relation across some comparison; only the PathStates
 * can say whether this session performed it. A proposal failing the shape is
 * rejected as a rename and its paths fall through to ordinary derivation. The
 * rejection carries no claim about why: a relation that pre-existed the
 * session, a rename-then-recreate, an intermediate link in a rename chain, and
 * an overwrite all land here.
 */
function acceptRenameProposals(
  proposals: readonly RenameProposal[],
  beforeStates: ReadonlyMap<string, PathState>,
  afterStates: ReadonlyMap<string, PathState>,
): RenameProposal[] {
  const accepted: RenameProposal[] = [];
  for (const proposal of proposals) {
    const beforeSource = beforeStates.get(proposal.previousPath);
    const beforeDest = beforeStates.get(proposal.path);
    const afterSource = afterStates.get(proposal.previousPath);
    const afterDest = afterStates.get(proposal.path);
    if (
      beforeSource === undefined ||
      beforeDest === undefined ||
      afterSource === undefined ||
      afterDest === undefined
    ) {
      // An alias outside the candidate set cannot be proven either way. The
      // store-side destination of `src/a.ts -> .viberevert/a.ts` lands here,
      // which is exactly right: not a rename, and `src/a.ts` still derives
      // ordinarily as a deletion.
      continue;
    }
    if (
      present(beforeSource) &&
      !present(beforeDest) &&
      !present(afterSource) &&
      present(afterDest)
    ) {
      accepted.push(proposal);
    }
  }
  return accepted;
}

/** Competing claims among ACCEPTED, deduplicated pairs only. */
function assertNoRenameConflicts(accepted: readonly RenameProposal[]): void {
  const byPath = new Map<string, RenameProposal>();
  const byPrevious = new Map<string, RenameProposal>();
  for (const proposal of accepted) {
    const priorForPath = byPath.get(proposal.path);
    if (priorForPath !== undefined && priorForPath.previousPath !== proposal.previousPath) {
      throw new ConflictingRenameProposalError(
        `path ${JSON.stringify(proposal.path)} is claimed as renamed from both ${JSON.stringify(priorForPath.previousPath)} (${priorForPath.source}) and ${JSON.stringify(proposal.previousPath)} (${proposal.source})`,
      );
    }
    const priorForPrevious = byPrevious.get(proposal.previousPath);
    if (priorForPrevious !== undefined && priorForPrevious.path !== proposal.path) {
      throw new ConflictingRenameProposalError(
        `path ${JSON.stringify(proposal.previousPath)} is claimed as renamed to both ${JSON.stringify(priorForPrevious.path)} (${priorForPrevious.source}) and ${JSON.stringify(proposal.path)} (${proposal.source})`,
      );
    }
    byPath.set(proposal.path, proposal);
    byPrevious.set(proposal.previousPath, proposal);
  }
}

// ============================================================================
// Mirrors
// ============================================================================

async function writeMirrorFile(mirrorRoot: string, relPath: string, data: Buffer): Promise<void> {
  const abs = join(mirrorRoot, ...relPath.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
}

/**
 * Move the BEFORE-side payload of an accepted rename onto the destination
 * path, so both mirror sides sit at the same path and the delta describes the
 * content change rather than a delete plus an add.
 *
 * ONLY regular -> regular. That is the sole accepted-rename transition
 * eligible for `content_delta`; a symlink rename or a regular-to-symlink
 * rename is still `operation: "renamed"` but has no mirror file to move and
 * no hunks to derive.
 *
 * Deliberately strict: the source was written by this attempt's BEFORE pass
 * moments earlier, so its absence is a broken invariant, not a condition to
 * tolerate.
 */
async function normalizeRenameMirrors(
  entries: readonly DraftEntry[],
  beforeMirrorRoot: string,
): Promise<void> {
  for (const entry of entries) {
    if (entry.operation !== "renamed" || entry.previousPath === undefined) continue;
    if (entry.before.worktree.kind !== "regular" || entry.after.worktree.kind !== "regular") {
      continue;
    }
    const from = join(beforeMirrorRoot, ...entry.previousPath.split("/"));
    const to = join(beforeMirrorRoot, ...entry.path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }
}

// ============================================================================
// Live acquisition
// ============================================================================

interface LiveAcquisition {
  readonly afterHeadSha: string;
  readonly afterStatusText: string;
  readonly afterStatusZRaw: Buffer;
  readonly trackedStatus: readonly StatusEntry[];
  readonly endUntracked: readonly string[];
  readonly committedDelta: readonly NameStatusEntry[];
  readonly endIndex: IndexSnapshot;
  readonly inventory: ReadonlyMap<string, string>;
  readonly candidates: readonly string[];
  /** Candidate paths only. */
  readonly candidateStates: ReadonlyMap<string, PathState>;
  /** Extras that are NOT candidates. Disjoint from candidateStates. */
  readonly extraStates: ReadonlyMap<string, PathState>;
}

/** Where observed bytes go during Pass A. Null during Pass B. */
interface PublishingTargets {
  readonly sink: ContributionObjectSink;
  readonly mirrorRoot: string;
}

interface AcquireInputs {
  readonly repoRoot: string;
  readonly manifest: Manifest;
  readonly beforeHeadSha: string;
  readonly observationExtras: readonly string[];
  readonly untrackedExcludePatterns: readonly string[];
  /** Candidate paths derivable without touching the live tree. */
  readonly staticCandidates: readonly string[];
}

async function acquireLive(
  inputs: AcquireInputs,
  targets: PublishingTargets | null,
): Promise<LiveAcquisition> {
  const { repoRoot, manifest, beforeHeadSha, observationExtras } = inputs;

  // 1. HEAD.
  const afterHeadSha = await getHeadSha(repoRoot);

  // 2. Machine status. Tracked entries only: porcelain v1 collapses untracked
  //    directories to `?? dir/`, so it can never be an untracked source.
  const afterStatusZRaw = await getStatusPorcelainZRaw(repoRoot);
  const trackedStatus = parseStatusPorcelainZ(afterStatusZRaw).filter((e) => e.statusXY !== "??");

  // 3. Audit status. A SEPARATE git invocation from step 2, not an atomic read
  //    with it, which is exactly why both are fence members.
  const afterStatusText = await getStatusPorcelainText(repoRoot);

  // 4. End untracked surface, the only source that enumerates nested files.
  const untrackedBuf = await runGit(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const excludeMatchers = inputs.untrackedExcludePatterns.map((pattern) =>
    picomatch(pattern, PICOMATCH_OPTIONS),
  );
  const endUntracked: string[] = [];
  for (const path of splitNulList(untrackedBuf).filter((p) => p.length > 0)) {
    if (isViberevertStorePath(path)) continue;
    const message = repoRelativePathSafetyError(path, "captureContribution.endUntracked");
    if (message !== null) throw new Error(message);
    if (excludeMatchers.some((match) => match(path))) continue;
    endUntracked.push(path);
  }
  endUntracked.sort();

  // 5. Committed delta. Store paths are tolerated structurally so a rename
  //    INTO the store still yields its non-store source alias.
  const committedDeltaBuf = await runGit(repoRoot, [
    "diff",
    "--name-status",
    "-z",
    "-M",
    beforeHeadSha,
    afterHeadSha,
  ]);
  const committedDelta = parseNameStatus(committedDeltaBuf, {
    validatePath: validatePathAllowingStore,
  });

  // 6. Full index snapshot, one read.
  const endIndex = await readIndexSnapshot(repoRoot);

  // 7. Every cheap candidate source, resolved BEFORE the inventory scan so
  //    that the scan can decide storage while bytes are in hand.
  const candidates = new Set<string>();
  for (const path of inputs.staticCandidates) {
    addCandidate(candidates, path, "captureContribution.staticCandidate");
  }
  for (const entry of trackedStatus) {
    addCandidate(candidates, entry.path, "captureContribution.endStatus");
    if (entry.previousPath !== undefined) {
      addCandidate(candidates, entry.previousPath, "captureContribution.endStatus");
    }
  }
  for (const entry of committedDelta) {
    addCandidate(candidates, entry.path, "captureContribution.committedDelta");
    if (entry.previous_path !== undefined) {
      addCandidate(candidates, entry.previous_path, "captureContribution.committedDelta");
    }
  }
  for (const path of endUntracked) {
    addCandidate(candidates, path, "captureContribution.endUntracked");
  }

  // PathState ONLY. Never the observation: its payload Buffer would make this
  // scale with repository size rather than with the largest single file.
  const cache = new Map<string, PathState>();
  const inventory = new Map<string, string>();

  /**
   * Consume a candidate's payload. Storage takes every payload so the evidence
   * chain resolves; the mirror takes regular files only, because that is all
   * hunks can be derived from. Pass B passes no targets and does neither.
   */
  const consumePayload = async (
    path: string,
    state: PathState,
    object: { readonly digest: string; readonly data: Buffer } | undefined,
  ): Promise<void> => {
    if (targets === null || object === undefined) return;
    await targets.sink({ digest: object.digest, data: object.data });
    if (state.worktree.kind === "regular") {
      await writeMirrorFile(targets.mirrorRoot, path, object.data);
    }
  };

  // 8. Inventory scan. The observe-once anchor, and the raw-byte candidate
  //    source. Candidacy is fully determined here, so the storage decision
  //    happens while the payload exists rather than by retaining it.
  const trackedPaths = [...endIndex.byPath.keys()].sort();
  for (const path of trackedPaths) {
    if (isViberevertStorePath(path)) continue;
    const message = repoRelativePathSafetyError(path, "captureContribution.trackedInventory");
    if (message !== null) throw new Error(message);

    const observation = await observePathState(repoRoot, path, endIndex);
    cache.set(path, observation.state);

    if (observation.state.worktree.kind === "regular") {
      const digest = observation.state.worktree.content_ref;
      inventory.set(path, digest);
      if (manifest.snapshots.file_hashes[path] !== digest) {
        candidates.add(path);
      }
    }

    if (candidates.has(path)) {
      await consumePayload(path, observation.state, observation.worktreeObject);
    }
    // observation.worktreeObject goes out of scope here, by design.
  }

  // 9. The observation set: candidates plus caller extras, kept disjoint so
  //    the fence can name which of the two moved.
  const extraOnly = observationExtras.filter((path) => !candidates.has(path));
  const observationPaths = [...new Set([...candidates, ...extraOnly])].sort();

  // 10. Anything the inventory scan did not already observe: untracked files,
  //     paths absent from the index, extras that are not tracked. Extras that
  //     are not candidates are observed but never stored or mirrored.
  const candidateStates = new Map<string, PathState>();
  const extraStates = new Map<string, PathState>();
  for (const path of observationPaths) {
    let state = cache.get(path);
    if (state === undefined) {
      const observation = await observePathState(repoRoot, path, endIndex);
      state = observation.state;
      cache.set(path, state);
      if (candidates.has(path)) {
        await consumePayload(path, state, observation.worktreeObject);
      }
    }
    if (candidates.has(path)) candidateStates.set(path, state);
    else extraStates.set(path, state);
  }

  return {
    afterHeadSha,
    afterStatusText,
    afterStatusZRaw,
    trackedStatus,
    endUntracked,
    committedDelta,
    endIndex,
    inventory,
    candidates: [...candidates].sort(),
    candidateStates,
    extraStates,
  };
}

// ============================================================================
// The fence
// ============================================================================

/** Every differing member, sorted. Never just the first. */
function compareFence(a: LiveAcquisition, b: LiveAcquisition): string[] {
  const changed: string[] = [];
  if (a.afterHeadSha !== b.afterHeadSha) changed.push("afterHeadSha");
  if (!indexSnapshotEqual(a.endIndex, b.endIndex)) changed.push("endIndex");
  if (!statusEntriesEqual(a.trackedStatus, b.trackedStatus)) changed.push("trackedStatus");
  if (a.afterStatusText !== b.afterStatusText) changed.push("afterStatusText");
  if (!a.afterStatusZRaw.equals(b.afterStatusZRaw)) changed.push("afterStatusZRaw");
  if (!stringArraysEqual(a.endUntracked, b.endUntracked)) changed.push("endUntracked");
  if (!mapsEqual(a.inventory, b.inventory, (x, y) => x === y)) changed.push("inventory");
  if (!stringArraysEqual(a.candidates, b.candidates)) changed.push("candidates");
  if (!mapsEqual(a.candidateStates, b.candidateStates, pathStateEqual)) {
    changed.push("candidatePathStates");
  }
  if (!mapsEqual(a.extraStates, b.extraStates, pathStateEqual)) {
    changed.push("additionalObservationPathStates");
  }
  return changed.sort();
}

// ============================================================================
// Entry derivation
// ============================================================================

interface DraftEntry {
  readonly path: string;
  readonly previousPath?: string;
  readonly operation: ContributionOperation;
  readonly facets: readonly ContributionFacet[];
  readonly before: PathState;
  readonly after: PathState;
}

/** Candidates are in both maps by construction; absence is a broken invariant. */
function requireState(
  states: ReadonlyMap<string, PathState>,
  path: string,
  side: string,
): PathState {
  const state = states.get(path);
  if (state === undefined) {
    throw new Error(
      `deriveDraftEntries: candidate ${JSON.stringify(path)} has no observed ${side} state`,
    );
  }
  return state;
}

function deriveDraftEntries(
  candidates: readonly string[],
  beforeStates: ReadonlyMap<string, PathState>,
  afterStates: ReadonlyMap<string, PathState>,
  accepted: readonly RenameProposal[],
): DraftEntry[] {
  const drafts: DraftEntry[] = [];
  const consumed = new Set<string>();

  // Accepted renames first, so their aliases are consumed before the ordinary
  // pass. NEVER elided: for a rename the path transition IS the change, and a
  // pure rename has structurally identical paired states.
  for (const proposal of accepted) {
    const before = requireState(beforeStates, proposal.previousPath, "BEFORE");
    const after = requireState(afterStates, proposal.path, "AFTER");
    drafts.push({
      path: proposal.path,
      previousPath: proposal.previousPath,
      operation: "renamed",
      facets: deriveFacets(before, after),
      before,
      after,
    });
    consumed.add(proposal.path);
    consumed.add(proposal.previousPath);
  }

  // Ordinary same-path derivation for everything unconsumed.
  for (const path of candidates) {
    if (consumed.has(path)) continue;
    const before = requireState(beforeStates, path, "BEFORE");
    const after = requireState(afterStates, path, "AFTER");
    // Elision, ordinary entries ONLY: identical states mean this path carries
    // no session contribution. Applying this to a rename would erase it.
    if (pathStateEqual(before, after)) continue;
    drafts.push({
      path,
      operation: classifyOperation(before, after, false),
      facets: deriveFacets(before, after),
      before,
      after,
    });
  }

  drafts.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return drafts;
}

function toContributionEntries(
  sessionId: string,
  drafts: readonly DraftEntry[],
  contentByPath: ReadonlyMap<string, PreparedMirrorDiffEntry>,
): SessionContributionEntry[] {
  return drafts.map((draft) => {
    // deriveChangeGroupId normalizes and sorts internally; sorting here is
    // redundant but makes the canonical-set intent visible at the call site.
    const aliases =
      draft.previousPath === undefined ? [draft.path] : [draft.previousPath, draft.path].sort();
    return {
      path: draft.path,
      ...(draft.previousPath === undefined ? {} : { previous_path: draft.previousPath }),
      operation: draft.operation,
      facets: [...draft.facets],
      change_group_id: deriveChangeGroupId(sessionId, aliases),
      before: draft.before,
      after: draft.after,
      content_delta: deriveContentDelta(draft.before, draft.after, contentByPath.get(draft.path)),
    };
  });
}

// ============================================================================
// Public: capture
// ============================================================================

/**
 * Capture the session's contribution and hand the proven-stable facts to
 * `publish`, which runs inside the oracle before any cleanup.
 *
 * See this file's header for the attempt sequencing and the observe-once
 * rule. Throws EndStateChangedDuringCaptureError if the tree never settles,
 * leaving the session ACTIVE.
 */
export async function captureContribution<T>(
  repoRoot: string,
  checkpointDir: string,
  opts: CaptureContributionOptions<T>,
): Promise<ContributionCaptureResult<T>> {
  const observationExtras = normalizeObservationPaths(opts.additionalObservationPaths);

  const { value, cleanupWarnings } = await withCheckpointOracle(repoRoot, checkpointDir, {
    tempDirPrefix: CONTRIBUTION_TEMP_DIR_PREFIX,
    run: async ({ tempRoot, worktreePath, manifest }) => {
      if (manifest.session_id !== opts.sessionId) {
        throw new SessionCheckpointBindingError(opts.sessionId, manifest.session_id);
      }
      const beforeHeadSha = manifest.git.head_sha;

      // Immutable BEFORE facts, read once for the whole capture.
      const beforeIndex = await readIndexSnapshot(worktreePath);
      const oracleStatus = (await getStatusPorcelainZ(worktreePath)).filter(
        (e) => e.statusXY !== "??",
      );

      // Candidate sources that do not depend on the live tree.
      const staticCandidates = new Set<string>();
      for (const entry of oracleStatus) {
        addCandidate(staticCandidates, entry.path, "captureContribution.oracleStatus");
        if (entry.previousPath !== undefined) {
          addCandidate(staticCandidates, entry.previousPath, "captureContribution.oracleStatus");
        }
      }
      for (const path of Object.keys(manifest.untracked.file_hashes)) {
        addCandidate(staticCandidates, path, "captureContribution.capturedUntracked");
      }
      for (const path of manifest.snapshots.tracked_dirty_paths) {
        addCandidate(staticCandidates, path, "captureContribution.capturedTrackedDirty");
      }

      const acquireInputs: AcquireInputs = {
        repoRoot,
        manifest,
        beforeHeadSha,
        observationExtras,
        untrackedExcludePatterns: opts.untrackedExcludePatterns,
        staticCandidates: [...staticCandidates].sort(),
      };

      let lastChanged: readonly string[] = [];
      for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
        const beforeMirror = `before-${attempt}`;
        const afterMirror = `after-${attempt}`;
        const beforeMirrorRoot = join(tempRoot, beforeMirror);
        const afterMirrorRoot = join(tempRoot, afterMirror);
        await mkdir(beforeMirrorRoot, { recursive: true });
        await mkdir(afterMirrorRoot, { recursive: true });

        // ---- Pass A -------------------------------------------------------
        const passA = await acquireLive(acquireInputs, {
          sink: opts.storeObject,
          mirrorRoot: afterMirrorRoot,
        });

        // ---- BEFORE side --------------------------------------------------
        // Candidates AND extras, once per path in this attempt. Only
        // candidates enter derivation or produce payloads; extras are observed
        // so the observation set is symmetric across both sides.
        const candidateSet = new Set(passA.candidates);
        const beforeObservationPaths = [
          ...new Set([...passA.candidates, ...observationExtras]),
        ].sort();
        const beforeStates = new Map<string, PathState>();
        for (const path of beforeObservationPaths) {
          const observation = await observePathState(worktreePath, path, beforeIndex);
          if (!candidateSet.has(path)) continue;
          beforeStates.set(path, observation.state);
          const object = observation.worktreeObject;
          if (object !== undefined) {
            await opts.storeObject({ digest: object.digest, data: object.data });
            if (observation.state.worktree.kind === "regular") {
              await writeMirrorFile(beforeMirrorRoot, path, object.data);
            }
          }
        }

        // ---- Derive -------------------------------------------------------
        const proposals = dedupeRenameProposals(
          collectRenameProposals(passA.committedDelta, passA.trackedStatus),
        );
        const accepted = acceptRenameProposals(proposals, beforeStates, passA.candidateStates);
        assertNoRenameConflicts(accepted);
        const drafts = deriveDraftEntries(
          passA.candidates,
          beforeStates,
          passA.candidateStates,
          accepted,
        );
        await normalizeRenameMirrors(drafts, beforeMirrorRoot);
        const mirrorEntries = await diffPreparedMirrors(tempRoot, beforeMirror, afterMirror, {
          detectRenames: false,
        });
        const contentByPath = new Map(mirrorEntries.map((e) => [e.path, e]));
        const entries = toContributionEntries(opts.sessionId, drafts, contentByPath);

        // ---- Pass B, the last live observation before publication ---------
        const passB = await acquireLive(acquireInputs, null);
        const changed = compareFence(passA, passB);
        if (changed.length > 0) {
          lastChanged = changed;
          continue;
        }

        const endWorktreeStates = new Map<string, WorktreeState>();
        for (const [path, state] of passA.candidateStates) {
          endWorktreeStates.set(path, state.worktree);
        }
        for (const [path, state] of passA.extraStates) {
          endWorktreeStates.set(path, state.worktree);
        }

        const capture: StableContributionCapture = {
          sessionId: opts.sessionId,
          checkpointId: opts.checkpointId,
          capturedAt: manifest.captured_at,
          beforeHeadSha,
          afterHeadSha: passA.afterHeadSha,
          entries,
          endWorktreeStates,
          afterStatusText: passA.afterStatusText,
          afterStatusZRaw: passA.afterStatusZRaw,
        };
        return await opts.publish(capture);
      }

      throw new EndStateChangedDuringCaptureError(MAX_CAPTURE_ATTEMPTS, lastChanged);
    },
  });

  return { value, cleanupWarnings };
}

// ============================================================================
// Public: the deterministic builder
// ============================================================================

/**
 * Assemble and validate the persisted artifact from capture facts.
 *
 * Separate from capture on purpose. Capture never reads a clock and never
 * evaluates a framework signature, so the same capture facts always build the
 * same artifact; the two inputs that cannot be derived from observation
 * arrive here explicitly.
 */
export function buildContributionFile(
  capture: StableContributionCapture,
  opts: BuildContributionOptions,
): SessionContributionFile {
  const candidate = {
    schema_version: CONTRIBUTION_FILE_SCHEMA_VERSION,
    session_id: capture.sessionId,
    checkpoint_id: capture.checkpointId,
    before_head_sha: capture.beforeHeadSha,
    after_head_sha: capture.afterHeadSha,
    captured_at: capture.capturedAt,
    ended_at: opts.endedAt,
    ...(opts.detectedFrameworksAtEnd === undefined
      ? {}
      : { detected_frameworks_at_end: [...opts.detectedFrameworksAtEnd].sort() }),
    entries: capture.entries,
  };

  const parsed = SessionContributionFileSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `buildContributionFile: assembled contribution is invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
