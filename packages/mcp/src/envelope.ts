// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// MCP tool-call envelope: discriminated union of {ok:true, data} /
// {ok:false, error}, plus the helpers that translate caught errors
// and ZodError instances into the envelope's error shape.
//
// Architectural locks:
//
//   D99.I -- two-source error model.
//   See errors.ts for full discussion. envelope.ts owns:
//     - MCP_ERROR_CODE_MAP: constructor-keyed registry for VibeRevert
//       domain errors (14 from cli-commands + 5 from core)
//     - toErrorEnvelope: 3-tier lookup (direct brand -> map -> fallback)
//     - formatZodErrorSummary: Zod-error -> compact summary for the
//       Cat 3 invalid-input response (Step 4 dispatcher wire shape)
//
//   R31 -- formatZodErrorSummary scrubs raw input values and caps
//   length so secret bytes (and giant error blobs) cannot leak into
//   the envelope's error.message field.

import {
  AmbiguousReportSelectionError,
  CheckpointNameCollisionError,
  ConcurrentOperationError,
  CreateCheckpointListLoadError,
  InvalidReportSelectionError,
  PromptFixDriftDetectedError,
  PromptFixEmptyFindingsError,
  PromptFixIoFailureError,
  PromptFixReadFailureError,
  PromptFixReportParseError,
  PromptFixStaleRemovalFailureError,
  PromptFixTargetResolutionError,
  ReportNotFoundError,
  RuntimeEnvInvalidError,
} from "@viberevert/cli-commands";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  RepoRootNotFoundError,
  SessionAlreadyActiveError,
} from "@viberevert/core";
import { z } from "zod";

import { McpDirectError } from "./errors.js";

// ============================================================================
// ToolEnvelope type + Zod schemas
// ============================================================================

/**
 * Discriminated union returned by every MCP tool handler.
 *
 * Locked per D99.I:
 *   - {ok: true, data: TData}        success path; TData is per-tool
 *   - {ok: false, error: {...}}      failure path; error.code is the
 *                                    stable string code, error.message
 *                                    is sanitized free-form text,
 *                                    error.details is optional
 *                                    structured payload
 *
 * The Step 4 dispatcher returns this shape as the JSON-RPC
 * `result.structuredContent` for Cat 1 responses (and ALSO writes the
 * JSON-stringified envelope into `result.content[0].text` for clients
 * without structured support; byte-identity assertion lives in the
 * dispatcher tests).
 */
export type ToolEnvelope<TData> =
  | { ok: true; data: TData }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/**
 * Build a Zod schema for ToolEnvelope<T> given a Zod schema for T.
 *
 * All object schemas are STRICT (extra keys rejected). This prevents
 * a handler from accidentally returning `{ok:true, data:..., error:...}`
 * (a contract violation), and prevents an inner error object from
 * carrying extra fields like `stack` that would leak diagnostic
 * context out to MCP clients.
 *
 * Per-tool tests use this to validate the handler's return value
 * against the tool's documented data shape.
 *
 * Example:
 *   const startSessionEnvelope = toolEnvelopeSchemaOf(
 *     z.object({ session_id: z.string(), checkpoint_id: z.string() })
 *   );
 *   startSessionEnvelope.parse(handlerResult);
 */
export function toolEnvelopeSchemaOf<TData extends z.ZodTypeAny>(dataSchema: TData) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z
      .object({
        ok: z.literal(false),
        error: z
          .object({
            code: z.string(),
            message: z.string(),
            details: z.unknown().optional(),
          })
          .strict(),
      })
      .strict(),
  ]);
}

/**
 * Loose ToolEnvelope schema that accepts any structure for data.
 *
 * Used by the Step 4 dispatcher post-handler to assert structural
 * correctness of the envelope itself when the handler's data shape
 * is not statically known at the dispatcher layer (e.g., generic
 * envelope-shape integrity tests).
 *
 * The data field accepts z.unknown() but the WRAPPER shape is still
 * strict (no extra top-level keys, no extra error-object keys) --
 * the strict() locks come from toolEnvelopeSchemaOf above.
 */
export const toolEnvelopeSchema = toolEnvelopeSchemaOf(z.unknown());

// ============================================================================
// Domain error -> code map (Tier 2 of toErrorEnvelope)
// ============================================================================

/**
 * Identity-only handle for an Error constructor used as a Map key.
 *
 * This map NEVER instantiates the constructor -- it only looks up
 * `err.constructor` as a `Map` key. Modeling the shape as
 * "constructor object whose prototype is Error" captures the actual
 * runtime contract directly, without inviting TypeScript constructor-
 * variance edge cases (a `new (...args: never[]) => Error` form would
 * be clever but brittle if TS tightens variance rules later, and is
 * also misleading: we have no business "constructing" anything here).
 */
