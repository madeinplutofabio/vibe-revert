// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the PTY engine: host wiring, precondition gate, and the raw
// terminal bridge (M G4 Step 3c). All take injected deps / fake streams+pty --
// deterministic, no real node-pty / TTY / fs.

import { describe, expect, it } from "vitest";

import type { PtyDisposable, PtyModule, PtyProcess } from "../src/commands/pty-loader.js";
import {
  attachTerminalBridge,
  evaluatePtyPreconditions,
  type PtyBridgeStreams,
  type ResolvedInteractiveShell,
  resolveHostInteractiveShell,
} from "../src/commands/shell-pty.js";

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
