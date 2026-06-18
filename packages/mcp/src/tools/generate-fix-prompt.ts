// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// generate_fix_prompt MCP tool: typed-operation backend.
//
// Per D99.E + D99.Q row 8 + D99.V + D99.U:
//
//   - Backend: typed-operation. Calls
//     @viberevert/cli-commands's generateFixPromptOperation
//     (extracted in M G1a Step 1) which owns all prompt-generation
//     domain logic: repo-root resolution, target resolution
//     (delegated to resolvePromptFixReportTarget), source-report
//     read+parse, D86 drift-guarded empty-findings cleanup, D90.7
//     single renderer call, D88 success-path drift guard, D81 file-
//     before-return-value write order.
//
//   - Returns the full rendered fix-prompt text (or a truncated
//     view per D99.U; see below), the absolute path to the
//     persisted sibling `fix-prompt.txt`, and the source report id.
//
//   - Side-effect class: B (writes the sibling `fix-prompt.txt` via
//     atomic temp+rename; under empty-findings refusal, removes
//     any stale sibling). NOT wrapped in withTimeout per D99.V --
//     racing a side-effecting tool without cancellation tokens
//     would destroy audit truth.
//
//   - Input fields: { session?, report? }. Mutually exclusive --
//     supplying both fires AmbiguousReportSelectionError at the
//     operation layer (NOT at the MCP layer; the resolver is the
//     single source of truth for this rule). Each id field is
//     bounded at MAX_REPORT_TARGET_ID_LEN characters as defense in
//     depth against megabyte-scale DoS before the resolver gets a
//     chance to reject; control characters are rejected at the MCP
//     boundary so resolved filesystem paths cannot carry escape
//     sequences or NUL bytes. Shape validation (must be
//     sess_<ULID> or rpt_<ULID>) is left to the resolver, which
//     emits the more informative InvalidReportSelectionError --
//     duplicating that check here would shadow the typed error
//     with a generic Zod regex failure.
//
//   - D99.U output cap (CRITICAL -- cap-applies-only-to-MCP-response):
//     `prompt_text` is capped at MAX_GENERATE_FIX_PROMPT_TEXT_BYTES
//     bytes in the MCP wire shape. The cap is BYTE-MEASURED on the
//     UTF-8 encoding (NOT JS string-length-measured) so the cap
//     aligns with the actual wire-payload size, AND truncation
//     happens at a UTF-8 codepoint boundary so the returned string
//     is always valid UTF-8 (never sliced mid-codepoint).
//
//     CRITICAL D81 byte-identity preservation: the sibling
//     `fix-prompt.txt` on disk is ALWAYS the FULL untruncated text.
//     The operation persists the file BEFORE returning (D81 file-
//     before-return-value write order), so this handler caps the
//     wire shape's prompt_text view AFTER persistence. Truncation
//     here NEVER touches the on-disk artifact. Tests assert the
//     file's bytes are byte-identical to the full template render
//     even when the wire shape is truncated.
//
//     Truncation discriminator: when the cap fires, the data shape
//     gains two fields: `truncated: true` and `bytes_omitted: N`.
//     When the cap does NOT fire, both fields are ABSENT (NOT
//     `truncated: false`). Consumers branch on key presence per
//     the D99.U locked wire shape. The TypeScript encoding is a
//     real discriminated union (NotTruncated has `truncated?: never`
//     and `bytes_omitted?: never`; Truncated requires both keys
//     with their narrow types) so impossible states are unreachable
//     at the type level, not only forbidden by comment.
//
//   - Error mapping (all 12 relevant typed errors already in
//     MCP_ERROR_CODE_MAP via the slice 3.2 contract layer; no
//     envelope.ts changes needed for slice 3.7):
//       RepoRootNotFoundError             -> REPO_ROOT_NOT_FOUND
//       AmbiguousReportSelectionError     -> AMBIGUOUS_REPORT_SELECTION
//                                            (R31-special-cased:
//                                              generic message + NO
//                                              details. Upstream
//                                              template embeds the
//                                              raw session AND report
//                                              user-supplied ids.)
//       InvalidReportSelectionError       -> INVALID_REPORT_SELECTION
//                                            (R31-special-cased:
//                                              generic message + NO
//                                              details. Upstream
//                                              template embeds the
//                                              rejected raw value.)
//       ReportNotFoundError               -> REPORT_NOT_FOUND
//                                            (R31-special-cased:
//                                              generic message + NO
//                                              details. Upstream
//                                              template embeds the
//                                              rejected raw id.)
//       RuntimeEnvInvalidError            -> RUNTIME_ENV_INVALID
//       PromptFixTargetResolutionError    -> PROMPT_FIX_TARGET_RESOLUTION_FAILED
//                                            (R31-special-cased:
//                                              generic message + NO
//                                              details. Upstream
//                                              template is
//                                              formatCause(cause)
//                                              where cause is from
//                                              UNKNOWN resolver throws
//                                              and may carry
//                                              arbitrary bytes.)
//       PromptFixReadFailureError         -> PROMPT_FIX_READ_FAILED
//                                            + details.path
//                                            + details.phase
//                                              ("initial_read" |
//                                               "drift_guard_read")
//       PromptFixReportParseError         -> PROMPT_FIX_REPORT_PARSE_FAILED
//                                            + details.path
//       PromptFixDriftDetectedError       -> PROMPT_FIX_DRIFT_DETECTED
//                                            (no details -- binary
//                                              refusal, locked D93
//                                              message is fixed)
//       PromptFixStaleRemovalFailureError -> PROMPT_FIX_STALE_REMOVAL_FAILED
//                                            + details.path
//       PromptFixIoFailureError           -> PROMPT_FIX_IO_FAILED
//                                            + details.path
//                                            + details.phase
//                                              ("persist_fix_prompt")
//       PromptFixEmptyFindingsError       -> PROMPT_FIX_EMPTY_FINDINGS
//                                            + details.report_id
//                                              (semantic id from the
//                                                parsed ReportFile per
//                                                D86 -- NOT raw user
//                                                input)
//     Unknown errors fall through to toErrorEnvelope Tier 3 ->
//     INTERNAL_ERROR.
//
//     R31 special-casing pattern (4 errors above): the upstream
//     Error.message templates embed raw user-supplied bytes
//     (session/report ids) or arbitrary resolver-cause text. Passing
//     them through toErrorEnvelope/sanitizeMessage would leak those
//     bytes via error.message -- sanitizeMessage only strips control
//     chars + caps length, it does NOT redact arbitrary embedded
//     substrings. The handler bypasses toErrorEnvelope for these 4
//     classes and emits generic information-equivalent messages:
//     stable codes carry the semantics, generic messages avoid the
//     leak. Same pattern as create-checkpoint.ts's
//     CheckpointNameCollisionError handling. The 4 codes are
//     constrained at the type level via GenericPromptFixErrorCode
//     so a typo in this special-case path is a compile error.
//
//     The operation is D19 config-blind -- it does not call
//     loadConfig and its passthrough set does not include
//     ConfigValidationError. This handler does NOT pre-support
//     config errors; a future expansion of the operation's
//     passthrough set would be a D19 contract change requiring its
//     own slice.
//
//     Surfaced `path` / `phase` / `report_id` on the 5 PromptFix*
//     errors that DO carry details are operation-internal-derived
//     values, NOT raw user input echoes. The client supplied
//     session/report ids; the resolved filesystem paths and the
//     report's own self-id are computed by the operation. Re-
//     surfacing them is contract-safe and useful for diagnosis
//     without re-parsing the error.message text.
//
// Details serializers are EXPLICIT WHITELISTS (not blind spread).
// A future field added to any PromptFix*Error class will NOT
// silently leak into the MCP wire surface -- adding it requires
// updating the corresponding branch below.
//
// SDK-free: no @modelcontextprotocol/sdk import. D99.G locked:
// only `definition` and `handler` are exported. Module-private
// constants stay private; tests reference the same numbers via
// test-local literals + comments pointing back to the D99.U lock.

