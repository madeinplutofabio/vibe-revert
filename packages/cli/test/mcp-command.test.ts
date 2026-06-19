// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/cli/src/commands/mcp.ts.
//
// Test focus:
//   - Bare `viberevert mcp` (no "serve") path -- prints help to
//     stdout, exits 0, does NOT invoke the loader. Two assertions
//     enforce "not called": (a) throwing-stub loader (the throw
//     would surface as exit 1 if accidentally invoked), AND
//     (b) explicit `loaderCalled === 0` counter. Belt-and-suspenders
//     so a future refactor that catches/swallows loader exceptions
//     would still fail loudly.
//   - `viberevert mcp serve` happy path -- invokes the injected
//     loader exactly once, awaits its startServer exactly once with
//     a single `{cwd: process.cwd()}` argument (asserted via
//     toEqual on the captured opts array -- locks BOTH call count
//     AND argument SHAPE; future addition of extra fields like
//     `{cwd, port}` would break the assertion deliberately).
//     Returns 0, NO stdout, NO stderr.
//   - Boot-failure paths (3 variants):
//       a) loader factory rejects synchronously
//       b) loader resolves but startServer rejects with an
//          McpBootError-like Error
//       c) non-Error throw (string thrown) -- formatError falls
//          back to String(err)
//     All assert exit 1 + NO stdout + the exact stderr line
//     "viberevert mcp serve failed: <message>\n".
//
// Stdout discipline (ALL serve paths assert `stdout === ""`):
// `viberevert mcp serve` will, in production, hand stdio to the
// MCP server's StdioServerTransport. That transport speaks
// JSON-RPC over the process's real stdout. Any stray
// `this.context.stdout.write(...)` from MCPCommand.execute()
// would corrupt the protocol byte stream (clients would see
// human text interleaved with JSON-RPC frames -> framing break,
// client disconnect). Locking stdout to empty on the test
// command instance is a regression wall: a future refactor that
// adds a "Booting server..." line to stdout would fail the test
// instead of silently breaking the MCP protocol in production.
// Human diagnostics on serve paths go to STDERR only.
//
// Mock strategy: the D99.N injectable loader seam
// (`MCPCommand.loader = <stub>`) replaces the dynamic import with
// a test-supplied factory. NO vi.mock on the mcp module -- the
// whole point of the seam is to avoid ESM-module-mocking brittleness
// across vitest/Node versions. `afterEach` restores the original
// loader so test order does not matter and a forgotten override
// in one test cannot leak into the next.
//
// Output capture: Clipanion's `cli.run(argv, context)` accepts a
// custom context with stdout/stderr Writable streams. Per-test
// stdout/stderr buffers (Writable wrappers around in-memory Buffer
// chunks) replace the real process streams; the buffered text is
// asserted directly. Cli.run() returns the exit code WITHOUT
// calling process.exit (that's runExit() -- which we do NOT use
// in tests because it would terminate the vitest process).

import { Writable } from "node:stream";

import { Builtins, Cli } from "clipanion";
import { afterEach, describe, expect, it } from "vitest";

import { MCPCommand, type StartServerLoader } from "../src/commands/mcp.js";

// ============================================================================
// Loader save/restore for test isolation
// ============================================================================

/**
 * Captured at module load time -- the production defaultLoader.
 * `afterEach` resets MCPCommand.loader to this value so:
 *   - a test that forgot to set a stub still sees a known starting
 *     state in the NEXT test (not a leaked override from a prior
 *     test), and
 *   - the production loader (real dynamic import) is restored after
 *     the suite completes, so any downstream code in the same vitest
 *     process behaves as in production.
 */
const ORIGINAL_LOADER = MCPCommand.loader;

afterEach(() => {
  MCPCommand.loader = ORIGINAL_LOADER;
});

// ============================================================================
// Test helpers
// ============================================================================

type BufferedStream = {
  readonly stream: Writable;
  getText(): string;
};

/**
 * Build a Writable stream that buffers all chunks in memory.
 * Used to capture clipanion's stdout/stderr output for assertion.
 * Node's Buffer.concat preserves byte order, so multi-write
 * sequences (e.g., write("a"); write("b")) produce "ab" verbatim.
 */
