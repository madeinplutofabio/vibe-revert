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
//   header lock #1; M 0.8.0 — a THIRD artifact, the contribution):
//     - Happy-path FINAL STATE: contribution.json holds the caller's exact
//       bytes (M 0.8.0), after-status.txt holds the D8 audit form (raw v1
//       text), after-status.z holds the D8 machine surface (raw
//       `git status --porcelain=v1 -z` BYTES persisted verbatim),
//       session.json carries ended_at + after_status_path +
//       after_status_z_path + contribution_path + contribution_sha256, and
//       active-session.json is gone. The WRITE ORDER is not observable
//       from outside endSession and is deliberately not asserted here;
//       what IS asserted is the invariant that order protects — that
//       contribution_sha256 digests the bytes actually present at
//       contribution_path.
//       Per session.ts header lock #1 the two status snapshots are
//       captured by the CLI via SEPARATE git invocations (--porcelain=v1
//       vs --porcelain=v1 -z, because -z changes output format) and
//       supplied independently to endSession — core does not assume they
//       came from the same git call, and persists the exact text and bytes
//       the caller hands it. Byte-exact round-trip of after-status.z is
//       load-bearing: M D's rollback dirty-tree comparison reads these
//       bytes back through @viberevert/git's shared parseStatusPorcelainZ
//       parser, and any text-encoding round-trip would defeat the
//       z-format's "binary-safe path delimiter" guarantee.
//     - NoActiveSessionError when no lock.
//     - Validate-before-mutate: a malformed `endedAt` refuses BEFORE any
//       writeFileAtomic. Asserts on-disk state byte-untouched (no
//       contribution.json, no after-status.txt, no after-status.z,
//       session.json unchanged, lock unchanged). This pins endSession's
//       read-and-validate-first, mutate-second ordering. Coverage of
//       after-status.z absence is what makes it M D-tight; coverage of
//       contribution.json absence is what makes it 0.8.0-tight. If a
//       future refactor hoisted any write above the validation block, one
//       of those three absence assertions is the canary.
//       On what that case actually rejects: `endedAt` must equal the
//       contribution's `ended_at`, so the fixture carries the same
//       malformed value on both sides to avoid tripping the cross-binding
//       check instead. SessionContributionFileSchema therefore rejects the
//       timestamp first, before the terminal SessionState is ever built.
//       The terminal parse stays as defense in depth for the coupling
//       rules; this test does not separately exercise its timestamp
//       validator.
//
//   endSession, the M 0.8.0 contribution specifically:
//     - Architectural lock #8 (EXACT bytes, never a re-serialization) is
//       pinned by handing core deliberately NON-CANONICAL bytes — the
//       same object serialized compactly rather than with the producer's
//       2-space indent — and asserting both that the on-disk file equals
//       those bytes and that contribution_sha256 is their digest. A
//       reserializing implementation would still validate and still
//       "work"; it would just write different bytes, or record a digest
//       over bytes that are not on disk. The test also asserts the two
//       serializations actually differ, so it cannot pass vacuously.
//     - The SAME test first seeds an UNREFERENCED contribution.json, the
//       state session.ts documents as reachable when a prior end was
//       interrupted between publishing the contribution and writing the
//       session.json that names it. The session is still active, so a
//       retry must replace that orphan — not fail on it, not merge with
//       it. Folding this into the exact-byte case is deliberate: the
//       orphan carries the OTHER serialization, so a failed replacement is
//       caught by the byte-equality assertion already there. It also
//       exercises rename-over-an-existing-regular-file on Windows.
//     - The three cross-bindings (session_id, checkpoint_id, ended_at)
//       each get their own refusal test, because a single combined test
//       would still pass if two of the three checks were deleted.
//     - Malformed payloads (not JSON; schema-invalid) refuse with their
//       NATIVE error detail rather than ContributionBindingError. The
//       schema case asserts on the ZodError's issue path, so swapping the
//       structural failure for a generic Error would fail the test —
//       asserting merely "not a ContributionBindingError" would not.
//     - Every refusal above asserts zero mutation, through the same helper
//       the malformed-endedAt case uses.
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

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActiveSessionLock,
  ActiveSessionLockSchema,
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionContributionFile,
  type SessionState,
  SessionStateSchema,
} from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendCommandsLogEntry,
  ContributionBindingError,
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
// A second valid checkpoint id, used ONLY by the checkpoint cross-binding
// refusal. It must be schema-valid so the test reaches the binding check
// rather than failing earlier on shape.
const OTHER_CHECKPOINT_ID = "cp_01JV8Z0N6E7ABCDEFGHJKMNPQR";
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

