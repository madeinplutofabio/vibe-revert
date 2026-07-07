// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration matrix for `viberevert shell` (M G3 Step 4, D103).
//
// Harness: a real clipanion Cli with ShellCommand registered, driven via
// cli.run(["shell", ...]) with captured context stdout/stderr and a
// PassThrough stdin (isTTY configurable). All submitted command lines are
// pre-buffered onto stdin and the stream is ended -- shell.ts consumes
// them through ONE readline async iterator (D103.B/C), exactly like
// piping a script into the REPL. (Probe-verified: the async iterator
// drains a pre-buffered PassThrough in order then EOFs -- with OR without
// a final newline; sequential iterator.next() reads consecutive lines,
// which is how the confirm sub-read consumes exactly the next line.)
//
// CRITICAL: shell.ts spawns each accepted command with stdio: "inherit",
// so children inherit the REAL test-runner stdio, NOT the captured
// context streams. All test children are therefore SILENT (node -e /
// node <file> writing sentinel files, setting exit codes, or mutating the
// active lock); the captured stdout stays empty and only shell.ts's own
// wrapper text (stderr per the D103.B stream lock) is asserted.
//
// Children use process.execPath, double-quoted in the shell line so a
// path with spaces still tokenizes to a single argv[0] (backslashes
// inside double quotes are literal, so Windows paths survive). Tiny
// silent one-liners use nodeLine(); anything touching paths / the active
// lock uses nodeScriptFileCommand() (a real .cjs file, so the source can
// contain any characters without shell-line escaping). The one ENOENT
// test uses a deliberately bogus name.
//
// Fixture: a real git repo with a HEAD commit (startSessionOperation ->
// createCheckpoint), a .gitignore hiding .viberevert/, and a
// .viberevert.yml (shell REQUIRES valid config, D19). Same shape as
// run-command.test.ts.

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
import { Builtins, Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShellCommand } from "../src/commands/shell.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

const execFileAsync = promisify(execFile);

// Crockford-base32 ULIDs (no I, L, O, U). The PREEXISTING identity backs
// the "session already active" refusal; the OTHER identity backs the
// "active session replaced by a different session" integrity test (15b).
const PREEXISTING_SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const PREEXISTING_CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const PREEXISTING_STARTED_AT = "2026-05-04T10:30:11Z";
const OTHER_SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQS";
const OTHER_CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQS";
const OTHER_STARTED_AT = "2026-05-05T11:31:12Z";

let tmpRoot: string;
let originalCwd: string;

const RETRYABLE_RM_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

/**
 * Remove a directory tree, retrying the Windows handle-release teardown
 * race (a just-exited child's directory handle not yet released by the OS
 * / an AV scanner). ONLY the known race codes are retried; any other
 * error -- or exhausting the retries -- rethrows, so real failures are
 * never hidden.
 */
async function rmWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!RETRYABLE_RM_CODES.has(code ?? "") || attempt === 4) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cli-shell-"));
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
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  await rmWithRetry(tmpRoot);
});

/** Overwrite the repo's .viberevert.yml with the given raw YAML. */
async function writeConfig(yaml: string): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), yaml);
}

/**
 * Set up a pre-existing in-flight session directly on disk (bypassing
 * core.startSession), mirroring run-command.test.ts. Used by the "session
 * already active" refusal test.
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
 * Drive `viberevert shell` through a clipanion Cli. `lines` are the
 * command lines submitted to the REPL; the stdin stream is then ended,
 * delivering EOF. By default a final newline terminates the last line;
 * `finalNewline: false` omits it (locks the no-EOL EOF path the probes
 * validated). `isTTY` toggles the stdin TTY flag (drives the
 * require_confirm branch); `task` passes `--task`. Builtins.HelpCommand
 * is registered so the harness matches the real binary (it never
 * intercepts a plain `shell` invocation).
 */
