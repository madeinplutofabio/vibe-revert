// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Hook-manager detection module for M F's `viberevert hook install`.
 * Pure detection logic: scans the repo for husky/lefthook signals.
 * Returns BOTH managers' state -- the command layer decides whether to
 * throw HuskyDetectedError, LefthookDetectedError, or HookManagersDetectedError.
 *
 * Architectural locks (D98.W + D98.M.11):
 *
 *  1. Filesystem surface LOCKED (D98.M.11): exactly the patterns
 *     lstat(huskyDirPath) x1
 *     readFile(packageJsonPath) x1
 *     lstat(lefthookYmlPath) x1
 *     lstat(lefthookYamlPath) x1
 *     lstat(dotLefthookYmlPath) x1
 *     lstat(dotLefthookYamlPath) x1
 *     lstat(lefthookLocalYmlPath) x1
 *     No readdir, no stat, no write, no rename, no chmod, no unlink, no mkdir.
 *
 *  2. No child_process import (D98.M.1).
 *  3. No @viberevert/checks import (D98.M.2).
 *  4. No LLM SDK import (D98.M.3).
 *  5. ASCII-only at byte level (D98.M.13).
 *  6. No cross-command imports (D98.M.12) -- consumed only by hook-install.ts.
 *
 *  7. Independent fs signals per manager (D98.W algorithm). Husky and lefthook
 *     states accumulate independently; neither short-circuits the other. Early
 *     return only when BOTH are detected via filesystem signals (steps 1-2 of
 *     the algorithm) -- in that case package.json parse is skipped entirely
 *     (avoids spurious MalformedPackageJsonError when both managers already
 *     known from fs).
 *
 *  8. ENOENT-tolerant: missing signal files are silently treated as "signal
 *     absent". Non-ENOENT lstat/readFile failures (EACCES, EPERM, ELOOP, etc.)
 *     throw HookManagerIoError with op-tagged message; the command layer
 *     surfaces these through D98.O's locked generic I/O refusal copy via
 *     handleKnownError().
 *
 *  9. Malformed package.json throws MalformedPackageJsonError -- NEVER silently
 *     treated as "no managers detected". Protects users who DO have husky or
 *     lefthook configured but temporarily broken JSON from accidental hook
 *     overwrite.
 *
 * 10. package.json read happens AT MOST ONCE total -- the parsed object is
 *     reused across husky and lefthook dep-checks.
 *
 * 11. Detection-type asymmetry between husky and lefthook signals:
 *      - Husky's `.husky/` signal requires `stat.isDirectory()` because the
 *        locked signal label is literally ".husky/ directory". A regular file
 *        at `.husky` is NOT husky-managed.
 *      - Lefthook's file signals are EXISTENCE-BASED (any inode type counts).
 *        A symlinked lefthook config, weird-typed lefthook file, or repo-tool
 *        generated config path still triggers refusal. Bias: false positive
 *        refusal is safer than false negative direct-hook install over a
 *        user's lefthook setup.
 */

/**
 * Result of detection. Both husky and lefthook states are independent and
 * always present in the returned object; the command layer reads each to
 * decide which refusal class to throw.
 */
export interface HookManagerDetection {
  readonly husky: HookManagerState;
  readonly lefthook: HookManagerState;
}

/**
 * Either-or shape: detected with a first-match signal, OR not detected.
 * The `signal` string when detected matches the locked vocabulary in D98.O.
 */
export type HookManagerState =
  | { readonly detected: false }
  | { readonly detected: true; readonly signal: string };

/**
 * Thrown by detectHookManagers when package.json exists but is unparseable
 * JSON. The command layer surfaces this via handleKnownError() using the
 * locked D98.O MalformedPackageJsonError copy. NEVER silently treated as
 * "no managers detected".
 */
export class MalformedPackageJsonError extends Error {
  readonly path: string;
  readonly parseMessage: string;

  constructor(path: string, parseMessage: string) {
    super(
      `Failed to parse package.json while checking for hook managers at ${path}: ${parseMessage}.`,
    );
    this.name = "MalformedPackageJsonError";
    this.path = path;
    this.parseMessage = parseMessage;
  }
}

