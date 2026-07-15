// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * PTY engine for `viberevert shell --pty` (M G4 Step 3c, D104.C/N/G/I).
 *
 * Built incrementally across 3c pieces: host shell RESOLUTION
 * (`resolveHostInteractiveShell`), the pre-spawn PRECONDITION gate
 * (`evaluatePtyPreconditions`), the raw TERMINAL BRIDGE
 * (`attachTerminalBridge`), and the `runPtyShell` ORCHESTRATION that binds them
 * live here. `runPtyShell` is FULLY INJECTED (every side-effecting seam is a
 * dep); the real default-deps factory (`createRunPtyShellDeps`) + the G3-backed
 * session adapter are bound below (3c-v). Until the engine is wired behind the
 * guarded `--pty` path (Step 3d/4) this file is reachable only by tests.
 *
 * Boundaries (enforced by invariants): this file reaches the native PTY module
 * ONLY via pty-loader's `loadPtyModule` (never the package name directly),
 * routes all I/O through `this.context` (no `process.std*` / `exit` /
 * `console`), and has no env-flag escape hatch.
 *
 * --- Host shell resolution ---
 *
 * `resolveHostInteractiveShell` bridges the pure shell resolver
 * (`shell-resolver.ts` -- WHICH interactive shell) and the executable path
 * resolver (`executable-probe.ts` -- WHERE it is) into the concrete
 * `{ path, args, kind }` the engine spawns.
 *
 * ONE resolution seam: the same `resolveExecutablePath` both approves a
 * candidate's availability (its `!== null`, fed to the resolver as
 * `isExecutableAvailable`) AND yields the exact path to spawn. Availability
 * results are CACHED so the approved path is byte-for-byte the one availability
 * accepted -- no approve-one-spawn-another drift across the two lookups. The
 * approved EXACT path is then re-verified directly (not the bare name) right
 * before returning; if it no longer resolves to itself (removed/changed) it
 * refuses rather than fall through to a different PATH candidate. This preserves
 * the Step-3b guarantee: the engine spawns the resolved exact path, never a bare
 * name the OS/runtime might re-resolve differently (CWD / PATHEXT). Deps are
 * ALL-OR-NONE injectable so it is deterministically unit-tested.
 *
 * --- Pre-spawn preconditions ---
 *
 * `evaluatePtyPreconditions` is the fail-fast gate the engine runs before any
 * PTY: a real interactive TTY (checked FIRST, so the native PTY module is never
 * loaded off a non-TTY -- which also excludes the MCP harness / piped stdin),
 * then the PTY module loads (a thrown loader is treated as unavailable --
 * fail-closed), then a suitable shell resolves. It returns a `refuse` (a
 * machine-stable `reason` + human message + exit code) or `proceed` (carrying
 * the loaded PTY module + resolved shell). Session-level refusals (session
 * already active, repo/config) come later from the reused G3 session machinery,
 * not this gate.
 *
 * --- Terminal bridge (D104.I) ---
 *
 * `attachTerminalBridge` wires a raw transparent passthrough between the
 * terminal streams and a spawned PTY: stdin (raw) -> pty.write; pty.onData ->
 * stdout.write; stdout resize -> pty.resize (guarded, plus one initial resize);
 * pty.onExit -> settles `waitForExit()` AND auto-disposes (so the terminal is
 * restored the instant the child exits, even if the caller forgets). Every
 * post-setup handler is wrapped so a throw (e.g. `pty.write` on a dead child)
 * disposes the bridge rather than escaping uncaught and stranding raw mode.
 * Setup is TRANSACTIONAL (a failing wire undoes what succeeded before throwing,
 * and raw restoration is attempted whenever the toggle was even begun).
 * Teardown (`dispose()`) runs an EXPLICIT ordered sequence (restore raw mode
 * FIRST, kill child LAST), attempts every step even if one throws, never throws,
 * is idempotent (cached result), and settles `waitForExit()` with a
 * deterministic fallback if the child had not exited (so it can never hang).
 * All handlers go inert after `dispose()`. It touches only the passed streams
 * (never `process.std*`) and installs no signal handlers (in raw mode Ctrl-C is
 * a byte to the pty; process-signal cleanup is `runPtyShell`'s concern).
 *
 * --- runPtyShell orchestration (D104.G/J) ---
 *
 * `runPtyShell` binds the pieces into one flow: the precondition gate, an
 * injected session PORT (open/close), then spawn -> attach bridge -> wait ->
 * dispose -> close session. It is a NON-THROWING boundary -- every expected and
 * unexpected failure (spawn/attach/wait/dispose/kill, session open/close, even a
 * throwing stderr) maps to a numeric exit code. It OWNS all user-visible output
 * (the session port RETURNS refusal copy for it to write, never writes itself),
 * and fails CLOSED (D104.J): a bridge that failed a handler surfaces its dispose
 * errors as a wrapper failure (exit 1), never a clean success. The inner shell's
 * own exit is displayed but not propagated (D104.G). Every seam is injected, so
 * the whole flow is unit-tested with no live PTY / native PTY module / session
 * locks; the real deps factory + G3-backed session adapter are bound below (3c-v).
 */

import {
  type Config,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadActiveSessionLock,
  loadConfig,
  NoActiveSessionError,
  RepoRootNotFoundError,
  resolveRepoRoot,
  SessionAlreadyActiveError,
} from "@viberevert/core";

import type { CommandsPolicyConfig } from "../command-guard.js";
import { truncateIdForDisplay } from "../format.js";
import { ConcurrentOperationError } from "../locks.js";
import { EndSessionRaceError, endSessionOperation } from "../operations/end-session.js";
import { START_LOCK_REL, startSessionOperation } from "../operations/start-session.js";
import { RuntimeEnvInvalidError } from "../runtime-env.js";
import { createHostExecutablePathResolver } from "./executable-probe.js";
import {
  type BashInterceptionInstallResult,
  installBashInterception,
} from "./pty-interception-installer.js";
import { createBashInterceptionInstallerDeps } from "./pty-interception-installer-bindings.js";
import type { PtyDisposable, PtyModule, PtyProcess, PtySpawnOptions } from "./pty-loader.js";
import { loadPtyModule } from "./pty-loader.js";
import {
  resolveInteractiveShell,
  type ShellKind,
  type ShellResolverEnv,
} from "./shell-resolver.js";

/** The exact interactive shell to spawn in the PTY. */
export interface ResolvedInteractiveShell {
  /** Exact executable path (from the executable path resolver). */
  readonly path: string;
  /** Interactive argv from the shell resolver. */
  readonly args: readonly string[];
  readonly kind: ShellKind;
}

/**
 * Injected host facts for `resolveHostInteractiveShell`. ALL-OR-NONE: pass every
 * field (tests) or omit `deps` entirely for the host default -- never mix an
 * injected `platform`/`env` with the real host `resolveExecutablePath`.
 */
export interface HostShellResolutionDeps {
  /** Usually `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Usually `process.env`. */
  readonly env: NodeJS.ProcessEnv;
  /** The SINGLE executable-resolution seam: exact path for a file, or null. */
  readonly resolveExecutablePath: (file: string) => string | null;
}

/** Host default deps: real platform/env + the fs/PATH executable resolver. */
function createHostShellResolutionDeps(): HostShellResolutionDeps {
  return {
    platform: process.platform,
    env: process.env,
    resolveExecutablePath: createHostExecutablePathResolver(),
  };
}

/** Env key the resolver reads; bracket-const access satisfies tsc + biome. */
const SHELL_ENV_KEY = "SHELL";

/**
 * Adapt the host `NodeJS.ProcessEnv` to the narrow `ShellResolverEnv` the pure
 * resolver consumes -- OMISSION-safe: an undefined `SHELL` is dropped, not
 * passed as `{ SHELL: undefined }` (which differs under
 * `exactOptionalPropertyTypes`). Keeps the resolver seeing only `SHELL`.
 */
function createShellResolverEnv(env: NodeJS.ProcessEnv): ShellResolverEnv {
  const shell = env[SHELL_ENV_KEY];
  return shell === undefined ? {} : { SHELL: shell };
}

/**
 * Resolve the host's interactive shell to an exact spawnable `{ path, args,
 * kind }`, or `null` when no suitable shell is available (the engine then
 * refuses). Deterministic given `deps`; by default reads the real host.
 */
export function resolveHostInteractiveShell(
  deps: HostShellResolutionDeps = createHostShellResolutionDeps(),
): ResolvedInteractiveShell | null {
  const { platform, env, resolveExecutablePath } = deps;

  // Cache resolutions so a candidate's availability check and its approved-path
  // lookup return the SAME path (no approve-one-spawn-another drift).
  const resolvedPaths = new Map<string, string | null>();
  const resolveAndCache = (file: string): string | null => {
    if (resolvedPaths.has(file)) {
      return resolvedPaths.get(file) ?? null;
    }
    const resolved = resolveExecutablePath(file);
    resolvedPaths.set(file, resolved);
    return resolved;
  };

  const selected = resolveInteractiveShell({
    platform,
    env: createShellResolverEnv(env),
    isExecutableAvailable: (file) => resolveAndCache(file) !== null,
  });
  if (selected === null) {
    return null;
  }

  const approvedPath = resolveAndCache(selected.file);
  if (approvedPath === null) {
    return null;
  }

  // Re-verify the EXACT approved path (not the bare name) right before spawning.
  // If it no longer resolves to itself (removed/changed), refuse -- do not fall
  // through to a different PATH candidate.
  if (resolveExecutablePath(approvedPath) !== approvedPath) {
    return null;
  }

  return { path: approvedPath, args: selected.args, kind: selected.kind };
}

/** Why the PTY preconditions refused (machine-stable, alongside the message). */
export type PtyPreconditionRefusalReason = "not_tty" | "pty_unavailable" | "no_shell";

/** Outcome of the pre-spawn preconditions: refuse (reason/message/exit) or proceed. */
export type PtyPreconditionResult =
  | {
      readonly kind: "refuse";
      readonly reason: PtyPreconditionRefusalReason;
      readonly message: string;
      readonly exitCode: number;
    }
  | {
      readonly kind: "proceed";
      readonly pty: PtyModule;
      readonly shell: ResolvedInteractiveShell;
    };

/** Injected facts for the precondition gate (all-or-none per call). */
export interface PtyPreconditionDeps {
  /**
   * True only when both stdin and stdout are real TTYs. stdin is needed for raw
   * input; stdout is needed for PTY output/resize. stderr is not part of the PTY
   * bridge.
   */
  readonly hasInteractiveTty: () => boolean;
  /** Load the optional native PTY module (the sole seam), or null if absent. */
  readonly loadPtyModule: () => Promise<PtyModule | null>;
  /** Resolve the host interactive shell to an exact spawnable, or null. */
  readonly resolveHostShell: () => ResolvedInteractiveShell | null;
}

const NOT_A_TTY_MESSAGE =
  "viberevert shell --pty requires an interactive terminal (a real TTY). Run `viberevert shell` for the guarded REPL instead.";
const PTY_UNAVAILABLE_MESSAGE =
  "viberevert shell --pty is unavailable here: the optional native PTY dependency is not installed or failed to load. Run `viberevert shell` for the guarded REPL instead.";
const NO_SHELL_MESSAGE =
  "viberevert shell --pty could not find a suitable interactive shell on this system. Run `viberevert shell` for the guarded REPL instead.";

/** Build a refusal result (all pre-spawn refusals exit non-zero, code 1). */
function refuse(reason: PtyPreconditionRefusalReason, message: string): PtyPreconditionResult {
  return { kind: "refuse", reason, message, exitCode: 1 };
}

/**
 * Pre-spawn precondition gate for the PTY engine (D104.G). Returns a refusal
 * (reason + message + exit code) or `proceed` with the loaded PTY module +
 * resolved shell. Deterministic given `deps`; runs no PTY.
 *
 * Order (fail-fast, short-circuiting): (1) a real interactive TTY -- checked
 * first so the native PTY module is never loaded off a non-TTY; (2) the PTY
 * module loads -- a thrown loader is treated as unavailable (fail-closed);
 * (3) a suitable shell resolves.
 */
export async function evaluatePtyPreconditions(
  deps: PtyPreconditionDeps,
): Promise<PtyPreconditionResult> {
  if (!deps.hasInteractiveTty()) {
    return refuse("not_tty", NOT_A_TTY_MESSAGE);
  }

  let pty: PtyModule | null;
  try {
    pty = await deps.loadPtyModule();
  } catch {
    return refuse("pty_unavailable", PTY_UNAVAILABLE_MESSAGE);
  }
  if (pty === null) {
    return refuse("pty_unavailable", PTY_UNAVAILABLE_MESSAGE);
  }

  const shell = deps.resolveHostShell();
  if (shell === null) {
    return refuse("no_shell", NO_SHELL_MESSAGE);
  }

  return { kind: "proceed", pty, shell };
}

/** The PTY child's exit event (`signal` required so `undefined` assigns cleanly). */
export interface PtyExitResult {
  readonly exitCode: number;
  readonly signal: number | undefined;
}

/** Teardown outcome: any errors from cleanup steps (`dispose()` never throws). */
export interface TerminalBridgeDisposeResult {
  readonly errors: readonly unknown[];
}

/** A live terminal bridge: await the child's exit, then idempotently tear down. */
export interface TerminalBridge {
  /**
   * Resolves with the child's real exit event, or -- if the bridge is disposed
   * first (explicitly or via a handler failure) -- a deterministic fallback so
   * it can never hang.
   */
  waitForExit(): Promise<PtyExitResult>;
  /**
   * Idempotent teardown in an explicit order (restore raw mode FIRST, kill the
   * child LAST). Attempts EVERY step even if one throws, never throws, and
   * returns the collected errors (cached, so repeats return the same result
   * without re-running cleanup).
   */
  dispose(): TerminalBridgeDisposeResult;
}

/** The exact stdin/stdout surface the bridge drives (this.context.* in prod). */
export interface PtyBridgeStreams {
  readonly stdin: {
    readonly isRaw?: boolean;
    // Flow state at attach: null = never engaged (paused), false = paused, true =
    // already flowing. The bridge returns stdin to paused on teardown ONLY when it
    // resumed a not-already-flowing stream, so it never pauses a caller-owned flow.
    readonly readableFlowing?: boolean | null;
    setRawMode(mode: boolean): void;
    on(event: "data", listener: (data: Buffer | string) => void): void;
    removeListener(event: "data", listener: (data: Buffer | string) => void): void;
    pause(): void;
  };
  readonly stdout: {
    readonly columns?: number;
    readonly rows?: number;
    write(data: string): void;
    on(event: "resize", listener: () => void): void;
    removeListener(event: "resize", listener: () => void): void;
  };
}

/** Deterministic exit used when the bridge is disposed before the child exits. */
const DISPOSE_FALLBACK_EXIT: PtyExitResult = { exitCode: 1, signal: undefined };

/** A usable PTY dimension: a positive finite integer. */
function isUsableDimension(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

/** Run every cleanup in the given order, collecting (never throwing) any errors. */
function runCleanups(cleanups: readonly (() => void)[]): unknown[] {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Wire a raw transparent passthrough between the terminal `streams` and a
 * spawned `pty` (D104.I). See the module header for the full contract:
 * auto-dispose on exit, wrapped handlers, transactional setup, explicit-ordered
 * idempotent non-throwing teardown, deterministic `waitForExit()`,
 * inert-after-dispose.
 */
export function attachTerminalBridge(streams: PtyBridgeStreams, pty: PtyProcess): TerminalBridge {
  const { stdin, stdout } = streams;

  let disposed = false;
  let exited = false;
  let disposeResult: TerminalBridgeDisposeResult | null = null;
  const bridgeErrors: unknown[] = [];

  let settleExit: (result: PtyExitResult) => void = () => undefined;
  const exitPromise = new Promise<PtyExitResult>((resolve) => {
    settleExit = resolve;
  });

  // Wired resources, recorded as setup progresses so teardown only undoes what
  // was actually wired (partial-attach rollback + explicit teardown order).
  // `rawRestoreNeeded` is set BEFORE the setRawMode(true) attempt, so a partial
  // toggle that throws is still rolled back.
  let rawRestoreNeeded = false;
  let previousRaw = false;
  // True only when the bridge moved stdin from non-flowing to flowing (its own
  // `on("data")`); teardown then pauses it back. If stdin was already flowing at
  // attach, the bridge does not own that lifecycle and leaves it alone.
  let bridgeResumedStdin = false;
  let onStdinData: ((data: Buffer | string) => void) | undefined;
  let onResize: (() => void) | undefined;
  let dataSub: PtyDisposable | undefined;
  let exitSub: PtyDisposable | undefined;

  const applyResize = (): void => {
    if (disposed) {
      return;
    }
    const { columns, rows } = stdout;
    if (isUsableDimension(columns) && isUsableDimension(rows)) {
      pty.resize(columns, rows);
    }
  };

  const disposeBridge = (): TerminalBridgeDisposeResult => {
    if (disposeResult !== null) {
      return disposeResult;
    }
    disposed = true;
    if (!exited) {
      settleExit(DISPOSE_FALLBACK_EXIT);
    }

    // Explicit teardown order for stdin: stop input delivery (remove the data
    // listener) FIRST, then return stdin to paused (a flowing TTY stdin left
    // resumed keeps Node alive and blocks the CLI's natural exit), then restore raw
    // mode. Then resize, subscriptions, and kill LAST. Each step is guarded by
    // whether it was wired and run best-effort by runCleanups, so a throw in one
    // step (e.g. pause) never skips the rest.
    const ordered: (() => void)[] = [];
    const stdinHandler = onStdinData;
    if (stdinHandler !== undefined) {
      ordered.push(() => stdin.removeListener("data", stdinHandler));
    }
    if (bridgeResumedStdin) {
      ordered.push(() => stdin.pause());
    }
    if (rawRestoreNeeded) {
      ordered.push(() => stdin.setRawMode(previousRaw));
    }
    const resizeHandler = onResize;
    if (resizeHandler !== undefined) {
      ordered.push(() => stdout.removeListener("resize", resizeHandler));
    }
    const dataSubscription = dataSub;
    if (dataSubscription !== undefined) {
      ordered.push(() => dataSubscription.dispose());
    }
    const exitSubscription = exitSub;
    if (exitSubscription !== undefined) {
      ordered.push(() => exitSubscription.dispose());
    }
    if (!exited) {
      ordered.push(() => pty.kill());
    }

    disposeResult = { errors: [...bridgeErrors, ...runCleanups(ordered)] };
    return disposeResult;
  };

  /** A post-setup handler threw: record it and tear the bridge down. */
  const failBridge = (error: unknown): void => {
    if (disposed) {
      return;
    }
    bridgeErrors.push(error);
    disposeBridge();
  };

  try {
    previousRaw = stdin.isRaw ?? false;
    rawRestoreNeeded = true;
    stdin.setRawMode(true);

    onStdinData = (data) => {
      if (disposed) {
        return;
      }
      try {
        const chunk = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        pty.write(chunk);
      } catch (error) {
        failBridge(error);
      }
    };
    // Observe flow state, ATTEMPT attachment, and only after it succeeds record that
    // the bridge owns the resulting resume. If `on("data")` throws, ownership is
    // never claimed (bridgeResumedStdin stays false), so the startup-failure
    // rollback will not pause a stream the bridge never resumed. An absent
    // readableFlowing counts as not-flowing (the narrower CLI-owned-stdin contract).
    const stdinWasAlreadyFlowing = stdin.readableFlowing === true;
    stdin.on("data", onStdinData);
    bridgeResumedStdin = !stdinWasAlreadyFlowing;

    dataSub = pty.onData((data) => {
      if (disposed) {
        return;
      }
      try {
        stdout.write(data);
      } catch (error) {
        failBridge(error);
      }
    });

    onResize = () => {
      if (disposed) {
        return;
      }
      try {
        applyResize();
      } catch (error) {
        failBridge(error);
      }
    };
    stdout.on("resize", onResize);

    exitSub = pty.onExit((event) => {
      if (disposed) {
        return;
      }
      exited = true;
      settleExit({ exitCode: event.exitCode, signal: event.signal });
      // Auto-dispose so the terminal is restored the instant the child exits
      // (exited === true, so this restores raw mode / listeners / subs without
      // settling the fallback or killing). A later caller dispose() is cached.
      disposeBridge();
    });

    // Size the child once now, from the current dimensions (if valid).
    applyResize();
  } catch (error) {
    // Transactional rollback: mark inert, undo whatever was wired, then rethrow.
    disposed = true;
    disposeBridge();
    throw error;
  }

  return {
    waitForExit: () => exitPromise,
    dispose: disposeBridge,
  };
}

// ============================================================================
// runPtyShell orchestration (M G4 Step 3c-iv, D104.C/G/I/J)
// ============================================================================

/** The stream + message surface `runPtyShell` drives (this.context.* in prod). */
export interface PtyShellContext extends PtyBridgeStreams {
  readonly stderr: { write(data: string): void };
}

/** Outcome of opening the one PTY session (the port RETURNS copy, never writes it). */
export type PtyShellSessionOpen =
  | {
      readonly kind: "opened";
      readonly sessionId: string;
      readonly commandsPolicy: CommandsPolicyConfig | undefined;
    }
  | { readonly kind: "refused"; readonly exitCode: number; readonly stderrText: string };

/** Outcome of closing the one PTY session (returns copy for the runner to write). */
export interface PtyShellSessionClose {
  readonly exitCode: number;
  readonly stderrText: string;
}

/**
 * The session lifecycle as an injected PORT. The real G3-backed adapter
 * (`createG3BackedPtyShellSession`, below) reuses the shipped session machinery;
 * `runPtyShell` owns ALL user-visible output, so BOTH `open()` and `close()`
 * RETURN copy rather than writing it (D104.M.4: adapters return decisions/data,
 * the runner writes).
 */
export interface PtyShellSession {
  /** Open the one session; `refused` carries copy for `runPtyShell` to write. */
  open(): Promise<PtyShellSessionOpen>;
  /** Scoped teardown -> exit code + copy for the runner. Contract: never throws. */
  close(): Promise<PtyShellSessionClose>;
}

/** Everything `runPtyShell` needs, ALL injected (no host default factory until 3c-v). */
export interface RunPtyShellDeps {
  readonly context: PtyShellContext;
  /** True only when both stdin and stdout are real TTYs (fed to the gate). */
  readonly hasInteractiveTty: () => boolean;
  /** Load the optional native PTY module, or null (the pty-loader seam). */
  readonly loadPtyModule: () => Promise<PtyModule | null>;
  /** Resolve the host interactive shell to an exact spawnable, or null. */
  readonly resolveHostShell: () => ResolvedInteractiveShell | null;
  /** Wire the raw terminal bridge (`attachTerminalBridge` in prod). */
  readonly attachBridge: (streams: PtyBridgeStreams, pty: PtyProcess) => TerminalBridge;
  /** The one PTY session; real deps bind the G3-backed adapter below. */
  readonly session: PtyShellSession;
  /**
   * Install interception for the resolved shell (interception-REQUIRED). The engine
   * may spawn ONLY from a genuine install's handle.shellStartup; the real deps bind
   * this to installBashInterception(createBashInterceptionInstallerDeps(args)).
   */
  readonly installInterception: (args: {
    readonly shell: { readonly path: string; readonly kind: ShellKind };
    readonly commandsPolicy: CommandsPolicyConfig | undefined;
  }) => Promise<BashInterceptionInstallResult>;
  /** Working directory for the spawned PTY (`process.cwd()` in prod). */
  readonly cwd: string;
  /** Environment for the spawned PTY (`process.env` in prod). */
  readonly spawnEnv: NodeJS.ProcessEnv;
  /**
   * Run `run()` with scoped process-signal cleanup installed: on a signal,
   * `onSignal` (which disposes the bridge) runs before the process tears down.
   * The bridge installs NO signal handlers (D104.I) -- signal cleanup is the
   * orchestration's concern. Identity in tests; the real scoped SIGTERM/SIGHUP
   * binding lands in 3c-v.
   */
  readonly withSignalCleanup: <T>(onSignal: () => void, run: () => Promise<T>) => Promise<T>;
}

/** Result of driving one PTY child through the bridge (no exceptions escape). */
type DrivePtyResult =
  | {
      readonly kind: "completed";
      readonly exit: PtyExitResult;
      readonly disposeErrors: readonly unknown[];
    }
  | { readonly kind: "failed"; readonly errors: readonly unknown[] };

/** Format any thrown value into a message string (non-Error / unprintable-safe). */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    // Some thrown values have a throwing toString(); never let formatting throw.
    return "[unprintable thrown value]";
  }
}

/** Write to stderr without ever letting a throwing stream crash the runner. */
function writeStderrSafely(context: PtyShellContext, text: string): void {
  if (text.length === 0) {
    return;
  }
  try {
    context.stderr.write(text);
  } catch {
    // Error reporting must not itself become the failure; nothing else to do.
  }
}

/** Dispose the bridge without letting a contract-violating throw escape drivePty. */
function disposeBridgeSafely(bridge: TerminalBridge): TerminalBridgeDisposeResult {
  try {
    return bridge.dispose();
  } catch (error) {
    return { errors: [error] };
  }
}

/**
 * Concatenate error groups in order, de-duplicated by identity: genuinely
 * different errors are all kept, but the SAME error surfaced twice (e.g. a
 * cached bridge dispose result observed by both the signal cleanup and the final
 * safety dispose) is reported once -- no noisy duplicate stderr lines.
 */
function combineUniqueErrors(...groups: readonly (readonly unknown[])[]): readonly unknown[] {
  const seen = new Set<unknown>();
  const combined: unknown[] = [];
  for (const group of groups) {
    for (const error of group) {
      if (!seen.has(error)) {
        seen.add(error);
        combined.push(error);
      }
    }
  }
  return combined;
}

/** True for a non-null object (defensive reads use readProp on top of this). */
function isObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Read a property off an unknown as unknown (variable-key bracket: satisfies tsc + biome). */
function readProp(value: unknown, key: PropertyKey): unknown {
  return isObjectValue(value) ? (value as Record<PropertyKey, unknown>)[key] : undefined;
}

/** The trusted, immutable engine inputs distilled from an untrusted install result. */
type ClassifiedInstallResult =
  | {
      readonly kind: "installed";
      readonly dispose: () => Promise<void>;
      readonly startup: { readonly executable: string; readonly args: readonly string[] };
    }
  | { readonly kind: "install_failed"; readonly message: string }
  | { readonly kind: "invalid" };

/**
 * The FINAL no-spawn authorization boundary. `installInterception` is injected, so a
 * JS caller / test double can return anything; classify the RAW value entirely through
 * guarded reads -- reading each untrusted field ONCE -- and return only trusted, frozen
 * engine inputs. Any hostile getter/proxy throw, or any missing/ill-typed field, yields
 * `invalid` (fail-closed) rather than escaping. Validates ONLY what the engine
 * dereferences (dispose + the spawn material); the installer owns the branded handle.
 * The captured `dispose` is invoked later as a standalone zero-argument callback (it is
 * already bound by the installer), never method-style off the raw result.
 */
function classifyInstallResult(value: unknown): ClassifiedInstallResult {
  try {
    const kind = readProp(value, "kind");
    if (kind === "install_failed") {
      const message = readProp(value, "message");
      return typeof message === "string"
        ? { kind: "install_failed", message }
        : { kind: "invalid" };
    }
    if (kind !== "installed") {
      return { kind: "invalid" };
    }
    const dispose = readProp(value, "dispose");
    if (typeof dispose !== "function") {
      return { kind: "invalid" };
    }
    const startup = readProp(readProp(value, "handle"), "shellStartup");
    if (!isObjectValue(startup)) {
      return { kind: "invalid" };
    }
    const executable = readProp(startup, "executable");
    if (typeof executable !== "string" || executable.trim().length === 0) {
      return { kind: "invalid" };
    }
    const rawArgs = readProp(startup, "args");
    if (!Array.isArray(rawArgs)) {
      return { kind: "invalid" };
    }
    // Copy ONCE, then validate + freeze the copy (a hostile array-like cannot differ
    // between the validation pass and the frozen snapshot).
    const args = [...rawArgs];
    if (!args.every((arg) => typeof arg === "string")) {
      return { kind: "invalid" };
    }
    return {
      kind: "installed",
      dispose: dispose as () => Promise<void>,
      startup: Object.freeze({ executable, args: Object.freeze(args) }),
    };
  } catch {
    return { kind: "invalid" };
  }
}

/** Append a trailing newline only when absent (installer messages may or may not carry one). */
function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Dispose interception, capturing a SINGLE failure (0 or 1) without ever throwing. */
async function disposeInterceptionSafely(
  dispose: () => Promise<void>,
): Promise<{ readonly error: unknown } | null> {
  try {
    await dispose();
    return null;
  } catch (error) {
    return { error };
  }
}

/**
 * Build the PTY spawn options. The size is a PAIR: `cols`/`rows` are passed only
 * when BOTH are usable (mirrors the bridge resize rule) -- never a half
 * `{ cols }` / `{ rows }`. `cwd`/`env` always flow through.
 * exactOptionalPropertyTypes-safe: the size is OMITTED (not present-with-
 * undefined) when unusable.
 */
function createPtySpawnOptions(deps: RunPtyShellDeps): PtySpawnOptions {
  const { columns, rows } = deps.context.stdout;
  const size = isUsableDimension(columns) && isUsableDimension(rows) ? { cols: columns, rows } : {};
  return {
    cwd: deps.cwd,
    // Copy the injected env (like the args copy) so a future/fake spawn cannot
    // mutate the caller's object.
    env: { ...deps.spawnEnv },
    ...size,
  };
}

/**
 * Spawn the guarded shell startup, attach the bridge, wait for exit (through the
 * signal cleanup seam), then ALWAYS dispose. Returns a stable union instead of throwing
 * so every failure (spawn, attach + backstop kill, wait rejection, dispose) is
 * observable without exception control flow. On attach failure the bridge never
 * took ownership, so the child is backstop-killed; BOTH the attach and kill
 * errors are preserved. A rejected `waitForExit()` still disposes, and a
 * contract-violating `dispose()` is tolerated (disposeBridgeSafely) so drivePty
 * itself never rejects. A parent-signal-triggered dispose settles a synthetic
 * fallback exit, NOT the child's real exit, so it is reported as a failure.
 * Teardown errors are combined by identity (no duplicate reporting).
 */
async function drivePty(
  deps: RunPtyShellDeps,
  pty: PtyModule,
  startup: { readonly executable: string; readonly args: readonly string[] },
): Promise<DrivePtyResult> {
  let child: PtyProcess;
  try {
    // Copy the readonly args to a fresh array (no accidental mutation of the
    // guarded startup by a future spawn implementation).
    child = pty.spawn(startup.executable, [...startup.args], createPtySpawnOptions(deps));
  } catch (spawnError) {
    return { kind: "failed", errors: [spawnError] };
  }

  let bridge: TerminalBridge;
  try {
    bridge = deps.attachBridge(deps.context, child);
  } catch (attachError) {
    // Attach threw before the bridge owned the child -> backstop kill so the
    // child cannot leak. Preserve BOTH errors if the kill also throws.
    const errors: unknown[] = [attachError];
    try {
      child.kill();
    } catch (killError) {
      errors.push(killError);
    }
    return { kind: "failed", errors };
  }

  // The bridge now owns the child. Wait for exit through the signal-cleanup
  // seam, then ALWAYS dispose (safely) and observe its errors. A signal firing
  // through the seam disposes the bridge -> the resolved exit is the synthetic
  // fallback, not the inner shell's, so track it and fail closed.
  let signalCleanupRan = false;
  let signalCleanupErrors: unknown[] = [];
  let exit: PtyExitResult;
  try {
    exit = await deps.withSignalCleanup(
      () => {
        signalCleanupRan = true;
        const result = disposeBridgeSafely(bridge);
        signalCleanupErrors = [...signalCleanupErrors, ...result.errors];
      },
      () => bridge.waitForExit(),
    );
  } catch (waitError) {
    const failed = disposeBridgeSafely(bridge);
    return {
      kind: "failed",
      errors: combineUniqueErrors([waitError], signalCleanupErrors, failed.errors),
    };
  }

  // Combine by identity: keep every genuinely different teardown error, but do
  // not report the same cached bridge error twice (signal dispose + final safety
  // dispose).
  const disposeResult = disposeBridgeSafely(bridge);
  const disposeErrors = combineUniqueErrors(signalCleanupErrors, disposeResult.errors);

  if (signalCleanupRan) {
    // Parent signal tore the bridge down; `exit` is the synthetic fallback, not
    // the inner shell's real exit -> fail closed (D104.J).
    return {
      kind: "failed",
      errors:
        disposeErrors.length > 0
          ? disposeErrors
          : [new Error("PTY shell interrupted by parent signal")],
    };
  }

  return { kind: "completed", exit, disposeErrors };
}

/** Close the session, mapping a broken `close()` contract to a safe failure. */
async function closeSessionSafely(session: PtyShellSession): Promise<PtyShellSessionClose> {
  try {
    return await session.close();
  } catch (error) {
    return {
      exitCode: 1,
      stderrText: `Unexpected error closing PTY shell session: ${formatErrorMessage(error)}\n`,
    };
  }
}

/** Display the inner shell's exit (D104.G) -- non-zero code or a signal. */
function displayChildExit(context: PtyShellContext, exit: PtyExitResult): void {
  if (exit.signal !== undefined) {
    writeStderrSafely(context, `[signal: ${exit.signal}]\n`);
  } else if (exit.exitCode !== 0) {
    writeStderrSafely(context, `[exit: ${exit.exitCode}]\n`);
  }
}

/**
 * Orchestrate one `viberevert shell --pty` session over the 3c pieces
 * (D104.C/G/I/J). Fully injected + non-throwing: returns an exit code for every
 * path.
 *
 * Flow: gate -> (refuse: write message, its exit code; gate threw: exit 1) ->
 * open session -> (refused: write the port's text + its exit code; open threw:
 * exit 1) -> drive the PTY (spawn/attach/wait/dispose) -> ALWAYS close the
 * session -> exit 1 if the drive failed, produced dispose errors, or scoped
 * teardown returned/threw non-zero; otherwise 0. The inner shell's own exit is
 * DISPLAYED, not propagated.
 */
export async function runPtyShell(deps: RunPtyShellDeps): Promise<number> {
  const { context } = deps;

  // The gate catches loader throws, but `hasInteractiveTty` / `resolveHostShell`
  // are injected and could throw -- runPtyShell is the outer boundary, so wrap
  // the whole evaluation.
  let pre: PtyPreconditionResult;
  try {
    pre = await evaluatePtyPreconditions({
      hasInteractiveTty: deps.hasInteractiveTty,
      loadPtyModule: deps.loadPtyModule,
      resolveHostShell: deps.resolveHostShell,
    });
  } catch (error) {
    writeStderrSafely(
      context,
      `Unexpected error preparing PTY shell: ${formatErrorMessage(error)}\n`,
    );
    return 1;
  }
  if (pre.kind === "refuse") {
    writeStderrSafely(context, `${pre.message}\n`);
    return pre.exitCode;
  }

  // Open the ONE session. The port returns its refusal copy; `runPtyShell`
  // writes it (adapters never write). A thrown open is an unexpected failure
  // (exit 1); neither a refusal nor a throw opened a session, so `close()` is
  // NOT called.
  let opened: PtyShellSessionOpen;
  try {
    opened = await deps.session.open();
  } catch (error) {
    writeStderrSafely(
      context,
      `Unexpected error starting PTY shell session: ${formatErrorMessage(error)}\n`,
    );
    return 1;
  }
  if (opened.kind === "refused") {
    writeStderrSafely(context, opened.stderrText);
    return opened.exitCode;
  }

  // Session is open. Install interception (interception-REQUIRED) BEFORE any spawn.
  // Snapshot + freeze the install inputs ONCE so the installer sees exactly
  // {shell:{path,kind}, commandsPolicy} -- resolver args absent, path/kind copied (a
  // later pre.shell mutation cannot change what it saw), commandsPolicy by identity.
  const installArgs = Object.freeze({
    shell: Object.freeze({ path: pre.shell.path, kind: pre.shell.kind }),
    commandsPolicy: opened.commandsPolicy,
  });

  let rawInstallResult: unknown;
  try {
    rawInstallResult = await deps.installInterception(installArgs);
  } catch (error) {
    // A defensive throw from the injected seam -> fail closed. The just-opened
    // session must still be closed.
    writeStderrSafely(
      context,
      `Unexpected error installing PTY command interception: ${formatErrorMessage(error)}\n`,
    );
    const close = await closeSessionSafely(deps.session);
    writeStderrSafely(context, close.stderrText);
    return 1;
  }

  // Positive authorization: only a classified `installed` result authorizes a spawn.
  // `install_failed` writes the installer's sanitized message; ANY other/malformed
  // result writes a generic invalid-result message. Both close the just-opened
  // session, exit 1, and NEVER spawn -- and neither invokes an untrusted `dispose`.
  const classified = classifyInstallResult(rawInstallResult);
  if (classified.kind === "install_failed") {
    writeStderrSafely(context, ensureTrailingNewline(classified.message));
    const close = await closeSessionSafely(deps.session);
    writeStderrSafely(context, close.stderrText);
    return 1;
  }
  if (classified.kind === "invalid") {
    writeStderrSafely(
      context,
      "PTY command interception returned an invalid installation result.\n",
    );
    const close = await closeSessionSafely(deps.session);
    writeStderrSafely(context, close.stderrText);
    return 1;
  }

  // Authorized: `dispose` and `startup` are captured + frozen; the raw result is
  // never touched again. Interception-disposal ownership begins NOW, so EVERY path
  // below runs the ordered teardown: bridge dispose (restore raw -> kill child,
  // inside drivePty) -> interception dispose -> session close. The nested finally
  // guarantees the session close is attempted even if interception disposal throws.
  const disposeInterception = classified.dispose;

  let drive: DrivePtyResult;
  let interceptionFailure: { readonly error: unknown } | null = null;
  let close: PtyShellSessionClose = { exitCode: 0, stderrText: "" };
  try {
    drive = await drivePty(deps, pre.pty, classified.startup);
  } catch (error) {
    drive = { kind: "failed", errors: [error] };
  } finally {
    try {
      interceptionFailure = await disposeInterceptionSafely(disposeInterception);
    } finally {
      close = await closeSessionSafely(deps.session);
    }
  }

  // Report in precedence order: drive (primary) -> interception teardown (secondary)
  // -> close copy. Any failure -> exit 1 (D104.J fail-closed).
  let driveFailed = false;
  if (drive.kind === "failed") {
    driveFailed = true;
    for (const error of drive.errors) {
      writeStderrSafely(context, `Error in PTY shell: ${formatErrorMessage(error)}\n`);
    }
  } else if (drive.disposeErrors.length > 0) {
    // Fail-closed (D104.J): a handler failure settled the fallback exit AND left
    // dispose errors -> a wrapper failure, never a clean success.
    driveFailed = true;
    for (const error of drive.disposeErrors) {
      writeStderrSafely(context, `Error tearing down PTY shell: ${formatErrorMessage(error)}\n`);
    }
  } else {
    // Clean completion: DISPLAY the inner shell's exit (D104.G), do NOT propagate.
    displayChildExit(context, drive.exit);
  }

  let interceptionFailed = false;
  if (interceptionFailure !== null) {
    interceptionFailed = true;
    writeStderrSafely(
      context,
      `Error tearing down PTY command interception: ${formatErrorMessage(interceptionFailure.error)}\n`,
    );
  }

  writeStderrSafely(context, close.stderrText);
  const closeFailed = close.exitCode !== 0;
  return driveFailed || interceptionFailed || closeFailed ? 1 : 0;
}

// ============================================================================
// Real deps + G3-backed session adapter (M G4 Step 3c-v, D104.C/F/N)
// ============================================================================
//
// These bind runPtyShell's injected seams to the real host: the in-file shell
// resolver, the pty-loader, the terminal bridge, a scoped signal cleanup, and a
// G3-backed PtyShellSession that reuses the shipped session machinery
// (startSessionOperation + the scoped teardown). The engine stays test-only
// until the guarded `--pty` path is wired (Step 3d/4) -- nothing public calls
// these.
//
// The session-refusal + teardown COPY is duplicated byte-for-byte from shell.ts
// (the established v1 pattern -- shell.ts itself duplicates run.ts's copy). A
// future cleanup extracts one shared copy module once PTY mode is wired and
// stable; until then the golden-string tests pin parity so the two commands'
// session copy cannot drift.

/** The lock command recorded for a PTY session (distinct from the REPL's). */
const PTY_LOCK_COMMAND = "viberevert shell --pty";

// --- session-refusal / teardown copy (byte-identical to shell.ts) ---

const repoRootNotFoundCopy = (): string =>
  "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\nRun `viberevert init` to create a project here.\n";

const configNotFoundCopy = (): string =>
  "No .viberevert.yml found in this repo.\nRun:\n  viberevert init\n\nto create one.\n";

const invalidConfigCopy = (message: string): string =>
  `Invalid .viberevert.yml: ${message}\nFix the file, or re-run:\n  viberevert init\n\nto start fresh.\n`;

/**
 * Sanitized refusal for a DEFENSIVE config-extraction failure: a hostile/fake
 * loader returning a non-object (null/array/scalar) or a throwing `commands`
 * getter. The real loadConfig never produces these (it returns a valid Config or
 * throws a typed ConfigNotFound/Parse/Validation error, which keep their own
 * copy), so this is a fail-closed boundary guard, not an "invalid YAML" case.
 */
const configLoadFailedCopy = (): string =>
  "The VibeRevert configuration could not be read while starting the PTY shell.\n" +
  "Use `viberevert shell` for the guarded command loop.\n";

/** The "session already active" block (Task line only when the lock has one). */
function sessionAlreadyActiveCopy(lock: SessionAlreadyActiveError["active"]): string {
  let text = "A session is already active in this repo.\n\n";
  text += `Session:     ${truncateIdForDisplay(lock.session_id)}\n`;
  text += `Started at:  ${lock.started_at}\n`;
  if (lock.task !== undefined) {
    text += `Task:        ${lock.task}\n`;
  }
  text += `Checkpoint:  ${truncateIdForDisplay(lock.checkpoint_id)}\n`;
  text += "\nUse:\n";
  text += "  viberevert sessions\n";
  text += "  viberevert end                                     (then start fresh)\n";
  text +=
    "  viberevert end && viberevert rollback <session>    (then discard that session's changes)\n";
  return text;
}

/** The "another operation is already running" block (with/without lock info). */
function concurrentOperationCopy(info: ConcurrentOperationError["info"]): string {
  return info !== null
    ? `Another viberevert operation is already running:\n  command:  ${info.command}\n  pid:      ${info.pid}\n  since:    ${info.started_at}\n\nIf you're sure that command isn't running anymore (e.g., crashed),\nremove this stale lock directory manually:\n  ${START_LOCK_REL}\n`
    : `Another viberevert operation is already running (lock metadata unavailable).\n\nIf you're sure no other viberevert command is running,\nremove this stale lock directory manually:\n  ${START_LOCK_REL}\n`;
}

// --- G3-backed session adapter ---

/**
 * The shipped session operations the adapter reuses (all-or-none injected). A
 * minimal STRUCTURAL surface -- only what the adapter reads -- so tests fake it
 * without reproducing the full ActiveSessionLock / operation-result schemas; the
 * real host functions still bind to it (REAL_G3_SESSION_OPS) by covariant
 * return / contravariant param.
 */
export interface G3BackedPtyShellSessionOps {
  readonly resolveRepoRoot: (cwd: string) => string;
  readonly loadConfig: (repoRoot: string) => Promise<Config>;
  readonly startSessionOperation: (input: {
    readonly cwd: string;
    readonly lockCommand: string;
    readonly task?: string;
    readonly loadedConfig?: Config;
  }) => Promise<{ readonly sessionId: string }>;
  readonly endSessionOperation: (input: { readonly cwd: string }) => Promise<unknown>;
  readonly loadActiveSessionLock: (
    repoRoot: string,
  ) => Promise<{ readonly session_id: string } | null>;
}

/** Real host binding of the session operations. */
const REAL_G3_SESSION_OPS: G3BackedPtyShellSessionOps = {
  resolveRepoRoot,
  loadConfig,
  startSessionOperation,
  endSessionOperation,
  loadActiveSessionLock,
};

/** Args for the G3-backed session adapter (ops default to the real host ops). */
export interface CreateG3BackedPtyShellSessionArgs {
  readonly cwd: string;
  readonly task?: string;
  readonly ops?: G3BackedPtyShellSessionOps;
}

/** Adapter state: prevents close-before-open, double-close, partial-open fuzz. */
type SessionState =
  | { readonly kind: "not_opened" }
  | {
      readonly kind: "opened";
      readonly repoRoot: string;
      readonly sessionId: string;
      readonly commandsPolicy: CommandsPolicyConfig | undefined;
    }
  | { readonly kind: "closed" };

/**
 * A PtyShellSession backed by the shipped G3 session machinery
 * (startSessionOperation + the scoped teardown). BOTH `open()` and `close()`
 * RETURN copy for `runPtyShell` to write. `open()` maps every start error to the
 * byte-identical G3 refusal text and is one-shot (a second open returns the same
 * session; after close it refuses). `close()` reproduces the G3 scoped-teardown
 * copy, performs the same scoped ownership check as the G3 shell teardown before
 * ending (the check->end window is not atomic), never throws, and is IDEMPOTENT:
 * only a close that reaches a TERMINAL outcome marks the adapter closed; a read
 * failure or an unknown end failure leaves it `opened` so a later close can retry.
 */
export function createG3BackedPtyShellSession(
  args: CreateG3BackedPtyShellSessionArgs,
): PtyShellSession {
  const { cwd } = args;
  const task = args.task;
  const ops = args.ops ?? REAL_G3_SESSION_OPS;
  let state: SessionState = { kind: "not_opened" };

  const open = async (): Promise<PtyShellSessionOpen> => {
    if (state.kind === "opened") {
      // One-shot: a repeat open returns the already-open session (no re-start,
      // no config reload) -- the policy captured at start is returned verbatim.
      return { kind: "opened", sessionId: state.sessionId, commandsPolicy: state.commandsPolicy };
    }
    if (state.kind === "closed") {
      return {
        kind: "refused",
        exitCode: 1,
        stderrText: "This PTY shell session adapter has already been closed.\n",
      };
    }

    let repoRoot: string;
    try {
      repoRoot = ops.resolveRepoRoot(cwd);
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        return { kind: "refused", exitCode: 1, stderrText: repoRootNotFoundCopy() };
      }
      throw err;
    }

    // Load the ONE config snapshot BEFORE starting the session: its command
    // policy is surfaced to the engine AND the exact object is threaded into
    // startSessionOperation (loadedConfig), so the session's rollback snapshot
    // and the guard policy derive from one on-disk read (M G4 4e-iv-a). Typed
    // parse/validation errors keep their existing copy; a DEFENSIVE extraction
    // failure (a hostile/fake loader returning a non-object, or a throwing
    // `commands` getter) fails closed -- no session is started.
    let config: Config;
    try {
      config = await ops.loadConfig(repoRoot);
    } catch (err) {
      if (err instanceof ConfigNotFoundError) {
        return { kind: "refused", exitCode: 1, stderrText: configNotFoundCopy() };
      }
      if (err instanceof ConfigParseError || err instanceof ConfigValidationError) {
        return { kind: "refused", exitCode: 1, stderrText: invalidConfigCopy(err.message) };
      }
      throw err;
    }
    let commandsPolicy: CommandsPolicyConfig | undefined;
    try {
      const rawConfig: unknown = config;
      if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
        return { kind: "refused", exitCode: 1, stderrText: configLoadFailedCopy() };
      }
      commandsPolicy = config.commands;
    } catch {
      return { kind: "refused", exitCode: 1, stderrText: configLoadFailedCopy() };
    }

    let sessionId: string;
    try {
      const started = await ops.startSessionOperation({
        cwd,
        lockCommand: PTY_LOCK_COMMAND,
        loadedConfig: config,
        ...(task !== undefined ? { task } : {}),
      });
      sessionId = started.sessionId;
    } catch (err) {
      if (err instanceof RuntimeEnvInvalidError) {
        return { kind: "refused", exitCode: 1, stderrText: `${err.message}\n` };
      }
      if (err instanceof SessionAlreadyActiveError) {
        return { kind: "refused", exitCode: 1, stderrText: sessionAlreadyActiveCopy(err.active) };
      }
      if (err instanceof ConcurrentOperationError) {
        return { kind: "refused", exitCode: 1, stderrText: concurrentOperationCopy(err.info) };
      }
      if (err instanceof RepoRootNotFoundError) {
        return { kind: "refused", exitCode: 1, stderrText: repoRootNotFoundCopy() };
      }
      if (err instanceof ConfigNotFoundError) {
        return { kind: "refused", exitCode: 1, stderrText: configNotFoundCopy() };
      }
      if (err instanceof ConfigParseError || err instanceof ConfigValidationError) {
        return { kind: "refused", exitCode: 1, stderrText: invalidConfigCopy(err.message) };
      }
      throw err;
    }

    // Commit the opened state ONLY after startSessionOperation succeeds; any
    // earlier refusal left `state` untouched (not_opened), so a retry is possible.
    state = { kind: "opened", repoRoot, sessionId, commandsPolicy };
    return { kind: "opened", sessionId, commandsPolicy };
  };

  const close = async (): Promise<PtyShellSessionClose> => {
    if (state.kind !== "opened") {
      // close-before-open or an idempotent repeat after a terminal close -> quiet.
      return { exitCode: 0, stderrText: "" };
    }
    const { repoRoot, sessionId } = state;

    let lock: Awaited<ReturnType<typeof ops.loadActiveSessionLock>>;
    try {
      lock = await ops.loadActiveSessionLock(repoRoot);
    } catch (err) {
      // Read failure: the session may still exist -> stay `opened` so a later
      // close can retry; surface the failure.
      return {
        exitCode: 1,
        stderrText: `Could not read the active session state while shutting down: ${formatErrorMessage(err)}\nIf a session is still active, close it manually with:\n  viberevert end\n`,
      };
    }

    if (lock === null) {
      state = { kind: "closed" };
      return {
        exitCode: 0,
        stderrText: "Note: the session was already ended; nothing to close.\n",
      };
    }
    if (lock.session_id !== sessionId) {
      state = { kind: "closed" };
      return {
        exitCode: 1,
        stderrText:
          "Warning: the active session belongs to a different session; leaving it untouched.\n",
      };
    }

    try {
      await ops.endSessionOperation({ cwd });
    } catch (err) {
      if (err instanceof NoActiveSessionError || err instanceof EndSessionRaceError) {
        state = { kind: "closed" };
        return {
          exitCode: 0,
          stderrText: `Note: the session was already ended before the shell could close it.\nSession: ${sessionId}\nNext: viberevert check --since ${sessionId}\n`,
        };
      }
      // Unknown end failure: the session may still exist -> stay `opened` for a
      // possible retry; surface the failure.
      return {
        exitCode: 1,
        stderrText: `The session could not be closed: ${formatErrorMessage(err)}\nClose it manually with:\n  viberevert end\n`,
      };
    }

    state = { kind: "closed" };
    return {
      exitCode: 0,
      stderrText: `Session: ${sessionId}\nNext: viberevert check --since ${sessionId}\n`,
    };
  };

  return { open, close };
}

