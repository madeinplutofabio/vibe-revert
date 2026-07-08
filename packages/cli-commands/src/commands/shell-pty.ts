// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * PTY engine for `viberevert shell --pty` (M G4 Step 3c, D104.C/N).
 *
 * PIECE (i) -- host shell resolution. Bridges the pure shell resolver
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
 * name the OS/runtime might re-resolve differently (CWD / PATHEXT).
 *
 * This is the impure host seam (reads `process.platform` / `process.env`,
 * resolves via fs); deps are ALL-OR-NONE injectable so it is deterministically
 * unit-tested. Later 3c pieces add the PTY engine proper (`runPtyShell`) to this
 * file; per the locked boundaries it will reference node-pty ONLY via
 * `pty-loader`'s `loadPtyModule`, route all I/O through `this.context`, and
 * expose no env-flag escape hatch. Until the engine is wired (Step 4) this file
 * is reachable only by tests.
 */

import { createHostExecutablePathResolver } from "./executable-probe.js";
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