/**
 * Thrown by detectHookManagers on non-ENOENT lstat/readFile failures (EACCES,
 * EPERM, ELOOP, EIO, etc.). The command layer surfaces this via
 * handleKnownError() using D98.O's generic I/O refusal copy.
 *
 * `op` is one of "stat" | "read" -- only those two fs operations happen
 * inside this module per D98.M.11.
 */
export class HookManagerIoError extends Error {
  readonly op: "stat" | "read";
  readonly path: string;
  readonly underlyingMessage: string;

  constructor(op: "stat" | "read", path: string, underlyingMessage: string) {
    super(`Failed to ${op} at ${path}: ${underlyingMessage}.`);
    this.name = "HookManagerIoError";
    this.op = op;
    this.path = path;
    this.underlyingMessage = underlyingMessage;
  }
}

/**
 * Detect husky and/or lefthook in a repo.
 *
 * Algorithm (D98.W locked):
 *  1. lstat <repoRoot>/.husky -- if directory, husky detected.
 *  2. lstat each lefthook file signal in precedence order; existence wins
 *     (any inode type triggers detection -- see architectural lock #11).
 *  3. Early return if both detected via fs signals (skip package.json parse).
 *  4. readFile <repoRoot>/package.json (ENOENT silently allowed; non-ENOENT
 *     throws HookManagerIoError; JSON.parse failure throws
 *     MalformedPackageJsonError).
 *  5. If husky still undetected and package.json parsed: check pkg.husky key,
 *     then devDependencies.husky, then dependencies.husky (first match wins).
 *  6. If lefthook still undetected and package.json parsed: check
 *     devDependencies.lefthook, then dependencies.lefthook.
 *  7. Return { husky, lefthook }.
 *
 * package.json is read AT MOST ONCE total -- reused across steps 5+6.
 */
