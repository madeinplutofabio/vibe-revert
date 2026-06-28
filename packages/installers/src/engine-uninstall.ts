// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Engine uninstall for @viberevert/installers.
//
// === ENTRY ===
// uninstall(recordKey, ctx) -> UninstallOutcome
//   Record-driven (no adapter involvement): reads the existing
//   IntegrationRecord for `recordKey` and reverses each recorded op
//   per-kind, then removes the record from integrations.json. Lock
//   discipline + pending-journal refusal + best-effort cleanup
//   mirror engine-apply.ts.
//
// === OUTCOMES ===
//   - UninstallOutcome.uninstalled: transaction committed.
//       receipt.filesRemoved = absolute paths of unlinked target
//         files (one per successful write-new reversal).
//       receipt.filesRestored = absolute paths of files mutated
//         back to pre-install state (one per successful
//         backup-and-write / sentinel-block-* / json-key-merge
//         reversal).
//       receipt.adapterName = record.adapterName.
//       receipt.humanSummary = `Uninstalled ${adapterName} (${N} ops
//         reversed)` where N = filesRemoved.length + filesRestored.length.
//   - UninstallOutcome.not-installed: no record for recordKey.
//     Informational, not refused. Returned AFTER lock + pending-
//     journal scan (recovery-safety per the locked execution
//     order); see EXECUTION ORDER below.
//   - UninstallOutcome.refused: drift (overrideable with
//     --force-uninstall) OR structural refusal (backup-file-missing-
//     on-disk, integrations-record-duplicate-target,
//     integrations-record-corrupted-op -- all NOT overrideable).
//
// === BOUNDARY (locked by 2H.3 scope) ===
//
// uninstall DOES write to disk:
//   - unlink target files (write-new reversal).
//   - writeFileAtomic target files with backup Buffer (backup-and-
//     write reversal) -- restores byte-faithful pre-install state.
//   - writeFileAtomic target files with sentinel-block-removed text
//     (sentinel-* reversal).
//   - writeFileAtomic target files with json-key-deleted text
//     (json-key-merge reversal).
//   - Target parent directory chain via lstat-guarded non-recursive
//     mkdir (ensureTargetParentDirChain), for backup-and-write
//     reversal only -- the target may be absent under force+drift.
//     Other reversals do not need this (target was just read).
//   - .viberevert/integrations.json + its store-self-backup via
//     writeIntegrationsFile (integrations-store.ts). The record is
//     REMOVED from records[]; history "uninstall" appended.
//   - .viberevert/integrations.lock/ + pid.json via acquireLock /
//     releaseLock (lock.ts).
//   - .viberevert/integration-journal/<txnId>.json via writeJournal /
//     updateJournal / deleteJournal (journal.ts). Written ONLY when
//     at least one reversal mutates a target file; if all reverses
//     are skip plans (force-overridden already-done state), no
//     journal is written -- analogous to install's adoption-only
//     path.
//   - unlink target backup files (best-effort, after restore + store
//     update). Failure prints stderr warning and continues.
//
// uninstall NEVER:
//   - Deletes .viberevert/integrations.json (always preserves the
//     file, even when records becomes empty -- keeps history +
//     createdByVersion for audit).
//   - Writes anything outside the repo root (assertSafeTarget +
//     readBackupSafely + ensureTargetParentDirChain re-verify).
//   - Follows symlinked components (every fs entry is lstat-guarded).
//   - Uses recursive mkdir (always per-level lstat-guarded).
//
// === ERROR PROPAGATION ===
//
// In-band refusals returned as UninstallOutcome.refused (always
// with recordKey, per outcome-type asymmetry):
//   - integrations-content-drift -- current SHA differs from
//     recorded; overrideable with --force-uninstall.
//   - backup-file-missing-on-disk -- backup file expected by record
//     is absent; NOT overrideable. For backup-and-write, this check
//     fires BEFORE the drift check, so a missing backup wins over
//     a forceable drift refusal (avoids "user runs --force-
//     uninstall to discover the real problem" UX trap).
//   - integrations-record-duplicate-target -- record has >1 ops for
//     one pathRelative; NOT overrideable.
//   - integrations-record-corrupted-op -- defensive check on
//     per-kind invariants (managedBlockSha256 non-null for sentinel,
//     etc.); should be unreachable because IntegrationsFileSchema's
//     superRefine catches these at readIntegrationsFile time; NOT
//     overrideable.
//
// Out-of-band errors propagated as throws:
//   - IntegrationsLockError (lock already held)
//   - PendingIntegrationRecoveryError (pending journal found)
//   - SymlinkTargetRefusal, TargetOutsideRepoRootError,
//     IntegrationTargetParentNotDirectoryError,
//     IntegrationTargetNotFileError,
//     IntegrationTargetTooLargeError (from assertSafeTarget on
//     target paths with op:"merge" for sentinel/json-key-merge --
//     enforces 1 MiB cap on read-modify-write targets;
//     write-new/backup-and-write preflight with op:"write" skips
//     the size cap since the install writes full files)
//   - IntegrationsCorruptedError, IntegrationsSchemaVersionError
//     (from readIntegrationsFile)
//   - SyntaxError (from JSON.parse of a target outer file for
//     json-key-merge reversal; matches install's propagation policy)
//   - ZodError (from writeIntegrationsFile's IntegrationsFileSchema
//     parse of the updated file)
//   - I/O errors (unlink EPERM, writeFileAtomic ENOSPC, etc.)
//
// Mid-transaction failures (after journal write) leave the journal
// pending. Next install/uninstall sees pending journal and refuses
// with PendingIntegrationRecoveryError; user inspects + cleans
// manually (locked rule 7: no auto-recovery in Step 2).
//
// === REVERSE PER KIND ===
//
//   write-new
//     reverse: unlink(target)
//     receipt: filesRemoved
//     drift basis: sha256OfUtf8(currentText) vs fullFileSha256AfterWrite
//
//   backup-and-write
//     reverse: writeFileAtomic(target, backupBuffer) AS RAW BUFFER
//              (byte-faithful restore); ensureTargetParentDirChain
//              first (target may be absent under force+drift).
//     receipt: filesRestored
//     drift basis: sha256OfUtf8(currentText) vs fullFileSha256AfterWrite
//     post: best-effort unlink(backup) AFTER store write succeeds.
//
//   sentinel-block-insert / sentinel-block-replace
//     reverse: writeFileAtomic(target, removeSentinelBlock(currentText,
//              blockId) normalized to current line-ending).
//     receipt: filesRestored
//     drift basis: sha256OfUtf8(findSentinelBlock(currentText,
//                  blockId).content) vs managedBlockSha256
//
//   json-key-merge
//     reverse: writeFileAtomic(target, prettyJson(deleteAtKeyPath(
//              parseJson(currentText), jsonKeyPath)) + "\n",
//              normalized to current line-ending).
//     receipt: filesRestored
//     drift basis: sha256OfCanonical(jsonValueAtKeyPath(parseJson(
//                  currentText), jsonKeyPath)) vs managedValueSha256
//
// === REVERSE ORDER ===
//
// Reverse record.ops in REVERSE order (last recorded -> first
// recorded). v1 ops are independent (one op per file per record)
// so order doesn't matter operationally, but reverse-order is the
// conventional safety margin for any future ordered dependencies.
// The journal's plannedOps records mutations in EXECUTION ORDER
// (reversed), not record order, so the journal matches what apply
// actually performs.
//
// === DRIFT + FORCE-SCOPE ===
//
// Per recorded op:
//   - currentSha = extractCurrentShaFromRecordOp(recordOp, currentText)
//   - recordedSha = extractRecordedShaFromRecordOp(recordOp)
//
// Refusal precedence (BACKUP-MISSING WINS OVER DRIFT for backup-
// and-write):
//   1. For backup-and-write: validate + read backup FIRST. Missing
//      backup -> refuse backup-file-missing-on-disk (NOT
//      overrideable). This precedes the drift check so a user with
//      both a drifted target AND a missing backup sees the real
//      problem first, not "forceable" drift.
//   2. Drift check (uniform across kinds): if currentSha !==
//      recordedSha AND !forceUninstall -> refuse
//      integrations-content-drift (overrideable).
//
// If currentSha === recordedSha -> NO drift; reverse per kind table.
//
// If currentSha !== recordedSha AND forceUninstall -> see FORCE +
// ALREADY-DONE below for the per-kind skip-vs-reverse decision.
//
// === FORCE + ALREADY-DONE (locked rule) ===
//
// Under forceUninstall + drift, planning checks
// `currentSha === null`:
//
//   currentSha === null + write-new          -> skip (target absent)
//   currentSha === null + sentinel-*         -> skip (block absent)
//   currentSha === null + json-key-merge     -> skip (key absent)
//   currentSha === null + backup-and-write   -> DO NOT skip; restore
//                                               from backup (target
//                                               may be absent or
//                                               drifted; backup is
//                                               authoritative).
//
//   currentSha !== null + drift              -> reverse per kind
//                                               (user's drift gets
//                                               overwritten /
//                                               removed).
//
// Skip plans contribute nothing to filesRemoved or filesRestored
// (no file touch). They are silently no-ops on disk; the record
// is still removed.
//
// === BACKUP RESTORE + DELETION ===
//
// Backup PathSpec is read from recordOp.backup (non-null for
// backup-and-write per schema; null for other kinds). Backup file
// is read as RAW BUFFER (no encoding) via readBackupSafely, which:
//   - resolves the PathSpec under repoRoot
//   - re-validates the path stays inside repo (defensive vs.
//     tampered records)
//   - assertSafeTarget (lstat-guards every existing component;
//     refuses symlinks; refuses non-file backup target)
//   - readFile as Buffer
//   - ENOENT -> {kind: "missing"} (becomes
//     backup-file-missing-on-disk refusal in planning, BEFORE
//     journal write)
//
// readBackupSafely uses assertSafeTarget with op:"write" which
// skips the merge-size cap -- backups are restore evidence, not
// merge text, and may exceed 1 MiB legitimately.
//
// Backup deletion happens AFTER all reverses + store write succeed.
// Best-effort unlink per restored backup; failure prints stderr
// warning and continues. The transaction has logically succeeded;
// orphan backups under .viberevert/integration-backups/<recordKey>/
// <oldGroupId>/ are harmless and user-cleanable.
//
// === TARGET PREFLIGHT (per-kind) ===
//
// assertSafeTarget per recorded target uses op:"write" for
// write-new and backup-and-write (skips the 1 MiB merge cap --
// these are full-file replacements, not merge text reads),
// op:"merge" for sentinel-* and json-key-merge (enforces the cap
// since those reverses do read-modify-write of the existing
// target). This mirrors install's per-kind preflight policy; a
// legitimate large hook script or workflow YAML installed via
// backup-and-write is uninstall-able.
//
// === INTEGRATIONS.JSON UPDATE ===
//
// After all reverses succeed:
//   - Read existing IntegrationsFile under lock (already done in
//     execution step 3).
//   - Build updated file:
//       records: { ...existing.records } MINUS [recordKey]
//       (preserves all other records).
//       history: existing.history.slice(-999) + new entry
//       {timestamp: ctx.now.toISOString(), action: "uninstall",
//        recordKey, cliVersion: ctx.cliVersion}.
//       createdByVersion: preserved.
//       updatedByVersion: ctx.cliVersion (overwritten).
//       schemaVersion: 1.
//   - Pass to writeIntegrationsFile with backupGroupId (the same
//     id used for the txn's journal, scoping the store self-backup
//     under __store__/<backupGroupId>/ for audit consistency).
//
// integrations.json is NEVER deleted by uninstall. If records
// becomes empty after removal, the file persists with `records: {}`
// + preserved history + preserved createdByVersion (audit trail).
//
// === JOURNAL SEMANTICS ===
//
// Written ONLY when at least one reverse plan mutates a target
// file. If every plan is "skip" (force-overrode all reverses to
// already-done state), no journal is written -- analogous to
// install's adoption-only path.
//
// When written:
//   txnId = randomUUID() (shared with backupGroupId per locked rule).
//   backupGroupId = utcSlug(ctx.now) + "--" + txnId.
//   command: "uninstall".
//   phase: "writing-files" -> "updating-integrations" -> "done".
//   plannedOps: PlannedJournalOp[] in EXECUTION ORDER (reverse of
//     record.ops) -- one entry per recorded op that has a non-skip
//     reverse plan. Skip plans are NOT in plannedOps; they would
//     be misleading -- the planned-mutation set is what this
//     journal tracks.
//   recordedOps: existing record.ops VERBATIM (per journal.ts
//     comment "recordedOps for uninstall sourced from existing
//     record"). NOT accumulated during execution -- per-op uninstall
//     progress is M H concern; phase advance is the granularity
//     for 2H.3.
//   backupPaths: [] -- uninstall never creates backups; the
//     restored backup files are read (not created) and then deleted
//     best-effort post-commit.
//
// === EXECUTION ORDER (locked) ===
//
//   1. acquire lock (throws IntegrationsLockError on conflict).
//   2. scan pending journal (throws PendingIntegrationRecoveryError
//      if any). Inside try (with finally releaseLock).
//   3. read integrations.json (throws IntegrationsCorruptedError /
//      IntegrationsSchemaVersionError).
//   4. if records[recordKey] === undefined -> return
//      UninstallOutcome.not-installed.
//   5. duplicate-record-path guard: if record.ops has >1 ops for
//      the same pathRelative -> refuse (NOT overrideable).
//   6. preflight every recorded target path (per-kind op:
//      "write" for write-new/backup-and-write; "merge" otherwise).
//   7. read current target bytes per recorded path: UTF-8 string
//      (raw Buffer not needed -- backups are read separately by
//      readBackupSafely). ENOENT -> null.
//   8. build reverse plans (per op):
//      a. pre-validate record-op per-kind invariants (defensive;
//         catches integrations-record-corrupted-op).
//      b. for backup-and-write: read backup FIRST (refuses on
//         missing BEFORE drift check is consulted).
//      c. drift check (uniform); if drift AND !forceUninstall ->
//         refuse drift (overrideable).
//      d. apply FORCE + ALREADY-DONE rule per kind to produce
//         ReversePlan: skip / reverse-write-new /
//         reverse-backup-and-write / reverse-sentinel /
//         reverse-json-key-merge / refuse.
//   9. if any refuse plan exists -> return refused outcome
//      (first refusal's reasonCode; message lists all detail lines).
//  10. compute plansInExecutionOrder = plans.reverse();
//      targetMutationsInExecutionOrder = plansInExecutionOrder
//      filtered to non-skip non-refuse plans.
//  11. txnId = randomUUID(); backupGroupId = utcSlug + "--" + txnId.
//  12. if targetMutationsInExecutionOrder.length > 0:
//        a. writeJournal phase: "writing-files",
//           plannedOps: targetMutationsInExecutionOrder
//             .map(recordOpToPlannedJournalOp),
//           recordedOps: record.ops (verbatim),
//           backupPaths: [].
//        b. execute each plan in plansInExecutionOrder:
//             skip -> no-op; append nothing to receipt.
//             reverse-write-new -> unlink; filesRemoved.push.
//             reverse-backup-and-write -> ensureTargetParentDirChain;
//               writeFileAtomic with backupBuffer; filesRestored.push;
//               backupsToDelete.push.
//             reverse-sentinel -> removeSentinelBlock + normalize +
//               writeFileAtomic; filesRestored.push.
//             reverse-json-key-merge -> deleteAtKeyPath + prettyJson
//               + normalize + writeFileAtomic; filesRestored.push.
//        c. updateJournal phase: "updating-integrations".
//      else:
//        no journal written; execution loop skipped.
//  13. build updated IntegrationsFile (record removed; history
//      "uninstall" appended); await writeIntegrationsFile.
//  14. if journal was written:
//        a. updateJournal phase: "done".
//        b. best-effort deleteJournal (warn on failure; commit
//           stands).
//  15. for each backupAbsolutePath in backupsToDelete: best-effort
//      unlink (warn on failure; commit stands).
//  16. return UninstallOutcome.uninstalled with receipt.
//  17. finally: best-effort releaseLock (warn on failure; commit
//      stands).
//
// === RECEIPT CONSTRUCTION ===
//
//   filesRemoved: absolute paths of unlinked write-new targets (in
//     reverse record.ops order).
//   filesRestored: absolute paths of writeFileAtomic-touched files
//     (backup-and-write / sentinel-* / json-key-merge reversals; in
//     reverse record.ops order).
//   adapterName: from existing record.
//   humanSummary: `Uninstalled ${record.adapterName}
//                  (${reversed} ops reversed)` where
//                  reversed = filesRemoved.length + filesRestored.length.
//                  Skip plans contribute 0 to the count.

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  findSentinelBlock,
  type JsonObject,
  type JsonValue,
  removeSentinelBlock,
} from "@viberevert/adapters";

