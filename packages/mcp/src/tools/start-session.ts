// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// start_session MCP tool: typed-operation backend.
//
// Per D99.E + D99.Q row 6 + D99.V:
//
//   - Backend: typed-operation. Calls
//     @viberevert/cli-commands's startSessionOperation (extracted in
//     M G1a Step 1) which owns all session-start domain logic:
//     repo-root resolution, config load, D22 start-lock, D11
//     active-session pre-check, inner-checkpoint creation, git
//     porcelain capture, core.startSession hand-off, D13 cleanup.
//
//   - Returns the new session id, inner checkpoint id, and start
//     timestamp.
//
//   - Side-effect class: B (writes session state and uses the D22
//     start lock during execution; lock is released on operation
//     completion or failure). NOT wrapped in withTimeout per D99.V
//     -- racing a side-effecting tool without cancellation tokens
//     would destroy audit truth.
//
//   - Input fields: { task? }. Empty input is valid (no task). When
//     present, task MUST contain at least one non-whitespace
//     character -- the operation itself does not re-validate, so
//     the MCP Zod schema is the gatekeeper. The handler then trims
//     the parsed task before passing it to the operation so
//     persisted session metadata never carries accidental leading/
//     trailing whitespace. The schema uses .regex(/\S/, ...) rather
//     than a transform so the generated JSON Schema stays
//     representable for MCP clients (transforms have no direct
//     JSON-schema representation).
//
//   - lockCommand: hard-coded to "viberevert mcp start_session" so
//     D22 concurrent-operation refusal copy truthfully identifies
//     the MCP origin without leaking raw MCP argument bytes into
//     lock metadata (per the operation's locked JSDoc).
//
//   - Error mapping (all 7 typed errors already in
//     MCP_ERROR_CODE_MAP via slice 3.2; no envelope.ts changes
//     needed for slice 3.6):
//       RepoRootNotFoundError     -> REPO_ROOT_NOT_FOUND
//       ConfigNotFoundError       -> CONFIG_NOT_FOUND
//       ConfigParseError          -> CONFIG_PARSE_FAILED
//       ConfigValidationError     -> CONFIG_VALIDATION_FAILED
//                                    + details.issues (snapshot)
//       RuntimeEnvInvalidError    -> RUNTIME_ENV_INVALID
//       SessionAlreadyActiveError -> SESSION_ALREADY_ACTIVE
//                                    + details.active (whitelist
//                                      serializer; no schema_version)
//       ConcurrentOperationError  -> CONCURRENT_OPERATION
//                                    + details.lock (whitelist
//                                      serializer; info_available
//                                      discriminator for null info)
//     Unknown errors fall through to toErrorEnvelope Tier 3 ->
//     INTERNAL_ERROR.
//
// Details serializers are EXPLICIT WHITELISTS (not blind spread).
// A future field added to ActiveSessionLock or LockInfo will NOT
// silently leak into the MCP wire surface -- adding it requires
// updating the corresponding serializer here.
//
// Output snapshot ownership: result fields are all primitive
// strings (sessionId / checkpointId / startedAt). No arrays or
// objects to snapshot.
//
// SDK-free: no @modelcontextprotocol/sdk import.

import { ConcurrentOperationError, startSessionOperation } from "@viberevert/cli-commands";
import { ConfigValidationError, SessionAlreadyActiveError } from "@viberevert/core";
import { z } from "zod";

import { type ToolEnvelope, toErrorEnvelope, toInvalidToolInputEnvelope } from "../envelope.js";
import type { JsonSchemaObject, ToolDefinition, ToolHandler } from "../tools.js";

// ============================================================================
// Input schema (strict; task is optional and must contain non-whitespace)
// ============================================================================

const startSessionInputSchema = z
  .object({
    task: z
      .string()
      .regex(/\S/, {
        message: "task must not be empty or whitespace-only",
      })
      .optional(),
  })
  .strict();

// ============================================================================
// Output data shape (D99.Q row 6)
// ============================================================================

type StartSessionResult = Awaited<ReturnType<typeof startSessionOperation>>;

export type StartSessionData = {
  readonly session_id: StartSessionResult["sessionId"];
  readonly checkpoint_id: StartSessionResult["checkpointId"];
  readonly started_at: StartSessionResult["startedAt"];
};

// ============================================================================
// Helpers (module-private)
// ============================================================================

/**
 * Safe object-spread base for merging extra details into a
 * toErrorEnvelope-produced envelope. Treats arrays as non-objects to
 * avoid spreading an array's numeric keys into the object envelope.
 * Mirrors the pattern locked in slice 3.5's get-policy handler.
 */
