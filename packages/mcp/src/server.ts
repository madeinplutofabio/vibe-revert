// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// MCP server + dispatcher: low-level @modelcontextprotocol/sdk Server,
// stdio transport, own request-handler implementations for
// ListToolsRequestSchema and CallToolRequestSchema.
//
// Architectural locks:
//
//   D99.D -- LOW-LEVEL Server (not high-level McpServer). McpServer's
//   built-in tools/call handler rejects unknown names BEFORE our code
//   runs, which breaks audit-on-denial; we own the dispatcher end-to-
//   end. D99.M.8 grep asserts exactly 1 `new Server(`, exactly 1
//   `new StdioServerTransport(`, 0 `new McpServer(`.
//
//   D99.J/K/L -- single audit FileHandle per server lifetime, opened
//   in startServer (or createServerForTests), closed on graceful OR
//   unhealthy shutdown. Every tools/call dispatch produces exactly
//   one audit record (or one denied record) before the wire response
//   goes out.
//
//   D99.P -- startServer({cwd}) -> Promise<void>. Resolves on
//   graceful shutdown (SIGINT/SIGTERM or transport close). Rejects on
//   boot failure (McpBootError) OR unhealthy shutdown (audit append
//   failure, transport error). Never calls process.exit; never writes
//   to process.stdout/stderr (D99.M.14).
//
//   D99.V -- conditional withTimeout(30_000) wrap based on the
//   registration's sideEffectClass: class A (no-side-effect) is
//   wrapped; class B (side-effecting) runs to completion per R17.
//
//   D99.W -- command-output-too-large policy. The dispatcher
//   normalizes ANY handler envelope that surfaces a data-side
//   `stderr_truncated: true` flag into a uniform
//   `{ok:false, error:{code:"MCP_COMMAND_OUTPUT_TOO_LARGE", ...}}`
//   wire response. The raw (pre-normalization) envelope is used for
//   audit-field detection (so the audit record carries both
//   `stderr_truncated:true` AND the canonical error_code).
//
//   D99.Y -- protocolVersion behavior is owned by the pinned SDK
//   version. stdio-server.test.ts snapshots initialize negotiation
//   against SDK 1.29.0 so protocol drift is caught deliberately.
//
//   D99.Z divergence note: the plan envisaged dispatcher-side
//   safeParse before handler invocation, returning a Cat-3 text-only
//   wire shape for invalid input. Slice 3.6 moved input validation
//   into every handler (centralized via toInvalidToolInputEnvelope)
//   and normalized the wire shape to a structured Cat-1 ok:false
//   envelope with details.{issue_count, truncated, issues}. This file
//   honors that decision -- known-tool dispatches always invoke the
//   handler; INVALID_TOOL_INPUT envelopes flow through the same
//   Cat-1 wire path as any other handler ok:false response. The
//   text-only manual error path remains only for unknown / reserved
//   tool names (Cat 2). See dispatchToolsCall comments for details.
//
// P11 response-category matrix as implemented:
//
//   Cat 1 (known tool, handler invoked): wire shape
//     { result: { content: [{type:"text", text: JSON.stringify(env)}],
//                 structuredContent: env,
//                 isError: <true if env.ok===false else omit> } }
//     Includes INVALID_TOOL_INPUT envelopes (slice 3.6 contract).
//     Includes MCP_COMMAND_OUTPUT_TOO_LARGE normalization (D99.W).
//
//   Cat 2 (unknown name, incl. RESERVED): wire shape
//     { result: { content: [{type:"text",
//                 text: "MCP error -32602: Tool not found"}],
//                 isError: true } }
//     NO structuredContent. R31: text is GENERIC -- never echoes the
//     client-supplied name. Audit's tool_name uses the literal
//     reserved name for the two locked reserved entries, OR the
//     sentinel "<unknown>" for arbitrary unknowns (R31: no client-
//     supplied bytes in audit logs).
//
//   Cat 3 (text-only invalid input): NOT REACHED -- handlers own
//     invalid-input rejection per the slice 3.6 contract above.
//
//   Cat 4 (server-integrity throw): when audit append fails on a
//     Cat 2 (denied-tool-name) path, we throw
//     McpError(InternalError, "audit append failed during denied-
//     tool-name probe"). SDK serializes to JSON-RPC error -32603 with
//     auto-prepended "MCP error -32603: " in the message field (R30).
//     We pass JUST the raw reason here.
//
//     For Cat 1 audit failures (handler invoked, then audit fails),
//     the response is Cat 1 with envelope
//     {ok:false, error:{code:"MCP_AUDIT_WRITE_FAILED", ...}} so the
//     client still sees a structured tool result, AND we signal
//     unhealthy shutdown so startServer rejects after the current
//     response has been handed back to the SDK.
//
// Boot binding: one server = one repo = one audit log. resolveRepoRoot
// is the single source of cwd-to-repo binding; D99.M.17 forbids any
// per-call cwd parameter on tool input schemas.
//
// Public surface (D99.M.16 / package barrel):
//   - startServer({cwd}): the production entry. CLI's MCPCommand
//     (Step 5) calls this in `viberevert mcp serve`. Returns a Promise
//     that resolves on graceful shutdown and rejects on boot or
//     unhealthy shutdown.
//   - createServerForTests({cwd}): returns {dispatch, shutdown,
//     closed}. NO Server or Transport instances are constructed -- the
//     test helper exposes the SAME dispatchToolsCall function used by
//     the SDK request handler (Option X per slice 4 lock). Keeps
//     D99.M.8 at exactly 1 of each constructor.
//
// SDK constructor call sites (D99.M.8):
//   - `new Server(...)` lives ONLY inside startServer. createServerFor-
//     Tests never constructs one.
//   - `new StdioServerTransport()` lives ONLY inside startServer.
//   - `new McpServer(...)` MUST NOT appear anywhere (high-level class
//     explicitly rejected per D99.D).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveRepoRoot } from "@viberevert/core";

