// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Shared command-harness helpers used by every command-backed MCP
// tool (check_repo, explain_diff, classify_risk, list_risky_files).
//
// The helpers centralize the proven common mechanics ONLY:
//
//   - absolute repoRoot guard (defensive vs Step 4 boot binding)
//   - runCommandInProcess call (Clipanion-in-process harness)
//   - stdoutTruncated -> MCP_COMMAND_OUTPUT_TOO_LARGE per D99.W + R26
//   - stdoutBytes UTF-8 decode
//   - JSON.parse (json helper only)
//   - canonical-schema safeParse (json helper only)
//   - exit 1 / unexpected-exit -> INTERNAL_ERROR with sanitized stderr
//   - stderr sanitization (control-char strip + cap)
//
// Tool-specific logic stays in each tools/*.ts file:
//
//   - argv construction
//   - input schema (Zod) + safeParse
//   - success data projection (D99.Q per-tool shape)
//   - D99.U cap shape (discriminated-union switch, summary, etc.)
//   - blocked / risk semantics
//   - description text
//
// Two helpers (per locked Slice 3.4 direction, "Option A split"):
//
//   runRawCommandHarness  -- for tools that consume raw stdout
//                            (e.g., explain_diff's --markdown call)
//   runJsonCommandHarness -- for tools that consume JSON stdout
//                            (e.g., check_repo, classify_risk,
//                             list_risky_files, explain_diff's
//                             --json call)
//
// Each helper returns a discriminated union:
//
//   { kind: "success", ... }    -- success with parsed payload + stderr metadata
//   { kind: "error", envelope } -- ToolEnvelope error ready to return
//
// Note: stdoutTruncated:true does NOT have a separate result kind --
// it is resolved INSIDE the helper to a kind:"error" envelope with
// MCP_COMMAND_OUTPUT_TOO_LARGE per D99.W. Callers never see the raw
// truncated bytes.
//
// SDK-free: imports only @viberevert/cli-commands (harness +
// CommandClass type via Parameters<...>), envelope (internal),
// and node:path. No @modelcontextprotocol/sdk.

import { isAbsolute } from "node:path";

import { runCommandInProcess } from "@viberevert/cli-commands";

import type { ToolEnvelope } from "./envelope.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Shorthand for Clipanion's Command-class type WITHOUT importing
 * clipanion (D99.M.18). Derived from runCommandInProcess's first
 * parameter to track upstream changes automatically.
 */
type CommandClass = Parameters<typeof runCommandInProcess>[0];

/**
 * Minimal duck type for a schema parser. Zod schemas satisfy this
 * shape. We do NOT import Zod's runtime types here so the helper
 * stays usable with any schema library that follows the same shape.
 */
export type SchemaLike<T> = {
  readonly safeParse: (
    input: unknown,
  ) =>
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: { readonly issues: readonly unknown[] } };
};

/**
 * Opts common to BOTH harness helpers.
 */
export type HarnessOpts = {
  /** The Clipanion Command class to invoke (e.g. CheckCommand, ReportCommand). */
  readonly command: CommandClass;
  /** Tool name -- baked into error messages so the envelope clearly identifies the source. */
  readonly toolName: string;
  /** Full argv INCLUDING the path token (e.g. ["report", "--json", ...]). */
  readonly argv: readonly string[];
  /** Boot-time repo root from ToolHandlerContext. MUST be absolute. */
  readonly repoRoot: string;
  /**
   * Allowed success exit codes for this tool's command:
   *   - check_repo:  [0, 2]  (D99.Q.1: 0 = no blockers, 2 = blockers)
   *   - report tools: [0]    (D47: ReportCommand NEVER exits 2)
   *
   * Exit 1 always maps to INTERNAL_ERROR with sanitized stderr.
   * Any exit code NOT in successExitCodes AND not 1 maps to
   * INTERNAL_ERROR with an "unexpected exit code" message.
   */
  readonly successExitCodes: readonly number[];
};