// M 0.8.0 contribution fixtures. `gitObjectId` requires 40 or 64 lowercase
// hex; these are 40-char SHA-1-shaped ids. They differ from each other so the
// fixture describes a session that committed, which is the realistic case.
const BEFORE_HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const AFTER_HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";

/**
 * A minimal but fully valid `SessionContributionFile`.
 *
 * `entries: []` is a real contribution, not a degenerate stub: a session that
 * ended without changing anything produces exactly this. Core validates and
 * digests the artifact without interpreting `entries`, so an empty list
 * exercises every code path in endSession while keeping the fixture free of
 * PathState and change-group construction that belongs to @viberevert/git's
 * tests, not core's.
 *
 * The schema's string fields infer as plain `string`, so an override may carry
 * a deliberately INVALID value (a truncated sha, a malformed timestamp)
 * without a cast — which is what the refusal fixtures below rely on.
 */
function buildContribution(
  overrides: Partial<SessionContributionFile> = {},
): SessionContributionFile {
  return {
    schema_version: CONTRIBUTION_FILE_SCHEMA_VERSION,
    session_id: NEWER_ID,
    checkpoint_id: CHECKPOINT_ID,
    before_head_sha: BEFORE_HEAD_SHA,
    after_head_sha: AFTER_HEAD_SHA,
    captured_at: NEWER_TS,
    ended_at: ENDED_TS,
    entries: [],
    ...overrides,
  };
}

/**
 * Serialize a contribution the way the shipped producer does: 2-space indent,
 * no trailing newline. Core never performs this step itself — that is exactly
 * the point of architectural lock #8 — so the tests own it.
 */
