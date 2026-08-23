// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// PathState: the two-axis description of what exists at a repo-relative path.
//
// M 0.8.0 step 0. Worktree state and index state are INDEPENDENT axes and a
// single `kind` cannot express either of these perfectly ordinary states:
//
//   HEAD has foo.ts, index has foo.ts, worktree does NOT   (unstaged deletion)
//   HEAD has foo.ts, index does NOT, worktree DOES         (staged deletion +
//                                                           an untracked file
//                                                           at the same path)
//
// Collapsing them into one discriminant would either lose the index state or
// claim a worktree file exists when it does not. So PathState carries both.
//
// HEAD is a THIRD contextual axis and deliberately does NOT live here: it is
// per-capture, not per-path, and is recorded once on the contribution header
// as before_head_sha / after_head_sha.
//
// =============================================================================
// Scope of the guarantee (locked for 0.8.0)
// =============================================================================
//
// This models the COMPLETE SUPPORTED index state reconstructable from the
// existing checkpoint evidence: index entry, blob, mode, and the
// staged-versus-worktree distinction. It is NOT the complete Git index.
// Git's special index metadata -- intent-to-add, skip-worktree,
// assume-unchanged -- is not preserved by `createCheckpoint` and cannot be
// invented by scratch reconstruction, so it is explicitly outside the 0.8.0
// guarantee. See plans/milestone_0_8_0_plan.md, "Scope of the index
// guarantee".
//
// Filesystem metadata that VibeRevert's recovery contract does not cover --
// xattrs, ACLs, timestamps, ownership, sparse-index flags -- is deliberately
// absent. Modeling it "for the future" would silently widen the product's
// recovery promise beyond what capture and restore actually deliver.
//
// Nested structure: PathState is never written as a standalone artifact. It is
// embedded in the session contribution and carries no schema_version of its
// own, matching the Evidence / ChangedFile / RollbackFileResult precedent.

import { z } from "zod";
import { gitObjectId, sha256ObjectRef } from "./atoms.js";

// =============================================================================
// Local enums
//
// The Git-object and content-address atoms live in ./atoms.js so that the
// contribution header's before_head_sha / after_head_sha use the SAME
// validator as the index oids below.
// =============================================================================

/**
 * Git index entry modes for a FILE entry. Trees (`040000`) never appear as an
 * index entry for a path in this model.
 *
 *   - 100644  regular file
 *   - 100755  regular file, executable
 *   - 120000  symbolic link
 *   - 160000  gitlink (submodule commit)
 */
export const IndexEntryModeSchema = z.enum(["100644", "100755", "120000", "160000"]);
export type IndexEntryMode = z.infer<typeof IndexEntryModeSchema>;

/**
 * Filesystem kinds VibeRevert observes but does not model as restorable
 * state. Enumerated rather than left as a free string so the unsupported set
 * cannot drift silently as new producers are added.
 */
export const UnsupportedFsKindSchema = z.enum([
  "fifo",
  "socket",
  "block_device",
  "character_device",
  "unknown",
]);
export type UnsupportedFsKind = z.infer<typeof UnsupportedFsKindSchema>;

// =============================================================================
// Worktree axis
// =============================================================================

/**
 * What exists ON DISK at the path, independent of the index.
 *
 * **`regular.executable` is nullable, and null means "not observable here".**
 *
 *   POSIX    -> the actual executable bit as reported by `lstat`.
 *   Windows, and any platform where worktree executability is not
 *            meaningfully observable -> `null`.
 *
 * Persisting a mandatory boolean would put a value in the artifact that looks
 * authoritative while being synthetic, forcing every future consumer to carry
 * an out-of-band rule about which platform wrote it. Encoding the unknown
 * directly means the model states whether the fact is known: 0.8.0
 * verification compares only observations that exist, 1.1.0 subtraction never
 * has to reinterpret a fabricated value, and a platform with richer
 * executable semantics can be added deliberately instead of inheriting an
 * invented `false`.
 *
 * The null is NOT to be back-filled from the index. Deriving one axis from the
 * other would defeat the reason these axes are separate.
 *
 * Consumer semantics (implementation-level, deliberately not another schema
 * field): `null` means UNKNOWN. It is neither `false` nor a wildcard. Two
 * states both recording `null` compare equal as observations, but no code may
 * turn `null` into an assertion about the executable bit.
 *
 * `directory` is recorded so a file-to-directory transition is representable.
 * 0.8.0 fails closed on restoring across such a transition unless every
 * descendant belongs to the same selected change group, because the restore
 * would otherwise have to delete unselected later work. Descendant ownership
 * is decided by the change-group layer, not here.
 */
