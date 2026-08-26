// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for cli command implementations:
//   - viberevert end (this file, 5d-1)
//   - viberevert start (added in 5f)
//
// Both commands operate on session state, so test setup (mkdtemp +
// git init + .gitignore) is shared. Each command gets its own
// `describe` block. Both share `beforeEach` / `afterEach` and the
// `setupActiveSession` fixture where an existing active session is needed.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { createCheckpoint } from "@viberevert/git";
import {
  type ActiveSessionLock,
  ManifestSchema,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
  SessionStateSchema,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EndCommand } from "../src/commands/end.js";
import { StartCommand } from "../src/commands/start.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

const execFileAsync = promisify(execFile);

// Crockford-base32 ULID (no I, L, O, U) — same fixture pattern as
// packages/core/test/session.test.ts.
//
// There is deliberately NO fixture checkpoint-id constant. Checkpoint
// identity is produced by `createCheckpoint` and returned to its caller;
// inventing one here would describe a session that `viberevert start`
// cannot produce. See `setupActiveSession`.
const SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const STARTED_AT = "2026-05-04T10:30:11Z";

/**
 * D49 fixture-determinism sentinel. Tests that need to prove
 * `VIBEREVERT_TEST_FIXED_NOW` affects persisted timestamps set
 * `process.env.VIBEREVERT_TEST_FIXED_NOW = FIXED_NOW` per-test
 * (with restore-over-delete in `finally`) and assert exact equality
 * on the resulting persisted artifacts. Distinct from `STARTED_AT`
 * (which is a fixture-setup constant used by `setupActiveSession`).
 * Same value the M C golden-fixture harness will use in Step 10.
 */
const FIXED_NOW = "2026-01-01T00:00:00Z";

/**
 * D5/D11 display truncation: prefix plus 14 characters. `cp_` is three,
 * so a truncated checkpoint id is 17 characters.
 */
const CHECKPOINT_ID_DISPLAY_LENGTH = 17;

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cli-end-"));
  originalCwd = process.cwd();
  // Real git repo: both start and end now exercise git-backed operations.
  // Start creates the owning checkpoint; end reconstructs that checkpoint
  // through the contribution-capture oracle. Both therefore require a real
  // repository, and checkpoint creation requires a valid HEAD.
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: tmpRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.test",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
    { cwd: tmpRoot },
  );
  // These tests bypass `viberevert init` and write `.viberevert.yml` and
  // session-state files directly, so we manually set up the `.gitignore`
  // state init would have created. Required so session-state writes don't
  // show up in `git status` and tests that assert on after-status content
  // can make precise assertions.
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  process.chdir(tmpRoot);
});

afterEach(async () => {
  // Restore CWD before cleanup so rm doesn't fail on Windows file
  // locks (same pattern as init.test.ts).
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Set up an in-flight session on disk, bypassing core.startSession.
 *
 * The session-state files are written directly, but the inner checkpoint
 * is REAL, created through `git.createCheckpoint` exactly as
 * `startSessionOperation` does.
 *
 * **Why real, as of M 0.8.0 step 4c.** This helper previously created an
 * empty `checkpoint/` subdir and documented its contents as irrelevant,
 * because `end` only needed the active lock and `session.json` to parse.
 * That is no longer the contract: `endSessionOperation` reconstructs the
 * owning checkpoint into a disposable worktree to capture the session's
 * contribution. An empty dir makes it refuse with `CheckpointNotFoundError`
 * ("manifest.json not found"), so a fixture without a real checkpoint no
 * longer describes a session that can end.
 *
 * **Checkpoint identity comes from `createCheckpoint`, never from a
 * constant.** `createCheckpoint` generates the id and returns it; that
 * returned value is what `startSessionOperation` writes into
 * `session.json` and the active lock, so this helper does the same. The
 * manifest itself records only `session_id`; the generated checkpoint id is
 * persisted in `session.json` and `active-session.json`, which is why the id
 * is returned here for tests that assert on how it is displayed.
 *
 * A fixture-supplied checkpoint id would describe a session `viberevert
 * start` cannot produce, so the parameter does not exist.
 *
 * `capturedAt` is pinned to `opts.startedAt` so the fixture reads no
 * clock: the checkpoint is taken, in fiction, at session start.
 */
async function setupActiveSession(opts: {
  sessionId: string;
  startedAt: string;
  task?: string;
}): Promise<{ checkpointId: string }> {
  const sessionDir = join(tmpRoot, ".viberevert", "sessions", opts.sessionId);
  await mkdir(sessionDir, { recursive: true });

  // Mirrors startSessionOperation: the session dir exists, and
  // createCheckpoint owns the `checkpoint/` subdir beneath it.
  const { checkpointId } = await createCheckpoint({
    repoRoot: tmpRoot,
    checkpointDir: join(sessionDir, "checkpoint"),
    rollbackExcludePatterns: [],
    sessionId: opts.sessionId,
    capturedAt: opts.startedAt,
  });

  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: opts.sessionId,
    checkpoint_id: checkpointId,
    started_at: opts.startedAt,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    before_status_path: `.viberevert/sessions/${opts.sessionId}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${opts.sessionId}/commands.log`,
  };
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState, null, 2));
  await writeFile(join(sessionDir, "before-status.txt"), "");
  await writeFile(join(sessionDir, "commands.log"), "");

  const lock: ActiveSessionLock = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: opts.sessionId,
    checkpoint_id: checkpointId,
    started_at: opts.startedAt,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
  };
  await writeFile(
    join(tmpRoot, ".viberevert", "active-session.json"),
    JSON.stringify(lock, null, 2),
  );

  return { checkpointId };
}

