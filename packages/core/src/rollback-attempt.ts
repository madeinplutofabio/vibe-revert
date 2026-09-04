// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// RollbackAttempt publication (M 0.8.0 step 10E).
//
// Publishes the immutable pre-mutation crash-recovery marker at
// `.viberevert/sessions/<sess>/rollbacks/<rb_ULID>/attempt.json`, the artifact
// whose existence means "mutation may have started".
//
// This module allocates the rollback id and publishes the artifact. It performs
// NO git-state validation and NO repository mutation. The final protected-domain
// fence lives in `@viberevert/git`, and the mutation schedule is step 10F's.
// Returning successfully from here is the capability token 10F requires before
// any repository mutation becomes reachable.
//
// =============================================================================
// Two rollback namespaces, deliberately distinct
// =============================================================================
//
//     legacy full rollback   .viberevert/rollbacks/<rb>/
//     selective rollback     .viberevert/sessions/<sess>/rollbacks/<rb>/
//
// Both use `rb_<ULID>`, and they must NOT be unified. Selective rollback is
// session-bound: its artifacts belong to the contribution they restore, and a
// reader assessing a half-applied tree needs them beside that session's
// evidence. The legacy namespace has no session to belong to.
//
// =============================================================================
// Validation precedes path construction
// =============================================================================
//
// `sessionId` becomes a filesystem path component, so it is validated FIRST,
// against `SESSION_DIR_NAME_RE`. Field-level schema parsing is NOT sufficient
// for it: `RollbackAttemptSchema.shape.session_id` is `nonBlankString`, and the
// `sess_<ULID>` shape lives in a top-level `.refine()`. So `".."` satisfies the
// field schema, and validating that way would leave path traversal wide open
// while looking rigorous.
//
// What each caller field gets, stated exactly:
//
//     session_id                  fully validated here, before any path is built
//     contribution_sha256         fully validated here (`z.hash("sha256")`)
//     selection                   fully validated here
//     pre_rollback_checkpoint_id  only non-blank here; its `cp_<ULID>` shape is
//                                 a top-level refinement, so the full parse
//                                 below is what enforces it
//
// The checkpoint id is not a path component, so nothing unsafe follows from
// that gap; a malformed one costs an inert empty rollback directory.
//
// =============================================================================
// Ancestry, not just the final component
// =============================================================================
//
// Checking only `sessions/<sess>` would leave the same stable-symlink hole step
// 10C closed for the worktree. A pre-existing
//
//     sessions/<sess>/rollbacks -> /somewhere/outside
//
// would send the supposedly protected `rb_<ULID>` directory out of the store
// entirely, because `mkdir` follows symlinked ancestors. So every component of
// this fixed control-plane path is required to be a REAL directory, and the
// `rollbacks/` parent is created non-recursively so an EEXIST can be inspected
// rather than traversed.
//
// Core cannot import git's `fs-ancestry.ts`, and does not need to: this path is
// fixed and three components deep, not an arbitrary caller-supplied one.
//
// As in 10C, this rejects STABLE symlink ancestry and takes every deterministic
// protection available. Node offers no pinned `mkdirat`, so the residual
// namespace race is acknowledged rather than papered over.
//
// =============================================================================
// Immutability comes from the exclusive directory creation
// =============================================================================
//
// Neither existing helper provides it:
//
//     writeFileAtomic    atomic VISIBILITY only. `wx` guards the random temp
//                        path; the final rename overwrites an existing
//                        destination on POSIX.
//     renameDirAtomic    disclaims no-replace in its own header. Its lstat
//                        pre-check leaves a TOCTOU that Node cannot portably
//                        close.
//
// So the final `rb_<ULID>` directory is created NON-RECURSIVELY: kernel-enforced
// exclusive creation with no check-then-create TOCTOU at the FINAL COMPONENT,
// identical on POSIX and Windows, and refusing a pre-existing directory
// regardless of why it exists.
//
//     exclusive mkdir   -> only one writer can own this rollback directory
//     writeFileAtomic   -> no reader observes a partial attempt.json
//
// SCOPE, stated honestly: a no-replace guarantee between COOPERATIVE VibeRevert
// writers. Only the process that creates the directory proceeds to publish;
// another gets EEXIST and must stop. It is not protection against an arbitrary
// external process with filesystem access, which could still alter files inside
// the directory afterwards.
//
// =============================================================================
// Failure semantics
// =============================================================================
//
//     crash before the exclusive mkdir
//         no rollback artifact at all
//
//     crash after the rollback directory is created, before publication
//         the rollback directory exists
//         attempt.json does NOT exist
//         temporary publication debris such as `attempt.json.tmp.<hex>` MAY
//             exist, since `writeFileAtomic` creates its temp file before the
//             rename and never cleans up on failure
//         nothing claims mutation may have started
//
//     attempt.json published
//         state = mutation_may_have_started; 10F may now mutate
//
//     a second VibeRevert writer for the same rollback id
//         EEXIST on the final mkdir; it cannot replace the existing attempt
//
// =============================================================================
// `written_at` is sampled HERE, and takes no override
// =============================================================================
//
// It records when this process crossed the "mutation may now begin" boundary,
// which is evidence about publication rather than caller data. An API accepting
// a `writtenAt` would make it structurally possible to thread through the
// session's `started_at`, the emergency checkpoint's timestamp, the plan's, or a
// test-fixed earlier value, and still produce a schema-valid artifact that lies
// about when recovery became necessary.
//
// It is sampled AFTER the directory reservation: reserving the directory is
// preparation for publication, not the event this field describes.
//
// The cost is that these bytes are not fixture-deterministic. No golden fixture
// for this artifact exists, and if step 12 develops a genuine need for one, that
// should be solved deliberately rather than by weakening this field's meaning.

