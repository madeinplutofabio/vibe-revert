// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Executable path resolver + availability probe for the shell resolver
 * (M G4 Step 3b, D104.N).
 *
 * The pure resolver (`shell-resolver.ts`) stays free of `fs` / `process`; this
 * module owns the host seam that answers "where is this executable?" -- WITHOUT
 * spawning a process (no `which` / `where` / child_process).
 *
 * The PATH RESOLVER is the primary seam: `(file) => string | null` returns the
 * EXACT path that passed the executable check, so the PTY engine (Step 3c) can
 * spawn THAT resolved path rather than a bare name. Spawning a bare name would
 * let the OS/runtime re-resolve it with its own search semantics (current
 * directory, PATHEXT quirks) -- possibly diverging from what this module
 * approved. The boolean probe `(file) => boolean` is derived (`path !== null`)
 * and kept for the already-committed resolver's `isExecutableAvailable`
 * contract.
 *
 * Layers (each in pure + host form):
 *   - `createExecutablePathResolver(deps)` / `createExecutableProbe(deps)` --
 *     PURE factories. Given a platform, the relevant environment, and an
 *     injected `fileIsExecutable(path)` check, they do NO filesystem access
 *     themselves, so the PATH-scan logic is deterministic and unit-tested with
 *     fakes.
 *   - `createHostExecutablePathResolver()` / `createHostExecutableProbe()` --
 *     thin host wrappers binding the real `process.platform` / `process.env`
 *     and a real `fileIsExecutable` that requires a REGULAR FILE (Windows: the
 *     file exists; POSIX: exists AND carries the execute bit) -- never a
 *     directory.
 *
 * Accepted `file` shapes are exactly two: an ABSOLUTE path (checked directly)
 * or a BARE executable name (searched on PATH). On Windows "absolute" means
 * FULLY QUALIFIED (`C:\...`, UNC `\\server\share\...`, or `\\?\`-extended); a
 * Windows ROOT-RELATIVE path (`\Windows\...`, relative to the current drive --
 * not exact) resolves to `null`, as does a relative path WITH separators
 * (`./foo`, `bin/foo`, `bin\foo`).
 *
 * PATH scan (which-like, but PATH-only): a bare name is searched across each
 * `PATH` entry using PLATFORM-specific path semantics (`path.win32` /
 * `path.posix`, never host-default). EMPTY `PATH` entries are SKIPPED -- the
 * current directory is never implicitly searched (avoids the classic `::` /
 * trailing-`:` CWD-injection footgun). Windows env keys are read
 * case-tolerantly (`PATH`/`Path`/`path`, `PATHEXT`/`PathExt`/`pathext`) so a
 * copied/plain env object behaves like the live case-insensitive `process.env`;
 * POSIX reads `PATH` only (its environment is case-sensitive). On Windows the
 * bare name is tried first, then each `PATHEXT` extension -- leading-dot
 * normalized, de-duplicated, and skipped entirely when the name already carries
 * a known executable extension (so `powershell.exe` is never probed as
 * `powershell.exe.EXE`).
 */

import { accessSync, constants, statSync } from "node:fs";
import { posix as posixPath, win32 as winPath } from "node:path";

/** Windows executable extensions tried when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * PATH env-var keys to consult. Windows env is case-insensitive, so a copied
 * env object may carry any casing (`PATH`/`Path`/`path`); POSIX is
 * case-sensitive, so only `PATH` is honored there.
 */
const WINDOWS_PATH_KEYS = ["PATH", "Path", "path"] as const;
const POSIX_PATH_KEYS = ["PATH"] as const;
const PATHEXT_KEYS = ["PATHEXT", "PathExt", "pathext"] as const;

/** Injected inputs for the pure factories. */
export interface ExecutableProbeDeps {
  /** Usually `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Usually `process.env` (reads `PATH`, and `PATHEXT` on Windows). */
  readonly env: NodeJS.ProcessEnv;
  /**
   * "Does this exact path point at an executable REGULAR FILE?" Injected so the
   * core does no filesystem access -- tests supply a deterministic set; the host
   * wrapper supplies a real fs check.
   */
  readonly fileIsExecutable: (candidatePath: string) => boolean;
}

/**
 * Build a pure `resolveExecutablePath(file)` from injected host facts: returns
 * the EXACT path that passed `fileIsExecutable`, or `null`. No filesystem
 * access, no spawning -- PATH-scan decision logic only.
 */
