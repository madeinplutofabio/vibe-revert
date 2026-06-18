// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// MCP tool catalog + per-tool registration contract.
//
// Architectural locks:
//
//   D99.A -- TOOL_NAMES_IN_ORDER is the locked 8-element tuple of
//   tool names exposed via tools/list. Order is part of the contract:
//   the Step 5 Phase 12f smoke test asserts tools/list returns them
//   in this exact sequence. D99.M.4 AST-asserts the array literal
//   matches this tuple exactly (order-sensitive).
//
//   D99.B -- RESERVED_TOOL_NAMES is the locked 2-element tuple of
//   reserved-but-hidden names that MUST NOT appear in tools/list
//   and MUST be denied by the dispatcher with the same Cat 2 shape
//   as any other unknown name (D99.O). D99.M.3 AST-asserts the
//   two tuples are disjoint.
//
//   D99.V -- ToolSideEffectClass + TOOL_SIDE_EFFECT_CLASS_BY_NAME
//   drive the Step 4 dispatcher's conditional withTimeout wrap.
//   Class "A" tools are no-side-effect and timeout-eligible; class
//   "B" tools are side-effecting and run to completion (R17 -- no
//   cancellation tokens in v0.7.0-beta, so racing a write tool
//   would destroy audit truth). The "D99.V / Step 3" invariant in
//   architectural-invariants.test.ts AST-asserts the map content
//   exactly so a B-to-A flip cannot slip through.
//
//   D99.P -- ToolHandlerContext carries the boot-time repoRoot so
//   handlers never call process.cwd(). The MCP server binds to one
//   repo at boot; the dispatcher passes repoRoot into every handler
//   invocation. D99.M.17 forbids cwd-like fields in any tool's
//   inputSchema -- the context channel is the only legitimate way
//   for a handler to learn the repo location.
//
// SDK-free internal contract:
//
//   This file deliberately imports NO MCP SDK types. The structural
//   ToolDefinition / ToolHandler / ToolRegistration shapes are
//   defined locally so the catalog + per-tool files compile and
//   test without the SDK on the critical path. Step 4's dispatcher
//   (server.ts) adapts these internal shapes to the SDK's tools/call
//   and tools/list response types at the server boundary -- the
//   adapter is the one place SDK types touch tool logic.
//
//   The Step 3 pre-import guard (architectural-invariants.test.ts)
//   continues to block any @modelcontextprotocol/sdk import in
//   packages/mcp/src/** until the first SDK-using implementation
//   slice lands.

import type { ToolEnvelope } from "./envelope.js";

// ============================================================================
// Tool catalog (D99.A + D99.B)
// ============================================================================

/**
 * Locked 8-element tuple of exposed tool names per D99.A.
 *
 * Order is part of the contract: tools/list responses MUST emit the
 * tools in this exact sequence. Phase 12f smoke test asserts this.
 *
 *   Read-only (5):   check_repo, explain_diff, classify_risk,
 *                    list_risky_files, get_policy
 *   Local-write (3): start_session, create_checkpoint,
 *                    generate_fix_prompt
 */
export const TOOL_NAMES_IN_ORDER = [
  "check_repo",
  "explain_diff",
  "classify_risk",
  "list_risky_files",
  "get_policy",
  "start_session",
  "create_checkpoint",
  "generate_fix_prompt",
] as const;

/** Union of exposed tool names derived from TOOL_NAMES_IN_ORDER. */
export type ToolName = (typeof TOOL_NAMES_IN_ORDER)[number];

/**
 * Locked 2-element tuple of reserved-but-hidden tool names per D99.B.
 *
 * MUST NOT appear in tools/list. MUST be denied by the dispatcher
 * with the same Cat 2 shape as any other unknown name (D99.O). MUST
 * be audited as `tool_call_denied` with `reserved:true` +
 * `reason:"reserved_approval_gated_not_exposed"` (D99.J).
 */
export const RESERVED_TOOL_NAMES = ["rollback", "request_human_approval"] as const;

/** Union of reserved tool names derived from RESERVED_TOOL_NAMES. */
export type ReservedToolName = (typeof RESERVED_TOOL_NAMES)[number];

