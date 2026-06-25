// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKUP_FILE_REGEX, MANAGED_BY_MARKER } from "@viberevert/adapters";
import { RepoRootNotFoundError, resolveRepoRoot } from "@viberevert/core";
import { Command, Option } from "clipanion";

/**
 * `viberevert hook uninstall` -- remove the viberevert-managed
 * .git/hooks/pre-commit hook per M F D98.X validate-before-mutate sequence.
 * With --restore, instead rename the most recent
 * pre-commit.viberevert-backup-<UTC> file back to .git/hooks/pre-commit.
 * The safety posture is best-effort validate-before-mutate; it is not a
 * cross-process lock. Specifically: the validate-and-then-mutate sequence
 * (final hookPath stat -> rm-managed-if-any -> rename -> chmod) can still
 * interleave with a concurrent process touching hookPath between steps.
 *
 * Architectural locks (see docs/hook-contract.md and the M F plan):
 *
 *  1. NO child_process import (D98.M.1).
 *  2. NO @viberevert/checks import (D98.M.2).
 *  3. NO LLM SDK import (D98.M.3).
 *  4. NO cross-command import (D98.M.12) -- does NOT import from
 *     commands/hook-install.ts. The two shared error classes
 *     (UnsupportedGitHookLayoutError, UnsupportedGitHooksDirectoryError) are
 *     re-defined locally per D98.M.12. The signal classifier helpers
 *     (classifyGitDirSignal, classifyHooksDirSignal) are similarly duplicated
 *     rather than shared. The `import type { Dirent, Stats }` from node:fs
 *     is type-only (erased at runtime), so it does not introduce an fs call
 *     site and does not affect the D98.M.7 surface count. Stats specifically
 *     pins TS to lstat's non-bigint overload so the metadata-fingerprint
 *     fields (dev/ino/size/mtimeMs/ctimeMs) stay strictly `number` rather
 *     than collapsing to `number | bigint` via Awaited<ReturnType<typeof
 *     lstat>>.
 *  5. ASCII-only at byte level (D98.M.13).
 *  6. Filesystem surface LOCKED (D98.M.7): exactly 9 fs source call sites
 *     across 8 operation patterns -- one .git-dir stat, one hooks-dir stat
 *     (D98.X uninstall does NOT mkdir, so no post-mkdir re-check), TWO
 *     hookPath stats (first for presence + marker check, second for --restore
 *     final collision guard -- intentionally two distinct call sites, not
 *     helper-abstracted), one hookPath read, one hookPath rm (default-
 *     uninstall AND --restore-rm-managed paths share the SAME call site via
 *     a shouldRm flag), one hooks-dir listing with locked file-type Dirent
 *     option (D98.M.7 separate grep enforces the token), one backup-to-
 *     hookPath rename, one hookPath chmod. No aliasing; no other fs calls
 *     (no mkdir, no unlink, no copyFile, no writeFile, no stat).
 *  7. EXACTLY ONE import of MANAGED_BY_MARKER (D98.M.8). HOOK_SCRIPT_TEMPLATE
 *     is NOT imported (uninstall does not write the template).
 *  8. D98.X locked uninstall order: resolve repo root -> validate .git is
 *     directory -> stat hooks-dir (ENOENT -> HookNotFoundError default /
 *     NoBackupsFoundError --restore; non-directory ->
 *     UnsupportedGitHooksDirectoryError; directory -> proceed) -> first
 *     hookPath stat + regular-file marker check (D98.A11 with CRLF
 *     tolerance) + capture currentManaged + currentHookFingerprint ->
 *     default-uninstall branch (rm-if-managed, refuse otherwise) OR
 *     --restore branch (D98.P).
 *  9. D98.P locked --restore order (validate-before-mutate, best-effort --
 *     not a cross-process lock): the managed hook is NEVER deleted before
 *     backup existence is proven. List hooks-dir -> filter via
 *     BACKUP_FILE_REGEX + sort descending -> if no candidates refuse
 *     NoBackupsFoundError with managed hook UNTOUCHED -> final collision
 *     guard via second hookPath stat metadata-fingerprint compare (dev +
 *     ino + size + mtimeMs + ctimeMs against the fingerprint captured at
 *     step 4 -- catches in-place modification that pure dev/ino compare
 *     would miss) -> rm-managed-if-present (the single shared call site)
 *     -> rename -> chmod gated on selectedDirent.isFile() (symlink-safe).
 * 10. Marker check (D98.A11): only marker-check regular files
 *     (lstat.isFile() === true). Line 2 of content (split on "\n") must
 *     EXACTLY equal MANAGED_BY_MARKER OR MANAGED_BY_MARKER + "\r" (narrow
 *     CRLF tolerance -- same rule as install per D98.P step 1, so a
 *     CRLF-drifted viberevert hook is still recognized as managed and
 *     removable).
 * 11. NO --force flag (D98.S). Refusing to remove hooks we did not write is
 *     the safety belt; an escape hatch defeats the belt. Users who want to
 *     nuke .git/hooks/pre-commit regardless of provenance can run `rm`
 *     themselves.
 * 12. Single-source-call-site flag pattern (mirrors D98.A11 install):
 *     shouldRm + restorePlan flags accumulate runtime intent; the rm,
 *     rename, and chmod calls each appear EXACTLY ONCE at the bottom of
 *     executeUnwrapped(), gated by the flags. This is the canonical
 *     resolution for "single fs call site lock + multiple semantic branches"
 *     tension and is what keeps D98.M.7 green.
 * 13. All 7 file-local error classes are EXPORTED per D98.R so M G1 MCP
 *     `hook_uninstall` tool wrappers can typed-catch them. Each carries
 *     readonly fields.
 */

