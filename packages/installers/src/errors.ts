// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Base class + concrete subclasses for @viberevert/installers errors.
//
// Pattern:
//   - InstallerError is an abstract base extending Error. Subclasses
//     pass a stable kebab-case `code` string up to the base; this is
//     what gets surfaced as `reasonCode` in PreviewOutcome /
//     InstallOutcome / UninstallOutcome refusals. Class names are
//     developer-facing; codes are API/user-facing and must remain
//     stable.
//   - The base sets `this.name = new.target.name` so each subclass's
//     toString() shows the actual class name without each constructor
//     re-asserting it.
//   - `Object.setPrototypeOf(this, new.target.prototype)` fixes the
//     classic "instanceof returns false after transpilation" bug when
//     extending Error in TypeScript. Belt-and-braces for any future
//     compile target downgrade.
//   - Subclasses expose typed readonly fields for programmatic access
//     (engine code can read err.targetPath, err.sizeBytes, etc.
//     without parsing the message).
//   - Args passed as a single object literal (not positional) so
//     adding fields later doesn't break call sites.

/**
 * Base class for all errors thrown by @viberevert/installers.
 * Abstract — instantiate via concrete subclasses only.
 */
export abstract class InstallerError extends Error {
  readonly code: string;

  protected constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Refusal to write through a symlinked path component. Per D101.R,
 * the installer engine walks every existing path component from the
 * repo root down to the target and refuses if ANY existing component
 * (including the target itself) is a symlink. Carries the symlinked
 * component path for actionable diagnostics.
 *
 * code: "symlink-target-refusal"
 */
export class SymlinkTargetRefusal extends InstallerError {
  readonly targetPath: string;
  readonly symlinkedComponentPath: string;

  constructor(args: { targetPath: string; symlinkedComponentPath: string }) {
    super(
      `Refusing to write through a symlinked path component: ${args.symlinkedComponentPath} (target: ${args.targetPath}). VibeRevert installer never writes through symlinks.`,
      "symlink-target-refusal",
    );
    this.targetPath = args.targetPath;
    this.symlinkedComponentPath = args.symlinkedComponentPath;
  }
}

/**
 * Refusal to merge a target file larger than the limit (1 MiB per
 * D101.S). Config files are KB-scale; a multi-MB target is
 * overwhelmingly likely to be a misidentified non-config file.
 * Refusing prevents accidental mutation + unbounded memory use.
 *
 * code: "integration-target-too-large"
 */
export class IntegrationTargetTooLargeError extends InstallerError {
  readonly targetPath: string;
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(args: { targetPath: string; sizeBytes: number; limitBytes: number }) {
    super(
      `Target file at ${args.targetPath} is ${args.sizeBytes} bytes; merge operations refuse files larger than ${args.limitBytes} bytes (D101.S).`,
      "integration-target-too-large",
    );
    this.targetPath = args.targetPath;
    this.sizeBytes = args.sizeBytes;
    this.limitBytes = args.limitBytes;
  }
}

/**
 * Refusal to write to a target path that resolves outside the
 * repository root (or equals it). Per rule 14 (no global writes),
 * PathSpecSchema should already prevent these, but assertSafeTarget
 * is the last pre-mutation safety gate; refusing here defends against
 * caller bugs becoming global writes.
 *
 * code: "target-outside-repo-root"
 */
export class TargetOutsideRepoRootError extends InstallerError {
  readonly repoRoot: string;
  readonly targetPath: string;

  constructor(args: { repoRoot: string; targetPath: string }) {
    super(
      `Refusing unsafe target path: ${args.targetPath} is outside or equal to the repository root ${args.repoRoot}.`,
      "target-outside-repo-root",
    );
    this.repoRoot = args.repoRoot;
    this.targetPath = args.targetPath;
  }
}

/**
 * Refusal to operate on a target path that exists but is not a
 * regular file. Every installer target is file-shaped by design;
 * an existing directory, socket, FIFO, device, etc. at the target
 * is rejected explicitly here rather than allowed to fail later
 * with a generic filesystem error. Symlinks are refused earlier
 * (SymlinkTargetRefusal) so this only fires on the remaining
 * non-file kinds.
 *
 * code: "integration-target-not-file"
 */
export class IntegrationTargetNotFileError extends InstallerError {
  readonly targetPath: string;

  constructor(args: { targetPath: string }) {
    super(
      `Target path at ${args.targetPath} exists but is not a regular file; installer targets must be file-shaped.`,
      "integration-target-not-file",
    );
    this.targetPath = args.targetPath;
  }
}

/**
 * Refusal to operate on a target path whose existing parent
 * component is not a directory. Parent components must be
 * directories so the walk can descend into them and the engine can
 * ultimately create or read the target file. A regular file /
 * socket / FIFO / device at any non-final position in the path is
 * invalid for an installer target. Symlinked parents are refused
 * earlier (SymlinkTargetRefusal); ENOENT parents are allowed (the
 * engine will create them).
 *
 * code: "integration-target-parent-not-directory"
 */
export class IntegrationTargetParentNotDirectoryError extends InstallerError {
  readonly targetPath: string;
  readonly parentPath: string;

