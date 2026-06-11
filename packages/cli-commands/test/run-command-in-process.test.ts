// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for the in-process Clipanion harness (M G1a substep 6).
//
// 24 tests covering:
//
//   - Happy path (small writes, correct shape, exit code surfacing).
//   - Void-return normalization (Command execute() returning
//     undefined → exitCode 0 per nullish-coalesce contract).
//   - cwd binding correct during execution AND restored on success.
//   - cwd restored on Command throw (and rethrow preserves error identity).
//   - Invalid cwd: throws before Command execution; cwd unchanged
//     (protects the "if initial chdir throws, no restore needed" branch).
//   - Relative cwd: rejects the Promise BEFORE the mutex is acquired
//     (process-global state by definition; enforced absolute contract).
//   - Stdout / stderr truncation at the locked D99.W caps.
//   - Zero-cap edge case.
//   - Partial-chunk preservation when a write straddles the cap.
//   - Multi-byte byte accounting (emoji bytes counted correctly, NOT chars).
//   - All three Writable.write chunk types: string, Buffer, Uint8Array.
//   - Concurrent calls SERIALIZED with per-call cwd preservation
//     (verifies the FIFO mutex + the resolve-before-mutex patch).
//   - process.argv NOT mutated (the harness shallow-copies argv).
//   - process.env NOT mutated (the harness shallow-copies env).
//   - Cap validation rejects negative / NaN / Infinity / non-integer
//     BEFORE any chdir or Command execution (8 parameterized cases).
//   - Stable result shape on Command refusal (exit 1).
//   - Unexpected Command throw rethrows with object identity.
//   - **D99.X non-forwarding**: process.stdout.write + process.stderr.write
//     are monkey-patched; a noisy Command runs; assertion: zero calls
//     to the real process streams.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BaseContext, Command, type CommandClass } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCommandInProcess } from "../src/run-command-in-process.js";

let tmpRoot: string;
let originalCwd: string;

/**
 * Build an in-test Command class that runs `behavior(cmd)` inside its
 * `execute()`. The behavior may write to `cmd.context.stdout/stderr`,
 * read state, throw, or return a custom exit code.
 *
 * Each call returns a FRESH class so static state can't leak between
 * tests. The path is always `["test"]` so the harness can invoke it
 * via argv `["test"]`.
 */
