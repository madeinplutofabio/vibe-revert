// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Pre-mutation recovery journal per D101.M.
//
// Every install/uninstall transaction writes a JournalEntry to
// `.viberevert/integration-journal/<txnId>.json` BEFORE mutating
// any user file. The entry grows as ops complete (phase + recordedOps
// + backupPaths). On clean completion the engine deletes the entry.
// A surviving entry indicates a prior crash -- the next install or
// uninstall refuses with PendingIntegrationRecoveryError (locked
// rule 7: no auto-recovery in Step 2; user inspects + cleans manually).
//
// Write semantics differ by purpose:
//   - writeJournal (new file): uses writeFile with flag: "wx" --
//     atomic exclusive create at the kernel level. Failing with
//     EEXIST is the "do not overwrite crash evidence" enforcement;
//     a concurrent same-txnId or a stale file at the same path
//     correctly throws PendingIntegrationRecoveryError instead of
//     silently clobbering. A crash mid-write of a NEW journal leaves
//     a partial file at the journal path; the next install/uninstall
//     correctly refuses (schema-parse of the partial file fails,
//     surfacing corruption). The journal IS the safety net; a corrupt
//     pending one blocking recovery is safer than overwriting it.
//     "wx" is the correct atomic primitive for new-file creation,
//     NOT writeFileAtomic (which uses rename + DOES overwrite the
//     destination on POSIX -- the lstat-then-rename race would let
//     concurrent same-txnId writes clobber each other).
//   - updateJournal (existing file replace): uses writeFileAtomic
//     (4th D17c copy in atomic.ts). Overwriting the same journal IS
//     the intended semantic for progress updates; the temp+rename
//     idiom keeps the update atomic.
//
// Journal output is rendered via prettyJson (from canonical-json),
// not raw JSON.stringify. prettyJson inherits canonical-json's strict
// input validation (rejects getters, non-finite numbers, non-plain
// objects, etc.) so a malformed in-memory entry cannot serialize to
// a malformed-on-disk entry.
//
// plannedOps captures, at journal-write time, what the transaction
// INTENDS to do. Without it, an early crash (after journal write but
// before any file mutation) leaves recordedOps=[] and backupPaths=[]
// and no integrations.json record -- the journal would be nearly
// useless for manual recovery. PlannedJournalOpSchema captures only
// the durable recovery-relevant fields (kind + target + per-kind
// rollback discriminator); the engine maps adapter FileEditOps into
// this shape, which keeps journal.ts free of an @viberevert/adapters
// runtime dep. plannedOps is .min(1) -- a zero-planned-op transaction
// must not journal.
//
// Array caps: plannedOps / recordedOps / backupPaths are .max(256).
// Generous for installer integrations; prevents a malformed journal
// from ballooning to multi-MB. A future adapter needing more is a
// conscious schema migration, not accidental unbounded growth.
//
// API takes (repoRoot, txnId) rather than an arbitrary journal path:
//   - txnId is z.uuid()-validated BEFORE path computation;
//   - the journal path is derived from repoRoot + txnId inside this
//     module;
//   - callers cannot trick update/delete into mutating an arbitrary
//     file via a forged path string.
//
// updateJournal accepts a JournalMutation that is validated at
// RUNTIME against JournalMutationSchema (a .strict() Zod object
// permitting ONLY the progress fields phase / recordedOps /
// backupPaths). A JS caller or bad cast cannot smuggle identity
// fields (txnId, recordKey, adapterName, command, startedAt,
// cliVersion, plannedOps) through the type system -- the runtime
// schema rejects them.
//
// updateJournal validates SHAPE, not STATE-MACHINE semantics. The
// schema permits going from phase="done" back to phase="writing-files"
// because that's a valid shape. The engine (2H) owns monotonic phase
// transitions.
//
// scanForPendingJournals lstat-guards .viberevert/ and the journal
// dir before readdir (same rule as lock.ts: never follow symlinked
// state dirs, even for reads). It then filters readdir results to
// names matching the strict UUID-plus-".json" regex; arbitrary
// .json files (e.g. notes, editor swaps) are ignored. Results are
// sorted by filename for deterministic ordering across runs and
// platforms (readdir order is non-deterministic on POSIX inode-order
// vs NTFS). Returns PendingJournal objects (filename + journalPath +
// entry) so the caller can populate PendingIntegrationRecoveryError
// without rescanning.
//
// File-kind guard: updateJournal / deleteJournal / scanForPendingJournals
// all lstat the journal FILE itself before any read/write/delete.
// A journal that is a symlink, directory, FIFO, etc. is refused via
// SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError.
// writeJournal does NOT need a separate file-kind guard because
// wx-EEXIST atomically refuses whether the existing path is a
// regular file, symlink, or otherwise -- the diagnostic just goes
// through PendingIntegrationRecoveryError uniformly on the new-write
// path.
//
// updateJournal AND deleteJournal also lstat-guard .viberevert/ and
// the journal dir before touching paths. Mutation paths must never
// follow symlinked state dirs.
//
// .viberevert/ parent + journal-dir safety: same lstat-guarded
// pattern as lock.ts. Refuse if either is a symlink or non-directory.
// repoRoot itself may be symlinked. mkdir EEXIST races re-run the
// guard.
//
// TOCTOU disclaimer: this is a pre-mutation symlink guard, NOT a
// full TOCTOU-proof sandbox. Same scope as lock.ts.
//
// D101.M.8: this module contains the ONLY writes/reads/deletes of
// .viberevert/integration-journal/ files. writeJournal uses
// writeFile with flag:"wx" for atomic exclusive creation;
// updateJournal uses writeFileAtomic from atomic.ts for atomic
// replacement; scanForPendingJournals uses readdir + readFile;
// deleteJournal uses unlink. Other modules that need journal data
// go through writeJournal / updateJournal / scanForPendingJournals
// / deleteJournal.

import { lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.js";
import { prettyJson } from "./canonical-json.js";
import type { CommandKind } from "./engine-types.js";
import {
  IntegrationTargetParentNotDirectoryError,
  PendingIntegrationRecoveryError,
  SymlinkTargetRefusal,
} from "./errors.js";
import {
  IntegrationFileEditRecordSchema,
  PathSpecSchema,
  RecordKeySchema,
} from "./integrations-schema.js";

const VIBEREVERT_DIR_NAME = ".viberevert";
const JOURNAL_DIR_NAME = "integration-journal";
const JOURNAL_FILE_EXT = ".json";

const MAX_PLANNED_OPS = 256;
const MAX_RECORDED_OPS = 256;
const MAX_BACKUP_PATHS = 256;

// Strict UUID-v1..v5 + ".json" filename. scanForPendingJournals only
// reads files matching this; arbitrary *.json (e.g. notes.json, an
// editor swap file) is ignored.
const JOURNAL_FILENAME_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;

// Reusable schema fragments inlined here rather than re-exported from
// integrations-schema.ts. Small duplication; acceptable for 2F.
// Refactor to shared helpers in 2H/2I if it becomes painful.
const BoundedNoControlString = (max: number, label: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (s) => {
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (c <= 0x1f || c === 0x7f) return false;
        }
        return true;
      },
      { message: `${label} must not contain control characters` },
    );

const UtcIsoDateTime = z.iso.datetime().refine((s) => s.endsWith("Z"), {
  message: "datetime must be UTC and end with Z",
});

const BlockIdSchemaInline = BoundedNoControlString(256, "blockId");

const JsonKeySegmentSchemaInline = z
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
    { message: "jsonKeyPath segments must not contain control characters" },
  )
  .refine((s) => s !== "__proto__" && s !== "constructor" && s !== "prototype", {
    message: "jsonKeyPath must not contain prototype-pollution keys",
  });

// ---------------------------------------------------------------------------
// PlannedJournalOp -- durable recovery-relevant subset of adapter
// FileEditOp. Captures kind + target + the per-kind rollback
// discriminator (blockId / jsonKeyPath). Does NOT capture the actual
// content to write (bytes/content/value) -- those are not needed for
// rollback diagnostic. Engine maps adapter FileEditOp into this shape
// before writing the journal.
// ---------------------------------------------------------------------------

const PlannedJournalOpSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("write-new"),
      target: PathSpecSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sentinel-block-insert"),
      target: PathSpecSchema,
      blockId: BlockIdSchemaInline,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sentinel-block-replace"),
      target: PathSpecSchema,
      blockId: BlockIdSchemaInline,
    })
    .strict(),
  z
    .object({
      kind: z.literal("backup-and-write"),
      target: PathSpecSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("json-key-merge"),
      target: PathSpecSchema,
      jsonKeyPath: z.array(JsonKeySegmentSchemaInline).min(1),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// JournalEntry -- root durable journal shape.
// ---------------------------------------------------------------------------

export const JournalEntrySchema = z
  .object({
    txnId: z.uuid(),
    recordKey: RecordKeySchema,
    adapterName: BoundedNoControlString(128, "adapterName"),
    startedAt: UtcIsoDateTime,
    command: z.enum(["install", "uninstall"]) satisfies z.ZodType<CommandKind>,
    cliVersion: BoundedNoControlString(128, "cliVersion"),
    phase: z.enum(["writing-files", "updating-integrations", "done"]),
    plannedOps: z.array(PlannedJournalOpSchema).min(1).max(MAX_PLANNED_OPS),
    recordedOps: z.array(IntegrationFileEditRecordSchema).max(MAX_RECORDED_OPS),
    backupPaths: z.array(PathSpecSchema).max(MAX_BACKUP_PATHS),
  })
  .strict();

export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export type PlannedJournalOp = z.infer<typeof PlannedJournalOpSchema>;

// ---------------------------------------------------------------------------
// JournalMutation -- the only fields updateJournal may mutate.
// Validated at runtime against JournalMutationSchema; a JS caller or
// bad cast cannot smuggle identity fields (txnId, recordKey,
// adapterName, command, startedAt, cliVersion, plannedOps) through
// the type system because the runtime schema rejects them via
// `.strict()`.
// ---------------------------------------------------------------------------

export const JournalMutationSchema = z
  .object({
    phase: z.enum(["writing-files", "updating-integrations", "done"]).optional(),
    recordedOps: z.array(IntegrationFileEditRecordSchema).max(MAX_RECORDED_OPS).optional(),
    backupPaths: z.array(PathSpecSchema).max(MAX_BACKUP_PATHS).optional(),
  })
  .strict();

export type JournalMutation = z.infer<typeof JournalMutationSchema>;

/**
 * Result entry from scanForPendingJournals. Carries the filename
 * + absolute journalPath + validated entry so callers can populate
 * PendingIntegrationRecoveryError or reference the file by path
 * without reconstructing either from txnId.
 */
export interface PendingJournal {
  readonly filename: string;
  readonly journalPath: string;
  readonly entry: JournalEntry;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Write a NEW journal entry. Uses writeFile with flag:"wx" for
 * atomic exclusive creation -- if the journal path already exists
 * in any form (regular file, symlink, etc.), the kernel returns
 * EEXIST and we throw PendingIntegrationRecoveryError naming the
 * file. This is the "do not overwrite crash evidence" enforcement
 * applied at the kernel level (no race window).
 *
 * Validates the entry against the schema BEFORE touching disk.
 * Output rendered via prettyJson (rejects getters/non-finite
 * numbers/non-plain objects on the in-memory entry).
 *
 * Throws SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError
 * if .viberevert/ or the journal dir is a symlink or non-directory.
 *
 * Returns the absolute path of the written file (for diagnostic /
 * test use).
 */
export async function writeJournal(repoRoot: string, entry: JournalEntry): Promise<string> {
  const validated = JournalEntrySchema.parse(entry);
  const { viberevertDir, journalDir, journalPath } = journalPathFor(repoRoot, validated.txnId);

  await ensureViberevertDir(viberevertDir, journalDir);
  await ensureJournalDir(viberevertDir, journalDir);

  try {
    await writeFile(journalPath, `${prettyJson(validated)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PendingIntegrationRecoveryError({
        journalDir,
        pendingEntries: [basename(journalPath)],
      });
    }
    throw err;
  }
  return journalPath;
}

/**
 * Atomic read-modify-write of an existing journal entry. Validates
 * the mutation at runtime against JournalMutationSchema (rejects
 * identity fields). Reads the file (after lstat-guarding it is a
 * regular file), parses + validates, merges the validated mutation,
 * re-validates, then writes back atomically via writeFileAtomic
 * (overwriting the same journal is the intended semantic for
 * progress updates).
 *
 * Validates SHAPE only -- the schema accepts e.g. phase going from
 * "done" back to "writing-files" because that's a valid shape. The
 * engine (2H) owns monotonic phase transitions.
 *
 * lstat-guards .viberevert/, the journal dir, AND the journal file
 * before touching it. Throws SymlinkTargetRefusal /
 * IntegrationTargetParentNotDirectoryError on safety mismatch.
 *
 * Throws on any I/O failure including ENOENT on the journal file
 * (caller should treat as recovery-blocked corruption). Throws if
 * the merged result fails schema validation.
 */
export async function updateJournal(
  repoRoot: string,
  txnId: string,
  mutation: JournalMutation,
): Promise<void> {
  const validatedMutation = JournalMutationSchema.parse(mutation);
  const { viberevertDir, journalDir, journalPath } = journalPathFor(repoRoot, txnId);

  await assertJournalDirsExistSafe(viberevertDir, journalDir);
  await requireExistingSafeJournalFile(journalPath, journalDir);

  const raw = await readFile(journalPath, "utf8");
  const existing = JournalEntrySchema.parse(JSON.parse(raw));
  const merged = { ...existing, ...validatedMutation };
  const validated = JournalEntrySchema.parse(merged);

  await writeFileAtomic(journalPath, `${prettyJson(validated)}\n`);
}

/**
 * Delete a journal entry. lstat-guards .viberevert/, the journal dir,
 * AND the journal file before unlink. Throws on any I/O failure
 * including ENOENT -- caller (engine) decides whether to swallow
 * (after a successful commit, a delete failure should print a stderr
 * warning but not roll back).
 */
export async function deleteJournal(repoRoot: string, txnId: string): Promise<void> {
  const { viberevertDir, journalDir, journalPath } = journalPathFor(repoRoot, txnId);
  await assertJournalDirsExistSafe(viberevertDir, journalDir);
  await requireExistingSafeJournalFile(journalPath, journalDir);
  await unlink(journalPath);
}

/**
 * Scan `.viberevert/integration-journal/` for journal entries. Returns
 * an array of PendingJournal objects (filename + journalPath + entry)
 * -- empty if .viberevert/ or the journal dir does not exist, OR
 * contains no UUID-named .json files. Results are sorted by filename
 * for deterministic ordering across runs and platforms (readdir
 * order is non-deterministic).
 *
 * lstat-guards .viberevert/ AND the journal dir before readdir -- a
 * symlinked or non-directory parent throws
 * SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError.
 *
 * Filters readdir results to filenames matching JOURNAL_FILENAME_REGEX
 * (strict UUID + ".json"); arbitrary *.json files are ignored.
 *
 * lstat-guards each matching journal FILE before readFile -- a
 * symlinked or non-regular-file journal throws the typed safety
 * errors. Closes the read-through-symlink leak at the file level.
 *
 * Throws if any matching journal file fails schema validation
 * (caller should treat as recovery-blocked corruption).
 *
 * Does NOT throw on "pending journals exist" -- caller (engine)
 * checks the returned length and throws PendingIntegrationRecoveryError
 * with its own lock-release-first ordering.
 */
export async function scanForPendingJournals(repoRoot: string): Promise<PendingJournal[]> {
  const repoRootAbs = resolve(repoRoot);
  const viberevertDir = join(repoRootAbs, VIBEREVERT_DIR_NAME);
  const journalDir = join(viberevertDir, JOURNAL_DIR_NAME);

  if ((await lstatExistingSafeDir(viberevertDir, journalDir)) === "absent") return [];
  if ((await lstatExistingSafeDir(journalDir, journalDir)) === "absent") return [];

  const files = await readdir(journalDir);
  const validNames = files.filter((f) => JOURNAL_FILENAME_REGEX.test(f)).sort();

  const results: PendingJournal[] = [];
  for (const filename of validNames) {
    const journalPath = join(journalDir, filename);
    await requireExistingSafeJournalFile(journalPath, journalDir);
    const raw = await readFile(journalPath, "utf8");
    const entry = JournalEntrySchema.parse(JSON.parse(raw));
    results.push({ filename, journalPath, entry });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Internal: path computation + dir-safety + file-safety helpers.
// ---------------------------------------------------------------------------

/**
 * Compute the absolute journal path for `(repoRoot, txnId)`. Validates
 * txnId as a UUID BEFORE composing the path -- a forged non-UUID
 * cannot become part of the filesystem path.
 */
function journalPathFor(
  repoRoot: string,
  txnId: string,
): { viberevertDir: string; journalDir: string; journalPath: string } {
  const validatedTxnId = z.uuid().parse(txnId);
  const repoRootAbs = resolve(repoRoot);
  const viberevertDir = join(repoRootAbs, VIBEREVERT_DIR_NAME);
  const journalDir = join(viberevertDir, JOURNAL_DIR_NAME);
  const journalPath = join(journalDir, `${validatedTxnId}${JOURNAL_FILE_EXT}`);
  return { viberevertDir, journalDir, journalPath };
}

/**
 * lstat `dir`; return "exists" if it's a real directory (NOT a
 * symlink, NOT another file kind), return "absent" on ENOENT, throw
 * SymlinkTargetRefusal / IntegrationTargetParentNotDirectoryError
 * on safety mismatch. Used by scanForPendingJournals to allow
 * missing-but-safe dirs without falsely throwing.
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
 * Same shape as lstatExistingSafeDir but ENOENT throws naturally
 * (caller requires the dir to exist). Other safety mismatches throw
 * the typed errors.
 */
async function requireExistingSafeDir(dir: string, errorTargetPath: string): Promise<void> {
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
}

/**
 * Require both .viberevert/ AND the journal dir to exist as real
 * directories before any mutation path. Used by updateJournal +
 * deleteJournal. ENOENT on either propagates as a natural lstat
 * error; symlinks/non-dirs throw the typed safety errors.
 */
async function assertJournalDirsExistSafe(
  viberevertDir: string,
  journalDir: string,
): Promise<void> {
  await requireExistingSafeDir(viberevertDir, journalDir);
  await requireExistingSafeDir(journalDir, journalDir);
}

/**
 * Require a journal FILE to exist as a regular file (NOT a symlink,
 * NOT a directory or other special kind). Used by updateJournal +
 * deleteJournal + scanForPendingJournals before reading or
 * unlinking the file. Closes the read-through-symlink leak at the
 * file level.
 *
 * writeJournal does NOT call this -- its EEXIST handling via
 * wx-flag covers any existing-path scenario uniformly with PIRE.
 *
 * The IntegrationTargetParentNotDirectoryError naming is slightly
 * imperfect for "journal file is not a regular file" (it's a parent-
 * dir-kind error type), but reusing it avoids adding a new error
 * class just for this case. The important behavior is refusing
 * before readFile / unlink.
 */
async function requireExistingSafeJournalFile(
  journalPath: string,
  journalDir: string,
): Promise<void> {
  const st = await lstat(journalPath);
  if (st.isSymbolicLink()) {
    throw new SymlinkTargetRefusal({
      targetPath: journalPath,
      symlinkedComponentPath: journalPath,
    });
  }
  if (!st.isFile()) {
    throw new IntegrationTargetParentNotDirectoryError({
      targetPath: journalPath,
      parentPath: journalDir,
    });
  }
}

/**
 * Same shape as lock.ts ensureViberevertDir. Mirror is kept here
 * rather than shared to avoid cross-module coupling for 2F. Refactor
 * to a shared helper in 2H/2I if duplication becomes a maintenance
 * burden.
 */
async function ensureViberevertDir(viberevertDir: string, journalDir: string): Promise<void> {
  try {
    const st = await lstat(viberevertDir);
    if (st.isSymbolicLink()) {
      throw new SymlinkTargetRefusal({
        targetPath: journalDir,
        symlinkedComponentPath: viberevertDir,
      });
    }
    if (!st.isDirectory()) {
      throw new IntegrationTargetParentNotDirectoryError({
        targetPath: journalDir,
        parentPath: viberevertDir,
      });
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    await mkdir(viberevertDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      await ensureViberevertDir(viberevertDir, journalDir);
      return;
    }
    throw err;
  }
}

/**
 * Ensure `.viberevert/integration-journal/` exists as a regular
 * directory. Same lstat-guarded pattern as ensureViberevertDir.
 */
async function ensureJournalDir(viberevertDir: string, journalDir: string): Promise<void> {
  try {
    const st = await lstat(journalDir);
    if (st.isSymbolicLink()) {
      throw new SymlinkTargetRefusal({
        targetPath: journalDir,
        symlinkedComponentPath: journalDir,
      });
    }
    if (!st.isDirectory()) {
      throw new IntegrationTargetParentNotDirectoryError({
        targetPath: journalDir,
        parentPath: journalDir,
      });
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    await mkdir(journalDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      await ensureJournalDir(viberevertDir, journalDir);
      return;
    }
    throw err;
  }
}
