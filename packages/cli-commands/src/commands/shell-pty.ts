// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * PTY engine for `viberevert shell --pty` (M G4 Step 3c, D104.C/N/G).
 *
 * Built incrementally across 3c pieces: host shell RESOLUTION
 * (`resolveHostInteractiveShell`) and the pre-spawn PRECONDITION gate
 * (`evaluatePtyPreconditions`) live here; the PTY lifecycle (spawn / raw
 * passthrough / resize / D104.I teardown) and `runPtyShell` follow. Until the
 * engine is wired behind the guarded `--pty` path (Step 3d/4) this file is
 * reachable only by tests.
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
 */

import { createHostExecutablePathResolver } from "./executable-probe.js";
import type { PtyModule } from "./pty-loader.js";
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
