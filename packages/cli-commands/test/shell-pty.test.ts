// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the PTY engine: host wiring, precondition gate, and the raw
// terminal bridge (M G4 Step 3c). All take injected deps / fake streams+pty --
// deterministic, no live PTY / native PTY module / TTY / fs.

import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  NoActiveSessionError,
  RepoRootNotFoundError,
  SessionAlreadyActiveError,
} from "@viberevert/core";
import { describe, expect, it } from "vitest";
import type {
  PtyDisposable,
  PtyModule,
  PtyProcess,
  PtySpawnOptions,
} from "../src/commands/pty-loader.js";
import {
  attachTerminalBridge,
  createG3BackedPtyShellSession,
  createRunPtyShellDeps,
  createScopedSignalCleanup,
  evaluatePtyPreconditions,
  type G3BackedPtyShellSessionOps,
  type PtyBridgeStreams,
  type PtyExitResult,
  type PtyShellContext,
  type PtyShellSession,
  type PtyShellSessionClose,
  type PtyShellSessionOpen,
  type ResolvedInteractiveShell,
  type RunPtyShellDeps,
  type RunPtyShellFactoryContext,
  resolveHostInteractiveShell,
  runPtyShell,
  type SignalSource,
  type TerminalBridge,
  type TerminalBridgeDisposeResult,
} from "../src/commands/shell-pty.js";
import { truncateIdForDisplay } from "../src/format.js";
import { ConcurrentOperationError } from "../src/locks.js";
import { EndSessionRaceError } from "../src/operations/end-session.js";
import { START_LOCK_REL } from "../src/operations/start-session.js";
import { RuntimeEnvInvalidError } from "../src/runtime-env.js";

/**
 * Build a fake `resolveExecutablePath` that models the real one: each
 * `[input, resolved]` entry maps the bare/absolute input to its resolved path,
 * AND every resolved (exact) path resolves to itself (an absolute executable
 * verifies as itself). Anything else -> null.
 */
function resolverFromEntries(
  entries: readonly [string, string][],
): (file: string) => string | null {
  const byInput = new Map(entries);
  const exactPaths = new Set(entries.map(([, resolved]) => resolved));
  return (file) => {
    if (byInput.has(file)) {
      return byInput.get(file) ?? null;
    }
    return exactPaths.has(file) ? file : null;
  };
}

const noopDisposable: PtyDisposable = { dispose: () => undefined };
const fakePtyProcess: PtyProcess = {
  write: () => undefined,
  resize: () => undefined,
  kill: () => undefined,
  onData: () => noopDisposable,
  onExit: () => noopDisposable,
};
const fakePty: PtyModule = { spawn: () => fakePtyProcess };
const fakeShell: ResolvedInteractiveShell = { path: "/bin/bash", args: ["-i"], kind: "bash" };

/** A recording fake PtyProcess with capturable onData/onExit and optional throws. */
function createFakePty(
  opts: {
    writeThrows?: boolean;
    killThrows?: boolean;
    onDataThrows?: boolean;
    resizeThrows?: boolean;
  } = {},
) {
  const writes: string[] = [];
  const resizes: [number, number][] = [];
  let killed = 0;
  let dataDisposed = 0;
  let exitDisposed = 0;
  let dataCb: ((data: string) => void) | undefined;
  let exitCb: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  const pty: PtyProcess = {
    write: (data) => {
      if (opts.writeThrows) {
        throw new Error("pty.write failed");
      }
      writes.push(data);
    },
    resize: (columns, rows) => {
      if (opts.resizeThrows) {
        throw new Error("pty.resize failed");
      }
      resizes.push([columns, rows]);
    },
    kill: () => {
      if (opts.killThrows) {
        throw new Error("pty.kill failed");
      }
      killed += 1;
    },
    onData: (cb) => {
      if (opts.onDataThrows) {
        throw new Error("pty.onData failed");
      }
      dataCb = cb;
      return {
        dispose: () => {
          dataDisposed += 1;
        },
      };
    },
    onExit: (cb) => {
      exitCb = cb;
      return {
        dispose: () => {
          exitDisposed += 1;
        },
      };
    },
  };

  return {
    pty,
    writes,
    resizes,
    killCount: () => killed,
    dataDisposeCount: () => dataDisposed,
    exitDisposeCount: () => exitDisposed,
    emitData: (data: string) => dataCb?.(data),
    emitExit: (event: { exitCode: number; signal?: number }) => exitCb?.(event),
  };
}

/** A recording fake PtyBridgeStreams with capturable data/resize listeners. */
function createFakeStreams(
  opts: {
    initialRaw?: boolean;
    columns?: number;
    rows?: number;
    stdoutWriteThrows?: boolean;
    setRawModeThrowsOnTrue?: boolean;
    setRawModeThrowsOnFalse?: boolean;
  } = {},
) {
  const setRawModeCalls: boolean[] = [];
  const stdoutWrites: string[] = [];
  let stdinRemoved = 0;
  let stdoutRemoved = 0;
  let dataListener: ((data: Buffer | string) => void) | undefined;
  let resizeListener: (() => void) | undefined;

  const streams: PtyBridgeStreams = {
    stdin: {
      isRaw: opts.initialRaw ?? false,
      setRawMode: (mode) => {
        setRawModeCalls.push(mode);
        if (opts.setRawModeThrowsOnTrue && mode) {
          throw new Error("setRawMode(true) failed");
        }
        if (opts.setRawModeThrowsOnFalse && !mode) {
          throw new Error("setRawMode(false) failed");
        }
      },
      on: (_event, listener) => {
        dataListener = listener;
      },
      removeListener: () => {
        stdinRemoved += 1;
      },
    },
    stdout: {
      // Omit columns/rows when undefined (exactOptionalPropertyTypes): a
      // size-less stream has them ABSENT, not present-with-undefined.
      ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
      ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      write: (data) => {
        if (opts.stdoutWriteThrows) {
          throw new Error("stdout.write failed");
        }
        stdoutWrites.push(data);
      },
      on: (_event, listener) => {
        resizeListener = listener;
      },
      removeListener: () => {
        stdoutRemoved += 1;
      },
    },
  };

  return {
    streams,
    setRawModeCalls,
    stdoutWrites,
    stdinRemovedCount: () => stdinRemoved,
    stdoutRemovedCount: () => stdoutRemoved,
    emitStdinData: (data: Buffer | string) => dataListener?.(data),
    emitResize: () => resizeListener?.(),
  };
}

