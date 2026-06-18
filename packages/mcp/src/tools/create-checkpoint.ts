// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// create_checkpoint MCP tool: typed-operation backend.
//
// Per D99.E + D99.Q row 7 + D99.V:
//
//   - Backend: typed-operation. Calls
//     @viberevert/cli-commands's createCheckpointOperation (extracted
//     in M G1a Step 1) which owns all checkpoint-creation domain
//     logic: repo-root resolution, config load (D19 -- rollback.exclude
//     drives D3 capture symmetry), optional D22 name-uniqueness lock
//     (only when `name` is supplied), git.createCheckpoint, atomic
//     rename to final cp_<id>/, D13 cleanup-on-failure.
//
//   - Returns the new checkpoint id and creation timestamp.
//
//   - Side-effect class: B (writes a checkpoint directory under
//     .viberevert/checkpoints/; uses the D22 name lock when `name` is
//     supplied; the atomic outer rename is the durability boundary).
//     NOT wrapped in withTimeout per D99.V -- racing a side-effecting
//     tool without cancellation tokens would destroy audit truth.
//
//   - Input fields: { name? }. No `message` field -- the underlying
//     operation does NOT accept a message parameter (see
//     operations/create-checkpoint.ts header: adding `message?` here
//     would create a lying contract). Empty input is valid
//     (nameless checkpoint). When present, `name` MUST:
//       - contain at least one non-whitespace character,
//       - be at most MAX_CREATE_CHECKPOINT_NAME_LEN characters,
//       - contain NO ASCII control characters (0x00-0x1F or 0x7F).
//     The MCP Zod schema is the SOLE GATEKEEPER for all three rules
//     -- the operation does not re-validate. `name` is persisted into
//     checkpoint manifest metadata; the length cap prevents bloating
//     every manifest read, and the control-char ban prevents poisoning
//     terminal listings (`viberevert checkpoint --list`) and NDJSON-
//     adjacent contexts (audit log). /\S/ alone does NOT cover the
//     control-char case -- NUL is non-whitespace and would slip
//     through, so the control-char regex runs as an explicit pre-check.
//     The handler then trims the parsed name before passing it to the
//     operation so persisted checkpoint metadata never carries
//     accidental leading/trailing whitespace. The schema uses
//     .regex(...) rather than a transform so the generated JSON
//     Schema stays representable for MCP clients (transforms have no
//     direct JSON-schema representation).
//
//   - lockCommand: hard-coded to "viberevert mcp create_checkpoint"
//     so D22 concurrent-operation refusal copy truthfully identifies
//     the MCP origin without leaking raw MCP argument bytes into
//     lock metadata. Only used by the operation when `name` is
//     supplied (nameless checkpoints skip the D22 lock entirely per
//     D5b lock #4).
//
//   - Error mapping (all typed errors already in MCP_ERROR_CODE_MAP
//     via the slice 3.2 contract layer; no envelope.ts changes
//     needed for slice 3.7):
//       RepoRootNotFoundError         -> REPO_ROOT_NOT_FOUND
//       ConfigNotFoundError           -> CONFIG_NOT_FOUND
//       ConfigParseError              -> CONFIG_PARSE_FAILED
//       ConfigValidationError         -> CONFIG_VALIDATION_FAILED
//                                        + details.issues (snapshot)
//       RuntimeEnvInvalidError        -> RUNTIME_ENV_INVALID
//       ConcurrentOperationError      -> CONCURRENT_OPERATION
//                                        + details.lock (whitelist
//                                          serializer; info_available
//                                          discriminator for null info)
//       CheckpointNameCollisionError  -> CHECKPOINT_NAME_COLLISION
//                                        (R31-special-cased: emits a
//                                          GENERIC message and NO
//                                          details. The upstream
//                                          Error template interpolates
//                                          the raw user-supplied name
//                                          ("checkpoint name already
//                                          exists: ${name}"). Passing
//                                          it through toErrorEnvelope/
//                                          sanitizeMessage would leak
//                                          credential-shaped input
//                                          bytes via error.message
//                                          since sanitizeMessage only
//                                          strips control chars + caps
//                                          length -- it does NOT
//                                          redact arbitrary embedded
//                                          substrings. This handler
//                                          bypasses toErrorEnvelope
//                                          for this one class and
//                                          emits a generic
//                                          information-equivalent
//                                          message -- the stable code
//                                          carries the semantic
//                                          refusal so clients lose no
//                                          actionable information,
//                                          but NO field of the
//                                          envelope echoes user-
//                                          supplied bytes.)
//       CreateCheckpointListLoadError -> CHECKPOINT_LIST_LOAD_FAILED
//                                        (no details -- the wrapped
//                                          cause is internal; the
//                                          sanitized error.message is
//                                          enough for diagnosis. Safe
//                                          to pass through
//                                          toErrorEnvelope because the
//                                          message template is
//                                          formatCause(internal fs/
//                                          scan error), NOT raw user
//                                          input.)
//     Unknown errors fall through to toErrorEnvelope Tier 3 ->
//     INTERNAL_ERROR.
//
// Details serializers are EXPLICIT WHITELISTS (not blind spread).
// A future field added to LockInfo will NOT silently leak into the
// MCP wire surface -- adding it requires updating lockDetails here.
//
// Output snapshot ownership: result fields are all primitive
// strings (checkpointId / createdAt). No arrays or objects to
// snapshot.
//
// SDK-free: no @modelcontextprotocol/sdk import.