import { type AuditRecordInput, type AuditWriter, openAuditLog } from "./audit.js";
import { type ToolEnvelope, toErrorEnvelope } from "./envelope.js";
import { McpBootError } from "./errors.js";
import { withTimeout } from "./timeout.js";
import { TOOL_REGISTRATIONS_IN_ORDER } from "./tool-registry.js";
import {
  RESERVED_TOOL_NAMES,
  type ReservedToolName,
  type ToolName,
  type ToolRegistration,
} from "./tools.js";

// ============================================================================
// Dispatcher-internal types
// ============================================================================

/**
 * Input passed to dispatchToolsCall. Mirrors the SDK's
 * CallToolRequest.params shape (name + optional arguments). Typed
 * locally so the dispatcher can be invoked from both the SDK
 * request handler AND createServerForTests without coupling tests
 * to SDK Zod schemas.
 */
type DispatchInput = {
  readonly name: string;
  readonly arguments?: unknown;
};

/**
 * Wire result for a tools/call dispatch. Matches the SDK's
 * CallToolResult shape. structuredContent + isError are optional
 * per the JSON-RPC discriminator semantics.
 */
type DispatchResult = {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: ToolEnvelope<unknown>;
  readonly isError?: true;
};

/**
 * Wire result for a tools/list dispatch. The SDK's ListToolsResult
 * shape: an array of tool descriptors with name, description, and
 * inputSchema (JSON Schema).
 */
type ListResult = {
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: object;
  }>;
};

/**
 * Dispatcher dependencies. Bundled so both the SDK request handler
 * and createServerForTests's exposed dispatch function can pass the
 * same surface to dispatchToolsCall.
 */
type DispatcherDeps = {
  readonly audit: AuditWriter;
  readonly repoRoot: string;
  readonly registrationsByName: ReadonlyMap<ToolName, ToolRegistration>;
  readonly signalUnhealthy: (reason: string, cause: unknown) => void;
};

/**
 * Codes valid for direct-envelope construction in this file. Locks
 * the two codes server.ts emits inline (bypassing toErrorEnvelope)
 * so a typo in either site is a compile error. Same pattern as
 * generate-fix-prompt.ts's GenericPromptFixErrorCode union.
 */
type ServerDirectErrorCode = "MCP_AUDIT_WRITE_FAILED" | "MCP_COMMAND_OUTPUT_TOO_LARGE";

// ============================================================================
// Per-tool side-effect timeout (D99.V)
// ============================================================================

/**
 * Locked 30-second response timeout for class-A (no-side-effect)
 * tools per D99.V. Class-B tools are NEVER wrapped -- abandoning a
 * side-effecting Command mid-run would destroy audit truth (R17).
 *
 * Module-private per D99.G analog: tests reference the value via
 * a test-local literal with a comment pointing back to this lock.
 */
const CLASS_A_TIMEOUT_MS = 30_000;

// ============================================================================
// Tool-name sanitization (mirrors audit.ts sanitizeToolName)
// ============================================================================