describe("resolveHostInteractiveShell -- resolver + path resolver via one seam", () => {
  it("resolves a POSIX bash to its exact path", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
      resolveExecutablePath: resolverFromEntries([["bash", "/bin/bash"]]),
    });
    expect(result).toEqual({ path: "/bin/bash", args: ["-i"], kind: "bash" });
  });

  it("resolves an absolute non-bash $SHELL to its exact path (kind posix)", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { SHELL: "/usr/bin/zsh", PATH: "/usr/bin" },
      resolveExecutablePath: resolverFromEntries([["/usr/bin/zsh", "/usr/bin/zsh"]]),
    });
    expect(result).toEqual({ path: "/usr/bin/zsh", args: ["-i"], kind: "posix" });
  });

  it("prefers pwsh on Windows and resolves its exact path", () => {
    const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const result = resolveHostInteractiveShell({
      platform: "win32",
      env: {},
      resolveExecutablePath: resolverFromEntries([["pwsh", pwshPath]]),
    });
    expect(result).toEqual({ path: pwshPath, args: ["-NoLogo"], kind: "powershell" });
  });

  it("falls back to powershell.exe on Windows when pwsh is absent", () => {
    const psPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const result = resolveHostInteractiveShell({
      platform: "win32",
      env: {},
      resolveExecutablePath: resolverFromEntries([["powershell.exe", psPath]]),
    });
    expect(result).toEqual({ path: psPath, args: ["-NoLogo"], kind: "powershell" });
  });

  it("returns null when no suitable shell is available", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: {},
      resolveExecutablePath: resolverFromEntries([]),
    });
    expect(result).toBeNull();
  });

  it("treats undefined SHELL as omitted when adapting ProcessEnv for the pure resolver", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { SHELL: undefined, PATH: "/bin" },
      resolveExecutablePath: resolverFromEntries([["bash", "/bin/bash"]]),
    });
    expect(result).toEqual({ path: "/bin/bash", args: ["-i"], kind: "bash" });
  });

  it("returns the same path that availability approved, not a later PATH candidate", () => {
    let bashCalls = 0;
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
      resolveExecutablePath: (file) => {
        if (file === "bash") {
          bashCalls += 1;
          return bashCalls === 1 ? "/usr/bin/bash" : "/bin/bash";
        }
        return file === "/usr/bin/bash" ? "/usr/bin/bash" : null;
      },
    });
    expect(result).toEqual({ path: "/usr/bin/bash", args: ["-i"], kind: "bash" });
  });

  it("refuses if the approved exact path no longer verifies", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { PATH: "/bin" },
      resolveExecutablePath: (file) => {
        if (file === "bash") {
          return "/bin/bash";
        }
        return null; // exact /bin/bash verification fails
      },
    });
    expect(result).toBeNull();
  });
});

describe("evaluatePtyPreconditions -- pre-spawn gate", () => {
  it("refuses not_tty first, before loading the PTY module or resolving a shell", async () => {
    let loadCalls = 0;
    let shellCalls = 0;

    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => false,
      loadPtyModule: async () => {
        loadCalls += 1;
        return fakePty;
      },
      resolveHostShell: () => {
        shellCalls += 1;
        return fakeShell;
      },
    });

    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("not_tty");
      expect(result.exitCode).toBe(1);
    }
    expect(loadCalls).toBe(0);
    expect(shellCalls).toBe(0);
  });

  it("refuses pty_unavailable when the PTY module is absent", async () => {
    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => null,
      resolveHostShell: () => fakeShell,
    });
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("pty_unavailable");
      expect(result.exitCode).toBe(1);
    }
  });

  it("refuses pty_unavailable (fail-closed) when the loader throws", async () => {
    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => {
        throw new Error("native binding blew up");
      },
      resolveHostShell: () => fakeShell,
    });
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("pty_unavailable");
      expect(result.exitCode).toBe(1);
    }
  });

  it("refuses no_shell when no suitable shell resolves", async () => {
    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => fakePty,
      resolveHostShell: () => null,
    });
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("no_shell");
      expect(result.exitCode).toBe(1);
    }
  });

  it("checks the PTY module before the shell (pty_unavailable short-circuits no_shell)", async () => {
    let shellCalls = 0;

    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => null,
      resolveHostShell: () => {
        shellCalls += 1;
        return null;
      },
    });

    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("pty_unavailable");
    }
    expect(shellCalls).toBe(0);
  });

  it("proceeds with the loaded PTY module and resolved shell when all checks pass", async () => {
    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => fakePty,
      resolveHostShell: () => fakeShell,
    });
    expect(result.kind).toBe("proceed");
    if (result.kind === "proceed") {
      expect(result.pty).toBe(fakePty);
      expect(result.shell).toEqual(fakeShell);
    }
  });
});

