// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4f: the REPL engine path consumes the SAME once-captured `task`
// snapshot as the validation + PTY paths. With core repo/config + the session
// operation mocked, this drives ShellCommand's REPL branch far enough to capture
// startSessionOperation's input, proving a getter-backed `this.task` is read
// exactly once and the captured value is threaded into session start. Isolated
// so the core/start-session mocks do not affect other suites.

import { type Config, loadConfig, resolveRepoRoot } from "@viberevert/core";
import type { BaseContext } from "clipanion";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShellCommand } from "../src/commands/shell.js";
import type { StartSessionOperationOpts } from "../src/operations/start-session.js";
import { startSessionOperation } from "../src/operations/start-session.js";

vi.mock("@viberevert/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@viberevert/core")>();
  return { ...actual, resolveRepoRoot: vi.fn(), loadConfig: vi.fn() };
});

vi.mock("../src/operations/start-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/start-session.js")>();
  return { ...actual, startSessionOperation: vi.fn() };
});

function makeContext(): BaseContext {
  return {
    stdin: {},
    stdout: {},
    stderr: { write: () => true },
  } as unknown as BaseContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ShellCommand REPL captured-task (M G4 Step 4f)", () => {
  it("reads this.task once and threads the captured value into startSessionOperation", async () => {
    vi.mocked(resolveRepoRoot).mockReturnValue("/repo");
    vi.mocked(loadConfig).mockResolvedValue({ version: 1 } as Config);
    let captured: StartSessionOperationOpts | undefined;
    vi.mocked(startSessionOperation).mockImplementation(async (input) => {
      captured = input;
      throw new Error("__stop_after_capture__");
    });

    let taskReads = 0;
    const cmd = new ShellCommand();
    cmd.pty = false;
    Object.defineProperty(cmd, "task", {
      configurable: true,
      get() {
        taskReads += 1;
        return "repl task";
      },
    });
    cmd.context = makeContext();

    // startSessionOperation aborts (throws) before the readline loop; the REPL's
    // start-catch rethrows the unmapped error, so execute rejects after capture.
    await expect(cmd.execute()).rejects.toThrow("__stop_after_capture__");

    expect(vi.mocked(startSessionOperation)).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(taskReads).toBe(1); // this.task read exactly once across the whole method
    expect(captured?.task).toBe("repl task"); // captured value threaded into session start
  });
});