function makeTestCommand(
  behavior: (cmd: Command<BaseContext>) => number,
): CommandClass<BaseContext>;
function makeTestCommand(
  behavior: (cmd: Command<BaseContext>) => Promise<number>,
): CommandClass<BaseContext>;
function makeTestCommand(
  behavior: (cmd: Command<BaseContext>) => undefined,
): CommandClass<BaseContext>;
function makeTestCommand(
  behavior: (cmd: Command<BaseContext>) => Promise<undefined>,
): CommandClass<BaseContext>;
function makeTestCommand(behavior: (cmd: Command<BaseContext>) => void): CommandClass<BaseContext>;
function makeTestCommand(
  behavior: (cmd: Command<BaseContext>) => Promise<void>,
): CommandClass<BaseContext>;
function makeTestCommand(
  behavior: (cmd: Command<BaseContext>) => Promise<unknown> | unknown,
): CommandClass<BaseContext> {
  return class extends Command<BaseContext> {
    static override paths = [["test"]];

    override async execute(): Promise<number | undefined> {
      const result = await behavior(this);
      return typeof result === "number" ? result : undefined;
    }
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-rcip-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("runCommandInProcess — happy path + cwd binding", () => {
  it("captures small writes; returns typed result; exit code surfaces; cwd is correct during execution AND restored after success", async () => {
    let observedCwd: string | undefined;
    const HappyCmd = makeTestCommand((cmd) => {
      observedCwd = process.cwd();
      cmd.context.stdout.write("hello stdout\n");
      cmd.context.stderr.write("hello stderr\n");
      return 0;
    });

    const cwdBefore = process.cwd();
    const result = await runCommandInProcess(HappyCmd, ["test"], { cwd: tmpRoot });
    const cwdAfter = process.cwd();

    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes.toString("utf8")).toBe("hello stdout\n");
    expect(result.stderrText).toBe("hello stderr\n");
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdoutBytesOmitted).toBe(0);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stderrBytesOmitted).toBe(0);
    expect(observedCwd).toBe(resolve(tmpRoot));
    expect(cwdAfter).toBe(cwdBefore);
  });

  it("normalizes a Command execute() void return to exitCode 0 (locks the `cliExitCode ?? 0` contract)", async () => {
    const VoidCmd = makeTestCommand((cmd) => {
      cmd.context.stdout.write("void-return\n");
      // no return — execute() returns void/undefined
    });

    const result = await runCommandInProcess(VoidCmd, ["test"], { cwd: tmpRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes.toString("utf8")).toBe("void-return\n");
  });

  it("cwd restored on Command throw AND throw rethrown with object identity preserved", async () => {
    const syntheticError = new Error("synthetic command throw");
    const ThrowingCmd = makeTestCommand(() => {
      throw syntheticError;
    });

    const cwdBefore = process.cwd();
    let caught: unknown;
    try {
      await runCommandInProcess(ThrowingCmd, ["test"], { cwd: tmpRoot });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(syntheticError);
    expect(process.cwd()).toBe(cwdBefore);
  });

  it("populates command.cli with the full clipanion MiniCli bridge (parity with Cli.run, minus the catch-and-swallow)", async () => {
    // Regression wall: a previous harness implementation called
    // command.validateAndExecute() without setting command.cli,
    // mirroring Cli.run only for the execute side. A future
    // Command using `this.cli.*` (e.g., for sub-command dispatch)
    // would crash with TypeError. This test fails if command.cli
    // is unset OR missing any of the 6 MiniCli methods OR drops
    // any of the 5 CliOptions fields, so the hidden compatibility
    // cliff is closed structurally rather than by convention.
    //
    // The shape we assert matches MiniCli<Context> from
    // clipanion 3.2.1 Cli.d.ts:92 (CliOptions + 6 methods).
    let observedCli: unknown;
    const CliCaptureCmd = makeTestCommand((cmd) => {
      observedCli = cmd.cli;
    });

    await runCommandInProcess(CliCaptureCmd, ["test"], { cwd: tmpRoot });

    expect(observedCli).not.toBeUndefined();
    expect(observedCli).not.toBeNull();
    // Declared-property shape (NOT `Record<string, unknown>`) so:
    //   - TS's `noPropertyAccessFromIndexSignature: true` is
    //     satisfied: these are declared properties, not index
    //     signature entries, so dot access is allowed.
    //   - Biome's `useLiteralKeys` is satisfied: with declared
    //     properties, dot access is the literal-keys style biome
    //     prefers (bracket access on declared properties is what
    //     useLiteralKeys complains about).
    // The fields mirror MiniCli<BaseContext> from clipanion 3.2.1
    // Cli.d.ts:92 — names match, types are `unknown` because we
    // only `typeof`-check or `.toBe`-compare and don't need
    // structural narrowing.
    const cliBridge = observedCli as {
      binaryName?: unknown;
      binaryLabel?: unknown;
      binaryVersion?: unknown;
      enableCapture?: unknown;
      enableColors?: unknown;
      definitions?: unknown;
      error?: unknown;
      format?: unknown;
      process?: unknown;
      run?: unknown;
      usage?: unknown;
    };
    // CliOptions fields propagate from the outer Cli instance.
    expect(cliBridge.binaryName).toBe("viberevert");
    expect(cliBridge.binaryLabel).toBe("VibeRevert");
    expect(cliBridge.binaryVersion).toBe("0.0.0");
    expect(typeof cliBridge.enableCapture).toBe("boolean");
    // enableColors is deterministically `false` per the harness's
    // Cli construction (run-command-in-process.ts) — disables ANSI
    // color codes in clipanion error formatting so captured bytes
    // stay clean. The DUAL assertion (key present AND value false)
    // prevents two distinct regressions:
    //   - A future bridge that drops the field from MiniCli.
    //   - A future harness that lets enableColors auto-infer from
    //     the env, breaking the deterministic-output contract.
    expect("enableColors" in cliBridge).toBe(true);
    expect(cliBridge.enableColors).toBe(false);
    // All 6 MiniCli methods are present as function values.
    expect(typeof cliBridge.definitions).toBe("function");
    expect(typeof cliBridge.error).toBe("function");
    expect(typeof cliBridge.format).toBe("function");
    expect(typeof cliBridge.process).toBe("function");
    expect(typeof cliBridge.run).toBe("function");
    expect(typeof cliBridge.usage).toBe("function");
  });

  it("invalid cwd throws BEFORE Command execution and leaves cwd unchanged (protects the 'if initial chdir throws, no restore needed' branch)", async () => {
    let commandExecuted = false;
    const ShouldNotRunCmd = makeTestCommand(() => {
      commandExecuted = true;
    });

    const cwdBefore = process.cwd();

    await expect(
      runCommandInProcess(ShouldNotRunCmd, ["test"], {
        cwd: join(tmpRoot, "does-not-exist"),
      }),
    ).rejects.toThrow();

    expect(commandExecuted).toBe(false);
    expect(process.cwd()).toBe(cwdBefore);
  });

  it("rejects relative cwd with RangeError BEFORE the mutex is acquired (absolute-cwd contract; process-global state foot-gun eliminated)", async () => {
    let commandExecuted = false;
    const ShouldNotRunCmd = makeTestCommand(() => {
      commandExecuted = true;
    });

    const cwdBefore = process.cwd();

    await expect(
      runCommandInProcess(ShouldNotRunCmd, ["test"], { cwd: "." }),
    ).rejects.toBeInstanceOf(RangeError);

    expect(commandExecuted).toBe(false);
    expect(process.cwd()).toBe(cwdBefore);
  });

  it("Command-returned exit code surfaces correctly for refusal path (return 1)", async () => {
    const RefusalCmd = makeTestCommand((cmd) => {
      cmd.context.stderr.write("refusal reason\n");
      return 1;
    });

    const result = await runCommandInProcess(RefusalCmd, ["test"], { cwd: tmpRoot });
    expect(result.exitCode).toBe(1);
    expect(result.stderrText).toBe("refusal reason\n");
    expect(result.stdoutBytes).toBeInstanceOf(Buffer);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdoutBytesOmitted).toBe(0);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stderrBytesOmitted).toBe(0);
  });
});

