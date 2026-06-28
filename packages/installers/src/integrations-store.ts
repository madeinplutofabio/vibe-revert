// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Durable store I/O for .viberevert/integrations.json per D101.C.
//
// readIntegrationsFile(repoRoot) -> IntegrationsFile | null
//   - .viberevert/ ENOENT → null (no file to read)
//   - .viberevert/ symlink/non-dir → typed safety refusal
//   - integrations.json ENOENT → null
//   - integrations.json symlink → SymlinkTargetRefusal
//   - integrations.json non-file → IntegrationTargetNotFileError
//   - JSON.parse fail → IntegrationsCorruptedError
//   - root not an object (null, array, string, etc.) → IntegrationsCorruptedError
//   - schemaVersion missing or != 1 → IntegrationsSchemaVersionError
//   - schema.parse fail → IntegrationsCorruptedError
//   - else → validated IntegrationsFile
//
// Classification policy (sharp lines):
//   - invalid JSON                       → IntegrationsCorruptedError
//   - JSON root not an object            → IntegrationsCorruptedError
//   - object root, schemaVersion not 1   → IntegrationsSchemaVersionError
//     (covers missing / null / string / 2 / etc.)
//   - object root, schemaVersion === 1
//     but bad shape                      → IntegrationsCorruptedError
//
// writeIntegrationsFile({ repoRoot, next, backupGroupId }) -> void
//   - Validate `next` with IntegrationsFileSchema.parse BEFORE any disk touch.
//   - Validate `backupGroupId` with local BackupGroupIdSchema (length-
//     bounded, no control chars, no path separators, no ':', no leading
//     '~', no "." / "..", no Windows reserved device names (CON, PRN,
//     AUX, NUL, COM1-9, LPT1-9 -- WITH OR WITHOUT extensions, since
//     Win32 treats `CON.txt` the same as `CON`), no trailing dot or
//     space (Win32 silently strips them, causing collisions)).
//   - Ensure .viberevert/ exists as a real directory (lstat-guard
//     + mkdir-if-absent + EEXIST race re-guard).
//   - If integrations.json already exists:
//       * lstat-guard it (regular file, not symlink, not other kind).
//       * Read its raw BYTES (Buffer, no UTF-8 decode) so corrupt or
//         non-UTF-8 content is preserved exactly in the backup --
//         readFile with "utf8" would silently transform invalid
//         sequences and lose crash evidence.
//       * Ensure the 3-level backup chain safely:
//           integration-backups/
//           integration-backups/__store__/
//           integration-backups/__store__/<backupGroupId>/
//       * Write the backup via writeFile(..., { flag: "wx" }) so a
//         stale or duplicate backup destination is a hard refusal
//         (BackupCollisionError), not silent overwrite.
//   - Atomic write of new integrations.json via writeFileAtomic
//     (rendered via prettyJson -- inherits canonical-json's strict
//     input validation).
//
// No stale cleanup on later failure: if the backup write succeeds
// and the final writeFileAtomic fails, the backup IS LEFT IN PLACE
// as crash evidence. The next install/uninstall can use it for
// manual recovery. Per locked rule 7 (no auto-recovery in Step 2),
// the engine must not delete it.
//
// Path authority is internal: both API functions derive every path
// from `repoRoot` (and, for write, `backupGroupId`). Callers cannot
// supply an integrationsPath or backupPath argument. backupGroupId
// is validated as a safe filename component before path composition.
//
// Backup leaf naming uses encodeBackupPath(".viberevert/integrations.json")
// → `<sha256-12>--integrations.json` for consistency with the
// broader backup naming convention. Collision-impossible (there's
// only one integrations.json per repo); the sha-12 prefix is for
// uniformity.
//
// __store__ namespace under integration-backups/ keeps store self-
// backups separate from user-config-file backups (which the engine
// writes under integration-backups/<recordKey>/ in 2H).
//
// Expected backupGroupId shape (engine in 2H): `${UTC_TIMESTAMP}--${txnId}`
// or another collision-resistant transaction-scoped id. It must be
// unique per TRANSACTION, NOT per recordKey -- using a recordKey as
// the backupGroupId would cause backup collisions across transactions
// for the same adapter (since the backup path includes
// __store__/<backupGroupId>/...).
//
// Caller precondition: writeIntegrationsFile is invoked only while
// holding the per-repo installer lock (lock.ts). This module guards
// symlink/path safety AND atomicity-at-the-file-level, but it does
// NOT serialize transactions itself. Without the lock, two
// concurrent writeIntegrationsFile calls could each backup-and-
// replace integrations.json, with the second silently overwriting
// the first's changes.
//
// TOCTOU disclaimer: this is a pre-mutation symlink guard, NOT a
// full TOCTOU-proof sandbox. Same scope as lock.ts / journal.ts.
//
// D101.M.X (claim number assigned in 2I): this module contains the
// ONLY call sites for writeFile/writeFileAtomic targeting
// .viberevert/integrations.json AND the ONLY call sites for writes
// under .viberevert/integration-backups/__store__/ in
// @viberevert/installers/src/. Engine writes target-file backups
// under integration-backups/<recordKey>/ in 2H -- that's engine
// territory, not store.

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.js";
import { prettyJson } from "./canonical-json.js";
import {
  BackupCollisionError,
  IntegrationsCorruptedError,
  IntegrationsSchemaVersionError,
  IntegrationTargetNotFileError,
  IntegrationTargetParentNotDirectoryError,
  SymlinkTargetRefusal,
} from "./errors.js";
import { type IntegrationsFile, IntegrationsFileSchema } from "./integrations-schema.js";
import { encodeBackupPath } from "./path-encode.js";

