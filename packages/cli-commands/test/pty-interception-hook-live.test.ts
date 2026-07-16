// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4 -- RUNTIME regression for the interception-hook prompt/descriptor
// lifecycle (surfaced by CI live-smoke, 2026-07-15). The DEBUG-trap's per-command
// loopback round-trip must NOT corrupt the interactive shell AND must NOT leak a
// file descriptor. The original hook used `exec {fd}<>/dev/tcp` inside the trap:
// that mutated the shell's fd table and left readline unable to re-render the
// prompt. A naive fix (block redirection `{...} {fd}<>...`) restores the prompt
// but LEAKS the socket fd every command (bash does not auto-close `{var}` fds on
// a compound command). Only the subshell form is both prompt-safe and leak-free.
//
// This drives REAL Bash in a REAL node-pty PTY with a minimal loopback "allow"
// parent and asserts, at runtime (not via generated-string properties):
//   * prompt -> executed marker -> SECOND prompt   (POSIX + Bash)
//   * after several allowed commands, the interactive shell's open-socket count
//     is UNCHANGED from a pre-command baseline   (Linux only, because
//     /proc/<pid>/fd is Linux-specific; baseline tolerates unrelated sockets)
// The two assertions together distinguish all three candidate implementations:
// original exec fails prompt-return; block redirection passes prompt-return but
// grows the socket count; the subshell passes both.
//
// Gated: POSIX + node-pty loadable + host shell resolves to Bash. Windows / no
// node-pty / non-Bash environments skip (the guarded PTY is Bash-only).

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PTY_INTERCEPTION_PROTOCOL_VERSION } from "../src/commands/pty-interception.js";
import { resolveAuditedCwd } from "../src/commands/pty-interception-audit.js";
import { generateBashInterceptionHook } from "../src/commands/pty-interception-hook.js";
import { loadPtyModule, type PtyModule, type PtyProcess } from "../src/commands/pty-loader.js";
import { resolveHostInteractiveShell } from "../src/commands/shell-pty.js";

const PROMPT = "viberevert$ ";
const MARKER_CMD = "echo VR_HOOK_$((6*7))_ok";
const MARKER_OUT = "VR_HOOK_42_ok";
const NONCE = "hookreturnnonce";

const PROMPT_DEADLINE_MS = 20_000;
const MARKER_DEADLINE_MS = 15_000;
const SECOND_PROMPT_DEADLINE_MS = 15_000;
const COMMAND_DEADLINE_MS = 15_000;
const EXIT_BACKSTOP_MS = 80_000;
const CLEANUP_EXIT_MS = 5_000;
const TEST_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 64_000;

/**
 * A guarded command that counts the interactive shell's OPEN socket descriptors
 * and prints them labelled. Pure builtins + a single readlink per fd (no pipe,
 * no persistent fd), so it does not itself create a lingering socket. The OUTPUT
 * begins `<label>=<digit>`, while the terminal-echoed command has `%s` after the
 * '=', so a digit-anchored match reads the output, not the echo.
 */