export function createExecutablePathResolver(
  deps: ExecutableProbeDeps,
): (file: string) => string | null {
  const isWindows = deps.platform === "win32";
  const pathApi = isWindows ? winPath : posixPath;
  const pathDirs = readPath(deps.env, isWindows)
    .split(pathApi.delimiter)
    .filter((dir) => dir.length > 0); // skip empty entries -> never search CWD
  const windowsExts = isWindows ? parsePathExt(readPathExt(deps.env)) : [];

  return (file: string): string | null => {
    if (file.length === 0) {
      return null;
    }
    if (isDirectPath(file, isWindows, pathApi)) {
      return deps.fileIsExecutable(file) ? file : null;
    }
    if (pathApi.isAbsolute(file)) {
      // Absolute but not fully qualified (e.g. a Windows current-drive-relative
      // path like `\Windows\...`) -- not an exact path, so reject it.
      return null;
    }
    // Only bare names are PATH-searched; a relative path with separators
    // (./foo, bin/foo, bin\foo) is not joined onto every PATH entry.
    if (!isBareName(file, pathApi)) {
      return null;
    }
    const exts = isWindows ? extensionsForName(file, windowsExts) : [""];
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const candidate = pathApi.join(dir, file + ext);
        if (deps.fileIsExecutable(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  };
}

/**
 * Boolean availability probe, derived from the path resolver. Kept for the
 * resolver's `isExecutableAvailable: (file) => boolean` contract.
 */
export function createExecutableProbe(deps: ExecutableProbeDeps): (file: string) => boolean {
  const resolveExecutablePath = createExecutablePathResolver(deps);
  return (file) => resolveExecutablePath(file) !== null;
}

/**
 * The host path resolver: real `process` values + a real fs regular-file check.
 * This is the ONLY filesystem-touching part; the engine imports this to spawn
 * the exact approved path.
 */
export function createHostExecutablePathResolver(): (file: string) => string | null {
  const platform = process.platform;
  return createExecutablePathResolver({
    platform,
    env: process.env,
    fileIsExecutable: (candidatePath) =>
      platform === "win32" ? isWindowsExecutable(candidatePath) : isPosixExecutable(candidatePath),
  });
}

/** Host boolean probe, derived from the host path resolver. */
export function createHostExecutableProbe(): (file: string) => boolean {
  const resolveExecutablePath = createHostExecutablePathResolver();
  return (file) => resolveExecutablePath(file) !== null;
}

/** True only when `candidatePath` is an existing regular file (not a directory). */
function isRegularFile(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

/** Windows host check: a regular file at the path. */
function isWindowsExecutable(candidatePath: string): boolean {
  return isRegularFile(candidatePath);
}

/** POSIX host check: a regular file that also carries the execute permission. */
function isPosixExecutable(candidatePath: string): boolean {
  if (!isRegularFile(candidatePath)) {
    return false;
  }
  try {
    accessSync(candidatePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First defined value among `keys` in `env` (bracket access -- index sig). */
function readEnvValue(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Read PATH. Windows is case-insensitive (accept `PATH`/`Path`/`path`); POSIX
 * is case-sensitive, so only `PATH` is honored there.
 */
function readPath(env: NodeJS.ProcessEnv, isWindows: boolean): string {
  return readEnvValue(env, isWindows ? WINDOWS_PATH_KEYS : POSIX_PATH_KEYS) ?? "";
}

/** Read PATHEXT case-tolerantly (`PATHEXT`/`PathExt`/`pathext`; Windows-only). */
function readPathExt(env: NodeJS.ProcessEnv): string | undefined {
  return readEnvValue(env, PATHEXT_KEYS);
}

/**
 * A "direct" path is checked as-is rather than PATH-searched: any POSIX
 * absolute path, or a FULLY QUALIFIED Windows path. A Windows path that is
 * merely `isAbsolute` (e.g. the current-drive-relative `\Windows\...`) is NOT
 * direct -- it is not an exact path.
 */
function isDirectPath(
  file: string,
  isWindows: boolean,
  pathApi: typeof winPath | typeof posixPath,
): boolean {
  if (!pathApi.isAbsolute(file)) {
    return false;
  }
  return !isWindows || isFullyQualifiedWindowsPath(file);
}

/**
 * Fully qualified Windows path: drive-qualified (`C:\`), UNC (`\\server\share\`),
 * or `\\?\`-extended (drive or UNC). Excludes current-drive-relative paths like
 * `\Windows\...`.
 */
function isFullyQualifiedWindowsPath(file: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(file) ||
    /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(file) ||
    /^\\\\\?\\[A-Za-z]:[\\/]/.test(file) ||
    /^\\\\\?\\UNC\\[^\\/]+[\\/][^\\/]+[\\/]/.test(file)
  );
}

/** A bare name has no path separators (its basename equals itself). */
function isBareName(file: string, pathApi: typeof winPath | typeof posixPath): boolean {
  return file === pathApi.basename(file);
}

/** Parse `PATHEXT` into a leading-dot-normalized, de-duplicated (ci) list. */
function parsePathExt(pathext: string | undefined): readonly string[] {
  const seen = new Set<string>();
  const exts: string[] = [];
  for (const raw of (pathext ?? DEFAULT_PATHEXT).split(";")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const ext = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    const key = ext.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    exts.push(ext);
  }
  return exts;
}

/**
 * Windows extensions to try for `name`: the bare name first, then each PATHEXT
 * extension -- UNLESS the name already ends in a known executable extension, in
 * which case only the bare name is tried (no `foo.exe.EXE` duplicates).
 */
function extensionsForName(name: string, windowsExts: readonly string[]): readonly string[] {
  const lower = name.toLowerCase();
  const alreadyHasExt = windowsExts.some((ext) => lower.endsWith(ext.toLowerCase()));
  return alreadyHasExt ? [""] : ["", ...windowsExts];
}