/**
 * Opts for runJsonCommandHarness -- adds the schema parser.
 *
 * `schemaName` is baked into the parse-failure envelope message so
 * per-tool tests can assert on the specific schema name (e.g.,
 * `"ReportFileSchema"`). Without this, all four tools would emit
 * the same generic message and per-tool failure messages would be
 * indistinguishable.
 */
export type JsonHarnessOpts<T> = HarnessOpts & {
  readonly parser: SchemaLike<T>;
  readonly schemaName: string;
};

export type HarnessSuccessRaw = {
  readonly kind: "success";
  readonly stdoutText: string;
  readonly exitCode: number;
  readonly stderrText: string;
  readonly stderrTruncated: boolean;
  readonly stderrBytesOmitted: number;
};

export type HarnessSuccessJson<T> = HarnessSuccessRaw & {
  readonly parsed: T;
};

export type HarnessError = {
  readonly kind: "error";
  readonly envelope: ToolEnvelope<never>;
};

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Sanitize a free-form message (typically stderr-derived) for safe
 * inclusion in a ToolEnvelope error.message field. Strips ASCII
 * control chars, collapses whitespace, caps at maxLen. Mirrors
 * envelope.ts's private sanitizeMessage exactly.
 */
function sanitizeStderrMessage(input: string, maxLen = 512): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional D99.I R31 sanitization -- strip ASCII control bytes from stderr-derived envelope error messages before protocol output.
  let s = String(input).replace(/[\x00-\x1F\x7F]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) {
    const suffix = "... (truncated)";
    s = s.slice(0, maxLen - suffix.length) + suffix;
  }
  return s;
}

/**
 * Build a ToolEnvelope error.
 */
function errorEnvelope(code: string, message: string, details?: unknown): ToolEnvelope<never> {
  if (details === undefined) {
    return { ok: false, error: { code, message } };
  }
  return { ok: false, error: { code, message, details } };
}

// ============================================================================
// Public: truncateUtf8Text (used by explain_diff for 256 KiB markdown cap)
// ============================================================================

/**
 * Truncate `text` so its UTF-8 byte length does not exceed
 * `capBytes`. When truncation occurs, back off to the nearest
 * complete UTF-8 character boundary so the resulting string is
 * valid UTF-8 (no severed multi-byte sequence).
 *
 * Returns the truncated string + a flag + the exact byte count
 * omitted. When `text` already fits, returns it unchanged with
 * `truncated: false, bytesOmitted: 0`.
 *
 * Continuation-byte detection: a UTF-8 continuation byte has the
 * top bits 10xxxxxx (range 0x80-0xBF). When we slice at
 * `capBytes` and find ourselves inside a multi-byte sequence,
 * back off byte-by-byte until we land on either a leading byte
 * (0x00-0x7F or 0xC0+) or the start of the string.
 *
 * Used by explain_diff for the 256 KiB markdown cap per D99.U.
 * Exported so per-tool files can opt in.
 */
export function truncateUtf8Text(
  text: string,
  capBytes: number,
): { readonly text: string; readonly truncated: boolean; readonly bytesOmitted: number } {
  const full = Buffer.from(text, "utf8");
  if (full.length <= capBytes) {
    return { text, truncated: false, bytesOmitted: 0 };
  }
  let end = capBytes;
  while (end > 0) {
    const byte = full[end];
    if (byte === undefined) break;
    if ((byte & 0xc0) === 0x80) {
      end -= 1;
    } else {
      break;
    }
  }
  const truncated = full.subarray(0, end).toString("utf8");
  return {
    text: truncated,
    truncated: true,
    bytesOmitted: full.length - end,
  };
}

// ============================================================================
// Public: runRawCommandHarness (raw stdout, no JSON parse)
// ============================================================================