type ErrorCtor = {
  readonly prototype: Error;
};

/**
 * Entries for the constructor-keyed domain-error registry.
 *
 * Two groups (D99.E locked):
 *
 *   1. cli-commands (14) -- operation-public + passthrough errors
 *      exported from the @viberevert/cli-commands barrel. Each can
 *      surface from a typed-operation backend (start_session,
 *      create_checkpoint, generate_fix_prompt) or from the
 *      command-harness backend (check_repo, etc.) when a wrapped
 *      Command throws.
 *
 *   2. core (5) -- error classes that bubble through operations from
 *      @viberevert/core. The boot path also surfaces RepoRootNotFound;
 *      get_policy surfaces the 3 config errors directly via D99.M.6's
 *      narrow carve-out.
 *
 * Each code string is UPPER_SNAKE_CASE derived from the class name
 * minus the "Error" suffix. Entries are alphabetized within each
 * group for findability.
 */
export const MCP_ERROR_CODE_ENTRIES = [
  // cli-commands (14, alphabetical)
  [AmbiguousReportSelectionError, "AMBIGUOUS_REPORT_SELECTION"],
  [CheckpointNameCollisionError, "CHECKPOINT_NAME_COLLISION"],
  [ConcurrentOperationError, "CONCURRENT_OPERATION"],
  [CreateCheckpointListLoadError, "CHECKPOINT_LIST_LOAD_FAILED"],
  [InvalidReportSelectionError, "INVALID_REPORT_SELECTION"],
  [PromptFixDriftDetectedError, "PROMPT_FIX_DRIFT_DETECTED"],
  [PromptFixEmptyFindingsError, "PROMPT_FIX_EMPTY_FINDINGS"],
  [PromptFixIoFailureError, "PROMPT_FIX_IO_FAILED"],
  [PromptFixReadFailureError, "PROMPT_FIX_READ_FAILED"],
  [PromptFixReportParseError, "PROMPT_FIX_REPORT_PARSE_FAILED"],
  [PromptFixStaleRemovalFailureError, "PROMPT_FIX_STALE_REMOVAL_FAILED"],
  [PromptFixTargetResolutionError, "PROMPT_FIX_TARGET_RESOLUTION_FAILED"],
  [ReportNotFoundError, "REPORT_NOT_FOUND"],
  [RuntimeEnvInvalidError, "RUNTIME_ENV_INVALID"],
  // core (5, alphabetical)
  [ConfigNotFoundError, "CONFIG_NOT_FOUND"],
  [ConfigParseError, "CONFIG_PARSE_FAILED"],
  [ConfigValidationError, "CONFIG_VALIDATION_FAILED"],
  [RepoRootNotFoundError, "REPO_ROOT_NOT_FOUND"],
  [SessionAlreadyActiveError, "SESSION_ALREADY_ACTIVE"],
] as const satisfies ReadonlyArray<readonly [ErrorCtor, string]>;

/**
 * Constructor-keyed registry derived from MCP_ERROR_CODE_ENTRIES.
 *
 * Exposed as ReadonlyMap so callers cannot mutate. Per the D99.I
 * locked contract, lookup is by EXACT constructor identity --
 * subclasses of mapped classes WITHOUT their own explicit entry
 * fall through to INTERNAL_ERROR. Adding a new mapped class
 * requires an entry above.
 */
export const MCP_ERROR_CODE_MAP: ReadonlyMap<ErrorCtor, string> = new Map<ErrorCtor, string>(
  MCP_ERROR_CODE_ENTRIES,
);

// ============================================================================
// Message sanitization
// ============================================================================

/**
 * Sanitize a free-form message string for safe inclusion in a
 * ToolEnvelope error.message field.
 *
 * Steps:
 *   1. Strip ASCII control chars (0x00-0x1F and 0x7F) -> space.
 *      Includes tab/CR/LF -- the message stays single-line so it
 *      embeds cleanly into NDJSON-adjacent contexts (audit log
 *      etc.).
 *   2. Collapse whitespace runs -> single space. Trim.
 *   3. Cap at maxLen with a "... (truncated)" suffix if cut.
 *
 * Never reads err.stack -- workspace file paths and line numbers
 * are diagnostic context that should not leak through the envelope
 * to MCP clients.
 */
function sanitizeMessage(input: string, maxLen = 512): string {
  let s = String(input);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional D99.I R31 sanitization -- strip ASCII control bytes from caller-supplied envelope error messages before protocol output.
  s = s.replace(/[\x00-\x1F\x7F]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) {
    const suffix = "... (truncated)";
    s = s.slice(0, maxLen - suffix.length) + suffix;
  }
  return s;
}

// ============================================================================
// toErrorEnvelope: 3-tier err -> envelope shape
// ============================================================================

