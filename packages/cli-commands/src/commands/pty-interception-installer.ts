// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import type { CommandPolicyDecision, CommandsPolicyConfig } from "../command-guard.js";
import type {
  InstalledInterception,
  InterceptionChannelRef,
  InterceptionInstallFailureReason,
  InterceptionShellStartup,
} from "./pty-interception.js";
import type { BashInterceptionHookParams } from "./pty-interception-hook.js";
import type {
  InterceptionService,
  InterceptionServiceDeps,
  InterceptionServiceTransport,
} from "./pty-interception-service.js";
import { resolveInterceptionShellSupport } from "./pty-interception-shell-support.js";
import type { LoopbackInterceptionTransport } from "./pty-interception-transport.js";
import type { ShellKind } from "./shell-resolver.js";

/**
 * The bash interception INSTALLER (M G4 Step 4e-i, D104.E/H/J/O). Assembles the
 * parent-side channel (4b) + the hook (4d), behind the shell-support gate (4c),
 * into one branded `InstalledInterception` handle -- the SOLE way the engine
 * (4e-iv) obtains a guarded-shell spawn spec. Fully INJECTED (no real net/fs/
 * spawn here) so the orchestration -- acquire in order, fail closed, and tear
 * down every acquired resource in the fixed lifecycle order -- is unit-testable
 * with fakes; the real bindings are 4e-iii.
 *
 * Fail-closed + hostile-dependency-resistant by construction, and it NEVER
 * throws. Two-phase snapshotting keeps the capability gate authoritative and
 * FIRST: phase 1 captures ONLY the shell object + its KIND (behind a fail-closed
 * boundary -- exactly what the gate needs) and runs the gate, so an UNSUPPORTED
 * shell returns `unsupported_shell` WITHOUT reading the executable path or any
 * non-shell dependency. Only a supported shell reads + validates the executable
 * path, then snapshots policy/callbacks/factories/sink (again fail-closed). A
 * null/forged shell, a non-string kind, a blank/throwing executable, a
 * non-function callback, or a throwing getter yields a sanitized refusal from
 * `dependency_setup_failed` -- and, since no sink can be safely captured in that
 * case, without attempting diagnostics.
 *
 * Every step's failure returns NO handle; a SINGLE memoized, best-effort disposer
 * serves BOTH partial-failure rollback AND successful-install teardown, so
 * acquisition changes cannot desync the two. Captured inputs are read ONCE, each
 * validated value (channel endpoint, rc path) is read ONCE, and each cleanup
 * operation is BOUND at acquisition with its resource registered BEFORE the
 * resource's metadata is validated -- so a getter-backed or mutated dependency
 * cannot change which implementation/value participates, and a live-but-malformed
 * resource is torn down rather than leaked. The public result carries only a
 * coarse (4a-contract) reason + a sanitized message; the fine-grained internal
 * cause is reported ONLY to an optional best-effort diagnostic sink -- never a raw
 * exception, filesystem path, nonce, or port.
 */

/** Fine-grained INTERNAL diagnostic cause (never leaked into the public result). */
export type BashInterceptionInstallFailureCause =
  | "unsupported_shell"
  | "dependency_setup_failed"
  | "nonce_setup_failed"
  | "channel_setup_failed"
  | "service_setup_failed"
  | "hook_setup_failed"
  | "materialization_failed"
  | "handle_setup_failed";

/** Setup causes reachable via the generic `fail` helper (unsupported is built inline). */
type SetupFailureCause = Exclude<BashInterceptionInstallFailureCause, "unsupported_shell">;

/**
 * Map an internal cause DOWN to the 4a-contract public reason. Exhaustive (no
 * `default`), so adding a cause without deciding its public mapping fails to
 * typecheck rather than silently defaulting to the wrong reason.
 */
export function publicReasonFor(
  cause: BashInterceptionInstallFailureCause,
): InterceptionInstallFailureReason {
  switch (cause) {
    case "unsupported_shell":
      return "unsupported_shell";
    case "dependency_setup_failed":
    case "nonce_setup_failed":
    case "channel_setup_failed":
    case "service_setup_failed":
      return "channel_setup_failed";
    case "hook_setup_failed":
    case "materialization_failed":
    case "handle_setup_failed":
      return "hook_setup_failed";
  }
}

/** The materialized hook rc file (4e-ii implements): its path + best-effort cleanup. */
export interface MaterializedInterceptionHook {
  readonly rcPath: string;
  readonly cleanup: () => Promise<void>;
}

/** A sanitized diagnostic record for internal observability (carries no secrets). */
export interface InterceptionInstallDiagnostic {
  readonly cause: BashInterceptionInstallFailureCause;
}

