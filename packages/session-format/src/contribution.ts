// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// SessionContributionFile: the durable record of what a session contributed.
//
// M 0.8.0 step 0. This is the artifact that makes a session's contribution
// addressable AFTER the fact. Before 0.8.0, VibeRevert could restore the state
// BEFORE a session (the checkpoint) but had no record of what the session
// actually did: `endSession` persisted only after-status path sets, with no
// content, no digests, and no index state, so the session's after-state was
// gone the moment the user edited again.
//
// Written once by the end-of-session capture transaction, then immutable.
//
// =============================================================================
// Two persisted things, not one
// =============================================================================
//
// A CHANGE answers "what did the session do" -- hunks serve that.
// A PATH STATE answers "what exactly existed, on disk and in the index" --
// hunks cannot serve that at all. Both are recorded per entry: `content_delta`
// for the former, `before` / `after` PathState for the latter.
//
// =============================================================================
// Determinism
// =============================================================================
//
// `session.json` records a `contribution_sha256` over this file's
// deterministic serialized bytes, and every consumer walks that evidence chain
// before any mutation. So every set-like or order-bearing field here is
// canonical: entries sorted by path, hunks in file order, facets sorted and
// unique, frameworks sorted and unique, unmerged stages ascending (enforced in
// ./path-state.js). Anything that could serialize the same logical state two
// ways would break the chain for no reason.
//
// Canonical-set checks route through `isSortedUniqueStringArray` from
// ./atoms.js rather than re-implementing the loop per field: the atoms module
// exists so this semantics has exactly one implementation. The prefixed-ULID
// regexes come from the same place for the same reason.
//
// The same requirement is why `change_group_id` is DERIVED rather than randomly
// generated -- and why the derivation is an exported FUNCTION here rather than
// prose to be reimplemented downstream.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CHECKPOINT_ID_REGEX,
  gitObjectId,
  isSortedUniqueStringArray,
  nonBlankString,
  normalizePathArray,
  SESSION_ID_REGEX,
  safeStoredRelativePath,
  sortedUniqueStringArray,
} from "./atoms.js";
import { PathStateSchema } from "./path-state.js";

/**
 * Independent schema version for the contribution artifact. A FIFTH axis,
 * alongside SCHEMA_VERSION, SESSION_STATE_SCHEMA_VERSION,
 * REPORT_FILE_SCHEMA_VERSION, and RECEIPT_FILE_SCHEMA_VERSION.
 *
 * Independent on purpose: the contribution format will evolve with 1.1.0
 * session subtraction and 1.2.0 lineage, and that evolution must not force a
 * version bump on the manifest, the report, or the receipt. Bumping this
 * requires a documented migration in MIGRATIONS.md and a matching row in
 * docs/session-format.md's version table (enforced by
 * session-format-docs.test.ts).
 */
export const CONTRIBUTION_FILE_SCHEMA_VERSION = "1.0" as const;
export type ContributionFileSchemaVersion = typeof CONTRIBUTION_FILE_SCHEMA_VERSION;

// =============================================================================
// Change-group identity (normative derivation)
// =============================================================================

/**
 * The single NUL separator byte used for domain/field separation in the
 * change-group payload. Built programmatically so no literal U+0000 ever
 * appears in this source file -- a raw 0x00 byte would make git treat the file
 * as binary.
 */
const NUL_SEPARATOR = new Uint8Array([0]);