// ============================================================================
// Side-effect class (D99.V)
// ============================================================================

/**
 * Per-tool side-effect classification. Drives the Step 4 dispatcher's
 * conditional withTimeout wrap.
 *
 *   "A" -- no side effects (no .viberevert/ writes, no git
 *          mutation, no sibling file persistence). Wrapped in
 *          withTimeout(30_000) by the Step 4 dispatcher per D99.V.
 *          Timing out is safe because abandoning the in-process Cli
 *          invocation orphans nothing.
 *
 *   "B" -- side-effecting (writes session/checkpoint/sibling files
 *          OR mutates git state). NOT wrapped in withTimeout per
 *          R17 -- without real cancellation tokens, racing a write
 *          tool would produce "MCP says timeout, repo says mutated"
 *          which destroys audit truth. Runs to completion.
 */
export type ToolSideEffectClass = "A" | "B";

/**
 * Locked per-tool side-effect classification. The Step 4 dispatcher
 * reads this map (or the equivalent ToolRegistration.sideEffectClass
 * field) to decide whether to wrap a handler invocation in
 * withTimeout per D99.V.
 *
 * `satisfies Record<ToolName, ToolSideEffectClass>` enforces that
 * every name in TOOL_NAMES_IN_ORDER has an entry AND no extra keys
 * exist -- adding a 9th tool to TOOL_NAMES_IN_ORDER without adding
 * its class entry here is a compile error.
 *
 * check_repo defaults to class B per D99.V because CheckCommand may
 * persist report/session artifacts under .viberevert/. Flip to "A"
 * only in the same slice that proves and tests a no-persist MCP
 * path (Step 0.6 verification not yet run).
 *
 * ToolRegistration's `sideEffectClass` field is typed as
 * `(typeof TOOL_SIDE_EFFECT_CLASS_BY_NAME)[TName]`, so a
 * registration with `name: "check_repo", sideEffectClass: "A"` is
 * a compile error -- the registration MUST match the map for its
 * specific tool name.
 */
export const TOOL_SIDE_EFFECT_CLASS_BY_NAME = {
  check_repo: "B",
  explain_diff: "A",
  classify_risk: "A",
  list_risky_files: "A",
  get_policy: "A",
  start_session: "B",
  create_checkpoint: "B",
  generate_fix_prompt: "B",
} as const satisfies Record<ToolName, ToolSideEffectClass>;

// ============================================================================
// Structural JSON / JSON Schema types (SDK-free)
// ============================================================================

/** Recursive JSON value. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Plain JSON object. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Structural JSON Schema (draft-07 subset, loose).
 *
 * The schema is produced by z.toJSONSchema() at tool-definition
 * authoring time and consumed by the MCP SDK as opaque JSON. Typed
 * here only tightly enough that ToolDefinition.inputSchema cannot
 * be set to a primitive by mistake.
 */
export type JsonSchemaObject = {
  readonly type?: string;
  readonly properties?: { readonly [key: string]: JsonSchemaObject };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchemaObject;
  readonly description?: string;
  readonly [key: string]: unknown;
};

// ============================================================================
// Per-tool contract types
// ============================================================================

/**
 * Per-tool handler context. Carries boot-time data that handlers
 * cannot/MUST NOT learn through their own input schema (D99.M.17
 * forbids cwd-like input fields).
 *
 * Currently exposes only `repoRoot` -- the absolute path to the
 * vibe-revert repo root resolved by startServer() at boot per D99.P.
 * Future additions may include shared dependencies (audit writer,
 * config snapshot, etc.) the dispatcher injects.
 */
export type ToolHandlerContext = {
  readonly repoRoot: string;
};

/**
 * Per-tool definition: the public face of a tool in tools/list.
 *
 * Generic `TName extends ToolName = ToolName` binds the definition's
 * name to a specific literal so the registration can enforce
 * `registration.name === definition.name` at the type level. The
 * ToolRegistration type uses `NoInfer<TName>` on the definition's
 * TName so inference flows from `registration.name` only -- this
 * makes a mismatched definition.name a compile error.
 *
 * SDK-agnostic shape. Step 4's dispatcher adapts this to the SDK's
 * expected tool object (`{name, description?, inputSchema, ...}`)
 * at the server boundary.
 */