import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  type RollbackAttempt,
  RollbackAttemptSchema,
  type RollbackSelection,
  RollbackSelectionSchema,
  toIsoSecondString,
} from "@viberevert/session-format";

import { writeFileAtomic } from "./atomic.js";
import { sessionDir, sessionsDir, viberevertDir } from "./paths.js";
import { SESSION_DIR_NAME_RE } from "./session.js";

const ROLLBACKS_SUBDIR = "rollbacks";
const ATTEMPT_FILENAME = "attempt.json";
/** The sibling whose presence finalizes an invocation (see the header). */
const RECEIPT_FILENAME = "receipt.json";

/**
 * `<repoRoot>/.viberevert/sessions/<sessionId>/rollbacks`. Pure path-join;
 * existence unchecked.
 *
 * `publishRollbackAttempt` returns `rollbackDir` precisely so a caller never
 * reconstructs this layout, but a SCAN has no prior publication to return one,
 * so the convention has to be nameable. The storage names themselves stay
 * private: consumers ask for a directory or an invocation's artifacts, never
 * for a filename, so core can rename either without touching them.
 */
export function sessionRollbacksDir(repoRoot: string, sessionId: string): string {
  return join(sessionDir(repoRoot, sessionId), ROLLBACKS_SUBDIR);
}

/**
 * Both artifact paths for one invocation directory.
 *
 * Returned together because the pair is what the state machine reads: the
 * marker alone means "mutation may have started and did not finalize", and only
 * the sibling receipt finalizes it. A helper that returned one at a time would
 * invite a consumer to check for the marker and forget the sibling.
 */
/**
 * `<repoRoot>/.viberevert/sessions/<sessionId>/rollbacks/<rollbackId>`. Pure
 * path-join; existence unchecked.
 *
 * Exists so a caller that PREALLOCATES a rollback id can name the invocation it
 * is about to publish, and can inspect exactly that one afterwards if the
 * publication throws. The caller supplies the id and nothing else: the location
 * is still derived here from the repository and session, so preallocation stays
 * a storage-layout affordance rather than a path-authority expansion.
 */
export function rollbackInvocationDir(
  repoRoot: string,
  sessionId: string,
  rollbackId: string,
): string {
  return join(sessionRollbacksDir(repoRoot, sessionId), rollbackId);
}

export function rollbackInvocationPaths(rollbackDir: string): {
  readonly attemptPath: string;
  readonly receiptPath: string;
} {
  return {
    attemptPath: join(rollbackDir, ATTEMPT_FILENAME),
    receiptPath: join(rollbackDir, RECEIPT_FILENAME),
  };
}

export interface PublishRollbackAttemptOpts {
  readonly repoRoot: string;
  /** The session whose contribution is being selectively restored. */
  readonly sessionId: string;
  /**
   * PREALLOCATED by the caller, via `generateRollbackId`.
   *
   * Required rather than generated here, because a publication that throws
   * leaves the caller needing to inspect the exact invocation it attempted. If
   * the id were minted inside, a throw before the return would leave the caller
   * with no name for what it may have created, and "possibly published
   * somewhere" is not a state a recovery tool can act on.
   *
   * The DIRECTORY is still derived here from `repoRoot` and `sessionId`; the
   * caller supplies an identity, never a location.
   */
  readonly rollbackId: string;
  /** Digest of the exact contribution bytes the selection was resolved against. */
  readonly contributionSha256: string;
  /** The recovery handle: the emergency checkpoint created before the fence. */
  readonly preRollbackCheckpointId: string;
  readonly selection: RollbackSelection;
}

