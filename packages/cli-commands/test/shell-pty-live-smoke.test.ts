// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4f RELEASE GATE: one live, end-to-end round-trip of the PUBLIC
// `viberevert shell --pty` command. It spawns the BUILT CLI bin
// (packages/cli/dist/index.js) inside a real node-pty PTY, in a real git repo,
// and drives: guarded prompt -> a benign guarded command that actually EXECUTES
// -> the guarded prompt returns -> `exit` -> clean process termination (code 0).
//
// Prerequisites are decided BEFORE launch; each missing one is a LOGGED SKIP:
// POSIX platform; node-pty loadable; host shell resolves to Bash;
// resolveHostInteractiveShell guarantees an ABSOLUTE + re-verified EXECUTABLE
// path; the environment can allocate + cleanly run a trivial PTY (probe exits 0);
// git available; built CLI entry present. Once the CLI child launches, NOTHING
// skips: a missing prompt, unexpected interceptor refusal, missing marker,
// missing second prompt, early/abnormal exit, or teardown needing a force-kill
// all FAIL, with per-phase deadlines. This box (Windows / node-pty absent) skips;
// CI Linux is the first environment expected to execute the round-trip, and 4f
// is not complete until it does.
//
// Freshness: existsSync(CLI_ENTRY) proves presence, not freshness. The CI Linux
// job builds packages/cli/dist/index.js in the SAME job (checkout -> install ->
// lint -> typecheck -> build -> test, no restored artifact) before this test
// runs, so the entry is freshly produced in that run. The RUN + PASS log lines
// (bash path, built entry, node-pty availability, initial prompt, executed
// marker, returned prompt, exit code, no force-kill, no failure copy, no REPL
// fallback) are the 4f release-gate evidence.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { loadPtyModule, type PtyModule, type PtyProcess } from "../src/commands/pty-loader.js";
import { resolveHostInteractiveShell } from "../src/commands/shell-pty.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(TEST_DIR, "..", "..", "cli", "dist", "index.js");

const PROMPT = "viberevert$ ";
// A benign command whose OUTPUT (VR_SMOKE_42_9c3f) differs from the typed text
// (`$((6*7))`), so finding it proves Bash EXECUTED the command (the interceptor
// allowed it), not that the terminal merely echoed the keystrokes.
const MARKER_CMD = "echo VR_SMOKE_$((6*7))_9c3f";
const MARKER_OUT = "VR_SMOKE_42_9c3f";

const PROBE_DEADLINE_MS = 10_000;
const PROMPT_DEADLINE_MS = 30_000;
const MARKER_DEADLINE_MS = 15_000;
const SECOND_PROMPT_DEADLINE_MS = 15_000;
const EXIT_DEADLINE_MS = 15_000;
const CHILD_EXIT_BACKSTOP_MS = 100_000;
const TEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 64_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One stable output seam for release-gate evidence. Raw process.stdout.write is
// visible in `vitest run`, whereas console.log is intercepted by the configured
// runner and not emitted; the explicit trailing newline keeps evidence lines from
// merging with reporter output under parallel runs. (Test-harness output only --
// D99.M.20's src-output routing does not apply to test files.)
function reportEvidence(message: string): void {
  process.stdout.write(`${message}\n`);
}

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Resolve when `predicate()` holds, or REJECT (fail) at the deadline with diagnostics. */
function waitFor(
  predicate: () => boolean,
  deadlineMs: number,
  phase: string,
  diag: () => string,
): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (predicate()) {
      resolveWait();
      return;
    }
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        clearTimeout(timer);
        resolveWait();
      }
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(
        new Error(
          `[shell --pty live smoke] timed out waiting for ${phase} after ${deadlineMs}ms.\n` +
            `--- recent output ---\n${diag()}`,
        ),
      );
    }, deadlineMs);
  });
}

/**
 * A single, race-safe exit promise: the onExit observer is attached IMMEDIATELY
 * (so an exit during setup is not missed), it settles ONCE, and clears both the
 * timer and the subscription on every outcome. Handles are predeclared so a
 * synchronous onExit (an already-exited child) cannot hit the temporal dead zone,
 * and the timer is not installed at all if onExit settled synchronously. The
 * backstop timer is unref'd so it can never hold the test worker open after the
 * test has otherwise settled.
 */
