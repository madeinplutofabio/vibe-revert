// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for the session-state lifecycle in packages/core/src/session.ts.
//
// What's load-bearing here, by section:
//
//   startSession:
//     - The full happy-path side effects: session.json contents validate
//       against SessionStateSchema, before-status.txt + commands.log
//       written verbatim, the tmp dir is renamed away (no .tmp-sess_*
//       leftover), active-session.json validates against
//       ActiveSessionLockSchema.
//     - Optional `task` lands in BOTH session.json and active-session.json.
//       Optional `agent_command` lands in session.json ONLY (the active
//       lock schema doesn't pick it).
//     - SessionAlreadyActiveError carries the parsed existing lock so the
//       CLI's refusal message can render details without re-reading.
//
//   endSession (M D Step 4a — TWO snapshots persisted per session.ts
//   header lock #1):
//     - Happy-path mutation order: after-status.txt written (D8 audit
//       form; raw v1 text), after-status.z written (D8 machine surface;
//       raw `git status --porcelain=v1 -z` BYTES persisted verbatim),
//       session.json updated with ended_at + after_status_path +
//       after_status_z_path, active-session.json deleted. Both files
//       exist after a successful endSession; both path fields populate
//       session.json. Per session.ts header lock #1 the two snapshots
//       are captured by the CLI via SEPARATE git invocations
//       (--porcelain=v1 vs --porcelain=v1 -z, because -z changes
//       output format) and supplied independently to endSession —
//       core does not assume they came from the same git call, and
//       persists the exact text and bytes the caller hands it.
//       Byte-exact round-trip of after-status.z is load-bearing:
//       M D's rollback dirty-tree comparison reads these bytes back
//       through @viberevert/git's shared parseStatusPorcelainZ
//       parser, and any text-encoding round-trip would defeat the
//       z-format's "binary-safe path delimiter" guarantee.
//     - NoActiveSessionError when no lock.
//     - Validate-before-mutate: a malformed `endedAt` throws BEFORE any
//       writeFileAtomic. Asserts on-disk state byte-untouched (no
//       after-status.txt, no after-status.z, session.json unchanged,
//       lock unchanged). This locks architectural lock #4 in session.ts:
//       read+validate first, mutate second. Coverage of after-status.z
//       absence is what makes the lock M D-tight: if a future refactor
//       split the two writes around the validation, the txt-only
//       assertion would silently pass while leaking a half-written
//       machine snapshot.
//
//   loadSession:
//     - Happy-path returns parsed SessionState.
//     - SessionNotFoundError when dir/json missing.
//     - SessionNotFoundError when sessionId starts with `.tmp-` (D13/D23
//       symmetric rule — temp dirs never resolve to valid sessions, even
//       when explicitly requested by absolute id).
//     - Throws when session.json's internal session_id mismatches the
//       requested id (architectural lock #7 — endSession depends on this
//       to avoid silently mutating the wrong session).
//
//   listSessions:
//     - { sessions: [], warnings: [] } when sessions dir missing (D23).
//     - Reverse-chronological order (newer ULID first per D12).
//     - Skips `.tmp-sess_*` entries (D13).
//     - crash_interrupted warning for orphan (no ended_at, no active
//       lock reference); omitted from `sessions`.
//     - schema_invalid warning for dirname-vs-internal-id mismatch;
//       omitted from `sessions`.
//     - Returned `path` is repo-relative POSIX (forward slashes).
//
//   loadActiveSessionLock:
//     - null when file missing (D23).
//     - Parsed ActiveSessionLock when present and valid.
//     - Throws when present but invalid JSON.
//
// Crockford-base32 note: the ULID character set excludes I, L, O, U.
// SESSION_DIR_NAME_RE in session.ts enforces this with `[0-9A-HJKMNP-TV-Z]`.
// Test fixture ids below are scrubbed accordingly — using a forbidden
// character would silently pass schema validation (nonBlankString
// accepts it) but fail the listSessions dir-name filter, hiding the
// session from the listing and causing tests to pass for the wrong
// reason or fail with misleading assertions.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActiveSessionLock,
  ActiveSessionLockSchema,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
  SessionStateSchema,
} from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  endSession,
  listSessions,
  loadActiveSessionLock,
  loadSession,
  NoActiveSessionError,
  SessionNotFoundError,
  startSession,
} from "../src/session.js";

