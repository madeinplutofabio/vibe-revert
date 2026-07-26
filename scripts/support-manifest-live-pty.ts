// scripts/support-manifest-live-pty.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.4: the pure live-PTY accounting policy seam. Two responsibilities,
// both pure (no I/O, no PTY, no Vitest), so the live-suite gates and the focused
// accounting test share ONE decision instead of re-deriving the contract:
//   - readLivePtyPlatformPolicy: extract a logical platform's declared live-PTY
//     disposition (+ the single permitted skip reason code) from a parsed
//     support.yml, verifying the reason code is declared in reason_codes;
//   - decideLivePtyAccounting: given that policy and the host's capability
//     outcome, decide run / permitted-skip / contract-violation.
//
// The contract (the feature disposition each profile.live_pty_validation agrees
// with, enforced in support-manifest-core):
//   - exercised (required):  ANY unavailable outcome is a violation;
//   - capability_gated:      run, or skip ONLY with the declared reason code;
//   - not_applicable:        skip ONLY with the declared reason code, and a
//                            capable host is itself a violation.
// The runtime outcome space is deliberately WIDER than the permitted skip codes:
// a macOS node-pty load failure (node_pty_unavailable) is not the platform's
// permitted code (pty_allocation_unavailable), so it is a violation, not a benign
// skip. Only a genuine allocation failure is a permitted macOS skip.

export type LivePtyPlatform = "linux" | "macos" | "windows";

export type LivePtyDisposition = "exercised" | "capability_gated" | "not_applicable";

// The runtime capability outcome space -- wider than the manifest's reason_codes
// registry (which declares only the PERMITTED skip codes): a host can fail for
// reasons that are never a permitted skip (e.g. a missing node-pty binding).
export type LivePtyReasonCode =
  | "pty_allocation_unavailable"
  | "requires_posix_bash"
  | "node_pty_unavailable"
  | "bash_unavailable";

// Impossible states are unrepresentable: `exercised` has no permitted skip code;
// a gated / not-applicable platform always carries exactly one.
export type LivePtyPlatformPolicy =
  | {
      readonly platform: LivePtyPlatform;
      readonly disposition: "exercised";
      readonly permittedReasonCode: null;
    }
  | {
      readonly platform: LivePtyPlatform;
      readonly disposition: "capability_gated" | "not_applicable";
      readonly permittedReasonCode: LivePtyReasonCode;
    };

export type LivePtyHostOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: LivePtyReasonCode };

export type LivePtyVerdict =
  | { readonly action: "run" }
  | { readonly action: "skip"; readonly reasonCode: LivePtyReasonCode }
  | { readonly action: "violation"; readonly message: string };

const DISPOSITIONS: ReadonlySet<string> = new Set<LivePtyDisposition>([
  "exercised",
  "capability_gated",
  "not_applicable",
]);
const REASON_CODES: ReadonlySet<string> = new Set<LivePtyReasonCode>([
  "pty_allocation_unavailable",
  "requires_posix_bash",
  "node_pty_unavailable",
  "bash_unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProp(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = readProp(current, key);
  }
  return current;
}

function isDisposition(value: unknown): value is LivePtyDisposition {
  return typeof value === "string" && DISPOSITIONS.has(value);
}

function isReasonCode(value: unknown): value is LivePtyReasonCode {
  return typeof value === "string" && REASON_CODES.has(value);
}

/**
 * Extract the live-PTY policy for one logical platform from a parsed manifest.
 * Throws on a structurally invalid declaration -- the manifest is already gated
 * by support-manifest-core, so a failure here means the test was pointed at a
 * manifest that never passed validation (fail closed, never a benign default).
 * A referenced reason_code must be BOTH a known runtime code AND declared in the
 * manifest's reason_codes registry: `node_pty_unavailable` is a runtime code but
 * intentionally not a permitted, registered skip code.
 */
export function readLivePtyPlatformPolicy(
  manifest: unknown,
  platform: LivePtyPlatform,
): LivePtyPlatformPolicy {
  const entry = readPath(manifest, ["features", "live_pty_interception", "platforms", platform]);
  if (!isRecord(entry)) {
    throw new Error(
      `support.yml has no live_pty_interception disposition for platform ${JSON.stringify(platform)}`,
    );
  }
  const disposition = readProp(entry, "disposition");
  if (!isDisposition(disposition)) {
    throw new Error(
      `invalid live_pty_interception disposition for ${platform}: ${JSON.stringify(disposition)}`,
    );
  }
  const rawReason = readProp(entry, "reason_code");
  if (disposition === "exercised") {
    if (rawReason !== undefined) {
      throw new Error(`exercised platform ${platform} must not declare a reason_code`);
    }
    return { platform, disposition, permittedReasonCode: null };
  }
  if (!isReasonCode(rawReason)) {
    throw new Error(
      `platform ${platform} (${disposition}) must declare a known reason_code, got ${JSON.stringify(rawReason)}`,
    );
  }
  const reasonDefinition = readPath(manifest, ["reason_codes", rawReason]);
  if (!isRecord(reasonDefinition)) {
    throw new Error(
      `platform ${platform} references undeclared reason_code ${JSON.stringify(rawReason)}`,
    );
  }
  return { platform, disposition, permittedReasonCode: rawReason };
}

/**
 * The pure accounting decision. `run` when execution is contract-permitted;
 * `skip` when the host is unavailable for the platform's single permitted reason
 * code; `violation` otherwise -- a required platform that could not run, a gated
 * / not-applicable skip for a non-permitted reason, or a not-applicable platform
 * that was unexpectedly capable.
 */
export function decideLivePtyAccounting(
  policy: LivePtyPlatformPolicy,
  outcome: LivePtyHostOutcome,
): LivePtyVerdict {
  if (outcome.ok) {
    if (policy.disposition === "not_applicable") {
      return {
        action: "violation",
        message: `platform ${policy.platform} is declared not_applicable but the host is live-PTY capable`,
      };
    }
    return { action: "run" };
  }
  if (policy.disposition === "exercised") {
    return {
      action: "violation",
      message: `required live-PTY validation for ${policy.platform} is unavailable (${outcome.reasonCode})`,
    };
  }
  if (outcome.reasonCode === policy.permittedReasonCode) {
    return { action: "skip", reasonCode: outcome.reasonCode };
  }
  return {
    action: "violation",
    message: `platform ${policy.platform} (${policy.disposition}) permits a skip only for ${policy.permittedReasonCode}, but the host was unavailable for ${outcome.reasonCode}`,
  };
}
