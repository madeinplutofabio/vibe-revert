// packages/cli-commands/test/live-pty-accounting.ts
// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M H7 Step 2.4: the live-PTY skip-accounting layer. accountLivePtyHost applies
// the manifest's per-platform policy to an ALREADY-resolved host result and is
// the single policy boundary for every live-PTY suite:
//   - run       -> returns the live pty + bash path;
//   - skip      -> emits labelled, reason-coded evidence and calls ctx.skip()
//                  (which THROWS the Vitest skip signal -- never caught here);
//   - violation -> THROWS an Error, so a required proof that silently failed to
//                  run, or a skip for a non-permitted reason, turns the cell red.
// resolveAccountedLivePtyHost is the convenience wrapper over the shared
// resolver; a suite that keeps its own prerequisite probe (smoke) can instead
// build a LivePtyHostResult and call accountLivePtyHost directly. The policy is
// loaded from support.yml for the ACTUAL running host and never injected, so a
// suite cannot run under a different platform's policy. The suite groups are
// locked (LIVE_PTY_SUITE_GROUPS): a gate can only be routed under a registered
// group, and a focused test asserts the registry plus the on-disk suite files.

import { readFileSync } from "node:fs";

import type { TestContext } from "vitest";

import {
  decideLivePtyAccounting,
  type LivePtyHostOutcome,
  type LivePtyPlatform,
  type LivePtyPlatformPolicy,
  readLivePtyPlatformPolicy,
} from "../../../scripts/support-manifest-live-pty.js";
import { parseSupportManifest } from "../../../scripts/support-manifest-parser.js";
import type { PtyModule } from "../src/commands/pty-loader.js";
import { type LivePtyHostResult, resolveLivePtyHost } from "./live-pty-host.js";

// The complete set of live-PTY suite groups. A capability gate may only be routed
// under one of these (the LivePtySuiteGroup type rejects any other name at
// compile time, and accountLivePtyHost re-checks at runtime), and the focused
// accounting test locks this list AND asserts each group's suite file exists --
// so an entire live suite disappearing is caught.
export const LIVE_PTY_SUITE_GROUPS = [
  "shell-pty-live-smoke",
  "pty-interception-compound-live",
  "pty-interception-hook-live",
] as const;

export type LivePtySuiteGroup = (typeof LIVE_PTY_SUITE_GROUPS)[number];

export interface AccountedLivePtyRequest {
  readonly ctx: TestContext;
  readonly group: LivePtySuiteGroup;
  readonly label: string;
}

export interface LivePtyExecution {
  readonly pty: PtyModule;
  readonly bashPath: string;
}

const SUPPORT_MANIFEST_URL = new URL("../../../support.yml", import.meta.url);

// One stable seam for CI-visible skip evidence: raw process.stdout.write is
// emitted by `vitest run`, whereas console.log is intercepted by the runner and
// not shown. (Mirrors the per-suite reporters.)
function reportEvidence(message: string): void {
  process.stdout.write(`${message}\n`);
}

// Map the running host to a schema-v1 logical platform, failing closed on any
// platform the manifest does not model rather than silently mislabelling it.
function currentLivePtyPlatform(): LivePtyPlatform {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      throw new Error(
        `unsupported platform for live-PTY accounting: ${JSON.stringify(process.platform)}`,
      );
  }
}

let cachedPlatformPolicy: LivePtyPlatformPolicy | undefined;

/**
 * Load (once) the current host's live-PTY policy from the checked-in support.yml.
 * `??=` caches only a successfully parsed + validated policy: a parse / validation
 * throw leaves the cache empty, so the next call re-reads rather than memoizing a
 * failure.
 */
export function loadLivePtyPolicyForHost(): LivePtyPlatformPolicy {
  cachedPlatformPolicy ??= readLivePtyPlatformPolicy(
    parseSupportManifest(readFileSync(SUPPORT_MANIFEST_URL, "utf8")),
    currentLivePtyPlatform(),
  );
  return cachedPlatformPolicy;
}

/**
 * Apply the accounting policy to an ALREADY-resolved host result. Pure except for
 * reportEvidence + ctx.skip(). Returns the live execution on run; emits
 * reason-coded evidence and calls ctx.skip() (which throws the Vitest skip
 * signal) on a permitted skip; throws on any contract violation. The host-shape
 * guards are unreachable given decideLivePtyAccounting's contract (run only for a
 * capable host; skip only for an unavailable one); they exist so a future change
 * to the decision cannot silently mis-handle a host result.
 */
export function accountLivePtyHost(
  request: AccountedLivePtyRequest,
  host: LivePtyHostResult,
): LivePtyExecution {
  const { ctx, group, label } = request;
  if (!(LIVE_PTY_SUITE_GROUPS as readonly string[]).includes(group)) {
    throw new Error(`unknown live-PTY suite group: ${JSON.stringify(group)}`);
  }
  if (label.trim().length === 0) {
    throw new Error(`[${group}] live-PTY accounting label must be non-blank`);
  }
  const platformPolicy = loadLivePtyPolicyForHost();
  const outcome: LivePtyHostOutcome = host.ok
    ? { ok: true }
    : { ok: false, reasonCode: host.reasonCode };
  const verdict = decideLivePtyAccounting(platformPolicy, outcome);

  if (verdict.action === "violation") {
    throw new Error(`[${group}] ${label}: live-PTY accounting violation: ${verdict.message}`);
  }
  if (verdict.action === "skip") {
    if (host.ok) {
      throw new Error(`[${group}] ${label}: accounting permitted a skip for a capable host`);
    }
    reportEvidence(`[${group}] ${label} SKIP [${verdict.reasonCode}]: ${host.reason}`);
    ctx.skip();
  }
  if (!host.ok) {
    throw new Error(`[${group}] ${label}: accounting permitted a run for an unavailable host`);
  }
  return { pty: host.pty, bashPath: host.bashPath };
}

/** Resolve the shared host capability, then account for it. */
export async function resolveAccountedLivePtyHost(
  request: AccountedLivePtyRequest,
): Promise<LivePtyExecution> {
  return accountLivePtyHost(request, await resolveLivePtyHost());
}