/**
 * Run `viberevert end` via a clipanion Cli instance with captured
 * stdout/stderr. Same harness pattern as init.test.ts — see the
 * comments there for why we use real PassThrough/Writable streams
 * (avoids structural casts on context).
 *
 * Note on streams: clipanion 3.2.1 writes UNCAUGHT command errors to
 * `stdout`, not `stderr`. A command that throws therefore surfaces here
 * as exit 1 with an empty `stderr` and a stack trace in `stdout`. Assert
 * on `stderr` only for refusals the command writes deliberately.
 */
async function runEnd(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(EndCommand);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = false;

  const stdoutStub = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      callback();
    },
  });

  const stderrStub = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      callback();
    },
  });

  const exitCode = await cli.run(["end", ...args], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

/**
 * Write a minimal valid `.viberevert.yml` to tmpRoot. Same as
 * checkpoint.test.ts's helper — only `version: 1` is required by
 * ConfigSchema; all other fields are optional, producing an empty
 * `rollback.exclude` list.
 */
async function writeMinimalConfig(): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
}

/**
 * Run `viberevert start` via a clipanion Cli instance with captured
 * stdout/stderr. Same harness pattern as runEnd above; inlined for
 * symmetry with the existing `runEnd` shape in this file (a generic
 * runCommand factor-out is reserved for a future post-M B cleanup
 * pass that consolidates patterns across all CLI test files).
 */