export const WorktreeStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absent") }),
  z.strictObject({
    kind: z.literal("regular"),
    content_ref: sha256ObjectRef,
    executable: z.boolean().nullable(),
  }),
  z.strictObject({
    kind: z.literal("symlink"),
    /** SHA-256 of the raw link-target bytes, not of any resolved file. */
    target_ref: sha256ObjectRef,
  }),
  z.strictObject({ kind: z.literal("directory") }),
  z.strictObject({
    kind: z.literal("unsupported"),
    fs_kind: UnsupportedFsKindSchema,
  }),
]);
export type WorktreeState = z.infer<typeof WorktreeStateSchema>;

// =============================================================================
// Index axis
// =============================================================================

/**
 * A single unmerged index stage. Stage 1 is the merge base, 2 is "ours", 3 is
 * "theirs". Recorded for fidelity; 0.8.0 REFUSES selective restore of any path
 * carrying unmerged stages rather than guessing which stage to reproduce.
 */
export const UnmergedStageSchema = z.strictObject({
  stage: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  mode: IndexEntryModeSchema,
  oid: gitObjectId,
});
export type UnmergedStage = z.infer<typeof UnmergedStageSchema>;

/**
 * Canonical form for a path's unmerged stages: 1 to 3 entries, strictly
 * ascending by stage, therefore duplicate-free.
 *
 * **Why canonical ordering is enforced rather than merely conventional.** The
 * session contribution's `contribution_sha256` is computed over deterministic
 * serialized bytes, so two logically identical conflict states MUST have one
 * representation. A bare `.min(1)` would let `[stage 2, stage 1]` and
 * `[stage 1, stage 2]` describe the same index while hashing differently,
 * which would break the evidence chain for no reason. This is the same
 * principle `sortedUniqueStringArray` and `sortedUniquePathArray` already
 * apply to persisted set-like arrays in this package.
 *
 * This does not fight the producer: `git ls-files --stage` emits conflict
 * stages in ascending stage order, so the invariant is what git already hands
 * us. Enforcing it here makes the requirement explicit instead of incidental.
 */
const UnmergedEntriesSchema = z
  .array(UnmergedStageSchema)
  .min(1)
  .max(3)
  .refine(
    (entries) => {
      for (let i = 1; i < entries.length; i++) {
        const prev = entries[i - 1];
        const curr = entries[i];
        if (prev === undefined || curr === undefined || curr.stage <= prev.stage) {
          return false;
        }
      }
      return true;
    },
    {
      message: "entries must be sorted by stage ascending and contain no duplicate stages",
    },
  );

/**
 * What the INDEX holds for the path, independent of the worktree.
 *
 * `absent` means the path has no index entry at all: it is untracked, or was
 * staged for deletion. Which of those it is follows from the worktree axis and
 * the capture's HEAD, not from this field alone.
 */
export const IndexStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absent") }),
  z.strictObject({
    kind: z.literal("entry"),
    mode: IndexEntryModeSchema,
    oid: gitObjectId,
  }),
  z.strictObject({
    kind: z.literal("unmerged"),
    entries: UnmergedEntriesSchema,
  }),
]);
export type IndexState = z.infer<typeof IndexStateSchema>;

// =============================================================================
// PathState
// =============================================================================

/**
 * The complete supported state of one repo-relative path at one point in time.
 *
 * Both axes are REQUIRED. An observer that cannot determine one of them has
 * not finished observing, and must not persist a half-state: the end-capture
 * transaction fences on exactly this before the contribution is published.
 */
export const PathStateSchema = z.strictObject({
  worktree: WorktreeStateSchema,
  index: IndexStateSchema,
});
export type PathState = z.infer<typeof PathStateSchema>;