/**
 * Derive a `change_group_id` (v1). THIS FUNCTION IS THE CONTRACT: the
 * algorithm is not merely documented, it is implemented once here, in the
 * package every producer already depends on, so `@viberevert/git` imports it
 * rather than recreating it.
 *
 * ```text
 * aliases = sorted, unique, canonical repo-relative paths of the whole group
 * payload = UTF-8( "viberevert-change-group-v1"
 *                  + \0 + session_id
 *                  + \0 + JSON.stringify(aliases) )
 * id      = "cg_" + lowercase_hex( SHA-256(payload) )
 * ```
 *
 * where `\0` denotes a single U+0000 byte.
 *
 * **Session-scoped.** The session id is part of the payload, so changing
 * `src/foo.ts` in session A and in session B yields DIFFERENT group ids. A
 * path-only fingerprint would make two unrelated sessions share one atomic
 * group identity, which 1.2.0 cross-session lineage must never inherit.
 * Determinism within a session is preserved exactly.
 *
 * **Unambiguous encoding.** `JSON.stringify` over the alias ARRAY makes element
 * boundaries explicit, so `["a/b", "c"]` cannot collide with `["a/bc"]`. The
 * `viberevert-change-group-v1` prefix is domain separation: this digest can
 * never be confused with an object-store content digest, which is also a bare
 * SHA-256. The `v1` is what a future derivation change increments, alongside
 * the contribution schema version.
 *
 * **Full digest, not truncated.** Halving a selection-controlling identifier
 * saves nothing on disk and spends collision resistance on an operation that
 * mutates the user's working tree.
 *
 * @param sessionId The owning session's `sess_<ULID>`.
 * @param aliases Every path in the group: `path`, plus `previous_path` for a
 *   rename. Canonicalized, deduped, and sorted internally via
 *   `normalizePathArray`, which throws on an un-canonicalizable path.
 * @throws If `aliases` is empty. A change group always owns at least one path;
 *   an empty group is a producer bug, not a representable state.
 */
export function deriveChangeGroupId(sessionId: string, aliases: readonly string[]): string {
  if (aliases.length === 0) {
    throw new Error("deriveChangeGroupId: aliases must contain at least one path");
  }
  const canonical = normalizePathArray(aliases);
  const hash = createHash("sha256");
  hash.update("viberevert-change-group-v1", "utf8");
  hash.update(NUL_SEPARATOR);
  hash.update(sessionId, "utf8");
  hash.update(NUL_SEPARATOR);
  hash.update(JSON.stringify(canonical), "utf8");
  return `cg_${hash.digest("hex")}`;
}

// =============================================================================
// Content delta
// =============================================================================

/**
 * One line of a unified-diff hunk.
 *
 * `context` remains in the enum even though the producer runs `git diff -U0`
 * and therefore emits none today: the type describes the diff format, not one
 * invocation's flags, and a future context-bearing capture must not require a
 * schema bump.
 */
export const DiffLineKindSchema = z.enum(["add", "remove", "context"]);
export type DiffLineKind = z.infer<typeof DiffLineKindSchema>;

/**
 * A single diff line. `text` is the line WITHOUT its leading +/-/space marker
 * and MAY legitimately be empty (a blank line added or removed), so it is a
 * plain `z.string()` and deliberately NOT `nonBlankString`.
 */
