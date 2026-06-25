// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { chmod, lstat, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKUP_FILE_PREFIX,
  detectHookManagers,
  formatBackupTimestamp,
  HOOK_SCRIPT_TEMPLATE,
  HookManagerIoError,
  MANAGED_BY_MARKER,
  MalformedPackageJsonError,
} from "@viberevert/adapters";
import { RepoRootNotFoundError, resolveRepoRoot } from "@viberevert/core";
import { Command, Option } from "clipanion";

import { writeFileAtomic } from "../atomic.js";
import { resolveNowForCliTimestamp } from "../runtime-env.js";

/**
 * `viberevert hook install` -- write .git/hooks/pre-commit per M F D98.X
 * validate-before-mutate sequence.
 *
 * Architectural locks (see docs/hook-contract.md and the M F plan):
 *
 *  1. NO child_process import (D98.M.1).
 *  2. NO @viberevert/checks import (D98.M.2) -- the on-disk hook SHELLS OUT
 *     to `viberevert check --staged`; this command does NOT link against the
 *     checks engine.
 *  3. NO LLM SDK import (D98.M.3).
 *  4. NO cross-command import (D98.M.12) -- does NOT import from
 *     commands/hook-uninstall.ts or commands/rollback.ts. Shared error class
 *     (UnsupportedGitHookLayoutError) is re-defined locally per D98.M.12;
 *     clock seam (resolveNowForCliTimestamp) comes from runtime-env.ts.
 *  5. ASCII-only at byte level (D98.M.13).
 *  6. Filesystem surface LOCKED (D98.M.6): exactly 10 source call sites --
 *     lstat(join(repoRoot, ".git")) x1, lstat(hooksDir) x2 (preflight +
 *     post-mkdir per D98.X), lstat(hookPath) x1, readFile(hookPath) x1,
 *     lstat(backupPath) x1, rename(hookPath, backupPath) x1, mkdir(hooksDir)
 *     x1, writeFileAtomic(hookPath) x1, chmod(hookPath) x1. No aliasing; no
 *     other fs calls; manager detection delegated to `@viberevert/adapters`.
 *  7. EXACTLY ONE import of HOOK_SCRIPT_TEMPLATE, MANAGED_BY_MARKER, and
 *     detectHookManagers (D98.M.8); EXACTLY ONE source call site
 *     `detectHookManagers(repoRoot)` in the execute path (one import does
 *     not prevent two calls).
 *  8. D98.X locked install order: resolve repo root -> validate .git is dir
 *     -> detect hook managers -> refuse on husky/lefthook/both/malformed JSON
 *     -> preflight lstat(hooksDir) (absent OR directory-OK, refuse otherwise)
 *     -> existing-hook lstat + regular-file marker check -> re-install OR
 *     --force/refuse branch -> backup-collision check -> rename-if-force ->
 *     write phase (mkdir-if-absent + post-mkdir lstat re-validation +
 *     writeFileAtomic + chmod, gated by D98.A11 flag-based pattern).
 *     Mutation happens ONLY in step 7+8; all refusals before that are
 *     side-effect-free.
 *  9. D98.A11 flag-based pattern: locked `let shouldWriteTemplate = false;
 *     let shouldChmod = false; ...` shape -- the chmod and writeFileAtomic
 *     each have exactly ONE source call site, gated by flags set in the
 *     branching logic. This is the canonical resolution for "single fs call
 *     site lock + multiple semantic branches" tension.
 * 10. Marker check (D98.A11): only marker-check regular files
 *     (lstat.isFile() === true). Line 2 of content (split on "\n") must
 *     EXACTLY equal MANAGED_BY_MARKER OR MANAGED_BY_MARKER + "\r" (narrow
 *     CRLF tolerance for CRLF-drifted hooks; D98.A11 byte-compare then
 *     triggers refresh to canonical LF).
 * 11. `--force` scope (D98.D): ONLY overrides existing-non-viberevert-hook
 *     refusal. Does NOT override husky/lefthook detection, .git layout,
 *     .git/hooks layout, malformed package.json, or HookManagerIoError
 *     refusals. Those are absolute.
 * 12. Clock seam (D98.H): backup timestamps source the Date via
 *     resolveNowForCliTimestamp() from runtime-env.ts (honors
 *     VIBEREVERT_TEST_FIXED_NOW). NEVER from new Date() directly; NEVER
 *     from commands/rollback.ts.
 * 13. All 8 file-local error classes are EXPORTED per D98.R so M G1 MCP
 *     `hook_install` tool wrappers can typed-catch them. Each carries
 *     readonly fields (no string-parsing required by downstream consumers).
 */