/**
 * Sanitize an inbound tool name for use in dispatcher control flow
 * (registration lookup, audit lookups for reserved names). The audit
 * writer already runs the same rule on its tool_name field
 * internally; duplicating the small regex here keeps server.ts
 * independent of audit's private helpers.
 *
 * R31 note: sanitization is NOT redaction. The dispatcher only uses
 * sanitizedName for registration-map lookup and reserved-name
 * detection -- NEVER echoes it back to the client (Cat 2 message is
 * generic). For arbitrary unknown names the audit record uses the
 * "<unknown>" sentinel instead of the sanitized client input.
 *
 * Rule per D99.J: replace any byte outside printable ASCII
 * (0x20-0x7E) with "?"; cap at 64 characters.
 */
function sanitizeToolName(name: unknown): string {
  return String(name)
    .replace(/[^\x20-\x7E]/g, "?")
    .slice(0, 64);
}

/**
 * Type guard for the RESERVED_TOOL_NAMES tuple. Used in Cat 2 audit
 * records to distinguish reserved-but-hidden names (rollback,
 * request_human_approval) from arbitrary unknown names; reserved
 * names get `reason: "reserved_approval_gated_not_exposed"`.
 *
 * Reserved names are FIXED strings (the two literal entries in
 * RESERVED_TOOL_NAMES), so audit can safely log them. Arbitrary
 * unknowns use the "<unknown>" sentinel per R31.
 */
function isReservedName(name: string): name is ReservedToolName {
  return (RESERVED_TOOL_NAMES as readonly string[]).includes(name);
}

// ============================================================================
// Direct-envelope helper (manual construction, bypasses toErrorEnvelope)
// ============================================================================

/**
 * Construct a minimal envelope with a server-direct code and message,
 * bypassing toErrorEnvelope entirely. The `code` parameter is typed
 * as ServerDirectErrorCode (the 2 valid server-side direct codes) so
 * typos and accidental reuse for codes that should flow through the
 * 3-tier toErrorEnvelope lookup are compile errors.
 *
 * Used for:
 *   - MCP_AUDIT_WRITE_FAILED on Cat 1 audit failure (no err class to
 *     throw -- the audit failure is a return-flag signal)
 *   - MCP_COMMAND_OUTPUT_TOO_LARGE on D99.W truncation normalization
 *     (handler returned a success envelope; dispatcher overrides
 *     based on the data-side truncated flag)
 */
function directErrorEnvelope(code: ServerDirectErrorCode, message: string): ToolEnvelope<never> {
  return { ok: false, error: { code, message } };
}

// ============================================================================
// Deferred unhealthy-signal helper
// ============================================================================

/**
 * Defer a signalUnhealthy invocation to the next macrotask so the
 * current request handler can return its result (or have its thrown
 * McpError propagated) to the SDK BEFORE the shutdown controller's
 * awaitShutdown rejects.
 *
 * A synchronous signalUnhealthy would reject awaitShutdown
 * immediately, which causes startServer's `await
 * shutdown.awaitShutdown` to throw and enter its finally block
 * (closing the transport). That race could close the transport
 * before the SDK serializes the current Cat 1 ok:false or Cat 4
 * McpError response.
 *
 * setTimeout(..., 0) lets the JS event loop process the current
 * call stack (handler return / McpError throw) and any
 * microtask-queued SDK serialization steps before the
 * shutdown-signal macrotask fires. The SDK then proceeds with
 * graceful close after the response has been handed back.
 *
 * Note: true transport-level drain (bytes flushed to stdio) is
 * SDK/transport-owned. This helper guarantees only that we don't
 * close synchronously before the handler returns -- which is the
 * load-bearing race here.
 */
function signalUnhealthyAfterResponse(
  signalUnhealthy: (reason: string, cause: unknown) => void,
  reason: string,
  cause: unknown,
): void {
  setTimeout(() => signalUnhealthy(reason, cause), 0);
}

// ============================================================================
// Data-field detection (D99.W + audit blocked/stderr_truncated)
// ============================================================================

/**
 * Type-safe probe for an optional boolean true flag on a success
 * envelope's data object. Returns false for ok:false envelopes,
 * non-object data, array data, or missing/non-true field values.
 *
 * Used for:
 *   - "blocked": check_repo surfaces this in its data per D99.Q.1;
 *     audit records it for the locked
 *     `{event:"tool_call", ok:true, exit_code:0, blocked:true, ...}`
 *     shape.
 *   - "stderr_truncated": handlers MAY surface this when the
 *     underlying Command's stderr cap fired (D99.W diagnostic); the
 *     dispatcher normalizes the wire response AND audits the flag.
 */