const VIBEREVERT_DIR_NAME = ".viberevert";
const INTEGRATIONS_FILENAME = "integrations.json";
const BACKUPS_DIR_NAME = "integration-backups";
const STORE_BACKUP_NAMESPACE = "__store__";

// Passed to encodeBackupPath to compute the deterministic backup
// leaf name (`<sha12>--integrations.json`).
const INTEGRATIONS_PATHREL = `${VIBEREVERT_DIR_NAME}/${INTEGRATIONS_FILENAME}`;

const EXPECTED_SCHEMA_VERSION = 1;

// Matches Windows reserved device names (CON, PRN, AUX, NUL, COM1-9,
// LPT1-9) WITH OR WITHOUT extensions. Win32 treats `CON.txt` the same
// as `CON`, so a backup directory named "CON.txt" would be just as
// broken as "CON".
const WINDOWS_RESERVED_BASENAME_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const BackupGroupIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (s) => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c <= 0x1f || c === 0x7f) return false;
      }
      return true;
    },
    { message: "backupGroupId must not contain control characters" },
  )
  .refine((s) => !s.includes(":") && !s.includes("/") && !s.includes("\\"), {
    message: "backupGroupId must not contain path separators or ':'",
  })
  .refine((s) => !s.startsWith("~"), {
    message: "backupGroupId must not start with '~'",
  })
  .refine((s) => s !== "." && s !== "..", {
    message: "backupGroupId must not be '.' or '..'",
  })
  .refine((s) => !WINDOWS_RESERVED_BASENAME_REGEX.test(s), {
    message:
      "backupGroupId must not be a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) -- even with an extension",
  })
  .refine((s) => !/[. ]$/.test(s), {
    message: "backupGroupId must not end with a dot or space (Win32 silently strips them)",
  });

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Read and validate `.viberevert/integrations.json`. Returns the
 * validated IntegrationsFile if present, or `null` if either
 * `.viberevert/` or `integrations.json` does not exist.
 *
 * See top-comment classification policy for the IntegrationsCorruptedError
 * vs IntegrationsSchemaVersionError split. lstat-guards every
 * existing path component before reading; never follows symlinks.
 */