import { writeFileAtomic } from "./atomic.js";
import { prettyJson, sha256OfCanonical } from "./canonical-json.js";
import { chooseTargetLineEnding, sha256OfUtf8 } from "./engine-classify.js";
import type {
  RecordKey,
  UninstallContext,
  UninstallOutcome,
  UninstallReceipt,
} from "./engine-types.js";
import {
  IntegrationTargetParentNotDirectoryError,
  PendingIntegrationRecoveryError,
  SymlinkTargetRefusal,
  TargetOutsideRepoRootError,
} from "./errors.js";
import type {
  IntegrationFileEditRecord,
  IntegrationRecord,
  IntegrationsFile,
  PathSpec,
} from "./integrations-schema.js";
import { readIntegrationsFile, writeIntegrationsFile } from "./integrations-store.js";
import {
  deleteJournal,
  type JournalEntry,
  type PlannedJournalOp,
  scanForPendingJournals,
  updateJournal,
  writeJournal,
} from "./journal.js";
import { normalizeToWriteFormat } from "./line-endings.js";
import { acquireLock, releaseLock } from "./lock.js";
import { resolvePath } from "./path-resolve.js";
import { assertSafeTarget } from "./preflight-target.js";

const VIBEREVERT_DIR_NAME = ".viberevert";
const JOURNAL_DIR_NAME = "integration-journal";
const HISTORY_RETENTION_LIMIT = 999;