export const DiffLineSchema = z.strictObject({
  kind: DiffLineKindSchema,
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

/**
 * A unified-diff hunk.
 *
 * **Field naming:** snake_case, matching every other persisted field in this
 * package. `@viberevert/git`'s in-memory `RawDiffHunk` uses camelCase
 * (`oldStart`), so producers convert at the persistence boundary rather than
 * structurally reusing the type. The persisted convention wins; the in-memory
 * type is not the format.
 *
 * **Header coordinates.** Starts and counts are non-negative, not positive,
 * because a zero start is legal for a ZERO-LENGTH side -- git writes
 * `@@ -0,0 +1,3 @@` for a new file and `@@ -1,3 +0,0 @@` for a deleted one.
 * A zero start with a NON-zero length is not a diff git can produce, so it is
 * rejected. The rule is one-directional: a zero-length range may legitimately
 * carry a positive start, as in `@@ -5,0 +6,2 @@` for an insertion under -U0.
 *
 * **Header-versus-lines consistency.** Without it the schema would accept
 * self-contradictory evidence -- a header claiming 99 old lines above a single
 * added line -- and persist it into a digest-bearing artifact:
 *
 *   old_lines === removes + context
 *   new_lines === adds    + context
 *
 * and a hunk must actually change something (at least one add or remove), since
 * git never emits a context-only hunk. All of this costs the producer nothing:
 * the existing diff parser already carries exactly these header counts and line
 * kinds.
 *
 * Git's `\ No newline at end of file` marker is deliberately NOT modeled. The
 * current parser ignores it, and the exact before/after bytes are already
 * preserved by the `PathState` object refs, so richer patch semantics can be
 * derived from the authoritative bytes rather than by pretending this
 * structure carries information it does not.
 */
export const DiffHunkSchema = z
  .strictObject({
    old_start: z.int().nonnegative(),
    old_lines: z.int().nonnegative(),
    new_start: z.int().nonnegative(),
    new_lines: z.int().nonnegative(),
    lines: z.array(DiffLineSchema),
  })
  .refine((h) => h.old_lines === 0 || h.old_start > 0, {
    message: "old_start must be positive when old_lines is non-zero",
    path: ["old_start"],
  })
  .refine((h) => h.new_lines === 0 || h.new_start > 0, {
    message: "new_start must be positive when new_lines is non-zero",
    path: ["new_start"],
  })
  .refine(
    (h) => {
      let adds = 0;
      let removes = 0;
      let context = 0;
      for (const line of h.lines) {
        if (line.kind === "add") adds++;
        else if (line.kind === "remove") removes++;
        else context++;
      }
      return h.old_lines === removes + context && h.new_lines === adds + context;
    },
    {
      message:
        "hunk header counts must match its lines: old_lines === removes + context, new_lines === adds + context",
      path: ["lines"],
    },
  )
  .refine((h) => h.lines.some((line) => line.kind !== "context"), {
    message: "hunk must contain at least one add or remove line",
    path: ["lines"],
  });
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

/**
 * Canonical hunk sequence: at least one hunk, in strict file order.
 *
 * Ordering is strictly ascending lexicographically by `(old_start, new_start)`.
 * Git already emits hunks in file order, so this pins what the producer
 * naturally does; without it, two orderings of the same delta would serialize
 * differently and hash differently, defeating the digest for no benefit.
 */
const DiffHunkArraySchema = z
  .array(DiffHunkSchema)
  .min(1)
  .refine(
    (hunks) => {
      for (let i = 1; i < hunks.length; i++) {
        const prev = hunks[i - 1];
        const curr = hunks[i];
        if (prev === undefined || curr === undefined) return false;
        if (curr.old_start < prev.old_start) return false;
        if (curr.old_start === prev.old_start && curr.new_start <= prev.new_start) {
          return false;
        }
      }
      return true;
    },
    {
      message: "hunks must be in canonical file order by old_start then new_start",
    },
  );

/**
 * How the path's CONTENT changed, as a discriminated union.
 *
 * Modeled this way instead of `is_binary: boolean` plus optional `hunks`
 * because that pair cannot distinguish a binary content change from a
 * mode-only change that has no hunks. Reconstruction into the in-memory
 * `RawDiffEntry` is then exact and total:
 *
 *   text   -> isBinary: false, hunks: <the hunks>
 *   binary -> isBinary: true,  hunks: []
 *   none   -> isBinary: false, hunks: []
 *
 * `text` requires at least one hunk: a text delta with zero hunks is not a
 * delta, it is `none`, and allowing both spellings would put two encodings of
 * one fact into a digest-bearing artifact.
 */
export const ContentDeltaSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    hunks: DiffHunkArraySchema,
  }),
  z.strictObject({ kind: z.literal("binary") }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type ContentDelta = z.infer<typeof ContentDeltaSchema>;

// =============================================================================
// Operation and facets
// =============================================================================

/**
 * The coarse shape of the change, mirroring the existing `ChangedFileStatus`
 * vocabulary rather than inventing a parallel one.
 *
 * Deliberately NOT a mutually-exclusive list that includes things like
 * `mode_change`: a single change can be content-modified AND chmodded, or
 * renamed AND modified. Encoding those as peers of `modified` would force the
 * producer to pick one truth and would bake an ambiguous model into the
 * substrate 1.1.0 subtraction depends on. Orthogonal facts live in `facets`.
 */
export const ContributionOperationSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "type_changed",
]);
export type ContributionOperation = z.infer<typeof ContributionOperationSchema>;

/**
 * Orthogonal, non-exclusive facts about a change. Every facet is also
 * derivable from `before` / `after` PathState; they are persisted so consumers
 * and selectors can address them without re-deriving, and so a reader can see
 * at a glance that one entry was both a rename and a content change.
 */