describe("attachTerminalBridge -- raw passthrough + D104.I teardown", () => {
  it("applies an initial resize and re-resizes on resize events", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ columns: 100, rows: 40 });
    attachTerminalBridge(streams.streams, pty.pty);
    expect(pty.resizes).toEqual([[100, 40]]);
    streams.emitResize();
    expect(pty.resizes).toEqual([
      [100, 40],
      [100, 40],
    ]);
  });

  it("ignores resize when a dimension is zero", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ columns: 0, rows: 40 });
    attachTerminalBridge(streams.streams, pty.pty);
    streams.emitResize();
    expect(pty.resizes).toEqual([]);
  });

  it("ignores resize when dimensions are undefined", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({});
    attachTerminalBridge(streams.streams, pty.pty);
    streams.emitResize();
    expect(pty.resizes).toEqual([]);
  });

  it("forwards stdin (Buffer and string) to pty.write as utf8", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ columns: 80, rows: 24 });
    attachTerminalBridge(streams.streams, pty.pty);
    streams.emitStdinData(Buffer.from("hello", "utf8"));
    streams.emitStdinData("world");
    expect(pty.writes).toEqual(["hello", "world"]);
  });

  it("forwards pty output to stdout.write", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ columns: 80, rows: 24 });
    attachTerminalBridge(streams.streams, pty.pty);
    pty.emitData("output chunk");
    expect(streams.stdoutWrites).toEqual(["output chunk"]);
  });

  it("auto-disposes on normal exit: real exit result, raw restored, no kill", async () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ initialRaw: false, columns: 80, rows: 24 });
    const bridge = attachTerminalBridge(streams.streams, pty.pty);

    pty.emitExit({ exitCode: 0 });

    const exit = await bridge.waitForExit();
    expect(exit).toEqual({ exitCode: 0, signal: undefined });
    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(streams.stdinRemovedCount()).toBe(1);
    expect(streams.stdoutRemovedCount()).toBe(1);
    expect(pty.dataDisposeCount()).toBe(1);
    expect(pty.exitDisposeCount()).toBe(1);
    expect(pty.killCount()).toBe(0);

    // A later explicit dispose() is cached: same result, no repeated cleanup.
    const result = bridge.dispose();
    expect(result.errors).toEqual([]);
    expect(pty.exitDisposeCount()).toBe(1);
  });

  it("restores the previous raw state on dispose (initialRaw true -> true)", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ initialRaw: true, columns: 80, rows: 24 });
    const bridge = attachTerminalBridge(streams.streams, pty.pty);
    bridge.dispose();
    expect(streams.setRawModeCalls).toEqual([true, true]);
  });

  it("dispose before exit settles the fallback and kills the child", async () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ initialRaw: false, columns: 80, rows: 24 });
    const bridge = attachTerminalBridge(streams.streams, pty.pty);

    const result = bridge.dispose();

    const exit = await bridge.waitForExit();
    expect(exit).toEqual({ exitCode: 1, signal: undefined });
    expect(result.errors).toEqual([]);
    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(pty.killCount()).toBe(1);
  });

  it("fails closed when a handler throws: disposes, restores raw, kills, caches errors", async () => {
    const pty = createFakePty({ writeThrows: true });
    const streams = createFakeStreams({ initialRaw: false, columns: 80, rows: 24 });
    const bridge = attachTerminalBridge(streams.streams, pty.pty);

    streams.emitStdinData("x"); // pty.write throws -> failBridge -> disposeBridge

    const exit = await bridge.waitForExit();
    expect(exit).toEqual({ exitCode: 1, signal: undefined });
    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(pty.killCount()).toBe(1);

    const result = bridge.dispose();
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0] as Error).message).toBe("pty.write failed");
    // idempotent + cached: same object, no repeated cleanup.
    expect(bridge.dispose()).toBe(result);
    expect(pty.killCount()).toBe(1);
  });

  it("attempts all cleanup steps even if an early cleanup throws, and collects the error", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({
      initialRaw: false,
      columns: 80,
      rows: 24,
      setRawModeThrowsOnFalse: true,
    });
    const bridge = attachTerminalBridge(streams.streams, pty.pty);

    const result = bridge.dispose();

    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(streams.stdinRemovedCount()).toBe(1);
    expect(streams.stdoutRemovedCount()).toBe(1);
    expect(pty.dataDisposeCount()).toBe(1);
    expect(pty.exitDisposeCount()).toBe(1);
    expect(pty.killCount()).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0] as Error).message).toBe("setRawMode(false) failed");

    expect(bridge.dispose()).toBe(result);
    expect(pty.killCount()).toBe(1);
  });

  it("collects an error thrown by the final cleanup step (kill)", () => {
    const pty = createFakePty({ killThrows: true });
    const streams = createFakeStreams({ initialRaw: false, columns: 80, rows: 24 });
    const bridge = attachTerminalBridge(streams.streams, pty.pty);
    const result = bridge.dispose();
    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0] as Error).message).toBe("pty.kill failed");
  });

  it("rolls back transactionally (restores raw, kills) if a wire throws early during setup", () => {
    const pty = createFakePty({ onDataThrows: true });
    const streams = createFakeStreams({ initialRaw: false, columns: 80, rows: 24 });
    expect(() => attachTerminalBridge(streams.streams, pty.pty)).toThrow("pty.onData failed");
    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(streams.stdinRemovedCount()).toBe(1);
    expect(pty.killCount()).toBe(1);
  });

  it("rolls back fully if the initial resize throws after listeners/subscriptions are wired", () => {
    const pty = createFakePty({ resizeThrows: true });
    const streams = createFakeStreams({ initialRaw: false, columns: 80, rows: 24 });

    expect(() => attachTerminalBridge(streams.streams, pty.pty)).toThrow("pty.resize failed");

    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(streams.stdinRemovedCount()).toBe(1);
    expect(streams.stdoutRemovedCount()).toBe(1);
    expect(pty.dataDisposeCount()).toBe(1);
    expect(pty.exitDisposeCount()).toBe(1);
    expect(pty.killCount()).toBe(1);
  });

  it("attempts raw restoration and kills the child even if setRawMode(true) throws", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ initialRaw: false, setRawModeThrowsOnTrue: true });
    expect(() => attachTerminalBridge(streams.streams, pty.pty)).toThrow("setRawMode(true) failed");
    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(pty.killCount()).toBe(1);
  });

  it("is idempotent: repeated dispose returns the cached result without re-running cleanup", () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ initialRaw: false, columns: 80, rows: 24 });
    const bridge = attachTerminalBridge(streams.streams, pty.pty);
    const first = bridge.dispose();
    const second = bridge.dispose();
    expect(second).toBe(first);
    expect(streams.setRawModeCalls).toEqual([true, false]);
    expect(pty.killCount()).toBe(1);
    expect(pty.exitDisposeCount()).toBe(1);
  });

  it("handlers go inert after dispose (late stdin/output/exit are no-ops)", async () => {
    const pty = createFakePty();
    const streams = createFakeStreams({ initialRaw: false, columns: 80, rows: 24 });
    const bridge = attachTerminalBridge(streams.streams, pty.pty);
    bridge.dispose();

    streams.emitStdinData("late");
    pty.emitData("late output");
    pty.emitExit({ exitCode: 9 });

    expect(pty.writes).toEqual([]);
    expect(streams.stdoutWrites).toEqual([]);
    const exit = await bridge.waitForExit();
    expect(exit).toEqual({ exitCode: 1, signal: undefined });
  });
});

// ---------------------------------------------------------------------------
// runPtyShell orchestration fakes (all injected; no live PTY / native PTY module / fs)
// ---------------------------------------------------------------------------

const identitySignalCleanup: RunPtyShellDeps["withSignalCleanup"] = (_onSignal, run) => run();
const firingSignalCleanup: RunPtyShellDeps["withSignalCleanup"] = (onSignal, run) => {
  const pending = run();
  onSignal();
  return pending;
};

/** A recording PtyShellContext: stdout dims for spawn options + capturable stderr. */
function createFakeContext(opts: { columns?: number; rows?: number; stderrThrows?: boolean } = {}) {
  const stderrWrites: string[] = [];
  const context: PtyShellContext = {
    stdin: {
      setRawMode: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    },
    stdout: {
      // Omit dims when undefined (exactOptionalPropertyTypes): absent, not
      // present-with-undefined.
      ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
      ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      write: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    },
    stderr: {
      write: (data) => {
        if (opts.stderrThrows) {
          throw new Error("stderr.write failed");
        }
        stderrWrites.push(data);
      },
    },
  };
  return {
    context,
    stderrText: () => stderrWrites.join(""),
    stderrWriteCount: () => stderrWrites.length,
  };
}

/** A PtyModule that records spawn calls and returns a kill-recording child. */
function createSpawningPty(opts: { spawnThrows?: boolean; killThrows?: boolean } = {}) {
  const spawnCalls: {
    file: string;
    args: readonly string[] | undefined;
    options: PtySpawnOptions | undefined;
  }[] = [];
  let killCalls = 0;
  const child: PtyProcess = {
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      // Count the attempt, then throw: killCount() stays honest even when the
      // backstop kill fails.
      killCalls += 1;
      if (opts.killThrows) {
        throw new Error("child.kill failed");
      }
    },
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
  };
  const module: PtyModule = {
    spawn: (file, args, options) => {
      if (opts.spawnThrows) {
        throw new Error("pty.spawn failed");
      }
      spawnCalls.push({ file, args, options });
      return child;
    },
  };
  return { module, child, spawnCalls, killCount: () => killCalls };
}

/** A fake session port: open/close outcomes + call counts. */
function createFakeSession(
  opts: {
    open?: PtyShellSessionOpen;
    openThrows?: unknown;
    close?: PtyShellSessionClose;
    closeThrows?: unknown;
  } = {},
) {
  let openCalls = 0;
  let closeCalls = 0;
  const session: PtyShellSession = {
    open: async () => {
      openCalls += 1;
      if (opts.openThrows !== undefined) {
        throw opts.openThrows;
      }
      return opts.open ?? { kind: "opened", sessionId: "sess-1" };
    },
    close: async () => {
      closeCalls += 1;
      if (opts.closeThrows !== undefined) {
        throw opts.closeThrows;
      }
      return opts.close ?? { exitCode: 0, stderrText: "" };
    },
  };
  return { session, openCount: () => openCalls, closeCount: () => closeCalls };
}