// ============================================================================
// File-local error classes (D98.R uninstall: 7 classes, all exported)
// ============================================================================

/**
 * D98.V: thrown when <repoRoot>/.git is absent OR not a directory.
 * Re-defined locally per D98.M.12 cross-command-import lock -- NOT imported
 * from hook-install.ts.
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
 * Re-defined locally per D98.M.12.
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
 * Default uninstall (no --restore) found no pre-commit hook to remove.
 * --restore treats absence as valid per D98.P step 1 and proceeds to backup
 * lookup; this error is default-uninstall-only.
 */
export class HookNotFoundError extends Error {
  readonly hookPath: string;

  constructor(hookPath: string) {
    super(
      `No viberevert hook found at ${hookPath} (nothing to uninstall).\nIf ${hookPath} exists but is not viberevert-managed, leave it alone -- vibe-revert refuses to remove hooks it did not write.`,
    );
    this.name = "HookNotFoundError";
    this.hookPath = hookPath;
  }
}

/**
 * Found a pre-commit hook but it is not viberevert-managed. Covers BOTH
 * branches:
 *  (a) regular file with wrong or missing line-2 marker (readFile ran);
 *  (b) non-regular inode (symlink, directory, socket, fifo) where no
 *      readFile ran per D98.A11's regular-file-only rule.
 */
export class HookNotViberevertManagedError extends Error {
  readonly hookPath: string;

  constructor(hookPath: string) {
    super(
      `Pre-commit hook at ${hookPath} is not viberevert-managed (missing expected managed-by marker on line 2, or path is not a regular file). Refusing to remove it.\nIf this is a stale viberevert hook from a future version, remove it manually.`,
    );
    this.name = "HookNotViberevertManagedError";
    this.hookPath = hookPath;
  }
}

/**
 * --restore found no .git/hooks/pre-commit.viberevert-backup-* matching the
 * locked BACKUP_FILE_REGEX. Per D98.P validate-before-mutate, any current
 * managed hook is left UNTOUCHED so the user can re-run plain uninstall or
 * install.
 */
export class NoBackupsFoundError extends Error {
  readonly hooksDir: string;

