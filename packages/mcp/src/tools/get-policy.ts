// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// get_policy MCP tool: direct-core backend.
//
// Per D99.E + D99.Q row 5 + D99.V:
//
//   - Backend: direct-core. Calls @viberevert/core's loadConfig +
//     mergeChecksConfig (the resolver promoted in M G1a Step 3.5a).
//
//   - Returns the project's resolved policy slice: concrete block/warn
//     risk thresholds, the check-toggles map, configured-or-detected
//     frameworks, and the rollback-exclude pattern list.
//
//   - Side-effect class: A (loadConfig + mergeChecksConfig are
//     read-only per D57; mergeChecksConfig delegates to
//     detectFrameworks which does fs.existsSync probes only).
//
//   - No input fields (empty strict object). Empty input is the only
//     valid shape; extras are rejected with INVALID_TOOL_INPUT.
//
//   - Error mapping: ConfigNotFoundError / ConfigParseError flow
//     through toErrorEnvelope (Tier 2 constructor map ->
//     CONFIG_NOT_FOUND / CONFIG_PARSE_FAILED). ConfigValidationError
//     is handled explicitly so the per-field issues surface as
//     `details.issues` for MCP consumers; toErrorEnvelope produces
//     the base shape, then we spread-merge `details` so any future
//     base-shape `details` field is preserved alongside `issues`.
//
// Output shape derivation:
//
//   `GetPolicyData` is derived from `Awaited<ReturnType<typeof
//   mergeChecksConfig>>` so the MCP surface stays compile-time tied
//   to core's `ResolvedChecksConfig` without importing
//   `ChecksToggleKey` directly (which would require expanding the
//   D99.M.6 allowed-import set for a type-only import).
//
// Output snapshot ownership:
//
//   `projectToData` spreads arrays and clones the `checks` map so
//   the MCP boundary owns its own output snapshot. Core's resolver
//   already returns snapshots (3.5a hardening), but the MCP layer
//   does not rely on that contract being preserved across versions.
//   The ConfigValidationError handler likewise snapshots `err.issues`
//   into the envelope details.
//
// SDK-free: no @modelcontextprotocol/sdk import.

import { ConfigValidationError, loadConfig, mergeChecksConfig } from "@viberevert/core";
import { z } from "zod";

import { type ToolEnvelope, toErrorEnvelope, toInvalidToolInputEnvelope } from "../envelope.js";
import type { JsonSchemaObject, ToolDefinition, ToolHandler } from "../tools.js";

// ============================================================================
// Input schema (empty, strict)
// ============================================================================

const getPolicyInputSchema = z.object({}).strict();

// ============================================================================
// Output data shape (D99.Q row 5)
// ============================================================================

type ResolvedPolicy = Awaited<ReturnType<typeof mergeChecksConfig>>;

export type GetPolicyData = {
  readonly risk: {
    readonly block_on: ResolvedPolicy["riskBlockOn"];
    readonly warn_on: ResolvedPolicy["riskWarnOn"];
  };
  readonly frameworks: ResolvedPolicy["frameworks"];
  readonly checks_enabled: ResolvedPolicy["checks"];
  readonly rollback_exclude: ResolvedPolicy["rollbackExclude"];
};

// ============================================================================
// Helpers (module-private)
// ============================================================================

/**
 * Project the core resolver's `ResolvedPolicy` into the snake_case MCP
 * shape. Arrays are spread and the `checks` map is cloned so the MCP
 * boundary owns its own output snapshot -- defense in depth that does
 * not rely on core's snapshot contract being preserved over time.
 */
function projectToData(resolved: ResolvedPolicy): GetPolicyData {
  return {
    risk: { block_on: resolved.riskBlockOn, warn_on: resolved.riskWarnOn },
    frameworks: [...resolved.frameworks],
    checks_enabled: { ...resolved.checks },
    rollback_exclude: [...resolved.rollbackExclude],
  };
}

// ============================================================================
// Public surface (D99.G: exactly `definition` + `handler`)
// ============================================================================

export const definition: ToolDefinition<"get_policy"> = {
  name: "get_policy",
  description:
    "Return the project's resolved policy slice from .viberevert.yml: " +
    "block/warn risk thresholds, check toggles, frameworks, and rollback " +
    "exclude patterns. Applies M C defaults (D57) before returning. " +
    "Read-only (class A per D99.V); does not run checks or mutate state.",
  inputSchema: z.toJSONSchema(getPolicyInputSchema, { target: "draft-7" }) as JsonSchemaObject,
};

export const handler: ToolHandler<GetPolicyData> = async (
  input,
  context,
): Promise<ToolEnvelope<GetPolicyData>> => {
  const parsed = getPolicyInputSchema.safeParse(input);
  if (!parsed.success) {
    return toInvalidToolInputEnvelope("get_policy", parsed.error);
  }

  try {
    const config = await loadConfig(context.repoRoot);
    const resolved = await mergeChecksConfig(config, context.repoRoot);
    return { ok: true, data: projectToData(resolved) };
  } catch (err) {
    // ConfigValidationError is in MCP_ERROR_CODE_MAP
    // (-> CONFIG_VALIDATION_FAILED) but toErrorEnvelope intentionally
    // does not propagate err-specific details. Use toErrorEnvelope to
    // get the sanitized base shape, then augment `details` with
    // `issues` so MCP consumers can render the exact invalid config
    // paths. The defensive spread preserves any base-shape `details`
    // field a future toErrorEnvelope revision might set, while the
    // !Array.isArray guard prevents an array `details` from being
    // spread into the object envelope (which would create numeric
    // keys). `issues` is snapshotted so the MCP boundary owns its
    // diagnostic array. ConfigNotFoundError, ConfigParseError, and
    // any unknown error flow through toErrorEnvelope unchanged.
    if (err instanceof ConfigValidationError) {
      const base = toErrorEnvelope(err);
      // toErrorEnvelope returns ToolEnvelope<never>, so the ok:true
      // branch is unreachable; narrow explicitly for TS.
      if (base.ok === false) {
        const existingDetails =
          typeof base.error.details === "object" &&
          base.error.details !== null &&
          !Array.isArray(base.error.details)
            ? base.error.details
            : {};
        return {
          ok: false,
          error: {
            ...base.error,
            details: { ...existingDetails, issues: [...err.issues] },
          },
        };
      }
    }
    return toErrorEnvelope(err);
  }
};
