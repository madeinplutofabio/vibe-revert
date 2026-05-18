// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for cli command implementations:
//   - viberevert end (this file, 5d-1)
//   - viberevert start (added in 5f)
//
// Both commands operate on session state, so test setup (mkdtemp +
// git init + .gitignore) is shared. Each command gets its own
// `describe` block. The 5f addition will share `beforeEach`/`afterEach`
// + the `setupActiveSession` helper unchanged.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  type ActiveSessionLock,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
  SessionStateSchema,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EndCommand } from "../src/commands/end.js";
import { StartCommand } from "../src/commands/start.js";

const execFileAsync = promisify(execFile);

// Crockford-base32 ULIDs (no I, L, O, U) — same fixture pattern as
// packages/core/test/session.test.ts.
const SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const STARTED_AT = "2026-05-04T10:30:11Z";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cli-end-"));
  originalCwd = process.cwd();
  // Real git repo: end.ts shells out via @viberevert/git's
  // getStatusPorcelainText, which needs a real .git/ dir. Start tests
  // additionally call createCheckpoint which calls getHeadSha — that
  // requires HEAD to point somewhere, so we make an initial empty
  // commit. End tests don't need the commit but it doesn't affect them.
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
 * Set up an in-flight session by writing session-state files directly
 * to disk, bypassing core.startSession + git.createCheckpoint. The
 * goal is test isolation: end.ts only depends on
 *   - .viberevert/active-session.json existing and parsing
 *   - .viberevert/sessions/<id>/session.json existing and parsing
 *   - the session.json's session_id matching the dir name
 * It does NOT depend on the inner checkpoint dir's contents (git's
 * domain), so we just create an empty checkpoint/ subdir.
 */
async function setupActiveSession(opts: {
  sessionId: string;
  checkpointId: string;
  startedAt: string;
  task?: string;
}): Promise<void> {
  const sessionDir = join(tmpRoot, ".viberevert", "sessions", opts.sessionId);
  await mkdir(join(sessionDir, "checkpoint"), { recursive: true });

  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: opts.sessionId,
    checkpoint_id: opts.checkpointId,
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
    checkpoint_id: opts.checkpointId,
    started_at: opts.startedAt,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
  };
  await writeFile(
    join(tmpRoot, ".viberevert", "active-session.json"),
    JSON.stringify(lock, null, 2),
  );
}

/**
 * Run `viberevert end` via a clipanion Cli instance with captured
 * stdout/stderr. Same harness pattern as init.test.ts — see the
 * comments there for why we use real PassThrough/Writable streams
 * (avoids structural casts on context).
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
    await setupActiveSession({
      sessionId: SESSION_ID,
      checkpointId: CHECKPOINT_ID,
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
    // Locks the second-precision ISO format from end.ts step 4
    // (and session.ts architectural lock #2). Exact value isn't
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
      checkpointId: CHECKPOINT_ID,
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
    await setupActiveSession({
      sessionId: SESSION_ID,
      checkpointId: CHECKPOINT_ID,
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
    // Truncated IDs (D11 example uses prefix + 14 chars per D5)
    expect(result.stderr).toContain("sess_01JV8Z0N6E7ABC");
    expect(result.stderr).toContain("cp_01JV8Y7W2M7ABC");
    // Full IDs MUST NOT leak (truncation contract)
    expect(result.stderr).not.toContain(SESSION_ID);
    expect(result.stderr).not.toContain(CHECKPOINT_ID);
    // "Use:" footer with M B-only commands
    expect(result.stderr).toContain("viberevert sessions");
    expect(result.stderr).toContain("viberevert end");
    // M D commands MUST NOT be named (D7/D10/D11)
    expect(result.stderr).not.toContain("viberevert rollback");

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
    // not exist at all.
    const checkpointsDir = join(tmpRoot, ".viberevert", "checkpoints");
    await expect(stat(checkpointsDir)).rejects.toThrow();
  });

  it("refuses with exit 1 when --task is whitespace-only (defensive validation)", async () => {
    // No config needed — --task validation runs BEFORE loadConfig.
    const result = await runStart(["--task", "   "]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--task must not be empty or whitespace-only");
  });
});
