// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Session-state lifecycle for VibeRevert.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
// 1. **D16: core never spawns child_process, never invokes git.** The CLI
//    fetches the raw `git status --porcelain=v1` text via @viberevert/git's
//    helpers (`getStatusPorcelainText`) and passes the strings into
//    `startSession({ beforeStatusText })` / `endSession({ afterStatusText })`
//    as plain inputs. Core writes them to disk verbatim — it does not
//    interpret them, does not invoke git, and does not import
//    @viberevert/git. Verifiable by grep: no `child_process` import in this
//    file, no `@viberevert/git` import in this file.
//
//    **M D Step 4a extension:** `endSession` also accepts
//    `afterStatusZRaw: Buffer` — the raw `git status --porcelain=v1 -z`
//    output captured by the CLI via @viberevert/git's
//    `getStatusPorcelainZRaw`. Core persists it verbatim to
//    `after-status.z` alongside the existing `after-status.txt`. Per D8,
//    `after-status.txt` is the human-audit form (raw v1 text, never
//    parsed for machine logic); `after-status.z` is the machine surface
//    that M D's rollback dirty-tree comparison parses via the shared
//    `parseStatusPorcelainZ` parser. Core does NOT parse either form;
//    it only writes the bytes.
//
//    **M 0.8.0 extension:** `endSession` also accepts
//    `contributionBytes: Buffer` — the serialized `contribution.json`
//    assembled by @viberevert/git's session-contribution capture. Core
//    validates those bytes and persists them; it does not derive the
//    contribution, does not observe the repository, and still does not
//    import @viberevert/git. Unlike the two status forms, core DOES parse
//    this payload — but for verification only, never to re-encode it
//    (see lock #8).
//
// 2. **Deterministic timestamps: core never calls `new Date()` internally.**
//    Both `startSession` and `endSession` accept the timestamp as a typed
//    input (`startedAt`, `endedAt`). The CLI generates the ISO string;
//    core writes it. This keeps core a pure structured-data layer (tests
//    pass fixed strings and assert byte-equal output without mocking
//    global `Date`) and matches the "core takes plain typed inputs from
//    the orchestration layer" boundary.
//
// 3. **D13: structured warnings, no terminal writes.** `listSessions`
//    returns `{ sessions, warnings }` where `warnings` is a structured
//    array. Core MUST NOT call `process.stderr.write` / `console.warn` /
//    `console.error`. The CLI iterates `warnings` and prints them.
//    Verifiable by grep: no `console.` or `process.stderr` in this file.
//
// 4. **D17b/D17c: caller pre-creates the tmp dir + git checkpoint.**
//    `startSession` assumes `tmpSessionDir` already exists with a
//    populated `checkpoint/` subdir (the CLI calls `git.createCheckpoint`
//    with `checkpointDir = ${tmpSessionDir}/checkpoint` BEFORE calling
//    `startSession`). Core writes the session-state files INTO the tmp
//    dir, then atomically renames the tmp dir to its final id-based name.
//    Core does not own the inner checkpoint write.
//
// 5. **D22 lock dependency: caller serializes concurrent invocations.**
//    `startSession` checks for `active-session.json` pre-existence and
//    refuses if present (`SessionAlreadyActiveError`), but the check and
//    the subsequent write are not atomic with each other. The CLI
//    orchestration layer wraps the entire `start` flow in the
//    `.viberevert/.locks/start.lock/` mkdir-based exclusive lock per D22,
//    and as of M 0.8.0 wraps the entire `end` transaction in that same
//    lock. Core does not lock internally — it trusts caller
//    serialization, on both sides.
//
// 6. **D23: missing-state read contract.** `listSessions` returns
//    `{ sessions: [], warnings: [] }` when `.viberevert/sessions/` is
//    absent. `loadActiveSessionLock` returns `null` when the lock file is
//    absent. `loadSession` (singular) throws `SessionNotFoundError` when
//    the dir or `session.json` is missing — singular load asserts existence
//    per D23. `loadSession` ALSO throws when the requested `sessionId`
//    starts with `.tmp-` (D13: temp dirs are construction/crash markers,
//    never valid sessions, even when explicitly requested).
//
// 7. **session_id verification on every load.** `loadSession` verifies
//    that the parsed `session.json`'s `session_id` field equals the
//    requested `sessionId` argument; mismatches throw. This catches
//    corruption, manual edits, bad recovery operations, and concurrent
//    write races where the file path and its internal id have drifted
//    apart. Without this check, `endSession` (which loads by lock's
//    `session_id` and writes the result back) could silently endorse the
//    inconsistency.
//
// 8. **M 0.8.0: persisted digests bind EXACT bytes, never a
//    re-serialization.** `endSession` receives the contribution as a
//    `Buffer` the caller already serialized. Core parses those bytes to
//    validate them — schema shape, plus the session / checkpoint /
//    ended_at cross-binding — computes `contribution_sha256` over the
//    incoming buffer, and then writes that same buffer verbatim. It never
//    re-encodes the parsed object. Re-encoding would be a silent
//    corruption vector rather than a cosmetic difference: any formatting
//    disagreement between the caller's serializer and core's would make
//    the recorded digest describe bytes that are not the bytes on disk,
//    and every downstream evidence-chain verification would then fail on
//    a perfectly healthy repository.

import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActiveSessionLock,
  ActiveSessionLockSchema,
  type EvaluationSnapshot,
  SESSION_STATE_SCHEMA_VERSION,
  SessionContributionFileSchema,
  type SessionState,
  SessionStateSchema,
} from "@viberevert/session-format";
import { renameDirAtomic, writeFileAtomic } from "./atomic.js";