/**
 * Invoke a Clipanion command via runCommandInProcess and return
 * the raw stdout string on success, or a clean envelope error on
 * any failure.
 *
 * Failure modes (all return kind:"error"):
 *   - repoRoot is not absolute     -> INTERNAL_ERROR
 *   - runCommandInProcess throws   -> INTERNAL_ERROR with sanitized message
 *   - stdoutTruncated:true         -> MCP_COMMAND_OUTPUT_TOO_LARGE (D99.W + R26)
 *   - exit code === 1              -> INTERNAL_ERROR with sanitized stderr (or fallback)
 *   - exit code not in successExitCodes -> INTERNAL_ERROR with "unexpected exit code"
 *
 * Success returns the decoded stdout + exit code + stderr metadata.
 * The exit code is GUARANTEED to be in opts.successExitCodes.
 */
export async function runRawCommandHarness(
  opts: HarnessOpts,
): Promise<HarnessSuccessRaw | HarnessError> {
  if (!isAbsolute(opts.repoRoot)) {
    return {
      kind: "error",
      envelope: errorEnvelope(
        "INTERNAL_ERROR",
        `${opts.toolName}: context.repoRoot must be an absolute path`,
      ),
    };
  }

  let result: Awaited<ReturnType<typeof runCommandInProcess>>;
  try {
    result = await runCommandInProcess(opts.command, opts.argv, { cwd: opts.repoRoot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      envelope: errorEnvelope(
        "INTERNAL_ERROR",
        sanitizeStderrMessage(`${opts.toolName} command threw: ${message}`),
      ),
    };
  }

  if (result.stdoutTruncated) {
    return {
      kind: "error",
      envelope: errorEnvelope(
        "MCP_COMMAND_OUTPUT_TOO_LARGE",
        `${opts.toolName}: command produced more stdout than the harness can safely capture (cap: 8 MiB). Re-run with narrower scope.`,
        { stdoutBytesOmitted: result.stdoutBytesOmitted },
      ),
    };
  }

  if (opts.successExitCodes.includes(result.exitCode)) {
    return {
      kind: "success",
      stdoutText: result.stdoutBytes.toString("utf8"),
      exitCode: result.exitCode,
      stderrText: result.stderrText,
      stderrTruncated: result.stderrTruncated,
      stderrBytesOmitted: result.stderrBytesOmitted,
    };
  }

  if (result.exitCode === 1) {
    const fallback = `${opts.toolName} command failed`;
    const stderr = result.stderrText.trim();
    const msg = stderr.length > 0 ? sanitizeStderrMessage(stderr) : fallback;
    return { kind: "error", envelope: errorEnvelope("INTERNAL_ERROR", msg) };
  }

  return {
    kind: "error",
    envelope: errorEnvelope(
      "INTERNAL_ERROR",
      sanitizeStderrMessage(
        `${opts.toolName}: unexpected exit code ${result.exitCode} (expected one of: ${opts.successExitCodes.join(", ")})`,
      ),
    ),
  };
}

// ============================================================================
// Public: runJsonCommandHarness (raw + JSON.parse + schema safeParse)
// ============================================================================

/**
 * Like runRawCommandHarness, but additionally JSON-parses stdout
 * and validates against a canonical schema. Returns the parsed
 * value on success.
 *
 * Additional failure modes (vs runRawCommandHarness):
 *   - JSON.parse throws          -> INTERNAL_ERROR ("stdout is not valid JSON")
 *   - parser.safeParse fails     -> INTERNAL_ERROR ("stdout does not match <schemaName>")
 */
export async function runJsonCommandHarness<T>(
  opts: JsonHarnessOpts<T>,
): Promise<HarnessSuccessJson<T> | HarnessError> {
  const raw = await runRawCommandHarness(opts);
  if (raw.kind === "error") return raw;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.stdoutText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      envelope: errorEnvelope(
        "INTERNAL_ERROR",
        sanitizeStderrMessage(`${opts.toolName}: stdout is not valid JSON: ${message}`),
      ),
    };
  }

  const schemaParse = opts.parser.safeParse(parsedJson);
  if (!schemaParse.success) {
    return {
      kind: "error",
      envelope: errorEnvelope(
        "INTERNAL_ERROR",
        `${opts.toolName}: stdout does not match ${opts.schemaName}`,
      ),
    };
  }

  return { ...raw, parsed: schemaParse.data };
}