function hasBooleanDataField(
  envelope: ToolEnvelope<unknown>,
  field: "blocked" | "stderr_truncated",
): boolean {
  return (
    envelope.ok === true &&
    typeof envelope.data === "object" &&
    envelope.data !== null &&
    !Array.isArray(envelope.data) &&
    (envelope.data as Record<string, unknown>)[field] === true
  );
}

/**
 * D99.W normalization: if a handler returned a success envelope with
 * a data-side `stderr_truncated: true` flag, override the wire
 * response to a MCP_COMMAND_OUTPUT_TOO_LARGE failure envelope.
 *
 * The raw (pre-normalization) envelope is preserved in the caller
 * for audit-field detection -- the audit record still carries
 * `stderr_truncated: true` (diagnostic) AND `blocked: true` (if
 * applicable), even when the wire response is overridden.
 *
 * Pass-through (returns the same reference) when no truncation
 * signal is present; no allocation cost on the hot path.
 */
function normalizeCommandOutputCap(envelope: ToolEnvelope<unknown>): ToolEnvelope<unknown> {
  if (!hasBooleanDataField(envelope, "stderr_truncated")) return envelope;
  return directErrorEnvelope(
    "MCP_COMMAND_OUTPUT_TOO_LARGE",
    "command output exceeded MCP response cap",
  );
}

// ============================================================================
// Dispatcher: tools/list
// ============================================================================

/**
 * Build the tools/list response from the registration table. NOT
 * async because it does no I/O; defined as a regular function for
 * clarity. The SDK request handler wraps it in async because the
 * setRequestHandler API expects a Promise return.
 *
 * The exposed list is exactly TOOL_NAMES_IN_ORDER (the same
 * iteration order as the registration tuple, locked by D99.M.4
 * exhaustive-equality invariant). RESERVED_TOOL_NAMES are NOT
 * included (D99.B + D99.M.3 disjointness invariant).
 */
function dispatchToolsList(deps: DispatcherDeps): ListResult {
  const tools: ListResult["tools"] = Array.from(deps.registrationsByName.values()).map((reg) => ({
    name: reg.definition.name,
    description: reg.definition.description,
    inputSchema: reg.definition.inputSchema,
  }));
  return { tools };
}

// ============================================================================
// Dispatcher: tools/call
// ============================================================================

/**
 * Compute the exit_code field for a tool_call audit record from a
 * handler envelope.
 *
 * Convention (Step 4):
 *   - envelope.ok === true                      -> exit_code: 0
 *   - envelope.error.code === "MCP_TOOL_TIMEOUT" -> exit_code: null
 *     (the underlying work was abandoned mid-run per R17 -- there
 *      is no meaningful exit code to record)
 *   - other envelope.ok === false                -> exit_code: 1
 *
 * For command-harness tools (check_repo, etc.) the underlying
 * Command's true exit code (e.g. exit:2 for check_repo blocked
 * findings) is NOT surfaced through the handler's envelope shape
 * today; the audit gets the binary 0/1 collapse. Surfacing the
 * native exit code through audit would require extending the
 * envelope shape -- out of scope for Step 4.
 */
function exitCodeFromEnvelope(envelope: ToolEnvelope<unknown>): number | null {
  if (envelope.ok === true) return 0;
  if (envelope.error.code === "MCP_TOOL_TIMEOUT") return null;
  return 1;
}

/**
 * Build the Cat 1 wire shape from a handler envelope per D99.O.
 *
 * content[0].text is the JSON.stringify of the envelope (byte-
 * identical to JSON.stringify(structuredContent)) so clients without
 * structured-content support can still parse it. isError is set
 * only when envelope.ok === false; the SDK treats the field as
 * absent-vs-true (no false case in the wire shape).
 */
