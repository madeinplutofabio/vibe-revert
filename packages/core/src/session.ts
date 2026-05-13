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
// 5. **D22 lock dependency: caller serializes concurrent start invocations.**
//    `startSession` checks for `active-session.json` pre-existence and
//    refuses if present (`SessionAlreadyActiveError`), but the check and
//    the subsequent write are not atomic with each other. The CLI
//    orchestration layer wraps the entire `start` flow in the
//    `.viberevert/.locks/start.lock/` mkdir-based exclusive lock per D22.
//    Core does not lock internally — it trusts caller serialization.
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

import { chmod, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActiveSessionLock,
  ActiveSessionLockSchema,
  type SessionState,
  SessionStateSchema,
  SESSION_STATE_SCHEMA_VERSION,
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
 *   - None beyond the persisted active-session state. M B's CLI does
 *     not wrap `viberevert end` in the D22 start lock. Most concurrent
 *     end attempts are handled by `active-session.json` re-checking and
 *     `NoActiveSessionError`; a narrower double-end race after both
 *     calls pass the re-check may surface as a filesystem ENOENT during
 *     active-lock removal.
 *
 * What this function does, in order:
 *   1. Read `active-session.json` via `loadActiveSessionLock`. If null,
 *      throw `NoActiveSessionError` — no work done.
 *   2. Read existing `session.json` via `loadSession` (which validates
 *      schema AND verifies `session_id` matches the lock's session id —
 *      see architectural lock #7).
 *   3. Build the post-mutation `SessionState` (existing + `ended_at` +
 *      `after_status_path`) and validate it against
 *      `SessionStateSchema`. Catches malformed `opts.endedAt` (wrong
 *      ISO format, missing offset, fractional seconds, etc.) here.
 *   4. Steps 1-3 are all read/validate; the on-disk state is
 *      byte-untouched up to this point. If any of them throws, no
 *      mutation occurred.
 *   5. Write `after-status.txt` into the session dir via
 *      `writeFileAtomic`.
 *   6. Write the updated `session.json` via `writeFileAtomic`.
 *   7. Delete `active-session.json` via `rm`.
 *
 * **Known crash window (M B-tolerated):** a crash between step 6 and
 * step 7 leaves `session.json` showing the session as ended (with
 * `ended_at` set) AND `active-session.json` still pointing at it. The
 * session is logically ended on disk but the active-lock is stale —
 * subsequent `viberevert start` would refuse with the stale lock as
 * the "currently active" session. M B does not auto-recover this; a
 * future `viberevert gc` (deferred) sweeps stale locks by checking
 * whether the referenced session has `ended_at`. Manual recovery in
 * M B: delete `.viberevert/active-session.json` and retry `start`.
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

  const sessionDirAbs = join(opts.repoRoot, VIBEREVERT_DIR, SESSIONS_SUBDIR, lock.session_id);
  const sessionJsonAbs = join(sessionDirAbs, SESSION_JSON_FILENAME);
  const afterStatusAbs = join(sessionDirAbs, AFTER_STATUS_FILENAME);
  const activeLockPathAbs = join(opts.repoRoot, VIBEREVERT_DIR, ACTIVE_SESSION_LOCK_FILENAME);
  const afterStatusPathRel = `${SESSIONS_DIR_REL}/${lock.session_id}/${AFTER_STATUS_FILENAME}`;

  // Build + validate the post-mutation state BEFORE any disk write —
  // catches malformed opts.endedAt (e.g., wrong ISO format, missing
  // offset, fractional seconds) here, leaving the on-disk state
  // byte-untouched. Without this ordering, a bad endedAt would surface
  // only AFTER after-status.txt had already been written, leaving a
  // half-state (after-status.txt updated, session.json untouched,
  // active lock untouched).
  const updatedState: SessionState = {
    ...existingState,
    ended_at: opts.endedAt,
    after_status_path: afterStatusPathRel,
  };
  SessionStateSchema.parse(updatedState);

  await writeFileAtomic(afterStatusAbs, opts.afterStatusText);
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
export async function loadSession(
  sessionId: string,
  repoRoot: string,
): Promise<SessionState> {
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
    throw new Error(
      `session.json for ${sessionId} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
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
        reason: result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
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
export async function loadActiveSessionLock(
  repoRoot: string,
): Promise<ActiveSessionLock | null> {
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
    throw new Error(
      `active-session.json is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return ActiveSessionLockSchema.parse(parsed);
}