function objectDetails(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

/**
 * Whitelist serializer for SessionAlreadyActiveError's `.active`
 * field. Surfaces only user-actionable D11 refusal-copy fields;
 * skips schema_version (plumbing). Conditionally emits task only
 * when set (it's optional on ActiveSessionLock).
 *
 * The whitelist is intentional -- a future field added to
 * ActiveSessionLockSchema (in @viberevert/session-format) will NOT
 * silently leak into the MCP wire surface. Adding it requires
 * updating this serializer.
 */
function activeDetails(active: SessionAlreadyActiveError["active"]): Record<string, unknown> {
  return {
    session_id: active.session_id,
    checkpoint_id: active.checkpoint_id,
    started_at: active.started_at,
    ...(active.task !== undefined ? { task: active.task } : {}),
  };
}

/**
 * Whitelist serializer for ConcurrentOperationError's lock-state
 * exposure. Surfaces `lock_dir` (already in the error message text,
 * user-actionable for stale-lock diagnosis) and `info_available`
 * (discriminator -- err.info can be null when lock metadata is
 * missing/malformed). When info is present, surfaces the 4 LockInfo
 * fields (pid, command, started_at, host).
 *
 * The internal class property is named `info`; the MCP wire key is
 * `lock` (per slice 3.6 locked direction). The discriminator gives
 * consumers a stable programmatic branch instead of forcing them to
 * parse the error message text.
 */
function lockDetails(err: ConcurrentOperationError): Record<string, unknown> {
  if (err.info === null) {
    return { lock_dir: err.lockDir, info_available: false };
  }
  return {
    lock_dir: err.lockDir,
    info_available: true,
    pid: err.info.pid,
    command: err.info.command,
    started_at: err.info.started_at,
    host: err.info.host,
  };
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

// ============================================================================
// Public surface (D99.G: exactly `definition` + `handler`)
// ============================================================================

export const definition: ToolDefinition<"start_session"> = {
  name: "start_session",
  description:
    "Start a new VibeRevert session: create the inner checkpoint, capture pre-session " +
    "git status, and acquire the active-session lock. Returns the new session id, " +
    "checkpoint id, and start timestamp. Side-effecting (class B per D99.V); writes " +
    "session state and uses the D22 start lock during execution.",
  inputSchema: z.toJSONSchema(startSessionInputSchema, { target: "draft-7" }) as JsonSchemaObject,
};

export const handler: ToolHandler<StartSessionData> = async (
  input,
  context,
): Promise<ToolEnvelope<StartSessionData>> => {
  const parsed = startSessionInputSchema.safeParse(input);
  if (!parsed.success) {
    return toInvalidToolInputEnvelope("start_session", parsed.error);
  }

  // Normalize task AFTER parsing -- the schema's /\S/ pattern
  // guarantees at least one non-whitespace character, but the raw
  // value may still carry leading/trailing whitespace. Trim here so
  // persisted session metadata stays clean. Done in the handler
  // rather than via Zod .transform() so the schema generated for
  // definition.inputSchema remains JSON-schema-representable.
  const task = parsed.data.task?.trim();

  try {
    // Build operation opts. Omit `task` key entirely when absent so
    // the field is undefined on the resulting object (cleaner TS
    // than passing `task: undefined`). lockCommand is a fixed
    // literal -- never templated with the raw task -- so D22 lock
    // metadata cannot carry user input bytes.
    const result = await startSessionOperation({
      cwd: context.repoRoot,
      lockCommand: "viberevert mcp start_session",
      ...(task !== undefined ? { task } : {}),
    });
    return {
      ok: true,
      data: {
        session_id: result.sessionId,
        checkpoint_id: result.checkpointId,
        started_at: result.startedAt,
      },
    };
  } catch (err) {
    // Per slice 3.6 locked direction: surface conflict-class details
    // via explicit WHITELIST serializers. Each branch produces a
    // toErrorEnvelope base shape (sanitized code+message) augmented
    // with stable MCP wire keys (`active`, `lock`, `issues`).
    if (err instanceof SessionAlreadyActiveError) {
      return augmentEnvelope(err, { active: activeDetails(err.active) });
    }
    if (err instanceof ConcurrentOperationError) {
      return augmentEnvelope(err, { lock: lockDetails(err) });
    }
    if (err instanceof ConfigValidationError) {
      return augmentEnvelope(err, { issues: [...err.issues] });
    }
    // Everything else -- typed (RepoRootNotFound/ConfigNotFound/
    // ConfigParse/RuntimeEnvInvalid) and unknown (Tier 3 INTERNAL_ERROR)
    // -- through toErrorEnvelope unchanged.
    return toErrorEnvelope(err);
  }
};