function envelopeToCat1Result(envelope: ToolEnvelope<unknown>): DispatchResult {
  const text = JSON.stringify(envelope);
  if (envelope.ok === false) {
    return {
      content: [{ type: "text", text }],
      structuredContent: envelope,
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: envelope,
  };
}

/**
 * Construct the Cat 2 (unknown / reserved tool name) wire shape per
 * D99.O. R31-safe: text is GENERIC and does NOT echo the client-
 * supplied name. Identical shape for reserved AND truly-unknown
 * names; the only difference between the two cases is the audit
 * record's `reserved` field + `tool_name` value (literal reserved
 * name vs "<unknown>" sentinel).
 *
 * The "MCP error <code>: " prefix is part of the text because the
 * SDK does NOT auto-prepend to result.content text -- the auto-
 * prepend behavior is specific to thrown McpError messages (R30).
 * Uses ErrorCode.InvalidParams (SDK constant = -32602) rather than
 * a hardcoded number so an SDK enum change would surface here.
 */
function makeCat2Result(): DispatchResult {
  return {
    content: [{ type: "text", text: `MCP error ${ErrorCode.InvalidParams}: Tool not found` }],
    isError: true,
  };
}

/**
 * The core dispatcher. Invoked by the SDK CallToolRequestSchema
 * handler AND by createServerForTests's exposed dispatch function.
 *
 * Slice 3.6 / D99.Z divergence: invalid-input handling lives inside
 * each tool handler (centralized via toInvalidToolInputEnvelope).
 * The dispatcher here never runs safeParse against a tool's Zod
 * schema -- it always invokes the handler with the raw arguments
 * (normalized to {} when undefined per the MCP zero-arg
 * convention), and the handler returns either a success envelope OR
 * an INVALID_TOOL_INPUT envelope with structured details. The wire
 * shape for both is Cat 1; the audit record for invalid-input is a
 * standard tool_call ok:false (not a separate denied-shape).
 *
 * D99.W normalization: the dispatcher checks each success envelope
 * for a data-side `stderr_truncated: true` flag and overrides the
 * wire response to MCP_COMMAND_OUTPUT_TOO_LARGE if present. The raw
 * envelope is preserved for audit-field detection so both wire and
 * audit reflect the truncation event consistently.
 *
 * Audit failure policy (per D99.J), with deferred unhealthy signal
 * via signalUnhealthyAfterResponse so the current response/error
 * has been handed back to the SDK before the transport closes:
 *   - Cat 2 path (unknown / reserved): if audit.record throws,
 *     defer signalUnhealthy AND throw McpError(InternalError) so the
 *     SDK serializes a JSON-RPC error envelope (-32603). The
 *     audit-throw catch site sends JUST the raw reason -- the SDK
 *     auto-prepends "MCP error -32603: " in the wire message (R30).
 *   - Cat 1 path (handler invoked): if audit.record throws, defer
 *     signalUnhealthy AND return Cat 1 with envelope
 *     {ok:false, error:{code:"MCP_AUDIT_WRITE_FAILED", ...}}. The
 *     client still gets a structured tool result, AND startServer
 *     rejects after the current response has been handed back to
 *     the SDK.
 *
 * The conditional withTimeout wrap (D99.V) applies only to
 * sideEffectClass "A". Class "B" runs to completion -- racing a
 * side-effecting Command would orphan its mutations after the MCP
 * envelope already reported MCP_TOOL_TIMEOUT (R17 / R21).
 */
async function dispatchToolsCall(
  request: DispatchInput,
  deps: DispatcherDeps,
): Promise<DispatchResult> {
  const sanitizedName = sanitizeToolName(request.name);
  const registration = deps.registrationsByName.get(sanitizedName as ToolName);

  if (registration === undefined) {
    // Cat 2: unknown name (including reserved). R31: audit tool_name
    // uses the literal reserved name for the two locked entries, OR
    // the "<unknown>" sentinel for arbitrary unknowns. Wire text is
    // always generic (no name echo).
    const reserved = isReservedName(sanitizedName);
    const auditedToolName = reserved ? sanitizedName : "<unknown>";
    const auditEntry: AuditRecordInput = reserved
      ? {
          event: "tool_call_denied",
          tool_name: auditedToolName,
          ok: false,
          error_code: "TOOL_NOT_FOUND",
          reserved: true,
          exposed: false,
          reason: "reserved_approval_gated_not_exposed",
        }
      : {
          event: "tool_call_denied",
          tool_name: auditedToolName,
          ok: false,
          error_code: "TOOL_NOT_FOUND",
          reserved: false,
          exposed: false,
        };

    try {
      await deps.audit.record(auditEntry);
    } catch (auditErr) {
      // Cat 2 audit failure: defer signalUnhealthy + throw McpError.
      // The SDK auto-prepends "MCP error -32603: " in the wire
      // message (R30), so we pass JUST the raw reason here. The
      // deferred signal lets the SDK serialize the McpError throw
      // before awaitShutdown rejects and the transport closes.
      signalUnhealthyAfterResponse(
        deps.signalUnhealthy,
        "audit append failed during denied-tool-name probe",
        auditErr,
      );
      throw new McpError(
        ErrorCode.InternalError,
        "audit append failed during denied-tool-name probe",
      );
    }

    return makeCat2Result();
  }

  // Cat 1: known tool. Invoke handler with arguments per the slice
  // 3.6 contract (handler owns input validation). Normalize missing
  // arguments to {} so zero-arg tools (get_policy, start_session
  // with no task, etc.) don't fail safeParse on undefined.
  const handlerInput = request.arguments === undefined ? {} : request.arguments;
  const start = Date.now();
  let rawEnvelope: ToolEnvelope<unknown>;
  try {
    const handlerInvocation = registration.handler(handlerInput, {
      repoRoot: deps.repoRoot,
    });
    rawEnvelope =
      registration.sideEffectClass === "A"
        ? await withTimeout(handlerInvocation, CLASS_A_TIMEOUT_MS, sanitizedName)
        : await handlerInvocation;
  } catch (err) {
    // Defensive: handlers should return envelopes, not throw. Tier 1
    // of toErrorEnvelope maps McpToolTimeoutError to MCP_TOOL_TIMEOUT
    // via the McpDirectError brand; Tier 2 maps other typed errors
    // via MCP_ERROR_CODE_MAP; Tier 3 falls through to INTERNAL_ERROR.
    rawEnvelope = toErrorEnvelope(err);
  }
  const duration_ms = Math.max(0, Date.now() - start);

  // D99.W normalization happens AFTER capture but BEFORE audit/wire
  // construction. The raw envelope is the source of truth for
  // audit-field detection (blocked, stderr_truncated); the
  // normalized envelope drives the wire response and error_code.
  const envelope = normalizeCommandOutputCap(rawEnvelope);
  const blocked = hasBooleanDataField(rawEnvelope, "blocked");
  const stderrTruncated = hasBooleanDataField(rawEnvelope, "stderr_truncated");

  const auditEntry: AuditRecordInput = envelope.ok
    ? {
        event: "tool_call",
        tool_name: sanitizedName,
        ok: true,
        exit_code: exitCodeFromEnvelope(envelope),
        duration_ms,
        ...(blocked ? { blocked: true as const } : {}),
        ...(stderrTruncated ? { stderr_truncated: true as const } : {}),
      }
    : {
        event: "tool_call",
        tool_name: sanitizedName,
        ok: false,
        exit_code: exitCodeFromEnvelope(envelope),
        error_code: envelope.error.code,
        duration_ms,
        ...(blocked ? { blocked: true as const } : {}),
        ...(stderrTruncated ? { stderr_truncated: true as const } : {}),
      };

  try {
    await deps.audit.record(auditEntry);
  } catch (auditErr) {
    // Cat 1 audit failure: defer signalUnhealthy + return Cat 1 with
    // MCP_AUDIT_WRITE_FAILED envelope. The client still gets a
    // structured tool result, AND startServer rejects after the
    // current response has been handed back to the SDK. Per D99.J
    // locked policy.
    signalUnhealthyAfterResponse(
      deps.signalUnhealthy,
      "audit append failed during known-tool dispatch",
      auditErr,
    );
    return envelopeToCat1Result(
      directErrorEnvelope("MCP_AUDIT_WRITE_FAILED", "audit append failed; server shutting down"),
    );
  }

  return envelopeToCat1Result(envelope);
}

// ============================================================================
// Shutdown controller
// ============================================================================

/**
 * Two-state shutdown coordinator. Both startServer and
 * createServerForTests use a controller to decide whether
 * `awaitShutdown` resolves (graceful) or rejects (unhealthy).
 *
 * - signalGraceful(): startServer's returned Promise will resolve
 *   after cleanup. Triggered by SIGINT/SIGTERM, transport close,
 *   or test-side .shutdown().
 * - signalUnhealthy(reason, cause): startServer's returned Promise
 *   will reject with McpBootError wrapping the cause. Triggered
 *   by audit append failures on denied-tool paths (deferred via
 *   signalUnhealthyAfterResponse so the response handoff wins the
 *   race), transport errors (via server.onerror), or other
 *   integrity failures.
 *
 * Idempotent: the first call wins. Subsequent calls are no-ops so
 * concurrent SIGINT + transport-close races settle cleanly.
 */
type ShutdownController = {
  readonly signalGraceful: () => void;
  readonly signalUnhealthy: (reason: string, cause: unknown) => void;
  readonly awaitShutdown: Promise<void>;
};

function createShutdownController(): ShutdownController {
  let resolved = false;
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const awaitShutdown = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    signalGraceful: () => {
      if (resolved) return;
      resolved = true;
      resolve();
    },
    signalUnhealthy: (reason: string, cause: unknown) => {
      if (resolved) return;
      resolved = true;
      reject(new McpBootError(reason, { cause }));
    },
    awaitShutdown,
  };
}