export interface PublishedRollbackAttempt {
  /** Echoed back: the caller's preallocated `rb_<ULID>`. */
  readonly rollbackId: string;
  /** Exactly what was persisted. */
  readonly attempt: RollbackAttempt;
  /**
   * Absolute path to the published rollback directory.
   *
   * Returned so step 12 writes its sibling `receipt.json` into the directory
   * this module created, rather than reconstructing the convention.
   */
  readonly rollbackDir: string;
}

/**
 * Require one component of the control-plane path to be a REAL directory.
 *
 * `lstat`, so a symlink reports `isDirectory()` false and is refused rather than
 * traversed. Only ENOENT becomes "missing"; every other error propagates, so an
 * unreadable component is never mistaken for an absent one.
 */
async function requireRealDirectory(absPath: string, label: string): Promise<void> {
  const stat = await lstat(absPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (stat === null) {
    throw new Error(`publishRollbackAttempt: ${label} does not exist: ${absPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`publishRollbackAttempt: ${label} is not a real directory: ${absPath}`);
  }
}

/**
 * Publish the immutable attempt marker, allocating its rollback id.
 *
 * This refuses to FABRICATE a missing session directory; it does not prove the
 * session was properly started. Loading and verifying `session.json` belongs to
 * the orchestration layer, which already holds the proven session and evidence
 * context by the time it reaches this boundary.
 */
export async function publishRollbackAttempt(
  opts: PublishRollbackAttemptOpts,
): Promise<PublishedRollbackAttempt> {
  // The path-driving field first, against the shape that actually constrains it.
  if (!SESSION_DIR_NAME_RE.test(opts.sessionId)) {
    throw new TypeError(
      `publishRollbackAttempt: sessionId must match sess_<ULID>; got ${JSON.stringify(opts.sessionId)}`,
    );
  }
  const contributionSha256 = RollbackAttemptSchema.shape.contribution_sha256.parse(
    opts.contributionSha256,
  );
  const preRollbackCheckpointId = RollbackAttemptSchema.shape.pre_rollback_checkpoint_id.parse(
    opts.preRollbackCheckpointId,
  );
  const selection = RollbackSelectionSchema.parse(opts.selection);
  // The caller's identity, validated against the same shape the marker records.
  const rollbackId = RollbackAttemptSchema.shape.rollback_id.parse(opts.rollbackId);

  // Every component real, not merely the last one.
  const sessionDirAbs = sessionDir(opts.repoRoot, opts.sessionId);
  await requireRealDirectory(viberevertDir(opts.repoRoot), "the .viberevert directory");
  await requireRealDirectory(sessionsDir(opts.repoRoot), "the sessions directory");
  await requireRealDirectory(sessionDirAbs, "the session directory");

  const rollbacksDirAbs = join(sessionDirAbs, ROLLBACKS_SUBDIR);
  const rollbackDir = rollbackInvocationDir(opts.repoRoot, opts.sessionId, rollbackId);

  // Non-recursive so an existing entry is INSPECTED rather than traversed. A
  // symlinked `rollbacks/` would otherwise place the rollback outside the store.
  try {
    await mkdir(rollbacksDirAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    await requireRealDirectory(rollbacksDirAbs, "the session's rollbacks directory");
  }

  // The immutability guarantee. EEXIST means another VibeRevert writer already
  // owns this rollback id, or a stale directory survived a crash. Either way
  // this attempt must not proceed.
  await mkdir(rollbackDir);

  // After the reservation, immediately before publication.
  const writtenAt = toIsoSecondString(new Date());

  const attempt: RollbackAttempt = {
    schema_version: ROLLBACK_ATTEMPT_SCHEMA_VERSION,
    rollback_id: rollbackId,
    session_id: opts.sessionId,
    contribution_sha256: contributionSha256,
    pre_rollback_checkpoint_id: preRollbackCheckpointId,
    selection,
    state: "mutation_may_have_started",
    written_at: writtenAt,
  };
  RollbackAttemptSchema.parse(attempt);

  // Two-space indent and no trailing newline, matching every other JSON
  // artifact this package persists.
  await writeFileAtomic(join(rollbackDir, ATTEMPT_FILENAME), JSON.stringify(attempt, null, 2));

  return { rollbackId, attempt, rollbackDir };
}