/** A fake TerminalBridge: configurable exit / rejection / per-call dispose results. */
function createFakeBridge(
  opts: {
    exit?: PtyExitResult;
    rejects?: boolean;
    rejectError?: unknown;
    disposeResults?: readonly TerminalBridgeDisposeResult[];
    disposeThrows?: unknown;
  } = {},
) {
  let disposeCalls = 0;
  const disposeResults = opts.disposeResults ?? [{ errors: [] }];
  const bridge: TerminalBridge = {
    waitForExit: () =>
      opts.rejects === true
        ? Promise.reject(opts.rejectError ?? new Error("waitForExit rejected"))
        : Promise.resolve(opts.exit ?? { exitCode: 0, signal: undefined }),
    dispose: () => {
      const index = Math.min(disposeCalls, disposeResults.length - 1);
      disposeCalls += 1;
      if (opts.disposeThrows !== undefined) {
        throw opts.disposeThrows;
      }
      return disposeResults[index] ?? { errors: [] };
    },
  };
  return { bridge, disposeCount: () => disposeCalls };
}

/** Assemble RunPtyShellDeps with proceed-happy defaults; each test overrides seams. */
function baseDeps(over: Partial<RunPtyShellDeps> = {}): RunPtyShellDeps {
  return {
    context: over.context ?? createFakeContext().context,
    hasInteractiveTty: over.hasInteractiveTty ?? (() => true),
    loadPtyModule: over.loadPtyModule ?? (async () => fakePty),
    resolveHostShell: over.resolveHostShell ?? (() => fakeShell),
    attachBridge: over.attachBridge ?? (() => createFakeBridge().bridge),
    session: over.session ?? createFakeSession().session,
    cwd: over.cwd ?? "/repo",
    spawnEnv: over.spawnEnv ?? {},
    withSignalCleanup: over.withSignalCleanup ?? identitySignalCleanup,
  };
}

/** Count how many `Error in PTY shell:` lines were written to stderr. */
function driveErrorLineCount(stderr: string): number {
  return stderr.split("Error in PTY shell:").length - 1;
}