export async function readIntegrationsFile(repoRoot: string): Promise<IntegrationsFile | null> {
  const { viberevertDir, integrationsPath } = readPathsFor(repoRoot);

  // .viberevert/ missing → no file possible. Symlink/non-dir throws.
  if ((await lstatExistingSafeDir(viberevertDir, integrationsPath)) === "absent") {
    return null;
  }

  // integrations.json: lstat first to detect symlink/non-file BEFORE
  // following anything via readFile. ENOENT → null.
  try {
    const st = await lstat(integrationsPath);
    if (st.isSymbolicLink()) {
      throw new SymlinkTargetRefusal({
        targetPath: integrationsPath,
        symlinkedComponentPath: integrationsPath,
      });
    }
    if (!st.isFile()) {
      throw new IntegrationTargetNotFileError({ targetPath: integrationsPath });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const raw = await readFile(integrationsPath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new IntegrationsCorruptedError({
      path: integrationsPath,
      reason: `JSON parse failed: ${(err as Error).message}`,
    });
  }

  // Non-object root (null, array, string, number, boolean) is
  // CORRUPTION, not a version mismatch. SchemaVersionError implies
  // "looks like an integrations file but wrong version"; a non-
  // object root doesn't look like an integrations file at all.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IntegrationsCorruptedError({
      path: integrationsPath,
      reason: "schema validation failed: root must be an object",
    });
  }

  // Object root: check schemaVersion. Missing / null / wrong type /
  // wrong value all become SchemaVersionError -- the file LOOKS LIKE
  // an integrations file, just not our version.
  const foundVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (foundVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new IntegrationsSchemaVersionError({
      path: integrationsPath,
      foundVersion,
      expectedVersion: EXPECTED_SCHEMA_VERSION,
    });
  }

  // Full schema parse. Failure here means the file has the right
  // schemaVersion but otherwise doesn't match -- back to Corrupted.
  try {
    return IntegrationsFileSchema.parse(parsed);
  } catch (err) {
    throw new IntegrationsCorruptedError({
      path: integrationsPath,
      reason: `schema validation failed: ${(err as Error).message}`,
    });
  }
}

/**
 * Atomic write of `.viberevert/integrations.json` with pre-write
 * byte-preserving backup of the existing file (if any) under
 * `.viberevert/integration-backups/__store__/<backupGroupId>/`.
 *
 * Validates `next` against IntegrationsFileSchema BEFORE any disk
 * touch. Validates `backupGroupId` as a safe filename component.
 *
 * If integrations.json already exists, its raw bytes (Buffer, NOT
 * UTF-8 decoded -- preserves any corrupt or non-UTF-8 content as
 * crash evidence) are written to the backup path with `wx` flag.
 * EEXIST on backup → BackupCollisionError.
 *
 * Throws SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError
 * if any existing path component is a symlink or non-directory.
 * Throws IntegrationTargetNotFileError if existing integrations.json
 * is a non-file. Throws on any unhandled I/O failure.
 *
 * Caller precondition: holds the per-repo installer lock.
 */