// ============================================================================
// File-local error classes (D98.R install: 8 classes, all exported)
// ============================================================================

/**
 * D98.V: thrown when <repoRoot>/.git is absent OR not a directory.
 * Re-defined locally per D98.M.12 cross-command-import lock -- NOT imported
 * from hook-uninstall.ts.
 */
export class UnsupportedGitHookLayoutError extends Error {
  readonly repoRoot: string;
  readonly signal: "not-found" | "regular-file" | "other";

  constructor(repoRoot: string, signal: "not-found" | "regular-file" | "other") {
    super(
      `Hook management requires a standard git repository layout (${join(
        repoRoot,
        ".git",
      )} must be a directory). Detected: ${signal}.\nGit worktrees and submodules use indirected hook directories that vibe-revert does not yet support in v0.7.0-beta. See docs/hook-contract.md for the deferred-feature note.`,
    );
    this.name = "UnsupportedGitHookLayoutError";
    this.repoRoot = repoRoot;
    this.signal = signal;
  }
}

/**
 * D98.X: thrown when <repoRoot>/.git/hooks exists but is not a directory.
 * Re-defined locally per D98.M.12 cross-command-import lock.
 */
export class UnsupportedGitHooksDirectoryError extends Error {
  readonly hooksDir: string;
  readonly signal: "regular-file" | "symbolic-link" | "other";

  constructor(hooksDir: string, signal: "regular-file" | "symbolic-link" | "other") {
    super(
      `Hook management requires .git/hooks to be a real directory at ${hooksDir}. Detected: ${signal}.\nShared-hooks-directory setups (where .git/hooks is a symlink to another location) are not supported in v0.7.0-beta. Manage the hook at the symlink target manually, or wait for M G/M H support.`,
    );
    this.name = "UnsupportedGitHooksDirectoryError";
    this.hooksDir = hooksDir;
    this.signal = signal;
  }
}

/**
 * D98.D: thrown when .git/hooks/pre-commit exists and is NOT viberevert-managed
 * (missing marker, non-regular inode), and --force is NOT set.
 */
export class ExistingNonViberevertHookError extends Error {
  readonly hookPath: string;
  readonly backupPath: string;

  constructor(hookPath: string, backupPath: string) {
    super(
      `Refusing to overwrite existing non-viberevert pre-commit hook at ${hookPath}.\nRe-run with --force to back it up to ${backupPath} and install the viberevert hook.`,
    );
    this.name = "ExistingNonViberevertHookError";
    this.hookPath = hookPath;
    this.backupPath = backupPath;
  }
}

/**
 * D98.B: thrown when ONLY husky is detected (lefthook absent).
 */
export class HuskyDetectedError extends Error {
  readonly signal: string;

  constructor(signal: string) {
    super(
      `Detected husky configuration (${signal}). vibe-revert does not install into husky-managed hooks in v0.7.0.\nManage your pre-commit through husky directly, or remove husky to let \`viberevert hook install\` manage \`.git/hooks/pre-commit\` standalone.\nIf you want vibe-revert to gate commits while keeping husky, add this line to your husky pre-commit:\n  viberevert check --staged`,
    );
    this.name = "HuskyDetectedError";
    this.signal = signal;
  }
}

/**
 * D98.B: thrown when ONLY lefthook is detected (husky absent).
 */
export class LefthookDetectedError extends Error {
  readonly signal: string;