describe("runPtyShell -- orchestration (fully injected, no live PTY)", () => {
  it("refuses not_tty: exit 1, message, session never opened", async () => {
    const ctx = createFakeContext();
    const session = createFakeSession();
    const code = await runPtyShell(
      baseDeps({ context: ctx.context, hasInteractiveTty: () => false, session: session.session }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("requires an interactive terminal");
    expect(session.openCount()).toBe(0);
  });

  it("refuses pty_unavailable when the loader returns null: exit 1, session never opened", async () => {
    const ctx = createFakeContext();
    const session = createFakeSession();
    const code = await runPtyShell(
      baseDeps({ context: ctx.context, loadPtyModule: async () => null, session: session.session }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("optional native PTY dependency");
    expect(session.openCount()).toBe(0);
  });

  it("refuses no_shell when no shell resolves: exit 1, session never opened", async () => {
    const ctx = createFakeContext();
    const session = createFakeSession();
    const code = await runPtyShell(
      baseDeps({ context: ctx.context, resolveHostShell: () => null, session: session.session }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("could not find a suitable interactive shell");
    expect(session.openCount()).toBe(0);
  });

  it("surfaces an unexpected error preparing the gate (hasInteractiveTty throws)", async () => {
    const ctx = createFakeContext();
    const session = createFakeSession();
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        hasInteractiveTty: () => {
          throw new Error("tty probe blew up");
        },
        session: session.session,
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Unexpected error preparing PTY shell: tty probe blew up");
    expect(session.openCount()).toBe(0);
  });

  it("surfaces an unexpected error preparing the gate (resolveHostShell throws)", async () => {
    const ctx = createFakeContext();
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        resolveHostShell: () => {
          throw new Error("shell probe blew up");
        },
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Unexpected error preparing PTY shell: shell probe blew up");
  });

  it("writes the session's refusal text and returns its exit code without closing or spawning", async () => {
    const ctx = createFakeContext();
    const spawning = createSpawningPty();
    const session = createFakeSession({
      open: { kind: "refused", exitCode: 3, stderrText: "session busy\n" },
    });
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        loadPtyModule: async () => spawning.module,
        session: session.session,
      }),
    );
    expect(code).toBe(3);
    expect(ctx.stderrText()).toBe("session busy\n");
    expect(session.closeCount()).toBe(0);
    expect(spawning.spawnCalls).toHaveLength(0);
  });

  it("returns 1 and does not close when session.open throws", async () => {
    const ctx = createFakeContext();
    const session = createFakeSession({ openThrows: new Error("lock read failed") });
    const code = await runPtyShell(baseDeps({ context: ctx.context, session: session.session }));
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain(
      "Unexpected error starting PTY shell session: lock read failed",
    );
    expect(session.closeCount()).toBe(0);
  });

  it("formats a non-Error thrown by session.open", async () => {
    const ctx = createFakeContext();
    const session = createFakeSession({ openThrows: "boom" });
    const code = await runPtyShell(baseDeps({ context: ctx.context, session: session.session }));
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Unexpected error starting PTY shell session: boom");
  });

  it("formats an unprintable thrown value without rejecting", async () => {
    const ctx = createFakeContext();
    const unprintable = {
      toString: () => {
        throw new Error("toString failed");
      },
    };
    const session = createFakeSession({ openThrows: unprintable });
    const code = await runPtyShell(baseDeps({ context: ctx.context, session: session.session }));
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain(
      "Unexpected error starting PTY shell session: [unprintable thrown value]",
    );
  });

  it("happy path: spawns the resolved shell, drives the bridge, closes, returns 0", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const spawning = createSpawningPty();
    const fakeBridge = createFakeBridge({ exit: { exitCode: 0, signal: undefined } });
    const session = createFakeSession();
    const spawnEnv = { FOO: "bar" };
    let attachStreams: PtyBridgeStreams | undefined;
    let attachChild: PtyProcess | undefined;

    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        loadPtyModule: async () => spawning.module,
        attachBridge: (streams, child) => {
          attachStreams = streams;
          attachChild = child;
          return fakeBridge.bridge;
        },
        session: session.session,
        cwd: "/work",
        spawnEnv,
      }),
    );

    expect(code).toBe(0);
    expect(spawning.spawnCalls).toHaveLength(1);
    const call = spawning.spawnCalls[0];
    expect(call?.file).toBe("/bin/bash");
    expect(call?.args).toEqual(["-i"]);
    expect(call?.args).not.toBe(fakeShell.args); // copied, not the resolved array
    expect(call?.options).toEqual({ cwd: "/work", env: { FOO: "bar" }, cols: 80, rows: 24 });
    expect(call?.options?.env).not.toBe(spawnEnv); // env copied
    expect(attachStreams).toBe(ctx.context);
    expect(attachChild).toBe(spawning.child);
    expect(ctx.stderrText()).toBe("");
    expect(session.openCount()).toBe(1);
    expect(session.closeCount()).toBe(1);
  });

  it("displays a non-zero inner-shell exit but returns 0 (swallowed)", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () => createFakeBridge({ exit: { exitCode: 5, signal: undefined } }).bridge,
      }),
    );
    expect(code).toBe(0);
    expect(ctx.stderrText()).toContain("[exit: 5]");
  });

  it("displays a signal exit numerically but returns 0", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () => createFakeBridge({ exit: { exitCode: 0, signal: 15 } }).bridge,
      }),
    );
    expect(code).toBe(0);
    expect(ctx.stderrText()).toContain("[signal: 15]");
  });

  it("prints no status line on a clean zero exit", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const code = await runPtyShell(baseDeps({ context: ctx.context }));
    expect(code).toBe(0);
    expect(ctx.stderrText()).toBe("");
  });

  it("spawn throws: fails, still closes the session, returns 1, no kill", async () => {
    const ctx = createFakeContext();
    const spawning = createSpawningPty({ spawnThrows: true });
    const session = createFakeSession();
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        loadPtyModule: async () => spawning.module,
        session: session.session,
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Error in PTY shell: pty.spawn failed");
    expect(spawning.killCount()).toBe(0);
    expect(session.closeCount()).toBe(1);
  });

  it("attach throws: backstop-kills the child, closes, returns 1", async () => {
    const ctx = createFakeContext();
    const spawning = createSpawningPty();
    const session = createFakeSession();
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        loadPtyModule: async () => spawning.module,
        attachBridge: () => {
          throw new Error("attach boom");
        },
        session: session.session,
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Error in PTY shell: attach boom");
    expect(spawning.killCount()).toBe(1);
    expect(session.closeCount()).toBe(1);
  });

  it("attach throws and the backstop kill also throws: both errors reported", async () => {
    const ctx = createFakeContext();
    const spawning = createSpawningPty({ killThrows: true });
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        loadPtyModule: async () => spawning.module,
        attachBridge: () => {
          throw new Error("attach boom");
        },
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("attach boom");
    expect(ctx.stderrText()).toContain("child.kill failed");
    expect(driveErrorLineCount(ctx.stderrText())).toBe(2);
    expect(spawning.killCount()).toBe(1);
  });

  it("waitForExit rejection: disposes, fails closed, closes, returns 1", async () => {
    const ctx = createFakeContext();
    const bridge = createFakeBridge({ rejects: true, rejectError: new Error("wait boom") });
    const session = createFakeSession();
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () => bridge.bridge,
        session: session.session,
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Error in PTY shell: wait boom");
    expect(bridge.disposeCount()).toBeGreaterThanOrEqual(1);
    expect(session.closeCount()).toBe(1);
  });

  it("waitForExit rejection plus dispose throw reports both errors and still closes", async () => {
    const ctx = createFakeContext();
    const session = createFakeSession();
    const bridge = createFakeBridge({
      rejects: true,
      rejectError: new Error("wait boom"),
      disposeThrows: new Error("dispose after wait boom"),
    });

    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () => bridge.bridge,
        session: session.session,
      }),
    );

    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Error in PTY shell: wait boom");
    expect(ctx.stderrText()).toContain("Error in PTY shell: dispose after wait boom");
    expect(driveErrorLineCount(ctx.stderrText())).toBe(2);
    expect(bridge.disposeCount()).toBeGreaterThanOrEqual(1);
    expect(session.closeCount()).toBe(1);
  });

  it("dispose errors on clean completion are treated as failure", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () =>
          createFakeBridge({
            exit: { exitCode: 0, signal: undefined },
            disposeResults: [{ errors: [new Error("teardown boom")] }],
          }).bridge,
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Error tearing down PTY shell: teardown boom");
  });

  it("tolerates a contract-violating dispose() throw (no rejection escapes)", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () =>
          createFakeBridge({
            exit: { exitCode: 0, signal: undefined },
            disposeThrows: new Error("dispose exploded"),
          }).bridge,
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Error tearing down PTY shell: dispose exploded");
  });

  it("session.close returning non-zero makes the wrapper fail", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const session = createFakeSession({ close: { exitCode: 2, stderrText: "" } });
    const code = await runPtyShell(baseDeps({ context: ctx.context, session: session.session }));
    expect(code).toBe(1);
  });

  it("session.close throwing is observed safely and fails the wrapper", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const session = createFakeSession({ closeThrows: new Error("end failed") });
    const code = await runPtyShell(baseDeps({ context: ctx.context, session: session.session }));
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Unexpected error closing PTY shell session: end failed");
  });

  it("writes the session's close text exactly (runPtyShell owns close output)", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const session = createFakeSession({
      close: {
        exitCode: 0,
        stderrText: "Session: sess-1\nNext: viberevert check --since sess-1\n",
      },
    });
    const code = await runPtyShell(baseDeps({ context: ctx.context, session: session.session }));
    expect(code).toBe(0);
    expect(ctx.stderrText()).toBe("Session: sess-1\nNext: viberevert check --since sess-1\n");
  });

  it("does not write stderr for an empty close copy", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const session = createFakeSession({ close: { exitCode: 0, stderrText: "" } });
    const code = await runPtyShell(baseDeps({ context: ctx.context, session: session.session }));
    expect(code).toBe(0);
    expect(ctx.stderrText()).toBe("");
    expect(ctx.stderrWriteCount()).toBe(0);
  });

  it("never rejects even when stderr.write throws (refuse path still returns the code)", async () => {
    const ctx = createFakeContext({ stderrThrows: true });
    await expect(
      runPtyShell(baseDeps({ context: ctx.context, hasInteractiveTty: () => false })),
    ).resolves.toBe(1);
  });

  it("signal-triggered dispose fails closed with a synthetic error", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const bridge = createFakeBridge({ exit: { exitCode: 0, signal: undefined } });
    const session = createFakeSession();
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () => bridge.bridge,
        session: session.session,
        withSignalCleanup: firingSignalCleanup,
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain(
      "Error in PTY shell: PTY shell interrupted by parent signal",
    );
    expect(ctx.stderrText()).not.toContain("[exit:");
    expect(bridge.disposeCount()).toBeGreaterThanOrEqual(1);
    expect(session.closeCount()).toBe(1);
  });

  it("signal-triggered dispose surfaces a cached teardown error exactly once (deduped)", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const sharedErr = new Error("cached teardown");
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () =>
          createFakeBridge({
            exit: { exitCode: 0, signal: undefined },
            disposeResults: [{ errors: [sharedErr] }], // same object returned each dispose
          }).bridge,
        withSignalCleanup: firingSignalCleanup,
      }),
    );
    expect(code).toBe(1);
    expect(driveErrorLineCount(ctx.stderrText())).toBe(1);
    expect(ctx.stderrText()).toContain("cached teardown");
  });

  it("signal cleanup error and a different final dispose error are both reported", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () =>
          createFakeBridge({
            exit: { exitCode: 0, signal: undefined },
            disposeResults: [
              { errors: [new Error("signal teardown")] },
              { errors: [new Error("final teardown")] },
            ],
          }).bridge,
        withSignalCleanup: firingSignalCleanup,
      }),
    );
    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("signal teardown");
    expect(ctx.stderrText()).toContain("final teardown");
    expect(driveErrorLineCount(ctx.stderrText())).toBe(2);
  });

  it("waitForExit rejection after signal cleanup includes wait and teardown errors", async () => {
    const ctx = createFakeContext({ columns: 80, rows: 24 });
    const sharedErr = new Error("signal teardown");
    const bridge = createFakeBridge({
      rejects: true,
      rejectError: new Error("wait after signal"),
      disposeResults: [{ errors: [sharedErr] }],
    });
    const session = createFakeSession();

    const code = await runPtyShell(
      baseDeps({
        context: ctx.context,
        attachBridge: () => bridge.bridge,
        session: session.session,
        withSignalCleanup: firingSignalCleanup,
      }),
    );

    expect(code).toBe(1);
    expect(ctx.stderrText()).toContain("Error in PTY shell: wait after signal");
    expect(ctx.stderrText()).toContain("Error in PTY shell: signal teardown");
    expect(driveErrorLineCount(ctx.stderrText())).toBe(2);
    expect(bridge.disposeCount()).toBeGreaterThanOrEqual(1);
    expect(session.closeCount()).toBe(1);
  });

  it("passes cols+rows to spawn only when both dimensions are usable", async () => {
    const ctx = createFakeContext({ columns: 120, rows: 40 });
    const spawning = createSpawningPty();
    await runPtyShell(
      baseDeps({ context: ctx.context, loadPtyModule: async () => spawning.module }),
    );
    expect(spawning.spawnCalls[0]?.options).toEqual({ cwd: "/repo", env: {}, cols: 120, rows: 40 });
  });

  it("omits both dimensions when only columns is present", async () => {
    const ctx = createFakeContext({ columns: 120 });
    const spawning = createSpawningPty();
    await runPtyShell(
      baseDeps({ context: ctx.context, loadPtyModule: async () => spawning.module }),
    );
    expect(spawning.spawnCalls[0]?.options).toEqual({ cwd: "/repo", env: {} });
  });

  it("omits both dimensions when only rows is present", async () => {
    const ctx = createFakeContext({ rows: 40 });
    const spawning = createSpawningPty();
    await runPtyShell(
      baseDeps({ context: ctx.context, loadPtyModule: async () => spawning.module }),
    );
    expect(spawning.spawnCalls[0]?.options).toEqual({ cwd: "/repo", env: {} });
  });

  it("omits both dimensions when a dimension is zero", async () => {
    const ctx = createFakeContext({ columns: 0, rows: 40 });
    const spawning = createSpawningPty();
    await runPtyShell(
      baseDeps({ context: ctx.context, loadPtyModule: async () => spawning.module }),
    );
    expect(spawning.spawnCalls[0]?.options).toEqual({ cwd: "/repo", env: {} });
  });
});