function makeBufferedStream(): BufferedStream {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return {
    stream,
    getText: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Build a fresh Cli with MCPCommand + Builtins.HelpCommand
 * registered. Mirrors the production packages/cli/src/index.ts
 * wiring closely enough that the test exercises the same
 * registration semantics, but without registering the other 14
 * commands (which the MCPCommand tests do not need).
 */
function buildCli(): Cli {
  const cli = new Cli({
    binaryName: "viberevert",
    binaryLabel: "VibeRevert",
    binaryVersion: "0.0.0-test",
  });
  cli.register(Builtins.HelpCommand);
  cli.register(MCPCommand);
  return cli;
}

/**
 * Construct a stub `typeof import("@viberevert/mcp")` namespace
 * containing just the `startServer` function the dispatcher uses.
 * The `as unknown as` cast bypasses TS's full-namespace check --
 * MCPCommand only destructures `startServer` from the loader's
 * return value, so a partial stub is functionally complete.
 */
function stubMcpModule(
  startServer: (opts: { cwd: string }) => Promise<void>,
): typeof import("@viberevert/mcp") {
  return { startServer } as unknown as typeof import("@viberevert/mcp");
}

/**
 * Invoke `cli.run(argv)` with buffered stdout/stderr and return
 * the captured exit code + text. Uses process.stdin for the
 * stdin context field (MCPCommand never reads stdin in tests --
 * the real server-stdio handoff happens INSIDE startServer, which
 * is stubbed here).
 */
async function runCli(
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutBuf = makeBufferedStream();
  const stderrBuf = makeBufferedStream();
  const cli = buildCli();
  const exitCode = await cli.run([...argv], {
    stdout: stdoutBuf.stream as unknown as NodeJS.WriteStream,
    stderr: stderrBuf.stream as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    env: process.env,
  });
  return {
    exitCode,
    stdout: stdoutBuf.getText(),
    stderr: stderrBuf.getText(),
  };
}

// ============================================================================
// A. Bare `viberevert mcp` (no serve) -- help + exit 0
// ============================================================================

describe("MCPCommand: A. bare `viberevert mcp` (no serve subcommand)", () => {
  it("exits 0 with usage text on stdout; loader is NOT called", async () => {
    // Belt-and-suspenders enforcement of "loader is not called":
    //   1. Throwing-stub loader -- if the help path accidentally
    //      invokes the loader, the throw surfaces as exit 1 and
    //      the exit-code assertion below fails loudly.
    //   2. Explicit counter -- structural assertion that survives
    //      any refactor that catches/swallows loader exceptions
    //      (e.g., if execute() ever gains a try/catch around the
    //      loader call on the bare path, the throw alone would
    //      become invisible; the counter still catches it).
    let loaderCalled = 0;
    MCPCommand.loader = (async () => {
      loaderCalled++;
      throw new Error("loader must not be called on bare `mcp` path");
    }) as StartServerLoader;

    const { exitCode, stdout, stderr } = await runCli(["mcp"]);

    expect(exitCode).toBe(0);
    // Direct counter assertion -- structural lock on the
    // "not called" contract.
    expect(loaderCalled).toBe(0);
    // Usage text comes from cli.usage(MCPCommand, {detailed:true})
    // which renders the registered Command.Usage metadata. The
    // canonical invocation form appears in the examples block.
    expect(stdout).toContain("viberevert mcp serve");
    // Happy path: no stderr.
    expect(stderr).toBe("");
  });
});

// ============================================================================
// B. `viberevert mcp serve` happy path (loader resolves, startServer resolves)
// ============================================================================

describe("MCPCommand: B. `viberevert mcp serve` happy path", () => {
  it("invokes loader once, awaits startServer exactly once with {cwd: process.cwd()}, returns 0, NO stdout/stderr", async () => {
    let loaderCalled = 0;
    // Capture EVERY call's opts as-is into an array. Asserting
    // `toEqual([{cwd: process.cwd()}])` locks in ONE assertion:
    //   - call count (array length 1)
    //   - argument SHAPE (no extra fields like `port`, `signal`,
    //     `transport` that a future refactor might silently add)
    //   - cwd VALUE (process.cwd() at test time)
    // Future addition of a legitimate field requires this test
    // to be updated deliberately -- contract change is visible.
    const startServerOpts: Array<{ cwd: string }> = [];

    MCPCommand.loader = async () => {
      loaderCalled++;
      return stubMcpModule(async (opts) => {
        startServerOpts.push(opts);
      });
    };

    const { exitCode, stdout, stderr } = await runCli(["mcp", "serve"]);

    expect(exitCode).toBe(0);
    expect(loaderCalled).toBe(1);
    // Single assertion locks call count AND argument shape AND
    // cwd value (D99.M.17 / D99.P: boot binding via process.cwd,
    // no extra fields).
    expect(startServerOpts).toEqual([{ cwd: process.cwd() }]);
    // Serve path stdout discipline: in production, stdout is the
    // MCP JSON-RPC byte channel. Any stray write from
    // MCPCommand.execute() would corrupt the protocol stream.
    // Locked empty here so a future regression fails the test
    // instead of silently breaking the wire format.
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});

// ============================================================================
// C. Boot-failure stderr + exit 1
// ============================================================================

describe("MCPCommand: C. boot-failure stderr + exit 1", () => {
  it("loader factory rejects -> NO stdout, stderr 'viberevert mcp serve failed: <msg>' + exit 1", async () => {
    MCPCommand.loader = (async () => {
      throw new Error("loader synchronously rejected");
    }) as StartServerLoader;

    const { exitCode, stdout, stderr } = await runCli(["mcp", "serve"]);

    expect(exitCode).toBe(1);
    // Stdout discipline on the failure path: same as happy path
    // (see test B comment) -- stdout is the JSON-RPC byte channel
    // in production; failure diagnostics go to STDERR only.
    expect(stdout).toBe("");
    expect(stderr).toBe("viberevert mcp serve failed: loader synchronously rejected\n");
  });

  it("startServer rejects with McpBootError-like Error -> NO stdout, same stderr shape + exit 1", async () => {
    MCPCommand.loader = async () =>
      stubMcpModule(async () => {
        // McpBootError extends Error; its .message starts with
        // "MCP server boot failed: ...". This stub mimics the
        // real shape so the stderr assertion locks the
        // user-facing diagnostic verbatim.
        throw new Error("MCP server boot failed: repo root not resolved");
      });

    const { exitCode, stdout, stderr } = await runCli(["mcp", "serve"]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "viberevert mcp serve failed: MCP server boot failed: repo root not resolved\n",
    );
  });

  it("non-Error throw (string thrown) -> NO stdout, stderr formats via String(err) + exit 1", async () => {
    MCPCommand.loader = (async () => {
      throw "string thrown";
    }) as StartServerLoader;

    const { exitCode, stdout, stderr } = await runCli(["mcp", "serve"]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    // formatError(err) falls through to String(err) for non-Error
    // throws. Locks the contract that a thrown string (or other
    // non-Error value) still produces a stable diagnostic, not
    // "viberevert mcp serve failed: [object Object]" or similar.
    expect(stderr).toBe("viberevert mcp serve failed: string thrown\n");
  });
});