async function runShell(
  lines: string[],
  opts: { isTTY?: boolean; task?: string; finalNewline?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(Builtins.HelpCommand);
  cli.register(ShellCommand);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = opts.isTTY === true;
  if (lines.length > 0) {
    const body = lines.join("\n");
    stdinStub.write(opts.finalNewline === false ? body : `${body}\n`);
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

  const shellArgs = opts.task !== undefined ? ["shell", "--task", opts.task] : ["shell"];
  const exitCode = await cli.run(shellArgs, {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

/**
 * A shell input LINE that runs node with `-e <script>`. The node path is
 * double-quoted so a path containing spaces (Windows "Program Files")
 * still tokenizes to a single argv[0]. `script` MUST contain no
 * double-quote or backslash characters -- for anything more complex (path
 * / lock manipulation, JSON), use nodeScriptFileCommand().
 */
function nodeLine(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}

/** The argv that nodeLine(script) tokenizes to (for commands.log asserts). */
function nodeArgv(script: string): string[] {
  return [process.execPath, "-e", script];
}

/**
 * Write `source` to a real .cjs file and return the shell LINE that runs
 * it plus the argv that line tokenizes to. The source is a file, so it
 * may contain any characters (quotes, backslashes, JSON) without
 * shell-line escaping -- use this for children that touch paths or mutate
 * the active-session lock.
 */
async function nodeScriptFileCommand(
  name: string,
  source: string,
): Promise<{ line: string; argv: string[] }> {
  const scriptPath = join(tmpRoot, `.tmp-${name}.cjs`);
  await writeFile(scriptPath, source);
  return {
    line: `"${process.execPath}" "${scriptPath}"`,
    argv: [process.execPath, scriptPath],
  };
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

/** Read + parse the active-session lock (asserts it exists). */
async function readActiveLock(): Promise<ActiveSessionLock> {
  return JSON.parse(
    await readFile(join(tmpRoot, ".viberevert", "active-session.json"), "utf8"),
  ) as ActiveSessionLock;
}

/** Assert the .viberevert/ STATE dir was never created (pure pre-loop refusal). */
async function expectNoSessionState(): Promise<void> {
  await expect(stat(join(tmpRoot, ".viberevert"))).rejects.toThrow();
}

/** Assert the active-session lock was removed (session ended). */
async function expectSessionEnded(): Promise<void> {
  await expect(stat(join(tmpRoot, ".viberevert", "active-session.json"))).rejects.toThrow();
}

// ===========================================================================
// Integration matrix
// ===========================================================================

describe("viberevert shell (integration matrix)", () => {
  it("(1) happy multi-command: two children run, one commands.log entry each, session ended, two-line summary on stderr, stdout empty", async () => {
    const scriptA = "require('fs').writeFileSync('a.txt','A')";
    const scriptB = "require('fs').writeFileSync('b.txt','B')";
    const result = await runShell([nodeLine(scriptA), nodeLine(scriptB), "exit"]);

    expect(result.exitCode).toBe(0);
    // D103.B: wrapper text is stderr-only; silent children write nothing
    // to the captured stdout.
    expect(result.stdout).toBe("");
    // Both children ran (cwd = repo root).
    await expect(stat(join(tmpRoot, "a.txt"))).resolves.toBeDefined();
    await expect(stat(join(tmpRoot, "b.txt"))).resolves.toBeDefined();
    await expectSessionEnded();
    // D102.G two-line summary, on stderr.
    expect(result.stderr).toMatch(/Session: sess_[0-9A-HJKMNP-TV-Z]{26}\n/);
    expect(result.stderr).toMatch(/Next: viberevert check --since sess_[0-9A-HJKMNP-TV-Z]{26}\n/);

    // One commands.log entry per accepted command, in order, cwd ".",
    // verbatim argv, ISO-second `at`.
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.["cwd"]).toBe(".");
    expect(entries[0]?.["argv"]).toEqual(nodeArgv(scriptA));
    expect(entries[1]?.["argv"]).toEqual(nodeArgv(scriptB));
    for (const entry of entries) {
      expect(entry["at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it("(2) guard refusal SKIPS the command and CONTINUES: guarded command not run/logged, next command runs", async () => {
    await writeConfig("version: 1\ncommands:\n  guard:\n    - 'rm -rf /'\n");
    const script = "require('fs').writeFileSync('after.txt','')";
    const result = await runShell(["rm -rf /", nodeLine(script), "exit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "Refused: this command matches a guarded pattern in .viberevert.yml.",
    );
    expect(result.stderr).toContain("matched rule:  rm -rf /");
    // The next command still ran.
    await expect(stat(join(tmpRoot, "after.txt"))).resolves.toBeDefined();
    // Only the accepted command was logged (the guarded one was not).
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual(nodeArgv(script));
  });

  it('(3) require_confirm + TTY + "run anyway": child runs, one entry, loop continues to exit', async () => {
    // Prefix-match rule (D102.C): the entry is process.execPath, a
    // boundary-prefix of the full `<node> -e <script>` command.
    // Single-quoted YAML keeps Windows backslashes literal.
    await writeConfig(`version: 1\ncommands:\n  require_confirm:\n    - '${process.execPath}'\n`);
    const script = "require('fs').writeFileSync('ok.txt','')";
    const result = await runShell([nodeLine(script), "run anyway", "exit"], { isTTY: true });

    expect(result.exitCode).toBe(0);
    await expect(stat(join(tmpRoot, "ok.txt"))).resolves.toBeDefined();
    await expectSessionEnded();
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual(nodeArgv(script));
  });

  it("(4) require_confirm + TTY + wrong answer: command skipped, loop CONTINUES, a later command runs", async () => {
    await writeConfig("version: 1\ncommands:\n  require_confirm:\n    - 'blocked'\n");
    const script = "require('fs').writeFileSync('later.txt','')";
    const result = await runShell(["blocked", "nope", nodeLine(script), "exit"], { isTTY: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Confirmation did not match. Command not run.");
    // `blocked` never ran (the confirm read consumed "nope"); the later
    // command did.
    await expect(stat(join(tmpRoot, "later.txt"))).resolves.toBeDefined();
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual(nodeArgv(script));
  });

  it("(5) require_confirm + non-TTY: refused WITHOUT consuming a line, so the next line stays a command", async () => {
    await writeConfig("version: 1\ncommands:\n  require_confirm:\n    - 'blocked'\n");
    const script = "require('fs').writeFileSync('next.txt','')";
    // isTTY:false -- if shell wrongly consumed a confirm line here, the
    // node command would be eaten as the answer and next.txt would be
    // absent (matrix #5 line-accounting guard).
    const result = await runShell(["blocked", nodeLine(script), "exit"], { isTTY: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "Refused: this command matches a confirm-required pattern in .viberevert.yml, and stdin is not a TTY",
    );
    await expect(stat(join(tmpRoot, "next.txt"))).resolves.toBeDefined();
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual(nodeArgv(script));
  });

  it("(6a) `exit` terminates: a command after `exit` does NOT run; session ended; exit 0", async () => {
    const before = "require('fs').writeFileSync('before.txt','')";
    const after = "require('fs').writeFileSync('after.txt','')";
    const result = await runShell([nodeLine(before), "exit", nodeLine(after)]);

    expect(result.exitCode).toBe(0);
    await expect(stat(join(tmpRoot, "before.txt"))).resolves.toBeDefined();
    // The line after `exit` was never read.
    await expect(stat(join(tmpRoot, "after.txt"))).rejects.toThrow();
    await expectSessionEnded();
    expect(result.stderr).toMatch(/Session: sess_[0-9A-HJKMNP-TV-Z]{26}\n/);
  });

  it('(6b) `commands.guard: ["exit"]` does NOT trap the user -- `exit` still quits before policy', async () => {
    await writeConfig("version: 1\ncommands:\n  guard:\n    - 'exit'\n");
    const after = "require('fs').writeFileSync('after.txt','')";
    const result = await runShell(["exit", nodeLine(after)]);

    expect(result.exitCode).toBe(0);
    // `exit` is handled before guard policy: it terminates rather than
    // being refused, and the following command never runs.
    await expect(stat(join(tmpRoot, "after.txt"))).rejects.toThrow();
    expect(result.stderr).not.toContain("Refused: this command matches a guarded pattern");
    await expectSessionEnded();
  });

  it("(7) EOF (no `exit`) terminates: session ended, summary, exit 0", async () => {
    const script = "require('fs').writeFileSync('x.txt','')";
    const result = await runShell([nodeLine(script)]); // no `exit`; stdin ends

    expect(result.exitCode).toBe(0);
    await expect(stat(join(tmpRoot, "x.txt"))).resolves.toBeDefined();
    await expectSessionEnded();
    expect(result.stderr).toMatch(/Session: sess_[0-9A-HJKMNP-TV-Z]{26}\n/);
  });

  it("(7b) EOF WITHOUT a final newline still reads the last command (no-EOL probe finding)", async () => {
    const script = "require('fs').writeFileSync('noeol.txt','')";
    const result = await runShell([nodeLine(script)], { finalNewline: false });

    expect(result.exitCode).toBe(0);
    await expect(stat(join(tmpRoot, "noeol.txt"))).resolves.toBeDefined();
    await expectSessionEnded();

    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual(nodeArgv(script));
  });

  it("(8) immediate EOF, zero commands: one session starts and ends, commands.log empty, summary, exit 0", async () => {
    const result = await runShell([]); // empty stdin -> immediate EOF

    expect(result.exitCode).toBe(0);
    await expectSessionEnded();
    expect(result.stderr).toMatch(/Session: sess_[0-9A-HJKMNP-TV-Z]{26}\n/);
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(0);
  });

  it("(9) empty and whitespace-only lines are no-ops: only the real command is logged", async () => {
    const script = "require('fs').writeFileSync('real.txt','')";
    const result = await runShell(["", "   ", "\t", nodeLine(script), "exit"]);

    expect(result.exitCode).toBe(0);
    await expect(stat(join(tmpRoot, "real.txt"))).resolves.toBeDefined();
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual(nodeArgv(script));
  });

  it("(10) unterminated quote: soft error on stderr, no child, no entry, loop continues", async () => {
    const script = "require('fs').writeFileSync('after.txt','')";
    const result = await runShell(['echo "abc', nodeLine(script), "exit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("unterminated double quote");
    // The malformed line ran no child; the next command did.
    await expect(stat(join(tmpRoot, "after.txt"))).resolves.toBeDefined();
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual(nodeArgv(script));
  });

  it('(11) quoted empty argument is preserved and logged; a `""` first token is refused', async () => {
    // A trailing quoted empty arg is a valid child arg (argv[0] non-empty).
    const script = "require('fs').writeFileSync('q.txt','')";
    const withEmptyArg = `${nodeLine(script)} ""`;
    const result = await runShell([withEmptyArg, '""', "exit"]);

    expect(result.exitCode).toBe(0);
    // The node command ran (the trailing empty arg is harmless to it).
    await expect(stat(join(tmpRoot, "q.txt"))).resolves.toBeDefined();
    // A first-token `""` is refused before append/spawn (empty argv[0]).
    expect(result.stderr).toContain("Command name must not be empty.");
    // Exactly one entry: the node command, argv carrying the trailing "".
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual([...nodeArgv(script), ""]);
  });

  it("(12) per-command non-zero exit -> `[exit: 7]` on stderr, next command still runs, shell exit 0", async () => {
    const after = "require('fs').writeFileSync('after.txt','')";
    const result = await runShell([nodeLine("process.exit(7)"), nodeLine(after), "exit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("[exit: 7]");
    // The child's non-zero code is displayed and swallowed; the loop
    // continues and the next command runs.
    await expect(stat(join(tmpRoot, "after.txt"))).resolves.toBeDefined();
    // Both accepted commands are logged (the exit-7 one ran and IS logged).
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(2);
  });

  it("(13) spawn ENOENT -> 'Command not found', loop continues, AND the failed-spawn command IS logged (append-before-spawn)", async () => {
    const bogus = "viberevert-nonexistent-binary-9d3f";
    const after = "require('fs').writeFileSync('after.txt','')";
    const result = await runShell([bogus, nodeLine(after), "exit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`Command not found: ${bogus}`);
    await expect(stat(join(tmpRoot, "after.txt"))).resolves.toBeDefined();
    // Append-before-spawn (D103.F): the ENOENT command was accepted by
    // policy and logged BEFORE the spawn attempt -> two entries.
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.["argv"]).toEqual([bogus]);
    expect(entries[1]?.["argv"]).toEqual(nodeArgv(after));
  });

  it("(14) session already active -> exit 1, run's copy on stderr, no children run, no new session created, pre-existing lock untouched", async () => {
    await setupActiveSession();
    const result = await runShell([nodeLine("require('fs').writeFileSync('nope.txt','')"), "exit"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("A session is already active in this repo.");
    // The loop was never entered: no child ran.
    await expect(stat(join(tmpRoot, "nope.txt"))).rejects.toThrow();
    // No NEW session dir was created (refusal happens before start).
    const sessions = await readdir(join(tmpRoot, ".viberevert", "sessions"));
    expect(sessions).toEqual([PREEXISTING_SESSION_ID]);
    // The pre-existing lock is untouched.
    const lock = await readActiveLock();
    expect(lock.session_id).toBe(PREEXISTING_SESSION_ID);
  });

  it("(15a) active-session lock MISSING after a child -> shell stops, a later command does NOT run, teardown makes NO end call, exit 0", async () => {
    const del = await nodeScriptFileCommand(
      "unlink-lock",
      "require('fs').unlinkSync('.viberevert/active-session.json');\n",
    );
    const after = "require('fs').writeFileSync('after.txt','')";
    const result = await runShell([del.line, nodeLine(after), "exit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("the active session was ended externally; the shell will stop");
    // The later command did NOT run (the loop stopped after the deleting
    // child).
    await expect(stat(join(tmpRoot, "after.txt"))).rejects.toThrow();
    // The lock is gone (the child deleted it); teardown ended nothing and
    // printed no summary.
    await expect(stat(join(tmpRoot, ".viberevert", "active-session.json"))).rejects.toThrow();
    expect(result.stderr).not.toMatch(/Session: sess_/);
    // The deleting command was accepted + logged before it spawned.
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["argv"]).toEqual(del.argv);
  });

  it("(15b) active-session lock CHANGED to another id after a child -> shell stops, later command does NOT run, the other lock is left untouched, exit 1", async () => {
    // Pre-write a schema-valid lock carrying a DIFFERENT session id; a
    // child copies it over active-session.json mid-loop.
    const differentLock: ActiveSessionLock = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: OTHER_SESSION_ID,
      checkpoint_id: OTHER_CHECKPOINT_ID,
      started_at: OTHER_STARTED_AT,
    };
    await writeFile(join(tmpRoot, "diff-lock.json"), JSON.stringify(differentLock, null, 2));

    const replace = await nodeScriptFileCommand(
      "replace-lock",
      "require('fs').copyFileSync('diff-lock.json', '.viberevert/active-session.json');\n",
    );
    const after = "require('fs').writeFileSync('after.txt','')";
    const result = await runShell([replace.line, nodeLine(after), "exit"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "the active session now belongs to a different session; the shell will stop without touching it",
    );
    // The later command did NOT run.
    await expect(stat(join(tmpRoot, "after.txt"))).rejects.toThrow();
    // The different lock is left UNTOUCHED (shell never ends someone
    // else's session): still present, still the other id.
    const lock = await readActiveLock();
    expect(lock.session_id).toBe(OTHER_SESSION_ID);
    expect(result.stderr).not.toMatch(/Session: sess_/);
  });

  it("(16a) --task labels the session (session.json.task)", async () => {
    const result = await runShell([nodeLine("require('fs').writeFileSync('t.txt','')"), "exit"], {
      task: "refactor auth",
    });

    expect(result.exitCode).toBe(0);
    const sessionId = await readSingleSessionId();
    const session = SessionStateSchema.parse(
      JSON.parse(
        await readFile(join(tmpRoot, ".viberevert", "sessions", sessionId, "session.json"), "utf8"),
      ),
    );
    expect(session.task).toBe("refactor auth");
  });

  it("(16b) empty/whitespace --task -> exit 1 before the loop, no session state", async () => {
    const result = await runShell([nodeLine("require('fs').writeFileSync('x.txt','')"), "exit"], {
      task: "   ",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--task must not be empty or whitespace-only.");
    await expectNoSessionState();
  });

  it("(17) `at` determinism: with VIBEREVERT_TEST_FIXED_NOW set, every commands.log entry's `at` equals the fixed value", async () => {
    const FIXED = "2026-06-15T12:00:00Z";
    // vi.stubEnv is restored by vi.unstubAllEnvs() in afterEach -- no
    // fixed-time leakage into later tests.
    vi.stubEnv(VIBEREVERT_TEST_FIXED_NOW, FIXED);
    const result = await runShell([
      nodeLine("require('fs').writeFileSync('one.txt','')"),
      nodeLine("require('fs').writeFileSync('two.txt','')"),
      "exit",
    ]);

    expect(result.exitCode).toBe(0);
    const sessionId = await readSingleSessionId();
    const entries = await readCommandsLog(sessionId);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry["at"]).toBe(FIXED);
    }
  });

  it("(18) `shell --help` documents the guarded-REPL honesty contract and does NOT execute the REPL", async () => {
    const outChunks: string[] = [];
    const collect = new Writable({
      write(chunk, _encoding, callback) {
        outChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        callback();
      },
    });
    const cli = new Cli({ binaryName: "viberevert" });
    cli.register(Builtins.HelpCommand);
    cli.register(ShellCommand);
    const stdinStub = new PassThrough();
    stdinStub.end();
    const exitCode = await cli.run(["shell", "--help"], {
      stdin: stdinStub,
      stdout: collect,
      stderr: collect,
    });

    // --help prints usage and exits 0 WITHOUT running execute() -- so no
    // session state is ever created.
    expect(exitCode).toBe(0);
    await expectNoSessionState();

    // Normalize whitespace so Clipanion's line-wrapping cannot split a
    // phrase across a wrap boundary (matrix #18 honesty lock).
    const help = outChunks.join("").replace(/\s+/g, " ");
    expect(help).toContain("guarded command loop");
    expect(help).toContain("not a transparent shell");
    expect(help).toContain("no shell expansion");
    expect(help).toContain("use sh -c / cmd /c for shell features");
  });

  it.skipIf(process.platform !== "win32")(
    "(19) Windows: spawning a .cmd directly -> EINVAL hint on stderr, loop continues, and the command IS logged",
    async () => {
      const cmdPath = join(tmpRoot, "test.cmd");
      await writeFile(cmdPath, "@echo off\r\nexit /b 0\r\n");
      const after = "require('fs').writeFileSync('after.txt','')";
      const result = await runShell([`"${cmdPath}"`, nodeLine(after), "exit"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Windows refuses .bat/.cmd with shell disabled");
      expect(result.stderr).toContain("cmd /c");
      // The loop continued; the next command ran.
      await expect(stat(join(tmpRoot, "after.txt"))).resolves.toBeDefined();
      // The .cmd command was accepted + logged before the failed spawn.
      const sessionId = await readSingleSessionId();
      const entries = await readCommandsLog(sessionId);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.["argv"]).toEqual([cmdPath]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "(20) POSIX: a child that kills itself with SIGTERM -> `[signal: SIGTERM]` on stderr, loop continues, shell exits 0",
    async () => {
      const after = "require('fs').writeFileSync('after.txt','')";
      const result = await runShell([
        nodeLine("process.kill(process.pid, 'SIGTERM')"),
        nodeLine(after),
        "exit",
      ]);

      expect(result.exitCode).toBe(0);
      // shell DISPLAYS the child's signal death and CONTINUES (a different
      // contract from run, which propagates 128+signal).
      expect(result.stderr).toContain("[signal: SIGTERM]");
      await expect(stat(join(tmpRoot, "after.txt"))).resolves.toBeDefined();
    },
  );
});
