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
//     - toInvalidToolInputEnvelope: ZodError -> INVALID_TOOL_INPUT
//       envelope with details.issues as an MCP-owned, sanitized,
//       bounded InvalidToolInputIssue array (M G1a Step 3.6
//       contract normalization across all MCP tools). Raw ZodIssue
//       objects are NEVER exposed -- each issue is whitelisted to
//       {code, path, message} with the message run through
//       scrubZodIssueMessage so R31 protections extend to the
//       details.issues array as well as error.message.
//
//   R31 -- formatZodErrorSummary AND invalidToolInputIssues both
//   scrub raw input values via scrubZodIssueMessage. Scrub patterns
//   cover Zod's `received <value>` AND `Unrecognized keys: "..."`
//   message shapes so credential-shaped key names and value text
//   cannot leak into the envelope's error.message field OR
//   details.issues[].message field.

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
import type { ZodError } from "zod";
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
 * Scrub potentially-sensitive value AND key-name mentions from a
 * Zod issue message, and normalize control chars / whitespace so the
 * result stays single-line.
 *
 * Four scrub patterns handle Zod's input-derived message shapes:
 *   - Unrecognized-key messages -- the input KEY NAMES Zod
 *     surfaces when a strict object rejects extras. An attacker
 *     who slips a credential-shaped key into a request would
 *     otherwise see the key name echoed back through the envelope.
 *     The regex tolerates Zod's known wording variants:
 *       - `Unrecognized key: "x"`  (singular)
 *       - `Unrecognized keys: "x", "y"`  (plural)
 *       - `Unrecognized key(s) in object: 'x'`  (older Zod wording)
 *     and matches both double-quoted and single-quoted key lists.
 *     All variants are replaced with a uniform
 *     `unrecognized key(s): <key>` placeholder. Escaped quote
 *     characters inside quoted key names are treated as part of
 *     the key, not as the end of the match.
 *   - `received "..."` (double-quoted, e.g. for string values)
 *   - `received '...'` (single-quoted)
 *   - `received <token>` (unquoted, for numbers/booleans/identifiers)
 *
 * The unquoted regex uses `[^\s;,)]+` to stop at whitespace,
 * semicolon, comma, or closing paren -- typical sentence boundaries
 * in Zod messages. Order matters: the unrecognized-keys pattern runs
 * FIRST (specific shape -- avoids partial matches inside it);
 * quoted-received patterns run BEFORE the unquoted-received pattern
 * so `received "foo bar"` (spaces inside quotes) is replaced as a
 * unit before the unquoted regex would otherwise stop mid-value.
 *
 * Control-char strip runs BEFORE the scrub patterns so a multi-line
 * custom Zod message cannot bypass the scrubber by splitting
 * `received` (or the unrecognized-key list) from its value via
 * newlines.
 */
function scrubZodIssueMessage(message: string): string {
  return (
    String(message)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional D99.I R31 sanitization -- strip ASCII control bytes from custom Zod issue messages before invalid-input response text.
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(
        /\bunrecognized\s+key(?:s|\(s\))?(?:\s+in\s+object)?\s*:\s*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?:\s*,\s*)?)+/gi,
        "unrecognized key(s): <key>",
      )
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
 * values AND raw key names from issue.message before joining. Zod's
 * default `received` templates insert the actual rejected value
 * into the message, and `unrecognized keys` templates insert the
 * actual key names -- if that text happens to be a credential-
 * shaped token (or merely large), the envelope would leak it. The
 * scrub regex catches double-quoted, single-quoted, AND unquoted
 * received-value shapes plus the unrecognized-keys list shape.
 * Control chars are normalized to single spaces so a custom Zod
 * message can't inject newlines into the envelope.
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

// ============================================================================
// toInvalidToolInputEnvelope: ZodError -> INVALID_TOOL_INPUT envelope
// ============================================================================

/**
 * Hard cap on the number of issue records exposed in
 * `details.issues`. A malformed payload with hundreds of invalid
 * fields would otherwise produce a multi-MB structured response.
 * `details.issue_count` carries the ORIGINAL count so consumers
 * still know the full error scope; `details.truncated` is a stable
 * boolean discriminator.
 */
export const MAX_INVALID_TOOL_INPUT_ISSUES = 25;

/**
 * Hard cap on each individual issue's `message` length (after
 * scrubbing). Prevents a single pathological message from blowing
 * the structured-response bound even when the issue count is small.
 * This is a string-length cap, not a byte-length cap.
 * Truncated text gets a `... (truncated)` suffix.
 */
export const MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN = 256;

/**
 * Hard cap on each individual path segment exposed in
 * `details.issues[].path`. Defense in depth -- current MCP tool
 * schemas use fixed object keys so path segments are bounded by
 * schema authorship, but a future schema with dynamic keys (e.g.,
 * z.record(z.string(), ...)) could let attacker-supplied keys
 * surface as path segments. The cap prevents unbounded structured
 * output from path segments. It bounds path text; it does not
 * attempt semantic credential classification of arbitrary keys.
 * Current MCP schemas avoid dynamic attacker-controlled path keys.
 * This is a string-length cap, not a byte-length cap. Truncated
 * segments get a `... (truncated)` suffix.
 */
export const MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN = 128;