// =============================================================================
// Test fixtures
// =============================================================================

// Two valid `sess_<ULID>` ids. ULIDs are lexicographically AND chronologically
// sortable; the first 10 chars are the timestamp portion. NEWER_ID > OLDER_ID
// in ASCII order (Y=0x59 < Z=0x5A at position 5), so listSessions must return
// NEWER first. All chars are Crockford-base32 (no I, L, O, U).
const OLDER_ID = "sess_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const NEWER_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const OLDER_TS = "2026-05-04T09:00:00Z";
const NEWER_TS = "2026-05-04T10:30:11Z";
const ENDED_TS = "2026-05-04T11:00:00Z";

// Representative `git status --porcelain=v1 -z` bytes for endSession's
// after-status.z snapshot. Two entries (modified + untracked),
// NUL-terminated per the z-format spec. Constructed as a Buffer (not a
// utf-8 string) because:
//   (a) endSession's `afterStatusZRaw` parameter is typed as Buffer —
//       string would not typecheck.
//   (b) The bytes are persisted verbatim by writeFileAtomic; the test's
//       load-bearing assertion is byte-exact round-trip via
//       Buffer.equals, NOT utf-8-decoded string equality. Any encoding
//       round-trip would defeat z-format's binary-safe path delimiter
//       guarantee and silently corrupt paths containing newlines /
//       non-utf-8 sequences (which valid git paths CAN contain).
//   (c) The bytes here are pure ASCII so they happen to round-trip
//       through utf-8 cleanly, but the test asserts byte equality
//       regardless — the assertion is calibrated to catch a future
//       refactor that accidentally writes the string form.
const AFTER_STATUS_Z_BYTES = Buffer.from(" M src/foo.ts\0?? src/bar.ts\0", "utf8");

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-core-session-"));
  await mkdir(join(repoRoot, ".viberevert"), { recursive: true });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

/**
 * Create a tmp session dir at `.viberevert/sessions/.tmp-<sessionId>/`
 * with a fake `checkpoint/` subdir, mirroring what the CLI would do
 * (call git.createCheckpoint with checkpointDir=tmp/checkpoint) before
 * invoking startSession. Returns the absolute path.
 *
 * Core does NOT verify the precondition (per session.ts architectural
 * lock #4), but populating checkpoint/ here keeps the test fixture
 * realistic — after the rename, the final session dir has the structure
 * a real session would.
 */