const DRIFT_REASON_CODE = "integrations-content-drift";
const BACKUP_MISSING_REASON_CODE = "backup-file-missing-on-disk";
const DUPLICATE_RECORD_PATH_REASON_CODE = "integrations-record-duplicate-target";
const CORRUPTED_OP_REASON_CODE = "integrations-record-corrupted-op";

// ---------------------------------------------------------------------------
// Internal types.
// ---------------------------------------------------------------------------

type ReversePlan =
  | {
      readonly kind: "skip";
      readonly recordOp: IntegrationFileEditRecord;
      readonly reason: string;
    }
  | {
      readonly kind: "reverse-write-new";
      readonly recordOp: IntegrationFileEditRecord;
      readonly absolutePath: string;
    }
  | {
      readonly kind: "reverse-backup-and-write";
      readonly recordOp: IntegrationFileEditRecord;
      readonly absolutePath: string;
      readonly backupAbsolutePath: string;
      readonly backupBuffer: Buffer;
    }
  | {
      readonly kind: "reverse-sentinel";
      readonly recordOp: IntegrationFileEditRecord;
      readonly absolutePath: string;
      readonly currentText: string;
      readonly lineEnding: "LF" | "CRLF";
    }
  | {
      readonly kind: "reverse-json-key-merge";
      readonly recordOp: IntegrationFileEditRecord;
      readonly absolutePath: string;
      readonly currentText: string;
      readonly lineEnding: "LF" | "CRLF";
    }
  | {
      readonly kind: "refuse";
      readonly recordOp: IntegrationFileEditRecord;
      readonly reasonCode: string;
      readonly detailLine: string;
    };

