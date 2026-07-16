// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { type CommandsPolicyConfig, evaluateCommandPolicy } from "../command-guard.js";
import { createInstalledInterceptionHandle } from "./pty-interception.js";
import type { AuditAcceptedCommand } from "./pty-interception-audit.js";
import { generateBashInterceptionHook } from "./pty-interception-hook.js";
import { materializeBashHook } from "./pty-interception-hook-materializer.js";
import type {
  InstallBashInterceptionDeps,
  InterceptionInstallDiagnostic,
} from "./pty-interception-installer.js";
import {
  type AuditGateFailureReason,
  createInterceptionService,
} from "./pty-interception-service.js";
import { createLoopbackInterceptionTransport } from "./pty-interception-transport.js";
import type { ShellKind } from "./shell-resolver.js";

/**
 * The 4e-iii REAL BINDINGS: `createBashInterceptionInstallerDeps(...)` -> the
 * installer's (4e-i) `InstallBashInterceptionDeps`, wiring the real crypto nonce,
 * loopback transport (4b), interception service (4b), hook generator (4d), hook
 * materializer (4e-ii), and -- crucially -- the branded-handle factory (4a). This
 * is the SOLE production module that imports `createInstalledInterceptionHandle`
 * (a 4g source-level invariant confines that import to this module + tests).
 *
 * Production CONFIGURATION (the resolved shell + the exact session policy snapshot
 * + an optional sanitized diagnostic sink) is kept SEPARATE from the primitive
 * SEAM: the public factory calls an `@internal` helper with a fixed, frozen
 * REAL_BINDINGS table; the helper exists only so tests can inject fakes and verify
 * the wiring. 4e-iv (and any production caller) uses ONLY the public factory and
 * can neither re-inject primitives nor override the branded factory. This layer
 * adds NO validation -- the installer (4e-i) is the single fail-closed authority
 * over shell/config/dependency values.
 */

/** Public production configuration (supplied by the engine, 4e-iv). */
export interface CreateBashInterceptionInstallerDepsArgs {
  /** The resolved shell -- only path + kind are used; the resolver's args are discarded. */
  readonly shell: { readonly path: string; readonly kind: ShellKind };
  /** The exact validated policy snapshot from session-open (passed through by identity). */
  readonly commandsPolicy: CommandsPolicyConfig | undefined;
  /**
   * The session-backed accepted-command audit gate (Step 5c), passed through by
   * IDENTITY. Required: only the session can re-check its own ownership and
   * append, so this layer never invents or wraps one.
   */
  readonly auditAcceptedCommand: AuditAcceptedCommand;
  /** Best-effort SYNCHRONOUS audit-gate failure sink, passed through by identity. */
  readonly recordAuditGateFailure: (reason: AuditGateFailureReason) => void;
  /** Optional sanitized diagnostic sink, passed through unchanged (never invented here). */
  readonly reportDiagnostic?: (diagnostic: InterceptionInstallDiagnostic) => void;
}

/**
 * @internal Test seam: the injectable primitive table. Production callers use
 * `createBashInterceptionInstallerDeps`, which passes the frozen REAL_BINDINGS.
 */
export interface BashInterceptionInstallerBindings {
  readonly randomBytes: (size: number) => Buffer;
  readonly createTransport: typeof createLoopbackInterceptionTransport;
  readonly generateHook: typeof generateBashInterceptionHook;
  readonly createService: typeof createInterceptionService;
  readonly materializeHook: typeof materializeBashHook;
  readonly createHandle: typeof createInstalledInterceptionHandle;
}

/** Nonce entropy: 24 bytes -> exactly 32 base64url chars (192 bits). */
const NONCE_BYTES = 24;

const REAL_BINDINGS: BashInterceptionInstallerBindings = Object.freeze({
  randomBytes,
  createTransport: createLoopbackInterceptionTransport,
  generateHook: generateBashInterceptionHook,
  createService: createInterceptionService,
  materializeHook: materializeBashHook,
  createHandle: createInstalledInterceptionHandle,
});

/**
 * @internal Test seam: build the installer deps from an injected binding table.
 * Every binding AND every config arg is CAPTURED ONCE before any closure/object is
 * built, so a later mutation (or getter-backed re-read) cannot re-target an
 * implementation or change a value. Bindings are wired DIRECTLY (so a production
 * dep compares `===` the real function) EXCEPT `createService` (wrapped async: the
 * (B) readiness boundary over the sync 4b factory) and `generateNonce`
 * (constructed). The returned deps object and its copied shell are frozen;
 * `commandsPolicy` is passed through by identity (never cloned/frozen -- it must
 * remain the exact validated session snapshot); `reportDiagnostic` is OMITTED when
 * absent (never present as explicit undefined). No validation here.
 */
export function createBashInterceptionInstallerDepsWithBindings(
  args: CreateBashInterceptionInstallerDepsArgs,
  bindings: BashInterceptionInstallerBindings,
): InstallBashInterceptionDeps {
  const {
    randomBytes: generateRandomBytes,
    createTransport,
    generateHook,
    createService,
    materializeHook,
    createHandle,
  } = bindings;

  const inputShell = args.shell;
  const shellPath = inputShell.path;
  const shellKind = inputShell.kind;
  const commandsPolicy = args.commandsPolicy;
  const auditAcceptedCommand = args.auditAcceptedCommand;
  const recordAuditGateFailure = args.recordAuditGateFailure;
  const reportDiagnostic = args.reportDiagnostic;

  const generateNonce = (): string => generateRandomBytes(NONCE_BYTES).toString("base64url");

  const shell = Object.freeze({ path: shellPath, kind: shellKind });

  const deps: InstallBashInterceptionDeps = {
    shell,
    commandsPolicy,
    evaluateCommandPolicy,
    auditAcceptedCommand,
    recordAuditGateFailure,
    generateNonce,
    createTransport,
    generateHook,
    createService: async (transport, serviceDeps) => createService(transport, serviceDeps),
    materializeHook,
    createHandle,
    ...(reportDiagnostic !== undefined ? { reportDiagnostic } : {}),
  };
  return Object.freeze(deps);
}

/**
 * Build the real installer dependencies. The engine (4e-iv) supplies the resolved
 * shell ({path, kind} only -- the resolver's `args` are DISCARDED; the guarded
 * startup `--noprofile --rcfile <rc> -i` is minted solely inside the installed
 * handle) and the exact session policy snapshot.
 */
export function createBashInterceptionInstallerDeps(
  args: CreateBashInterceptionInstallerDepsArgs,
): InstallBashInterceptionDeps {
  return createBashInterceptionInstallerDepsWithBindings(args, REAL_BINDINGS);
}