function waitForPtyExit(
  child: PtyProcess,
  deadlineMs: number,
): Promise<{ exitCode: number; signal: number | undefined }> {
  return new Promise((resolveExit, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sub: { dispose(): void } | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      sub?.dispose();
    };

    const settleExit = (event: { exitCode: number; signal: number | undefined }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveExit(event);
    };

    sub = child.onExit((event) => {
      settleExit({ exitCode: event.exitCode, signal: event.signal });
    });

    // Do not install a timer if onExit already settled synchronously.
    if (!settled) {
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error(`PTY did not exit within ${deadlineMs}ms`));
      }, deadlineMs);
      // Unref so an orphaned backstop timer cannot hold the Vitest worker open.
      timer.unref?.();
    }
  });
}

type Prereq =
  | { readonly ok: true; readonly pty: PtyModule; readonly bashPath: string }
  | { readonly ok: false; readonly reason: string };

/** Allocate + cleanly run a trivial PTY (bash -lc "exit 0"); prove exit code 0. */
async function probePtyAllocation(
  pty: PtyModule,
  bashPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let probe: PtyProcess;
  try {
    probe = pty.spawn(bashPath, ["-lc", "exit 0"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: { ...process.env, SHELL: bashPath },
    });
  } catch (err) {
    return { ok: false, reason: `PTY allocation failed at spawn: ${messageOf(err)}` };
  }
  try {
    const exit = await waitForPtyExit(probe, PROBE_DEADLINE_MS);
    if (exit.exitCode !== 0) {
      return { ok: false, reason: `PTY probe exited ${exit.exitCode} (expected 0)` };
    }
    return { ok: true };
  } catch (err) {
    try {
      probe.kill();
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, reason: `PTY probe did not exit cleanly: ${messageOf(err)}` };
  }
}

/** Decide -- BEFORE any product launch -- whether this environment can run the round-trip. */
async function checkPrerequisites(): Promise<Prereq> {
  if (process.platform === "win32") {
    return {
      ok: false,
      reason:
        "platform is win32 (public --pty resolves PowerShell; the bash-only installer refuses)",
    };
  }
  const pty = await loadPtyModule();
  if (pty === null) {
    return { ok: false, reason: "node-pty unavailable / failed to load (loadPtyModule() -> null)" };
  }
  // resolveHostInteractiveShell guarantees an ABSOLUTE, re-verified EXECUTABLE path
  // (or null); we additionally require it to be Bash (the only supported shell).
  const shell = resolveHostInteractiveShell();
  if (shell === null || shell.kind !== "bash") {
    return {
      ok: false,
      reason: `host interactive shell is not Bash (resolved: ${shell === null ? "none" : shell.kind})`,
    };
  }
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    return { ok: false, reason: "git is unavailable (needed for the session checkpoint)" };
  }
  if (!existsSync(CLI_ENTRY)) {
    return {
      ok: false,
      reason: `built CLI entry missing at ${CLI_ENTRY} (run \`pnpm build\` first)`,
    };
  }
  const probe = await probePtyAllocation(pty, shell.path);
  if (!probe.ok) {
    return { ok: false, reason: probe.reason };
  }
  return { ok: true, pty, bashPath: shell.path };
}

/** No installer refusal, no engine error, and no silent REPL fallback in the output. */
function assertNoFailureCopy(output: string): void {
  expect(output).not.toContain("could not install");
  expect(output).not.toContain("only supports bash command interception");
  expect(output).not.toContain("PTY command interception returned an invalid installation result");
  expect(output).not.toContain("Unexpected error installing PTY command interception");
  expect(output).not.toContain("Error in PTY shell:");
  expect(output).not.toContain("Error tearing down PTY");
  expect(output).not.toContain("viberevert> "); // REPL prompt = silent fallback
}

let repoDir = "";

afterEach(async () => {
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true });
    repoDir = "";
  }
});