// ---------------------------------------------------------------------------
// 3c-v real-bindings fakes + tests
// ---------------------------------------------------------------------------

/** Build G3-backed session ops with quiet defaults; each test overrides a seam. */
function makeSessionOps(
  over: Partial<G3BackedPtyShellSessionOps> = {},
): G3BackedPtyShellSessionOps {
  return {
    resolveRepoRoot: over.resolveRepoRoot ?? (() => "/repo"),
    startSessionOperation: over.startSessionOperation ?? (async () => ({ sessionId: "sess_1" })),
    endSessionOperation: over.endSessionOperation ?? (async () => undefined),
    loadActiveSessionLock: over.loadActiveSessionLock ?? (async () => null),
  };
}

describe("createG3BackedPtyShellSession -- open refusals (byte-identical G3 copy)", () => {
  it("repo root not found", async () => {
    const session = createG3BackedPtyShellSession({
      cwd: "/nope",
      ops: makeSessionOps({
        resolveRepoRoot: () => {
          throw new RepoRootNotFoundError("/nope");
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
        "Run `viberevert init` to create a project here.\n",
      ].join(""),
    });
  });

  it("config not found", async () => {
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw new ConfigNotFoundError("/repo/.viberevert.yml");
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        "No .viberevert.yml found in this repo.\n",
        "Run:\n",
        "  viberevert init\n\n",
        "to create one.\n",
      ].join(""),
    });
  });

  it("config parse error (message interpolated)", async () => {
    const err = new ConfigParseError("/repo/.viberevert.yml", new Error("bad yaml"));
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw err;
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        `Invalid .viberevert.yml: ${err.message}\n`,
        "Fix the file, or re-run:\n",
        "  viberevert init\n\n",
        "to start fresh.\n",
      ].join(""),
    });
  });

  it("config validation error also maps to the invalid-config copy", async () => {
    const err = new ConfigValidationError("/repo/.viberevert.yml", {
      issues: [{ path: ["commands"], message: "bad" }],
    } as unknown as ConstructorParameters<typeof ConfigValidationError>[1]);
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw err;
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        `Invalid .viberevert.yml: ${err.message}\n`,
        "Fix the file, or re-run:\n",
        "  viberevert init\n\n",
        "to start fresh.\n",
      ].join(""),
    });
  });

  it("runtime-env invalid uses the raw message", async () => {
    const err = new RuntimeEnvInvalidError("VIBEREVERT_TEST_FIXED_NOW", "nope", "not ISO-8601");
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw err;
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: `${err.message}\n`,
    });
  });

  it("session already active (with task)", async () => {
    const active = {
      session_id: "sess_active",
      started_at: "2026-07-01T00:00:00Z",
      task: "refactor auth",
      checkpoint_id: "cp_active",
    } as unknown as ConstructorParameters<typeof SessionAlreadyActiveError>[0];
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw new SessionAlreadyActiveError(active);
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        "A session is already active in this repo.\n\n",
        `Session:     ${truncateIdForDisplay("sess_active")}\n`,
        "Started at:  2026-07-01T00:00:00Z\n",
        "Task:        refactor auth\n",
        `Checkpoint:  ${truncateIdForDisplay("cp_active")}\n`,
        "\nUse:\n",
        "  viberevert sessions\n",
        "  viberevert end                                     (then start fresh)\n",
        "  viberevert end && viberevert rollback <session>    (then discard that session's changes)\n",
      ].join(""),
    });
  });

  it("session already active (without task -> no Task line)", async () => {
    const active = {
      session_id: "sess_active",
      started_at: "2026-07-01T00:00:00Z",
      checkpoint_id: "cp_active",
    } as unknown as ConstructorParameters<typeof SessionAlreadyActiveError>[0];
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw new SessionAlreadyActiveError(active);
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        "A session is already active in this repo.\n\n",
        `Session:     ${truncateIdForDisplay("sess_active")}\n`,
        "Started at:  2026-07-01T00:00:00Z\n",
        `Checkpoint:  ${truncateIdForDisplay("cp_active")}\n`,
        "\nUse:\n",
        "  viberevert sessions\n",
        "  viberevert end                                     (then start fresh)\n",
        "  viberevert end && viberevert rollback <session>    (then discard that session's changes)\n",
      ].join(""),
    });
  });

  it("concurrent operation (with lock info)", async () => {
    const err = new ConcurrentOperationError("/repo/.viberevert/locks/start", {
      command: "viberevert run",
      pid: 4242,
      started_at: "2026-07-01T00:00:00Z",
    } as unknown as ConstructorParameters<typeof ConcurrentOperationError>[1]);
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw err;
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        "Another viberevert operation is already running:\n",
        "  command:  viberevert run\n",
        "  pid:      4242\n",
        "  since:    2026-07-01T00:00:00Z\n",
        "\n",
        "If you're sure that command isn't running anymore (e.g., crashed),\n",
        "remove this stale lock directory manually:\n",
        `  ${START_LOCK_REL}\n`,
      ].join(""),
    });
  });

  it("concurrent operation (no lock info)", async () => {
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw new ConcurrentOperationError("/repo/.viberevert/locks/start", null);
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        "Another viberevert operation is already running (lock metadata unavailable).\n",
        "\n",
        "If you're sure no other viberevert command is running,\n",
        "remove this stale lock directory manually:\n",
        `  ${START_LOCK_REL}\n`,
      ].join(""),
    });
  });

  it("open refusal does not poison the adapter; a later open can succeed", async () => {
    let calls = 0;
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          calls += 1;
          if (calls === 1) {
            throw new ConfigNotFoundError("/repo/.viberevert.yml");
          }
          return { sessionId: "sess_after_retry" };
        },
      }),
    });
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: [
        "No .viberevert.yml found in this repo.\n",
        "Run:\n",
        "  viberevert init\n\n",
        "to create one.\n",
      ].join(""),
    });
    expect(await session.open()).toEqual({ kind: "opened", sessionId: "sess_after_retry" });
  });

  it("re-throws an unexpected start error", async () => {
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          throw new Error("weird");
        },
      }),
    });
    await expect(session.open()).rejects.toThrow("weird");
  });

  it("re-throws an unexpected repo-root error", async () => {
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        resolveRepoRoot: () => {
          throw new Error("repo probe weird");
        },
      }),
    });
    await expect(session.open()).rejects.toThrow("repo probe weird");
  });
});