// --- scoped signal cleanup ---

/** The signal-source surface `createScopedSignalCleanup` drives (process in prod). */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void;
  removeListener(signal: NodeJS.Signals, listener: () => void): void;
}

/**
 * Build a `withSignalCleanup` that installs SIGTERM + SIGHUP handlers for the
 * duration of `run()`, invokes `onSignal` AT MOST ONCE (single-shot), and
 * removes ONLY the handlers it actually installed, in a `finally`, whether
 * `run()` resolves or rejects. Installation is tracked so a partial install
 * (SIGTERM ok, SIGHUP throws) still removes what was installed; each removal is
 * best-effort so one throwing removal does not skip the other. A throwing
 * `onSignal` is swallowed so it cannot crash the handler or block removal. No
 * SIGINT (raw-mode Ctrl-C semantics are delicate -- deferred past live PTY
 * validation); never calls process.exit; touches no stdio. When used by
 * runPtyShell, `onSignal` disposes the bridge -> waitForExit settles the
 * fallback -> runPtyShell fails closed (exit 1).
 */
export function createScopedSignalCleanup(
  source: SignalSource = process,
): RunPtyShellDeps["withSignalCleanup"] {
  return async (onSignal, run) => {
    let fired = false;
    let sigtermInstalled = false;
    let sighupInstalled = false;

    const handler = (): void => {
      if (fired) {
        return;
      }
      fired = true;
      try {
        onSignal();
      } catch {
        // A failing onSignal must not crash the signal handler; teardown still
        // proceeds and the installed listeners are removed in the finally.
      }
    };

    try {
      source.on("SIGTERM", handler);
      sigtermInstalled = true;
      source.on("SIGHUP", handler);
      sighupInstalled = true;
      return await run();
    } finally {
      if (sigtermInstalled) {
        try {
          source.removeListener("SIGTERM", handler);
        } catch {
          // Best-effort cleanup.
        }
      }
      if (sighupInstalled) {
        try {
          source.removeListener("SIGHUP", handler);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  };
}

// --- real deps factory ---

/** Non-stream inputs the real-deps factory needs (cwd/env snapshot + task). */
export interface CreateRunPtyShellDepsOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly task?: string;
}

/** The (Clipanion-style) command context the factory adapts; streams cast here. */
export interface RunPtyShellFactoryContext {
  readonly stdin: unknown;
  readonly stdout: unknown;
  readonly stderr: { write(data: string): void };
}

/** True only when a stream structurally exposes `isTTY === true` (never throws). */
function hasTrueIsTty(stream: unknown): boolean {
  if ((typeof stream !== "object" && typeof stream !== "function") || stream === null) {
    return false;
  }
  try {
    return (stream as { readonly isTTY?: unknown }).isTTY === true;
  } catch {
    return false;
  }
}

/**
 * Bind runPtyShell's injected seams to the real host (M G4 Step 3c-v). The
 * tty.ReadStream/WriteStream casts live ONLY here; `hasInteractiveTty` is fully
 * defensive (a null/typeless stream, a missing `isTTY`, or a throwing getter all
 * yield false -- never throws). `spawnEnv` is a SNAPSHOT so the spawned child is
 * independent of later env mutation; shell RESOLUTION intentionally reads the
 * live host env via `resolveHostInteractiveShell()` (a one-shot synchronous
 * lookup at gate time -- and there is no env-snapshot host path resolver without
 * touching the Step-3b module). Still unwired: nothing public calls this until
 * Step 3d/4.
 */
export function createRunPtyShellDeps(
  context: RunPtyShellFactoryContext,
  options: CreateRunPtyShellDepsOptions,
): RunPtyShellDeps {
  const stdin = context.stdin as NodeJS.ReadStream;
  const stdout = context.stdout as NodeJS.WriteStream;
  const ptyContext: PtyShellContext = { stdin, stdout, stderr: context.stderr };

  const sessionArgs: CreateG3BackedPtyShellSessionArgs = {
    cwd: options.cwd,
    ...(options.task !== undefined ? { task: options.task } : {}),
  };

  return {
    context: ptyContext,
    hasInteractiveTty: () => hasTrueIsTty(context.stdin) && hasTrueIsTty(context.stdout),
    loadPtyModule,
    resolveHostShell: () => resolveHostInteractiveShell(),
    attachBridge: attachTerminalBridge,
    session: createG3BackedPtyShellSession(sessionArgs),
    installInterception: (args) =>
      installBashInterception(createBashInterceptionInstallerDeps(args)),
    cwd: options.cwd,
    spawnEnv: { ...options.env },
    withSignalCleanup: createScopedSignalCleanup(),
  };
}