// =============================================================================
// Constants
// =============================================================================

const VIBEREVERT_DIR = ".viberevert";
const SESSIONS_SUBDIR = "sessions";
const SESSIONS_DIR_REL = `${VIBEREVERT_DIR}/${SESSIONS_SUBDIR}`;
const ACTIVE_SESSION_LOCK_FILENAME = "active-session.json";
const SESSION_JSON_FILENAME = "session.json";
const BEFORE_STATUS_FILENAME = "before-status.txt";
const AFTER_STATUS_FILENAME = "after-status.txt";
// M D Step 4a: machine-readable z-format snapshot persisted alongside the
// existing `after-status.txt` audit file. M D's rollback dirty-tree
// comparison parses these bytes via @viberevert/git's `parseStatusPorcelainZ`
// (per D8: audit text is NEVER parsed for machine logic; z-format is the
// machine surface).
const AFTER_STATUS_Z_FILENAME = "after-status.z";
// M 0.8.0: the durable session contribution. Core owns this filename, and
// therefore owns `session.contribution_path` — the caller supplies bytes, never
// a destination. A caller-chosen path would let the recorded path and the
// recorded digest describe two different files.
const CONTRIBUTION_FILENAME = "contribution.json";
const COMMANDS_LOG_FILENAME = "commands.log";

/** Matches `sess_<26-char Crockford base32 ULID>`. */
const SESSION_DIR_NAME_RE = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;

// =============================================================================
// Public types
// =============================================================================

/**
 * Input to `startSession`. The CLI orchestration layer fetches values from
 * git/config/clock and hands them to core as plain typed strings.
 */
export interface StartSessionOpts {
  readonly repoRoot: string;
  /**
   * Absolute path to a pre-existing tmp dir that already contains a
   * populated `checkpoint/` subdir (written by `git.createCheckpoint`
   * BEFORE this call, per D17b). Core writes session-state files into
   * this dir and then atomically renames it to the final id-based name.
   */
  readonly tmpSessionDir: string;
  /** Pre-generated session id from `generateSessionId()` (D5: `sess_<ULID>`). */
  readonly sessionId: string;
  /** The owning checkpoint's id from `git.createCheckpoint` (D11). */
  readonly checkpointId: string;
  /**
   * ISO 8601 datetime with offset and second precision (matches
   * SessionStateSchema's `started_at` validator). Caller-supplied —
   * core never calls `new Date()` internally.
   */
  readonly startedAt: string;
  /** Optional human task description from `--task "..."`. */
  readonly task?: string;
  /** Raw `git status --porcelain=v1` text (per D8 — fetched by CLI from git). */
  readonly beforeStatusText: string;
  /** Optional agent command (reserved for M G2 wrapper mode). */
  readonly agentCommand?: string;
  /**
   * M 0.8.0: the resolved evaluation rules in force at `viberevert start`,
   * already computed by the caller.
   *
   * Required, not optional. `.viberevert.yml` is a file the agent can rewrite
   * during its own session, so session-bound checks and selective rollback
   * read this snapshot rather than live config. A new session written without
   * one would silently lose `--risk`, `--finding`, and the session-start
   * verification commands at recovery time, which is the exact inversion the
   * snapshot exists to prevent. `SessionState.evaluation_snapshot` remains
   * optional on the READ side, because sessions written before 0.8.0
   * genuinely have none and cannot be back-filled.
   *
   * Core persists this verbatim. It does NOT read config, apply defaults, or
   * run framework detection: resolution belongs to the caller, which owns the
   * single validated config snapshot the session is started under.
   */
  readonly evaluationSnapshot: EvaluationSnapshot;
}

/**
 * Input to `endSession`.
 */
export interface EndSessionOpts {
  readonly repoRoot: string;
  /**
   * ISO 8601 datetime with offset and second precision. Caller-supplied —
   * symmetric with `StartSessionOpts.startedAt`; core never calls
   * `new Date()` internally.
   */
  readonly endedAt: string;
  /** Raw `git status --porcelain=v1` text (per D8 — fetched by CLI from git). */
  readonly afterStatusText: string;
  /**
   * Raw `git status --porcelain=v1 -z` BYTES (per M D Step 4a — fetched by
   * CLI from git via `getStatusPorcelainZRaw`). Core persists these bytes
   * verbatim to `after-status.z` alongside the existing
   * `after-status.txt` and records the relative path in
   * `session.after_status_z_path`.
   *
   * Per D8: `after-status.txt` is the human-audit form (raw v1 text, never
   * parsed for machine logic). `after-status.z` is the machine surface
   * that M D's rollback dirty-tree comparison parses via the shared
   * `parseStatusPorcelainZ` parser. Both are captured by the CLI at
   * end-of-session time and recorded in different formats. Core does not
   * assume they came from the same git invocation; it persists the exact
   * text and bytes supplied by the caller.
   */
  readonly afterStatusZRaw: Buffer;
  /**
   * M 0.8.0: the serialized `contribution.json` for this session — the
   * EXACT bytes to persist, assembled by @viberevert/git's capture and
   * already serialized by the caller.
   *
   * Required, not optional. Per the 0.8.0 contract there is no
   * `--no-contribution` escape hatch: a session that ends without a
   * durable record of what it contributed is precisely the gap 0.8.0
   * exists to close, so "end succeeded but produced no contribution" is
   * not a reachable state. Pre-0.8.0 sessions that ended before this
   * field existed remain readable — `SessionState.contribution_path` is
   * optional on the READ side for exactly that reason — but nothing
   * written by this function can omit it.
   *
   * Core parses these bytes to validate them (schema shape, and the
   * session / checkpoint / ended_at cross-binding), then writes THIS
   * buffer verbatim and records its SHA-256. Per architectural lock #8 the
   * parsed object never round-trips back to disk.
   */
  readonly contributionBytes: Buffer;
}