  constructor(signal: string) {
    super(
      `Detected lefthook configuration (${signal}). vibe-revert does not install into lefthook-managed hooks in v0.7.0.\nManage your pre-commit through lefthook directly, or remove lefthook to let \`viberevert hook install\` manage \`.git/hooks/pre-commit\` standalone.\nIf you want vibe-revert to gate commits while keeping lefthook, add \`viberevert check --staged\` to your lefthook.yml pre-commit commands.`,
    );
    this.name = "LefthookDetectedError";
    this.signal = signal;
  }
}

/**
 * D98.B: thrown when BOTH husky and lefthook are detected. Renders husky's
 * locked refusal copy first, then a blank line, then lefthook's locked
 * refusal copy (D98.B both-detected behavior).
 */
export class HookManagersDetectedError extends Error {
  readonly huskySignal: string;
  readonly lefthookSignal: string;

  constructor(huskySignal: string, lefthookSignal: string) {
    const huskyMsg = new HuskyDetectedError(huskySignal).message;
    const lefthookMsg = new LefthookDetectedError(lefthookSignal).message;
    super(`${huskyMsg}\n\n${lefthookMsg}`);
    this.name = "HookManagersDetectedError";
    this.huskySignal = huskySignal;
    this.lefthookSignal = lefthookSignal;
  }
}

/**
 * D98.D: thrown when --force is set and the computed backup path already
 * exists (sub-second collision from a prior --force install in the same
 * second). User must remove or rename it before re-running.
 */
export class BackupCollisionError extends Error {
  readonly backupPath: string;

  constructor(backupPath: string) {
    super(
      `Existing backup file at ${backupPath} would be overwritten by this install. Remove or rename it first, then re-run \`viberevert hook install --force\`.`,
    );
    this.name = "BackupCollisionError";
    this.backupPath = backupPath;
  }
}

/**
 * Generic I/O wrap for lstat/readFile/rename/mkdir/writeFileAtomic/chmod
 * failures inside the install command. The command layer surfaces this via
 * handleKnownError() using D98.O's generic I/O refusal copy.
 */
export class HookInstallIoError extends Error {
  readonly op: "stat" | "read" | "rename" | "write" | "chmod" | "mkdir";
  readonly path: string;
  readonly underlyingMessage: string;

  constructor(
    op: "stat" | "read" | "rename" | "write" | "chmod" | "mkdir",
    path: string,
    underlyingMessage: string,
  ) {
    super(`Failed to ${op} at ${path}: ${underlyingMessage}.`);
    this.name = "HookInstallIoError";
    this.op = op;
    this.path = path;
    this.underlyingMessage = underlyingMessage;
  }
}

// ============================================================================
// Success stdout copy (D98.O verbatim)
// ============================================================================

function installSuccessMessage(hookPath: string): string {
  return `Wrote viberevert pre-commit hook at ${hookPath}.\nThe hook runs \`viberevert check --staged\` on every commit; vibe-revert's \`risk.block_on\` threshold (default: critical) determines what aborts the commit.\nTo bypass this hook for a single commit, use \`git commit --no-verify\`.\n`;
}

function alreadyInstalledMessage(hookPath: string): string {
  return `VibeRevert pre-commit hook already installed at ${hookPath} (byte-identical to current template; no changes needed).\n`;
}

function permissionsRefreshedMessage(hookPath: string): string {
  return `VibeRevert pre-commit hook already installed at ${hookPath} (byte-identical to current template; executable permissions refreshed).\n`;
}

function updatedMessage(hookPath: string): string {
  return `VibeRevert pre-commit hook updated at ${hookPath} (existing managed hook refreshed to current template).\n`;
}

// ============================================================================
// Helpers (local; not exported)
// ============================================================================

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Classify a successful lstat on .git into D98.V signal vocabulary.
 */
function classifyGitDirSignal(stat: {
  isDirectory(): boolean;
  isFile(): boolean;
}): "regular-file" | "other" | null {
  if (stat.isDirectory()) {
    return null; // OK, proceed
  }
  if (stat.isFile()) {
    return "regular-file";
  }
  return "other";
}