function serializeContribution(contribution: SessionContributionFile): Buffer {
  return Buffer.from(JSON.stringify(contribution, null, 2), "utf8");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The canonical payload used by every test that is not varying it. */
const CONTRIBUTION_BYTES = serializeContribution(buildContribution());

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

/**
 * Start a real in-flight session for NEWER_ID and return its final dir.
 *
 * Uses startSession rather than a hand-written fixture so the state
 * endSession reads is the state startSession actually produces — a fixture
 * could drift from the writer and hide a coupling bug.
 */
async function startInFlightSession(): Promise<string> {
  const tmpDir = await makeTmpSessionDir(NEWER_ID);
  await startSession({
    repoRoot,
    tmpSessionDir: tmpDir,
    sessionId: NEWER_ID,
    checkpointId: CHECKPOINT_ID,
    startedAt: NEWER_TS,
    beforeStatusText: "before",
  });
  return join(repoRoot, ".viberevert", "sessions", NEWER_ID);
}

const ACTIVE_LOCK_REL = join(".viberevert", "active-session.json");

/**
 * Assert that a REFUSED endSession left the session dir byte-untouched.
 *
 * Covers all three artifacts endSession would write plus both pieces of
 * pre-existing state. Shared by the malformed-endedAt case and every M 0.8.0
 * contribution refusal, so a write hoisted above the validation block fails
 * here no matter which input triggered the refusal.
 */
async function expectNoEndMutation(
  finalDir: string,
  sessionJsonBefore: string,
  lockBefore: string,
): Promise<void> {
  await expect(stat(join(finalDir, "contribution.json"))).rejects.toThrow();
  await expect(stat(join(finalDir, "after-status.txt"))).rejects.toThrow();
  await expect(stat(join(finalDir, "after-status.z"))).rejects.toThrow();
  expect(await readFile(join(finalDir, "session.json"), "utf8")).toBe(sessionJsonBefore);
  expect(await readFile(join(repoRoot, ACTIVE_LOCK_REL), "utf8")).toBe(lockBefore);
}

describe("endSession", () => {
  it("happy path: writes contribution + both status snapshots, mutates session.json, deletes active lock", async () => {
    const finalDir = await startInFlightSession();

    await endSession({
      repoRoot,
      endedAt: ENDED_TS,
      afterStatusText: "after",
      afterStatusZRaw: AFTER_STATUS_Z_BYTES,
      contributionBytes: CONTRIBUTION_BYTES,
    });

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

    // contribution.json (M 0.8.0) likewise written BYTE-IDENTICALLY.
    const contributionRoundTrip = await readFile(join(finalDir, "contribution.json"));
    expect(contributionRoundTrip.equals(CONTRIBUTION_BYTES)).toBe(true);

    // session.json mutated correctly — all path fields populated
    const session = SessionStateSchema.parse(
      JSON.parse(await readFile(join(finalDir, "session.json"), "utf8")),
    );
    expect(session.ended_at).toBe(ENDED_TS);
    expect(session.after_status_path).toBe(`.viberevert/sessions/${NEWER_ID}/after-status.txt`);
    expect(session.after_status_z_path).toBe(`.viberevert/sessions/${NEWER_ID}/after-status.z`);
    expect(session.contribution_path).toBe(`.viberevert/sessions/${NEWER_ID}/contribution.json`);

    // The recorded digest describes the bytes actually on disk. That pairing
    // is what a reader resolving contribution_path depends on; the write
    // order session.ts uses to keep it robust is not observable from here.
    expect(session.contribution_sha256).toBe(sha256Hex(contributionRoundTrip));

    // Pre-existing fields preserved
    expect(session.session_id).toBe(NEWER_ID);
    expect(session.started_at).toBe(NEWER_TS);

    // Active lock deleted
    await expect(stat(join(repoRoot, ACTIVE_LOCK_REL))).rejects.toThrow();
  });

  it("throws NoActiveSessionError when no active-session.json exists", async () => {
    await expect(
      endSession({
        repoRoot,
        endedAt: ENDED_TS,
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
        contributionBytes: CONTRIBUTION_BYTES,
      }),
    ).rejects.toBeInstanceOf(NoActiveSessionError);
  });

  it("validate-before-mutate: a malformed endedAt refuses BEFORE any writeFileAtomic", async () => {
    const finalDir = await startInFlightSession();
    const sessionJsonBefore = await readFile(join(finalDir, "session.json"), "utf8");
    const lockBefore = await readFile(join(repoRoot, ACTIVE_LOCK_REL), "utf8");

    await expect(
      endSession({
        repoRoot,
        endedAt: "not-a-real-date",
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
        // Carries the same malformed value, so the refusal comes from
        // timestamp validation rather than the ended_at cross-binding.
        // SessionContributionFileSchema rejects it first, before the
        // terminal SessionState is built — the point of this test is the
        // zero-mutation guarantee, not which validator fires.
        contributionBytes: serializeContribution(
          buildContribution({ ended_at: "not-a-real-date" }),
        ),
      }),
    ).rejects.toThrow();

    // Nothing written: not the contribution (M 0.8.0), not either status
    // snapshot (M D Step 4a), and neither piece of pre-existing state moved.
    await expectNoEndMutation(finalDir, sessionJsonBefore, lockBefore);
  });
});

// =============================================================================
// endSession: the M 0.8.0 session contribution
// =============================================================================

describe("endSession contribution persistence (M 0.8.0)", () => {
  it("writes the caller's EXACT bytes and replaces an orphan left by an interrupted end (lock #8)", async () => {
    // Compact JSON parses to the same object as the producer's 2-space form,
    // so a reserializing implementation would still validate and still
    // "work" — it would just write different bytes, or record a digest over
    // bytes that are not on disk. Both are caught below.
    const contribution = buildContribution();
    const compactBytes = Buffer.from(JSON.stringify(contribution), "utf8");
    const prettyBytes = serializeContribution(contribution);

    // Guard: if these ever became equal the test would pass vacuously.
    expect(compactBytes.equals(prettyBytes)).toBe(false);

    const finalDir = await startInFlightSession();

    // Seed the orphan that a crash between "publish contribution" and "write
    // session.json" leaves behind. The session is still ACTIVE, so this retry
    // must replace the file in place. The orphan deliberately holds the OTHER
    // serialization, so a failed replacement cannot hide behind bytes that
    // happen to match.
    await writeFile(join(finalDir, "contribution.json"), prettyBytes);
    expect((await readFile(join(finalDir, "contribution.json"))).equals(prettyBytes)).toBe(true);

    await endSession({
      repoRoot,
      endedAt: ENDED_TS,
      afterStatusText: "after",
      afterStatusZRaw: AFTER_STATUS_Z_BYTES,
      contributionBytes: compactBytes,
    });

    const onDisk = await readFile(join(finalDir, "contribution.json"));
    expect(onDisk.equals(compactBytes)).toBe(true);
    expect(onDisk.equals(prettyBytes)).toBe(false);

    const session = SessionStateSchema.parse(
      JSON.parse(await readFile(join(finalDir, "session.json"), "utf8")),
    );
    expect(session.contribution_sha256).toBe(sha256Hex(compactBytes));
    expect(session.contribution_sha256).not.toBe(sha256Hex(prettyBytes));
  });

  it("refuses a contribution whose session_id names a different session", async () => {
    const finalDir = await startInFlightSession();
    const sessionJsonBefore = await readFile(join(finalDir, "session.json"), "utf8");
    const lockBefore = await readFile(join(repoRoot, ACTIVE_LOCK_REL), "utf8");

    await expect(
      endSession({
        repoRoot,
        endedAt: ENDED_TS,
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
        contributionBytes: serializeContribution(buildContribution({ session_id: OLDER_ID })),
      }),
    ).rejects.toBeInstanceOf(ContributionBindingError);

    await expectNoEndMutation(finalDir, sessionJsonBefore, lockBefore);
  });

  it("refuses a contribution whose checkpoint_id is not the session's checkpoint", async () => {
    const finalDir = await startInFlightSession();
    const sessionJsonBefore = await readFile(join(finalDir, "session.json"), "utf8");
    const lockBefore = await readFile(join(repoRoot, ACTIVE_LOCK_REL), "utf8");

    await expect(
      endSession({
        repoRoot,
        endedAt: ENDED_TS,
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
        contributionBytes: serializeContribution(
          buildContribution({ checkpoint_id: OTHER_CHECKPOINT_ID }),
        ),
      }),
    ).rejects.toBeInstanceOf(ContributionBindingError);

    await expectNoEndMutation(finalDir, sessionJsonBefore, lockBefore);
  });

  it("refuses a contribution whose ended_at disagrees with this end's timestamp", async () => {
    // Without this binding, session.json and contribution.json could record
    // two different end times for one event. Both values here are WELL-FORMED
    // timestamps, so the refusal can only come from the cross-binding check.
    const finalDir = await startInFlightSession();
    const sessionJsonBefore = await readFile(join(finalDir, "session.json"), "utf8");
    const lockBefore = await readFile(join(repoRoot, ACTIVE_LOCK_REL), "utf8");

    await expect(
      endSession({
        repoRoot,
        endedAt: ENDED_TS,
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
        contributionBytes: serializeContribution(buildContribution({ ended_at: OLDER_TS })),
      }),
    ).rejects.toBeInstanceOf(ContributionBindingError);

    await expectNoEndMutation(finalDir, sessionJsonBefore, lockBefore);
  });

  it("refuses contribution bytes that are not valid JSON, with native error detail", async () => {
    const finalDir = await startInFlightSession();
    const sessionJsonBefore = await readFile(join(finalDir, "session.json"), "utf8");
    const lockBefore = await readFile(join(repoRoot, ACTIVE_LOCK_REL), "utf8");

    await expect(
      endSession({
        repoRoot,
        endedAt: ENDED_TS,
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
        contributionBytes: Buffer.from("this is not json", "utf8"),
      }),
    ).rejects.toThrow(/not valid JSON/);

    await expectNoEndMutation(finalDir, sessionJsonBefore, lockBefore);
  });

  it("refuses a schema-invalid contribution with its native Zod issue detail", async () => {
    // A truncated head sha: structurally JSON, semantically not a git object
    // id. This must NOT be flattened into ContributionBindingError — the
    // three bindings are about identity, and folding shape failures into them
    // would discard the field-level detail an operator needs to act on.
    // Asserting the issue PATH, rather than merely "not a
    // ContributionBindingError", is what stops a future generic
    // `new Error("bad contribution")` from satisfying this test.
    const finalDir = await startInFlightSession();
    const sessionJsonBefore = await readFile(join(finalDir, "session.json"), "utf8");
    const lockBefore = await readFile(join(repoRoot, ACTIVE_LOCK_REL), "utf8");

    await expect(
      endSession({
        repoRoot,
        endedAt: ENDED_TS,
        afterStatusText: "after",
        afterStatusZRaw: AFTER_STATUS_Z_BYTES,
        contributionBytes: serializeContribution(
          buildContribution({ before_head_sha: "deadbeef" }),
        ),
      }),
    ).rejects.toMatchObject({
      name: "ZodError",
      issues: expect.arrayContaining([expect.objectContaining({ path: ["before_head_sha"] })]),
    });

    await expectNoEndMutation(finalDir, sessionJsonBefore, lockBefore);
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

// =============================================================================
// appendCommandsLogEntry (M G2, D102.F)
// =============================================================================

describe("appendCommandsLogEntry", () => {
  const AT = ENDED_TS; // "2026-05-04T11:00:00Z" -- valid UTC second-precision

  /** Start a REAL session via startSession so commands.log exists (empty). */
  async function startRealSession(sessionId: string): Promise<void> {
    const tmpDir = await makeTmpSessionDir(sessionId);
    await startSession({
      repoRoot,
      tmpSessionDir: tmpDir,
      sessionId,
      checkpointId: CHECKPOINT_ID,
      startedAt: NEWER_TS,
      beforeStatusText: " M src/foo.ts\n?? src/bar.ts\n",
    });
  }

  function logPathAbs(sessionId: string): string {
    return join(repoRoot, ".viberevert", "sessions", sessionId, "commands.log");
  }

  it("happy path: appends exactly one byte-exact JSONL line to the empty log", async () => {
    await startRealSession(NEWER_ID);
    await appendCommandsLogEntry({
      repoRoot,
      sessionId: NEWER_ID,
      at: AT,
      cwd: ".",
      argv: ["claude", "--flag"],
    });
    const content = await readFile(logPathAbs(NEWER_ID), "utf8");
    expect(content).toBe('{"at":"2026-05-04T11:00:00Z","cwd":".","argv":["claude","--flag"]}\n');
  });

  it("append semantics: a second entry accumulates; subdir cwd and empty LATER argv entries are valid", async () => {
    await startRealSession(NEWER_ID);
    await appendCommandsLogEntry({ repoRoot, sessionId: NEWER_ID, at: AT, cwd: ".", argv: ["a"] });
    await appendCommandsLogEntry({
      repoRoot,
      sessionId: NEWER_ID,
      at: AT,
      cwd: "packages/foo",
      argv: ["node", "-e", ""],
    });
    const content = await readFile(logPathAbs(NEWER_ID), "utf8");
    expect(content).toBe(
      '{"at":"2026-05-04T11:00:00Z","cwd":".","argv":["a"]}\n' +
        '{"at":"2026-05-04T11:00:00Z","cwd":"packages/foo","argv":["node","-e",""]}\n',
    );
  });

  it("rejects a malformed session id before touching the filesystem", async () => {
    await expect(
      appendCommandsLogEntry({
        repoRoot,
        sessionId: "sess_not-a-ulid",
        at: AT,
        cwd: ".",
        argv: ["x"],
      }),
    ).rejects.toThrow(TypeError);
  });

  it("throws SessionNotFoundError for a well-formed id with no session on disk", async () => {
    await expect(
      appendCommandsLogEntry({ repoRoot, sessionId: OLDER_ID, at: AT, cwd: ".", argv: ["x"] }),
    ).rejects.toThrow(SessionNotFoundError);
  });

  it("rejects non-UTC, non-second-precision, and impossible-calendar timestamps", async () => {
    await startRealSession(NEWER_ID);
    const badTimestamps = [
      "2026-05-04T11:00:00+02:00", // offset form -- UTC Z only
      "2026-05-04T11:00:00.123Z", // millisecond precision
      "2026-05-04 11:00:00Z", // missing T
      "2026-02-31T10:00:00Z", // impossible calendar date (Date.parse would normalize)
      "not-a-date",
    ];
    for (const at of badTimestamps) {
      await expect(
        appendCommandsLogEntry({ repoRoot, sessionId: NEWER_ID, at, cwd: ".", argv: ["x"] }),
        at,
      ).rejects.toThrow(TypeError);
    }
  });

  it("rejects non-normalized or non-repo-relative cwd values", async () => {
    await startRealSession(NEWER_ID);
    const badCwds = [
      "",
      "/abs",
      "C:/x",
      "a\\b",
      "foo//bar",
      "./foo",
      "foo/",
      "foo/./bar",
      "foo/../bar",
      "..",
    ];
    for (const cwd of badCwds) {
      await expect(
        appendCommandsLogEntry({ repoRoot, sessionId: NEWER_ID, at: AT, cwd, argv: ["x"] }),
        JSON.stringify(cwd),
      ).rejects.toThrow(TypeError);
    }
  });

  it("rejects empty argv, non-string entries, and an empty command name", async () => {
    await startRealSession(NEWER_ID);
    const badArgvs: readonly (readonly unknown[])[] = [[], ["", "x"], ["ok", 42]];
    for (const argv of badArgvs) {
      await expect(
        appendCommandsLogEntry({
          repoRoot,
          sessionId: NEWER_ID,
          at: AT,
          cwd: ".",
          argv: argv as readonly string[],
        }),
        JSON.stringify(argv),
      ).rejects.toThrow(TypeError);
    }
  });

  it("rejects argv when it is not an array", async () => {
    await startRealSession(NEWER_ID);
    await expect(
      appendCommandsLogEntry({
        repoRoot,
        sessionId: NEWER_ID,
        at: AT,
        cwd: ".",
        argv: "not-an-array" as unknown as readonly string[],
      }),
    ).rejects.toThrow(TypeError);
  });

  it("refuses when commands.log is missing (deletion after startSession is corruption)", async () => {
    await startRealSession(NEWER_ID);
    await rm(logPathAbs(NEWER_ID));
    await expect(
      appendCommandsLogEntry({ repoRoot, sessionId: NEWER_ID, at: AT, cwd: ".", argv: ["x"] }),
    ).rejects.toThrow(); // lstat ENOENT propagates
  });

  it("refuses when commands.log is not a regular file (directory in its place)", async () => {
    await startRealSession(NEWER_ID);
    await rm(logPathAbs(NEWER_ID));
    await mkdir(logPathAbs(NEWER_ID));
    await expect(
      appendCommandsLogEntry({ repoRoot, sessionId: NEWER_ID, at: AT, cwd: ".", argv: ["x"] }),
    ).rejects.toThrow(/existing regular file/);
  });

  it.runIf(process.platform !== "win32")("refuses when commands.log is a symlink", async () => {
    // THE lstat-vs-stat proof: with stat, a symlink to a regular file
    // would pass isFile() and be silently followed. lstat sees the link.
    await startRealSession(NEWER_ID);
    await rm(logPathAbs(NEWER_ID));

    const target = join(repoRoot, "outside-commands.log");
    await writeFile(target, "", "utf8");
    await symlink(target, logPathAbs(NEWER_ID));

    await expect(
      appendCommandsLogEntry({ repoRoot, sessionId: NEWER_ID, at: AT, cwd: ".", argv: ["x"] }),
    ).rejects.toThrow(/existing regular file/);
  });
});

// =============================================================================
// agentCommand threading (M G2)
// =============================================================================

describe("startSession agent_command persistence (M G2 threading target)", () => {
  it("persists agent_command in session.json when agentCommand is provided", async () => {
    const tmpDir = await makeTmpSessionDir(NEWER_ID);
    await startSession({
      repoRoot,
      tmpSessionDir: tmpDir,
      sessionId: NEWER_ID,
      checkpointId: CHECKPOINT_ID,
      startedAt: NEWER_TS,
      beforeStatusText: " M src/foo.ts\n",
      agentCommand: "claude --dangerously-skip-permissions",
    });
    const raw = await readFile(
      join(repoRoot, ".viberevert", "sessions", NEWER_ID, "session.json"),
      "utf8",
    );
    const session = SessionStateSchema.parse(JSON.parse(raw));
    expect(session.agent_command).toBe("claude --dangerously-skip-permissions");
  });
});