/**
 * Summary of one session as returned by `listSessions`. Field names match
 * D20's `--json` output contract verbatim (snake_case) so the CLI's JSON
 * printer is trivial.
 *
 * `task` and `ended_at` are `null` (not omitted) when absent, per D20's
 * "null for missing fields" rule.
 *
 * `path` is repo-relative POSIX (e.g., `.viberevert/sessions/sess_01JV...`).
 *
 * `status` is derived from `ended_at`:
 *   - `"ended"` if `ended_at` is set,
 *   - `"active"` if not (and the session passed orphan-filtering — orphans
 *     are omitted from the returned `sessions` array per D13).
 * Per D13, core does NOT compute a separate `is_active` marker — that
 * presentation concern (e.g., asterisking the active row) is the CLI's,
 * which calls `loadActiveSessionLock` separately.
 */
export interface SessionSummary {
  readonly id: string;
  readonly checkpoint_id: string;
  readonly status: "active" | "ended";
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly task: string | null;
  readonly path: string;
}

/**
 * Per-record warning emitted by `listSessions` for sessions that exist on
 * disk but cannot be returned as valid summaries. Two kinds (locked):
 *   - `crash_interrupted`: a session dir without `ended_at` AND not
 *     referenced by `active-session.json`. Likely a crash between the
 *     outer session-dir rename and the active-lock write per D13. The
 *     dir is preserved on disk for inspection / future `gc` recovery —
 *     never auto-cleaned, never auto-recovered in M B.
 *   - `schema_invalid`: a session dir whose `session.json` failed
 *     validation (parse error, schema mismatch, or session_id-vs-dirname
 *     mismatch). Caller can inspect `reason` for the specific failure.
 *
 * `path` is repo-relative POSIX (matches `SessionSummary.path`'s
 * convention), so the warnings array is byte-stable across platforms
 * and safe for snapshot tests.
 */
export type ListSessionsWarning =
  | { kind: "crash_interrupted"; sessionId: string; path: string }
  | { kind: "schema_invalid"; sessionId: string; path: string; reason: string };

/**
 * Return shape for `listSessions`. Always returned (never thrown), even on
 * missing `.viberevert/sessions/` (returns empty arrays).
 *
 * `sessions` is reverse-chronological (newest first), with orphans
 * omitted. `warnings` carries the per-record diagnostics, in the same
 * order the records were iterated (which is sorted by id, so
 * deterministic across platforms). The CLI iterates `warnings` and
 * prints them to stderr in BOTH human and `--json` mode (D20: stderr is
 * the warnings channel; doesn't break stdout JSON).
 */
export interface ListSessionsResult {
  readonly sessions: readonly SessionSummary[];
  readonly warnings: readonly ListSessionsWarning[];
}

// =============================================================================
// Error classes
// =============================================================================

/**
 * Thrown by `loadSession(sessionId, repoRoot)` when:
 *   - the dir does not exist,
 *   - the dir's `session.json` is missing,
 *   - `sessionId` starts with `.tmp-` (D13/D23 — temp dirs are
 *     construction/crash markers, never valid sessions, even when
 *     explicitly requested by id).
 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, reason: string, cause?: unknown) {
    super(`Session not found: ${sessionId}: ${reason}`, { cause });
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

/**
 * Thrown by `startSession` when `active-session.json` already exists at
 * the start of the call. Carries the parsed existing lock so the CLI can
 * print the current session's id / start time / task in its refusal
 * message (per D11's locked refusal-message format) without re-reading
 * the lock file.
 */
export class SessionAlreadyActiveError extends Error {
  readonly active: ActiveSessionLock;

  constructor(active: ActiveSessionLock, cause?: unknown) {
    super(`Session already active: ${active.session_id}`, { cause });
    this.name = "SessionAlreadyActiveError";
    this.active = active;
  }
}

/**
 * Thrown by `endSession` when `active-session.json` does not exist at the
 * start of the call. The CLI's `viberevert end` surfaces this as a
 * user-visible refusal per D11.
 */
export class NoActiveSessionError extends Error {
  constructor(cause?: unknown) {
    super("No active session", { cause });
    this.name = "NoActiveSessionError";
  }
}

/**
 * M 0.8.0: thrown by `endSession` when the supplied contribution is
 * structurally valid but describes a DIFFERENT session, checkpoint, or end
 * timestamp than the one being ended.
 *
 * This is not a user-facing refusal condition. Capture and persistence run
 * back to back inside a single locked transaction, so a mismatch means the
 * two halves disagreed about what they were operating on — a defect or an
 * out-of-band mutation of the session dir, not something the user chose.
 * The CLI therefore does not map it to friendly copy; it surfaces as an
 * unexpected error, which is the honest presentation.
 *
 * Schema-shape failures are NOT routed here: an invalid `contribution.json`
 * raises the underlying Zod error (or a wrapped JSON parse error) directly,
 * matching how `loadSession` reports a corrupt `session.json`. Both classes
 * of failure occur strictly before any mutation.
 */
export class ContributionBindingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ContributionBindingError";
  }
}

// =============================================================================
// Public functions
// =============================================================================

