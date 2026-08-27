// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Presentation contracts for `viberevert shell`'s scoped teardown
// (M 0.8.0 step 4c, Slice C).
//
// MOCK-FOCUSED BY DESIGN, same convention as end-presentation.test.ts and
// run-presentation.test.ts: module mocking is file-scoped, so it ships
// separately rather than contaminating shell-command.test.ts's behavioral
// integration matrix.
//
// MOCKED (five functions, each via `importOriginal` so siblings stay real):
//   @viberevert/core        resolveRepoRoot, loadConfig, loadActiveSessionLock
//   operations/start-session  startSessionOperation
//   operations/end-session    endSessionOperation
//
// REAL: ShellCommand itself, the REPL loop, and every error CLASS — a
// mocked class would let these pass even if shell.ts dispatched on the
// wrong type, which is exactly what is under test.
//
// Every test drives the REPL with immediate EOF (zero commands). That is
// the shortest path to `scopedTeardown`, which is the only region step 4c
// changed: no child spawns, no commands.log append, no guard evaluation.
// shell-command.test.ts already owns the command-loop behavior.

import { PassThrough, Writable } from "node:stream";
import {
  type Config,
  loadActiveSessionLock,
  loadConfig,
  NoActiveSessionError,
  resolveRepoRoot,
} from "@viberevert/core";
import { EndStateChangedDuringCaptureError } from "@viberevert/git";
import { SESSION_STATE_SCHEMA_VERSION } from "@viberevert/session-format";
import { Cli } from "clipanion";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShellCommand } from "../src/commands/shell.js";
import { ConcurrentOperationError, formatConcurrentOperationRefusal } from "../src/locks.js";
import { EndSessionRaceError, endSessionOperation } from "../src/operations/end-session.js";
import { START_LOCK_REL, startSessionOperation } from "../src/operations/start-session.js";

vi.mock("@viberevert/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@viberevert/core")>();
  return {
    ...actual,
    resolveRepoRoot: vi.fn(),
    loadConfig: vi.fn(),
    loadActiveSessionLock: vi.fn(),
  };
});

vi.mock("../src/operations/start-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/start-session.js")>();
  return { ...actual, startSessionOperation: vi.fn() };
});

vi.mock("../src/operations/end-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/end-session.js")>();
  return { ...actual, endSessionOperation: vi.fn() };
});

const SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const STARTED_AT = "2026-05-04T10:30:11Z";
const ENDED_AT = "2026-05-04T11:00:00Z";
const LOCK_DIR = "/repo/.viberevert/.locks/start.lock";

const WARNING_A = "git worktree remove --force failed for /tmp/vr-x/worktree: EBUSY";
const WARNING_B = "rm -rf /tmp/vr-x failed: EBUSY";

/** Only `version` is required by ConfigSchema. */
const MINIMAL_CONFIG = { version: 1 } as Config;

const STARTED = {
  sessionId: SESSION_ID,
  checkpointId: CHECKPOINT_ID,
  startedAt: STARTED_AT,
};

/** The active lock scopedTeardown re-reads: present AND ours. */
const OUR_LOCK = {
  schema_version: SESSION_STATE_SCHEMA_VERSION,
  session_id: SESSION_ID,
  checkpoint_id: CHECKPOINT_ID,
  started_at: STARTED_AT,
};

const CLEAN_END = {
  sessionId: SESSION_ID,
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  cleanupWarnings: [] as readonly string[],
};

beforeEach(() => {
  vi.mocked(resolveRepoRoot).mockReset().mockReturnValue(process.cwd());
  vi.mocked(loadConfig).mockReset().mockResolvedValue(MINIMAL_CONFIG);
  vi.mocked(loadActiveSessionLock).mockReset().mockResolvedValue(OUR_LOCK);
  vi.mocked(startSessionOperation).mockReset().mockResolvedValue(STARTED);
  vi.mocked(endSessionOperation).mockReset().mockResolvedValue(CLEAN_END);
});

/**
 * Drive the real ShellCommand with immediate EOF, so the REPL reads zero
 * commands and falls straight through to scopedTeardown.
 */