// ============================================================================
// Registration map builder
// ============================================================================

/**
 * Build an O(1) lookup Map<ToolName, ToolRegistration> from the
 * locked TOOL_REGISTRATIONS_IN_ORDER tuple. The dispatcher uses the
 * map for the tool-name lookup; the tools/list response iterates the
 * map's values (preserves insertion order = catalog order).
 *
 * The cast to ToolRegistration is safe because each element of
 * TOOL_REGISTRATIONS_IN_ORDER is a specific ToolRegistration<TName,
 * TData> -- widening to ToolRegistration<ToolName, unknown> for the
 * map is just losing the per-tool TData narrowing, which the
 * dispatcher doesn't need.
 */
function buildRegistrationsByName(): ReadonlyMap<ToolName, ToolRegistration> {
  const map = new Map<ToolName, ToolRegistration>();
  for (const reg of TOOL_REGISTRATIONS_IN_ORDER) {
    map.set(reg.name, reg as ToolRegistration);
  }
  return map;
}

// ============================================================================
// Public: startServer
// ============================================================================

/**
 * Boot the MCP server over stdio. Resolves on graceful shutdown
 * (SIGINT, SIGTERM, or transport close). Rejects on boot failure
 * (McpBootError) or unhealthy shutdown (audit append failure during
 * a denied-tool probe, transport error).
 *
 * Per D99.P locked contract:
 *   - cwd is the only input. resolveRepoRoot(cwd) does the
 *     boot-time binding; failure wraps as McpBootError.
 *   - One audit log opens at boot, closes at shutdown (cleanup
 *     runs even when the SDK wiring throws -- D99.K + D99.M.7
 *     enforce single-FH lifetime).
 *   - NEVER calls process.exit (D99.M.14). Returns / rejects only.
 *   - NEVER writes to process.stdout/stderr -- the SDK owns
 *     protocol stdio; the CLI command wrapper (Step 5) owns
 *     human-facing stderr + exit codes.
 */