import { Buffer } from "node:buffer";

import {
  AmbiguousReportSelectionError,
  generateFixPromptOperation,
  InvalidReportSelectionError,
  PromptFixEmptyFindingsError,
  PromptFixIoFailureError,
  PromptFixReadFailureError,
  PromptFixReportParseError,
  PromptFixStaleRemovalFailureError,
  PromptFixTargetResolutionError,
  ReportNotFoundError,
} from "@viberevert/cli-commands";
import { z } from "zod";

import { type ToolEnvelope, toErrorEnvelope, toInvalidToolInputEnvelope } from "../envelope.js";
import type { JsonSchemaObject, ToolDefinition, ToolHandler } from "../tools.js";

// ============================================================================
// Bounds
// ============================================================================

/**
 * Hard cap on the length of each report-target id field
 * (`session`, `report`). The operation's resolver validates the
 * full sess_<ULID> / rpt_<ULID> shape (31 chars each) and emits
 * InvalidReportSelectionError on mismatch; this cap is defense in
 * depth, ensuring the resolver doesn't have to scan a megabyte
 * before rejecting. 64 characters is 2x the valid id length --
 * generous headroom for future id-shape evolution while preventing
 * pathological inputs. String-length cap, not byte-length.
 */
const MAX_REPORT_TARGET_ID_LEN = 64;