async function runStart(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(StartCommand);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = false;

  const stdoutStub = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      callback();
    },
  });

  const stderrStub = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      callback();
    },
  });

  const exitCode = await cli.run(["start", ...args], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

describe("end command", () => {
  it("happy path: ends active session, writes after-status.txt, mutates session.json, deletes lock", async () => {
    const { checkpointId } = await setupActiveSession({
      sessionId: SESSION_ID,
      startedAt: STARTED_AT,
      task: "Add yearly billing",
    });

    const result = await runEnd([]);
    expect(result.exitCode).toBe(0);

    // Success summary
    expect(result.stdout).toContain("Session ended.");
    expect(result.stdout).toContain(`ID: ${SESSION_ID}`);
    expect(result.stdout).toContain("Task: Add yearly billing");
    expect(result.stdout).toContain(`Started: ${STARTED_AT}`);
    // Locks the second-precision ISO format produced by
    // endSessionOperation (operation architectural lock #3 and
    // session.ts architectural lock #2). Exact value isn't
    // load-bearing — the format contract is.
    expect(result.stdout).toMatch(/Ended: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);

    // Active lock deleted
    await expect(stat(join(tmpRoot, ".viberevert", "active-session.json"))).rejects.toThrow();

    // session.json mutated and re-validates against schema
    const session = SessionStateSchema.parse(
      JSON.parse(
        await readFile(
          join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "session.json"),
          "utf8",
        ),
      ),
    );
    expect(session.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(session.after_status_path).toBe(`.viberevert/sessions/${SESSION_ID}/after-status.txt`);
    // Pre-existing fields preserved
    expect(session.session_id).toBe(SESSION_ID);
    expect(session.checkpoint_id).toBe(checkpointId);
    expect(session.started_at).toBe(STARTED_AT);
    expect(session.task).toBe("Add yearly billing");

    // after-status.txt exists and is readable
    const afterStatus = await readFile(
      join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "after-status.txt"),
      "utf8",
    );
    expect(typeof afterStatus).toBe("string");
  });

  it("captures `git status --porcelain=v1` text into after-status.txt", async () => {
    await setupActiveSession({
      sessionId: SESSION_ID,
      startedAt: STARTED_AT,
    });

    // Create an untracked file so git status reports it distinctively.
    // beforeEach already gitignored .viberevert/, so the only
    // unexpected entries in the porcelain output are .gitignore (also
    // untracked) and untracked.txt.
    await writeFile(join(tmpRoot, "untracked.txt"), "hello");

    const result = await runEnd([]);
    expect(result.exitCode).toBe(0);

    const afterStatus = await readFile(
      join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "after-status.txt"),
      "utf8",
    );
    // git status --porcelain=v1 emits "?? <path>" for untracked files.
    expect(afterStatus).toContain("?? untracked.txt");
  });

  it("refuses with exit 1 when no active-session.json exists", async () => {
    // beforeEach's `git init` already created .git/ in tmpRoot, so
    // resolveRepoRoot finds tmpRoot as the repo root. With no
    // active-session.json present, loadActiveSessionLock returns null
    // and end.ts prints the "no active session" refusal.
    const result = await runEnd([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No active session in this repo.");
    expect(result.stderr).toContain("viberevert start");
    // M B's refusal copy MUST NOT name commands deferred to M D —
    // locks the D7/D10/D11 invariant. (The "session already active"
    // refusal in start.ts has the same constraint per the plan.)
    expect(result.stderr).not.toContain("viberevert rollback");
  });

  it("VIBEREVERT_TEST_FIXED_NOW overrides session.json.ended_at deterministically (D49 precondition)", async () => {
    await setupActiveSession({
      sessionId: SESSION_ID,
      startedAt: STARTED_AT,
      task: "deterministic test",
    });

    // Per-test scoped env mutation with restore-over-delete in
    // finally. The capture+restore pattern is safe even if a parent
    // process already set VIBEREVERT_TEST_FIXED_NOW (e.g., when the
    // whole test file runs under a CI harness that pins it
    // globally) — we restore to that value rather than deleting.
    const previous = process.env[VIBEREVERT_TEST_FIXED_NOW];
    process.env[VIBEREVERT_TEST_FIXED_NOW] = FIXED_NOW;
    try {
      const result = await runEnd([]);
      expect(result.exitCode).toBe(0);
      // Success-summary "Ended:" line reflects the override value
      // verbatim — same resolver path the persisted file goes through.
      expect(result.stdout).toContain(`Ended: ${FIXED_NOW}`);

      // Primary contract: session.json.ended_at equals the fixed
      // sentinel byte-for-byte (NOT just second-precision-shaped).
      const session = SessionStateSchema.parse(
        JSON.parse(
          await readFile(
            join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "session.json"),
            "utf8",
          ),
        ),
      );
      expect(session.ended_at).toBe(FIXED_NOW);
      // Sanity: started_at is the fixture-setup value, NOT the
      // sentinel (fixed-now only affects timestamps the CLI
      // generates this invocation; pre-existing fields are
      // preserved verbatim).
      expect(session.started_at).toBe(STARTED_AT);
    } finally {
      if (previous === undefined) {
        delete process.env[VIBEREVERT_TEST_FIXED_NOW];
      } else {
        process.env[VIBEREVERT_TEST_FIXED_NOW] = previous;
      }
    }
  });

  // The RepoRootNotFoundError path in end.ts is intentionally not
  // tested end-to-end here. Triggering it requires a temp directory
  // with no `.git`/`.viberevert.yml` in any parent up to the
  // filesystem root — fragile across dev machines (a user's home dir
  // dotfiles repo would invalidate the test). The catch block in
  // end.ts is 5 lines of straightforward defensive code; code review
  // covers it.
});

