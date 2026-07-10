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
 * dep); the real default-deps factory + the G3-backed session adapter follow in
 * 3c-v. Until the engine is wired behind the guarded `--pty` path (Step 3d/4)
 * this file is reachable only by tests.
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
 * locks; the real deps factory + G3-backed session adapter land in 3c-v.
 */

import { createHostExecutablePathResolver } from "./executable-probe.js";
import type { PtyDisposable, PtyModule, PtyProcess, PtySpawnOptions } from "./pty-loader.js";
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
    setRawMode(mode: boolean): void;
    on(event: "data", listener: (data: Buffer | string) => void): void;
    removeListener(event: "data", listener: (data: Buffer | string) => void): void;
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

    // Explicit teardown order: raw mode FIRST (most important), then listeners,
    // then subscriptions, then kill LAST. Each step is guarded by whether it was
    // actually wired and run best-effort by runCleanups.
    const ordered: (() => void)[] = [];
    if (rawRestoreNeeded) {
      ordered.push(() => stdin.setRawMode(previousRaw));
    }
    const stdinHandler = onStdinData;
    if (stdinHandler !== undefined) {
      ordered.push(() => stdin.removeListener("data", stdinHandler));
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
    stdin.on("data", onStdinData);

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
  | { readonly kind: "opened"; readonly sessionId: string }
  | { readonly kind: "refused"; readonly exitCode: number; readonly stderrText: string };

/**
 * The session lifecycle as an injected PORT. The real G3-backed adapter (start +
 * scoped teardown + the elaborate refusal copy) lands in 3c-v; `runPtyShell`
 * owns ALL user-visible output, so `open()` RETURNS refusal text rather than
 * writing it (D104.M.4: adapters return decisions/data, the runner writes).
 */
export interface PtyShellSession {
  /** Open the one session; `refused` carries copy for `runPtyShell` to write. */
  open(): Promise<PtyShellSessionOpen>;
  /** Scoped teardown: 0 on success, non-zero on teardown failure. Contract: never throws. */
  close(): Promise<number>;
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
  /** The one PTY session (G3-backed adapter in 3c-v). */
  readonly session: PtyShellSession;
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
 * Spawn the resolved shell, attach the bridge, wait for exit (through the signal
 * cleanup seam), then ALWAYS dispose. Returns a stable union instead of throwing
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
  shell: ResolvedInteractiveShell,
): Promise<DrivePtyResult> {
  let child: PtyProcess;
  try {
    // Copy the readonly args to a fresh array (no accidental mutation of the
    // resolved shell by a future spawn implementation).
    child = pty.spawn(shell.path, [...shell.args], createPtySpawnOptions(deps));
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

/** Close the session, mapping a broken `close()` contract to a safe exit 1. */
async function closeSessionSafely(
  session: PtyShellSession,
  context: PtyShellContext,
): Promise<number> {
  try {
    return await session.close();
  } catch (error) {
    writeStderrSafely(
      context,
      `Unexpected error closing PTY shell session: ${formatErrorMessage(error)}\n`,
    );
    return 1;
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

  // Session is open -> from here it is ALWAYS closed, whatever happens. drivePty
  // is designed not to throw, but runPtyShell is the outer boundary and must not
  // trust even its own helper -- so a stray throw still reaches the session close.
  let drive: DrivePtyResult;
  try {
    drive = await drivePty(deps, pre.pty, pre.shell);
  } catch (error) {
    drive = { kind: "failed", errors: [error] };
  }

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

  const closeCode = await closeSessionSafely(deps.session, context);
  const closeFailed = closeCode !== 0;
  return driveFailed || closeFailed ? 1 : 0;
}