describe("runCommandInProcess — D99.W truncation behavior", () => {
  it("stdout truncates at cap; bytes count + truncated flag + bytesOmitted all correct", async () => {
    const cap = 1024;
    const overflowBy = 500;
    const LargeStdoutCmd = makeTestCommand((cmd) => {
      cmd.context.stdout.write("a".repeat(cap + overflowBy));
    });

    const result = await runCommandInProcess(LargeStdoutCmd, ["test"], {
      cwd: tmpRoot,
      stdoutCap: cap,
    });

    expect(result.stdoutBytes.byteLength).toBe(cap);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytesOmitted).toBe(overflowBy);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stderrBytesOmitted).toBe(0);
  });

  it("stderr truncates at cap; symmetric behavior to stdout", async () => {
    const cap = 256;
    const overflowBy = 300;
    const LargeStderrCmd = makeTestCommand((cmd) => {
      cmd.context.stderr.write("b".repeat(cap + overflowBy));
    });

    const result = await runCommandInProcess(LargeStderrCmd, ["test"], {
      cwd: tmpRoot,
      stderrCap: cap,
    });

    expect(result.stderrText.length).toBe(cap);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderrBytesOmitted).toBe(overflowBy);
  });

  it("zero-cap: Command writes are accepted (drain-and-discard); captured is empty; bytesOmitted equals total written", async () => {
    const totalBytes = 100;
    const ZeroCapCmd = makeTestCommand((cmd) => {
      cmd.context.stdout.write("x".repeat(totalBytes));
    });

    const result = await runCommandInProcess(ZeroCapCmd, ["test"], {
      cwd: tmpRoot,
      stdoutCap: 0,
    });

    expect(result.stdoutBytes.byteLength).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytesOmitted).toBe(totalBytes);
    expect(result.exitCode).toBe(0);
  });

  it("partial-chunk preservation: when a write straddles the cap, keep the prefix that fits and discard ONLY the overflow", async () => {
    const cap = 10;
    const PartialChunkCmd = makeTestCommand((cmd) => {
      cmd.context.stdout.write("AAAAAAAA"); // 8 bytes — fits entirely
      cmd.context.stdout.write("BBBBB"); // 5 bytes; only "BB" fits
    });

    const result = await runCommandInProcess(PartialChunkCmd, ["test"], {
      cwd: tmpRoot,
      stdoutCap: cap,
    });

    expect(result.stdoutBytes.toString("utf8")).toBe("AAAAAAAABB");
    expect(result.stdoutBytes.byteLength).toBe(cap);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytesOmitted).toBe(3);
  });

  it("multi-byte byte accounting: emoji bytes counted correctly (NOT chars/UTF-16 code units)", async () => {
    const cap = 9;
    const emoji = "😀"; // U+1F600 → 4 UTF-8 bytes
    const totalBytes = 12;
    const overflowBy = totalBytes - cap;
    const MultiByteCmd = makeTestCommand((cmd) => {
      cmd.context.stdout.write(emoji.repeat(3));
    });

    const result = await runCommandInProcess(MultiByteCmd, ["test"], {
      cwd: tmpRoot,
      stdoutCap: cap,
    });

    expect(result.stdoutBytes.byteLength).toBe(cap);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytesOmitted).toBe(overflowBy);
    expect(result.stdoutBytes[0]).toBe(0xf0);
    expect(result.stdoutBytes[8]).toBe(0xf0);
  });
});

