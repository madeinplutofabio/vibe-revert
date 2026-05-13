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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  type ActiveSessionLock,
  type SessionState,
  SESSION_STATE_SCHEMA_VERSION,
  SessionStateSchema,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EndCommand } from "../src/commands/end.js";

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
  // getStatusPorcelainText, which needs a real .git/ dir.
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: tmpRoot });
  // Mirror what M A's init does: add `.viberevert/` to .gitignore so
  // session-state writes don't show up in `git status`. Tests that
  // assert on after-status content can then make precise assertions.
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
  await writeFile(
    join(sessionDir, "session.json"),
    JSON.stringify(sessionState, null, 2),
  );
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
    await expect(
      stat(join(tmpRoot, ".viberevert", "active-session.json")),
    ).rejects.toThrow();

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
    expect(session.after_status_path).toBe(
      `.viberevert/sessions/${SESSION_ID}/after-status.txt`,
    );
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