/**
 * D99.U-locked cap on `prompt_text` in the MCP wire shape. Cap is
 * BYTE-MEASURED on the UTF-8 encoding (NOT JS string-length); the
 * helper `truncateUtf8ByByteCap` ensures the slice stops at a
 * codepoint boundary so the returned string is always valid UTF-8.
 *
 * Module-private per D99.G (exactly `definition` + `handler`
 * exported). Tests reference the value via a test-local literal
 * with a comment pointing back to this D99.U lock.
 *
 * D99.U cap-applies-only-to-MCP-response: this cap NEVER affects
 * the sibling `fix-prompt.txt` on disk -- the operation persists
 * the full text first (D81 file-before-return-value), and this
 * handler caps the wire view afterward.
 */
const MAX_GENERATE_FIX_PROMPT_TEXT_BYTES = 256 * 1024;

// ============================================================================
// Input schema (strict; both id fields bounded + control-char-clean)
// ============================================================================

const generateFixPromptInputSchema = z
  .object({
    session: z
      .string()
      .max(MAX_REPORT_TARGET_ID_LEN, {
        message: `session must be at most ${MAX_REPORT_TARGET_ID_LEN} characters`,
      })
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional R31 / path-injection defense -- reject ASCII control bytes (0x00-0x1F + 0x7F) in resolved-id fields so the path fragments the operation passes to the resolver cannot carry NUL, escape sequences, or framing chars. ULID-shape validation is left to the resolver's typed InvalidReportSelectionError.
      .regex(/^[^\x00-\x1F\x7F]*$/, {
        message: "session must not contain control characters",
      })
      .optional(),
    report: z
      .string()
      .max(MAX_REPORT_TARGET_ID_LEN, {
        message: `report must be at most ${MAX_REPORT_TARGET_ID_LEN} characters`,
      })
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional R31 / path-injection defense -- same rationale as the session field above.
      .regex(/^[^\x00-\x1F\x7F]*$/, {
        message: "report must not contain control characters",
      })
      .optional(),
  })
  .strict();

// ============================================================================
// Output data shape (D99.Q row 8 + D99.U truncation discriminator)
// ============================================================================

type GenerateFixPromptResult = Awaited<ReturnType<typeof generateFixPromptOperation>>;

