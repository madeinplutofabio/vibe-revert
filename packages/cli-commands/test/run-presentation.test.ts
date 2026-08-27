// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Presentation contracts for `viberevert run`'s session lifecycle
// (M 0.8.0 step 4c, Slice C).
//
// MOCK-FOCUSED BY DESIGN, same convention as end-presentation.test.ts:
// module mocking is file-scoped, so it ships separately rather than
// contaminating run-command.test.ts's genuinely behavioral suite.
//
// =============================================================================
// The mock boundary
// =============================================================================
//
// MOCKED (five functions, each via `importOriginal` so every sibling export
// stays real):
//   @viberevert/core        resolveRepoRoot, loadConfig, appendCommandsLogEntry
//   operations/start-session  startSessionOperation
//   operations/end-session    endSessionOperation
//
// REAL: RunCommand itself, guard/confirm policy evaluation, executable
// resolution and target classification, the child spawn, and every error
// CLASS. Mocked error classes would let these tests pass even if run.ts
// dispatched on the wrong type, which is the whole thing under test.
//
// `resolveRepoRoot` must be mocked, not just `loadConfig`: run.ts resolves
// the repo root at Step 1, BEFORE config, so mocking config alone would
// still require a real repository on disk.
//
// Children are `process.execPath -e "process.exit(N)"` — a real subprocess
// with no shell semantics and no PATH dependency, matching the pattern
// run-command.test.ts already documents. Only the tests whose contract
// involves the child's outcome spawn one; the commands.log and start-
// contention cases return before Step 6 and do not need child-outcome
// behavior for the presentation contract under test.

import { PassThrough, Writable } from "node:stream";
import {
  appendCommandsLogEntry,
  type Config,
  loadConfig,
  NoActiveSessionError,
  resolveRepoRoot,
} from "@viberevert/core";
import { EndStateChangedDuringCaptureError } from "@viberevert/git";
import { Cli } from "clipanion";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RunCommand } from "../src/commands/run.js";
import { ConcurrentOperationError, formatConcurrentOperationRefusal } from "../src/locks.js";
import { EndSessionRaceError, endSessionOperation } from "../src/operations/end-session.js";
import { START_LOCK_REL, startSessionOperation } from "../src/operations/start-session.js";