/**
 * Classify a successful lstat on .git/hooks into D98.X signal vocabulary.
 */
function classifyHooksDirSignal(stat: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): "regular-file" | "symbolic-link" | "other" | null {
  if (stat.isDirectory()) {
    return null; // OK, proceed
  }
  if (stat.isFile()) {
    return "regular-file";
  }
  if (stat.isSymbolicLink()) {
    return "symbolic-link";
  }
  return "other";
}

// ============================================================================
// HookInstallCommand
// ============================================================================

export class HookInstallCommand extends Command {
  static override paths = [["hook", "install"]];

  static override usage = Command.Usage({
    category: "Hook",
    description: "Install the viberevert pre-commit hook into .git/hooks/",
    details: `
      Writes a deterministic POSIX sh pre-commit hook that runs
      \`viberevert check --staged\` on every git commit.

      Refuses if husky or lefthook is detected (use those managers directly
      to invoke \`viberevert check --staged\`). Refuses if .git is not a
      directory (worktree/submodule layouts not supported in v0.7.0-beta).
      Refuses if an existing non-viberevert pre-commit hook is present
      unless --force is set (which backs the existing hook up to
      .git/hooks/pre-commit.viberevert-backup-<UTC>).

      Re-running against an existing viberevert-managed hook is safe and
      idempotent (D98.A11): byte-identical content with executable bits set
      is a no-op; non-executable repair is chmod-only; bytes-differ
      refreshes the file atomically.
    `,
    examples: [
      ["Install the hook in a clean repo", "viberevert hook install"],
      ["Back up an existing non-viberevert hook and install", "viberevert hook install --force"],
    ],
  });

  force = Option.Boolean("--force", false, {
    description: "Back up an existing non-viberevert pre-commit hook before installing.",
  });

  override async execute(): Promise<number> {
    try {
      return await this.executeUnwrapped();
    } catch (err) {
      return this.handleKnownError(err);
    }
  }

  private async executeUnwrapped(): Promise<number> {
    // -------------------------------------------------------------------------
    // Step 1: resolve repo root (D98.X step 1).
    // -------------------------------------------------------------------------
    const repoRoot = resolveRepoRoot();

    // -------------------------------------------------------------------------
    // Step 2: validate <repoRoot>/.git is a directory (D98.V).
    // D98.M.6 grep requires the literal `lstat(join(repoRoot, ".git")` form;
    // the named `gitPath` const is kept for error messages only.
    // -------------------------------------------------------------------------
    const gitPath = join(repoRoot, ".git");
    try {
      const stat = await lstat(join(repoRoot, ".git"));
      const layoutSignal = classifyGitDirSignal(stat);
      if (layoutSignal !== null) {
        throw new UnsupportedGitHookLayoutError(repoRoot, layoutSignal);
      }
    } catch (err) {
      if (err instanceof UnsupportedGitHookLayoutError) {
        throw err;
      }
      if (isEnoent(err)) {
        throw new UnsupportedGitHookLayoutError(repoRoot, "not-found");
      }
      throw new HookInstallIoError("stat", gitPath, toErrorMessage(err));
    }

    // -------------------------------------------------------------------------
    // Step 3: detect hook managers (D98.W). One call site (D98.M.8).
    // -------------------------------------------------------------------------
    const detection = await detectHookManagers(repoRoot);

    // -------------------------------------------------------------------------
    // Step 4: refuse on husky/lefthook/both (D98.B). NO .git/hooks touch yet.
    // -------------------------------------------------------------------------
    if (detection.husky.detected && detection.lefthook.detected) {
      throw new HookManagersDetectedError(detection.husky.signal, detection.lefthook.signal);
    }
    if (detection.husky.detected) {
      throw new HuskyDetectedError(detection.husky.signal);
    }
    if (detection.lefthook.detected) {
      throw new LefthookDetectedError(detection.lefthook.signal);
    }

    // -------------------------------------------------------------------------
    // Step 5: preflight lstat(hooksDir) (D98.X step 5). NO mutation.
    // -------------------------------------------------------------------------
    const hooksDir = join(repoRoot, ".git", "hooks");
    let hooksDirMissing = false;
    try {
      const stat = await lstat(hooksDir);
      const hooksSignal = classifyHooksDirSignal(stat);
      if (hooksSignal !== null) {
        throw new UnsupportedGitHooksDirectoryError(hooksDir, hooksSignal);
      }
    } catch (err) {
      if (err instanceof UnsupportedGitHooksDirectoryError) {
        throw err;
      }
      if (isEnoent(err)) {
        hooksDirMissing = true; // mkdir deferred to write phase per D98.X.
      } else {
        throw new HookInstallIoError("stat", hooksDir, toErrorMessage(err));
      }
    }

    // -------------------------------------------------------------------------
    // Step 6: existing-hook lstat + marker check + classify branch (D98.A11).
    // -------------------------------------------------------------------------
    const hookPath = join(hooksDir, "pre-commit");
    let existingHookStat: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      existingHookStat = await lstat(hookPath);
    } catch (err) {
      if (!isEnoent(err)) {
        throw new HookInstallIoError("stat", hookPath, toErrorMessage(err));
      }
    }