export const ContributionFacetSchema = z.enum([
  "content_changed",
  "mode_changed",
  "index_changed",
  "worktree_kind_changed",
]);
export type ContributionFacet = z.infer<typeof ContributionFacetSchema>;

/**
 * Canonical facet set: sorted ASCII-ascending, no duplicates. May be empty
 * (a change whose only fact is captured by `operation` alone).
 *
 * Reuses `isSortedUniqueStringArray` rather than re-implementing the check:
 * enum members are strings, so the shared predicate applies directly.
 */
const FacetSetSchema = z.array(ContributionFacetSchema).refine(isSortedUniqueStringArray, {
  message: "facets must be sorted ascending and contain no duplicates",
});

// =============================================================================
// Entry
// =============================================================================

/**
 * Shape of a `change_group_id`. The VALUE is produced exclusively by
 * `deriveChangeGroupId`; this validator pins only the format, and the
 * file-level refinements below re-derive and verify every group.
 *
 * Exported because other modules must validate the SHAPE of a change-group id
 * without re-deriving it: the rollback attempt marker records a resolved
 * selection as change-group ids, and CLI selection parsing validates
 * user-supplied ids. Re-declaring this regex per consumer is exactly the drift
 * risk that centralizing `gitObjectId` and `sha256ObjectRef` was meant to
 * avoid.
 */
export const ChangeGroupIdSchema = z.string().regex(/^cg_[0-9a-f]{64}$/, {
  message: "must be cg_<64 lowercase hex SHA-256>",
});

/**
 * One path's contribution: what shape of change it was, what facts hold about
 * it, and its complete supported state on both sides.
 *
 * Refinements mirror `ChangedFileSchema`'s locked rename rules so the two
 * artifacts cannot disagree about what a rename looks like.
 */
export const SessionContributionEntrySchema = z
  .strictObject({
    path: safeStoredRelativePath,
    previous_path: safeStoredRelativePath.optional(),
    operation: ContributionOperationSchema,
    facets: FacetSetSchema,
    change_group_id: ChangeGroupIdSchema,
    before: PathStateSchema,
    after: PathStateSchema,
    content_delta: ContentDeltaSchema,
  })
  .refine((e) => e.operation !== "renamed" || typeof e.previous_path === "string", {
    message: "previous_path is required when operation is 'renamed'",
    path: ["previous_path"],
  })
  .refine((e) => e.operation === "renamed" || e.previous_path === undefined, {
    message: "previous_path must be absent when operation is not 'renamed'",
    path: ["previous_path"],
  })
  .refine((e) => e.previous_path === undefined || e.previous_path !== e.path, {
    message: "previous_path must differ from path",
    path: ["previous_path"],
  });
export type SessionContributionEntry = z.infer<typeof SessionContributionEntrySchema>;

// =============================================================================
// File
// =============================================================================

/**
 * Group every entry's complete alias set by `change_group_id`.
 *
 * An entry contributes `path`, plus `previous_path` when it has one. Shared by
 * both group-integrity refinements so the two cannot disagree about what a
 * group's aliases are.
 */
function collectGroupAliases(
  entries: readonly SessionContributionEntry[],
): Map<string, Set<string>> {
  const byGroup = new Map<string, Set<string>>();
  for (const entry of entries) {
    let aliases = byGroup.get(entry.change_group_id);
    if (aliases === undefined) {
      aliases = new Set<string>();
      byGroup.set(entry.change_group_id, aliases);
    }
    aliases.add(entry.path);
    if (entry.previous_path !== undefined) {
      aliases.add(entry.previous_path);
    }
  }
  return byGroup;
}