function socketFdProbe(label: string): string {
  return (
    '__c=0; for __p in /proc/$$/fd/*; do __t=$(readlink "$__p" 2>/dev/null || true); ' +
    'case "$__t" in socket:*) __c=$((__c + 1));; esac; done; ' +
    `printf '${label}=%s\\n' "$__c"`
  );
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

interface RecordedRequest {
  readonly id: string;
  readonly rawLine: string;
  readonly cwd: string;
}

interface AllowParentOptions {
  /**
   * OPT-IN: when set, the parent applies the REAL cwd validator against this repo
   * root and sends NO decision frame when it rejects. Omitted (the default) keeps
   * the established blanket-allow behavior every other live-hook test relies on.
   */
  readonly validateCwdAgainst?: string;
}

interface AllowParent {
  readonly port: number;
  requests: () => readonly RecordedRequest[];
  /**
   * Decision-frame write ATTEMPTS, incremented immediately BEFORE the write -- an
   * attempt whose callback never runs (socket closed first) still counts, so
   * "zero attempts" really proves the reject branch never tried to emit a frame,
   * rather than merely that no write completed.
   */
  decisionFrameWriteAttempts: () => number;
  close(): Promise<void>;
}

/**
 * A minimal loopback "allow" parent: connection-per-request, reads one framed
 * request line, records it, replies EXACTLY ONCE with the byte-exact allow
 * decision for that id, closes. Tracks live sockets so cleanup can destroy any
 * lingering connection before awaiting server close (a failed hook exchange must
 * not hang afterEach). With `validateCwdAgainst` it instead applies the REAL cwd
 * validator and closes with NO frame when the cwd is rejected.
 */
function startAllowParent(options: AllowParentOptions = {}): Promise<AllowParent> {
  const sockets = new Set<Socket>();
  const recorded: RecordedRequest[] = [];
  let decisionFrameWriteAttempts = 0;
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buf = "";
    let replied = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (replied) {
        return;
      }
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) {
        return;
      }
      replied = true;
      const line = buf.slice(0, nl);
      let id = "";
      let cwd = "";
      try {
        const parsed = JSON.parse(line) as { id?: unknown; rawLine?: unknown; cwd?: unknown };
        if (typeof parsed.id === "string") {
          id = parsed.id;
        }
        cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
        recorded.push({
          id,
          rawLine: typeof parsed.rawLine === "string" ? parsed.rawLine : "",
          cwd,
        });
      } catch {
        // malformed request -> empty id -> mismatched allow -> hook skips (safe)
      }
      // OPT-IN cwd validation. A rejected cwd -- or a validator that THROWS (a
      // harness-config problem) -- closes with NO frame, identically; no
      // exception may escape this server callback.
      if (options.validateCwdAgainst !== undefined) {
        let accepted = false;
        try {
          accepted = resolveAuditedCwd(cwd, options.validateCwdAgainst).ok;
        } catch {
          accepted = false;
        }
        if (!accepted) {
          socket.end();
          return;
        }
      }
      decisionFrameWriteAttempts += 1;
      socket.end(
        `{"protocolVersion":${PTY_INTERCEPTION_PROTOCOL_VERSION},"id":"${id}","kind":"allow"}\n`,
      );
    });
    socket.on("error", () => {
      // Bash may close its side abruptly after reading the reply; ignore.
    });
  });
  return new Promise((resolveStart, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("failed to obtain an ephemeral loopback port"));
        return;
      }
      resolveStart({
        port: addr.port,
        requests: () => recorded,
        decisionFrameWriteAttempts: () => decisionFrameWriteAttempts,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

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
          `[hook lifecycle] timed out waiting for ${phase} after ${deadlineMs}ms.\n--- output ---\n${diag()}`,
        ),
      );
    }, deadlineMs);
  });
}

