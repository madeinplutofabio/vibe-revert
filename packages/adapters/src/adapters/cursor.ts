// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor adapter for @viberevert/adapters.
 *
 * Detects the user's intent + on-disk evidence of Cursor configuration
 * and emits a json-key-merge plan that adds the VibeRevert MCP server
 * to <repo>/.cursor/mcp.json under mcpServers.viberevert.
 *
 * Per D101.A (read-only adapter discipline): this module MUST NOT
 * mutate the filesystem and MUST NOT read .viberevert/integrations.json.
 * detect() reads repo state to decide signal; plan() does not read fs
 * or inspect ctx at all -- the plan is purely declarative.
 *
 * Per D101.F (project-local only): the target is repo-relative
 * (.cursor/mcp.json) -- never a home directory or global Cursor config.
 * v1 has no --global support.
 *
 * Per D101.J (intent-gated detection):
 *   - ctx.intent === "explicit": user named --cursor on the CLI; always
 *     report detected so the plan runs.
 *   - ctx.intent === "all": adapter must show real on-disk evidence
 *     before reporting detected. Strict dir-shape check on .cursor/:
 *     a regular file at that path is NOT a positive signal (preflight
 *     would later refuse anyway; detection stays conservative for
 *     "all" to avoid implying the user has Cursor configured when they
 *     don't).
 *
 * Detection order for intent="all":
 *   1. lstat .cursor/ -- if missing OR not a directory -> not detected.
 *   2. .cursor/ is a real dir -> lstat .cursor/mcp.json. If present
 *      (any kind), emit the more specific "mcp.json-present" trigger.
 *      Otherwise emit "cursor-dir-present".
 * Checking .cursor/ first avoids a spurious ENOTDIR from lstat on
 * .cursor/mcp.json when .cursor is a regular file.
 *
 * plan() is purely declarative: it does NOT read the filesystem and
 * does NOT inspect ctx. The Adapter interface declares
 * plan(ctx: AdapterContext): TypeScript method bivariance accepts a
 * zero-arg implementation that satisfies the same return contract.
 * Every nested value returned (target object, keyPath array, value
 * object, meta object, ops array) is freshly constructed per call so
 * external mutation of one returned plan cannot leak back into a
 * subsequent plan() call (mutation-safe per locked discipline).
 */

import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { Adapter, AdapterContext, AdapterPlan, DetectResult, RecordKey } from "../types.js";

// Display-only adapter name (CLI output + logs). Distinct from
// RECORD_KEY which is the durable storage key.
const ADAPTER_NAME = "Cursor";

// Durable storage key written into .viberevert/integrations.json
// records[]. Locked per D101.O; matches the RecordKey enum.
const RECORD_KEY: RecordKey = "cursor";

// Repo-relative target -- POSIX forward slashes per D101.D.
const TARGET_PATH_RELATIVE = ".cursor/mcp.json";
const TARGET_PATH_TEMPLATE = `{repo}/${TARGET_PATH_RELATIVE}`;

// Human-readable summary surfaced by preview/apply receipts.
const HUMAN_SUMMARY = "Install the VibeRevert MCP server into Cursor's mcpServers config";

/**
 * lstat the path; return null on ENOENT; propagate any other I/O
 * error. Explicit-null contract avoids silently swallowing EACCES /
 * ELOOP / ENOTDIR / etc. which should surface to the caller. Detection
 * never tries to follow into a non-directory parent, so ENOTDIR
 * propagation is a real bug signal, not a non-event.
 */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The `.cursor/mcp.json` launcher value for VibeRevert, by host platform.
 *
 * On Windows, Cursor cannot spawn the bare `viberevert` `.cmd` shim, so this
 * emits the verified `cmd /c viberevert mcp serve` form (the consuming Cursor
 * client owns the spawn; the installer only writes configuration data). On other
 * platforms the bare form is kept. The shape is exactly the Run-1B-verified
 * workaround — no `type`, no `/d`/`/s`, no quoting changes, no absolute paths,
 * no `node`/`npx` — so it introduces no new mechanism requiring fresh Cursor
 * validation.
 *
 * The Windows form is host-specific; the install command surfaces a portability
 * warning when it is emitted. Claude MCP and the direct hook stay bare.
 *
 * Module-exported for direct unit tests only; not part of any package barrel.
 */
export function buildCursorMcpLaunchValue(platform: NodeJS.Platform): {
  command: string;
  args: string[];
} {
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "viberevert", "mcp", "serve"] };
  }
  return { command: "viberevert", args: ["mcp", "serve"] };
}

export const cursorAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(ctx: AdapterContext): Promise<DetectResult> {
    if (ctx.intent === "explicit") {
      return { detected: true, signal: { intent: "explicit" } };
    }

    // intent === "all": require real on-disk evidence. Check .cursor/
    // first as a real directory (avoids ENOTDIR if .cursor is a regular
    // file). If .cursor/ isn't a directory, nothing under it can exist
    // either, so we exit not-detected immediately.
    const cursorDirStat = await lstatOrNull(join(ctx.repoRoot, ".cursor"));
    if (cursorDirStat === null || !cursorDirStat.isDirectory()) {
      return {
        detected: false,
        reason: "no .cursor/ directory or .cursor/mcp.json file found in repo",
        signal: { intent: "all" },
      };
    }

    // .cursor/ is a real directory; check for mcp.json. If present
    // (any kind -- preflight refuses symlinks later), emit the more
    // specific trigger.
    const mcpJsonStat = await lstatOrNull(join(ctx.repoRoot, ".cursor", "mcp.json"));
    if (mcpJsonStat !== null) {
      return { detected: true, signal: { intent: "all", trigger: "mcp.json-present" } };
    }

    return { detected: true, signal: { intent: "all", trigger: "cursor-dir-present" } };
  },

  // Zero-arg implementation satisfies the Adapter interface's
  // plan(ctx) contract via method bivariance. ctx is intentionally
  // absent: the plan is purely declarative -- no fs reads, no intent
  // or flag inspection. Every nested object/array is freshly
  // constructed per call so a caller mutating the returned plan
  // cannot leak into a subsequent plan() invocation.
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
          value: buildCursorMcpLaunchValue(process.platform),
        },
      ],
      recordKey: RECORD_KEY,
      meta: {},
    });
  },
};