/**
 * The session contribution artifact, persisted at
 * `.viberevert/sessions/<sess>/contribution.json`.
 *
 * **Timestamp semantics (locked).** The two are NOT interchangeable and neither
 * is "when this file happened to be serialized":
 *
 *   captured_at = the owning checkpoint's `Manifest.captured_at`. It identifies
 *                 when the authoritative BEFORE state was captured, so it must
 *                 NOT change if end-capture retries after
 *                 `EndStateChangedDuringCapture`.
 *   ended_at    = the terminal session end timestamp, matching
 *                 `SessionState.ended_at`.
 *
 * Recording the checkpoint's own value means cross-artifact validation can
 * later assert equality against the manifest rather than trusting a second,
 * independently sampled clock reading.
 *
 * `before_head_sha` / `after_head_sha` use the SAME `gitObjectId` validator as
 * the index oids in PathState, so HEAD identity and object identity cannot
 * drift apart across schema modules. They differ whenever the session
 * committed: a mid-session commit is clean in `git status` and is discovered
 * through the `before_head..after_head` tree diff, which is precisely why both
 * ends are recorded.
 *
 * `detected_frameworks_at_end` is an observation of the coherent END state and
 * therefore belongs here rather than in the session-start evaluation snapshot.
 * Populated only for `auto` framework mode; absent when the project pinned
 * `frameworks` explicitly, since detection is not consulted in that case.
 * Ended-session checks evaluate `detected_at_start` UNION this field, so that
 * a framework introduced mid-session activates its rules while deleting a
 * framework signature cannot deactivate them. It is derived from the
 * end-consistency OBSERVATION set, a superset of the contribution candidates:
 * signature files such as `composer.json` plus `artisan` are observed even when
 * unchanged, and appear as entries only if they actually changed.
 */
export const SessionContributionFileSchema = z
  .strictObject({
    schema_version: z.literal(CONTRIBUTION_FILE_SCHEMA_VERSION),
    session_id: nonBlankString,
    checkpoint_id: nonBlankString,
    before_head_sha: gitObjectId,
    after_head_sha: gitObjectId,
    captured_at: z.iso.datetime({ offset: true, precision: 0 }),
    ended_at: z.iso.datetime({ offset: true, precision: 0 }),
    detected_frameworks_at_end: sortedUniqueStringArray.optional(),
    entries: z.array(SessionContributionEntrySchema),
  })
  .refine((c) => SESSION_ID_REGEX.test(c.session_id), {
    message: "session_id must be a sess_<26-char Crockford ULID>",
    path: ["session_id"],
  })
  .refine((c) => CHECKPOINT_ID_REGEX.test(c.checkpoint_id), {
    message: "checkpoint_id must be a cp_<26-char Crockford ULID>",
    path: ["checkpoint_id"],
  })
  // Canonical entry order: sorted by `path`, ASCII-ascending, no duplicate
  // paths. Digest stability again -- and a duplicate path would mean two
  // entries claiming authority over one path's before/after state. Routed
  // through the shared predicate rather than a local loop.
  .refine((c) => isSortedUniqueStringArray(c.entries.map((e) => e.path)), {
    message: "entries must be sorted by path ascending and contain no duplicate paths",
    path: ["entries"],
  })
  // Group-integrity (1/2): one alias belongs to at most ONE change group.
  // Selective recovery is group-atomic, so a path simultaneously owned by two
  // independently selectable groups would make "select this path" ambiguous
  // about what else it drags in.
  .refine(
    (c) => {
      const seen = new Map<string, string>();
      for (const [groupId, aliases] of collectGroupAliases(c.entries)) {
        for (const alias of aliases) {
          const owner = seen.get(alias);
          if (owner !== undefined && owner !== groupId) return false;
          seen.set(alias, groupId);
        }
      }
      return true;
    },
    {
      message: "each path may belong to at most one change_group_id",
      path: ["entries"],
    },
  )
  // Group-integrity (2/2): every change_group_id must equal the id re-derived
  // from this file's session_id and the group's COMPLETE alias set. This is
  // what makes the id verifiable rather than merely well-formed, and it catches
  // a group whose members disagree about their own membership.
  //
  // Cost: one SHA-256 over a short payload per GROUP at validation time, not
  // per entry. Negligible next to reading the file.
  .refine(
    (c) => {
      for (const [groupId, aliases] of collectGroupAliases(c.entries)) {
        if (deriveChangeGroupId(c.session_id, [...aliases]) !== groupId) return false;
      }
      return true;
    },
    {
      message:
        "change_group_id must equal deriveChangeGroupId(session_id, <complete alias set of the group>)",
      path: ["entries"],
    },
  );
export type SessionContributionFile = z.infer<typeof SessionContributionFileSchema>;