/**
 * Base shape shared by both arms of the truncation union.
 * Promotes the three always-present fields so the discriminated
 * arms only differ in their truncation discriminator.
 */
type GenerateFixPromptBaseData = {
  readonly fix_prompt_path: GenerateFixPromptResult["fixPromptPath"];
  readonly prompt_text: GenerateFixPromptResult["promptText"];
  readonly source_report_id: GenerateFixPromptResult["sourceReportId"];
};

/**
 * Non-truncated arm. `truncated` and `bytes_omitted` MUST be
 * absent (TypeScript `?: never` lock). Consumers narrowing via
 * `if (!('truncated' in data))` get the base shape without
 * `bytes_omitted` polluting the type.
 */
type GenerateFixPromptNotTruncatedData = GenerateFixPromptBaseData & {
  readonly truncated?: never;
  readonly bytes_omitted?: never;
};

/**
 * Truncated arm. `truncated: true` is the discriminator; consumers
 * narrowing via `if (data.truncated === true)` get `bytes_omitted`
 * as a non-optional `number`. Locks the D99.U paired-fields
 * contract at the type level so impossible states (truncated:true
 * without bytes_omitted, or bytes_omitted without the truncation
 * marker) are unreachable.
 */
type GenerateFixPromptTruncatedData = GenerateFixPromptBaseData & {
  readonly truncated: true;
  readonly bytes_omitted: number;
};

/**
 * MCP wire shape for generate_fix_prompt success responses. Real
 * discriminated union: D99.U is encoded at the TS level, not only
 * in comments.
 */
export type GenerateFixPromptData =
  | GenerateFixPromptNotTruncatedData
  | GenerateFixPromptTruncatedData;

// ============================================================================
// UTF-8 byte-boundary truncation helper (module-private)
// ============================================================================

/**
 * Discriminated union over the truncation outcome. The
 * non-truncated arm pins `bytesOmitted: 0` as a literal type so
 * the consumer's ternary cannot accidentally pass a nonzero
 * `bytesOmitted` through the not-truncated branch.
 */
type Utf8CapResult =
  | { readonly text: string; readonly truncated: false; readonly bytesOmitted: 0 }
  | { readonly text: string; readonly truncated: true; readonly bytesOmitted: number };

/**
 * Truncate `text` so its UTF-8 encoding is at most `maxBytes`
 * bytes, slicing at a codepoint boundary so the result is always
 * valid UTF-8 (never cut mid-codepoint).
 *
 * Returns the original text + truncated:false when it fits the
 * cap; otherwise returns the truncated text + truncated:true +
 * bytesOmitted (the count of UTF-8 bytes dropped vs the source).
 *
 * Algorithm: encode to UTF-8, then back up from `maxBytes` until
 * the byte at that index is NOT a UTF-8 continuation byte
 * (0x80-0xBF, high bits 10xxxxxx). At that point, bytes 0..n-1
 * form complete codepoints; subarray(0, n).toString("utf8")
 * yields valid UTF-8 ending at the previous codepoint's last
 * byte.
 *
 * The all-ASCII fast path is implicit: every ASCII byte is a
 * start byte, so the loop never decrements n and truncation lands
 * exactly at maxBytes.
 */
function truncateUtf8ByByteCap(text: string, maxBytes: number): Utf8CapResult {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return { text, truncated: false, bytesOmitted: 0 };
  }
  let n = maxBytes;
  while (n > 0) {
    const byte = buf[n];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    n--;
  }
  const truncatedText = buf.subarray(0, n).toString("utf8");
  return { text: truncatedText, truncated: true, bytesOmitted: buf.length - n };
}

// ============================================================================
// Helpers (module-private)
// ============================================================================

/**
 * Safe object-spread base for merging extra details into a
 * toErrorEnvelope-produced envelope. Treats arrays as non-objects
 * to avoid spreading an array's numeric keys into the object
 * envelope. Mirrors the pattern locked in slice 3.5/3.6/3.7's
 * get-policy + start-session + create-checkpoint handlers.
 */