describe("runCommandInProcess — multi-type writes", () => {
  it("captures string, Buffer, and Uint8Array writes correctly (all three types Clipanion's BaseContext.stdout supports)", async () => {
    const MultiTypeCmd = makeTestCommand((cmd) => {
      cmd.context.stdout.write("hello ");
      cmd.context.stdout.write(Buffer.from("from "));
      cmd.context.stdout.write(new Uint8Array([66, 117, 102, 102, 101, 114, 33]));
    });

    const result = await runCommandInProcess(MultiTypeCmd, ["test"], { cwd: tmpRoot });
    expect(result.stdoutBytes.toString("utf8")).toBe("hello from Buffer!");
    expect(result.stdoutTruncated).toBe(false);
  });
});

describe("runCommandInProcess — concurrency: FIFO mutex serializes calls; each preserves its own cwd", () => {
  it("two concurrent calls with different cwds are serialized; each Command sees its own cwd BEFORE and AFTER an async delay (proves cwd cannot be clobbered mid-execution)", async () => {
    const tmpRootB = await mkdtemp(join(tmpdir(), "viberevert-rcip-B-"));
    try {
      const observationsA: string[] = [];
      const observationsB: string[] = [];

      const CmdA = makeTestCommand(async () => {
        observationsA.push(process.cwd());
        await new Promise((r) => setTimeout(r, 50));
        observationsA.push(process.cwd());
      });

      const CmdB = makeTestCommand(async () => {
        observationsB.push(process.cwd());
        await new Promise((r) => setTimeout(r, 50));
        observationsB.push(process.cwd());
      });

      await Promise.all([
        runCommandInProcess(CmdA, ["test"], { cwd: tmpRoot }),
        runCommandInProcess(CmdB, ["test"], { cwd: tmpRootB }),
      ]);

      expect(observationsA).toHaveLength(2);
      expect(observationsA[0]).toBe(resolve(tmpRoot));
      expect(observationsA[1]).toBe(resolve(tmpRoot));

      expect(observationsB).toHaveLength(2);
      expect(observationsB[0]).toBe(resolve(tmpRootB));
      expect(observationsB[1]).toBe(resolve(tmpRootB));
    } finally {
      await rm(tmpRootB, { recursive: true, force: true });
    }
  });
});