import {
  CheckpointNameCollisionError,
  ConcurrentOperationError,
  createCheckpointOperation,
} from "@viberevert/cli-commands";
import { ConfigValidationError } from "@viberevert/core";
import { z } from "zod";

import { type ToolEnvelope, toErrorEnvelope, toInvalidToolInputEnvelope } from "../envelope.js";
import type { JsonSchemaObject, ToolDefinition, ToolHandler } from "../tools.js";

// ============================================================================
// Length cap on `name` (persisted to checkpoint manifest metadata)
// ============================================================================

/**
 * Hard cap on the `name` field. `name` is persisted into every
 * checkpoint manifest under .viberevert/checkpoints/cp_<id>/. Without
 * a length cap, an attacker could submit a multi-MB name and bloat
 * every subsequent manifest read (checkpoint list, rollback resolve,
 * etc.). 128 characters is generous for human-readable labels like
 * "before refactor" while staying well clear of pathological inputs.
 * String-length cap, not byte-length.
 */
const MAX_CREATE_CHECKPOINT_NAME_LEN = 128;

// ============================================================================
// Input schema (strict; name is optional, bounded, control-char-clean,
// and contains non-whitespace)
// ============================================================================

const createCheckpointInputSchema = z
  .object({
    name: z
      .string()
      .max(MAX_CREATE_CHECKPOINT_NAME_LEN, {
        message: `name must be at most ${MAX_CREATE_CHECKPOINT_NAME_LEN} characters`,
      })
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional R31 / persistence-safety check -- reject ASCII control bytes (0x00-0x1F + 0x7F) in checkpoint names so manifest metadata cannot carry NUL, escape sequences, or framing chars that would poison terminal listings and NDJSON-adjacent contexts. /\S/ alone does NOT cover this: NUL is non-whitespace.
      .regex(/^[^\x00-\x1F\x7F]*$/, {
        message: "name must not contain control characters",
      })
      .regex(/\S/, {
        message: "name must not be empty or whitespace-only",
      })
      .optional(),
  })
  .strict();

// ============================================================================
// Output data shape (D99.Q row 7)
// ============================================================================

type CreateCheckpointResult = Awaited<ReturnType<typeof createCheckpointOperation>>;

export type CreateCheckpointData = {
  readonly checkpoint_id: CreateCheckpointResult["checkpointId"];
  readonly created_at: CreateCheckpointResult["createdAt"];
};

// ============================================================================
// Helpers (module-private)
// ============================================================================

/**
 * Safe object-spread base for merging extra details into a
 * toErrorEnvelope-produced envelope. Treats arrays as non-objects to
 * avoid spreading an array's numeric keys into the object envelope.
 * Mirrors the pattern locked in slice 3.5/3.6's get-policy +
 * start-session handlers.
 */