/**
 * Begin a session.
 *
 * Pre-conditions (caller's responsibility — NOT checked by core):
 *   - `tmpSessionDir` exists and contains a populated `checkpoint/`
 *     subdir written by `git.createCheckpoint` (per D17b).
 *   - The D22 start-lock is held (per architectural lock #5 above).
 *
 * What this function does, in order:
 *   1. Read `active-session.json` via `loadActiveSessionLock`. If
 *      non-null, throw `SessionAlreadyActiveError` carrying the
 *      existing lock — no work done.
 *   2. Build the `SessionState` object, validate against
 *      `SessionStateSchema`.
 *   3. Write `session.json`, `before-status.txt`, and `commands.log`
 *      (empty) into `tmpSessionDir` via `writeFileAtomic`.
 *   4. Best-effort POSIX `chmod 0600` on `commands.log` (skipped on
 *      Windows entirely — POSIX permission bits are not portable; NTFS
 *      ACLs are out of M B scope; the file is empty in M B anyway and
 *      gains content only in M G2's `viberevert run`).
 *   5. Ensure `.viberevert/sessions/` exists, then atomically rename
 *      `tmpSessionDir` → `.viberevert/sessions/<sessionId>/` via
 *      `renameDirAtomic`.
 *   6. Build the `ActiveSessionLock` object, validate against
 *      `ActiveSessionLockSchema`, write to `active-session.json` via
 *      `writeFileAtomic`.
 */
export async function startSession(opts: StartSessionOpts): Promise<void> {
  const existing = await loadActiveSessionLock(opts.repoRoot);
  if (existing !== null) {
    throw new SessionAlreadyActiveError(existing);
  }

  const sessionsDirAbs = join(opts.repoRoot, VIBEREVERT_DIR, SESSIONS_SUBDIR);
  const finalSessionDirAbs = join(sessionsDirAbs, opts.sessionId);
  const activeLockPathAbs = join(opts.repoRoot, VIBEREVERT_DIR, ACTIVE_SESSION_LOCK_FILENAME);

  const sessionDirRel = `${SESSIONS_DIR_REL}/${opts.sessionId}`;
  const beforeStatusPathRel = `${sessionDirRel}/${BEFORE_STATUS_FILENAME}`;
  const commandsLogPathRel = `${sessionDirRel}/${COMMANDS_LOG_FILENAME}`;

  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: opts.sessionId,
    checkpoint_id: opts.checkpointId,
    started_at: opts.startedAt,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    ...(opts.agentCommand !== undefined ? { agent_command: opts.agentCommand } : {}),
    before_status_path: beforeStatusPathRel,
    commands_log_path: commandsLogPathRel,
    evaluation_snapshot: opts.evaluationSnapshot,
  };
  // Validate before writing — surfaces drift between this builder and
  // the schema as a loud failure, not a silent corruption on disk.
  SessionStateSchema.parse(sessionState);

  const sessionJsonAbs = join(opts.tmpSessionDir, SESSION_JSON_FILENAME);
  const beforeStatusAbs = join(opts.tmpSessionDir, BEFORE_STATUS_FILENAME);
  const commandsLogAbs = join(opts.tmpSessionDir, COMMANDS_LOG_FILENAME);

  await writeFileAtomic(sessionJsonAbs, JSON.stringify(sessionState, null, 2));
  await writeFileAtomic(beforeStatusAbs, opts.beforeStatusText);
  await writeFileAtomic(commandsLogAbs, "");

  if (process.platform !== "win32") {
    try {
      await chmod(commandsLogAbs, 0o600);
    } catch {
      // Best-effort — POSIX chmod failures don't block session start.
    }
  }

  await mkdir(sessionsDirAbs, { recursive: true });
  await renameDirAtomic(opts.tmpSessionDir, finalSessionDirAbs);

  const lock: ActiveSessionLock = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: opts.sessionId,
    checkpoint_id: opts.checkpointId,
    started_at: opts.startedAt,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
  };
  ActiveSessionLockSchema.parse(lock);
  await writeFileAtomic(activeLockPathAbs, JSON.stringify(lock, null, 2));
}

