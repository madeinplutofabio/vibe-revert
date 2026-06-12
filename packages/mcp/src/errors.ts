// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// MCP error infrastructure: direct-code registry, branded base class,
// and the 4 error classes used by the MCP package.
//
// Two-source error model (D99.I):
//
//   1. MCP_ERROR_CODE_MAP (in envelope.ts) keys VibeRevert domain error
//      classes from @viberevert/cli-commands and @viberevert/core to
//      stable code strings. Used by toErrorEnvelope() when a CLI
//      command or operation throws a known typed error.
//
//   2. MCP_DIRECT_ERROR_CODES (here) is the registry of codes
//      synthesized by the MCP layer itself. The MCP-internal error
//      classes (McpAuditWriteError, McpToolTimeoutError) carry these
//      codes via the McpDirectError brand. The remaining direct codes
//      (MCP_COMMAND_OUTPUT_TOO_LARGE, INVALID_TOOL_INPUT) are emitted
//      inline by the Step 4 dispatcher / Step 3 handlers when they
//      detect a condition without a thrown exception (return-flag
//      pattern, safeParse Result pattern).
//
// Lookup precedence in toErrorEnvelope() (defined in envelope.ts):
//
//   Tier 1: err instanceof McpDirectError -> emit err.mcpCode
//   Tier 2: MCP_ERROR_CODE_MAP.get(err.constructor) -> emit mapped code
//   Tier 3: fallback -> emit INTERNAL_ERROR
//
// The brand (McpDirectError) prevents toErrorEnvelope from accidentally
// treating a duck-typed `"code" in err` (Node SystemError ENOENT/EACCES/
// EPERM etc.) as a direct MCP code. Class identity, not property
// presence.

// ============================================================================
// Direct-code registry
// ============================================================================

/**
 * Codes synthesized by the MCP layer itself (NOT mapped from a
 * VibeRevert domain error class via MCP_ERROR_CODE_MAP in envelope.ts).
 *
 * Frozen so a future maintainer cannot mutate the array at runtime.
 * The derived type below extracts the exact union of allowed code
 * strings so subclasses of McpDirectError get compile-time
 * verification that their `mcpCode` belongs to this list.
 */
export const MCP_DIRECT_ERROR_CODES = Object.freeze([
  "MCP_TOOL_TIMEOUT",
  "MCP_AUDIT_WRITE_FAILED",
  "MCP_COMMAND_OUTPUT_TOO_LARGE",
  "INVALID_TOOL_INPUT",
] as const);

/** Exact union of the 4 direct-code strings, derived from the frozen tuple. */
export type McpDirectErrorCode = (typeof MCP_DIRECT_ERROR_CODES)[number];

// ============================================================================
// Branded base class
// ============================================================================

/**
 * Brand for MCP-layer errors that carry a direct envelope code.
 *
 * toErrorEnvelope() checks `err instanceof McpDirectError` and emits
 * `err.mcpCode` directly. This is intentionally a class-identity check,
 * NOT a duck-typed `"code" in err` check -- the latter would match
 * Node's SystemError (ENOENT, EACCES, EPERM, ...), which would corrupt
 * the MCP envelope's code field with a filesystem errno.
 *
 * Subclasses MUST set `mcpCode` to a value from MCP_DIRECT_ERROR_CODES.
 * The `as const` assertion in each subclass narrows the type so
 * TypeScript verifies the code string belongs to the McpDirectErrorCode
 * union at compile time.
 */
export abstract class McpDirectError extends Error {
  abstract readonly mcpCode: McpDirectErrorCode;

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = this.constructor.name;
  }
}

// ============================================================================
// Error classes
// ============================================================================

/**
 * Audit log write or close failure.
 *
 * Surfaces from openAuditLog (mkdir/open failed), AuditWriter.record
 * (appendFile failed), and AuditWriter.close (close failed AFTER tail
 * settled). The Step 4 dispatcher maps this to MCP_AUDIT_WRITE_FAILED
 * in the envelope OR to a JSON-RPC InternalError + unhealthy shutdown,
 * depending on which response category (1, 2, 3, or 4) was in flight
 * when the audit failure occurred (D99.J locked failure policy).
 *
 * Supports `secondaryCause` for the rare case where BOTH the tail
 * append AND the FileHandle close failed in AuditWriter.close. Standard
 * `cause` carries the upstream (tail) failure; `secondaryCause` carries
 * the close failure. Diagnostic preservation without losing either.
 */
export class McpAuditWriteError extends McpDirectError {
  override readonly mcpCode = "MCP_AUDIT_WRITE_FAILED" as const;
  readonly secondaryCause?: unknown;

  constructor(message: string, opts?: { cause?: unknown; secondaryCause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.secondaryCause = opts?.secondaryCause;
  }
}

/**
 * Tool execution exceeded the per-tool timeout (D99.V class A only).
 *
 * Surfaces from withTimeout() when the inner Promise does not settle
 * within the locked window (30s for class A). Class B tools (side-
 * effecting) are NOT wrapped in withTimeout per R17 -- abandoning a
 * side-effecting Command mid-run would destroy audit truth.
 *
 * Carries `toolName` and `timeoutMs` for the audit record (the
 * dispatcher uses both fields when constructing the
 * `{event:"tool_call", ok:false, error_code:"MCP_TOOL_TIMEOUT",
 * exit_code:null, duration_ms:<ms>}` audit entry).
 */
export class McpToolTimeoutError extends McpDirectError {
  override readonly mcpCode = "MCP_TOOL_TIMEOUT" as const;

  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Tool ${toolName} exceeded ${timeoutMs}ms timeout`);
  }
}

/**
 * MCP server boot failure.
 *
 * NOT a McpDirectError -- never reaches a ToolEnvelope. Surfaces from
 * the future Step 4/5 startServer() when boot binding fails
 * (resolveRepoRoot threw, audit log could not be opened, transport
 * could not be wired). The MCPCommand wrapper (Step 5) catches this,
 * writes a one-line stderr diagnostic, and returns exit code 1.
 *
 * No mcpCode field because this error class lives ABOVE the envelope
 * layer -- by the time the dispatcher would be running, boot has
 * already succeeded.
 */
export class McpBootError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "McpBootError";
  }
}

/**
 * Wrapper for an UNEXPECTED throw from a tool handler invocation.
 *
 * Regular Error only -- carries no mcpCode. The Step 4 dispatcher
 * uses this to attach `toolName` to unknown throws (errors NOT
 * present in MCP_ERROR_CODE_MAP) for diagnostic logs. The dispatcher
 * still passes the ORIGINAL err to toErrorEnvelope, where the
 * unknown error falls through to INTERNAL_ERROR.
 *
 * Do NOT wrap known domain errors with this class before
 * toErrorEnvelope(), or constructor-keyed mapping would be lost.
 */
export class McpToolInvocationError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
    opts?: { cause?: unknown },
  ) {
    super(message, opts);
    this.name = "McpToolInvocationError";
  }
}
