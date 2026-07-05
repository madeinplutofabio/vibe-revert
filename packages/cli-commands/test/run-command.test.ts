// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration matrix for `viberevert run` (M G2 Step 6, D102).
//
// Harness: a real clipanion Cli with RunCommand registered, driven via
// cli.run(...) with captured context stdout/stderr and a PassThrough
// stdin (isTTY configurable). CRITICAL: run.ts spawns the wrapped child
// with stdio: "inherit", so the child inherits the REAL test-runner
// stdio, NOT the captured context streams. All test children are
// therefore SILENT (node -e writing files / setting exit codes); the
// captured stdout stays empty and only run.ts's own wrapper text (which
// goes to context.stderr per the D102.D stream lock) is asserted.
//
// Children use process.execPath (the absolute node binary path) so they
// never depend on PATH resolution -- the one ENOENT test uses a
// deliberately bogus name. Guard / confirm-refusal children never spawn
// (refused pre-session), so their argv can be arbitrary.
//
// Each run needs: a real git repo with a HEAD commit (startSessionOperation
// -> createCheckpoint -> getHeadSha), a .gitignore hiding .viberevert/ so
// after-status captures only the child's file writes, and a .viberevert.yml
// (run REQUIRES valid config, D19). Same fixture shape as start-end.test.ts.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
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

import { type ChildExitStatus, mapChildExitToCode, RunCommand } from "../src/commands/run.js";

const execFileAsync = promisify(execFile);

// Crockford-base32 ULIDs (no I, L, O, U) -- same fixture pattern as
// start-end.test.ts, used only by the active-session refusal test.
const PREEXISTING_SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const PREEXISTING_CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const PREEXISTING_STARTED_AT = "2026-05-04T10:30:11Z";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cli-run-"));
  originalCwd = process.cwd();
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
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  // Default minimal config; guard / confirm tests overwrite it.
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Overwrite the repo's .viberevert.yml with the given raw YAML. */
async function writeConfig(yaml: string): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), yaml);
}

/**
 * Set up a pre-existing in-flight session directly on disk (bypassing
 * core.startSession), mirroring start-end.test.ts's helper. Used only by
 * the "session already active" refusal test.
 */
async function setupActiveSession(): Promise<void> {
  const sessionDir = join(tmpRoot, ".viberevert", "sessions", PREEXISTING_SESSION_ID);
  await mkdir(join(sessionDir, "checkpoint"), { recursive: true });

  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: PREEXISTING_SESSION_ID,
    checkpoint_id: PREEXISTING_CHECKPOINT_ID,
    started_at: PREEXISTING_STARTED_AT,
    before_status_path: `.viberevert/sessions/${PREEXISTING_SESSION_ID}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${PREEXISTING_SESSION_ID}/commands.log`,
  };
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState, null, 2));
  await writeFile(join(sessionDir, "before-status.txt"), "");
  await writeFile(join(sessionDir, "commands.log"), "");

  const lock: ActiveSessionLock = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: PREEXISTING_SESSION_ID,
    checkpoint_id: PREEXISTING_CHECKPOINT_ID,
    started_at: PREEXISTING_STARTED_AT,
  };
  await writeFile(
    join(tmpRoot, ".viberevert", "active-session.json"),
    JSON.stringify(lock, null, 2),
  );
}

/**
 * Run `viberevert run <args>` via a clipanion Cli with captured
 * stdout/stderr and a PassThrough stdin. `isTTY` toggles the stdin TTY
 * flag (drives the require_confirm branch); `stdinData`, if provided, is
 * pre-buffered onto stdin before the run (so the confirm readline reads
 * it). The stdin stream is always ended so no handle is left open.
 */