/** The install outcome: a branded handle + disposer, or a coarse fail-closed refusal. */
export type BashInterceptionInstallResult =
  | {
      readonly kind: "installed";
      readonly handle: InstalledInterception;
      readonly dispose: () => Promise<void>;
    }
  | {
      readonly kind: "install_failed";
      readonly reason: InterceptionInstallFailureReason;
      readonly message: string;
    };

/** The injected seam. ALL-OR-NONE fakes drive the orchestration in tests. */
export interface InstallBashInterceptionDeps {
  /** The resolved shell -- only its kind (gate) and path (executable) are used. */
  readonly shell: { readonly path: string; readonly kind: ShellKind };
  /** The exact validated policy snapshot from session-open (passed through unchanged). */
  readonly commandsPolicy: CommandsPolicyConfig | undefined;
  readonly evaluateCommandPolicy: (
    argv: readonly string[],
    policy: CommandsPolicyConfig | undefined,
  ) => CommandPolicyDecision;
  readonly generateNonce: () => string;
  readonly createTransport: () => Promise<LoopbackInterceptionTransport>;
  readonly generateHook: (params: BashInterceptionHookParams) => string;
  /** Awaited readiness boundary (B): resolves only when the service can receive. */
  readonly createService: (
    transport: InterceptionServiceTransport,
    deps: InterceptionServiceDeps,
  ) => Promise<InterceptionService>;
  readonly materializeHook: (hookScript: string) => Promise<MaterializedInterceptionHook>;
  /** The 4a branded-handle factory, injected so a fake can force handle_setup_failed. */
  readonly createHandle: (fields: {
    shellKind: "bash";
    nonce: string;
    channel: InterceptionChannelRef;
    shellStartup: InterceptionShellStartup;
  }) => InstalledInterception;
  /** Optional internal diagnostic sink; called best-effort (never alters the result). */
  readonly reportDiagnostic?: (diagnostic: InterceptionInstallDiagnostic) => void;
}

/** Phase-1: only what the capability gate needs (the path is read later, post-gate). */
type ShellGateSnapshot = {
  readonly shellKind: ShellKind;
  readonly shell: object;
};

/** Phase-2: the remaining validated dependencies (all callbacks confirmed functions). */
type DependencySnapshot = Omit<InstallBashInterceptionDeps, "shell" | "reportDiagnostic"> & {
  readonly reportDiagnostic: ((diagnostic: InterceptionInstallDiagnostic) => void) | undefined;
};

/** Nonce shape the hook + service both rely on (mirrors the 4d generator's guard). */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

const CHANNEL_SETUP_FAILED_MESSAGE =
  "viberevert shell --pty could not establish the private interception channel.\n" +
  "Use `viberevert shell` for the guarded command loop.";
const HOOK_SETUP_FAILED_MESSAGE =
  "viberevert shell --pty could not install the command interception hook.\n" +
  "Use `viberevert shell` for the guarded command loop.";

/** True for a non-null object (callers check for the specific members they need). */
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Read a property from an unknown value as `unknown` (absent/non-object -> undefined).
 * VARIABLE-key bracket read: the repo idiom that satisfies both tsc
 * `noPropertyAccessFromIndexSignature` (bracket OK) and biome `useLiteralKeys`
 * (variable key, not a literal). A property getter may throw -> the caller's try
 * classifies it; each call reads the property once.
 */
function readProp(value: unknown, key: PropertyKey): unknown {
  return isObject(value) ? (value as Record<PropertyKey, unknown>)[key] : undefined;
}