describe("createG3BackedPtyShellSession -- open success + one-shot", () => {
  it("records cwd + lockCommand + task and returns the session id", async () => {
    let recorded: { cwd: string; lockCommand: string; task?: string } | undefined;
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      task: "do things",
      ops: makeSessionOps({
        startSessionOperation: async (input) => {
          recorded = input;
          return { sessionId: "sess_new" };
        },
      }),
    });
    expect(await session.open()).toEqual({ kind: "opened", sessionId: "sess_new" });
    expect(recorded).toEqual({
      cwd: "/repo",
      lockCommand: "viberevert shell --pty",
      task: "do things",
    });
  });

  it("omits task from the start call when none is given", async () => {
    let recorded: { cwd: string; lockCommand: string; task?: string } | undefined;
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async (input) => {
          recorded = input;
          return { sessionId: "sess_1" };
        },
      }),
    });
    await session.open();
    expect(recorded).toEqual({ cwd: "/repo", lockCommand: "viberevert shell --pty" });
    expect("task" in (recorded ?? {})).toBe(false);
  });

  it("is one-shot: repeat open returns the same session; after close it refuses", async () => {
    let startCalls = 0;
    const session = createG3BackedPtyShellSession({
      cwd: "/repo",
      ops: makeSessionOps({
        startSessionOperation: async () => {
          startCalls += 1;
          return { sessionId: "sess_1" };
        },
      }),
    });
    expect(await session.open()).toEqual({ kind: "opened", sessionId: "sess_1" });
    expect(await session.open()).toEqual({ kind: "opened", sessionId: "sess_1" });
    expect(startCalls).toBe(1);
    await session.close();
    expect(await session.open()).toEqual({
      kind: "refused",
      exitCode: 1,
      stderrText: "This PTY shell session adapter has already been closed.\n",
    });
  });
});

describe("createG3BackedPtyShellSession -- close (scoped teardown copy + idempotency)", () => {
  async function opened(ops: G3BackedPtyShellSessionOps) {
    const session = createG3BackedPtyShellSession({ cwd: "/repo", ops });
    await session.open();
    return session;
  }

  it("success -> Session/Next summary; repeat is quiet", async () => {
    const session = await opened(
      makeSessionOps({ loadActiveSessionLock: async () => ({ session_id: "sess_1" }) }),
    );
    expect(await session.close()).toEqual({
      exitCode: 0,
      stderrText: "Session: sess_1\nNext: viberevert check --since sess_1\n",
    });
    expect(await session.close()).toEqual({ exitCode: 0, stderrText: "" });
  });

  it("lock already gone -> nothing-to-close note", async () => {
    const session = await opened(makeSessionOps({ loadActiveSessionLock: async () => null }));
    expect(await session.close()).toEqual({
      exitCode: 0,
      stderrText: "Note: the session was already ended; nothing to close.\n",
    });
  });

  it("different active session is left untouched", async () => {
    const session = await opened(
      makeSessionOps({ loadActiveSessionLock: async () => ({ session_id: "sess_other" }) }),
    );
    expect(await session.close()).toEqual({
      exitCode: 1,
      stderrText:
        "Warning: the active session belongs to a different session; leaving it untouched.\n",
    });
  });

  it("NoActiveSessionError -> already-ended note + summary (exit 0)", async () => {
    const session = await opened(
      makeSessionOps({
        loadActiveSessionLock: async () => ({ session_id: "sess_1" }),
        endSessionOperation: async () => {
          throw new NoActiveSessionError();
        },
      }),
    );
    expect(await session.close()).toEqual({
      exitCode: 0,
      stderrText: [
        "Note: the session was already ended before the shell could close it.\n",
        "Session: sess_1\n",
        "Next: viberevert check --since sess_1\n",
      ].join(""),
    });
  });

  it("EndSessionRaceError -> already-ended note + summary (exit 0)", async () => {
    const session = await opened(
      makeSessionOps({
        loadActiveSessionLock: async () => ({ session_id: "sess_1" }),
        endSessionOperation: async () => {
          throw new EndSessionRaceError();
        },
      }),
    );
    expect(await session.close()).toEqual({
      exitCode: 0,
      stderrText: [
        "Note: the session was already ended before the shell could close it.\n",
        "Session: sess_1\n",
        "Next: viberevert check --since sess_1\n",
      ].join(""),
    });
  });

  it("read failure stays `opened` so a later close can retry", async () => {
    let lockCalls = 0;
    const session = await opened(
      makeSessionOps({
        loadActiveSessionLock: async () => {
          lockCalls += 1;
          if (lockCalls === 1) {
            throw new Error("lock read boom");
          }
          return null;
        },
      }),
    );
    expect(await session.close()).toEqual({
      exitCode: 1,
      stderrText: [
        "Could not read the active session state while shutting down: lock read boom\n",
        "If a session is still active, close it manually with:\n",
        "  viberevert end\n",
      ].join(""),
    });
    // retry succeeds because state stayed `opened`
    expect(await session.close()).toEqual({
      exitCode: 0,
      stderrText: "Note: the session was already ended; nothing to close.\n",
    });
  });

  it("unknown end failure stays `opened` for a retry", async () => {
    let endCalls = 0;
    const session = await opened(
      makeSessionOps({
        loadActiveSessionLock: async () => ({ session_id: "sess_1" }),
        endSessionOperation: async () => {
          endCalls += 1;
          if (endCalls === 1) {
            throw new Error("end boom");
          }
          return undefined;
        },
      }),
    );
    expect(await session.close()).toEqual({
      exitCode: 1,
      stderrText: [
        "The session could not be closed: end boom\n",
        "Close it manually with:\n",
        "  viberevert end\n",
      ].join(""),
    });
    expect(await session.close()).toEqual({
      exitCode: 0,
      stderrText: "Session: sess_1\nNext: viberevert check --since sess_1\n",
    });
  });

  it("close before open is a quiet no-op", async () => {
    const session = createG3BackedPtyShellSession({ cwd: "/repo", ops: makeSessionOps() });
    expect(await session.close()).toEqual({ exitCode: 0, stderrText: "" });
  });
});