    let existingContent: Buffer | null = null;
    let markerMatches = false;
    if (existingHookStat?.isFile()) {
      try {
        existingContent = await readFile(hookPath);
      } catch (err) {
        throw new HookInstallIoError("read", hookPath, toErrorMessage(err));
      }
      const line2 = existingContent.toString("utf8").split("\n")[1];
      markerMatches = line2 === MANAGED_BY_MARKER || line2 === `${MANAGED_BY_MARKER}\r`;
    }

    // -------------------------------------------------------------------------
    // Step 7: branch into clean-install / re-install (D98.A11) / non-vr
    // (D98.D --force OR refuse). Set flags + successMessage per the locked
    // flag-based pattern; the single writeFileAtomic + chmod call sites at
    // the end of the write phase consume the flags.
    // -------------------------------------------------------------------------
    let shouldWriteTemplate = false;
    let shouldChmod = false;
    let successMessage: string;

    if (existingHookStat === null) {
      // 7a. Clean install -> write + chmod + clean-install success copy.
      shouldWriteTemplate = true;
      shouldChmod = true;
      successMessage = installSuccessMessage(hookPath);
    } else if (markerMatches) {
      // 7b. D98.A11 re-install: byte-compare via Buffer.equals (NOT string ===).
      // existingContent is guaranteed non-null here (markerMatches implies the
      // readFile succeeded above).
      const existing = existingContent as Buffer;
      const desired = Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8");
      if (existing.equals(desired)) {
        if (process.platform !== "win32" && (existingHookStat.mode & 0o111) === 0) {
          // 7b.i. Byte-identical AND non-executable on Unix -> chmod-only repair.
          shouldChmod = true;
          successMessage = permissionsRefreshedMessage(hookPath);
        } else {
          // 7b.ii. Byte-identical (executable Unix / any Windows) -> no-op.
          successMessage = alreadyInstalledMessage(hookPath);
        }
      } else {
        // 7b.iii. Bytes differ -> atomic refresh + chmod.
        shouldWriteTemplate = true;
        shouldChmod = true;
        successMessage = updatedMessage(hookPath);
      }
    } else {
      // 7c. Non-vr hook (regular file without marker OR non-regular inode).
      const now = new Date(resolveNowForCliTimestamp());
      const timestamp = formatBackupTimestamp(now);
      const backupPath = join(hooksDir, `${BACKUP_FILE_PREFIX}${timestamp}`);

      if (!this.force) {
        throw new ExistingNonViberevertHookError(hookPath, backupPath);
      }

      // --force: backup-collision check (D98.D + D98.I item 3).
      try {
        await lstat(backupPath);
        throw new BackupCollisionError(backupPath);
      } catch (err) {
        if (err instanceof BackupCollisionError) {
          throw err;
        }
        if (!isEnoent(err)) {
          throw new HookInstallIoError("stat", backupPath, toErrorMessage(err));
        }
        // ENOENT: good, proceed with rename.
      }

      try {
        await rename(hookPath, backupPath);
      } catch (err) {
        throw new HookInstallIoError("rename", hookPath, toErrorMessage(err));
      }

      // After backup: write fresh viberevert hook.
      shouldWriteTemplate = true;
      shouldChmod = true;
      successMessage = installSuccessMessage(hookPath);
    }