/** A non-blank string (used for the transport-opaque endpoint + the rc path). */
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A sanitized dependency-failure refusal (no diagnostics: the sink isn't safely captured). */
function dependencySetupFailure(): BashInterceptionInstallResult {
  return {
    kind: "install_failed",
    reason: publicReasonFor("dependency_setup_failed"),
    message: CHANNEL_SETUP_FAILED_MESSAGE,
  };
}

/** Run one teardown step, swallowing any rejection so later steps still run. */
async function bestEffort(operation: () => Promise<void> | void): Promise<void> {
  try {
    await operation();
  } catch {
    // Fail-closed teardown is best-effort; a failing step must not block the rest.
  }
}

/** Report a diagnostic cause without ever altering the result or throwing. */
function reportQuietly(
  report: ((diagnostic: InterceptionInstallDiagnostic) => void) | undefined,
  cause: BashInterceptionInstallFailureCause,
): void {
  if (report === undefined) {
    return;
  }
  try {
    report({ cause });
  } catch {
    // Diagnostics must never affect the install result or the cleanup path.
  }
}

/** Phase-1: capture only the shell object + its (string) kind, behind a fail-closed boundary. */
function snapshotShellForGate(deps: InstallBashInterceptionDeps): ShellGateSnapshot | undefined {
  try {
    const shell = deps.shell;
    if (!isObject(shell)) {
      return undefined;
    }
    const shellKind = readProp(shell, "kind");
    if (typeof shellKind !== "string") {
      return undefined;
    }
    return { shellKind: shellKind as ShellKind, shell };
  } catch {
    return undefined;
  }
}

/** Phase-2: capture the non-shell dependencies once (only reached for a supported shell). */
function snapshotDependencies(deps: InstallBashInterceptionDeps): DependencySnapshot | undefined {
  try {
    const commandsPolicy = deps.commandsPolicy;
    const evaluateCommandPolicy = deps.evaluateCommandPolicy;
    const generateNonce = deps.generateNonce;
    const createTransport = deps.createTransport;
    const generateHook = deps.generateHook;
    const createService = deps.createService;
    const materializeHook = deps.materializeHook;
    const createHandle = deps.createHandle;
    if (
      typeof evaluateCommandPolicy !== "function" ||
      typeof generateNonce !== "function" ||
      typeof createTransport !== "function" ||
      typeof generateHook !== "function" ||
      typeof createService !== "function" ||
      typeof materializeHook !== "function" ||
      typeof createHandle !== "function"
    ) {
      return undefined;
    }
    const rawReport = deps.reportDiagnostic;
    const reportDiagnostic = typeof rawReport === "function" ? rawReport : undefined;
    return {
      commandsPolicy,
      evaluateCommandPolicy,
      generateNonce,
      createTransport,
      generateHook,
      createService,
      materializeHook,
      createHandle,
      reportDiagnostic,
    };
  } catch {
    return undefined;
  }
}

/**
 * Install bash interception, returning a branded handle (+ disposer) or a
 * fail-closed refusal. Order: shell+kind snapshot -> gate -> (supported) path ->
 * dependency snapshot -> nonce -> channel -> hook -> (awaited) service ->
 * materialize -> stamp. Path/dependency-snapshot failures return a sanitized
 * refusal without diagnostics because no sink has been safely captured. Any
 * acquisition failure after a successful dependency snapshot reports its
 * internal cause, runs the shared disposer over the acquired subset (fixed
 * order: service -> transport -> rc), and returns the mapped coarse reason +
 * sanitized message. Never throws.
 */
export async function installBashInterception(
  deps: InstallBashInterceptionDeps,
): Promise<BashInterceptionInstallResult> {
  // Phase 1: capture ONLY the shell + its kind, so the gate runs FIRST touching
  // nothing beyond what it needs.
  const shellSnapshot = snapshotShellForGate(deps);
  if (shellSnapshot === undefined) {
    return dependencySetupFailure();
  }

  // GATE (authoritative, FIRST). An unsupported shell returns here having read
  // only deps.shell + shell.kind -- never the path, a non-shell dependency, or a sink.
  const support = resolveInterceptionShellSupport(shellSnapshot.shellKind);
  if (support.kind !== "supported") {
    return { kind: "install_failed", reason: "unsupported_shell", message: support.message };
  }

  // Supported only: NOW read + validate the executable path (once).
  let shellPath: unknown;
  try {
    shellPath = readProp(shellSnapshot.shell, "path");
  } catch {
    return dependencySetupFailure();
  }
  if (!isNonBlankString(shellPath)) {
    return dependencySetupFailure();
  }

  // Phase 2: snapshot the remaining dependencies behind a fail-closed boundary.
  const snapshot = snapshotDependencies(deps);
  if (snapshot === undefined) {
    return dependencySetupFailure();
  }
  const {
    commandsPolicy,
    evaluateCommandPolicy,
    generateNonce,
    createTransport,
    generateHook,
    createService,
    materializeHook,
    createHandle,
    reportDiagnostic,
  } = snapshot;

  // Cleanup operations, BOUND at acquisition (never re-read from a mutable dep).
  let closeTransport: (() => Promise<void> | void) | undefined;
  let stopService: (() => Promise<void> | void) | undefined;
  let cleanupMaterialized: (() => Promise<void> | void) | undefined;

  // ONE memoized, best-effort disposer for BOTH rollback and successful-install
  // teardown. The shared promise is installed BEFORE any cleanup runs, so a
  // synchronous, NON-AWAITING re-entrant dispose() (`void dispose()`) cannot start
  // a second run. A cleanup operation MUST NOT return or await this disposer --
  // that deadlocks (the disposer awaits the cleanup while the cleanup awaits the
  // disposer). Each bound cleanup runs at most once; the disposer never rejects.
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposePromise !== undefined) {
      return disposePromise;
    }
    let resolveDispose!: () => void;
    disposePromise = new Promise<void>((resolve) => {
      resolveDispose = resolve;
    });
    void (async () => {
      await bestEffort(() => stopService?.());
      await bestEffort(() => closeTransport?.());
      await bestEffort(() => cleanupMaterialized?.());
    })().then(resolveDispose, resolveDispose);
    return disposePromise;
  };

  const fail = (cause: SetupFailureCause): BashInterceptionInstallResult => {
    reportQuietly(reportDiagnostic, cause);
    const reason = publicReasonFor(cause);
    return {
      kind: "install_failed",
      reason,
      message:
        reason === "channel_setup_failed"
          ? CHANNEL_SETUP_FAILED_MESSAGE
          : HOOK_SETUP_FAILED_MESSAGE,
    };
  };

  // 1. NONCE (validate immediately, so a bad nonce never opens a channel).
  let nonce: string;
  try {
    const generated = generateNonce();
    if (typeof generated !== "string" || !NONCE_PATTERN.test(generated)) {
      throw new Error("invalid interception nonce");
    }
    nonce = generated;
  } catch {
    return fail("nonce_setup_failed");
  }

  // 2. CHANNEL (await + validate). Bind + register the closable transport BEFORE
  // the channel metadata, and SNAPSHOT the validated endpoint (read once).
  let createdTransport: InterceptionServiceTransport;
  let channel: InterceptionChannelRef;
  try {
    const created = await createTransport();
    const transportRaw = readProp(created, "transport");
    const closeFn = readProp(transportRaw, "close");
    if (typeof closeFn !== "function") {
      throw new Error("invalid interception transport");
    }
    createdTransport = transportRaw as unknown as InterceptionServiceTransport;
    closeTransport = (closeFn as unknown as () => Promise<void> | void).bind(createdTransport);

    const endpoint = readProp(readProp(created, "channel"), "endpoint");
    if (!isNonBlankString(endpoint)) {
      throw new Error("invalid interception channel");
    }
    channel = Object.freeze({ endpoint });
  } catch {
    await dispose();
    return fail("channel_setup_failed");
  }

  // 3. HOOK (generate + validate the returned script; a blank body is unusable).
  let hookScript: string;
  try {
    const generated = generateHook({ nonce, endpoint: channel.endpoint });
    if (typeof generated !== "string" || generated.trim().length === 0) {
      throw new Error("invalid interception hook");
    }
    hookScript = generated;
  } catch {
    await dispose();
    return fail("hook_setup_failed");
  }

  // 4. SERVICE (await readiness + validate). `stop` is its whole cleanup shape,
  // so bind-then-register after validating it.
  try {
    const readyService = await createService(createdTransport, {
      sessionNonce: nonce,
      commandsPolicy,
      evaluateCommandPolicy,
    });
    const stopFn = readProp(readyService, "stop");
    if (typeof stopFn !== "function") {
      throw new Error("invalid interception service");
    }
    stopService = (stopFn as unknown as () => Promise<void> | void).bind(readyService);
  } catch {
    await dispose();
    return fail("service_setup_failed");
  }

  // 5. MATERIALIZE (await + validate). Bind + register cleanup BEFORE validating
  // the path, and read the validated path once.
  let rcPath: string;
  try {
    const written = await materializeHook(hookScript);
    const cleanupFn = readProp(written, "cleanup");
    if (typeof cleanupFn !== "function") {
      throw new Error("invalid materialized interception hook");
    }
    cleanupMaterialized = (cleanupFn as unknown as () => Promise<void> | void).bind(written);
    const candidateRcPath = readProp(written, "rcPath");
    if (!isNonBlankString(candidateRcPath)) {
      throw new Error("invalid materialized interception hook path");
    }
    rcPath = candidateRcPath;
  } catch {
    await dispose();
    return fail("materialization_failed");
  }

  // 6. STAMP the branded handle (validates + copies + freezes; may throw). Only a
  // non-null object handle is accepted; the brand itself is guaranteed by the
  // 4e-iii production-import invariant, not re-checked here.
  let handle: InstalledInterception;
  try {
    const createdHandle = createHandle({
      shellKind: "bash",
      nonce,
      channel,
      shellStartup: {
        shellKind: "bash",
        executable: shellPath,
        args: ["--noprofile", "--rcfile", rcPath, "-i"],
      },
    });
    if (!isObject(createdHandle)) {
      throw new Error("invalid installed interception handle");
    }
    handle = createdHandle;
  } catch {
    await dispose();
    return fail("handle_setup_failed");
  }

  return { kind: "installed", handle, dispose };
}