describe("start command", () => {
  it("happy path nameless: creates session, exit 0, writes session.json + active lock, no Task: line in output", async () => {
    await writeMinimalConfig();

    const result = await runStart([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Session started.");
    expect(result.stdout).toMatch(/ID: sess_[0-9A-HJKMNP-TV-Z]{26}/);
    expect(result.stdout).toMatch(/Checkpoint: cp_[0-9A-HJKMNP-TV-Z]{26}/);
    expect(result.stdout).toMatch(/Started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    // No Task: line for nameless start
    expect(result.stdout).not.toContain("Task:");

    // active-session.json exists and validates as ActiveSessionLock
    const lockRaw = await readFile(join(tmpRoot, ".viberevert", "active-session.json"), "utf8");
    const lock: ActiveSessionLock = JSON.parse(lockRaw);
    expect(lock.session_id).toMatch(/^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(lock.checkpoint_id).toMatch(/^cp_[0-9A-HJKMNP-TV-Z]{26}$/);

    // Session dir exists with valid session.json (in-flight: no ended_at)
    const sessionsDir = join(tmpRoot, ".viberevert", "sessions");
    const entries = await readdir(sessionsDir);
    const sessionDirs = entries.filter((e) => /^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(e));
    expect(sessionDirs).toHaveLength(1);
    const sessionId = sessionDirs[0];
    if (sessionId === undefined) {
      throw new Error("test bug: sessionDirs[0] undefined despite length check");
    }
    expect(sessionId).toBe(lock.session_id);

    const session = SessionStateSchema.parse(
      JSON.parse(await readFile(join(sessionsDir, sessionId, "session.json"), "utf8")),
    );
    expect(session.session_id).toBe(sessionId);
    expect(session.checkpoint_id).toBe(lock.checkpoint_id);
    expect(session.ended_at).toBeUndefined();
    expect(session.task).toBeUndefined();

    // No leftover .tmp-sess_* dir
    const tmpEntries = entries.filter((e) => e.startsWith(".tmp-"));
    expect(tmpEntries).toEqual([]);
  });

  it("happy path with --task: stores task in session.json and active lock, prints Task: line", async () => {
    await writeMinimalConfig();

    const result = await runStart(["--task", "Add yearly billing"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Task: Add yearly billing");

    const lock: ActiveSessionLock = JSON.parse(
      await readFile(join(tmpRoot, ".viberevert", "active-session.json"), "utf8"),
    );
    expect(lock.task).toBe("Add yearly billing");

    const sessionsDir = join(tmpRoot, ".viberevert", "sessions");
    const sessionDirs = (await readdir(sessionsDir)).filter((e) =>
      /^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(e),
    );
    const sessionId = sessionDirs[0];
    if (sessionId === undefined) {
      throw new Error("test bug: no session dir");
    }
    const session = SessionStateSchema.parse(
      JSON.parse(await readFile(join(sessionsDir, sessionId, "session.json"), "utf8")),
    );
    expect(session.task).toBe("Add yearly billing");
  });

  it("refuses with exit 1 when .viberevert.yml is missing (D19)", async () => {
    // No writeMinimalConfig — let loadConfig throw ConfigNotFoundError.
    const result = await runStart([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No .viberevert.yml found in this repo.");
    expect(result.stderr).toContain("viberevert init");
    // No session dir or active lock should have been created.
    const vibeDir = join(tmpRoot, ".viberevert");
    await expect(stat(vibeDir)).rejects.toThrow();
  });

  it("refuses BEFORE creating any new checkpoint/temp dir when a session is already active (D11 + architectural-lock-#4)", async () => {
    await writeMinimalConfig();
    // Pre-existing active session
    const { checkpointId } = await setupActiveSession({
      sessionId: SESSION_ID,
      startedAt: STARTED_AT,
      task: "first attempt",
    });

    const result = await runStart(["--task", "second attempt"]);
    expect(result.exitCode).toBe(1);

    // D11 locked refusal copy
    expect(result.stderr).toContain("A session is already active in this repo.");
    expect(result.stderr).toContain("Session:");
    expect(result.stderr).toContain("Checkpoint:");
    expect(result.stderr).toContain("Task:");
    expect(result.stderr).toContain("first attempt");
    // Truncated IDs (D11 example uses prefix + 14 chars per D5).
    // The checkpoint side is derived from the id createCheckpoint
    // actually generated, so this pins truncation of the real
    // checkpoint identity rather than of a fixture constant.
    expect(result.stderr).toContain("sess_01JV8Z0N6E7ABC");
    expect(result.stderr).toContain(checkpointId.slice(0, CHECKPOINT_ID_DISPLAY_LENGTH));
    // Full IDs MUST NOT leak (truncation contract)
    expect(result.stderr).not.toContain(SESSION_ID);
    expect(result.stderr).not.toContain(checkpointId);
    // "Use:" footer per D74 unlock (M D Step 7): names the M B
    // state-machine exit (viberevert end) AND the M D discard
    // sequence (viberevert end && viberevert rollback <session>).
    expect(result.stderr).toContain("viberevert sessions");
    expect(result.stderr).toContain("viberevert end");
    // D74-unlocked: M D rollback IS named (previously D11 forbade
    // it). The `end && rollback` compound is explicitly locked to
    // honor D63's state-machine invariant — a session must be
    // ended before rollback, so a bare `viberevert rollback
    // <sess>` would refuse on the active session. The
    // `viberevert end &&` assertion locks the SEQUENCING wording,
    // not just rollback's presence.
    expect(result.stderr).toContain("viberevert rollback");
    expect(result.stderr).toContain("viberevert end &&");

    // CRITICAL ASSERTION (architectural lock #4 in start.ts): the
    // pre-check happens BEFORE any expensive work. After refusal,
    // .viberevert/sessions/ should contain EXACTLY the pre-existing
    // session dir — no new sess_*, no .tmp-sess_*. If start.ts
    // regressed to the wrong order (createCheckpoint before active-
    // lock check), this assertion would fail with extra entries.
    const sessionsDir = join(tmpRoot, ".viberevert", "sessions");
    const entries = await readdir(sessionsDir);
    expect(entries).toEqual([SESSION_ID]);

    // Same property for checkpoints/: never written to. start.ts
    // writes inner-session checkpoints inside the session tmp dir,
    // not directly into .viberevert/checkpoints/, so this dir should
    // not exist at all. The fixture's own checkpoint likewise lives
    // under its session dir, so it cannot satisfy this by accident.
    const checkpointsDir = join(tmpRoot, ".viberevert", "checkpoints");
    await expect(stat(checkpointsDir)).rejects.toThrow();
  });

  it("refuses with exit 1 when --task is whitespace-only (defensive validation)", async () => {
    // No config needed — --task validation runs BEFORE loadConfig.
    const result = await runStart(["--task", "   "]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--task must not be empty or whitespace-only");
  });

  it("VIBEREVERT_TEST_FIXED_NOW overrides session, active-lock, AND inner-checkpoint timestamps deterministically (D49 precondition)", async () => {
    await writeMinimalConfig();

    const previous = process.env[VIBEREVERT_TEST_FIXED_NOW];
    process.env[VIBEREVERT_TEST_FIXED_NOW] = FIXED_NOW;
    try {
      const result = await runStart(["--task", "deterministic test"]);
      expect(result.exitCode).toBe(0);
      // Success-summary "Started:" line reflects the override
      // verbatim — same resolver path the persisted files go through.
      expect(result.stdout).toContain(`Started: ${FIXED_NOW}`);

      // Find the just-created session dir (id is random per-call
      // — only the timestamp is pinned by VIBEREVERT_TEST_FIXED_NOW;
      // ULID generation is independent per D49's separate
      // VIBEREVERT_TEST_FIXED_ULID_SEED knob, which this test does
      // NOT set).
      const sessionsDir = join(tmpRoot, ".viberevert", "sessions");
      const sessionDirs = (await readdir(sessionsDir)).filter((e) =>
        /^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(e),
      );
      expect(sessionDirs).toHaveLength(1);
      const sessionId = sessionDirs[0];
      if (sessionId === undefined) {
        throw new Error("test bug: sessionDirs[0] undefined despite length check");
      }

      // Contract 1: active-session.json.started_at = FIXED_NOW.
      const lock: ActiveSessionLock = JSON.parse(
        await readFile(join(tmpRoot, ".viberevert", "active-session.json"), "utf8"),
      );
      expect(lock.started_at).toBe(FIXED_NOW);

      // Contract 2: session.json.started_at = FIXED_NOW.
      const session = SessionStateSchema.parse(
        JSON.parse(await readFile(join(sessionsDir, sessionId, "session.json"), "utf8")),
      );
      expect(session.started_at).toBe(FIXED_NOW);

      // Contract 3: inner-session checkpoint manifest.captured_at
      // = FIXED_NOW. THIS is the trust-critical assertion for the
      // M C precondition — checkpoint-base ad-hoc reports source
      // report.started_at from this manifest's captured_at value
      // per D31/D56, so Step 10 golden fixtures depend on this
      // being byte-deterministic. If this assertion regresses,
      // session-bound report fixtures will silently drift.
      //
      // Parsed via ManifestSchema (NOT a minimal cast) so the test
      // doubles as a schema-validity check on the just-written
      // manifest — catches regressions where the CLI threading
      // `capturedAt: now` could (in some future bug) produce a
      // manifest broken in OTHER fields entirely.
      const manifestRaw = await readFile(
        join(sessionsDir, sessionId, "checkpoint", "manifest.json"),
        "utf8",
      );
      const manifest = ManifestSchema.parse(JSON.parse(manifestRaw));
      expect(manifest.captured_at).toBe(FIXED_NOW);
    } finally {
      if (previous === undefined) {
        delete process.env[VIBEREVERT_TEST_FIXED_NOW];
      } else {
        process.env[VIBEREVERT_TEST_FIXED_NOW] = previous;
      }
    }
  });
});
