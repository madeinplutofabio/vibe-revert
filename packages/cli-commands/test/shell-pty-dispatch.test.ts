// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4f: ShellCommand is the public composition root for `shell --pty`.
// With the carved engine (createRunPtyShellDeps + runPtyShell) module-mocked,
// this pins the dispatch boundary by IDENTITY + read cardinality: task, pty,
// process.cwd, and process.env are each read the intended number of times; the
// host facts are passed by identity into createRunPtyShellDeps; the exact deps
// that factory produces reach runPtyShell; and runPtyShell's outcome (value or
// rejection) is returned verbatim (no catch, no REPL fallback). A whitespace
// --task is rejected BEFORE pty / cwd / env / either factory is touched.
// Isolated so the shell-pty.js mock does not affect the rest of the suite.

import type { BaseContext } from "clipanion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShellCommand } from "../src/commands/shell.js";
import { createRunPtyShellDeps, runPtyShell } from "../src/commands/shell-pty.js";

vi.mock("../src/commands/shell-pty.js", () => ({
  createRunPtyShellDeps: vi.fn(() => ({ marker: "deps" })),
  runPtyShell: vi.fn(async () => 7),
}));

/** A minimal command context; only `stderr.write` is exercised (validation copy). */
function makeContext(): { context: BaseContext; stderr: () => string } {
  let out = "";
  const context = {
    stdin: {},
    stdout: {},
    stderr: {
      write(s: string) {
        out += s;
        return true;
      },
    },
  } as unknown as BaseContext;
  return { context, stderr: () => out };
}

/** A ShellCommand with getter-backed pty/task (to count reads) + a fake context. */
function makeShellCommand(opts: { pty: () => boolean; task: () => string | undefined }): {
  cmd: ShellCommand;
  taskReads: () => number;
  ptyReads: () => number;
  ctx: { context: BaseContext; stderr: () => string };
} {
  const ctx = makeContext();
  let tReads = 0;
  let pReads = 0;
  const cmd = new ShellCommand();
  Object.defineProperty(cmd, "pty", {
    configurable: true,
    get() {
      pReads += 1;
      return opts.pty();
    },
  });
  Object.defineProperty(cmd, "task", {
    configurable: true,
    get() {
      tReads += 1;
      return opts.task();
    },
  });
  cmd.context = ctx.context;
  return { cmd, taskReads: () => tReads, ptyReads: () => pReads, ctx };
}

/**
 * Run `fn` with process.env temporarily replaced by a read-counting getter that
 * returns `sentinel`, restoring the EXACT original descriptor afterward (even on
 * throw). process.env is configurable in this runtime (asserted by the override
 * succeeding); the count is the number of reads during `fn`.
 */
async function withEnvCounter<T>(
  sentinel: NodeJS.ProcessEnv,
  fn: () => Promise<T>,
): Promise<{ result: T; envReads: number }> {
  const original = Object.getOwnPropertyDescriptor(process, "env");
  let reads = 0;
  Object.defineProperty(process, "env", {
    configurable: true,
    get() {
      reads += 1;
      return sentinel;
    },
  });
  try {
    const result = await fn();
    return { result, envReads: reads };
  } finally {
    if (original !== undefined) {
      Object.defineProperty(process, "env", original);
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ShellCommand --pty dispatch composition root (M G4 Step 4f)", () => {
  it("snapshots cwd/env/task once, passes them by identity into createRunPtyShellDeps, feeds those deps to runPtyShell, returns its code (no fallback)", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/sentinel/cwd");
    const sentinelEnv = { VR_SENTINEL: "1" } as NodeJS.ProcessEnv;
    const { cmd, taskReads, ptyReads, ctx } = makeShellCommand({
      pty: () => true,
      task: () => "my task",
    });

    const { result: code, envReads } = await withEnvCounter(sentinelEnv, () => cmd.execute());

    expect(code).toBe(7); // runPtyShell's return -> NO REPL fallback
    expect(taskReads()).toBe(1);
    expect(ptyReads()).toBe(1);
    expect(cwdSpy).toHaveBeenCalledTimes(1);
    expect(envReads).toBe(1);
    expect(ctx.stderr()).toBe("");

    const depsCall = vi.mocked(createRunPtyShellDeps).mock.calls[0];
    expect(depsCall?.[0]).toBe(ctx.context); // command context by identity
    const options = depsCall?.[1];
    expect(options?.cwd).toBe("/sentinel/cwd");
    expect(options?.env).toBe(sentinelEnv); // env by REFERENCE (the getter's object)
    expect(options?.task).toBe("my task"); // exact captured task value

    const producedDeps = vi.mocked(createRunPtyShellDeps).mock.results[0]?.value;
    expect(vi.mocked(runPtyShell).mock.calls[0]?.[0]).toBe(producedDeps); // exact deps
  });

  it("omits task from the engine options when none was given (exactOptionalPropertyTypes)", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/sentinel/cwd");
    const { cmd } = makeShellCommand({ pty: () => true, task: () => undefined });

    const { result: code } = await withEnvCounter({ VR_SENTINEL: "1" } as NodeJS.ProcessEnv, () =>
      cmd.execute(),
    );

    expect(code).toBe(7);
    const options = vi.mocked(createRunPtyShellDeps).mock.calls[0]?.[1];
    expect(options && "task" in options).toBe(false);
  });

  it("propagates a runPtyShell rejection verbatim (thin composition root; no catch/fallback)", async () => {
    const boom = new Error("engine boom");
    vi.mocked(runPtyShell).mockRejectedValueOnce(boom);
    vi.spyOn(process, "cwd").mockReturnValue("/sentinel/cwd");
    const { cmd } = makeShellCommand({ pty: () => true, task: () => undefined });

    await expect(
      withEnvCounter({ VR_SENTINEL: "1" } as NodeJS.ProcessEnv, () => cmd.execute()),
    ).rejects.toBe(boom);

    expect(vi.mocked(createRunPtyShellDeps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runPtyShell)).toHaveBeenCalledTimes(1);
  });

  it("rejects a whitespace --task BEFORE reading pty, process.cwd, process.env, or either engine factory", async () => {
    const cwdSpy = vi.spyOn(process, "cwd");
    const { cmd, taskReads, ptyReads, ctx } = makeShellCommand({
      pty: () => true,
      task: () => "   ",
    });

    const { result: code, envReads } = await withEnvCounter(
      { VR_SENTINEL: "1" } as NodeJS.ProcessEnv,
      () => cmd.execute(),
    );

    expect(code).toBe(1);
    expect(ctx.stderr()).toBe("--task must not be empty or whitespace-only.\n");
    expect(taskReads()).toBe(1); // captured once, then validated
    expect(ptyReads()).toBe(0); // engine never selected
    expect(cwdSpy).not.toHaveBeenCalled();
    expect(envReads).toBe(0);
    expect(vi.mocked(createRunPtyShellDeps)).not.toHaveBeenCalled();
    expect(vi.mocked(runPtyShell)).not.toHaveBeenCalled();
  });
});
