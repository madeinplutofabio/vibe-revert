// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive-shell resolver for `viberevert shell --pty` (M G4 Step 3, D104.N).
 *
 * PURE decision logic: given a platform, the relevant environment, and an
 * "is this executable available here?" probe, it returns which interactive
 * shell to spawn in the PTY -- WITHOUT spawning anything, touching the
 * terminal, reading the filesystem, or importing node-pty. Every host fact is
 * injected, so the core is fully deterministic and host-independent; the thin
 * wrapper that supplies the real `process.platform` / `process.env` and a PATH
 * probe lives with the PTY engine (where a filesystem PATH scan belongs), not
 * here.
 *
 * Selection order (D104.N):
 *   - Windows: `pwsh` if available, else `powershell.exe` if available, else
 *     `null`. NEVER `cmd.exe` -- PowerShell is a real modern interactive shell
 *     and (Step 4) exposes a clean pre-execution hook (PSReadLine); cmd.exe
 *     offers neither. `powershell.exe` (Windows PowerShell 5.1) is the reliable
 *     Windows fallback where available -- its hook works -- so it is used when
 *     `pwsh` (PowerShell 7) is absent.
 *   - POSIX: `$SHELL` when it is an ABSOLUTE path to an available executable,
 *     else `bash` if available, else `null`. A relative/bare `$SHELL` is
 *     rejected (we do not PATH-search or spawn an ambiguous value). `sh` is
 *     deliberately NOT a fallback: the guarded PTY (Step 4) needs a shell we
 *     can hook (bash DEBUG trap / PowerShell), which a bare POSIX `sh` (often
 *     dash) lacks -- an sh-only host reports "no suitable shell" so `--pty`
 *     refuses rather than opening an unguardable shell.
 *
 * `null` = "no suitable interactive shell here" -> the engine surfaces the
 * clear "PTY is unavailable" refusal (D104.A). `kind` classifies the family so
 * Step 4 can select AND gate its interception mechanism (only `powershell` and
 * `bash` are hookable in the first cut; a non-bash `posix` `$SHELL` is resolved
 * here but Step 4 refuses `--pty` on it until a per-shell hook lands). In Step
 * 3 `kind` is informational.
 *
 * Login/non-login is EXPLICIT: POSIX shells run NON-login interactive (`-i`)
 * -- the per-user interactive rc (e.g. ~/.bashrc) loads, a login profile does
 * not -- matching the embedded-terminal convention. PowerShell has no
 * login/non-login concept; profiles load (banner suppressed via `-NoLogo`).
 * Any interception-specific argument injection (an rc/profile shim) is a
 * Step-4 engine-layer concern layered on top of this result, NOT baked in here.
 */

/** Shell family -- Step 4 uses it to select AND gate its interception hook. */
export type ShellKind = "powershell" | "bash" | "posix";

/** The interactive shell to spawn: a spawnable file + interactive argv + family. */
export interface ResolvedShell {
  /** Executable to spawn: an absolute `$SHELL` path, or a PATH-resolved name. */
  readonly file: string;
  /** Interactive argv. Never a policy/interception shim (see the module docs). */
  readonly args: readonly string[];
  readonly kind: ShellKind;
}

/** The subset of the environment the resolver reads (index-signature-free). */
export interface ShellResolverEnv {
  readonly SHELL?: string;
}

/** Injected inputs -- all host access is passed in so the core stays pure. */
export interface ShellResolverInput {
  /** Usually `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Usually `process.env` (only `SHELL` is read). */
  readonly env: ShellResolverEnv;
  /**
   * "Is this executable resolvable/usable here?" Tests inject a deterministic
   * set; the host wrapper injects a real PATH/existence scan -- the core itself
   * does no filesystem access.
   */
  readonly isExecutableAvailable: (file: string) => boolean;
}

/**
 * Resolve the interactive shell for the PTY bridge, or `null` if none is
 * suitable here. Pure: no spawning, no terminal I/O, no filesystem, no
 * node-pty -- every host fact arrives through `input` (D104.N).
 */
export function resolveInteractiveShell(input: ShellResolverInput): ResolvedShell | null {
  if (input.platform === "win32") {
    return resolveWindowsShell(input.isExecutableAvailable);
  }
  return resolvePosixShell(input.env, input.isExecutableAvailable);
}

/** Windows: pwsh -> powershell.exe -> null. Never cmd.exe. */
function resolveWindowsShell(isAvailable: (file: string) => boolean): ResolvedShell | null {
  for (const file of ["pwsh", "powershell.exe"]) {
    if (isAvailable(file)) {
      return { file, args: ["-NoLogo"], kind: "powershell" };
    }
  }
  return null;
}

/** POSIX: usable absolute $SHELL -> bash -> null. Never sh (see module docs). */
function resolvePosixShell(
  env: ShellResolverEnv,
  isAvailable: (file: string) => boolean,
): ResolvedShell | null {
  const preferred = env.SHELL;
  if (preferred !== undefined && isAbsolutePosixPath(preferred) && isAvailable(preferred)) {
    return { file: preferred, args: ["-i"], kind: posixKind(preferred) };
  }
  if (isAvailable("bash")) {
    return { file: "bash", args: ["-i"], kind: "bash" };
  }
  return null;
}

/**
 * True only for an absolute POSIX path (leading `/`). A relative or bare
 * `$SHELL` is rejected -- the resolver will not PATH-search or spawn an
 * ambiguous value; it falls through to `bash` instead.
 */
function isAbsolutePosixPath(value: string): boolean {
  return value.startsWith("/");
}

/** Classify a resolved POSIX shell path: bash family vs everything else. */
function posixKind(file: string): ShellKind {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base === "bash" ? "bash" : "posix";
}