/**
 * A single, race-safe exit promise. The onExit observer is attached IMMEDIATELY,
 * settles ONCE, and clears both the timer and the subscription on every outcome.
 * If onExit delivers SYNCHRONOUSLY (an already-exited child), settlement happens
 * before `sub` is assigned, so the subscription is disposed explicitly after
 * assignment. The backstop timer is unref'd so it can never hold the worker open.
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

    const registeredSub = child.onExit((event) => {
      settleExit({ exitCode: event.exitCode, signal: event.signal });
    });
    sub = registeredSub;

    // A synchronously delivered exit settled before `sub` was assigned above.
    if (settled) {
      sub.dispose();
      return;
    }

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`PTY did not exit within ${deadlineMs}ms`));
    }, deadlineMs);
    timer.unref?.();
  });
}

/** Bounded, non-failing wait for the child to actually terminate during cleanup. */
async function awaitCleanupExit(
  childExit: Promise<unknown>,
  deadlineMs = CLEANUP_EXIT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      childExit.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function resolveHostBash(): Promise<{ pty: PtyModule; bashPath: string } | null> {
  if (process.platform === "win32") {
    return null;
  }
  const pty = await loadPtyModule();
  if (pty === null) {
    return null;
  }
  const shell = resolveHostInteractiveShell();
  if (shell === null || shell.kind !== "bash") {
    return null;
  }
  return { pty, bashPath: shell.path };
}

let rcDir = "";
let parent: AllowParent | undefined;

afterEach(async () => {
  if (parent !== undefined) {
    await parent.close();
    parent = undefined;
  }
  if (rcDir) {
    await rm(rcDir, { recursive: true, force: true });
    rcDir = "";
  }
});

describe("interception hook -- interactive prompt + descriptor lifecycle (M G4 Step 4)", () => {
  it(
    "returns to the interactive Bash prompt after an allowed guarded command",
    async (ctx) => {
      const host = await resolveHostBash();
      if (host === null) {
        ctx.skip();
        return;
      }
      parent = await startAllowParent();

      const hook = generateBashInterceptionHook({
        nonce: NONCE,
        endpoint: `127.0.0.1:${parent.port}`,
      });
      rcDir = await mkdtemp(join(tmpdir(), "vr-hook-return-"));
      const rcPath = join(rcDir, "hook.rc");
      await writeFile(rcPath, `PS1='${PROMPT}'\nPROMPT_COMMAND=\n${hook}`, { mode: 0o600 });

      const child = host.pty.spawn(host.bashPath, ["--noprofile", "--rcfile", rcPath, "-i"], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: rcDir,
        env: { ...process.env, SHELL: host.bashPath },
      });

      // Attach the single exit observer BEFORE output collection (race-safe).
      const childExit = waitForPtyExit(child, EXIT_BACKSTOP_MS);
      let exitEvent: { exitCode: number; signal: number | undefined } | undefined;
      void childExit.then(
        (event) => {
          exitEvent = event;
        },
        () => {
          // backstop/kill: surfaced by the per-phase deadlines, not here
        },
      );

      let output = "";
      let truncated = false;
      const dataSub = child.onData((chunk) => {
        output += chunk;
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(-MAX_OUTPUT_CHARS);
          truncated = true;
        }
      });
      const diag = (): string =>
        `${truncated ? `[output truncated to last ${MAX_OUTPUT_CHARS} chars]\n` : ""}${output}`;

      try {
        await waitFor(
          () => output.includes(PROMPT) || exitEvent !== undefined,
          PROMPT_DEADLINE_MS,
          "initial guarded prompt",
          diag,
        );
        if (!output.includes(PROMPT)) {
          throw new Error(
            `child exited (code ${exitEvent?.exitCode}) before the guarded prompt.\n${diag()}`,
          );
        }

        // The allowed guarded command must actually EXECUTE (arithmetic-expanded
        // marker differs from the typed text, proving execution, not echo).
        child.write(`${MARKER_CMD}\r`);
        await waitFor(
          () => output.includes(MARKER_OUT) || exitEvent !== undefined,
          MARKER_DEADLINE_MS,
          "executed command marker",
          diag,
        );
        if (!output.includes(MARKER_OUT)) {
          throw new Error(
            `child exited (code ${exitEvent?.exitCode}) before the command marker.\n${diag()}`,
          );
        }

        // THE PROMPT REGRESSION: the interactive prompt must RETURN after the command.
        await waitFor(
          () => occurrences(output, PROMPT) >= 2 || exitEvent !== undefined,
          SECOND_PROMPT_DEADLINE_MS,
          "returned guarded prompt",
          diag,
        );
        expect(
          occurrences(output, PROMPT),
          "Bash must return to the interactive prompt after an allowed guarded command",
        ).toBeGreaterThanOrEqual(2);

        // THE DESCRIPTOR REGRESSION (Linux only -- /proc/<pid>/fd is Linux-specific):
        // the open-socket count must not GROW across several allowed commands.
        // Baseline first so unrelated pre-existing sockets are tolerated.
        if (process.platform === "linux") {
          // Each probe waits for BOTH the labelled result AND a returned prompt,
          // so the guarded command has fully completed before the next write.
          const readCount = async (label: string, phase: string): Promise<number> => {
            const promptsBefore = occurrences(output, PROMPT);
            const pattern = new RegExp(`${label}=(\\d+)`);
            child.write(`${socketFdProbe(label)}\r`);
            await waitFor(
              () =>
                (pattern.test(output) && occurrences(output, PROMPT) > promptsBefore) ||
                exitEvent !== undefined,
              COMMAND_DEADLINE_MS,
              `${phase} and returned prompt`,
              diag,
            );
            if (exitEvent !== undefined) {
              throw new Error(
                `child exited (code ${exitEvent.exitCode}) during ${phase}.\n${diag()}`,
              );
            }
            const match = pattern.exec(output);
            expect(match, `${phase} should report a socket count`).not.toBeNull();
            return Number(match?.[1]);
          };

          const baseline = await readCount("VR_SOCKET_BASELINE", "baseline socket count");
          for (let i = 0; i < 3; i += 1) {
            const before = occurrences(output, PROMPT);
            child.write(`echo VR_LEAK_PROBE_${i}\r`);
            await waitFor(
              () => occurrences(output, PROMPT) > before || exitEvent !== undefined,
              COMMAND_DEADLINE_MS,
              `leak-probe command ${i} prompt`,
              diag,
            );
            if (exitEvent !== undefined) {
              throw new Error(
                `child exited (code ${exitEvent.exitCode}) during leak probing.\n${diag()}`,
              );
            }
          }
          const final = await readCount("VR_SOCKET_FINAL", "final socket count");
          expect(
            final,
            "no interception socket fd may accumulate across guarded commands (descriptor leak)",
          ).toBe(baseline);
        }

        child.write("exit\r");
        const finalExit = await childExit;
        expect(finalExit.exitCode).toBe(0);
      } finally {
        dataSub.dispose();
        if (exitEvent === undefined) {
          try {
            child.kill();
          } catch {
            // best-effort cleanup only
          }
        }
        await awaitCleanupExit(childExit);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "frames a newline-containing cwd as ONE protocol line, and never allows the invalid cwd",
    async (ctx) => {
      const host = await resolveHostBash();
      if (host === null) {
        ctx.skip();
        return;
      }

      rcDir = await mkdtemp(join(tmpdir(), "vr-hook-cwd-"));
      // A directory whose NAME contains a real newline (legal on POSIX, and
      // impossible to type into `cd`, so the PTY is spawned directly inside it).
      const newlineDir = join(rcDir, `nl${String.fromCharCode(0x0a)}dir`);
      await mkdir(newlineDir);
      // Bash sets $PWD from getcwd() at startup, which is PHYSICAL (e.g. macOS
      // /tmp -> /private/tmp). Compare + validate against realpath'd paths so
      // containment is satisfied and the NEWLINE is the sole rejection cause.
      const expectedCwd = await realpath(newlineDir);
      const activeParent = await startAllowParent({ validateCwdAgainst: await realpath(rcDir) });
      parent = activeParent;

      const hook = generateBashInterceptionHook({
        nonce: NONCE,
        endpoint: `127.0.0.1:${activeParent.port}`,
      });
      const rcPath = join(rcDir, "hook.rc");
      await writeFile(rcPath, `PS1='${PROMPT}'\nPROMPT_COMMAND=\n${hook}`, { mode: 0o600 });

      const child = host.pty.spawn(host.bashPath, ["--noprofile", "--rcfile", rcPath, "-i"], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: newlineDir,
        env: { ...process.env, SHELL: host.bashPath },
      });

      const childExit = waitForPtyExit(child, EXIT_BACKSTOP_MS);
      let exitEvent: { exitCode: number; signal: number | undefined } | undefined;
      void childExit.then(
        (event) => {
          exitEvent = event;
        },
        () => {
          // backstop/kill: surfaced by the per-phase deadlines, not here
        },
      );

      let output = "";
      let truncated = false;
      const dataSub = child.onData((chunk) => {
        output += chunk;
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(-MAX_OUTPUT_CHARS);
          truncated = true;
        }
      });
      const diag = (): string =>
        `${truncated ? `[output truncated to last ${MAX_OUTPUT_CHARS} chars]\n` : ""}${output}`;

      // Set only if the cleanup backstop has to kill the child, i.e. the shell did
      // NOT exit on its own -- asserted after the finally.
      let forceKill = false;

      try {
        await waitFor(
          () => output.includes(PROMPT) || exitEvent !== undefined,
          PROMPT_DEADLINE_MS,
          "initial guarded prompt",
          diag,
        );
        if (!output.includes(PROMPT)) {
          throw new Error(
            `child exited (code ${exitEvent?.exitCode}) before the guarded prompt.\n${diag()}`,
          );
        }

        child.write(`${MARKER_CMD}\r`);
        await waitFor(
          () => activeParent.requests().length >= 1 || exitEvent !== undefined,
          COMMAND_DEADLINE_MS,
          "the hook's interception request",
          diag,
        );

        // ONE well-formed protocol line: the newline was escaped INSIDE the JSON
        // string (never splitting the frame) and survives parsing as a real newline.
        const received = activeParent.requests();
        expect(received).toHaveLength(1);
        expect(received[0]?.cwd).toBe(expectedCwd);
        expect(received[0]?.cwd.includes("\n")).toBe(true);
        expect(received[0]?.rawLine).toBe(MARKER_CMD);

        // THE SECURITY ASSERTION: the reject branch never even ATTEMPTED a frame
        // (proved directly, not inferred from the missing marker -- a malformed or
        // block frame would also stop execution while breaking this contract).
        expect(activeParent.decisionFrameWriteAttempts()).toBe(0);

        // No frame -> the hook reads EOF -> fails closed: the command must NOT
        // execute, and the shell must stay usable (prompt returns).
        await waitFor(
          () => occurrences(output, PROMPT) >= 2 || exitEvent !== undefined,
          SECOND_PROMPT_DEADLINE_MS,
          "returned prompt after the skipped command",
          diag,
        );
        expect(output).not.toContain(MARKER_OUT);

        // The `exit` BUILTIN is a command too: it passes through the same DEBUG
        // trap and is also blocked while the cwd stays invalid. Pinned on purpose
        // -- there is NO lifecycle exemption, and none may slip in unnoticed.
        child.write("exit\r");
        await waitFor(
          () => activeParent.requests().length >= 2 || exitEvent !== undefined,
          COMMAND_DEADLINE_MS,
          "the hook's interception request for the exit builtin",
          diag,
        );
        await waitFor(
          () => occurrences(output, PROMPT) >= 3 || exitEvent !== undefined,
          SECOND_PROMPT_DEADLINE_MS,
          "returned prompt after the skipped exit builtin",
          diag,
        );
        // Exactly one more request, and STILL no decision frame ever attempted.
        expect(activeParent.requests()).toHaveLength(2);
        expect(activeParent.decisionFrameWriteAttempts()).toBe(0);

        // EOF is NOT a command, so it is never intercepted -- the supported
        // non-command way out of a shell whose audit prerequisite cannot be
        // satisfied.
        child.write("\x04");
        await childExit; // resolves => the shell exited; no backstop timeout
      } finally {
        dataSub.dispose();
        if (exitEvent === undefined) {
          forceKill = true;
          try {
            child.kill();
          } catch {
            // best-effort cleanup only
          }
        }
        await awaitCleanupExit(childExit);
      }
      // Natural teardown: the shell exited on EOF, so the cleanup backstop never
      // had to force-kill it.
      expect(forceKill).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