export async function detectHookManagers(repoRoot: string): Promise<HookManagerDetection> {
  // Path constants. Each gets its own const so D98.M.11 grep patterns
  // (lstat(huskyDirPath, lstat(lefthookYmlPath, etc.) match unambiguously.
  const huskyDirPath = join(repoRoot, ".husky");
  const lefthookYmlPath = join(repoRoot, "lefthook.yml");
  const lefthookYamlPath = join(repoRoot, "lefthook.yaml");
  const dotLefthookYmlPath = join(repoRoot, ".lefthook.yml");
  const dotLefthookYamlPath = join(repoRoot, ".lefthook.yaml");
  const lefthookLocalYmlPath = join(repoRoot, "lefthook-local.yml");
  const packageJsonPath = join(repoRoot, "package.json");

  // Step 1: husky fs signal (.husky/ directory). Requires isDirectory()
  // per architectural lock #11 -- the locked signal label is specifically
  // ".husky/ directory".
  let husky: HookManagerState = { detected: false };
  try {
    const stat = await lstat(huskyDirPath);
    if (stat.isDirectory()) {
      husky = { detected: true, signal: ".husky/ directory" };
    }
  } catch (err) {
    if (!isEnoent(err)) {
      throw new HookManagerIoError("stat", huskyDirPath, toErrorMessage(err));
    }
  }

  // Step 2: lefthook fs signals in precedence order. EXISTENCE-BASED per
  // architectural lock #11 -- any inode type (file, symlink, directory, etc.)
  // triggers detection. Safer to refuse on an unusual lefthook config than to
  // overwrite the user's lefthook setup. Each block is verbose-but-needed
  // because D98.M.11 grep requires the literal `lstat(<pathConst>` call site
  // to appear at the source level (a helper would hide the call sites).
  let lefthook: HookManagerState = { detected: false };

  if (!lefthook.detected) {
    try {
      await lstat(lefthookYmlPath);
      lefthook = { detected: true, signal: "lefthook.yml" };
    } catch (err) {
      if (!isEnoent(err)) {
        throw new HookManagerIoError("stat", lefthookYmlPath, toErrorMessage(err));
      }
    }
  }

  if (!lefthook.detected) {
    try {
      await lstat(lefthookYamlPath);
      lefthook = { detected: true, signal: "lefthook.yaml" };
    } catch (err) {
      if (!isEnoent(err)) {
        throw new HookManagerIoError("stat", lefthookYamlPath, toErrorMessage(err));
      }
    }
  }

  if (!lefthook.detected) {
    try {
      await lstat(dotLefthookYmlPath);
      lefthook = { detected: true, signal: ".lefthook.yml" };
    } catch (err) {
      if (!isEnoent(err)) {
        throw new HookManagerIoError("stat", dotLefthookYmlPath, toErrorMessage(err));
      }
    }
  }

  if (!lefthook.detected) {
    try {
      await lstat(dotLefthookYamlPath);
      lefthook = { detected: true, signal: ".lefthook.yaml" };
    } catch (err) {
      if (!isEnoent(err)) {
        throw new HookManagerIoError("stat", dotLefthookYamlPath, toErrorMessage(err));
      }
    }
  }

  if (!lefthook.detected) {
    try {
      await lstat(lefthookLocalYmlPath);
      lefthook = { detected: true, signal: "lefthook-local.yml" };
    } catch (err) {
      if (!isEnoent(err)) {
        throw new HookManagerIoError("stat", lefthookLocalYmlPath, toErrorMessage(err));
      }
    }
  }

  // Step 3: early return if both detected via fs signals -- skip package.json
  // parse entirely (avoids spurious MalformedPackageJsonError when both
  // managers are already known from filesystem evidence).
  if (husky.detected && lefthook.detected) {
    return { husky, lefthook };
  }

  // Step 4: readFile package.json (at most once). ENOENT -> no package.json,
  // continue with whatever state steps 1-2 produced. Non-ENOENT -> throw
  // HookManagerIoError. JSON.parse failure -> throw MalformedPackageJsonError.
  let pkg: unknown;
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    try {
      pkg = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedPackageJsonError(packageJsonPath, toErrorMessage(parseErr));
    }
  } catch (err) {
    if (err instanceof MalformedPackageJsonError) {
      throw err;
    }
    if (!isEnoent(err)) {
      throw new HookManagerIoError("read", packageJsonPath, toErrorMessage(err));
    }
    // ENOENT: pkg stays undefined; husky/lefthook stay at steps 1-2 state.
  }

  // Steps 5+6: package.json key + dep checks (only if pkg was parsed as an
  // object). Arrays, null, primitives all fall through to "no signals".
  if (typeof pkg === "object" && pkg !== null && !Array.isArray(pkg)) {
    const pkgObj = pkg as Record<string, unknown>;

    // Step 5: husky package.json signals, first-match-wins precedence.
    if (!husky.detected) {
      if (Object.hasOwn(pkgObj, "husky")) {
        husky = {
          detected: true,
          signal: "package.json `husky` key",
        };
      } else if (hasKey(pkgObj, "devDependencies", "husky")) {
        husky = {
          detected: true,
          signal: "package.json `husky` in devDependencies",
        };
      } else if (hasKey(pkgObj, "dependencies", "husky")) {
        husky = {
          detected: true,
          signal: "package.json `husky` in dependencies",
        };
      }
    }

    // Step 6: lefthook package.json signals, first-match-wins precedence.
    if (!lefthook.detected) {
      if (hasKey(pkgObj, "devDependencies", "lefthook")) {
        lefthook = {
          detected: true,
          signal: "package.json `lefthook` in devDependencies",
        };
      } else if (hasKey(pkgObj, "dependencies", "lefthook")) {
        lefthook = {
          detected: true,
          signal: "package.json `lefthook` in dependencies",
        };
      }
    }
  }

  return { husky, lefthook };
}

/**
 * Helper: ENOENT detection. Catches "no such file or directory" errors from
 * both lstat and readFile, regardless of whether they're NodeJS.ErrnoException
 * or a generic Error shape.
 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

/**
 * Helper: extract a string error message from any thrown value.
 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Helper: check whether pkg[topKey] is an object containing innerKey.
 * Returns false for non-object values, null, and arrays.
 */
function hasKey(pkg: Record<string, unknown>, topKey: string, innerKey: string): boolean {
  const top = pkg[topKey];
  return (
    typeof top === "object" && top !== null && !Array.isArray(top) && Object.hasOwn(top, innerKey)
  );
}
