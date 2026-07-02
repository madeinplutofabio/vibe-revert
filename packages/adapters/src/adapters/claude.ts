// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code adapter for @viberevert/adapters.
 *
 * Emits a json-key-merge plan that adds the VibeRevert MCP server to
 * <repo>/.mcp.json under mcpServers.viberevert as a stdio server
 * (docs.claude.com/docs/en/mcp-quickstart, verified 2026-06-30).
 *
 * Read-only per D101.A: never mutates fs, never reads
 * .viberevert/integrations.json.
 *
 * Project-local per D101.F: Claude Code's --scope project (repo-root
 * .mcp.json) only. --scope user (~/.claude.json) and --scope local
 * are out of scope in v1.
 *
 * Intent-gated per D101.J:
 *   - "explicit": always detected.
 *   - "all": require on-disk signal. Priority: .mcp.json (target
 *     present, any kind) > .claude/ (strict dir-shape check). The
 *     ordering is locked by claude.test.ts.
 *
 * plan() is declarative and does not read fs or inspect ctx; every
 * nested value is freshly constructed so callers cannot mutate a
 * returned plan into a subsequent plan()'s state (test-locked).
 */

import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type {
  Adapter,
  AdapterContext,
  AdapterPlan,
  DetectResult,
  JsonValue,
  RecordKey,
} from "../types.js";

// Display name (CLI output + logs). Distinct from RECORD_KEY, which is
// the durable storage key. Matches Anthropic's product name.
const ADAPTER_NAME = "Claude Code";

// Durable storage key per D101.O; matches the RecordKey enum.
const RECORD_KEY: RecordKey = "claude";

// POSIX forward slashes per D101.D. Target lives at the repo root
// (Claude Code --scope project), NOT under .claude/.
const TARGET_PATH_RELATIVE = ".mcp.json";
const TARGET_PATH_TEMPLATE = `{repo}/${TARGET_PATH_RELATIVE}`;

const HUMAN_SUMMARY = "Install the VibeRevert MCP server into Claude Code's mcpServers config";

/**
 * lstat the path; return null on ENOENT; propagate any other I/O
 * error. Explicit-null contract avoids swallowing EACCES / ELOOP /
 * ENOTDIR, which are real bug signals here.
 */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export const claudeAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(ctx: AdapterContext): Promise<DetectResult> {
    if (ctx.intent === "explicit") {
      return { detected: true, signal: { intent: "explicit" } };
    }

    // intent === "all": two independent signals; prefer the target
    // file (strongest) over the softer config-dir heuristic.
    const mcpJsonStat = await lstatOrNull(join(ctx.repoRoot, ".mcp.json"));
    if (mcpJsonStat !== null) {
      return { detected: true, signal: { intent: "all", trigger: "mcp.json-present" } };
    }

    // Strict dir-shape check: a regular file at .claude is NOT a
    // positive signal (mirror of Cursor's .cursor/ discipline).
    const claudeDirStat = await lstatOrNull(join(ctx.repoRoot, ".claude"));
    if (claudeDirStat?.isDirectory() === true) {
      return { detected: true, signal: { intent: "all", trigger: "claude-dir-present" } };
    }

    return {
      detected: false,
      reason: "no .mcp.json file or .claude/ directory found in repo",
      signal: { intent: "all" },
    };
  },

  plan(): Promise<AdapterPlan> {
    return Promise.resolve({
      status: "applicable",
      adapterName: ADAPTER_NAME,
      humanSummary: HUMAN_SUMMARY,
      ops: [
        {
          kind: "json-key-merge",
          target: {
            scope: "repo",
            pathTemplate: TARGET_PATH_TEMPLATE,
            pathRelative: TARGET_PATH_RELATIVE,
          },
          keyPath: ["mcpServers", "viberevert"],
          value: {
            type: "stdio",
            command: "viberevert",
            args: ["mcp", "serve"],
          } satisfies JsonValue,
        },
      ],
      recordKey: RECORD_KEY,
      meta: {},
    });
  },
};