export async function startServer(opts: { cwd: string }): Promise<void> {
  // Boot phase: resolve repo root + open audit log. Any failure
  // here is a boot failure (McpBootError) -- the dispatcher never
  // runs.
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(opts.cwd);
  } catch (err) {
    throw new McpBootError("MCP server boot failed: repo root not resolved", { cause: err });
  }

  let audit: AuditWriter;
  try {
    audit = await openAuditLog({ repoRoot });
  } catch (err) {
    throw new McpBootError("MCP server boot failed: audit log open failed", { cause: err });
  }

  const registrationsByName = buildRegistrationsByName();
  const shutdown = createShutdownController();

  const deps: DispatcherDeps = {
    audit,
    repoRoot,
    registrationsByName,
    signalUnhealthy: (reason, cause) => shutdown.signalUnhealthy(reason, cause),
  };

  // SDK wiring. Single new Server() + single new StdioServerTransport()
  // call sites per D99.M.8.
  const server = new Server(
    { name: "@viberevert/mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  const transport = new StdioServerTransport();

  // Wire onclose/onerror BEFORE connect so the handlers are in
  // place before any SDK initialization event can fire. A close or
  // error during connect would otherwise have no handler attached
  // and the shutdown signal would be lost.
  server.onclose = () => shutdown.signalGraceful();
  server.onerror = (err) => shutdown.signalUnhealthy("MCP server transport error", err);

  try {
    server.setRequestHandler(ListToolsRequestSchema, async () => dispatchToolsList(deps));
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      dispatchToolsCall({ name: req.params.name, arguments: req.params.arguments }, deps),
    );
    await server.connect(transport);
  } catch (err) {
    // SDK wiring failure: close audit (best-effort -- the boot
    // outcome is already determined) then wrap as McpBootError. The
    // audit FH would otherwise leak across the failed boot.
    try {
      await audit.close();
    } catch {
      // Best-effort cleanup; the upstream wiring failure is what
      // the caller sees.
    }
    throw new McpBootError("MCP server boot failed: transport wiring failed", { cause: err });
  }

  // Signal handlers: SIGINT (Ctrl+C) and SIGTERM both trigger
  // graceful shutdown. The handlers are removed in the finally
  // block below so a subsequent startServer call in the same
  // process (e.g., test suite) doesn't accumulate listeners.
  const onSignal = (): void => shutdown.signalGraceful();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // Block until graceful or unhealthy. signalUnhealthy rejects
    // this Promise via the controller; signalGraceful resolves it.
    await shutdown.awaitShutdown;
  } finally {
    // Cleanup runs on BOTH paths (resolve and reject). Order:
    // close transport (via server.close) first, then close audit
    // log. Errors during cleanup are swallowed -- the upstream
    // outcome (graceful or McpBootError) is what the caller sees.
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await server.close();
    } catch {
      // Transport close failures are not fatal for the audit
      // outcome; the caller's outcome is already determined.
    }
    try {
      await audit.close();
    } catch {
      // Audit close failures are not fatal -- the audit log on
      // disk has whatever records the writer's tail successfully
      // flushed. McpAuditWriteError on close is observed via the
      // record() rejection path during normal operation, not here.
    }
  }
}

