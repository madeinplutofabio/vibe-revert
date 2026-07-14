// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { constants as fsConstants } from "node:fs";
import { chmod, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { MaterializedInterceptionHook } from "./pty-interception-installer.js";

/**
 * Hook MATERIALIZATION fs seam (M G4 Step 4e-ii, D104.I). Writes the guarded bash
 * rc file the shell sources via `--rcfile` -- the deterministic UX prelude
 * (`PS1`/`PROMPT_COMMAND`) followed BYTE-EXACT by the 4d hook (nothing appended;
 * the DEBUG trap must install last) -- into a fresh PRIVATE per-session directory,
 * and returns its ABSOLUTE path + a once-only cleanup. The installer (4e-i)
 * consumes this as its injected `materializeHook`.
 *
 * Security posture: COLLISION-RESISTANT (a random `mkdtemp` directory is the
 * isolation, not the fixed file name), PRIVATE-BY-PERMISSIONS (dir 0700 + file
 * 0600 forced explicitly, so an extreme umask cannot loosen them), and FAIL-CLOSED
 * against a pre-existing or symlinked rc-file entry (`O_EXCL` + final-component
 * `O_NOFOLLOW`). It is NOT race-proof against a same-UID process manipulating
 * parent paths, and `O_NOFOLLOW` guards ONLY the final path component. Only a file
 * this invocation successfully opened may be unlinked on rollback, and a rollback
 * preserves the primary error. The `mkdtemp` return is validated to be a direct
 * child of the (absolute) root whose name is the prefix PLUS a non-empty suffix
 * before any further fs op.
 */

/** A complete-write file handle abstraction (the real binding delegates to node's FileHandle). */
export interface MaterializeFileHandle {
  chmod(mode: number): Promise<void>;
  /** Write the ENTIRE payload (real binding uses FileHandle.writeFile -- no partial writes). */
  writeFile(data: string): Promise<void>;
  close(): Promise<void>;
}

/** The injected filesystem seam. Real bindings by default; fakes drive the unit tests. */
export interface MaterializeFs {
  mkdtemp(prefix: string): Promise<string>;
  chmodDir(dirPath: string, mode: number): Promise<void>;
  openExclusive(filePath: string, mode: number): Promise<MaterializeFileHandle>;
  unlink(filePath: string): Promise<void>;
  rmdir(dirPath: string): Promise<void>;
}

/** Options for `materializeBashHook`. */
export interface MaterializeBashHookOptions {
  /** Base temp dir; must be absolute + non-blank if given. Defaults to resolve(os.tmpdir()). */
  readonly tmpRoot?: string;
  /** Injected fs seam (tests); defaults to the real node:fs/promises bindings. */
  readonly fs?: MaterializeFs;
}

const DIR_PREFIX = "viberevert-pty-";
const RC_FILE_NAME = "hook.rc";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** The exact deterministic prelude; the hook is concatenated verbatim after it. */
const RC_PRELUDE = "PS1='viberevert$ '\nPROMPT_COMMAND=\n";
/** NUL needle built at runtime (clear intent; no literal NUL escape in the source). */
const NUL_BYTE = String.fromCharCode(0);

// O_NOFOLLOW protects only the FINAL path component and is absent on Windows,
// where the bitwise OR coerces its `undefined` to 0 -- acceptable, since the
// guarded bash PTY is a POSIX-only runtime path.
const EXCLUSIVE_WRITE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

/** The real node:fs/promises seam (default; exported so tests can override `mkdtemp`). */
export function createMaterializeFs(): MaterializeFs {
  return {
    mkdtemp: (prefix) => mkdtemp(prefix),
    chmodDir: (dirPath, mode) => chmod(dirPath, mode),
    openExclusive: async (filePath, mode) => {
      const handle = await open(filePath, EXCLUSIVE_WRITE_FLAGS, mode);
      return {
        chmod: (m) => handle.chmod(m),
        writeFile: (data) => handle.writeFile(data, { encoding: "utf8" }),
        close: () => handle.close(),
      };
    },
    unlink: (filePath) => unlink(filePath),
    rmdir: (dirPath) => rmdir(dirPath),
  };
}

const realMaterializeFs = createMaterializeFs();

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Run one teardown step, swallowing any rejection so it never masks the primary error. */
async function bestEffort(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Cleanup is best-effort; a failing step must not replace the original error.
  }
}

/**
 * Materialize the guarded bash rc file. Rejects a blank/NUL-containing hook and a
 * non-absolute/blank `tmpRoot`. Order: mkdtemp -> validate-return -> chmod dir
 * 0700 -> exclusive+no-follow open -> chmod file 0600 -> full write -> close ->
 * return {rcPath, cleanup}. On any failure it closes the handle (if opened),
 * unlinks the rc file ONLY if this invocation opened it, removes the directory ONLY
 * if this invocation created it, then rethrows the ORIGINAL error. `cleanup` is
 * memoized, once-only, best-effort, and non-recursive (`rmdir`, not `rm -r`).
 */
export async function materializeBashHook(
  hookScript: string,
  options: MaterializeBashHookOptions = {},
): Promise<MaterializedInterceptionHook> {
  if (!isNonBlankString(hookScript) || hookScript.includes(NUL_BYTE)) {
    throw new Error("hookScript must be non-blank and contain no NUL bytes");
  }

  const { tmpRoot, fs = realMaterializeFs } = options;
  let root: string;
  if (tmpRoot === undefined) {
    root = resolve(tmpdir());
  } else if (isNonBlankString(tmpRoot) && isAbsolute(tmpRoot)) {
    root = resolve(tmpRoot);
  } else {
    throw new Error("tmpRoot must be an absolute non-blank path");
  }

  let dirCreated = false;
  let dirPath = "";
  let rcPath = "";
  let handle: MaterializeFileHandle | undefined;
  let fileOwned = false;

  try {
    const created = await fs.mkdtemp(join(root, DIR_PREFIX));
    const resolvedDir = resolve(created);
    const dirName = basename(resolvedDir);
    if (
      !isAbsolute(resolvedDir) ||
      dirname(resolvedDir) !== root ||
      !dirName.startsWith(DIR_PREFIX) ||
      dirName.length <= DIR_PREFIX.length
    ) {
      throw new Error("mkdtemp returned an invalid interception directory");
    }
    dirPath = resolvedDir;
    dirCreated = true;

    await fs.chmodDir(dirPath, DIR_MODE);

    rcPath = join(dirPath, RC_FILE_NAME);
    handle = await fs.openExclusive(rcPath, FILE_MODE);
    fileOwned = true;

    await handle.chmod(FILE_MODE);
    await handle.writeFile(RC_PRELUDE + hookScript);
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      const openHandle = handle;
      await bestEffort(() => openHandle.close());
    }
    if (fileOwned) {
      await bestEffort(() => fs.unlink(rcPath));
    }
    if (dirCreated) {
      await bestEffort(() => fs.rmdir(dirPath));
    }
    throw error;
  }

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      await bestEffort(() => fs.unlink(rcPath));
      await bestEffort(() => fs.rmdir(dirPath));
    })();
    return cleanupPromise;
  };

  return { rcPath, cleanup };
}
