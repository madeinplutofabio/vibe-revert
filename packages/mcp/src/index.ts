// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// @viberevert/mcp public barrel.
//
// Step 2 surface: envelope + audit + errors + timeout primitives. The
// MCP server boot entry point (startServer) and tool definitions arrive
// in Step 4 and Step 3 respectively; this file will grow then.
//
// Discipline: external consumers (CLI's MCPCommand in Step 5, M G1b
// installers, future MCP-aware integrations) MUST import from this
// barrel, never from deep paths. D99.M.19 enforces the reverse for
// cli-commands -> mcp; the same boundary applies in both directions
// to let internal layout evolve without breaking consumers.
//
// Only public surface is re-exported. Private helpers
// (sanitizeMessage, scrubZodIssueMessage, ErrorCtor type, the per-shape
// audit serializers, AuditWriterImpl class) stay module-private.

// ============================================================================
// Envelope (D99.I two-source error model -- mapping side)
// ============================================================================

export {
  formatZodErrorSummary,
  MCP_ERROR_CODE_ENTRIES,
  MCP_ERROR_CODE_MAP,
  type ToolEnvelope,
  toErrorEnvelope,
  toolEnvelopeSchema,
  toolEnvelopeSchemaOf,
} from "./envelope.js";

// ============================================================================
// Errors (D99.I direct-code registry + branded base + 4 concrete classes)
// ============================================================================

export {
  MCP_DIRECT_ERROR_CODES,
  McpAuditWriteError,
  McpBootError,
  McpDirectError,
  type McpDirectErrorCode,
  McpToolInvocationError,
  McpToolTimeoutError,
} from "./errors.js";

// ============================================================================
// Audit log (D99.J/K/L NDJSON writer + record-type catalog)
// ============================================================================

export {
  type AuditRecord,
  type AuditRecordInput,
  type AuditWriter,
  openAuditLog,
  type ServerIntegrityFailureRecord,
  type ToolCallDeniedRecord,
  type ToolCallRecord,
} from "./audit.js";

// ============================================================================
// Timeout helper (D99.V class-A 30s race primitive)
// ============================================================================

export { withTimeout } from "./timeout.js";