function objectDetails(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

/**
 * Whitelist serializer for ConcurrentOperationError's lock-state
 * exposure. Identical-by-contract to start-session's lockDetails: the
 * D22 lock surface is uniform across both operations, so a future
 * change to LockInfo's wire shape MUST update both serializers
 * together (architectural drift caught by the per-tool tests, which
 * pin both shapes independently).
 *
 * Surfaces `lock_dir` (already in the error message text, user-
 * actionable for stale-lock diagnosis) and `info_available`
 * (discriminator -- err.info can be null when lock metadata is
 * missing/malformed). When info is present, surfaces the 4 LockInfo
 * fields (pid, command, started_at, host).
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
 * objectDetails() prevents an array `details` from spreading numeric
 * keys.
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

export const definition: ToolDefinition<"create_checkpoint"> = {
  name: "create_checkpoint",
  description:
    "Create a standalone VibeRevert checkpoint capturing the current working tree state. " +
    "Returns the new checkpoint id and creation timestamp. Side-effecting (class B per " +
    "D99.V); writes a checkpoint directory under .viberevert/checkpoints/. When `name` is " +
    "supplied, uses the D22 name-uniqueness lock; nameless checkpoints skip the lock " +
    "entirely.",
  inputSchema: z.toJSONSchema(createCheckpointInputSchema, {
    target: "draft-7",
  }) as JsonSchemaObject,
};

export const handler: ToolHandler<CreateCheckpointData> = async (
  input,
  context,
): Promise<ToolEnvelope<CreateCheckpointData>> => {
  const parsed = createCheckpointInputSchema.safeParse(input);
  if (!parsed.success) {
    return toInvalidToolInputEnvelope("create_checkpoint", parsed.error);
  }

  // Normalize name AFTER parsing -- the schema's /\S/ pattern
  // guarantees at least one non-whitespace character, but the raw
  // value may still carry leading/trailing whitespace. Trim here so
  // persisted checkpoint metadata stays clean. Done in the handler
  // rather than via Zod .transform() so the schema generated for
  // definition.inputSchema remains JSON-schema-representable.
  const name = parsed.data.name?.trim();

  try {
    // Build operation opts. Omit `name` key entirely when absent so
    // the field is undefined on the resulting object (cleaner TS
    // than passing `name: undefined`). lockCommand is a fixed
    // literal -- never templated with the raw name -- so D22 lock
    // metadata cannot carry user input bytes.
    const result = await createCheckpointOperation({
      cwd: context.repoRoot,
      lockCommand: "viberevert mcp create_checkpoint",
      ...(name !== undefined ? { name } : {}),
    });
    return {
      ok: true,
      data: {
        checkpoint_id: result.checkpointId,
        created_at: result.createdAt,
      },
    };
  } catch (err) {
    // Per slice 3.6 locked direction: surface conflict-class details
    // via explicit WHITELIST serializers. Each branch produces a
    // toErrorEnvelope base shape (sanitized code+message) augmented
    // with stable MCP wire keys (`lock`, `issues`).
    //
    // CheckpointNameCollisionError is special-cased to bypass
    // toErrorEnvelope entirely: the upstream Error.message template
    // interpolates the raw user-supplied checkpoint name
    // (`checkpoint name already exists: ${name}`), so passing it
    // through sanitizeMessage would leak credential-shaped input
    // bytes via error.message (sanitizeMessage only strips control
    // chars + caps length -- it does NOT redact arbitrary embedded
    // substrings). Emitting a generic message keeps the contract
    // information-equivalent (the stable code carries the semantic
    // refusal so clients still know to prompt for a different
    // name) while ensuring NO field of the envelope echoes the
    // user-supplied bytes. R31 surface eliminated for this code
    // path; details remains undefined for the same reason.
    //
    // CreateCheckpointListLoadError flows through toErrorEnvelope
    // unchanged -- its message is formatCause(opts.cause) where
    // cause is an internal filesystem/scan error (NOT raw user
    // input), so passing it through sanitizeMessage is safe.
    if (err instanceof CheckpointNameCollisionError) {
      return {
        ok: false,
        error: {
          code: "CHECKPOINT_NAME_COLLISION",
          message: "checkpoint name already exists",
        },
      };
    }
    if (err instanceof ConcurrentOperationError) {
      return augmentEnvelope(err, { lock: lockDetails(err) });
    }
    if (err instanceof ConfigValidationError) {
      return augmentEnvelope(err, { issues: [...err.issues] });
    }
    return toErrorEnvelope(err);
  }
};