describe("createScopedSignalCleanup", () => {
  function createFakeSignalSource() {
    const handlers = new Map<string, Set<() => void>>();
    const onCalls: string[] = [];
    const source: SignalSource = {
      on: (signal, listener) => {
        onCalls.push(signal);
        const set = handlers.get(signal) ?? new Set<() => void>();
        set.add(listener);
        handlers.set(signal, set);
      },
      removeListener: (signal, listener) => {
        handlers.get(signal)?.delete(listener);
      },
    };
    return {
      source,
      onCalls,
      emit: (signal: string) => {
        for (const h of [...(handlers.get(signal) ?? [])]) {
          h();
        }
      },
      listenerCount: (signal: string) => handlers.get(signal)?.size ?? 0,
    };
  }

  it("installs SIGTERM+SIGHUP and removes them after run resolves", async () => {
    const sig = createFakeSignalSource();
    const result = await createScopedSignalCleanup(sig.source)(
      () => undefined,
      async () => 42,
    );
    expect(result).toBe(42);
    expect(sig.onCalls).toEqual(["SIGTERM", "SIGHUP"]);
    expect(sig.listenerCount("SIGTERM")).toBe(0);
    expect(sig.listenerCount("SIGHUP")).toBe(0);
  });

  it("removes listeners even when run rejects", async () => {
    const sig = createFakeSignalSource();
    await expect(
      createScopedSignalCleanup(sig.source)(
        () => undefined,
        async () => {
          throw new Error("run boom");
        },
      ),
    ).rejects.toThrow("run boom");
    expect(sig.listenerCount("SIGTERM")).toBe(0);
    expect(sig.listenerCount("SIGHUP")).toBe(0);
  });

  it("fires onSignal at most once even if both signals emit", async () => {
    const sig = createFakeSignalSource();
    let fired = 0;
    await createScopedSignalCleanup(sig.source)(
      () => {
        fired += 1;
      },
      async () => {
        sig.emit("SIGTERM");
        sig.emit("SIGHUP");
      },
    );
    expect(fired).toBe(1);
  });

  it("a throwing onSignal does not prevent listener removal", async () => {
    const sig = createFakeSignalSource();
    await createScopedSignalCleanup(sig.source)(
      () => {
        throw new Error("onSignal boom");
      },
      async () => {
        sig.emit("SIGTERM");
      },
    );
    expect(sig.listenerCount("SIGTERM")).toBe(0);
    expect(sig.listenerCount("SIGHUP")).toBe(0);
  });

  it("removes the installed SIGTERM listener and does not run when SIGHUP installation throws", async () => {
    let ran = false;
    const removed: string[] = [];
    const source: SignalSource = {
      on: (signal) => {
        if (signal === "SIGHUP") {
          throw new Error("install SIGHUP boom");
        }
      },
      removeListener: (signal) => {
        removed.push(signal);
      },
    };
    await expect(
      createScopedSignalCleanup(source)(
        () => undefined,
        async () => {
          ran = true;
        },
      ),
    ).rejects.toThrow("install SIGHUP boom");
    expect(ran).toBe(false);
    expect(removed).toEqual(["SIGTERM"]);
  });

  it("does not run and has nothing to remove when SIGTERM installation throws", async () => {
    let ran = false;
    const removed: string[] = [];
    const source: SignalSource = {
      on: () => {
        throw new Error("install SIGTERM boom");
      },
      removeListener: (signal) => {
        removed.push(signal);
      },
    };
    await expect(
      createScopedSignalCleanup(source)(
        () => undefined,
        async () => {
          ran = true;
        },
      ),
    ).rejects.toThrow("install SIGTERM boom");
    expect(ran).toBe(false);
    expect(removed).toEqual([]);
  });

  it("attempts both removals even if one removal throws", async () => {
    const removed: string[] = [];
    const source: SignalSource = {
      on: () => undefined,
      removeListener: (signal) => {
        removed.push(signal);
        if (signal === "SIGTERM") {
          throw new Error("remove SIGTERM boom");
        }
      },
    };
    const result = await createScopedSignalCleanup(source)(
      () => undefined,
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(removed).toEqual(["SIGTERM", "SIGHUP"]);
  });
});

describe("createRunPtyShellDeps", () => {
  function fakeFactoryContext(
    over: { stdin?: unknown; stdout?: unknown } = {},
  ): RunPtyShellFactoryContext {
    return {
      stdin: over.stdin ?? { isTTY: true },
      stdout: over.stdout ?? { isTTY: true },
      stderr: { write: () => undefined },
    };
  }

  it("hasInteractiveTty is true only when both streams report isTTY", () => {
    const deps = createRunPtyShellDeps(fakeFactoryContext(), { cwd: "/repo", env: {} });
    expect(deps.hasInteractiveTty()).toBe(true);
  });

  it("hasInteractiveTty is false when stdout is not a TTY", () => {
    const deps = createRunPtyShellDeps(fakeFactoryContext({ stdout: { isTTY: false } }), {
      cwd: "/repo",
      env: {},
    });
    expect(deps.hasInteractiveTty()).toBe(false);
  });

  it("hasInteractiveTty is false (never throws) for null / missing-isTTY streams", () => {
    const deps = createRunPtyShellDeps(fakeFactoryContext({ stdin: null, stdout: {} }), {
      cwd: "/repo",
      env: {},
    });
    expect(deps.hasInteractiveTty()).toBe(false);
  });

  it("hasInteractiveTty is false when the isTTY getter throws", () => {
    const throwingStream = Object.defineProperty({}, "isTTY", {
      get: () => {
        throw new Error("isTTY getter boom");
      },
    });
    const deps = createRunPtyShellDeps(
      fakeFactoryContext({ stdin: throwingStream, stdout: { isTTY: true } }),
      { cwd: "/repo", env: {} },
    );
    expect(deps.hasInteractiveTty()).toBe(false);
  });

  it("snapshots spawnEnv (copy, not the same reference, immune to later mutation)", () => {
    const env = { FOO: "bar" };
    const deps = createRunPtyShellDeps(fakeFactoryContext(), { cwd: "/repo", env });
    env.FOO = "mutated";
    expect(deps.spawnEnv).toEqual({ FOO: "bar" });
    expect(deps.spawnEnv).not.toBe(env);
  });

  it("threads cwd and wires the injected seams", () => {
    const deps = createRunPtyShellDeps(fakeFactoryContext(), { cwd: "/work", env: {} });
    expect(deps.cwd).toBe("/work");
    expect(typeof deps.loadPtyModule).toBe("function");
    expect(typeof deps.resolveHostShell).toBe("function");
    expect(typeof deps.attachBridge).toBe("function");
    expect(typeof deps.withSignalCleanup).toBe("function");
    expect(typeof deps.session.open).toBe("function");
    expect(typeof deps.session.close).toBe("function");
  });
});
