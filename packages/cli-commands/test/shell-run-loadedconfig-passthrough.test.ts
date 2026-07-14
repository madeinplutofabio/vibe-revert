// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4e-iv-a0: the REPL (`viberevert shell`) and `viberevert run` each
// load config ONCE, read `commands` from that loaded object for the guard
// policy, and thread that SAME validated object into startSessionOperation
// (loadedConfig) -- so guard policy and session start derive from one snapshot.
// startSessionOperation is mocked to CAPTURE its opts and abort immediately
// (before any session-state / REPL / child work). The proof is threefold:
//   - `captured.loadedConfig === sentinel` (the exact object is passed onward);
//   - the sentinel's getter-backed `commands` is read exactly once and BEFORE
//     startSessionOperation runs (events === ["commands", "start"]);
//   - the capture lands despite the shared abort error.

import { PassThrough, Writable } from "node:stream";
import { type Config, loadConfig, resolveRepoRoot } from "@viberevert/core";
import { Cli } from "clipanion";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RunCommand } from "../src/commands/run.js";
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

/** A no-op writable sink for a command's stdout/stderr. */
function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** A distinctive command policy (empty guard -> `echo hi` is allowed). */
const SENTINEL_POLICY = { guard: [] } as unknown as NonNullable<Config["commands"]>;

/** The single abort thrown after capture; must not prevent the capture. */
const STOP_AFTER_CAPTURE = new Error("__stop_after_capture__");

/** Records the interleaving of the `commands` read and the session-start call. */
let events: string[] = [];
let captured: StartSessionOperationOpts | undefined;

/** The one Config object the mocked loader returns; `commands` is getter-backed. */
const SENTINEL_CONFIG = {
  version: 1,
  get commands() {
    events.push("commands");
    return SENTINEL_POLICY;
  },
} as Config;

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  captured = undefined;
  vi.mocked(resolveRepoRoot).mockReturnValue("/fake/repo");
  vi.mocked(loadConfig).mockResolvedValue(SENTINEL_CONFIG);
  vi.mocked(startSessionOperation).mockImplementation(async (opts) => {
    events.push("start");
    captured = opts;
    throw STOP_AFTER_CAPTURE;
  });
});

/** Register a command via `register` and run `argv` with non-TTY empty stdin + sinks. */
async function drive(register: (cli: Cli) => void, argv: string[]): Promise<void> {
  const cli = new Cli({ binaryName: "viberevert" });
  register(cli);
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = false;
  stdin.end();
  await cli.run(argv, { stdin, stdout: sink(), stderr: sink() });
}

describe("shell / run thread their loaded config into startSessionOperation (M G4 4e-iv-a0)", () => {
  it("shell (REPL) reads commands once then passes the same config object by identity", async () => {
    await drive((cli) => cli.register(ShellCommand), ["shell"]);

    expect(vi.mocked(loadConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startSessionOperation)).toHaveBeenCalledTimes(1);
    expect(captured?.loadedConfig).toBe(SENTINEL_CONFIG);
    // commands read exactly once, and BEFORE the session-start boundary.
    expect(events).toEqual(["commands", "start"]);
  });

  it("run reads commands once then passes the same config object by identity", async () => {
    await drive((cli) => cli.register(RunCommand), ["run", "echo", "hi"]);

    expect(vi.mocked(loadConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startSessionOperation)).toHaveBeenCalledTimes(1);
    expect(captured?.loadedConfig).toBe(SENTINEL_CONFIG);
    expect(events).toEqual(["commands", "start"]);
  });
});
