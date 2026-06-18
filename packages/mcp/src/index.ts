// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// @viberevert/mcp public barrel.
//
// Current surface: Step 2 primitives (envelope + audit + errors +
// timeout) plus the Step 3 SDK-free tool catalog contract
// (TOOL_NAMES_IN_ORDER, RESERVED_TOOL_NAMES, ToolRegistration shape,
// per-tool handler signature with ToolHandlerContext, D99.V
// side-effect class map, defineToolRegistration helper) plus the
// growing tool registry (TOOL_REGISTRATIONS_IN_ORDER) -- check_repo
// landed in Slice 3.3, the remaining 7 tools land in Slices
// 3.4-3.7. The MCP server boot entry point (startServer /
// createServerForTests) arrives in Step 4.
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

// ============================================================================
// Tool catalog + per-tool registration contract (D99.A/B/V, SDK-free)
// ============================================================================

export {
  defineToolRegistration,
  type JsonObject,
  type JsonSchemaObject,
  type JsonValue,
  RESERVED_TOOL_NAMES,
  type ReservedToolName,
  TOOL_NAMES_IN_ORDER,
  TOOL_SIDE_EFFECT_CLASS_BY_NAME,
  type ToolDefinition,
  type ToolHandler,
  type ToolHandlerContext,
  type ToolName,
  type ToolRegistration,
  type ToolSideEffectClass,
} from "./tools.js";

// ============================================================================
// Tool registry (D99.E, SDK-free aggregation of per-tool definitions)
// ============================================================================

export { TOOL_REGISTRATIONS_IN_ORDER } from "./tool-registry.js";