export type ToolDefinition<TName extends ToolName = ToolName> = {
  readonly name: TName;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
};

/**
 * Per-tool handler: validated input + handler context -> typed envelope.
 *
 * Input is typed as `unknown` because the handler receives raw args
 * from the Step 4 dispatcher and runs its own safeParse against the
 * tool's Zod schema BEFORE projecting to a typed value (D99.Z own
 * input validation). The generic TData parameter narrows the
 * success branch of the returned envelope so per-tool tests can
 * assert specific data shapes.
 *
 * Context carries boot-time data (repoRoot per D99.P + any future
 * shared dependencies) so handlers never call process.cwd() or
 * reach for ambient state.
 */
export type ToolHandler<TData = unknown> = (
  input: unknown,
  context: ToolHandlerContext,
) => Promise<ToolEnvelope<TData>>;

/**
 * Per-tool registration row (the per-tool unit of the Step 3 tool
 * catalog).
 *
 *   name             matches the tool's exposed name (ToolName).
 *   definition       drives tools/list responses; definition.name
 *                    MUST equal `name` (enforced by NoInfer<TName>).
 *   handler          drives tools/call invocations.
 *   sideEffectClass  MUST match the locked
 *                    TOOL_SIDE_EFFECT_CLASS_BY_NAME entry for this
 *                    specific TName (enforced by the indexed-type
 *                    `(typeof TOOL_SIDE_EFFECT_CLASS_BY_NAME)[TName]`).
 *                    Drives the Step 4 dispatcher's conditional
 *                    withTimeout wrap (D99.V class A vs B).
 *
 * Two type-level guarantees:
 *
 *   1. `name === definition.name`. The TName generic binds both
 *      fields to the same literal. `NoInfer<TName>` on
 *      definition's TName forces inference from `name` only, so a
 *      mismatched `definition.name` is a compile error rather than
 *      a silent widening of TName.
 *
 *   2. `sideEffectClass === TOOL_SIDE_EFFECT_CLASS_BY_NAME[name]`.
 *      The indexed-type lookup constrains sideEffectClass to the
 *      exact "A" or "B" value the locked map specifies for that
 *      specific tool name. A registration with
 *      `name: "check_repo", sideEffectClass: "A"` is a compile
 *      error -- check_repo is locked to "B" in the map.
 *
 * `handler` is typed as ToolHandler<TData> in the registration
 * row. The dispatcher invokes by name without static knowledge of
 * TData. ToolHandler<X> is assignable to ToolHandler<unknown>
 * because ToolEnvelope is covariant in its data parameter (success
 * branch is `data: TData`).
 */
export type ToolRegistration<TName extends ToolName = ToolName, TData = unknown> = {
  readonly name: TName;
  readonly definition: ToolDefinition<NoInfer<TName>>;
  readonly handler: ToolHandler<TData>;
  readonly sideEffectClass: (typeof TOOL_SIDE_EFFECT_CLASS_BY_NAME)[TName];
};

/**
 * Helper for declaring a ToolRegistration with TName preserved as a
 * literal type (not widened to `ToolName`).
 *
 * Without this helper, a plain `const reg: ToolRegistration = {...}`
 * would widen `name` to `ToolName` and lose the constraints that
 * `definition.name === name` AND
 * `sideEffectClass === TOOL_SIDE_EFFECT_CLASS_BY_NAME[name]`. The
 * `const TName extends ToolName` type parameter forces TS to infer
 * the narrow literal at the call site.
 *
 * Example:
 *
 *   export const checkRepoRegistration = defineToolRegistration({
 *     name: "check_repo",
 *     definition: { name: "check_repo", description: "...", inputSchema: {...} },
 *     handler: async (input, ctx) => { ... },
 *     sideEffectClass: "B",   // MUST be "B" per the map; "A" is a compile error
 *   });
 *
 * A mismatched definition.name OR sideEffectClass produces a TS
 * error at the call site.
 */
export function defineToolRegistration<const TName extends ToolName, TData = unknown>(
  registration: ToolRegistration<TName, TData>,
): ToolRegistration<TName, TData> {
  return registration;
}