// ---------------------------------------------------------------------------
// UTC slug (duplicated from engine-apply.ts; refactor to shared in 2I).
// ---------------------------------------------------------------------------

function utcSlugFromDate(d: Date): string {
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  const pad3 = (n: number): string => n.toString().padStart(3, "0");
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const MM = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  const ms = pad3(d.getUTCMilliseconds());
  return `${yyyy}${MM}${dd}T${hh}${mm}${ss}${ms}Z`;
}

// ---------------------------------------------------------------------------
// Local JSON helpers (duplicated from engine-classify private; pure;
// 2I may consolidate).
// ---------------------------------------------------------------------------

function jsonValueAtKeyPath(
  root: JsonValue,
  keyPath: ReadonlyArray<string>,
): JsonValue | undefined {
  let cur: JsonValue = root;
  for (const segment of keyPath) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    const obj = cur as JsonObject;
    if (!(segment in obj)) return undefined;
    cur = obj[segment] as JsonValue;
  }
  return cur;
}

/**
 * Delete the leaf at keyPath. Does NOT prune empty ancestor
 * objects: deleting ["mcpServers", "viberevert"] from
 * { mcpServers: { viberevert: {...} } } leaves { mcpServers: {} }.
 * If any intermediate path is missing or non-object, returns root
 * unchanged (delete is idempotent when target absent).
 */
function deleteAtKeyPath(root: JsonObject, keyPath: ReadonlyArray<string>): JsonObject {
  if (keyPath.length === 0) {
    throw new Error("deleteAtKeyPath: cannot delete root");
  }
  const head = keyPath[0];
  if (head === undefined) {
    throw new Error("deleteAtKeyPath: empty key segment");
  }
  if (keyPath.length === 1) {
    if (!(head in root)) return root;
    const rest: Record<string, JsonValue> = {};
    for (const key of Object.keys(root)) {
      if (key !== head) rest[key] = root[key] as JsonValue;
    }
    return rest;
  }
  const existing = root[head];
  if (
    existing === undefined ||
    existing === null ||
    typeof existing !== "object" ||
    Array.isArray(existing)
  ) {
    return root;
  }
  const childAsObject = existing as JsonObject;
  const newChild = deleteAtKeyPath(childAsObject, keyPath.slice(1));
  if (newChild === childAsObject) return root;
  return { ...root, [head]: newChild };
}

function parseJsonObjectOrEmpty(currentText: string): JsonObject {
  const parsed: unknown = JSON.parse(currentText);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError(
      "json-key-merge target's existing content is valid JSON but its root is not an object",
    );
  }
  return parsed as JsonObject;
}

// ---------------------------------------------------------------------------
// Record-based SHA helpers (vs FileEditOp-based in engine-classify).
// ---------------------------------------------------------------------------