async function runRun(
  args: string[],
  opts: { isTTY?: boolean; stdinData?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(RunCommand);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = opts.isTTY === true;
  if (opts.stdinData !== undefined) {
    stdinStub.write(opts.stdinData);
  }
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

  const exitCode = await cli.run(["run", ...args], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

/** Read the single session id under .viberevert/sessions (asserts exactly one). */
async function readSingleSessionId(): Promise<string> {
  const entries = await readdir(join(tmpRoot, ".viberevert", "sessions"));
  expect(entries).toHaveLength(1);
  return entries[0] as string;
}

/** Parse a session's commands.log into its JSONL entries. */
async function readCommandsLog(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(
    join(tmpRoot, ".viberevert", "sessions", sessionId, "commands.log"),
    "utf8",
  );
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Assert the .viberevert/ STATE dir was never created (pure pre-session refusal). */
async function expectNoSessionState(): Promise<void> {
  await expect(stat(join(tmpRoot, ".viberevert"))).rejects.toThrow();
}

/** Assert the active-session lock was removed (session ended). */
async function expectSessionEnded(): Promise<void> {
  await expect(stat(join(tmpRoot, ".viberevert", "active-session.json"))).rejects.toThrow();
}

// ===========================================================================
// D102.E pure exit-code mapper (deep-imported unit surface)
// ===========================================================================

describe("mapChildExitToCode (D102.E pure mapper)", () => {
  it("propagates a numeric exit code verbatim (0)", () => {
    const status: ChildExitStatus = { code: 0, signal: null };
    expect(mapChildExitToCode(status)).toBe(0);
  });

  it("propagates a numeric exit code verbatim (7)", () => {
    const status: ChildExitStatus = { code: 7, signal: null };
    expect(mapChildExitToCode(status)).toBe(7);
  });

  it("maps SIGTERM death to 128 + signal number", () => {
    const status: ChildExitStatus = { code: null, signal: "SIGTERM" };
    expect(mapChildExitToCode(status)).toBe(128 + osConstants.signals.SIGTERM);
  });

  it("maps SIGINT death to 128 + signal number", () => {
    const status: ChildExitStatus = { code: null, signal: "SIGINT" };
    expect(mapChildExitToCode(status)).toBe(128 + osConstants.signals.SIGINT);
  });

  it("returns 1 for the defensive neither-code-nor-signal case", () => {
    const status: ChildExitStatus = { code: null, signal: null };
    expect(mapChildExitToCode(status)).toBe(1);
  });
});

// ===========================================================================
// Integration matrix
// ===========================================================================

describe("viberevert run (integration matrix)", () => {
  it("(a) happy path: file-writing child -> exit 0, session ended, after-status + commands.log + agent_command captured, two-line summary on stderr, stdout empty", async () => {
    const argv = [process.execPath, "-e", "require('fs').writeFileSync('x.txt','hi')"];
    const result = await runRun(argv);

    expect(result.exitCode).toBe(0);
    // D102.D: wrapper text is stderr-only; the silent child writes
    // nothing to the captured stdout.
    expect(result.stdout).toBe("");
    // D102.G two-line summary, on stderr.
    expect(result.stderr).toMatch(/Session: sess_[0-9A-HJKMNP-TV-Z]{26}\n/);
    expect(result.stderr).toMatch(/Next: viberevert check --since sess_[0-9A-HJKMNP-TV-Z]{26}\n/);

    // The child ran with cwd = repo root.
    await expect(stat(join(tmpRoot, "x.txt"))).resolves.toBeDefined();
    await expectSessionEnded();

    const sessionId = await readSingleSessionId();
    const sessionDir = join(tmpRoot, ".viberevert", "sessions", sessionId);

    // after-status.txt captured the new untracked file.
    const afterStatus = await readFile(join(sessionDir, "after-status.txt"), "utf8");
    expect(afterStatus).toContain("x.txt");

    // agent_command = normalized joined argv.
    const session = SessionStateSchema.parse(
      JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")),
    );
    expect(session.agent_command).toBe(argv.join(" "));

    // Exactly one commands.log entry: repo-relative cwd ".", verbatim argv.
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["cwd"]).toBe(".");
    expect(entries[0]?.["argv"]).toEqual(argv);
    expect(entries[0]?.["at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("(a2) invocation from subdirectory: child cwd is subdir and commands.log records repo-relative cwd", async () => {
    await mkdir(join(tmpRoot, "nested"));
    process.chdir(join(tmpRoot, "nested"));

    const argv = [process.execPath, "-e", "require('fs').writeFileSync('inside.txt','')"];
    const result = await runRun(argv);

    expect(result.exitCode).toBe(0);
    await expect(stat(join(tmpRoot, "nested", "inside.txt"))).resolves.toBeDefined();

    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["cwd"]).toBe("nested");
    expect(entries[0]?.["argv"]).toEqual(argv);
  });

  it("(b) guard match -> exit 2, refusal on stderr, NO session state created", async () => {
    await writeConfig("version: 1\ncommands:\n  guard:\n    - 'rm -rf /'\n");
    const result = await runRun(["rm", "-rf", "/"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "Refused: this command matches a guarded pattern in .viberevert.yml.",
    );
    expect(result.stderr).toContain("matched rule:  rm -rf /");
    expect(result.stderr).toContain("command:       rm -rf /");
    expect(result.stdout).toBe("");
    await expectNoSessionState();
  });

  it("(b2) guard wins over require_confirm when both match -> exit 2, NO prompt/session", async () => {
    await writeConfig(
      "version: 1\ncommands:\n  guard:\n    - 'danger'\n  require_confirm:\n    - 'danger'\n",
    );

    const result = await runRun(["danger", "now"], {
      isTTY: true,
      stdinData: "run anyway\n",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "Refused: this command matches a guarded pattern in .viberevert.yml.",
    );
    // The confirm prompt (double-quoted "run anyway", per run.ts) must
    // NOT appear -- guard is checked and returns before the confirm branch.
    expect(result.stderr).not.toContain('Type "run anyway"');
    await expectNoSessionState();
  });

  it("(c1) require_confirm + non-TTY stdin -> exit 2, refusal on stderr, NO session state", async () => {
    await writeConfig("version: 1\ncommands:\n  require_confirm:\n    - 'terraform destroy'\n");
    const result = await runRun(["terraform", "destroy"], { isTTY: false });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "Refused: this command matches a confirm-required pattern in .viberevert.yml, and stdin is not a TTY",
    );
    expect(result.stdout).toBe("");
    await expectNoSessionState();
  });

  it("(c2) require_confirm + TTY + wrong answer -> exit 2, NO session state", async () => {
    await writeConfig("version: 1\ncommands:\n  require_confirm:\n    - 'terraform destroy'\n");
    const result = await runRun(["terraform", "destroy"], { isTTY: true, stdinData: "nope\n" });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Confirmation did not match. Command not run.");
    await expectNoSessionState();
  });

  it('(c3) require_confirm + TTY + "run anyway" -> child spawns, exit 0, session ended', async () => {
    // Prefix-match rule (D102.C): the entry is process.execPath, which
    // is a boundary-prefix of the full `<node> -e <script>` command.
    // Single-quoted YAML keeps Windows backslashes literal.
    await writeConfig(`version: 1\ncommands:\n  require_confirm:\n    - '${process.execPath}'\n`);
    const argv = [process.execPath, "-e", "require('fs').writeFileSync('ok.txt','')"];
    const result = await runRun(argv, { isTTY: true, stdinData: "run anyway\n" });

    expect(result.exitCode).toBe(0);
    await expect(stat(join(tmpRoot, "ok.txt"))).resolves.toBeDefined();
    await expectSessionEnded();
    expect(result.stderr).toMatch(/Session: sess_[0-9A-HJKMNP-TV-Z]{26}\n/);
  });

  it("(d) child process.exit(7) -> exit 7, session ended", async () => {
    const result = await runRun([process.execPath, "-e", "process.exit(7)"]);
    expect(result.exitCode).toBe(7);
    await expectSessionEnded();
    await readSingleSessionId(); // exactly one session dir exists
  });

  it("(e) spawn ENOENT -> exit 127, 'Command not found', session ended, summary still printed", async () => {
    const bogus = "viberevert-nonexistent-binary-9d3f";
    const result = await runRun([bogus]);

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain(`Command not found: ${bogus}`);
    // Session started before the spawn attempt and ends cleanly -> the
    // two-line summary still prints below the error.
    expect(result.stderr).toMatch(/Session: sess_[0-9A-HJKMNP-TV-Z]{26}\n/);
    await expectSessionEnded();
  });

  it("(f) session already active -> exit 1, refusal on stderr, child never spawns", async () => {
    await setupActiveSession();
    const result = await runRun([
      process.execPath,
      "-e",
      "require('fs').writeFileSync('nope.txt','')",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("A session is already active in this repo.");
    // Child never ran; the pre-existing lock is untouched.
    await expect(stat(join(tmpRoot, "nope.txt"))).rejects.toThrow();
    await expect(stat(join(tmpRoot, ".viberevert", "active-session.json"))).resolves.toBeDefined();
  });

  it("(g1) --task BEFORE the command boundary -> parsed as run's flag (session.task set)", async () => {
    const argv = [process.execPath, "-e", "require('fs').writeFileSync('g1.txt','')"];
    const result = await runRun(["--task", "before label", ...argv]);

    expect(result.exitCode).toBe(0);
    const sessionId = await readSingleSessionId();
    const session = SessionStateSchema.parse(
      JSON.parse(
        await readFile(join(tmpRoot, ".viberevert", "sessions", sessionId, "session.json"), "utf8"),
      ),
    );
    expect(session.task).toBe("before label");
    // --task did NOT leak into the child's recorded argv.
    const entries = await readCommandsLog(sessionId);
    expect(entries[0]?.["argv"]).toEqual(argv);
  });

  it("(g2) --task AFTER the command boundary -> flows to the child (session.task unset)", async () => {
    // The child is a script FILE, so node stops option parsing at it and
    // passes `--task after-label` through as script argv (no node error).
    await writeFile(
      join(tmpRoot, "echo-args.cjs"),
      "require('fs').writeFileSync('child-argv.json', JSON.stringify(process.argv.slice(2)));\n",
    );
    const scriptPath = join(tmpRoot, "echo-args.cjs");
    const result = await runRun([process.execPath, scriptPath, "--task", "after-label"]);

    expect(result.exitCode).toBe(0);
    const sessionId = await readSingleSessionId();
    const session = SessionStateSchema.parse(
      JSON.parse(
        await readFile(join(tmpRoot, ".viberevert", "sessions", sessionId, "session.json"), "utf8"),
      ),
    );
    // run did NOT consume --task; the session carries no task.
    expect(session.task).toBeUndefined();
    // The child received --task after-label as its own args.
    const childArgv = JSON.parse(await readFile(join(tmpRoot, "child-argv.json"), "utf8"));
    expect(childArgv).toEqual(["--task", "after-label"]);
  });

  it("(g3) leading -- command boundary is consumed by Clipanion and not recorded in commands.log", async () => {
    const argv = [process.execPath, "-e", "require('fs').writeFileSync('g3.txt','')"];
    const result = await runRun(["--", ...argv]);

    expect(result.exitCode).toBe(0);
    await expect(stat(join(tmpRoot, "g3.txt"))).resolves.toBeDefined();

    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries[0]?.["argv"]).toEqual(argv);
  });

  it("(empty) empty command name -> exit 1 refusal before any session state", async () => {
    const result = await runRun(["", "foo"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Command name must not be empty.");
    await expectNoSessionState();
  });

  it.runIf(process.platform !== "win32")(
    "(h) POSIX: child killed by SIGTERM -> exit 128 + SIGTERM, session ended",
    async () => {
      const result = await runRun([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);
      expect(result.exitCode).toBe(128 + osConstants.signals.SIGTERM);
      await expectSessionEnded();
    },
  );

  it.runIf(process.platform === "win32")(
    "(i) Windows: spawning a .cmd directly -> exit 1 + cmd /c hint, session ended",
    async () => {
      const cmdPath = join(tmpRoot, "test.cmd");
      await writeFile(cmdPath, "@echo off\r\nexit /b 0\r\n");
      const result = await runRun([cmdPath]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Windows refuses .bat/.cmd with shell disabled");
      expect(result.stderr).toContain("viberevert run cmd /c");
      await expectSessionEnded();
    },
  );
});