vi.mock("@viberevert/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@viberevert/core")>();
  return {
    ...actual,
    resolveRepoRoot: vi.fn(),
    loadConfig: vi.fn(),
    appendCommandsLogEntry: vi.fn(),
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

/** Only `version` is required by ConfigSchema; run reads `.commands` off it. */
const MINIMAL_CONFIG = { version: 1 } as Config;

const STARTED = {
  sessionId: SESSION_ID,
  checkpointId: CHECKPOINT_ID,
  startedAt: STARTED_AT,
};

const CLEAN_END = {
  sessionId: SESSION_ID,
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  cleanupWarnings: [] as readonly string[],
};

/** A real, silent child that exits 7 — a code no wrapper path produces. */
const CHILD_EXIT_7 = [process.execPath, "-e", "process.exit(7)"];

beforeEach(() => {
  vi.mocked(resolveRepoRoot).mockReset().mockReturnValue(process.cwd());
  vi.mocked(loadConfig).mockReset().mockResolvedValue(MINIMAL_CONFIG);
  vi.mocked(appendCommandsLogEntry).mockReset().mockResolvedValue(undefined);
  vi.mocked(startSessionOperation).mockReset().mockResolvedValue(STARTED);
  vi.mocked(endSessionOperation).mockReset().mockResolvedValue(CLEAN_END);
});

/** Drive the real RunCommand through a clipanion Cli with captured streams. */
async function runRun(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(RunCommand);

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

  const exitCode = await cli.run(["run", ...argv], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

// =============================================================================
// Cleanup warnings, at both end call sites
// =============================================================================

describe("run: cleanup warnings", () => {
  it("Step 7 warnings precede the summary, and the child's exit code still propagates", async () => {
    vi.mocked(endSessionOperation).mockResolvedValue({
      ...CLEAN_END,
      cleanupWarnings: [WARNING_A, WARNING_B],
    });

    const result = await runRun(CHILD_EXIT_7);

    // Non-fatal: a failed scratch cleanup never overrides the child's code.
    expect(result.exitCode).toBe(7);
    // D102.D: all wrapper text is stderr-only.
    expect(result.stdout).toBe("");

    const firstAt = result.stderr.indexOf(`warning: ${WARNING_A}`);
    const secondAt = result.stderr.indexOf(`warning: ${WARNING_B}`);
    const summaryAt = result.stderr.indexOf(`Session: ${SESSION_ID}`);
    expect(firstAt).toBeGreaterThanOrEqual(0);
    // Order is preserved...
    expect(firstAt).toBeLessThan(secondAt);
    // ...and warnings sit WITH the session presentation, not before the
    // command outcome the user actually came for.
    expect(secondAt).toBeLessThan(summaryAt);
    expect(result.stderr).toContain(`Next: viberevert check --since ${SESSION_ID}`);
  });

  it("commands.log failure surfaces warnings between the outcome and the close state", async () => {
    vi.mocked(appendCommandsLogEntry).mockRejectedValue(new Error("commands.log is unreadable"));
    vi.mocked(endSessionOperation).mockResolvedValue({
      ...CLEAN_END,
      cleanupWarnings: [WARNING_A],
    });

    const result = await runRun(CHILD_EXIT_7);

    // The commands.log refusal returns its wrapper failure code before the
    // normal child-outcome path. D102.F's no-spawn behavior is covered by the
    // behavioral run suite; this presentation test owns the close/warning copy.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Could not record the command in the session's commands.log: commands.log is unreadable",
    );

    const outcomeAt = result.stderr.indexOf("Command not run.");
    const warningAt = result.stderr.indexOf(`warning: ${WARNING_A}`);
    const closeStateAt = result.stderr.indexOf("The session was closed.");
    expect(outcomeAt).toBeGreaterThanOrEqual(0);
    expect(outcomeAt).toBeLessThan(warningAt);
    expect(warningAt).toBeLessThan(closeStateAt);

    // This path returns before the summary; an unrelated failure mode must
    // not make cleanup diagnostics disappear, but it also must not invent a
    // session summary that never happened.
    expect(result.stderr).not.toContain(`Session: ${SESSION_ID}`);
  });

  it("commands.log failure plus EndSessionRaceError leaves the close state unknown", async () => {
    // The SECOND site where step 4c changed race semantics. This branch used
    // to classify the race as "already ended"; it now falls through to
    // "unknown", because the active marker vanished out of protocol and core
    // published no terminal state.
    vi.mocked(appendCommandsLogEntry).mockRejectedValue(new Error("commands.log is unreadable"));
    vi.mocked(endSessionOperation).mockRejectedValue(new EndSessionRaceError());

    const result = await runRun(CHILD_EXIT_7);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Command not run.");
    expect(result.stderr).toContain("The session may still be active. Close it manually with:");
    expect(result.stderr).toContain("viberevert end");
    // The false-success claim must not return.
    expect(result.stderr).not.toContain("The session was already ended.");
    expect(result.stderr).not.toContain(`Session: ${SESSION_ID}`);
  });
});

// =============================================================================
// End failures
// =============================================================================

describe("run: end failures", () => {
  it("fence refusal gets contextual copy and leaks no changed-member names", async () => {
    const err = new EndStateChangedDuringCaptureError(3, [
      "afterHeadSha",
      "trackedStatus",
      "rawInventory",
    ]);
    vi.mocked(endSessionOperation).mockRejectedValue(err);

    const result = await runRun(CHILD_EXIT_7);

    expect(result.exitCode).toBe(1);
    // D102.E: the child's result is still reported even though the wrapper
    // must fail, because end did not complete.
    expect(result.stderr).toContain(
      "The wrapped command finished (exit status: 7), but the session could not be closed: the project kept changing during capture",
    );
    expect(result.stderr).toContain(
      "Stop other writers or background processes changing the repo, then",
    );
    expect(result.stderr).toContain("Close it manually with:");
    expect(result.stderr).toContain("viberevert end");

    // Same privacy contract `end.ts` applies. One failure must not leak
    // fence internals just because a different command hit it.
    expect(result.stderr).not.toContain(err.message);
    expect(result.stderr).not.toContain("afterHeadSha");
    expect(result.stderr).not.toContain("trackedStatus");
    expect(result.stderr).not.toContain("rawInventory");
  });

  it("NoActiveSessionError keeps the already-ended note AND the child's exit code", async () => {
    vi.mocked(endSessionOperation).mockRejectedValue(new NoActiveSessionError());

    const result = await runRun(CHILD_EXIT_7);

    // The session really was ended (inside the child), so this is not a
    // wrapper failure: the child's code propagates verbatim.
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain(
      "Note: the session was already ended before the wrapper could close it.",
    );
    expect(result.stderr).toContain(`Session: ${SESSION_ID}`);
    expect(result.stderr).not.toContain("could not be closed");
  });

  it("EndSessionRaceError is an end FAILURE, never an already-ended session", async () => {
    vi.mocked(endSessionOperation).mockRejectedValue(new EndSessionRaceError());

    const result = await runRun(CHILD_EXIT_7);

    // Since step 4c the lifecycle lock refuses a competing `end` at
    // acquisition, so this class now means active-session.json vanished
    // out of protocol and core published NO terminal state. Claiming a
    // successful close would be false, so the wrapper fails.
    expect(result.exitCode).toBe(1);
    // ...but D102.E still holds: the user learns what their command did.
    expect(result.stderr).toContain(
      "The wrapped command finished (exit status: 7), but the session could not be closed:",
    );
    expect(result.stderr).toContain("Close it manually with:");
    // The pre-4c assumption must not creep back in.
    expect(result.stderr).not.toContain("already ended before the wrapper could close it");
  });
});

// =============================================================================
// Start-path lock contention
// =============================================================================

describe("run: start contention", () => {
  it("renders EXACTLY the canonical D22 formatter output, not a duplicated literal", async () => {
    const info = {
      pid: 4242,
      command: "viberevert start",
      started_at: "2026-07-01T00:00:00Z",
      host: "testhost",
    };
    vi.mocked(startSessionOperation).mockRejectedValue(
      new ConcurrentOperationError(LOCK_DIR, info),
    );

    const result = await runRun(CHILD_EXIT_7);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    // Nothing is written before Step 4 on an allowed command, so stderr is
    // exactly the formatter's block. Compared against the formatter itself
    // so this caller cannot drift from the canonical D22 copy -- which is
    // precisely what the migration away from the inline literal risks.
    expect(result.stderr).toBe(formatConcurrentOperationRefusal(info, START_LOCK_REL));
  });
});