/**
 * Convert any thrown value into a ToolEnvelope failure shape.
 *
 * Lookup precedence (locked per D99.I):
 *
 *   Tier 1: err instanceof McpDirectError (brand check) -> use err.mcpCode
 *   Tier 2: MCP_ERROR_CODE_MAP.get(err.constructor) (exact identity) -> mapped code
 *   Tier 3: fallback -> INTERNAL_ERROR
 *
 * The brand-check (Tier 1) precedes the map lookup (Tier 2) as a
 * defensive ordering. Map lookup uses err.constructor for exact
 * identity -- NO prototype-chain walking, NO instanceof loops.
 *
 * err.stack is NEVER included in the envelope output.
 */
export function toErrorEnvelope(err: unknown): ToolEnvelope<never> {
  // Tier 1: branded MCP-layer error.
  if (err instanceof McpDirectError) {
    return {
      ok: false,
      error: { code: err.mcpCode, message: sanitizeMessage(err.message) },
    };
  }
  // Tier 2: VibeRevert domain error with exact constructor identity.
  if (err instanceof Error) {
    const mapped = MCP_ERROR_CODE_MAP.get(err.constructor as ErrorCtor);
    if (mapped !== undefined) {
      return {
        ok: false,
        error: { code: mapped, message: sanitizeMessage(err.message) },
      };
    }
  }
  // Tier 3: fallback.
  const fallbackMessage = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: sanitizeMessage(fallbackMessage) },
  };
}

// ============================================================================
// formatZodErrorSummary: ZodError -> compact summary for Cat 3 response
// ============================================================================

/**
 * Scrub potentially-sensitive value mentions from a Zod issue
 * message, and normalize control chars / whitespace so the result
 * stays single-line.
 *
 * Three scrub patterns handle Zod's `received <value>` shapes:
 *   - `received "..."` (double-quoted, e.g. for string values)
 *   - `received '...'` (single-quoted)
 *   - `received <token>` (unquoted, for numbers/booleans/identifiers)
 *
 * The unquoted regex uses `[^\s;,)]+` to stop at whitespace,
 * semicolon, comma, or closing paren -- typical sentence boundaries
 * in Zod messages. Order matters: quoted patterns run FIRST so
 * `received "foo bar"` (spaces inside quotes) is replaced as a
 * unit before the unquoted regex would otherwise stop mid-value.
 *
 * Control-char strip runs BEFORE the scrub patterns so a multi-line
 * custom Zod message cannot bypass the scrubber by splitting
 * `received` from its value via newlines.
 */
function scrubZodIssueMessage(message: string): string {
  return (
    String(message)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional D99.I R31 sanitization -- strip ASCII control bytes from custom Zod issue messages before invalid-input response text.
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\breceived\s+"[^"]*"/gi, "received <value>")
      .replace(/\breceived\s+'[^']*'/gi, "received <value>")
      .replace(/\breceived\s+[^\s;,)]+/gi, "received <value>")
  );
}

/**
 * Flatten a ZodError into a compact single-line summary suitable for
 * the Step 4 dispatcher's Cat 3 invalid-input response text.
 *
 * Output shape:
 *   "<path1>: <reason1>; <path2>: <reason2>; ..."
 * with <path> being issue.path joined by "." (numeric segments
 * stringified via String()), or "<root>" for empty, joined by "; ",
 * truncated at 256 chars with "... (truncated)" suffix if cut.
 *
 * Empty-issues fallback: a ZodError with no issues (synthetic or
 * future Zod behavior) returns "<root>: Invalid input" rather than
 * an empty string -- the dispatcher's Cat 3 wire shape needs a
 * non-empty body.
 *
 * Critical R31 mitigation: scrubZodIssueMessage removes raw input
 * values from issue.message before joining. Zod's default `received`
 * templates insert the actual rejected value into the message -- if
 * that value happens to be a secret token (or merely large), the
 * envelope would leak it. The scrub regex catches double-quoted,
 * single-quoted, AND unquoted received-value shapes. Control chars
 * are normalized to single spaces so a custom Zod message can't
 * inject newlines into the envelope.
 *
 * The toolName prefix is NOT applied here -- the Step 4 dispatcher
 * composes the final wire shape "Invalid arguments for tool <name>:
 * <summary>". Keeping this formatter tool-agnostic preserves the
 * clean separation between validation reporting and the wire
 * response.
 */
export function formatZodErrorSummary(error: z.ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".");
    const scrubbedReason = scrubZodIssueMessage(issue.message);
    return `${path}: ${scrubbedReason}`;
  });
  if (parts.length === 0) {
    return "<root>: Invalid input";
  }
  let summary = parts.join("; ");
  const maxLen = 256;
  if (summary.length > maxLen) {
    const suffix = "... (truncated)";
    summary = summary.slice(0, maxLen - suffix.length) + suffix;
  }
  return summary;
}
