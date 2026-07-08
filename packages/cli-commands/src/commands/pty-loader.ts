// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Graceful loader for the OPTIONAL native dependency `node-pty` (M G4, D104.D).
 *
 * This is the SOLE module in `cli-commands/src` that references node-pty
 * (D104.M.1): later `shell-pty.ts` imports only `loadPtyModule` from here,
 * never `node-pty` directly. The node-pty import is DYNAMIC and wrapped in
 * try/catch (D104.M.2) so a missing or unbuildable optional dependency
 * degrades to `null` instead of crashing CLI module load -- which is what
 * keeps `viberevert --help` and `viberevert shell` (the REPL) working when
 * node-pty is absent (install blast-radius containment, D104.D).
 *
 * node-pty ships bundled prebuilds and its build scripts stay ignored
 * (D104.M.6); this loader triggers no native build. The bare specifier
 * `"node-pty"` is imported normally -- its resolved JS shim (`lib/index.js`)
 * loads the native `.node` internally via node-gyp-build -- so we never
 * hardcode a resolved file path.
 *
 * Type boundary: node-pty ships types, but this loader intentionally exposes
 * only a LOCAL structural type (below) so the optional dependency does not leak
 * into generated declarations. `typeof import("node-pty")` would put the
 * optional package into `pty-loader.d.ts`, and TS consumers/tools could then
 * fail resolving node-pty when it is omitted or skipped on a platform even
 * though runtime stays safe. The structural type is the minimal surface Step 3
 * (`shell-pty.ts`) needs -- and it deliberately does NOT declare a `dispose()`
 * on the PTY itself (node-pty has none): disposables come from `onData`/
 * `onExit`, and the child is stopped via `kill()`.
 *
 * Interop note (verified on node-pty 1.1.0): under `await import("node-pty")` a
 * callable `spawn` appears on BOTH the module namespace and on `default` (the
 * CJS `module.exports`). `normalizePtyModule` tries `default` first, then the
 * namespace, each under a callable-`spawn` check, so either ESM<->CJS interop
 * shape is accepted and a present-but-broken module degrades to `null` rather
 * than crashing later.
 */

/** A subscription handle returned by node-pty's event methods. */
export interface PtyDisposable {
  dispose(): void;
}

/** The minimal live-PTY surface Step 3 drives (a subset of node-pty's `IPty`). */
export interface PtyProcess {
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): PtyDisposable;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): PtyDisposable;
}

/** The subset of node-pty spawn options Step 3 sets. */
export interface PtySpawnOptions {
  readonly name?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The minimal node-pty module surface (local structural type; see above). */
export interface PtyModule {
  spawn(file: string, args?: readonly string[], options?: PtySpawnOptions): PtyProcess;
}

/**
 * Performs the dynamic import of node-pty. Injectable so tests can drive the
 * absent (throws / rejects) and present (resolves) paths without depending on
 * whether node-pty is installed on the test host. The default performs the real
 * dynamic import of the bare `"node-pty"` specifier.
 */
export type PtyImporter = () => Promise<unknown>;

const importNodePty: PtyImporter = () => import("node-pty");

/**
 * Attempt to load the optional `node-pty` native module.
 *
 * Resolves to the module when node-pty is present AND exposes a callable
 * `spawn`; resolves to `null` when node-pty is absent, fails to load (missing
 * prebuild / native error), or lacks the expected API. NEVER rejects -- callers
 * treat `null` as "PTY is unavailable here" and surface the clear message.
 */
export async function loadPtyModule(
  importPty: PtyImporter = importNodePty,
): Promise<PtyModule | null> {
  let namespace: unknown;
  try {
    namespace = await importPty();
  } catch {
    return null;
  }
  return normalizePtyModule(namespace);
}

/**
 * Collapse the two possible ESM<->CJS interop shapes: node-pty's `spawn` may
 * sit under `default` (the CJS `module.exports`) or on the namespace directly.
 * Try `default` first, accepting it only if it exposes a callable `spawn`;
 * otherwise fall back to the namespace under the same check; return `null` if
 * neither qualifies.
 */
function normalizePtyModule(namespace: unknown): PtyModule | null {
  if (!isObjectLike(namespace)) {
    return null;
  }

  if ("default" in namespace) {
    const fromDefault = namespace.default;
    if (isPtyModule(fromDefault)) {
      return fromDefault;
    }
  }

  return isPtyModule(namespace) ? namespace : null;
}

/** True for values that can carry properties (objects and functions). */
function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/** Structural check: a usable node-pty module exposes a callable `spawn`. */
function isPtyModule(value: unknown): value is PtyModule {
  return isObjectLike(value) && "spawn" in value && typeof value.spawn === "function";
}