async function runShell(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(ShellCommand);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = false;
  stdinStub.end();

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

  const exitCode = await cli.run(["shell"], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

// =============================================================================
// Cleanup warnings
// =============================================================================

describe("shell: cleanup warnings", () => {
  it("surfaces warnings in order, immediately before the summary, keeping exit 0", async () => {
    vi.mocked(endSessionOperation).mockResolvedValue({
      ...CLEAN_END,
      cleanupWarnings: [WARNING_A, WARNING_B],
    });

    const result = await runShell();

    // Non-fatal: the session WAS ended; only its scratch state outlived it.
    expect(result.exitCode).toBe(0);

    const firstAt = result.stderr.indexOf(`warning: ${WARNING_A}`);
    const secondAt = result.stderr.indexOf(`warning: ${WARNING_B}`);
    const summaryAt = result.stderr.indexOf(`Session: ${SESSION_ID}`);
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(firstAt).toBeLessThan(secondAt);
    expect(secondAt).toBeLessThan(summaryAt);
    expect(result.stderr).toContain(`Next: viberevert check --since ${SESSION_ID}`);
  });

  it("emits nothing extra when there are no warnings", async () => {
    const result = await runShell();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("warning: ");
    expect(result.stderr).toContain(`Session: ${SESSION_ID}`);
    expect(result.stderr).toContain(`Next: viberevert check --since ${SESSION_ID}`);
  });
});

// =============================================================================
// Teardown failures
// =============================================================================

describe("shell: teardown failures", () => {
  it("fence refusal gets retry copy and leaks no changed-member names", async () => {
    const err = new EndStateChangedDuringCaptureError(3, [
      "afterHeadSha",
      "trackedStatus",
      "rawInventory",
    ]);
    vi.mocked(endSessionOperation).mockRejectedValue(err);

    const result = await runShell();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "The session could not be closed because the project kept changing during capture.",
    );
    expect(result.stderr).toContain(
      "Stop other writers or background processes changing the repo, then close it manually with:",
    );
    expect(result.stderr).toContain("viberevert end");

    // Same privacy contract end.ts and run.ts apply.
    expect(result.stderr).not.toContain(err.message);
    expect(result.stderr).not.toContain("afterHeadSha");
    expect(result.stderr).not.toContain("trackedStatus");
    expect(result.stderr).not.toContain("rawInventory");

    // A failed close must not print a summary implying success.
    expect(result.stderr).not.toContain(`Session: ${SESSION_ID}`);
  });

  it("NoActiveSessionError stays a SUCCESS: already-ended note, summary, exit 0", async () => {
    vi.mocked(endSessionOperation).mockRejectedValue(new NoActiveSessionError());

    const result = await runShell();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "Note: the session was already ended before the shell could close it.",
    );
    // The id is still known, so the summary still prints.
    expect(result.stderr).toContain(`Session: ${SESSION_ID}`);
    expect(result.stderr).not.toContain("could not be closed");
  });

  it("EndSessionRaceError is an end FAILURE, never an already-ended session", async () => {
    vi.mocked(endSessionOperation).mockRejectedValue(new EndSessionRaceError());

    const result = await runShell();

    // Since step 4c the lifecycle lock refuses a competing `end` at
    // acquisition, so this class means active-session.json vanished out of
    // protocol with NO terminal state published. Reporting a successful
    // close would be false.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The session could not be closed:");
    expect(result.stderr).toContain("Close it manually with:");
    // The pre-4c assumption must not creep back in.
    expect(result.stderr).not.toContain("already ended before the shell could close it");
    expect(result.stderr).not.toContain(`Session: ${SESSION_ID}`);
  });
});

// =============================================================================
// Start-path lock contention
// =============================================================================

describe("shell: start contention", () => {
  it("renders EXACTLY the canonical D22 formatter output, not a duplicated literal", async () => {
    const info = {
      pid: 4242,
      command: "viberevert shell",
      started_at: "2026-07-01T00:00:00Z",
      host: "testhost",
    };
    vi.mocked(startSessionOperation).mockRejectedValue(
      new ConcurrentOperationError(LOCK_DIR, info),
    );

    const result = await runShell();

    expect(result.exitCode).toBe(1);
    // Compared against the formatter itself, never a copied literal, so this
    // caller cannot drift from the canonical D22 copy -- which is precisely
    // the risk the migration away from the inline literal introduces.
    expect(result.stderr).toBe(formatConcurrentOperationRefusal(info, START_LOCK_REL));
  });
});