/**
 * End the currently-active session.
 *
 * Pre-conditions:
 *   - The D22 start-lock is held around the WHOLE end transaction (per
 *     architectural lock #5). As of M 0.8.0 the orchestration layer's
 *     `endSessionOperation` owns that lock, so a competing `end` is
 *     refused at acquisition before it performs any capture work. Core
 *     still does not lock internally. Its `active-session.json` read below
 *     identifies and validates the session being ended; it is NOT a
 *     concurrency primitive or a fallback for a missing lifecycle lock.
 *     Concurrent calls to `endSession` without the required D22 lock are
 *     outside the supported contract and may interleave publication.
 *
 * What this function does, in order:
 *   1. Read `active-session.json` via `loadActiveSessionLock`. If null,
 *      throw `NoActiveSessionError` — no work done.
 *   2. Read existing `session.json` via `loadSession` (which validates
 *      schema AND verifies `session_id` matches the lock's session id —
 *      see architectural lock #7).
 *   3. M 0.8.0: parse `opts.contributionBytes` as JSON and validate the
 *      result against `SessionContributionFileSchema`. That schema is
 *      self-verifying: beyond shape, it re-derives every
 *      `change_group_id` from the contribution's own `session_id` and
 *      each group's complete alias set, so a contribution whose groups
 *      disagree with their members is rejected here rather than
 *      persisted. It also validates the contribution's own `ended_at` as
 *      an ISO datetime.
 *   4. M 0.8.0: cross-bind the contribution to THIS end —
 *      `session_id` must equal the active lock's, `checkpoint_id` must
 *      equal the loaded session's, and `ended_at` must equal
 *      `opts.endedAt`. Mismatches throw `ContributionBindingError`. This
 *      is what stops a contribution captured for one session from being
 *      filed under another, and what keeps `session.json` and
 *      `contribution.json` from recording two different end timestamps
 *      for the same event. Steps 3 and 4 together also mean a malformed
 *      `opts.endedAt` cannot survive: it either fails the contribution's
 *      timestamp validation or fails this equality check.
 *   5. M 0.8.0: compute `contribution_sha256` over
 *      `opts.contributionBytes` — the exact buffer written in step 8,
 *      never a re-serialization of the parsed object (lock #8).
 *   6. Build the post-mutation `SessionState` (existing + `ended_at` +
 *      `after_status_path` + M D Step 4a `after_status_z_path` + M 0.8.0
 *      `contribution_path` and `contribution_sha256`) and validate it
 *      against `SessionStateSchema`. This is where the schema's coupling
 *      refines are enforced: the M D one-way coupling
 *      (`after_status_z_path` present implies `ended_at` AND
 *      `after_status_path` present), the M 0.8.0 both-or-neither pairing
 *      of `contribution_path` with `contribution_sha256`, and the M 0.8.0
 *      rule that a contribution is valid only on an ended session. Drift
 *      between this builder and the schema surfaces as a loud failure.
 *
 *      This parse also re-checks `ended_at`, but no longer OWNS that
 *      check. Before M 0.8.0 it was the only validator a malformed
 *      `opts.endedAt` had to pass; now steps 3 and 4 reject one first.
 *      The parse stays as defense in depth, so the guarantee survives a
 *      future refactor that relaxes either of them.
 *   7. Steps 1-6 are all read/validate/derive; the on-disk state is
 *      byte-untouched up to this point. If any of them throws — including
 *      every contribution failure — no mutation occurred.
 *   8. Write, in order: `contribution.json` (M 0.8.0, the caller's exact
 *      bytes), `after-status.txt` (audit, v1 text), `after-status.z`
 *      (machine, raw z-format BYTES — M D Step 4a), then the updated
 *      `session.json`, all via `writeFileAtomic`.
 *   9. Delete `active-session.json` via `rm`.
 *
 * **Why the contribution is published FIRST.** `session.json` is the index
 * into everything else a session owns, so it must never name an artifact
 * that is not already on disk. Writing `contribution.json` before the
 * `session.json` that references it means the only reachable inconsistency
 * is a contribution with no reference — inert and self-correcting (see
 * below) — rather than a reference with no contribution, which every
 * evidence-chain check would have to treat as corruption.
 *
 * **Known crash window (M B-tolerated):** a crash between step 8's final
 * `session.json` write and step 9 leaves `session.json` showing the session
 * as ended (with `ended_at`, `after_status_path`, `after_status_z_path`,
 * AND the M 0.8.0 contribution fields set) while `active-session.json`
 * still points at it. The session is logically ended on disk but the
 * active-lock is stale — subsequent `viberevert start` would refuse with
 * the stale lock as the "currently active" session. M B does not
 * auto-recover this; a future `viberevert gc` (deferred) sweeps stale locks
 * by checking whether the referenced session has `ended_at`. Manual
 * recovery: delete `.viberevert/active-session.json` and retry `start`.
 *
 * **Narrower windows inside step 8.** Each `writeFileAtomic` is
 * individually atomic but the sequence is not, so a crash can leave any
 * prefix of the four files written:
 *   - `contribution.json` present without the `session.json` that names
 *     it. Nothing reads an unreferenced contribution: every consumer
 *     starts from `session.contribution_path`. The session remains ACTIVE,
 *     so re-running `end` recaptures and overwrites the file. Benign.
 *   - One after-status form present without its sibling. Per D13 this is
 *     M B-tolerated: M D's `loadEndOfSessionChangedPaths` returns
 *     `{ kind: "missing" }` when `after_status_z_path` is unset OR the
 *     file is absent, routing through the same legacy-session escape
 *     hatch as pre-M D ended sessions (the D61b refusal + `--force`
 *     path).
 *
 * **This is not a durability claim.** `writeFileAtomic` publishes by
 * rename without fsync, so "atomically persisted" here means no reader
 * ever observes a partially-written file — not that the bytes survive a
 * power loss. 0.8.0 deliberately does not change the project's durability
 * model, and no contribution guarantee should be read as extending it.
 */