  constructor(args: { targetPath: string; parentPath: string }) {
    super(
      `Refusing target path ${args.targetPath}: existing parent component ${args.parentPath} is not a directory.`,
      "integration-target-parent-not-directory",
    );
    this.targetPath = args.targetPath;
    this.parentPath = args.parentPath;
  }
}

/**
 * Refusal to acquire the installer lock because the lock directory
 * already exists. Per D101.L, only one install/uninstall transaction
 * may run at a time per repo. The lock dir is created via atomic
 * mkdir, and pid.json inside the lock dir carries diagnostic
 * metadata. This error fires when mkdir fails because the lock dir
 * is present — either another transaction is in progress or a prior
 * run crashed.
 *
 * existingPid is populated when lock.ts successfully read+parsed
 * pid.json; if parsing fails, existingPid is undefined and the
 * caller is told to inspect the file manually. Parsing is not
 * required for the error to be useful.
 *
 * code: "integrations-lock-held"
 */
export class IntegrationsLockError extends InstallerError {
  readonly lockDir: string;
  readonly pidPath: string;
  readonly existingPid: number | undefined;

  constructor(args: { lockDir: string; pidPath: string; existingPid: number | undefined }) {
    const pidPart = args.existingPid !== undefined ? ` (pid ${args.existingPid})` : "";
    super(
      `Refusing to acquire installer lock: ${args.lockDir} already exists${pidPart}. ` +
        `Another install/uninstall may be in progress, or a prior run crashed. ` +
        `Inspect ${args.pidPath} and remove the lock dir manually if no other process is running.`,
      "integrations-lock-held",
    );
    this.lockDir = args.lockDir;
    this.pidPath = args.pidPath;
    this.existingPid = args.existingPid;
  }
}

/**
 * Refusal to proceed because one or more pending recovery journals
 * exist under .viberevert/integration-journal/. Per D101.M, each
 * installer transaction writes a journal entry BEFORE mutating
 * files and deletes it after committing. A pending journal indicates
 * a prior transaction did not complete cleanly.
 *
 * Per locked rule 7, Step 2 does NOT auto-recover — the user must
 * inspect each pending journal and remove it manually. The full list
 * of pending entries is exposed via the pendingEntries field so the
 * CLI can print actionable filenames without re-scanning. The array
 * is defensively copied at construction to prevent external mutation
 * from changing the error after the fact.
 *
 * code: "pending-integration-recovery"
 */
export class PendingIntegrationRecoveryError extends InstallerError {
  readonly journalDir: string;
  readonly pendingEntries: readonly string[];

  constructor(args: { journalDir: string; pendingEntries: readonly string[] }) {
    const pendingEntries = [...args.pendingEntries];
    const entryList = pendingEntries.map((e) => `  - ${JSON.stringify(e)}`).join("\n");
    super(
      `Refusing to proceed: ${pendingEntries.length} pending recovery journal(s) under ${args.journalDir}:\n` +
        entryList +
        `\nInspect each journal and remove it manually only after confirming no installer process is still running (Step 2 does not auto-recover).`,
      "pending-integration-recovery",
    );
    this.journalDir = args.journalDir;
    this.pendingEntries = pendingEntries;
  }
}

/**
 * Refusal to use a corrupted .viberevert/integrations.json file.
 * Covers BOTH JSON-parse failures (file is not valid JSON) AND
 * schema-validation failures (file is valid JSON but doesn't match
 * IntegrationsFileSchema). `reason` carries a human-readable
 * description composed by the caller (e.g., "JSON parse failed:
 * Unexpected token at offset 42" or "schema validation failed: ...").
 *
 * code: "integrations-corrupted"
 */
export class IntegrationsCorruptedError extends InstallerError {
  readonly path: string;
  readonly reason: string;

  constructor(args: { path: string; reason: string }) {
    super(
      `Refusing to use corrupted integrations file at ${args.path}: ${args.reason}`,
      "integrations-corrupted",
    );
    this.path = args.path;
    this.reason = args.reason;
  }
}

/**
 * Refusal to use an integrations file whose schemaVersion does not
 * match the current installer. Separate from
 * IntegrationsCorruptedError because the actionable advice differs:
 * a schema-version mismatch usually means the user's CLI is older
 * than the file's writer (or vice versa), not that the file itself
 * is broken. `foundVersion` is typed `unknown` because parsed JSON
 * can contain any JSON value (number, string, null, boolean, object,
 * array) — the diagnostic JSON.stringify handles all of those.
 *
 * code: "integrations-schema-version"
 */
export class IntegrationsSchemaVersionError extends InstallerError {
  readonly path: string;
  readonly foundVersion: unknown;
  readonly expectedVersion: number;

  constructor(args: { path: string; foundVersion: unknown; expectedVersion: number }) {
    super(
      `Refusing to use integrations file at ${args.path}: schemaVersion is ${JSON.stringify(args.foundVersion)}, expected ${args.expectedVersion}.`,
      "integrations-schema-version",
    );
    this.path = args.path;
    this.foundVersion = args.foundVersion;
    this.expectedVersion = args.expectedVersion;
  }
}

/**
 * Refusal to overwrite an existing backup file. Per the locked
 * backup discipline (D101.E + path-encode discussion), backup
 * writes use `wx`-style create-new semantics so a stale or
 * duplicate destination is a hard safety refusal, not a silent
 * last-writer-wins. Either the same backup is being attempted
 * twice (engine bug) or a prior crashed transaction left a backup
 * at this path.
 *
 * code: "backup-collision"
 */
export class BackupCollisionError extends InstallerError {
  readonly backupPath: string;

  constructor(args: { backupPath: string }) {
    super(
      `Refusing to overwrite existing backup at ${args.backupPath}. Backup destinations must not collide; either the same content is being backed up twice or a stale backup remains.`,
      "backup-collision",
    );
    this.backupPath = args.backupPath;
  }
}