  constructor(hooksDir: string) {
    super(
      `No backup files found matching \`pre-commit.viberevert-backup-*\` in ${hooksDir}. Nothing to restore.`,
    );
    this.name = "NoBackupsFoundError";
    this.hooksDir = hooksDir;
  }
}

/**
 * --restore cannot safely complete because the current pre-commit target
 * fails one of the validate-before-mutate guards:
 *  (a) pre-condition: a regular non-vr file OR a non-regular inode is at
 *      hookPath (we refuse rather than overwrite something we did not write);
 *  (b) race -- the hook was managed at the first stat but disappeared, was
 *      replaced, was modified in place (size/mtime/ctime changed), or had
 *      any of its metadata-fingerprint fields (dev + ino + size + mtimeMs
 *      + ctimeMs) change between the first stat and the final
 *      collision-guard stat;
 *  (c) race -- the hook was absent at the first stat but a concurrent
 *      process created something at hookPath before the final stat.
 * User must remove the offending path manually before re-running --restore.
 */
export class RestoreTargetExistsError extends Error {
  readonly hookPath: string;

  constructor(hookPath: string) {
    super(
      `Cannot restore safely: pre-commit target at ${hookPath} is not the same viberevert-managed hook validated earlier, or already exists and is not viberevert-managed. Remove it manually before \`viberevert hook uninstall --restore\`.`,
    );
    this.name = "RestoreTargetExistsError";
    this.hookPath = hookPath;
  }
}

/**
 * Generic I/O wrap for stat/read/rm/list/rename/chmod failures inside the
 * uninstall command. The command layer surfaces this via handleKnownError()
 * using D98.O's generic I/O refusal copy. NOTE: hooks-dir-listing ENOENT
 * specifically is reclassified as NoBackupsFoundError per D98.P step 2 --
 * so the "list" op only fires for non-ENOENT listing failures.
 */
export class HookUninstallIoError extends Error {
  readonly op: "stat" | "read" | "rm" | "list" | "rename" | "chmod";
  readonly path: string;
  readonly underlyingMessage: string;

  constructor(
    op: "stat" | "read" | "rm" | "list" | "rename" | "chmod",
    path: string,
    underlyingMessage: string,
  ) {
    super(`Failed to ${op} at ${path}: ${underlyingMessage}.`);
    this.name = "HookUninstallIoError";
    this.op = op;
    this.path = path;
    this.underlyingMessage = underlyingMessage;
  }
}

// ============================================================================
// Success stdout copy (D98.O verbatim)
// ============================================================================

function removedMessage(hookPath: string): string {
  return `Removed viberevert pre-commit hook at ${hookPath}.\n`;
}

function restoredMessage(backupPath: string, hookPath: string): string {
  return `Restored backup at ${backupPath} to ${hookPath} (most recent viberevert backup).\n`;
}

// ============================================================================
// Helpers (local; not exported; duplicated per D98.M.12)
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
 * Classify a successful stat on .git into D98.V signal vocabulary.
 * Duplicated from hook-install.ts per D98.M.12.
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
 * Classify a successful stat on .git/hooks into D98.X signal vocabulary.
 * Duplicated from hook-install.ts per D98.M.12.
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
// HookUninstallCommand
// ============================================================================

export class HookUninstallCommand extends Command {
  static override paths = [["hook", "uninstall"]];

  static override usage = Command.Usage({
    category: "Hook",
    description: "Remove the viberevert pre-commit hook from .git/hooks/",
    details: `
      Removes .git/hooks/pre-commit if it is viberevert-managed. Refuses to
      remove unknown hooks (no --force; that is the safety belt). Refuses if
      .git is not a directory (worktree/submodule layouts not supported in
      v0.7.0-beta).

      With --restore, instead restores the most recent
      pre-commit.viberevert-backup-<UTC> file to .git/hooks/pre-commit
      (lexicographic-descending sort under the locked
      pre-commit.viberevert-backup-YYYYMMDDTHHMMSSZ pattern). Per D98.P
      validate-before-mutate, the managed hook (if any) is NEVER deleted
      before the backup-existence check passes. The safety posture is
      best-effort validate-before-mutate; it is not a cross-process lock.
    `,
    examples: [
      ["Remove the viberevert pre-commit hook", "viberevert hook uninstall"],
      ["Restore the most recent backup", "viberevert hook uninstall --restore"],
    ],
  });