function extractCurrentShaFromRecordOp(
  recordOp: IntegrationFileEditRecord,
  currentText: string | null,
): string | null {
  switch (recordOp.kind) {
    case "write-new":
    case "backup-and-write":
      return currentText === null ? null : sha256OfUtf8(currentText);
    case "sentinel-block-insert":
    case "sentinel-block-replace": {
      if (currentText === null) return null;
      if (recordOp.blockId === null) {
        throw new Error("unreachable: sentinel record op without blockId (schema invariant)");
      }
      const found = findSentinelBlock(currentText, recordOp.blockId);
      return found === null ? null : sha256OfUtf8(found.content);
    }
    case "json-key-merge": {
      if (currentText === null) return null;
      if (recordOp.jsonKeyPath === null) {
        throw new Error(
          "unreachable: json-key-merge record op without jsonKeyPath (schema invariant)",
        );
      }
      const parsed = JSON.parse(currentText) as JsonValue;
      const value = jsonValueAtKeyPath(parsed, recordOp.jsonKeyPath);
      return value === undefined ? null : sha256OfCanonical(value);
    }
  }
}

function extractRecordedShaFromRecordOp(recordOp: IntegrationFileEditRecord): string | null {
  switch (recordOp.kind) {
    case "write-new":
    case "backup-and-write":
      return recordOp.fullFileSha256AfterWrite;
    case "sentinel-block-insert":
    case "sentinel-block-replace":
      return recordOp.managedBlockSha256;
    case "json-key-merge":
      return recordOp.managedValueSha256;
  }
}

// ---------------------------------------------------------------------------
// Record-op -> PlannedJournalOp mapping (for uninstall journal
// plannedOps). Same shape as install's helper but takes a record op.
// ---------------------------------------------------------------------------

function recordOpToPlannedJournalOp(recordOp: IntegrationFileEditRecord): PlannedJournalOp {
  switch (recordOp.kind) {
    case "write-new":
      return { kind: "write-new", target: recordOp.target };
    case "backup-and-write":
      return { kind: "backup-and-write", target: recordOp.target };
    case "sentinel-block-insert":
      if (recordOp.blockId === null) {
        throw new Error(
          "unreachable: sentinel-block-insert record op without blockId (schema invariant)",
        );
      }
      return {
        kind: "sentinel-block-insert",
        target: recordOp.target,
        blockId: recordOp.blockId,
      };
    case "sentinel-block-replace":
      if (recordOp.blockId === null) {
        throw new Error(
          "unreachable: sentinel-block-replace record op without blockId (schema invariant)",
        );
      }
      return {
        kind: "sentinel-block-replace",
        target: recordOp.target,
        blockId: recordOp.blockId,
      };
    case "json-key-merge":
      if (recordOp.jsonKeyPath === null) {
        throw new Error(
          "unreachable: json-key-merge record op without jsonKeyPath (schema invariant)",
        );
      }
      return {
        kind: "json-key-merge",
        target: recordOp.target,
        jsonKeyPath: [...recordOp.jsonKeyPath],
      };
  }
}

// ---------------------------------------------------------------------------
// Defensive per-kind validation (mostly unreachable -- schema's
// superRefine catches at read time -- but defends if a tampered
// record slipped through).
// ---------------------------------------------------------------------------

