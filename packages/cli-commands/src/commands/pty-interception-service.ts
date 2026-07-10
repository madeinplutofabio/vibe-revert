// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Parent-side interception SERVICE -- pure DECISION CORE (M G4 Step 4b-i,
 * D104.E/H/J/O). This slice is I/O-FREE: the wire-envelope parser and the
 * security decision only. The private-channel transport (a nonce-bound
 * 127.0.0.1 loopback socket, design-approved) + the per-connection read timeout
 * land in 4b-ii; the bash hook in 4d.
 *
 * Stages kept explicit: wire bytes -> parse result -> parsed request ->
 * decision. `parseInterceptionRequest` validates ONLY the wire ENVELOPE (never
 * command semantics; never normalizing rawLine); `decideInterception` validates
 * the nonce VALUE and maps policy to allow/block. Every non-allow path fails
 * closed (D104.J).
 */

import type { CommandPolicyDecision, CommandsPolicyConfig } from "../command-guard.js";
import {
  type InterceptionDecision,
  type InterceptionDecisionBlockReason,
  type InterceptionRequest,
  PTY_INTERCEPTION_PROTOCOL_VERSION,
} from "./pty-interception.js";

/** Outcome of parsing untrusted wire bytes into a request envelope. */
export type ParseInterceptionRequestResult =
  | { readonly kind: "ok"; readonly request: InterceptionRequest }
  | { readonly kind: "malformed"; readonly reason: "malformed_request" };

/** True for a present, non-empty, non-whitespace string. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse untrusted wire bytes into an InterceptionRequest ENVELOPE, or a
 * `malformed` result. NEVER throws for hostile input. Validates ONLY the
 * envelope shape -- a non-array object, protocolVersion === 1, nonce/id non-blank
 * strings, rawLine a string (which MAY be empty) -- and normalizes NOTHING
 * (rawLine is preserved byte-for-byte; nonce/id kept as-is; extra fields are
 * ignored). Command semantics, the nonce VALUE, and policy are NOT checked here
 * (that is decideInterception).
 */
export function parseInterceptionRequest(raw: string): ParseInterceptionRequestResult {
  const malformed: ParseInterceptionRequestResult = {
    kind: "malformed",
    reason: "malformed_request",
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed;
  }

  // A non-array object only (reject null, arrays, and primitives).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed;
  }

  const obj = parsed as {
    protocolVersion?: unknown;
    nonce?: unknown;
    id?: unknown;
    rawLine?: unknown;
  };
  if (obj.protocolVersion !== PTY_INTERCEPTION_PROTOCOL_VERSION) {
    return malformed;
  }
  if (!isNonBlankString(obj.nonce) || !isNonBlankString(obj.id)) {
    return malformed;
  }
  if (typeof obj.rawLine !== "string") {
    return malformed;
  }

  // Preserve the original values (rawLine byte-for-byte; nonce/id kept as-is).
  return {
    kind: "ok",
    request: {
      protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
      nonce: obj.nonce,
      id: obj.id,
      rawLine: obj.rawLine,
    },
  };
}

/** Injected facts for the pure decision (all-or-none per call). */
export interface DecideInterceptionDeps {
  /** The session nonce the request's nonce must match. */
  readonly sessionNonce: string;
  /** The guard/confirm policy snapshotted at PTY-shell start. */
  readonly commandsPolicy: CommandsPolicyConfig | undefined;
  /** The shared guard evaluator (injected so the policy-error path is testable). */
  readonly evaluateCommandPolicy: (
    argv: readonly string[],
    policy: CommandsPolicyConfig | undefined,
  ) => CommandPolicyDecision;
}

/** Build a block decision echoing the request id (every block fails closed). */
function block(id: string, reason: InterceptionDecisionBlockReason): InterceptionDecision {
  return { protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION, id, kind: "block", reason };
}

/**
 * The security decision for one PARSED request (D104.J fail-closed). A nonce
 * mismatch -> block(nonce_mismatch) BEFORE any policy evaluation. Then the policy
 * seam is evaluated inside a try that ALSO covers the verdict switch, so ANY
 * misbehaviour -- a throw, a malformed/null return (reading `.kind` throws), or
 * an unknown/future decision kind -- fails closed as block(policy_error). A guard
 * OR require_confirm match -> block(blocked_by_policy) (PTY v1 has NO interactive
 * confirm); ONLY an explicit `allow` -> allow. Policy is evaluated against the
 * raw prompt line as a SINGLE synthetic argv `[rawLine]` (D104.H) -- no
 * tokenizing, splitting, or trimming. The decision echoes id + protocolVersion.
 */
export function decideInterception(
  request: InterceptionRequest,
  deps: DecideInterceptionDeps,
): InterceptionDecision {
  if (request.nonce !== deps.sessionNonce) {
    return block(request.id, "nonce_mismatch");
  }

  try {
    const decision = deps.evaluateCommandPolicy([request.rawLine], deps.commandsPolicy);
    switch (decision.kind) {
      case "guard":
      case "confirm":
        return block(request.id, "blocked_by_policy");
      case "allow":
        return {
          protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
          id: request.id,
          kind: "allow",
        };
      default:
        return block(request.id, "policy_error");
    }
  } catch {
    return block(request.id, "policy_error");
  }
}