  restore = Option.Boolean("--restore", false, {
    description:
      "Restore the most recent pre-commit.viberevert-backup-<UTC> file to .git/hooks/pre-commit.",
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
    // Step 1: resolve repo root.
    // -------------------------------------------------------------------------
    const repoRoot = resolveRepoRoot();

    // -------------------------------------------------------------------------
    // Step 2: validate <repoRoot>/.git is a directory (D98.V). The inline-
    // join expression below (rather than reusing the gitPath const) is
    // required to match D98.M.7's locked source-form for the .git stat call
    // site.
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
      throw new HookUninstallIoError("stat", gitPath, toErrorMessage(err));
    }

    // -------------------------------------------------------------------------
    // Step 3: hooks-dir stat (D98.X uninstall). EXACTLY ONE source call site
    // per D98.M.7 (no post-mkdir re-check; uninstall never mkdirs). ENOENT
    // -> HookNotFoundError (default) / NoBackupsFoundError (--restore).
    // Present-but-not-directory -> UnsupportedGitHooksDirectoryError.
    // -------------------------------------------------------------------------
    const hooksDir = join(repoRoot, ".git", "hooks");
    const hookPath = join(hooksDir, "pre-commit");
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
        if (this.restore) {
          throw new NoBackupsFoundError(hooksDir);
        }
        throw new HookNotFoundError(hookPath);
      }
      throw new HookUninstallIoError("stat", hooksDir, toErrorMessage(err));
    }

    // -------------------------------------------------------------------------
    // Step 4: hookPath stat source call site #1 (D98.M.7 allows exactly TWO
    // distinct stat calls on hookPath; this is the first). Presence check +
    // regular-file marker check (D98.A11 with CRLF tolerance) + capture
    // currentManaged + currentHookFingerprint (dev + ino + size + mtimeMs +
    // ctimeMs) for the --restore final-collision-guard branch. The
    // fingerprint is stronger than dev+ino alone: it catches in-place
    // modification (truncate-and-overwrite, vi `:wq` style edits) that
    // preserves the inode but changes content. Caveat: on filesystems with
    // second-resolution mtime (older ext, FAT, some SMB shares), two stats
    // within the same wall-clock second see identical mtimeMs (.000) even
    // after a rewrite -- the size field then carries most of the signal in
    // that case. The fingerprint is best-effort; not a cross-process lock.
    // -------------------------------------------------------------------------
    let currentManaged = false;
    let currentHookFingerprint: {
      dev: number;
      ino: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    } | null = null;
    let existingHookStat: Stats | null = null;
    try {
      existingHookStat = await lstat(hookPath);
    } catch (err) {
      if (!isEnoent(err)) {
        throw new HookUninstallIoError("stat", hookPath, toErrorMessage(err));
      }
      // ENOENT: existingHookStat stays null.
    }

    if (existingHookStat?.isFile()) {
      let content: Buffer;
      try {
        content = await readFile(hookPath);
      } catch (err) {
        throw new HookUninstallIoError("read", hookPath, toErrorMessage(err));
      }
      const line2 = content.toString("utf8").split("\n")[1];
      const markerMatches = line2 === MANAGED_BY_MARKER || line2 === `${MANAGED_BY_MARKER}\r`;
      if (markerMatches) {
        currentManaged = true;
        currentHookFingerprint = {
          dev: existingHookStat.dev,
          ino: existingHookStat.ino,
          size: existingHookStat.size,
          mtimeMs: existingHookStat.mtimeMs,
          ctimeMs: existingHookStat.ctimeMs,
        };
      }
    }
    // Non-regular existingHookStat (symlink, directory, socket, fifo) leaves
    // currentManaged=false per D98.A11's regular-file-only rule -- we did NOT
    // read the file.

    // -------------------------------------------------------------------------
    // Step 5: branch into default-uninstall OR --restore. Each branch sets
    // flags (shouldRm + restorePlan) plus successMessage; the actual rm /
    // rename / chmod calls happen ONCE at the bottom of this method, gated
    // by the flags. This keeps each fs call at exactly one source call site
    // per D98.M.7 (the canonical resolution for the "single call site lock
    // + multiple semantic branches" tension; mirrors D98.A11 in install).
    // -------------------------------------------------------------------------
    let shouldRm = false;
    let restorePlan: { backupPath: string; shouldChmod: boolean } | null = null;
    let successMessage: string;

    if (!this.restore) {
      // ---- Default uninstall ----
      if (existingHookStat === null) {
        throw new HookNotFoundError(hookPath);
      }
      if (!currentManaged) {
        throw new HookNotViberevertManagedError(hookPath);
      }
      shouldRm = true;
      successMessage = removedMessage(hookPath);
    } else {
      // ---- --restore (D98.P validate-before-mutate, best-effort) ----

      // Step 5.a: pre-condition guard. A non-vr current pre-commit (regular
      // file without marker, OR any non-regular inode) refuses immediately.
      // Managed-or-absent both proceed to backup lookup.
      if (existingHookStat !== null && !currentManaged) {
        throw new RestoreTargetExistsError(hookPath);
      }

      // Step 5.b (D98.P step 2): hooks-dir listing with locked file-type
      // Dirent option. ENOENT specifically reclassifies to NoBackupsFoundError
      // per D98.P (the hooks dir went away post-step-3; treat as "no
      // backups" rather than HookUninstallIoError).
      //
      // Typed as Dirent[] explicitly (NOT Awaited<ReturnType<typeof readdir>>)
      // because the directory-listing call has multiple typed overloads
      // (string names, Buffer names, Dirent objects, Dirent<Buffer> objects)
      // and the inferred ReturnType collapses to their union -- TS could
      // pick the wrong arm and lose .name / .isFile(). The `import type
      // { Dirent }` from node:fs is type-only and does NOT count toward
      // D98.M.7's fs-call-site budget.
      let entries: Dirent[];
      try {
        entries = await readdir(hooksDir, { withFileTypes: true });
      } catch (err) {
        if (isEnoent(err)) {
          throw new NoBackupsFoundError(hooksDir);
        }
        throw new HookUninstallIoError("list", hooksDir, toErrorMessage(err));
      }

      // Step 5.c (D98.P step 3+4): filter via strict BACKUP_FILE_REGEX + sort
      // descending by name (= chronological descending under the locked
      // YYYYMMDDTHHMMSSZ format). Malformed entries are SILENTLY excluded.
      const backupCandidates = entries
        .filter((e) => BACKUP_FILE_REGEX.test(e.name))
        .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

      // Step 5.d (D98.P step 5): no candidates -> refuse with managed hook
      // UNTOUCHED. This is the validate-before-mutate safety guarantee.
      const selected = backupCandidates[0];
      if (!selected) {
        throw new NoBackupsFoundError(hooksDir);
      }
      const selectedBackupPath = join(hooksDir, selected.name);

      // Step 5.e (D98.P step 6): hookPath stat source call site #2 -- final
      // collision guard against concurrent process creating/replacing/
      // mutating the pre-commit between step 4 and now. D98.M.7 allows
      // exactly TWO distinct stat calls on hookPath; this is the second.
      let finalHookStat: Stats | null = null;
      try {
        finalHookStat = await lstat(hookPath);
      } catch (err) {
        if (!isEnoent(err)) {
          throw new HookUninstallIoError("stat", hookPath, toErrorMessage(err));
        }
        // ENOENT: finalHookStat stays null.
      }

      if (currentManaged) {
        // Step 4 captured a metadata fingerprint; the file MUST still match
        // it now (dev + ino + size + mtimeMs + ctimeMs). Absent, replaced,
        // or modified in place -> race condition -> refuse. Catches in-place
        // edits that preserve inode but change content (which a pure
        // dev/ino check would silently accept).
        if (
          finalHookStat === null ||
          currentHookFingerprint === null ||
          finalHookStat.dev !== currentHookFingerprint.dev ||
          finalHookStat.ino !== currentHookFingerprint.ino ||
          finalHookStat.size !== currentHookFingerprint.size ||
          finalHookStat.mtimeMs !== currentHookFingerprint.mtimeMs ||
          finalHookStat.ctimeMs !== currentHookFingerprint.ctimeMs
        ) {
          throw new RestoreTargetExistsError(hookPath);
        }
        shouldRm = true;
      } else {
        // Step 4 saw the path absent; step 5.e must also see it absent. Any
        // appearance now means a concurrent process created the file.
        if (finalHookStat !== null) {
          throw new RestoreTargetExistsError(hookPath);
        }
      }

      restorePlan = { backupPath: selectedBackupPath, shouldChmod: selected.isFile() };
      successMessage = restoredMessage(selectedBackupPath, hookPath);
    }

    // -------------------------------------------------------------------------
    // Step 6: mutation phase (D98.P steps 7+8+9). Each fs call has exactly
    // ONE source call site per D98.M.7. Runtime ordering: rm-managed-if-any
    // (always before rename so the rename target slot is empty), then
    // rename-if-restore, then chmod-if-restore-and-regular-backup. NOTE: the
    // safety posture is best-effort validate-before-mutate; it is not a
    // cross-process lock -- a concurrent process touching hookPath between
    // any two of these steps is not prevented.
    // -------------------------------------------------------------------------
    if (shouldRm) {
      try {
        await rm(hookPath);
      } catch (err) {
        throw new HookUninstallIoError("rm", hookPath, toErrorMessage(err));
      }
    }

    if (restorePlan) {
      // Destructure to a local `backupPath` so the backup-to-hookPath rename
      // call site below matches D98.M.7's locked source-form (member-access
      // against restorePlan would not match the locked grep pattern).
      const { backupPath, shouldChmod } = restorePlan;
      try {
        await rename(backupPath, hookPath);
      } catch (err) {
        throw new HookUninstallIoError("rename", backupPath, toErrorMessage(err));
      }
      if (shouldChmod) {
        try {
          await chmod(hookPath, 0o755);
        } catch (err) {
          throw new HookUninstallIoError("chmod", hookPath, toErrorMessage(err));
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 7: print success stdout. Exit 0.
    // -------------------------------------------------------------------------
    this.context.stdout.write(successMessage);
    return 0;
  }

  /**
   * Centralized typed-error -> stderr mapping (D98.Q). Mirrors prompt-fix.ts
   * + hook-install.ts handleKnownError pattern. Unknown errors are re-thrown
   * so clipanion shows a loud stack trace for diagnostic.
   */
  private handleKnownError(err: unknown): number {
    if (err instanceof RepoRootNotFoundError) {
      this.context.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (
      err instanceof UnsupportedGitHookLayoutError ||
      err instanceof UnsupportedGitHooksDirectoryError ||
      err instanceof HookNotFoundError ||
      err instanceof HookNotViberevertManagedError ||
      err instanceof NoBackupsFoundError ||
      err instanceof RestoreTargetExistsError ||
      err instanceof HookUninstallIoError
    ) {
      this.context.stderr.write(`${err.message}\n`);
      return 1;
    }
    // Unknown -> re-throw so clipanion shows the stack (loud failure).
    throw err;
  }
}