/**
 * Stable MCP-owned shape for individual validation issues exposed
 * via INVALID_TOOL_INPUT envelopes. Whitelisted to three fields:
 *
 *   - code:    Zod's issue.code (small enum string, no user input)
 *   - path:    issue.path stringified to readonly string[] (Zod's
 *              path is (string|number)[]). Each segment is capped
 *              at MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN
 *              characters (defense-in-depth bound on dynamic-key
 *              schemas).
 *   - message: scrubbed via scrubZodIssueMessage (R31 -- removes the
 *              raw `received <value>` text AND `Unrecognized keys:
 *              "..."` key names so user-supplied input text never
 *              leaks into the envelope) and capped at
 *              MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN characters.
 *
 * Raw ZodIssue objects from `zod` are NEVER exposed -- they carry
 * Zod-internal fields that could expand in future versions and
 * leak unexpected data. Adding a new field to this MCP shape is a
 * deliberate contract decision.
 */
export type InvalidToolInputIssue = {
  readonly code: string;
  readonly path: readonly string[];
  readonly message: string;
};

/**
 * Full shape of `error.details` on the INVALID_TOOL_INPUT envelope.
 * Exported so MCP consumers (and tests) have a stable type handle
 * over the canonical shape.
 *
 *   - issue_count: ORIGINAL count of issues in the source ZodError
 *     (NOT capped). Tells consumers the full error scope even when
 *     the issues array is truncated.
 *   - truncated:   true when issue_count > MAX_INVALID_TOOL_INPUT_ISSUES.
 *                  Stable boolean discriminator so consumers do not
 *                  need to compare issue_count to MAX_*.
 *   - issues:      Array of sanitized InvalidToolInputIssue records,
 *                  capped at MAX_INVALID_TOOL_INPUT_ISSUES entries.
 */
export type InvalidToolInputDetails = {
  readonly issue_count: number;
  readonly truncated: boolean;
  readonly issues: readonly InvalidToolInputIssue[];
};

/**
 * Cap a sanitized issue message at the per-issue length bound,
 * adding a `... (truncated)` suffix when cut. Idempotent on
 * already-short strings.
 */
function capInvalidToolInputMessage(s: string): string {
  if (s.length <= MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN) return s;
  const suffix = "... (truncated)";
  return s.slice(0, MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN - suffix.length) + suffix;
}

/**
 * Cap a stringified path segment at the per-segment length bound,
 * adding a `... (truncated)` suffix when cut. Idempotent on
 * already-short segments.
 */
function capInvalidToolInputPathSegment(segment: string): string {
  if (segment.length <= MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN) return segment;
  const suffix = "... (truncated)";
  return segment.slice(0, MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN - suffix.length) + suffix;
}

/**
 * Project a ZodError into an array of MCP-owned, sanitized,
 * bounded InvalidToolInputIssue records. Module-private --
 * consumers reach the projected shape via
 * toInvalidToolInputEnvelope's envelope output.
 *
 * Slice happens BEFORE the map+scrub so we don't waste sanitization
 * work on issues that will be dropped.
 */
function invalidToolInputIssues(zodError: ZodError): InvalidToolInputIssue[] {
  return zodError.issues.slice(0, MAX_INVALID_TOOL_INPUT_ISSUES).map((issue) => ({
    code: issue.code,
    path: issue.path.map((segment) => capInvalidToolInputPathSegment(String(segment))),
    message: capInvalidToolInputMessage(scrubZodIssueMessage(issue.message)),
  }));
}

/**
 * Build the canonical INVALID_TOOL_INPUT envelope for an MCP tool
 * whose input failed Zod safeParse. Per the M G1a Step 3.6 contract
 * normalization, `details` is ALWAYS the InvalidToolInputDetails
 * shape: an MCP-owned whitelist over the raw ZodIssue shape, with
 * messages scrubbed via R31, plus issue_count + truncated metadata
 * so the issues array can be bounded without losing the original
 * error scope.
 *
 * Centralizing the shape keeps the public wire contract uniform:
 * every INVALID_TOOL_INPUT response everywhere in the MCP surface
 * has the same `{issue_count, truncated, issues}` details shape.
 *
 * The projection in invalidToolInputIssues snapshots each issue as
 * a fresh MCP-owned object -- caller-side mutation of the source
 * ZodError or its issues array does not affect the envelope (slice
 * 3.5/3.6 boundary-ownership pattern). Raw ZodIssue references are
 * never escaped.
 *
 * The toolName parameter is interpolated into the envelope's
 * `error.message`. Callers MUST pass their own tool name as a
 * literal so the message is informative without requiring the
 * dispatcher to look up the tool registration. Example:
 *   return toInvalidToolInputEnvelope("start_session", parsed.error);
 */
export function toInvalidToolInputEnvelope(
  toolName: string,
  zodError: ZodError,
): ToolEnvelope<never> {
  const originalCount = zodError.issues.length;
  return {
    ok: false,
    error: {
      code: "INVALID_TOOL_INPUT",
      message: `${toolName} input failed validation`,
      details: {
        issue_count: originalCount,
        truncated: originalCount > MAX_INVALID_TOOL_INPUT_ISSUES,
        issues: invalidToolInputIssues(zodError),
      },
    },
  };
}