export async function endSession(opts: EndSessionOpts): Promise<void> {
  const lock = await loadActiveSessionLock(opts.repoRoot);
  if (lock === null) {
    throw new NoActiveSessionError();
  }

  // Load + validate BEFORE any mutation — if loadSession throws (corrupt
  // session.json, schema violation, session_id-vs-lock mismatch per
  // architectural lock #7), the on-disk state is byte-untouched.
  const existingState = await loadSession(lock.session_id, opts.repoRoot);

  // M 0.8.0: validate the contribution the caller assembled. Parsing here is
  // for VERIFICATION ONLY — `contribution` is read for the three cross-binding
  // checks below and then never written. The bytes that land on disk are
  // `opts.contributionBytes` verbatim (architectural lock #8).
  let parsedContribution: unknown;
  try {
    parsedContribution = JSON.parse(opts.contributionBytes.toString("utf8"));
  } catch (err) {
    throw new Error(`contribution bytes are not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const contribution = SessionContributionFileSchema.parse(parsedContribution);

  if (contribution.session_id !== lock.session_id) {
    throw new ContributionBindingError(
      `contribution session_id (${contribution.session_id}) does not match the active session (${lock.session_id})`,
    );
  }
  if (contribution.checkpoint_id !== existingState.checkpoint_id) {
    throw new ContributionBindingError(
      `contribution checkpoint_id (${contribution.checkpoint_id}) does not match the session's checkpoint (${existingState.checkpoint_id})`,
    );
  }
  if (contribution.ended_at !== opts.endedAt) {
    throw new ContributionBindingError(
      `contribution ended_at (${contribution.ended_at}) does not match this end's timestamp (${opts.endedAt})`,
    );
  }

  // Digest the EXACT buffer that is about to be written, not a
  // re-serialization of `contribution` (architectural lock #8).
  const contributionSha256 = createHash("sha256").update(opts.contributionBytes).digest("hex");

  const sessionDirAbs = join(opts.repoRoot, VIBEREVERT_DIR, SESSIONS_SUBDIR, lock.session_id);
  const sessionJsonAbs = join(sessionDirAbs, SESSION_JSON_FILENAME);
  const afterStatusAbs = join(sessionDirAbs, AFTER_STATUS_FILENAME);
  const afterStatusZAbs = join(sessionDirAbs, AFTER_STATUS_Z_FILENAME);
  const contributionAbs = join(sessionDirAbs, CONTRIBUTION_FILENAME);
  const activeLockPathAbs = join(opts.repoRoot, VIBEREVERT_DIR, ACTIVE_SESSION_LOCK_FILENAME);
  const afterStatusPathRel = `${SESSIONS_DIR_REL}/${lock.session_id}/${AFTER_STATUS_FILENAME}`;
  const afterStatusZPathRel = `${SESSIONS_DIR_REL}/${lock.session_id}/${AFTER_STATUS_Z_FILENAME}`;
  const contributionPathRel = `${SESSIONS_DIR_REL}/${lock.session_id}/${CONTRIBUTION_FILENAME}`;

  // Build + validate the post-mutation state BEFORE any disk write, so the
  // coupling refines and any drift between this builder and the schema
  // surface while the on-disk state is still byte-untouched. Timestamp
  // validity is no longer this parse's job — the contribution parse and the
  // ended_at cross-binding above already settled it — but the check costs
  // nothing and holds if either of those is ever relaxed.
  const updatedState: SessionState = {
    ...existingState,
    ended_at: opts.endedAt,
    after_status_path: afterStatusPathRel,
    after_status_z_path: afterStatusZPathRel,
    contribution_path: contributionPathRel,
    contribution_sha256: contributionSha256,
  };
  SessionStateSchema.parse(updatedState);

  // Publication order is load-bearing: the contribution lands before the
  // session.json that names it, so the only reachable inconsistency is an
  // unreferenced artifact rather than a dangling reference.
  await writeFileAtomic(contributionAbs, opts.contributionBytes);
  await writeFileAtomic(afterStatusAbs, opts.afterStatusText);
  await writeFileAtomic(afterStatusZAbs, opts.afterStatusZRaw);
  await writeFileAtomic(sessionJsonAbs, JSON.stringify(updatedState, null, 2));

  await rm(activeLockPathAbs);
}

/**
 * Read and validate a single session's `session.json`.
 *
 * Throws `SessionNotFoundError` per D23 when:
 *   - `sessionId` starts with `.tmp-` (D13: temp dirs / crash markers
 *     never resolve to valid sessions, even when explicitly requested);
 *   - the session dir does not exist;
 *   - the session dir's `session.json` is missing.
 *
 * Throws a Zod error (or `Error` for invalid JSON) if `session.json`
 * exists but fails parsing or schema validation. Callers asserting
 * existence accept these as program errors. (Note: `listSessions`
 * captures these as structured `schema_invalid` warnings instead — it
 * iterates many sessions and cannot throw on each.)
 *
 * **Also throws** if the parsed `session.json`'s `session_id` field does
 * not equal the requested `sessionId` argument (architectural lock #7).
 * This catches corruption, manual edits, bad recovery operations, or
 * concurrent write races where the file path and its internal id have
 * drifted apart. The returned `SessionState` is *guaranteed* to belong
 * to the requested id — `endSession` (which loads by lock's session_id
 * and writes the result back) relies on this guarantee to avoid
 * silently mutating the wrong session's state.
 */