async function makeTmpSessionDir(sessionId: string): Promise<string> {
  const sessionsDir = join(repoRoot, ".viberevert", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const tmpPath = join(sessionsDir, `.tmp-${sessionId}`);
  await mkdir(join(tmpPath, "checkpoint"), { recursive: true });
  await writeFile(join(tmpPath, "checkpoint", "manifest.json"), '{"v":"1.0"}');
  return tmpPath;
}

/**
 * Write a complete session dir directly to disk, bypassing startSession.
 * Useful for setting up listSessions/loadSession scenarios that don't
 * exercise the start/end code path.
 */
async function writeSessionFixture(sessionId: string, state: SessionState): Promise<void> {
  const sessionDir = join(repoRoot, ".viberevert", "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(state, null, 2));
}

/**
 * Write `.viberevert/active-session.json` with the given lock contents.
 */
async function writeActiveLock(lock: ActiveSessionLock): Promise<void> {
  await writeFile(
    join(repoRoot, ".viberevert", "active-session.json"),
    JSON.stringify(lock, null, 2),
  );
}

function buildState(overrides: Partial<SessionState> & { session_id: string }): SessionState {
  const id = overrides.session_id;
  return {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    checkpoint_id: CHECKPOINT_ID,
    started_at: NEWER_TS,
    before_status_path: `.viberevert/sessions/${id}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${id}/commands.log`,
    ...overrides,
  } as SessionState;
}

// =============================================================================
// startSession
// =============================================================================

describe("startSession", () => {
  it("happy path: writes session-state files, atomically renames tmp dir, writes active lock", async () => {
    const tmpDir = await makeTmpSessionDir(NEWER_ID);

    await startSession({
      repoRoot,
      tmpSessionDir: tmpDir,
      sessionId: NEWER_ID,
      checkpointId: CHECKPOINT_ID,
      startedAt: NEWER_TS,
      beforeStatusText: " M src/foo.ts\n?? src/bar.ts\n",
    });

    // tmp dir consumed by rename (no leftover)
    await expect(stat(tmpDir)).rejects.toThrow();

    const finalDir = join(repoRoot, ".viberevert", "sessions", NEWER_ID);
    expect((await stat(finalDir)).isDirectory()).toBe(true);

    // session.json validates against the schema and round-trips
    const sessionRaw = await readFile(join(finalDir, "session.json"), "utf8");
    const session = SessionStateSchema.parse(JSON.parse(sessionRaw));
    expect(session.session_id).toBe(NEWER_ID);
    expect(session.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(session.started_at).toBe(NEWER_TS);
    expect(session.ended_at).toBeUndefined();
    expect(session.task).toBeUndefined();
    expect(session.agent_command).toBeUndefined();
    expect(session.before_status_path).toBe(`.viberevert/sessions/${NEWER_ID}/before-status.txt`);
    expect(session.commands_log_path).toBe(`.viberevert/sessions/${NEWER_ID}/commands.log`);

    // Status file written verbatim
    expect(await readFile(join(finalDir, "before-status.txt"), "utf8")).toBe(
      " M src/foo.ts\n?? src/bar.ts\n",
    );

    // commands.log created empty
    expect(await readFile(join(finalDir, "commands.log"), "utf8")).toBe("");

    // The fake checkpoint subdir written by makeTmpSessionDir came along
    // for the ride (rename moves the whole tree)
    expect(await readFile(join(finalDir, "checkpoint", "manifest.json"), "utf8")).toBe(
      '{"v":"1.0"}',
    );

    // Active lock validates and matches
    const lockRaw = await readFile(join(repoRoot, ".viberevert", "active-session.json"), "utf8");
    const lock = ActiveSessionLockSchema.parse(JSON.parse(lockRaw));
    expect(lock.session_id).toBe(NEWER_ID);
    expect(lock.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(lock.started_at).toBe(NEWER_TS);
    expect(lock.task).toBeUndefined();
  });

  it("includes optional task in both session.json and active-session.json; agent_command in session.json only", async () => {
    const tmpDir = await makeTmpSessionDir(NEWER_ID);

    await startSession({
      repoRoot,
      tmpSessionDir: tmpDir,
      sessionId: NEWER_ID,
      checkpointId: CHECKPOINT_ID,
      startedAt: NEWER_TS,
      beforeStatusText: "",
      task: "Add yearly billing",
      agentCommand: "claude --dangerous",
    });

    const session = SessionStateSchema.parse(
      JSON.parse(
        await readFile(join(repoRoot, ".viberevert", "sessions", NEWER_ID, "session.json"), "utf8"),
      ),
    );
    expect(session.task).toBe("Add yearly billing");
    expect(session.agent_command).toBe("claude --dangerous");

    const lockRaw = await readFile(join(repoRoot, ".viberevert", "active-session.json"), "utf8");
    const lockParsed = JSON.parse(lockRaw) as { task?: unknown; agent_command?: unknown };
    expect(lockParsed.task).toBe("Add yearly billing");
    // agent_command must NOT appear in the active lock (picked schema
    // excludes it; strictObject would reject it on parse).
    expect(lockParsed.agent_command).toBeUndefined();
    // And re-validation against the strict picked schema must succeed.
    expect(() => ActiveSessionLockSchema.parse(lockParsed)).not.toThrow();
  });

  it("refuses with SessionAlreadyActiveError when active-session.json already exists, carrying the parsed lock", async () => {
    await writeActiveLock({
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: OLDER_ID,
      checkpoint_id: CHECKPOINT_ID,
      started_at: OLDER_TS,
      task: "earlier session",
    });

    const tmpDir = await makeTmpSessionDir(NEWER_ID);

    await expect(
      startSession({
        repoRoot,
        tmpSessionDir: tmpDir,
        sessionId: NEWER_ID,
        checkpointId: CHECKPOINT_ID,
        startedAt: NEWER_TS,
        beforeStatusText: "",
      }),
    ).rejects.toMatchObject({
      name: "SessionAlreadyActiveError",
      active: {
        session_id: OLDER_ID,
        checkpoint_id: CHECKPOINT_ID,
        started_at: OLDER_TS,
        task: "earlier session",
      },
    });

    // tmp dir untouched (no rename happened)
    expect((await stat(tmpDir)).isDirectory()).toBe(true);
    // No new session dir created
    const sessionsListing = await readdir(join(repoRoot, ".viberevert", "sessions"));
    expect(sessionsListing).toEqual([`.tmp-${NEWER_ID}`]);
  });
});

// =============================================================================
// endSession
// =============================================================================

describe("endSession", () => {
  it("happy path: writes after-status.txt + after-status.z, mutates session.json with both paths, deletes active lock", async () => {
    // Set up an in-flight session
    const tmpDir = await makeTmpSessionDir(NEWER_ID);
    await startSession({
      repoRoot,
      tmpSessionDir: tmpDir,
      sessionId: NEWER_ID,
      checkpointId: CHECKPOINT_ID,
      startedAt: NEWER_TS,
      beforeStatusText: "before",
    });

    await endSession({
      repoRoot,
      endedAt: ENDED_TS,
      afterStatusText: "after",
      afterStatusZRaw: AFTER_STATUS_Z_BYTES,
    });

    const finalDir = join(repoRoot, ".viberevert", "sessions", NEWER_ID);

    // after-status.txt (D8 audit form — raw v1 text) written verbatim
    expect(await readFile(join(finalDir, "after-status.txt"), "utf8")).toBe("after");

    // after-status.z (D8 machine surface — raw -z bytes) written
    // BYTE-IDENTICALLY. readFile with no encoding returns a Buffer;
    // Buffer.equals is the byte-exact comparator. Asserting via utf-8
    // round-trip would mask a future refactor that accidentally
    // encoded the bytes as a string before writing.
    const zRoundTrip = await readFile(join(finalDir, "after-status.z"));
    expect(Buffer.isBuffer(zRoundTrip)).toBe(true);
    expect(zRoundTrip.equals(AFTER_STATUS_Z_BYTES)).toBe(true);

    // session.json mutated correctly — BOTH path fields populated per
    // M D Step 4a
    const session = SessionStateSchema.parse(
      JSON.parse(await readFile(join(finalDir, "session.json"), "utf8")),
    );
    expect(session.ended_at).toBe(ENDED_TS);
    expect(session.after_status_path).toBe(`.viberevert/sessions/${NEWER_ID}/after-status.txt`);
    expect(session.after_status_z_path).toBe(`.viberevert/sessions/${NEWER_ID}/after-status.z`);
    // Pre-existing fields preserved
    expect(session.session_id).toBe(NEWER_ID);
    expect(session.started_at).toBe(NEWER_TS);

    // Active lock deleted
    await expect(stat(join(repoRoot, ".viberevert", "active-session.json"))).rejects.toThrow();
  });

  it("throws NoActiveSessionError when no active-session.json exists", async () => {
    await expect(
      endSession({
        repoRoot,
        endedAt: ENDED_TS,
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
      }),
    ).rejects.toBeInstanceOf(NoActiveSessionError);
  });

  it("validate-before-mutate: malformed endedAt throws BEFORE any writeFileAtomic", async () => {
    // Set up an in-flight session
    const tmpDir = await makeTmpSessionDir(NEWER_ID);
    await startSession({
      repoRoot,
      tmpSessionDir: tmpDir,
      sessionId: NEWER_ID,
      checkpointId: CHECKPOINT_ID,
      startedAt: NEWER_TS,
      beforeStatusText: "before",
    });

    const finalDir = join(repoRoot, ".viberevert", "sessions", NEWER_ID);
    const sessionJsonBefore = await readFile(join(finalDir, "session.json"), "utf8");
    const lockBefore = await readFile(join(repoRoot, ".viberevert", "active-session.json"), "utf8");

    await expect(
      endSession({
        repoRoot,
        endedAt: "not-a-real-date",
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
      }),
    ).rejects.toThrow();

    // No after-status.txt written
    await expect(stat(join(finalDir, "after-status.txt"))).rejects.toThrow();
    // No after-status.z written either — M D Step 4a tightens the
    // validate-before-mutate invariant to cover BOTH snapshots. A
    // future refactor that split the two writes around the validation
    // would leak the z-file even when endedAt is malformed; this
    // assertion is the canary.
    await expect(stat(join(finalDir, "after-status.z"))).rejects.toThrow();
    // session.json byte-untouched
    expect(await readFile(join(finalDir, "session.json"), "utf8")).toBe(sessionJsonBefore);
    // Active lock byte-untouched
    expect(await readFile(join(repoRoot, ".viberevert", "active-session.json"), "utf8")).toBe(
      lockBefore,
    );
  });
});

// =============================================================================
// loadSession
// =============================================================================

describe("loadSession", () => {
  it("returns parsed SessionState for a valid session", async () => {
    const state = buildState({ session_id: NEWER_ID });
    await writeSessionFixture(NEWER_ID, state);

    const loaded = await loadSession(NEWER_ID, repoRoot);
    expect(loaded.session_id).toBe(NEWER_ID);
    expect(loaded.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(loaded.started_at).toBe(NEWER_TS);
  });

  it("throws SessionNotFoundError when session.json missing", async () => {
    await expect(loadSession(NEWER_ID, repoRoot)).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("throws SessionNotFoundError when sessionId starts with '.tmp-' (D13/D23)", async () => {
    // Even create a real session dir with a `.tmp-` name + valid contents
    // — the check is on the requested id string, not on disk presence.
    const state = buildState({ session_id: NEWER_ID });
    await writeSessionFixture(`.tmp-${NEWER_ID}`, state);

    await expect(loadSession(`.tmp-${NEWER_ID}`, repoRoot)).rejects.toMatchObject({
      name: "SessionNotFoundError",
      sessionId: `.tmp-${NEWER_ID}`,
    });
  });

  it("throws when session.json's internal session_id mismatches the requested id (architectural lock #7)", async () => {
    // Write a session.json under NEWER_ID's directory but with OLDER_ID
    // as its internal session_id field — simulating corruption / manual
    // edit / bad recovery.
    const state = buildState({
      session_id: OLDER_ID,
      before_status_path: `.viberevert/sessions/${NEWER_ID}/before-status.txt`,
      commands_log_path: `.viberevert/sessions/${NEWER_ID}/commands.log`,
    });
    await writeSessionFixture(NEWER_ID, state);

    await expect(loadSession(NEWER_ID, repoRoot)).rejects.toThrow(/session_id .* does not match/);
  });
});

// =============================================================================
// listSessions
// =============================================================================

describe("listSessions", () => {
  it("returns { sessions: [], warnings: [] } when sessions dir missing (D23)", async () => {
    const result = await listSessions(repoRoot);
    expect(result).toEqual({ sessions: [], warnings: [] });
  });

  it("lists ended sessions newest first (reverse-chronological per D12)", async () => {
    await writeSessionFixture(
      OLDER_ID,
      buildState({
        session_id: OLDER_ID,
        started_at: OLDER_TS,
        ended_at: "2026-05-04T09:30:00Z",
        after_status_path: `.viberevert/sessions/${OLDER_ID}/after-status.txt`,
      }),
    );
    await writeSessionFixture(
      NEWER_ID,
      buildState({
        session_id: NEWER_ID,
        started_at: NEWER_TS,
        ended_at: ENDED_TS,
        after_status_path: `.viberevert/sessions/${NEWER_ID}/after-status.txt`,
      }),
    );

    const { sessions, warnings } = await listSessions(repoRoot);
    expect(warnings).toEqual([]);
    expect(sessions.map((s) => s.id)).toEqual([NEWER_ID, OLDER_ID]);

    const newest = sessions[0];
    if (newest === undefined) throw new Error("test bug: missing first session");
    expect(newest.status).toBe("ended");
    expect(newest.ended_at).toBe(ENDED_TS);
    expect(newest.path).toBe(`.viberevert/sessions/${NEWER_ID}`);
  });

  it("skips '.tmp-sess_*' entries (D13)", async () => {
    await writeSessionFixture(
      NEWER_ID,
      buildState({
        session_id: NEWER_ID,
        ended_at: ENDED_TS,
        after_status_path: `.viberevert/sessions/${NEWER_ID}/after-status.txt`,
      }),
    );
    // Inject a leftover .tmp-sess_* dir with a fully-valid session.json
    // inside — listSessions must still ignore it because the dir name is
    // not `sess_<ULID>`.
    await writeSessionFixture(
      `.tmp-${OLDER_ID}`,
      buildState({
        session_id: OLDER_ID,
        ended_at: "2026-05-04T09:30:00Z",
        after_status_path: `.viberevert/sessions/${OLDER_ID}/after-status.txt`,
      }),
    );

    const { sessions, warnings } = await listSessions(repoRoot);
    expect(warnings).toEqual([]);
    expect(sessions.map((s) => s.id)).toEqual([NEWER_ID]);
  });

  it("emits crash_interrupted warning for orphan (no ended_at, no active-lock reference) and omits from sessions", async () => {
    // Orphan: no ended_at, and no active-session.json references it.
    await writeSessionFixture(NEWER_ID, buildState({ session_id: NEWER_ID }));

    const { sessions, warnings } = await listSessions(repoRoot);
    expect(sessions).toEqual([]);
    expect(warnings).toEqual([
      {
        kind: "crash_interrupted",
        sessionId: NEWER_ID,
        path: `.viberevert/sessions/${NEWER_ID}`,
      },
    ]);
  });

  it("returns active session in sessions array (status: 'active') when active-session.json references it", async () => {
    await writeSessionFixture(NEWER_ID, buildState({ session_id: NEWER_ID }));
    await writeActiveLock({
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: NEWER_ID,
      checkpoint_id: CHECKPOINT_ID,
      started_at: NEWER_TS,
    });

    const { sessions, warnings } = await listSessions(repoRoot);
    expect(warnings).toEqual([]);
    expect(sessions).toHaveLength(1);

    const active = sessions[0];
    if (active === undefined) throw new Error("test bug: missing active session");
    expect(active.status).toBe("active");
    expect(active.ended_at).toBeNull();
    expect(active.task).toBeNull();
  });

  it("emits schema_invalid warning when session.json's internal session_id mismatches its dir name", async () => {
    // Dir is NEWER_ID but session.json claims OLDER_ID — same shape as
    // loadSession's mismatch check, but listSessions captures it as a
    // structured warning instead of throwing.
    await writeSessionFixture(
      NEWER_ID,
      buildState({
        session_id: OLDER_ID,
        before_status_path: `.viberevert/sessions/${NEWER_ID}/before-status.txt`,
        commands_log_path: `.viberevert/sessions/${NEWER_ID}/commands.log`,
        ended_at: ENDED_TS,
        after_status_path: `.viberevert/sessions/${NEWER_ID}/after-status.txt`,
      }),
    );

    const { sessions, warnings } = await listSessions(repoRoot);
    expect(sessions).toEqual([]);
    expect(warnings).toHaveLength(1);

    const warning = warnings[0];
    if (warning === undefined) throw new Error("test bug: missing warning");
    expect(warning.kind).toBe("schema_invalid");
    expect(warning.sessionId).toBe(NEWER_ID);
    expect(warning.path).toBe(`.viberevert/sessions/${NEWER_ID}/session.json`);
    if (warning.kind === "schema_invalid") {
      expect(warning.reason).toMatch(/does not match dir name/);
    }
  });
});

// =============================================================================
// loadActiveSessionLock
// =============================================================================

describe("loadActiveSessionLock", () => {
  it("returns null when active-session.json missing (D23)", async () => {
    expect(await loadActiveSessionLock(repoRoot)).toBeNull();
  });

  it("returns parsed ActiveSessionLock when file exists and validates", async () => {
    await writeActiveLock({
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: NEWER_ID,
      checkpoint_id: CHECKPOINT_ID,
      started_at: NEWER_TS,
      task: "active task",
    });

    const lock = await loadActiveSessionLock(repoRoot);
    expect(lock).toEqual({
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: NEWER_ID,
      checkpoint_id: CHECKPOINT_ID,
      started_at: NEWER_TS,
      task: "active task",
    });
  });

  it("throws on invalid JSON in active-session.json", async () => {
    await writeFile(join(repoRoot, ".viberevert", "active-session.json"), "this is not json");
    await expect(loadActiveSessionLock(repoRoot)).rejects.toThrow(/not valid JSON/);
  });
});
