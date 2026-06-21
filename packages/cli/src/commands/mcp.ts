// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert mcp serve` -- boots the MCP server over stdio. Lives
// in the CLI binary package (NOT in @viberevert/cli-commands or
// @viberevert/mcp) because:
//
//   1. D99.M.16 (no-forward-cycle): @viberevert/mcp MUST NOT
//      depend on the `viberevert` CLI binary package. Having
//      MCPCommand in the CLI package keeps the import direction
//      one-way (cli -> mcp), avoiding the cycle.
//   2. The CLI binary is the natural owner of the MCP server's
//      process lifecycle (process.exit, human stderr, signal
//      handlers go to clipanion's runExit). The mcp library
//      throws/returns; this command translates.
//
// Architectural locks (D99.N + D99.M.14 boundary):
//
//   D99.N -- Injectable StartServerLoader seam. Tests override
//   MCPCommand.loader with a throwing loader (or a stub) to
//   exercise the boot-failure / success paths WITHOUT
//   ESM-module-mocking the dynamic import (which is brittle
//   across vitest/Node versions). Production uses defaultLoader
//   which performs the dynamic import.
//
//   D99.M.14 (mcp side) -- @viberevert/mcp's startServer NEVER
//   calls process.exit, process.stdout.write, or
//   process.stderr.write. This command file inherits the
//   discipline at the CLI boundary: execute() returns 0 or 1;
//   clipanion's runExit() handles the actual process.exit().
//   Human-facing stderr is owned by THIS file (this.context.stderr
//   .write); the mcp library does not write to stderr.
//
//   D99.P -- startServer({cwd}) is the contract: resolves on
//   graceful shutdown (SIGINT / SIGTERM / transport close);
//   rejects on boot failure or unhealthy shutdown. This command
//   awaits it; on resolve return 0; on reject write a one-line
//   stderr diagnostic and return 1.
//
// Two paths registered to ONE class:
//   - ["mcp"]          -- bare invocation; print help, exit 0
//   - ["mcp", "serve"] -- boot the server
//
// Path discrimination at runtime via this.path.length (1 = bare
// "mcp", 2 = "mcp serve"). Clipanion populates this.path with the
// matched tokens.

import { Command } from "clipanion";

// ============================================================================
// Injectable loader seam (D99.N)
// ============================================================================

/**
 * Async factory returning the @viberevert/mcp module namespace.
 * Tests override MCPCommand.loader with a throwing loader OR a
 * stub returning `{ startServer: () => Promise<void> }` to
 * exercise boot-failure / success paths without ESM-module-mocking
 * the real dynamic import.
 */
export type StartServerLoader = () => Promise<typeof import("@viberevert/mcp")>;

/**
 * Production loader: dynamic import of the mcp barrel. Dynamic
 * (not static) so the mcp module isn't loaded for non-mcp
 * invocations of the viberevert binary -- keeps `viberevert
 * --version` / `viberevert doctor` fast and avoids paying the
 * SDK + audit import cost when the user isn't running the server.
 */
const defaultLoader: StartServerLoader = () => import("@viberevert/mcp");

// ============================================================================
// Helpers (module-private)
// ============================================================================

/**
 * Render a thrown value as a one-line diagnostic for stderr.
 * Mirrors the cli-commands handleKnownError pattern: extract
 * .message from real Errors; String() everything else. When
 * .cause is present (e.g., McpBootError wrapping the underlying
 * SDK transport error from server.onerror), append it so the
 * actual cause is visible at the stderr boundary -- the static
 * outer message alone is insufficient for diagnosing transport
 * or boot failures (locked after Step 3 CI iterations showed
 * "MCP server transport error" repeatedly without the SDK's
 * underlying message). The cause's error.name is included
 * because SDK transport errors often distinguish via class
 * (e.g., "Error" vs "TypeError") in addition to message text.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.cause instanceof Error) {
      return `${err.message}: ${err.cause.name}: ${err.cause.message}`;
    }
    if (err.cause !== undefined) {
      return `${err.message}: ${String(err.cause)}`;
    }
    return err.message;
  }
  return String(err);
}

// ============================================================================
// MCPCommand
// ============================================================================

export class MCPCommand extends Command {
  static override paths = [["mcp"], ["mcp", "serve"]];

  static override usage = Command.Usage({
    category: "MCP",
    description: "Boot the VibeRevert Model Context Protocol server over stdio",
    details: `
      \`viberevert mcp serve\` boots the MCP server, exposing the
      8 VibeRevert tools (check_repo, explain_diff, classify_risk,
      list_risky_files, get_policy, start_session,
      create_checkpoint, generate_fix_prompt) over JSON-RPC on
      stdio. The server binds to the current working directory's
      repo root at boot; subsequent tool calls operate on that
      repo for the server's lifetime.

      The server runs until SIGINT (Ctrl+C), SIGTERM, or stdin
      close. On graceful shutdown it exits 0; on boot failure or
      audit-integrity failure it writes a one-line diagnostic to
      stderr and exits 1.

      \`viberevert mcp\` (without "serve") prints this help and
      exits 0.
    `,
    examples: [
      ["Boot the MCP server over stdio", "viberevert mcp serve"],
      ["Print this help", "viberevert mcp"],
    ],
  });

  /**
   * Injectable seam (D99.N). Tests override this static property
   * to inject a fake loader (throwing or stubbed). Production
   * uses defaultLoader which performs the real dynamic import.
   *
   * Static, not instance, so the override persists across the
   * single Command instance clipanion constructs per invocation.
   */
  static loader: StartServerLoader = defaultLoader;

  override async execute(): Promise<number> {
    // Discriminate between the two registered paths via the
    // matched-token length. Clipanion populates this.path with
    // the tokens after the binary name, so:
    //   `viberevert mcp`       -> this.path = ["mcp"]       (length 1)
    //   `viberevert mcp serve` -> this.path = ["mcp", "serve"] (length 2)
    if (this.path.length === 1) {
      // Bare `viberevert mcp`: print the same help clipanion
      // would render for `viberevert mcp --help`, then exit 0.
      // Pulls from the registered usage metadata so help stays
      // single-source-of-truth with the Command.Usage block above.
      this.context.stdout.write(this.cli.usage(MCPCommand, { detailed: true }));
      return 0;
    }

    // `viberevert mcp serve`: load the mcp module (dynamic import
    // via the injectable loader seam) and boot the server.
    try {
      const { startServer } = await MCPCommand.loader();
      await startServer({ cwd: process.cwd() });
      return 0;
    } catch (err) {
      // D99.P contract: startServer rejects on boot failure
      // (McpBootError) or unhealthy shutdown. Write a one-line
      // diagnostic to stderr (this.context.stderr -- never
      // process.stderr.write, never process.exit) and return 1.
      // Clipanion's runExit() translates the return value into
      // the actual process exit code.
      this.context.stderr.write(`viberevert mcp serve failed: ${formatError(err)}\n`);
      return 1;
    }
  }
}