describe("runCommandInProcess — argv + env defensive copying", () => {
  it("process.argv AND process.cwd() are NOT mutated by the harness (host state preserved, even on the cli.process-rethrow path)", async () => {
    const argvBefore = [...process.argv];
    const cwdBefore = process.cwd();
    const TestCmd = makeTestCommand(() => 0);
    // The harness switched from cli.run() to cli.process() +
    // validateAndExecute() so unexpected Command throws propagate
    // with object identity preserved (D99.E + file-header lock #5).
    // One side effect of using cli.process() is that clipanion
    // throws UnknownSyntaxError for an unparsed flag instead of
    // catch-and-write-stderr-and-return-1 (which is what cli.run
    // does). TestCmd has no `--flag` Option declared, so passing
    // `["test", "--flag", "value"]` ALWAYS produces an
    // UnknownSyntaxError — we use this as the test vehicle to
    // verify TWO host-state-preservation contracts hold under
    // the rejection path:
    //
    //   1. argv shallow-copy: process.argv is unchanged.
    //   2. cwd restoration: process.cwd() is restored to its
    //      pre-call value, even though the harness threw before
    //      Command execution.
    //
    // Strictly stronger than the prior success-path-only check
    // — and complements the dedicated "cwd restored on Command
    // throw" test (which covers the in-execute throw path) with
    // coverage of the pre-execute parse-error throw path.
    await expect(
      runCommandInProcess(TestCmd, ["test", "--flag", "value"], { cwd: tmpRoot }),
    ).rejects.toThrow();
    expect(process.argv).toEqual(argvBefore);
    expect(process.cwd()).toBe(cwdBefore);
  });

  it("process.env is NOT mutated by the Command (shallow-copy isolation)", async () => {
    const probeKey = "VIBEREVERT_RCIP_PROBE_KEY";
    const probeValueBefore = "before";
    process.env[probeKey] = probeValueBefore;
    try {
      const EnvMutatingCmd = makeTestCommand((cmd) => {
        cmd.context.env[probeKey] = "after";
      });
      await runCommandInProcess(EnvMutatingCmd, ["test"], { cwd: tmpRoot });
      expect(process.env[probeKey]).toBe(probeValueBefore);
    } finally {
      delete process.env[probeKey];
    }
  });
});

describe("runCommandInProcess — cap validation (rejects Promise BEFORE side effects)", () => {
  it.each([
    ["stdoutCap", -1],
    ["stdoutCap", Number.NaN],
    ["stdoutCap", Number.POSITIVE_INFINITY],
    ["stdoutCap", 1.5],
    ["stderrCap", -1],
    ["stderrCap", Number.NaN],
    ["stderrCap", Number.POSITIVE_INFINITY],
    ["stderrCap", 1.5],
  ])("rejects %s=%p with RangeError BEFORE any chdir or Command execution", async (capName, badCap) => {
    let commandExecuted = false;
    const ShouldNotRunCmd = makeTestCommand(() => {
      commandExecuted = true;
    });
    const cwdBefore = process.cwd();

    await expect(
      runCommandInProcess(ShouldNotRunCmd, ["test"], {
        cwd: tmpRoot,
        [capName]: badCap,
      } as Parameters<typeof runCommandInProcess>[2]),
    ).rejects.toBeInstanceOf(RangeError);

    expect(commandExecuted).toBe(false);
    expect(process.cwd()).toBe(cwdBefore);
  });
});

describe("runCommandInProcess — D99.X non-forwarding (process.std{out,err}.write is NEVER called)", () => {
  it("monkey-patches process.stdout.write + process.stderr.write; runs a noisy Command (100 lines each); asserts ZERO calls to the real process streams", async () => {
    // Store the UNBOUND original method references — restoring with
    // these preserves prototype-method identity. Storing
    // `process.stdout.write.bind(process.stdout)` would create a NEW
    // function object; restoring would put the bound copy on the
    // process stream instead of the original (functionally
    // equivalent for callers, but more global-state mutation than
    // necessary).
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    let stdoutCalls = 0;
    let stderrCalls = 0;

    process.stdout.write = ((..._args: unknown[]): boolean => {
      stdoutCalls += 1;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((..._args: unknown[]): boolean => {
      stderrCalls += 1;
      return true;
    }) as typeof process.stderr.write;

    try {
      const NoisyCmd = makeTestCommand((cmd) => {
        for (let i = 0; i < 100; i += 1) {
          cmd.context.stdout.write(`noisy stdout line ${i}\n`);
          cmd.context.stderr.write(`noisy stderr line ${i}\n`);
        }
      });
      await runCommandInProcess(NoisyCmd, ["test"], { cwd: tmpRoot });
    } finally {
      // CRITICAL: restore the originals BEFORE any expect() so vitest's
      // output infrastructure can report assertion outcomes via the
      // real streams.
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    expect(stdoutCalls).toBe(0);
    expect(stderrCalls).toBe(0);
  });
});