describe("viberevert shell --pty -- live PTY round-trip (M G4 Step 4f release gate)", () => {
  it(
    "opens a guarded Bash prompt, runs a benign guarded command, and exits cleanly",
    async (ctx) => {
      const prereq = await checkPrerequisites();
      if (!prereq.ok) {
        reportEvidence(`[shell --pty live smoke] SKIP: ${prereq.reason}`);
        ctx.skip();
        return;
      }
      reportEvidence(
        `[shell --pty live smoke] RUN: bash=${prereq.bashPath} cliEntry=${CLI_ENTRY} node-pty=available`,
      );

      // A real git repo with a .viberevert.yml (the session opens a checkpoint).
      repoDir = await mkdtemp(join(tmpdir(), "vr-pty-smoke-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "smoke@example.test"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "smoke"], { cwd: repoDir });
      await writeFile(join(repoDir, ".gitignore"), ".viberevert/\n");
      await writeFile(join(repoDir, ".viberevert.yml"), "version: 1\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

      // Bounded rolling buffer (a runaway child cannot exhaust memory before a deadline).
      let output = "";
      let truncated = false;
      const appendOutput = (chunk: string): void => {
        output += chunk;
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(-MAX_OUTPUT_CHARS);
          truncated = true;
        }
      };
      const diag = (): string =>
        `${truncated ? `[output truncated to last ${MAX_OUTPUT_CHARS} chars]\n` : ""}${output}`;

      const child = prereq.pty.spawn(process.execPath, [CLI_ENTRY, "shell", "--pty"], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: repoDir,
        env: { ...process.env, SHELL: prereq.bashPath },
      });
      // Attach the exit observer IMMEDIATELY (race-safe); record the event for the
      // phase predicates. The backstop deadline only prevents a dangling promise;
      // the per-phase waitFors are the real failure signals.
      let exitEvent: { exitCode: number; signal: number | undefined } | undefined;
      const childExit = waitForPtyExit(child, CHILD_EXIT_BACKSTOP_MS);
      void childExit.then(
        (e) => {
          exitEvent = e;
        },
        () => {
          /* backstop timeout: surfaced by the phase/exit deadlines, not here */
        },
      );
      const dataSub = child.onData(appendOutput);

      try {
        // Phase 1: the guarded prompt (proves the interceptor RC actually loaded).
        await waitFor(
          () => output.includes(PROMPT) || exitEvent !== undefined,
          PROMPT_DEADLINE_MS,
          "guarded prompt",
          diag,
        );
        if (!output.includes(PROMPT)) {
          throw new Error(
            `[live smoke] child exited (code ${exitEvent?.exitCode}) before the guarded prompt.\n${diag()}`,
          );
        }
        assertNoFailureCopy(output);

        // Phase 2: a benign guarded command actually executes (arithmetic expansion).
        child.write(`${MARKER_CMD}\r`);
        await waitFor(
          () => output.includes(MARKER_OUT) || exitEvent !== undefined,
          MARKER_DEADLINE_MS,
          "command marker",
          diag,
        );
        if (!output.includes(MARKER_OUT)) {
          throw new Error(
            `[live smoke] child exited (code ${exitEvent?.exitCode}) before the command marker.\n${diag()}`,
          );
        }

        // Phase 3: the guarded prompt returns (the command lifecycle completed and we
        // are back at the prompt before sending exit).
        await waitFor(
          () => occurrenceCount(output, PROMPT) >= 2 || exitEvent !== undefined,
          SECOND_PROMPT_DEADLINE_MS,
          "guarded prompt after command",
          diag,
        );
        if (occurrenceCount(output, PROMPT) < 2) {
          throw new Error(
            `[live smoke] child exited (code ${exitEvent?.exitCode}) before the prompt returned.\n${diag()}`,
          );
        }

        // Phase 4: the CLI PROCESS itself exits after PTY teardown -- proves no
        // handle (flowing stdin, node-pty, interception server/socket) survives
        // teardown to block clipanion's natural (process.exit-free) drain.
        child.write("exit\r");
        await waitFor(
          () => exitEvent !== undefined,
          EXIT_DEADLINE_MS,
          "CLI process exit after PTY teardown",
          diag,
        );
        expect(exitEvent?.exitCode).toBe(0);

        // Final: no fail-closed copy / REPL fallback surfaced anywhere in the run.
        assertNoFailureCopy(output);

        // Affirmative round-trip evidence for the 4f release-gate closeout.
        reportEvidence(
          `[shell --pty live smoke] PASS: ` +
            `bash=${prereq.bashPath} ` +
            `cliEntry=${CLI_ENTRY} ` +
            `node-pty=available ` +
            `initialPrompt=observed ` +
            `marker=${MARKER_OUT} ` +
            `secondPrompt=observed ` +
            `exitCode=${exitEvent?.exitCode} ` +
            `forceKill=false ` +
            `failureCopies=absent ` +
            `replFallback=absent`,
        );
      } finally {
        dataSub.dispose();
        // Force-kill is a cleanup safety net ONLY; if it was needed, the exit
        // deadline above already failed the test.
        if (exitEvent === undefined) {
          try {
            child.kill();
          } catch {
            /* best-effort */
          }
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