export async function loadSession(sessionId: string, repoRoot: string): Promise<SessionState> {
  if (sessionId.startsWith(".tmp-")) {
    throw new SessionNotFoundError(
      sessionId,
      "session id starts with '.tmp-' (reserved for in-progress or crash-interrupted writes per D13)",
    );
  }

  const sessionJsonAbs = join(
    repoRoot,
    VIBEREVERT_DIR,
    SESSIONS_SUBDIR,
    sessionId,
    SESSION_JSON_FILENAME,
  );

  let raw: string;
  try {
    raw = await readFile(sessionJsonAbs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionNotFoundError(sessionId, "session.json not found", err);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`session.json for ${sessionId} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const session = SessionStateSchema.parse(parsed);

  if (session.session_id !== sessionId) {
    throw new Error(
      `session.json session_id (${session.session_id}) does not match requested session id (${sessionId})`,
    );
  }

  return session;
}

/**
 * List all sessions under `<repoRoot>/.viberevert/sessions/`.
 *
 * Returns the locked structured shape `{ sessions, warnings }` per D13.
 * Per D23, returns `{ sessions: [], warnings: [] }` when the sessions
 * directory does not exist (fresh repo — NOT an error).
 *
 * Iteration:
 *   - Filters entries to those matching `sess_<ULID>` (covers `.tmp-*`
 *     per D13 and any garbage).
 *   - Sorts the surviving ids ASCII-ascending so iteration order — and
 *     therefore the order of any `warnings` produced — is deterministic
 *     across platforms (`readdir` order is filesystem-dependent).
 *   - For each id, reads `session.json` and validates against
 *     `SessionStateSchema`. Failures (missing file, invalid JSON, schema
 *     violation, session_id-vs-dirname mismatch) are captured as
 *     structured `schema_invalid` warnings and the entry is omitted from
 *     `sessions`.
 *   - Reads `active-session.json` ONCE to distinguish legitimate
 *     in-flight sessions (no `ended_at` AND referenced by the active
 *     lock) from crash-interrupted orphans (no `ended_at` AND NOT
 *     referenced). Orphans are omitted from `sessions` and surfaced as
 *     `crash_interrupted` warnings.
 *
 * All `path` fields in both `sessions` and `warnings` are repo-relative
 * POSIX (e.g., `.viberevert/sessions/sess_X` and
 * `.viberevert/sessions/sess_X/session.json`), so output is byte-stable
 * across Windows and POSIX.
 *
 * Does NOT compute `is_active` field on summaries. Does NOT write to
 * stderr. Returns pure structured data; the CLI owns all presentation
 * (active-marker rendering, warnings rendering).
 */
export async function listSessions(repoRoot: string): Promise<ListSessionsResult> {
  const sessionsDirAbs = join(repoRoot, VIBEREVERT_DIR, SESSIONS_SUBDIR);

  let entries: string[];
  try {
    entries = await readdir(sessionsDirAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { sessions: [], warnings: [] };
    }
    throw err;
  }

  const validIds = entries.filter((name) => SESSION_DIR_NAME_RE.test(name)).sort();

  const activeLock = await loadActiveSessionLock(repoRoot);
  const activeSessionId = activeLock?.session_id ?? null;

  const sessions: SessionSummary[] = [];
  const warnings: ListSessionsWarning[] = [];

  for (const id of validIds) {
    const sessionJsonAbs = join(sessionsDirAbs, id, SESSION_JSON_FILENAME);
    const sessionDirRel = `${SESSIONS_DIR_REL}/${id}`;
    const sessionJsonPathRel = `${sessionDirRel}/${SESSION_JSON_FILENAME}`;

    let raw: string;
    try {
      raw = await readFile(sessionJsonAbs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        warnings.push({
          kind: "schema_invalid",
          sessionId: id,
          path: sessionJsonPathRel,
          reason: "session.json not found in session dir",
        });
        continue;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warnings.push({
        kind: "schema_invalid",
        sessionId: id,
        path: sessionJsonPathRel,
        reason: `invalid JSON: ${(err as Error).message}`,
      });
      continue;
    }

    const result = SessionStateSchema.safeParse(parsed);
    if (!result.success) {
      warnings.push({
        kind: "schema_invalid",
        sessionId: id,
        path: sessionJsonPathRel,
        reason: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }

    const session = result.data;

    if (session.session_id !== id) {
      warnings.push({
        kind: "schema_invalid",
        sessionId: id,
        path: sessionJsonPathRel,
        reason: `session.session_id (${session.session_id}) does not match dir name (${id})`,
      });
      continue;
    }

    const isEnded = session.ended_at !== undefined;
    const isActiveLocked = activeSessionId === session.session_id;

    if (!isEnded && !isActiveLocked) {
      warnings.push({
        kind: "crash_interrupted",
        sessionId: id,
        path: sessionDirRel,
      });
      continue;
    }

    sessions.push({
      id: session.session_id,
      checkpoint_id: session.checkpoint_id,
      status: isEnded ? "ended" : "active",
      started_at: session.started_at,
      ended_at: session.ended_at ?? null,
      task: session.task ?? null,
      path: sessionDirRel,
    });
  }

  // Newest first. ULIDs are lexicographically AND chronologically
  // sortable, so descending string sort gives the right order per D12.
  sessions.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  return { sessions, warnings };
}

/**
 * Read and validate `.viberevert/active-session.json`.
 *
 * Returns `null` per D23 when the file does not exist (fresh repo, no
 * session in flight — NOT an error). Throws on JSON parse failure or
 * schema validation failure (the file exists but is corrupt — caller's
 * problem to surface).
 */
export async function loadActiveSessionLock(repoRoot: string): Promise<ActiveSessionLock | null> {
  const lockPathAbs = join(repoRoot, VIBEREVERT_DIR, ACTIVE_SESSION_LOCK_FILENAME);

  let raw: string;
  try {
    raw = await readFile(lockPathAbs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`active-session.json is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }

  return ActiveSessionLockSchema.parse(parsed);
}

// =============================================================================
// appendCommandsLogEntry (M G2, D102.F)
// =============================================================================

/** Matches the locked commands.log timestamp form: ISO-8601 UTC, second precision. */
const COMMANDS_LOG_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * True iff `at` is a REAL ISO-8601 UTC second-precision timestamp:
 * shape-matched, calendar-valid, and round-trip equivalent to the
 * input. `Date.parse` alone would accept normalized impossible dates
 * (e.g. Feb 31 -> Mar 2/3); the round-trip comparison rejects them
 * because normalization shifts the value. `new Date` is used here for
 * VALIDATION ONLY -- core never generates timestamps; callers supply
 * them.
 */
function isCommandsLogAtTimestamp(at: string): boolean {
  if (!COMMANDS_LOG_AT_RE.test(at)) {
    return false;
  }
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString() === `${at.slice(0, 19)}.000Z`;
}

/**
 * True iff `cwd` is a NORMALIZED repo-relative POSIX path: exactly
 * `"."` for the repo root, or slash-separated segments that are all
 * non-empty and neither `"."` nor `".."`. Rejects backslashes,
 * absolute paths, drive prefixes, `foo//bar`, `./foo`, `foo/`, and
 * `foo/./bar`.
 */
function isRepoRelativePosixCwd(cwd: string): boolean {
  if (cwd === ".") {
    return true;
  }
  if (cwd.length === 0 || cwd.includes("\\") || cwd.startsWith("/") || /^[A-Za-z]:/.test(cwd)) {
    return false;
  }
  return cwd.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Input to `appendCommandsLogEntry` (M G2 wrapper mode, D102.F).
 */
export interface AppendCommandsLogEntryOpts {
  readonly repoRoot: string;
  /** `sess_<ULID>` id of an EXISTING session. Shape-validated here;
   *  existence-validated via `loadSession` (SessionNotFoundError
   *  propagates). */
  readonly sessionId: string;
  /**
   * ISO-8601 UTC second-precision timestamp (`YYYY-MM-DDTHH:mm:ssZ`),
   * calendar-valid. Caller-supplied -- core never generates
   * timestamps (lock #2); `new Date` appears in validation only.
   */
  readonly at: string;
  /**
   * Working directory of the wrapped invocation, REPO-RELATIVE and
   * POSIX-NORMALIZED; exactly `"."` for the repo root. Absolute
   * paths, `..`/`.` segments, empty segments, and trailing slashes
   * are rejected -- commands.log never contains absolute paths
   * (D102.F).
   */
  readonly cwd: string;
  /**
   * Exact argv of the wrapped top-level command: non-empty array of
   * strings with a non-empty command name (`argv[0]`). LATER entries
   * may be empty strings -- `node -e ""` is a valid child invocation.
   */
  readonly argv: readonly string[];
}

/**
 * Append ONE JSONL entry to an existing session's `commands.log`
 * (M G2 wrapper mode, D102.F):
 *
 *   {"at":"<ISO-8601 UTC seconds>","cwd":".","argv":["claude","--flag"]}\n
 *
 * Contract (LOCKED):
 *   - Core owns session-dir mutations: the target path comes from the
 *     session state's `commands_log_path` -- callers can NEVER supply
 *     a file path.
 *   - The log file must ALREADY exist as a regular file (created by
 *     `startSession`). Missing file, directory, or symlink fails
 *     BEFORE appending (`lstat`, so symlinks are not followed) -- a
 *     corrupted or tampered session dir cannot cause this helper to
 *     create or append to the wrong thing.
 *   - Plain append, NOT atomic temp+rename: append semantics, single
 *     writer (`viberevert run` writes exactly one entry per session).
 *     A crash mid-append is tolerated; no parser consumes commands.log
 *     in v1.
 *   - argv is recorded exactly as invoked. Shell quoting is not
 *     reconstructable (D102.C normalization note) and secrets in
 *     arguments are NOT redacted -- documented privacy boundary.
 *
 * Validation (TypeError on violation; SessionNotFoundError et al.
 * propagate from `loadSession`; `lstat`'s ENOENT propagates when the
 * log file is missing):
 *   - sessionId must match `sess_<ULID>`.
 *   - at must match `YYYY-MM-DDTHH:mm:ssZ`, be calendar-valid, and
 *     round-trip exactly.
 *   - cwd must be normalized repo-relative POSIX (see
 *     `isRepoRelativePosixCwd`).
 *   - argv must be a non-empty array of strings with non-empty
 *     argv[0].
 */
export async function appendCommandsLogEntry(opts: AppendCommandsLogEntryOpts): Promise<void> {
  if (!SESSION_DIR_NAME_RE.test(opts.sessionId)) {
    throw new TypeError(
      `appendCommandsLogEntry: sessionId must match sess_<ULID>; got ${JSON.stringify(opts.sessionId)}`,
    );
  }
  if (!isCommandsLogAtTimestamp(opts.at)) {
    throw new TypeError(
      `appendCommandsLogEntry: at must be a calendar-valid ISO-8601 UTC second-precision timestamp (YYYY-MM-DDTHH:mm:ssZ); got ${JSON.stringify(opts.at)}`,
    );
  }
  if (!isRepoRelativePosixCwd(opts.cwd)) {
    throw new TypeError(
      `appendCommandsLogEntry: cwd must be normalized repo-relative POSIX ("." for repo root); got ${JSON.stringify(opts.cwd)}`,
    );
  }
  if (
    !Array.isArray(opts.argv) ||
    opts.argv.length === 0 ||
    opts.argv.some((token) => typeof token !== "string") ||
    opts.argv[0] === ""
  ) {
    throw new TypeError(
      "appendCommandsLogEntry: argv must be a non-empty array of strings with a non-empty command name",
    );
  }

  // Existence + schema validation; the log path comes from session
  // state, never from the caller.
  const state = await loadSession(opts.sessionId, opts.repoRoot);
  const logAbs = join(opts.repoRoot, ...state.commands_log_path.split("/"));

  // The log must already exist as a regular file (startSession created
  // it). lstat, not stat: a symlinked commands.log is refused, not
  // followed. ENOENT propagates when missing.
  const logStat = await lstat(logAbs);
  if (!logStat.isFile() || logStat.isSymbolicLink()) {
    throw new TypeError(
      "appendCommandsLogEntry: commands_log_path must point to an existing regular file",
    );
  }

  const line = `${JSON.stringify({ at: opts.at, cwd: opts.cwd, argv: opts.argv })}\n`;
  await appendFile(logAbs, line, "utf8");
}