export async function writeIntegrationsFile(args: {
  repoRoot: string;
  next: IntegrationsFile;
  backupGroupId: string;
}): Promise<void> {
  const validated = IntegrationsFileSchema.parse(args.next);
  const validatedGroupId = BackupGroupIdSchema.parse(args.backupGroupId);

  const paths = storePathsFor(args.repoRoot, validatedGroupId);
  const {
    viberevertDir,
    integrationsPath,
    backupsDir,
    storeBackupNamespaceDir,
    backupGroupDir,
    backupPath,
  } = paths;

  // Ensure .viberevert/ exists safely.
  await ensureSafeDir(viberevertDir, integrationsPath);

  // Check existing integrations.json: backup it if present, else
  // skip backup entirely. Read as Buffer (no encoding) to preserve
  // bytes exactly -- UTF-8 decode would silently transform invalid
  // sequences and corrupt crash evidence.
  let existingBytes: Buffer | null = null;
  try {
    const st = await lstat(integrationsPath);
    if (st.isSymbolicLink()) {
      throw new SymlinkTargetRefusal({
        targetPath: integrationsPath,
        symlinkedComponentPath: integrationsPath,
      });
    }
    if (!st.isFile()) {
      throw new IntegrationTargetNotFileError({ targetPath: integrationsPath });
    }
    existingBytes = await readFile(integrationsPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT → no existing file, no backup needed.
  }

  if (existingBytes !== null) {
    // Ensure the 3-level backup chain safely.
    await ensureSafeDir(backupsDir, backupPath);
    await ensureSafeDir(storeBackupNamespaceDir, backupPath);
    await ensureSafeDir(backupGroupDir, backupPath);

    // Write the backup with wx semantics (no overwrite). Buffer
    // passed verbatim -- no encoding transformation.
    try {
      await writeFile(backupPath, existingBytes, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BackupCollisionError({ backupPath });
      }
      throw err;
    }
  }

  // Atomic write of the new integrations.json. If this fails AFTER
  // a successful backup write, the backup is intentionally left in
  // place as crash evidence -- do not delete it.
  await writeFileAtomic(integrationsPath, `${prettyJson(validated)}\n`);
}

// ---------------------------------------------------------------------------
// Internal: path computation + dir-safety helpers.
// ---------------------------------------------------------------------------

function readPathsFor(repoRoot: string): {
  viberevertDir: string;
  integrationsPath: string;
} {
  const repoRootAbs = resolve(repoRoot);
  const viberevertDir = join(repoRootAbs, VIBEREVERT_DIR_NAME);
  const integrationsPath = join(viberevertDir, INTEGRATIONS_FILENAME);
  return { viberevertDir, integrationsPath };
}

function storePathsFor(
  repoRoot: string,
  backupGroupId: string,
): {
  viberevertDir: string;
  integrationsPath: string;
  backupsDir: string;
  storeBackupNamespaceDir: string;
  backupGroupDir: string;
  backupPath: string;
} {
  const { viberevertDir, integrationsPath } = readPathsFor(repoRoot);
  const backupsDir = join(viberevertDir, BACKUPS_DIR_NAME);
  const storeBackupNamespaceDir = join(backupsDir, STORE_BACKUP_NAMESPACE);
  const backupGroupDir = join(storeBackupNamespaceDir, backupGroupId);
  const backupLeaf = encodeBackupPath(INTEGRATIONS_PATHREL);
  const backupPath = join(backupGroupDir, backupLeaf);
  return {
    viberevertDir,
    integrationsPath,
    backupsDir,
    storeBackupNamespaceDir,
    backupGroupDir,
    backupPath,
  };
}

/**
 * lstat `dir`; return "exists" if it's a real directory (NOT a
 * symlink, NOT another file kind), return "absent" on ENOENT, throw
 * SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError
 * on safety mismatch.
 */
async function lstatExistingSafeDir(
  dir: string,
  errorTargetPath: string,
): Promise<"exists" | "absent"> {
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) {
      throw new SymlinkTargetRefusal({
        targetPath: errorTargetPath,
        symlinkedComponentPath: dir,
      });
    }
    if (!st.isDirectory()) {
      throw new IntegrationTargetParentNotDirectoryError({
        targetPath: errorTargetPath,
        parentPath: dir,
      });
    }
    return "exists";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
}

/**
 * Ensure `dir` exists as a regular directory. lstat-check: refuse
 * if symlink, refuse if non-directory, return if directory, create
 * (non-recursive mkdir) if ENOENT. mkdir EEXIST (another process
 * created the dir between our lstat and mkdir) re-runs the guard,
 * which accepts a real dir and rejects a symlink/file with the
 * right typed refusal.
 *
 * Same shape as lock.ts / journal.ts ensure* helpers. Duplicated
 * here rather than shared to keep 2G self-contained. Refactor to a
 * cross-module helper in 2H/2I if the duplication becomes painful.
 */
async function ensureSafeDir(dir: string, eventualTargetPath: string): Promise<void> {
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) {
      throw new SymlinkTargetRefusal({
        targetPath: eventualTargetPath,
        symlinkedComponentPath: dir,
      });
    }
    if (!st.isDirectory()) {
      throw new IntegrationTargetParentNotDirectoryError({
        targetPath: eventualTargetPath,
        parentPath: dir,
      });
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    await mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      await ensureSafeDir(dir, eventualTargetPath);
      return;
    }
    throw err;
  }
}