function preValidateRecordOp(
  recordOp: IntegrationFileEditRecord,
): { ok: true } | { ok: false; reason: string } {
  switch (recordOp.kind) {
    case "write-new":
      if (recordOp.fullFileSha256AfterWrite === null) {
        return { ok: false, reason: "write-new requires fullFileSha256AfterWrite" };
      }
      return { ok: true };
    case "backup-and-write":
      if (recordOp.fullFileSha256AfterWrite === null) {
        return { ok: false, reason: "backup-and-write requires fullFileSha256AfterWrite" };
      }
      if (recordOp.backup === null) {
        return { ok: false, reason: "backup-and-write requires backup PathSpec" };
      }
      return { ok: true };
    case "sentinel-block-insert":
    case "sentinel-block-replace":
      if (recordOp.managedBlockSha256 === null) {
        return { ok: false, reason: `${recordOp.kind} requires managedBlockSha256` };
      }
      if (recordOp.blockId === null) {
        return { ok: false, reason: `${recordOp.kind} requires blockId` };
      }
      return { ok: true };
    case "json-key-merge":
      if (recordOp.managedValueSha256 === null) {
        return { ok: false, reason: "json-key-merge requires managedValueSha256" };
      }
      if (recordOp.jsonKeyPath === null) {
        return { ok: false, reason: "json-key-merge requires jsonKeyPath" };
      }
      return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Duplicate-record-path detection (defensive vs tampered records).
// ---------------------------------------------------------------------------

function findDuplicateRecordPaths(record: IntegrationRecord): string[] {
  const counts = new Map<string, number>();
  for (const op of record.ops) {
    counts.set(op.target.pathRelative, (counts.get(op.target.pathRelative) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c > 1)
    .map(([p]) => p);
}

// ---------------------------------------------------------------------------
// Backup-read with symlink-safe path validation.
// ---------------------------------------------------------------------------

async function readBackupSafely(args: {
  repoRoot: string;
  backupPathSpec: PathSpec;
}): Promise<
  { kind: "ok"; bytes: Buffer; absolutePath: string } | { kind: "missing"; absolutePath: string }
> {
  const absolutePath = resolvePath(args.backupPathSpec, { repoRoot: args.repoRoot });
  // assertSafeTarget with op:"write" walks components, refuses
  // symlinks + outside-root + non-file target; does NOT enforce a
  // size cap (backups are restore evidence, not merge text).
  await assertSafeTarget({
    repoRoot: args.repoRoot,
    targetPath: absolutePath,
    op: "write",
  });
  try {
    const bytes = await readFile(absolutePath);
    return { kind: "ok", bytes, absolutePath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", absolutePath };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// lstat-guarded directory helpers (mirror engine-apply / lock /
// journal / store pattern; refactor to shared in 2I).
// ---------------------------------------------------------------------------

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

async function ensureTargetParentDirChain(args: {
  repoRoot: string;
  targetPath: string;
}): Promise<void> {
  const repoRootAbs = resolve(args.repoRoot);
  const targetDir = dirname(args.targetPath);
  if (targetDir === repoRootAbs) return;
  const rel = relative(repoRootAbs, targetDir);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TargetOutsideRepoRootError({
      repoRoot: repoRootAbs,
      targetPath: args.targetPath,
    });
  }
  const segments = rel.split(sep).filter((s) => s.length > 0);
  let acc = repoRootAbs;
  for (const seg of segments) {
    acc = join(acc, seg);
    await ensureSafeDir(acc, args.targetPath);
  }
}

// ---------------------------------------------------------------------------
// Per-op reverse planning.
//
// Structure: backup-and-write does its backup-read FIRST (non-
// forceable refusal wins over forceable drift). All kinds then go
// through a uniform drift check. Per-kind dispatch applies the
// FORCE + ALREADY-DONE rule for write-new / sentinel / json
// (backup-and-write under force-drift always restores from backup,
// already read above).
// ---------------------------------------------------------------------------

async function planReverse(args: {
  repoRoot: string;
  recordOp: IntegrationFileEditRecord;
  absolutePath: string;
  currentText: string | null;
  forceUninstall: boolean;
}): Promise<ReversePlan> {
  const { repoRoot, recordOp, absolutePath, currentText, forceUninstall } = args;

  // Pre-validate (defensive; mostly unreachable per schema superRefine).
  const validation = preValidateRecordOp(recordOp);
  if (!validation.ok) {
    return {
      kind: "refuse",
      recordOp,
      reasonCode: CORRUPTED_OP_REASON_CODE,
      detailLine: `${recordOp.target.pathRelative}: ${validation.reason}`,
    };
  }

  // For backup-and-write: read backup FIRST. Non-forceable
  // backup-missing refusal wins over forceable drift refusal so
  // users see the real problem first.
  let backupRead:
    | { kind: "ok"; bytes: Buffer; absolutePath: string }
    | { kind: "missing"; absolutePath: string }
    | null = null;
  if (recordOp.kind === "backup-and-write") {
    if (recordOp.backup === null) {
      // Unreachable per preValidateRecordOp but TS doesn't narrow.
      return {
        kind: "refuse",
        recordOp,
        reasonCode: CORRUPTED_OP_REASON_CODE,
        detailLine: `${recordOp.target.pathRelative}: backup-and-write requires backup PathSpec`,
      };
    }
    backupRead = await readBackupSafely({
      repoRoot,
      backupPathSpec: recordOp.backup,
    });
    if (backupRead.kind === "missing") {
      return {
        kind: "refuse",
        recordOp,
        reasonCode: BACKUP_MISSING_REASON_CODE,
        detailLine: `${recordOp.target.pathRelative}: backup file ${backupRead.absolutePath} is missing on disk`,
      };
    }
  }

  // Drift check (uniform; backup-missing already handled above for
  // backup-and-write).
  const currentSha = extractCurrentShaFromRecordOp(recordOp, currentText);
  const recordedSha = extractRecordedShaFromRecordOp(recordOp);
  const noDrift = currentSha !== null && currentSha === recordedSha;

  if (!noDrift && !forceUninstall) {
    return {
      kind: "refuse",
      recordOp,
      reasonCode: DRIFT_REASON_CODE,
      detailLine: `${recordOp.target.pathRelative}: current bytes drift from recorded managed-region SHA`,
    };
  }

  // From here: noDrift OR (drift AND forceUninstall).
  switch (recordOp.kind) {
    case "write-new": {
      if (!noDrift && currentSha === null) {
        return {
          kind: "skip",
          recordOp,
          reason: "force-overrode drift; write-new target already absent",
        };
      }
      return { kind: "reverse-write-new", recordOp, absolutePath };
    }
    case "backup-and-write": {
      if (backupRead === null || backupRead.kind !== "ok") {
        throw new Error("unreachable: backup-and-write dispatch without successful backupRead");
      }
      return {
        kind: "reverse-backup-and-write",
        recordOp,
        absolutePath,
        backupAbsolutePath: backupRead.absolutePath,
        backupBuffer: backupRead.bytes,
      };
    }
    case "sentinel-block-insert":
    case "sentinel-block-replace": {
      if (!noDrift && currentSha === null) {
        return {
          kind: "skip",
          recordOp,
          reason: "force-overrode drift; sentinel block already absent",
        };
      }
      if (currentText === null) {
        throw new Error(
          "unreachable: sentinel reverse plan with null currentText (should have skipped)",
        );
      }
      const lineEnding = chooseTargetLineEnding(currentText);
      return {
        kind: "reverse-sentinel",
        recordOp,
        absolutePath,
        currentText,
        lineEnding,
      };
    }
    case "json-key-merge": {
      if (!noDrift && currentSha === null) {
        return {
          kind: "skip",
          recordOp,
          reason: "force-overrode drift; json key already absent",
        };
      }
      if (currentText === null) {
        throw new Error(
          "unreachable: json-key-merge reverse plan with null currentText (should have skipped)",
        );
      }
      const lineEnding = chooseTargetLineEnding(currentText);
      return {
        kind: "reverse-json-key-merge",
        recordOp,
        absolutePath,
        currentText,
        lineEnding,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Refusal aggregation.
// ---------------------------------------------------------------------------

function aggregateRefusals(
  recordKey: RecordKey,
  adapterName: string,
  plans: ReadonlyArray<ReversePlan>,
): UninstallOutcome | null {
  const refusals = plans.filter(
    (p): p is Extract<ReversePlan, { kind: "refuse" }> => p.kind === "refuse",
  );
  if (refusals.length === 0) return null;
  const first = refusals[0];
  if (first === undefined) {
    throw new Error("unreachable: refusals.length > 0 but refusals[0] undefined");
  }
  const lines = refusals.map((r) => `  - [${r.reasonCode}] ${r.detailLine}`).join("\n");
  const message =
    `Refusing to uninstall ${recordKey}: planner detected the following issues:\n${lines}\n` +
    `Only ordinary content-drift refusals ("${DRIFT_REASON_CODE}") are overrideable ` +
    `with --force-uninstall. All other refusals require a manual fix.`;
  return {
    status: "refused",
    recordKey,
    adapterName,
    reasonCode: first.reasonCode,
    message,
  };
}

// ---------------------------------------------------------------------------
// Build updated IntegrationsFile (record removed; history appended).
// ---------------------------------------------------------------------------

function buildUpdatedIntegrationsFileForUninstall(args: {
  existing: IntegrationsFile;
  recordKey: RecordKey;
  ctx: UninstallContext;
}): IntegrationsFile {
  const { existing, recordKey, ctx } = args;
  const newRecords: Partial<Record<RecordKey, IntegrationRecord>> = {};
  for (const [k, v] of Object.entries(existing.records)) {
    if (k !== recordKey && v !== undefined) {
      newRecords[k as RecordKey] = v;
    }
  }
  const historyTail = existing.history.slice(-HISTORY_RETENTION_LIMIT);
  return {
    schemaVersion: 1,
    createdByVersion: existing.createdByVersion,
    updatedByVersion: ctx.cliVersion,
    records: newRecords,
    history: [
      ...historyTail,
      {
        timestamp: ctx.now.toISOString(),
        action: "uninstall",
        recordKey,
        cliVersion: ctx.cliVersion,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------

/**
 * Reverse the installation of `recordKey`. Returns an
 * UninstallOutcome reflecting the uninstalled, not-installed, or
 * refused result. See top comment for full discipline.
 *
 * Errors propagate per the top-comment error-propagation policy.
 * Lock and journal best-effort cleanup are warning-only on commit-
 * succeeded paths; mid-transaction failures leave the journal
 * pending for the next install/uninstall to refuse.
 */
export async function uninstall(
  recordKey: RecordKey,
  ctx: UninstallContext,
): Promise<UninstallOutcome> {
  // Step 1: acquire lock. Throws IntegrationsLockError on conflict.
  const lockHandle = await acquireLock(ctx.repoRoot, "uninstall");

  try {
    // Step 2: pending journal scan.
    const pending = await scanForPendingJournals(ctx.repoRoot);
    if (pending.length > 0) {
      const journalDir = join(resolve(ctx.repoRoot), VIBEREVERT_DIR_NAME, JOURNAL_DIR_NAME);
      throw new PendingIntegrationRecoveryError({
        journalDir,
        pendingEntries: pending.map((p) => p.filename),
      });
    }

    // Step 3: read integrations.json.
    const integrationsFile = await readIntegrationsFile(ctx.repoRoot);

    // Step 4: not-installed early-return.
    const record = integrationsFile?.records[recordKey] ?? null;
    if (record === null) {
      return {
        status: "not-installed",
        recordKey,
        reason: `no record for ${recordKey} in .viberevert/integrations.json`,
      };
    }
    const safeIntegrationsFile = integrationsFile as IntegrationsFile;

    // Step 5: duplicate-record-path guard.
    const duplicateRecordPaths = findDuplicateRecordPaths(record);
    if (duplicateRecordPaths.length > 0) {
      const lines = duplicateRecordPaths.map((p) => `  - ${p}`).join("\n");
      return {
        status: "refused",
        recordKey,
        adapterName: record.adapterName,
        reasonCode: DUPLICATE_RECORD_PATH_REASON_CODE,
        message:
          `Refusing to uninstall ${recordKey}: integrations record has duplicate target paths:\n${lines}\n` +
          `Manual inspection required (v1 schema invariant violation).`,
      };
    }

    // Step 6: per-kind preflight for every recorded target path.
    // write-new + backup-and-write use op:"write" (skips merge-size
    // cap; these are full-file replacements). Sentinel + json-key-
    // merge use op:"merge" (1 MiB cap applies; read-modify-write).
    const resolvedTargets = record.ops.map((op) => ({
      recordOp: op,
      absolutePath: resolvePath(op.target, { repoRoot: ctx.repoRoot }),
    }));
    for (const { recordOp, absolutePath } of resolvedTargets) {
      const preflightOp: "write" | "merge" =
        recordOp.kind === "write-new" || recordOp.kind === "backup-and-write" ? "write" : "merge";
      await assertSafeTarget({
        repoRoot: ctx.repoRoot,
        targetPath: absolutePath,
        op: preflightOp,
      });
    }

    // Step 7: read current target bytes (UTF-8 string only; raw
    // Buffer not needed -- backups come from readBackupSafely).
    const currentTextByPath = new Map<string, string | null>();
    for (const { recordOp, absolutePath } of resolvedTargets) {
      try {
        const text = await readFile(absolutePath, "utf8");
        currentTextByPath.set(recordOp.target.pathRelative, text);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          currentTextByPath.set(recordOp.target.pathRelative, null);
        } else {
          throw err;
        }
      }
    }

    // Step 8: build reverse plans (sequential; planReverse may do
    // readBackupSafely I/O).
    const plans: ReversePlan[] = [];
    for (const { recordOp, absolutePath } of resolvedTargets) {
      const currentText = currentTextByPath.get(recordOp.target.pathRelative) ?? null;
      const plan = await planReverse({
        repoRoot: ctx.repoRoot,
        recordOp,
        absolutePath,
        currentText,
        forceUninstall: ctx.options.forceUninstall,
      });
      plans.push(plan);
    }

    // Step 9: aggregate refusals.
    const refusedOutcome = aggregateRefusals(recordKey, record.adapterName, plans);
    if (refusedOutcome !== null) return refusedOutcome;

    // Step 10: compute execution order + mutation set.
    const plansInExecutionOrder = [...plans].reverse();
    const targetMutationsInExecutionOrder = plansInExecutionOrder.filter(
      (p) => p.kind !== "skip" && p.kind !== "refuse",
    );
    const hasMutations = targetMutationsInExecutionOrder.length > 0;

    // Step 11: txnId + backupGroupId (shared per locked rule).
    const txnId = randomUUID();
    const backupGroupId = `${utcSlugFromDate(ctx.now)}--${txnId}`;

    const filesRemoved: string[] = [];
    const filesRestored: string[] = [];
    const backupsToDelete: string[] = [];

    // Step 12: journal init + reverse execution (mutation only).
    if (hasMutations) {
      const plannedOps: PlannedJournalOp[] = targetMutationsInExecutionOrder.map((p) =>
        recordOpToPlannedJournalOp(p.recordOp),
      );
      const journalEntry: JournalEntry = {
        txnId,
        recordKey,
        adapterName: record.adapterName,
        startedAt: ctx.now.toISOString(),
        command: "uninstall",
        cliVersion: ctx.cliVersion,
        phase: "writing-files",
        plannedOps,
        recordedOps: [...record.ops],
        backupPaths: [],
      };
      await writeJournal(ctx.repoRoot, journalEntry);

      // Execute ALL plans in execution order. Skip plans are silent
      // no-ops at their position in the reversed sequence; they
      // contribute nothing to the receipt.
      for (const plan of plansInExecutionOrder) {
        switch (plan.kind) {
          case "skip":
            break;
          case "refuse":
            throw new Error("unreachable: refuse plan in execution phase");
          case "reverse-write-new":
            await unlink(plan.absolutePath);
            filesRemoved.push(plan.absolutePath);
            break;
          case "reverse-backup-and-write":
            await ensureTargetParentDirChain({
              repoRoot: ctx.repoRoot,
              targetPath: plan.absolutePath,
            });
            await writeFileAtomic(plan.absolutePath, plan.backupBuffer);
            filesRestored.push(plan.absolutePath);
            backupsToDelete.push(plan.backupAbsolutePath);
            break;
          case "reverse-sentinel": {
            if (plan.recordOp.blockId === null) {
              throw new Error("unreachable: reverse-sentinel plan with null blockId on recordOp");
            }
            const newText = removeSentinelBlock(plan.currentText, plan.recordOp.blockId);
            const normalized = normalizeToWriteFormat(newText, plan.lineEnding);
            await writeFileAtomic(plan.absolutePath, normalized);
            filesRestored.push(plan.absolutePath);
            break;
          }
          case "reverse-json-key-merge": {
            if (plan.recordOp.jsonKeyPath === null) {
              throw new Error(
                "unreachable: reverse-json-key-merge plan with null jsonKeyPath on recordOp",
              );
            }
            const parsed = parseJsonObjectOrEmpty(plan.currentText);
            const updated = deleteAtKeyPath(parsed, plan.recordOp.jsonKeyPath);
            const rendered = `${prettyJson(updated)}\n`;
            const normalized = normalizeToWriteFormat(rendered, plan.lineEnding);
            await writeFileAtomic(plan.absolutePath, normalized);
            filesRestored.push(plan.absolutePath);
            break;
          }
        }
      }

      await updateJournal(ctx.repoRoot, txnId, { phase: "updating-integrations" });
    }
    // else: all-skip path; no journal written; execution loop skipped.

    // Step 13: build + write integrations.json.
    const updatedFile = buildUpdatedIntegrationsFileForUninstall({
      existing: safeIntegrationsFile,
      recordKey,
      ctx,
    });
    await writeIntegrationsFile({
      repoRoot: ctx.repoRoot,
      next: updatedFile,
      backupGroupId,
    });

    // Step 14: journal phase done + best-effort delete (mutation only).
    if (hasMutations) {
      await updateJournal(ctx.repoRoot, txnId, { phase: "done" });
      try {
        await deleteJournal(ctx.repoRoot, txnId);
      } catch (err) {
        process.stderr.write(
          `warning: uninstall committed but failed to delete journal ${txnId}: ${(err as Error).message}\n` +
            `The transaction succeeded; the pending journal entry can be safely removed manually.\n`,
        );
      }
    }

    // Step 15: best-effort backup deletion.
    for (const backupAbsPath of backupsToDelete) {
      try {
        await unlink(backupAbsPath);
      } catch (err) {
        process.stderr.write(
          `warning: uninstall committed but failed to delete restored backup ${backupAbsPath}: ${(err as Error).message}\n` +
            `The transaction succeeded; the orphan backup file can be safely removed manually.\n`,
        );
      }
    }

    // Step 16: build receipt.
    const opsReversed = filesRemoved.length + filesRestored.length;
    const receipt: UninstallReceipt = {
      recordKey,
      adapterName: record.adapterName,
      filesRemoved,
      filesRestored,
      humanSummary: `Uninstalled ${record.adapterName} (${opsReversed} ops reversed)`,
    };
    return { status: "uninstalled", receipt };
  } finally {
    // Step 17: best-effort lock release.
    try {
      await releaseLock(lockHandle);
    } catch (err) {
      process.stderr.write(
        `warning: failed to release installer lock: ${(err as Error).message}\n` +
          `If no other installer is running, remove .viberevert/integrations.lock/ manually.\n`,
      );
    }
  }
}