function objectDetails(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

/**
 * Augment a toErrorEnvelope-produced envelope with extra details
 * fields while preserving any base-shape details a future
 * toErrorEnvelope revision might set. Defensive object-spread via
 * objectDetails() prevents an array `details` from spreading
 * numeric keys.
 */
function augmentEnvelope(err: Error, extra: Record<string, unknown>): ToolEnvelope<never> {
  const base = toErrorEnvelope(err);
  if (base.ok === false) {
    return {
      ok: false,
      error: {
        ...base.error,
        details: { ...objectDetails(base.error.details), ...extra },
      },
    };
  }
  // toErrorEnvelope returns ToolEnvelope<never>, so the ok:true
  // branch is unreachable; the return below satisfies TS narrowing.
  return base;
}

/**
 * Codes valid for the R31-special-case generic-envelope path.
 * Restricting genericErrorEnvelope's `code` parameter to this
 * literal union means a typo in any of the four R31-special-case
 * branches is a compile error, and it prevents the helper from
 * being repurposed for code paths where toErrorEnvelope's full
 * machinery (Tier 1 brand check + Tier 2 constructor-keyed map +
 * sanitizeMessage) is the correct choice.
 */
type GenericPromptFixErrorCode =
  | "AMBIGUOUS_REPORT_SELECTION"
  | "INVALID_REPORT_SELECTION"
  | "REPORT_NOT_FOUND"
  | "PROMPT_FIX_TARGET_RESOLUTION_FAILED";

/**
 * Construct a minimal envelope with a stable code and a generic
 * message, bypassing toErrorEnvelope entirely. Used for the 4
 * R31-special-cased error classes whose upstream message templates
 * embed raw user-supplied bytes (session/report ids) or arbitrary
 * resolver-cause text. sanitizeMessage strips control chars + caps
 * length only; it does NOT redact arbitrary embedded substrings,
 * so the upstream message would leak those bytes through
 * envelope.error.message. The stable code carries the semantic
 * refusal; this helper guarantees the message contains nothing the
 * client supplied. The `code` parameter is typed as
 * GenericPromptFixErrorCode (the 4 valid R31-special-case codes)
 * so typos and accidental reuse are compile errors.
 */
function genericErrorEnvelope(
  code: GenericPromptFixErrorCode,
  message: string,
): ToolEnvelope<never> {
  return { ok: false, error: { code, message } };
}

// ============================================================================
// Public surface (D99.G: exactly `definition` + `handler`)
// ============================================================================

export const definition: ToolDefinition<"generate_fix_prompt"> = {
  name: "generate_fix_prompt",
  description:
    "Render a fix-prompt from a VibeRevert check report. Returns the rendered prompt " +
    "text, the absolute path to the persisted sibling fix-prompt.txt, and the source " +
    "report id. Side-effecting (class B per D99.V); writes the sibling fix-prompt.txt " +
    "via atomic temp+rename. The on-disk sibling is always the full untruncated text " +
    "(D81); the MCP wire response's prompt_text is capped at " +
    `${MAX_GENERATE_FIX_PROMPT_TEXT_BYTES} bytes (D99.U) -- when truncated, the ` +
    "response carries truncated:true + bytes_omitted.",
  inputSchema: z.toJSONSchema(generateFixPromptInputSchema, {
    target: "draft-7",
  }) as JsonSchemaObject,
};

export const handler: ToolHandler<GenerateFixPromptData> = async (
  input,
  context,
): Promise<ToolEnvelope<GenerateFixPromptData>> => {
  const parsed = generateFixPromptInputSchema.safeParse(input);
  if (!parsed.success) {
    return toInvalidToolInputEnvelope("generate_fix_prompt", parsed.error);
  }

  try {
    // Build operation opts. Omit each key entirely when absent so
    // the field is undefined on the resulting object (cleaner TS
    // than passing `session: undefined`). Mutual exclusion (if
    // both supplied) fires AmbiguousReportSelectionError inside
    // the operation -- the MCP layer does NOT pre-empt that check.
    const result = await generateFixPromptOperation({
      cwd: context.repoRoot,
      ...(parsed.data.session !== undefined ? { session: parsed.data.session } : {}),
      ...(parsed.data.report !== undefined ? { report: parsed.data.report } : {}),
    });

    // D99.U cap-applies-only-to-MCP-response: the sibling
    // fix-prompt.txt on disk is ALREADY FULL bytes (the operation
    // persisted it before returning per D81 file-before-return-
    // value). Cap ONLY the wire shape's prompt_text view here.
    const capped = truncateUtf8ByByteCap(result.promptText, MAX_GENERATE_FIX_PROMPT_TEXT_BYTES);

    const data: GenerateFixPromptData = capped.truncated
      ? {
          fix_prompt_path: result.fixPromptPath,
          prompt_text: capped.text,
          source_report_id: result.sourceReportId,
          truncated: true,
          bytes_omitted: capped.bytesOmitted,
        }
      : {
          fix_prompt_path: result.fixPromptPath,
          prompt_text: capped.text,
          source_report_id: result.sourceReportId,
        };

    return { ok: true, data };
  } catch (err) {
    // R31 special-cases (4 classes): the upstream Error.message
    // templates embed raw user-supplied bytes (session/report ids)
    // or arbitrary resolver-cause text. Bypass toErrorEnvelope so
    // sanitizeMessage cannot leak those bytes via error.message.
    // Stable codes carry the semantics; generic messages avoid
    // user-byte echo. Same pattern as create-checkpoint.ts's
    // CheckpointNameCollisionError handling. The 4 codes are
    // type-locked via GenericPromptFixErrorCode.
    if (err instanceof AmbiguousReportSelectionError) {
      return genericErrorEnvelope(
        "AMBIGUOUS_REPORT_SELECTION",
        "session and report are mutually exclusive",
      );
    }
    if (err instanceof InvalidReportSelectionError) {
      return genericErrorEnvelope("INVALID_REPORT_SELECTION", "invalid report selection");
    }
    if (err instanceof ReportNotFoundError) {
      return genericErrorEnvelope("REPORT_NOT_FOUND", "report not found");
    }
    if (err instanceof PromptFixTargetResolutionError) {
      return genericErrorEnvelope(
        "PROMPT_FIX_TARGET_RESOLUTION_FAILED",
        "failed to resolve prompt-fix target",
      );
    }

    // Per-error WHITELIST details serializers. Each branch surfaces
    // operation-internal-derived fields only (path / phase /
    // report_id) -- never raw user input. The upstream message
    // templates here embed paths computed by the resolver, semantic
    // ids from the parsed ReportFile, and fs/JSON cause text --
    // none of which are direct user input -- so passing them
    // through toErrorEnvelope/sanitizeMessage is safe.
    if (err instanceof PromptFixReadFailureError) {
      return augmentEnvelope(err, { path: err.path, phase: err.phase });
    }
    if (err instanceof PromptFixReportParseError) {
      return augmentEnvelope(err, { path: err.path });
    }
    if (err instanceof PromptFixStaleRemovalFailureError) {
      return augmentEnvelope(err, { path: err.path });
    }
    if (err instanceof PromptFixIoFailureError) {
      return augmentEnvelope(err, { path: err.path, phase: err.phase });
    }
    if (err instanceof PromptFixEmptyFindingsError) {
      return augmentEnvelope(err, { report_id: err.reportId });
    }
    // Everything else -- typed (Repo/RuntimeEnv/DriftDetected) and
    // unknown (Tier 3 INTERNAL_ERROR) -- through toErrorEnvelope
    // unchanged.
    return toErrorEnvelope(err);
  }
};