// ============================================================================
// Public: createServerForTests
// ============================================================================

/**
 * Test-only entry. Exposes the dispatcher logic for in-process
 * testing WITHOUT constructing an SDK Server or StdioServerTransport
 * (Option X locked at Step 4 planning -- preserves D99.M.8's
 * "exactly 1 of each" by keeping the constructors confined to
 * startServer).
 *
 * Returns:
 *   - dispatch(request): invokes the SAME dispatchToolsCall function
 *     the SDK request handler would use. Tests assert wire shapes,
 *     audit records, and signalUnhealthy side effects via this
 *     function.
 *   - shutdown(): triggers a graceful shutdown and awaits cleanup
 *     (audit close). Resolves after both signalGraceful and
 *     audit.close have settled.
 *   - closed: mirrors the shutdown controller's awaitShutdown
 *     Promise, with audit.close cleanup chained in a finally block
 *     so the audit FH is released on BOTH graceful and unhealthy
 *     paths. Resolves on graceful, rejects on unhealthy. Tests can
 *     await this to verify the unhealthy-shutdown path fires
 *     correctly after a forced audit failure.
 *
 * Boot phase mirrors startServer (resolveRepoRoot + openAuditLog,
 * with the same McpBootError wrapping on failure).
 *
 * No optional injected registrations / audit writer yet -- the
 * exported contract stays minimal. Tests use vi.mock for boundary
 * stubbing; injection points get added only if tests prove they
 * are necessary.
 */
export async function createServerForTests(opts: { cwd: string }): Promise<{
  readonly dispatch: (request: DispatchInput) => Promise<DispatchResult>;
  readonly shutdown: () => Promise<void>;
  readonly closed: Promise<void>;
}> {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(opts.cwd);
  } catch (err) {
    throw new McpBootError("MCP server boot failed: repo root not resolved", { cause: err });
  }

  let audit: AuditWriter;
  try {
    audit = await openAuditLog({ repoRoot });
  } catch (err) {
    throw new McpBootError("MCP server boot failed: audit log open failed", { cause: err });
  }

  const registrationsByName = buildRegistrationsByName();
  const shutdown = createShutdownController();

  const deps: DispatcherDeps = {
    audit,
    repoRoot,
    registrationsByName,
    signalUnhealthy: (reason, cause) => shutdown.signalUnhealthy(reason, cause),
  };

  // closed mirrors awaitShutdown but chains audit.close in a finally
  // so the audit FH is released on BOTH graceful and unhealthy
  // paths. Without this, an unhealthy shutdown triggered via a
  // forced audit failure would reject `closed` while leaking the
  // (already-failing) audit handle.
  const closed = shutdown.awaitShutdown.finally(async () => {
    try {
      await audit.close();
    } catch {
      // Same swallow policy as startServer's finally block: the
      // upstream graceful/unhealthy outcome is what the caller
      // sees on `closed`.
    }
  });

  // Attach a noop rejection handler so a test that intentionally
  // triggers unhealthy shutdown (without immediately awaiting
  // `closed`) does not trip Node's unhandled-rejection detector.
  // The rejection is preserved -- callers can still
  // `await expect(server.closed).rejects.toThrow(...)`.
  void closed.catch(() => {
    /* prevent unhandled-rejection noise during forced-failure tests */
  });

  return {
    dispatch: (request) => dispatchToolsCall(request, deps),
    shutdown: async () => {
      shutdown.signalGraceful();
      await closed;
    },
    closed,
  };
}