    // -------------------------------------------------------------------------
    // Step 8: write phase (D98.X step 8). Only reached on success path.
    // mkdir-if-absent + post-mkdir lstat re-validation + writeFileAtomic +
    // chmod, all gated by the flags set above. Each fs call has exactly ONE
    // source call site per D98.M.6 / D98.I.
    // -------------------------------------------------------------------------
    if (shouldWriteTemplate || shouldChmod) {
      if (hooksDirMissing) {
        try {
          await mkdir(hooksDir, { recursive: true });
        } catch (err) {
          throw new HookInstallIoError("mkdir", hooksDir, toErrorMessage(err));
        }
        // Post-mkdir lstat re-validation (D98.M.6 second lstat(hooksDir)).
        try {
          const stat = await lstat(hooksDir);
          const hooksSignal = classifyHooksDirSignal(stat);
          if (hooksSignal !== null) {
            throw new UnsupportedGitHooksDirectoryError(hooksDir, hooksSignal);
          }
        } catch (err) {
          if (err instanceof UnsupportedGitHooksDirectoryError) {
            throw err;
          }
          throw new HookInstallIoError("stat", hooksDir, toErrorMessage(err));
        }
      }

      if (shouldWriteTemplate) {
        try {
          await writeFileAtomic(hookPath, HOOK_SCRIPT_TEMPLATE);
        } catch (err) {
          throw new HookInstallIoError("write", hookPath, toErrorMessage(err));
        }
      }

      if (shouldChmod) {
        try {
          await chmod(hookPath, 0o755);
        } catch (err) {
          throw new HookInstallIoError("chmod", hookPath, toErrorMessage(err));
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 9: print success stdout. Exit 0.
    // -------------------------------------------------------------------------
    this.context.stdout.write(successMessage);
    return 0;
  }

  /**
   * Centralized typed-error -> stderr mapping (D98.Q). Mirrors prompt-fix.ts
   * handleKnownError pattern. Unknown errors are re-thrown so clipanion shows
   * a loud stack trace for diagnostic.
   */
  private handleKnownError(err: unknown): number {
    if (err instanceof RepoRootNotFoundError) {
      this.context.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (
      err instanceof UnsupportedGitHookLayoutError ||
      err instanceof UnsupportedGitHooksDirectoryError ||
      err instanceof ExistingNonViberevertHookError ||
      err instanceof HuskyDetectedError ||
      err instanceof LefthookDetectedError ||
      err instanceof HookManagersDetectedError ||
      err instanceof BackupCollisionError ||
      err instanceof HookInstallIoError
    ) {
      this.context.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (err instanceof MalformedPackageJsonError) {
      // D98.O requires the 2-line copy. hook-managers.ts carries only the first
      // line (it doesn't know the install context); the second line is added
      // here so the wire copy is verbatim D98.O and does NOT drift if a future
      // edit changes MalformedPackageJsonError.message.
      this.context.stderr.write(
        `Failed to parse package.json while checking for hook managers at ${err.path}: ${err.parseMessage}.\n` +
          "Refusing to install the hook because we cannot verify whether husky or lefthook is configured. Fix the JSON and re-run.\n",
      );
      return 1;
    }
    if (err instanceof HookManagerIoError) {
      // Imported from @viberevert/adapters per the D98.M.8 amendment; surfaced
      // through the same generic I/O refusal copy shape as HookInstallIoError.
      this.context.stderr.write(`${err.message}\n`);
      return 1;
    }
    // Unknown -> re-throw so clipanion shows the stack (loud failure).
    throw err;
  }
}
