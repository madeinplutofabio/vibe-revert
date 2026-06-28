// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Engine apply for @viberevert/installers.
//
// === ENTRY ===
// apply(plan, ctx) -> InstallOutcome
//   Mutating orchestration. Models the SAME D101.B drift/refusal
//   table as preview (via shared engine-classify) but COMMITS the
//   resulting transaction: acquires the per-repo install lock,
//   refuses on pending recovery journal, writes target-file
//   backups (raw bytes, byte-preserving), atomically mutates
//   target files (with chmod where applicable on POSIX), commits
//   the integrations record, and releases the lock.
//
// === OUTCOMES ===
//   - InstallOutcome.refused: adapter-plan refused upstream (passed
//     through; no recordKey per asymmetry), OR engine-classified
//     refusal (drift / cross-kind / target-exists / target-missing /
//     sentinel-block-missing / duplicate-plan-path /
//     duplicate-record-path / empty-applicable-plan) WITH recordKey.
//   - InstallOutcome.noop: pure-noop transaction (every op is
//     would-noop). Acquires + releases lock; no journal, no backup,
//     no store mutation.
//   - InstallOutcome.applied: transaction committed.
//       receipt.opsApplied = count of would-apply + would-safe-update
//         (would-noop and would-adopt do NOT count as file ops).
//       receipt.filesWritten = absolute paths of target files
//         actually mutated (would-apply / would-safe-update only;
//         appended only after BOTH writeFileAtomic AND chmodIfPosix
//         succeed).
//       receipt.backupsCreated = absolute paths of backup files
//         actually written (one per backup-and-write op whose
//         assessment is would-apply, would-safe-update, OR
//         would-adopt -- see ADOPTION-AND-BACKUP below).
//       receipt.integrationsJsonPath = absolute path of the
//         updated .viberevert/integrations.json.
//       receipt.humanSummary = plan.humanSummary, OR the adoption
//         summary in adoption-only transactions.
//
// === BOUNDARY (locked by 2H.2 scope) ===
//
// apply DOES write to disk (through the named modules only):
//   - Per-op target files via writeFileAtomic (atomic.ts; UTF-8
//     strings -- installer targets are TEXT CONFIG FILES; binary
//     targets are out of scope by design).
//   - Per-op chmod (node:fs/promises) where applicable on POSIX.
//   - Per-op backup files via writeFile {flag:"wx"} with RAW Buffer
//     bytes (for backup-and-write only). EEXIST maps to
//     BackupCollisionError. Raw bytes preserve non-UTF-8 sequences
//     verbatim so recovery is byte-faithful.
//   - Target parent directory chain via lstat-guarded non-recursive
//     mkdir (ensureTargetParentDirChain), per level from repoRoot
//     down to dirname(targetPath). Refuses symlinks and non-dirs.
//   - .viberevert/integration-backups/<recordKey>/<backupGroupId>/
//     directory chain via lstat-guarded non-recursive mkdir
//     (ensureBackupDirChain).
//   - .viberevert/integrations.json + its store-self-backup via
//     writeIntegrationsFile (integrations-store.ts).
//   - .viberevert/integrations.lock/ + pid.json via acquireLock /
//     releaseLock (lock.ts).
//   - .viberevert/integration-journal/<txnId>.json via writeJournal /
//     updateJournal / deleteJournal (journal.ts; mutation only).
//
// apply NEVER writes:
//   - Anything outside the repo root (assertSafeTarget refuses;
//     ensureTargetParentDirChain re-verifies the repo boundary
//     defensively).
//   - Through symlinked components (assertSafeTarget refuses;
//     every directory ensure step lstat-guards).
//   - With recursive mkdir (would follow symlinks); always
//     per-level lstat-guarded.
//   - The user's .gitignore (D101.P: warn-only; auto-edit FORBIDDEN).
//
// === ERROR PROPAGATION ===
//
// In-band refusals returned as InstallOutcome.refused (recordKey
// asymmetry per engine-types: adapter passthrough omits recordKey;
// engine-classifier outputs include it):
//   - Adapter RefusedPlan (passthrough; no recordKey)
//   - empty-applicable-plan, duplicate-target-path-in-plan
//     (engine pre-lock checks)
//   - integrations-record-duplicate-target, integrations-content-drift,
//     integrations-record-kind-mismatch, target-exists-not-managed,
//     target-missing-for-backup-and-write,
//     sentinel-block-missing-for-replace (engine-classifier outputs)
//
// Out-of-band errors propagated as throws:
//   - IntegrationsLockError (lock already held)
//   - PendingIntegrationRecoveryError (pending journal found
//     before the new transaction starts)
//   - SymlinkTargetRefusal, TargetOutsideRepoRootError,
//     IntegrationTargetParentNotDirectoryError,
//     IntegrationTargetNotFileError,
//     IntegrationTargetTooLargeError (from assertSafeTarget +
//     ensureTargetParentDirChain + ensureBackupDirChain)
//   - IntegrationsCorruptedError, IntegrationsSchemaVersionError
//     (from readIntegrationsFile)
//   - SyntaxError (from JSON.parse of an invalid json-key-merge
//     existing outer file; classifier throws via
//     parseJsonObjectOrEmpty)
//   - BackupCollisionError (collision-impossible with the locked
//     unique backupGroupId scheme but defensive; from writeFile{wx})
//   - ZodError (from writeIntegrationsFile's IntegrationsFileSchema
//     parse of the updated file -- fires e.g. when an adapter emits
//     non-string meta values that violate MetadataSchema)
//   - I/O errors (chmod EPERM / ENOSYS, ENOSPC, etc.)
//
// Mid-transaction failures leave the journal pending (for mutation
// transactions) AND/OR orphan backups under integration-backups/
// AND/OR partial target writes. The next install/uninstall sees
// the pending journal and refuses with
// PendingIntegrationRecoveryError; the user inspects + cleans
// manually (locked rule 7: no auto-recovery in Step 2).
//
// === MUTATION SEQUENCE (locked) ===
//
//   0. Pre-lock checks (no I/O beyond plan inspection):
//      a. plan.status === "refused" -> InstallOutcome.refused
//         (adapter passthrough; no recordKey).
//      b. plan.ops.length === 0 -> InstallOutcome.refused
//         (empty-applicable-plan; with recordKey).
//      c. findDuplicatePlanPaths non-empty -> InstallOutcome.refused
//         (duplicate-target-path-in-plan; with recordKey).
//
//   1. await acquireLock(repoRoot, "install").
//
//   2. Inside try (with finally releaseLock):
//      a. await scanForPendingJournals -> throw
//         PendingIntegrationRecoveryError if any.
//      b. await assertSafeTarget per op (preflight; throws on
//         symlink / outside-root / oversize / non-file /
//         non-dir parent).
//      c. await readIntegrationsFile -> integrationsFile, record.
//      d. await readFile per target as raw Buffer -> populate
//         currentRawBytesByPath; also UTF-8-decode to populate
//         currentTextByPath for classifier use. (ENOENT -> null
//         in both maps.)
//      e. Per-op classification with record-duplicate guard ->
//         assessments[].
//      f. Aggregate -> ApplyAggregate ("refused" / "noop" /
//         "adoption" / "mutation").
//      g. If "refused" -> InstallOutcome.refused.
//      h. If "noop" -> InstallOutcome.noop.
//
//      (Reaching here means aggregate is "adoption" or "mutation";
//      both write integrations.json. "mutation" also writes target
//      files + uses the journal.)
//
//      i. Generate ONE transactionId via crypto.randomUUID().
//         backupGroupId = utcSlug(ctx.now) + "--" + transactionId.
//         The SAME transactionId names the journal file AND scopes
//         the backupGroupId so a single txn has one audit
//         identifier.
//      j. Compute OpExecutionPlan[] for ops contributing to record
//         build (excludes would-noop; those preserve their existing
//         record-op verbatim in step n). Each plan carries: op,
//         assessment, absolutePath, currentBytes (UTF-8 string),
//         currentRawBytes (Buffer; for backup write only),
//         desiredFullFileBytes (UTF-8 string), desiredManagedSha,
//         backupPathSpec (backup-and-write only), backupAbsolutePath
//         (backup-and-write only), recordOp (precomputed fresh
//         IntegrationFileEditRecord).
//      k. (mutation only) await writeJournal with
//         phase: "writing-files",
//         plannedOps: target-mutation set only (filtered to
//           assessment.kind === "would-apply" || "would-safe-update";
//           adopted backup-and-write writes a backup but is NOT a
//           planned target mutation; .min(1) is satisfied because
//           "mutation" implies at least one such op),
//         recordedOps: [],
//         backupPaths: [].
//      l. Per OpExecutionPlan in plan.ops order: if needsNewBackup
//         (backup-and-write whose assessment is adopt/apply/
//         safe-update), ensure the backup dir chain (lstat-
//         guarded mkdir per level) + await writeFile {flag:"wx"}
//         backup as RAW Buffer (preserves non-UTF-8 bytes
//         verbatim). EEXIST -> BackupCollisionError. Append to
//         backupsCreated[]; track backup PathSpec.
//         (mutation only) After each backup, await updateJournal
//         with the accumulated backupPaths[].
//      m. (mutation only) Per OpExecutionPlan in plan.ops order
//         whose assessment is would-apply or would-safe-update:
//           - await ensureTargetParentDirChain (lstat-guarded
//             non-recursive mkdir from repoRoot down to
//             dirname(absolutePath); refuses symlinks; never
//             creates outside repo).
//           - await writeFileAtomic target with desiredFullFileBytes
//             (UTF-8 string).
//           - await chmodIfPosix with op.mode for write-new /
//             backup-and-write.
//           - On success: push recordOp (precomputed
//             IntegrationFileEditRecord) into
//             recordedOpsAccumulator; await updateJournal with the
//             accumulated recordedOps[]. Push absolute target path
//             into filesWritten[]. (recordedOps + filesWritten
//             entries only appear AFTER both write AND chmod
//             succeed; a chmod failure means the op is NOT marked
//             recorded.)
//      n. Build updated IntegrationsFile.records[plan.recordKey]:
//         per plan op in plan.ops order:
//           would-noop  -> preserve existing record op verbatim
//                          (keeps original backup pathRelative +
//                          SHA unchanged). Requires existing record
//                          had a single matching op for this path
//                          (duplicate-record-path guard in step 2e
//                          enforces this).
//           would-adopt / would-apply / would-safe-update ->
//             use OpExecutionPlan.recordOp (precomputed in step j).
//      o. (mutation only) await updateJournal phase:
//         "updating-integrations".
//      p. await writeIntegrationsFile (passes backupGroupId so the
//         store's own self-backup of integrations.json lands under
//         __store__/<backupGroupId>/, sharing the txn audit trail).
//      q. (mutation only) await updateJournal phase: "done".
//      r. (mutation only) await deleteJournal -- BEST EFFORT;
//         on failure, write stderr warning and DO NOT roll back.
//      s. Return InstallOutcome.applied with receipt (absolute
//         paths everywhere).
//
//   3. finally: await releaseLock -- BEST EFFORT; on failure,
//      write stderr warning and DO NOT roll back the committed
//      transaction. Lock dir remains; user clears manually.
//
// === FAILURE CLEANUP (locked) ===
//
//   - Before journal write: no cleanup; nothing mutated.
//   - After journal write: NO auto-recovery in Step 2. Errors
//     propagate; journal stays pending; next install/uninstall
//     refuses with PendingIntegrationRecoveryError.
//   - Backup succeeds + later mutation/store-write fails: backup
//     LEFT in place as crash evidence. Journal stays pending for
//     mutation transactions.
//   - Target mutation partially succeeds: leave journal pending;
//     some files written, some not; user inspects manually.
//   - chmod failure after writeFileAtomic: op is NOT pushed into
//     recordedOps; filesWritten omits this entry; apply throws.
//     The file IS on disk (write succeeded) but the record won't
//     reflect it; user manually inspects.
//   - releaseLock attempted in finally; never deletes the journal
//     as cleanup unless commit reached step (r).
//   - deleteJournal failure after commit: stderr warning; commit
//     stands. Next install sees journal with phase "done" so the
//     user knows it is safe to delete manually.
//   - releaseLock failure after commit: stderr warning; commit
//     stands; the stale .viberevert/integrations.lock dir is the
//     user's to clear (`rm -rf .viberevert/integrations.lock`).
//
// === ADOPTION-ONLY ORPHAN-BACKUP CASE ===
//
// Adoption-only transactions DO write internal backup files (one
// per adopted backup-and-write op; see ADOPTION-AND-BACKUP below)
// AND write .viberevert/integrations.json. There is NO journal for
// adoption-only. If a backup write succeeds and the subsequent
// writeIntegrationsFile fails, the result is an ORPHAN INTERNAL
// BACKUP -- harmless stale internal state under
// .viberevert/integration-backups/<recordKey>/<backupGroupId>/.
// The next install run uses a fresh UUID-based backupGroupId so
// cannot collide with the orphan. No auto-recovery needed; user
// MAY manually delete .viberevert/integration-backups/<old-groupId>/
// directories if they appear stale.
//
// === MODE HANDLING (D101.K) ===
//
// For write-new / backup-and-write with op.mode !== undefined:
//   - POSIX (process.platform !== "win32"): chmod(absolutePath,
//     op.mode) AFTER writeFileAtomic. Failure (EPERM / ENOSYS on
//     WSL2 drvfs without metadata extension / etc.) treats the
//     whole transaction as failed; journal stays pending. The
//     mutating op is NOT pushed into recordedOps -- only
//     write+chmod-success ops are marked recorded.
//   - Windows: skip chmod silently (no-op). The recorded `mode`
//     field still captures the adapter's intent for portable
//     uninstall + cross-platform parity.
// For sentinel / json-key-merge ops: mode is null in the record;
// no chmod attempted.
//
// === STORE WRITE CONTENT ===
//
// updated IntegrationsFile:
//   schemaVersion: 1 (locked).
//   createdByVersion: existing?.createdByVersion ?? ctx.cliVersion.
//   updatedByVersion: ctx.cliVersion (always overwritten).
//   records: existing.records spread + records[plan.recordKey] =
//     fresh IntegrationRecord (recordKey / adapterName / installedAt:
//     ctx.now.toISOString() / installedByVersion: ctx.cliVersion /
//     ops: per-op records in plan.ops order / meta: plan.meta).
//   history: (existing?.history ?? []).slice(-999) + new HistoryEntry
//     with action: isAdoptionOnly ? "adopt" : "install".
//
// plan.meta is typed JsonObject (adapter contract) but the durable
// MetadataSchema requires Record<string, string>. Apply passes
// plan.meta verbatim (via `as unknown as Record<string, string>`
// cast at the boundary); writeIntegrationsFile's internal
// IntegrationsFileSchema.parse fails (ZodError) if the adapter
// emitted non-stringmap meta. Treated as adapter misbehavior;
// error propagates to caller.
//
// === BACKUP DISCIPLINE + ADOPTION-AND-BACKUP ===
//
// Per IntegrationFileEditRecord superRefine:
//   - backup-and-write REQUIRES backup !== null
//   - all other op kinds REQUIRE backup === null
//
// Backup bytes are written as RAW Buffer (no encoding parameter)
// to preserve the target file's bytes verbatim, including any
// non-UTF-8 sequences. The classifier uses a UTF-8-decoded view
// of the same bytes for SHA + diff computation (installer targets
// are text-shaped), but the on-disk backup is byte-faithful so
// uninstall can restore exactly what was there.
//
// ADOPTION-AND-BACKUP (locked): adoption of backup-and-write MUST
// still write a backup file (redundant -- backup bytes equal
// current bytes equal desired bytes by definition) so the record
// invariant holds and uninstall finds a backup to restore from.
// The "ADOPTION_HUMAN_SUMMARY: would adopt existing managed state
// without file changes" wording refers to USER (target) files;
// backups under .viberevert/integration-backups/ are internal
// bookkeeping the user does not see.
//
// Backup PathSpec construction (per op for backup-and-write):
//   pathRelative = .viberevert/integration-backups/<recordKey>/
//                  <backupGroupId>/encodeBackupPath(op.target.pathRelative)
//   pathTemplate = {repo}/<pathRelative>
// encodeBackupPath produces <sha256-12>--<basename> (path-encode.ts);
// collision-impossible with unique backupGroupId.
//
// === opsApplied DERIVATION ===
//
//   adoption-only -> opsApplied: 0, filesWritten: [],
//                    backupsCreated: backups for adopted
//                    backup-and-write ops (may be non-empty).
//   pure noop     -> apply doesn't reach this branch (returns
//                    InstallOutcome.noop instead).
//   mutation      -> opsApplied: count(would-apply +
//                    would-safe-update),
//                    filesWritten: their target absolute paths,
//                    backupsCreated: backup absolute paths for
//                    every backup-and-write op whose assessment
//                    is adopt/apply/safe-update.
//
// === JOURNAL CONTENT ===
//
// plannedOps (only on mutation transactions; never on adoption-
// only): target-mutation set -- one PlannedJournalOp per plan op
// whose assessment is would-apply or would-safe-update. Adopted
// backup-and-write ops are NOT in plannedOps (no target mutation)
// but their backups ARE tracked under backupPaths.
//
// recordedOps (accumulates during mutation phase): full
// IntegrationFileEditRecord[] -- one entry per target mutation
// that completed BOTH writeFileAtomic AND chmodIfPosix
// successfully. Updated via updateJournal after each successful
// op. Per journal schema, recordedOps is IntegrationFileEditRecord[]
// (NOT PlannedJournalOp[]); the full record shape carries the SHA
// + backup pointers needed for full recovery context.
//
// backupPaths (accumulates during backup phase): PathSpec[] for
// every backup actually written (mutation OR adopted
// backup-and-write).
//
// fileEditOpToPlannedJournalOp mapping (drops content/value/
// anchor/mode -- not recovery-relevant):
//   write-new         -> {kind, target}
//   backup-and-write  -> {kind, target}
//   sentinel-*        -> {kind, target, blockId}
//   json-key-merge    -> {kind, target, jsonKeyPath: op.keyPath}
//
// === LOCK + JOURNAL EXCLUSIONS FOR ADOPTION-ONLY ===
//
// Adoption-only transactions:
//   - DO acquire the lock (consistent read of store + currents vs
//     concurrent installers).
//   - DO scan for pending journals (refuse if any -- classification
//     could be wrong against a broken prior install).
//   - DO write backups for adopted backup-and-write ops (raw
//     Buffer; redundant but schema-required).
//   - DO write integrations.json.
//   - DO NOT write a journal (no target files mutate;
//     integrations-store's own __store__/ self-backup covers
//     integrations.json crash safety).
//   - DO release the lock.

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AdapterContext, AdapterPlan, ApplicablePlan, FileEditOp } from "@viberevert/adapters";

import { writeFileAtomic } from "./atomic.js";
import {
  ADOPTION_HUMAN_SUMMARY,
  chooseTargetLineEnding,
  classifyOp,
  computeDesiredFullFileBytes,
  computeDesiredManagedRegionSha,
  DUPLICATE_PLAN_PATH_REASON_CODE,
  DUPLICATE_RECORD_PATH_REASON_CODE,
  EMPTY_PLAN_REASON_CODE,
  findDuplicatePlanPaths,
  type PerOpAssessment,
  refuseAssessment,
} from "./engine-classify.js";
import type { InstallOutcome, InstallReceipt, RecordKey } from "./engine-types.js";
import {
  BackupCollisionError,
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
import { acquireLock, releaseLock } from "./lock.js";
import { encodeBackupPath } from "./path-encode.js";
import { resolvePath } from "./path-resolve.js";
import { assertSafeTarget } from "./preflight-target.js";

const VIBEREVERT_DIR_NAME = ".viberevert";
const INTEGRATIONS_FILENAME = "integrations.json";
const BACKUPS_DIR_NAME = "integration-backups";
const JOURNAL_DIR_NAME = "integration-journal";
const HISTORY_RETENTION_LIMIT = 999;

// ---------------------------------------------------------------------------
// Internal types.
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  readonly op: FileEditOp;
  readonly absolutePath: string;
}

interface OpExecutionPlan {
  readonly op: FileEditOp;
  readonly assessment: PerOpAssessment;
  readonly absolutePath: string;
  /** UTF-8 decoded view; null on ENOENT. Classifier + diff use this. */
  readonly currentBytes: string | null;
  /** Raw bytes for byte-preserving backup write; null on ENOENT. */
  readonly currentRawBytes: Buffer | null;
  readonly desiredFullFileBytes: string;
  readonly desiredManagedSha: string;
  /** Non-null only for backup-and-write whose assessment is adopt/apply/safe-update. */
  readonly backupPathSpec: PathSpec | null;
  /** Non-null iff backupPathSpec non-null. */
  readonly backupAbsolutePath: string | null;
  /** Precomputed fresh IntegrationFileEditRecord (used in mutation loop's recordedOps AND in final integrations-file build). */
  readonly recordOp: IntegrationFileEditRecord;
}

type ApplyAggregate =
  | { readonly kind: "refused"; readonly outcome: InstallOutcome }
  | { readonly kind: "noop"; readonly outcome: InstallOutcome }
  | { readonly kind: "adoption" }
  | { readonly kind: "mutation" };

// ---------------------------------------------------------------------------
// UTC slug.
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
// FileEditOp -> PlannedJournalOp mapping.
// ---------------------------------------------------------------------------

function fileEditOpToPlannedJournalOp(op: FileEditOp): PlannedJournalOp {
  switch (op.kind) {
    case "write-new":
      return { kind: "write-new", target: op.target };
    case "backup-and-write":
      return { kind: "backup-and-write", target: op.target };
    case "sentinel-block-insert":
      return { kind: "sentinel-block-insert", target: op.target, blockId: op.blockId };
    case "sentinel-block-replace":
      return { kind: "sentinel-block-replace", target: op.target, blockId: op.blockId };
    case "json-key-merge":
      return { kind: "json-key-merge", target: op.target, jsonKeyPath: [...op.keyPath] };
  }
}

// ---------------------------------------------------------------------------
// Backup path construction.
// ---------------------------------------------------------------------------

function backupPathSpecFor(args: {
  recordKey: RecordKey;
  backupGroupId: string;
  originalPathRelative: string;
}): PathSpec {
  const leaf = encodeBackupPath(args.originalPathRelative);
  const rel = `${VIBEREVERT_DIR_NAME}/${BACKUPS_DIR_NAME}/${args.recordKey}/${args.backupGroupId}/${leaf}`;
  return {
    scope: "repo",
    pathTemplate: `{repo}/${rel}`,
    pathRelative: rel,
  };
}

// ---------------------------------------------------------------------------
// Per-op record construction (per D101.C + IntegrationFileEditRecord superRefine).
// ---------------------------------------------------------------------------

function constructIntegrationFileEditRecord(args: {
  op: FileEditOp;
  desiredManagedSha: string;
  backupPathSpec: PathSpec | null;
}): IntegrationFileEditRecord {
  const { op, desiredManagedSha, backupPathSpec } = args;
  switch (op.kind) {
    case "write-new":
      return {
        kind: "write-new",
        target: op.target,
        backup: null,
        managedBlockSha256: null,
        managedValueSha256: null,
        fullFileSha256AfterWrite: desiredManagedSha,
        blockId: null,
        jsonKeyPath: null,
        mode: op.mode ?? null,
      };
    case "backup-and-write":
      if (backupPathSpec === null) {
        throw new Error(
          "constructIntegrationFileEditRecord: backup-and-write requires backupPathSpec",
        );
      }
      return {
        kind: "backup-and-write",
        target: op.target,
        backup: backupPathSpec,
        managedBlockSha256: null,
        managedValueSha256: null,
        fullFileSha256AfterWrite: desiredManagedSha,
        blockId: null,
        jsonKeyPath: null,
        mode: op.mode ?? null,
      };
    case "sentinel-block-insert":
      return {
        kind: "sentinel-block-insert",
        target: op.target,
        backup: null,
        managedBlockSha256: desiredManagedSha,
        managedValueSha256: null,
        fullFileSha256AfterWrite: null,
        blockId: op.blockId,
        jsonKeyPath: null,
        mode: null,
      };
    case "sentinel-block-replace":
      return {
        kind: "sentinel-block-replace",
        target: op.target,
        backup: null,
        managedBlockSha256: desiredManagedSha,
        managedValueSha256: null,
        fullFileSha256AfterWrite: null,
        blockId: op.blockId,
        jsonKeyPath: null,
        mode: null,
      };
    case "json-key-merge":
      return {
        kind: "json-key-merge",
        target: op.target,
        backup: null,
        managedBlockSha256: null,
        managedValueSha256: desiredManagedSha,
        fullFileSha256AfterWrite: null,
        blockId: null,
        jsonKeyPath: [...op.keyPath],
        mode: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Backup write predicate.
// ---------------------------------------------------------------------------

function needsNewBackup(opPlan: OpExecutionPlan): boolean {
  if (opPlan.op.kind !== "backup-and-write") return false;
  const k = opPlan.assessment.kind;
  return k === "would-apply" || k === "would-safe-update" || k === "would-adopt";
}

// ---------------------------------------------------------------------------
// chmod (POSIX only; Windows skip silently).
// ---------------------------------------------------------------------------

async function chmodIfPosix(absolutePath: string, mode: number | undefined): Promise<void> {
  if (mode === undefined) return;
  if (process.platform === "win32") return;
  await chmod(absolutePath, mode);
}

// ---------------------------------------------------------------------------
// lstat-guarded mkdir helpers (mirror lock.ts / journal.ts /
// integrations-store.ts pattern; refactor to a shared helper in 2I).
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

/**
 * Walk from repoRoot down to dirname(targetPath), lstat-guarding
 * each existing component and creating missing components one
 * level at a time. Never uses recursive mkdir (would follow
 * symlinks). Never creates anything outside repoRoot
 * (defensive -- assertSafeTarget already established this).
 */
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

async function ensureBackupDirChain(args: {
  repoRoot: string;
  recordKey: RecordKey;
  backupGroupId: string;
  eventualBackupAbsolutePath: string;
}): Promise<void> {
  const repoRootAbs = resolve(args.repoRoot);
  const viberevertDir = join(repoRootAbs, VIBEREVERT_DIR_NAME);
  const backupsDir = join(viberevertDir, BACKUPS_DIR_NAME);
  const recordKeyDir = join(backupsDir, args.recordKey);
  const groupDir = join(recordKeyDir, args.backupGroupId);
  await ensureSafeDir(viberevertDir, args.eventualBackupAbsolutePath);
  await ensureSafeDir(backupsDir, args.eventualBackupAbsolutePath);
  await ensureSafeDir(recordKeyDir, args.eventualBackupAbsolutePath);
  await ensureSafeDir(groupDir, args.eventualBackupAbsolutePath);
}

// ---------------------------------------------------------------------------
// Aggregator (mirrors preview's first-match-wins precedence; returns
// ApplyAggregate with InstallOutcome shapes instead of PreviewOutcome).
// ---------------------------------------------------------------------------

function aggregateForApply(
  plan: ApplicablePlan,
  assessments: ReadonlyArray<PerOpAssessment>,
): ApplyAggregate {
  const refusals = assessments.filter(
    (a): a is Extract<PerOpAssessment, { kind: "would-refuse" }> => a.kind === "would-refuse",
  );
  if (refusals.length > 0) {
    const first = refusals[0];
    if (first === undefined) {
      throw new Error("unreachable: refusals.length > 0 but refusals[0] undefined");
    }
    return {
      kind: "refused",
      outcome: {
        status: "refused",
        recordKey: plan.recordKey,
        adapterName: plan.adapterName,
        reasonCode: first.reasonCode,
        message: composeRefusalMessage(plan.recordKey, refusals),
      },
    };
  }

  if (assessments.every((a) => a.kind === "would-noop")) {
    return {
      kind: "noop",
      outcome: {
        status: "noop",
        recordKey: plan.recordKey,
        adapterName: plan.adapterName,
        reason: "already installed; current state matches recorded SHA",
      },
    };
  }

  const onlyNoopOrAdopt = assessments.every(
    (a) => a.kind === "would-noop" || a.kind === "would-adopt",
  );
  const hasAdopt = assessments.some((a) => a.kind === "would-adopt");
  if (onlyNoopOrAdopt && hasAdopt) {
    return { kind: "adoption" };
  }

  return { kind: "mutation" };
}

function composeRefusalMessage(
  recordKey: RecordKey,
  refusals: ReadonlyArray<Extract<PerOpAssessment, { kind: "would-refuse" }>>,
): string {
  const lines = refusals.map((r) => `  - [${r.reasonCode}] ${r.detailLine}`).join("\n");
  return (
    `Refusing to apply ${recordKey}: classifier detected the following issues:\n${lines}\n` +
    `Only ordinary content-drift refusals are overrideable with --force-reinstall. ` +
    `All other refusals require a manual fix.`
  );
}

// ---------------------------------------------------------------------------
// Build OpExecutionPlan[] (excludes would-noop; those preserve
// existing record op verbatim in buildUpdatedIntegrationsFile).
// ---------------------------------------------------------------------------

function buildOpExecutionPlans(args: {
  plan: ApplicablePlan;
  assessments: ReadonlyArray<PerOpAssessment>;
  currentTextByPath: ReadonlyMap<string, string | null>;
  currentRawBytesByPath: ReadonlyMap<string, Buffer | null>;
  resolvedTargets: ReadonlyArray<ResolvedTarget>;
  backupGroupId: string;
  repoRoot: string;
}): OpExecutionPlan[] {
  const plans: OpExecutionPlan[] = [];
  for (let i = 0; i < args.plan.ops.length; i++) {
    const op = args.plan.ops[i];
    const assessment = args.assessments[i];
    const resolved = args.resolvedTargets[i];
    if (op === undefined || assessment === undefined || resolved === undefined) {
      throw new Error("unreachable: index out of bounds in buildOpExecutionPlans");
    }
    if (assessment.kind === "would-noop" || assessment.kind === "would-refuse") {
      continue;
    }
    const currentBytes = args.currentTextByPath.get(op.target.pathRelative) ?? null;
    const currentRawBytes = args.currentRawBytesByPath.get(op.target.pathRelative) ?? null;
    const targetLineEnding = chooseTargetLineEnding(currentBytes);
    const desiredFullFileBytes = computeDesiredFullFileBytes({
      op,
      currentBytes,
      targetLineEnding,
    });
    const desiredManagedSha = computeDesiredManagedRegionSha({ op, desiredFullFileBytes });

    let backupPathSpec: PathSpec | null = null;
    let backupAbsolutePath: string | null = null;
    if (op.kind === "backup-and-write") {
      backupPathSpec = backupPathSpecFor({
        recordKey: args.plan.recordKey,
        backupGroupId: args.backupGroupId,
        originalPathRelative: op.target.pathRelative,
      });
      backupAbsolutePath = resolvePath(backupPathSpec, { repoRoot: args.repoRoot });
    }

    const recordOp = constructIntegrationFileEditRecord({
      op,
      desiredManagedSha,
      backupPathSpec,
    });

    plans.push({
      op,
      assessment,
      absolutePath: resolved.absolutePath,
      currentBytes,
      currentRawBytes,
      desiredFullFileBytes,
      desiredManagedSha,
      backupPathSpec,
      backupAbsolutePath,
      recordOp,
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Build the updated IntegrationsFile from existing + plan + execution plans.
// ---------------------------------------------------------------------------

function buildUpdatedIntegrationsFile(args: {
  existing: IntegrationsFile | null;
  plan: ApplicablePlan;
  assessments: ReadonlyArray<PerOpAssessment>;
  opPlans: ReadonlyArray<OpExecutionPlan>;
  ctx: AdapterContext;
  isAdoptionOnly: boolean;
}): IntegrationsFile {
  const { existing, plan, assessments, opPlans, ctx, isAdoptionOnly } = args;

  const existingRecord = existing?.records[plan.recordKey] ?? null;
  const opPlanByPath = new Map<string, OpExecutionPlan>();
  for (const op of opPlans) opPlanByPath.set(op.op.target.pathRelative, op);

  const recordOps: IntegrationFileEditRecord[] = [];
  for (let i = 0; i < plan.ops.length; i++) {
    const op = plan.ops[i];
    const assessment = assessments[i];
    if (op === undefined || assessment === undefined) {
      throw new Error("unreachable: index out of bounds in buildUpdatedIntegrationsFile");
    }
    if (assessment.kind === "would-noop") {
      // Preserve existing record op verbatim. Duplicate-record-path
      // guard in apply()'s classify loop ensures at most one match;
      // would-noop classification ensures the match exists.
      const existingOp = existingRecord?.ops.find(
        (r) => r.target.pathRelative === op.target.pathRelative,
      );
      if (existingOp === undefined) {
        throw new Error(
          `unreachable: would-noop classification implies existing record op for ${op.target.pathRelative}`,
        );
      }
      recordOps.push(existingOp);
      continue;
    }
    if (assessment.kind === "would-refuse") {
      throw new Error(
        `unreachable: would-refuse classification at record-build time for ${op.target.pathRelative}`,
      );
    }
    const opPlan = opPlanByPath.get(op.target.pathRelative);
    if (opPlan === undefined) {
      throw new Error(
        `unreachable: missing OpExecutionPlan for ${op.target.pathRelative} (assessment ${assessment.kind})`,
      );
    }
    recordOps.push(opPlan.recordOp);
  }

  const newRecord: IntegrationRecord = {
    recordKey: plan.recordKey,
    adapterName: plan.adapterName,
    installedAt: ctx.now.toISOString(),
    installedByVersion: ctx.cliVersion,
    ops: recordOps,
    meta: plan.meta as unknown as Record<string, string>,
  };

  const historyTail = (existing?.history ?? []).slice(-HISTORY_RETENTION_LIMIT);

  return {
    schemaVersion: 1,
    createdByVersion: existing?.createdByVersion ?? ctx.cliVersion,
    updatedByVersion: ctx.cliVersion,
    records: {
      ...(existing?.records ?? {}),
      [plan.recordKey]: newRecord,
    },
    history: [
      ...historyTail,
      {
        timestamp: ctx.now.toISOString(),
        action: isAdoptionOnly ? "adopt" : "install",
        recordKey: plan.recordKey,
        cliVersion: ctx.cliVersion,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------

/**
 * Mutating orchestration that commits the transaction modelled by
 * preview. Returns an InstallOutcome reflecting the applied,
 * noop, or refused result. See top comment for full discipline.
 *
 * Errors propagate per the top-comment error-propagation policy.
 * Lock and journal best-effort cleanup are warning-only on commit-
 * succeeded paths; mid-transaction failures leave the journal
 * pending for the next install to refuse.
 */
export async function apply(plan: AdapterPlan, ctx: AdapterContext): Promise<InstallOutcome> {
  // Step 0a: adapter-plan refusal passthrough (no lock, no recordKey).
  if (plan.status === "refused") {
    return {
      status: "refused",
      adapterName: plan.adapterName,
      reasonCode: plan.reasonCode,
      message: plan.message,
      ...(plan.manualSnippet !== undefined ? { manualSnippet: plan.manualSnippet } : {}),
    };
  }

  // Step 0b: empty-plan defense (no lock).
  if (plan.ops.length === 0) {
    return {
      status: "refused",
      recordKey: plan.recordKey,
      adapterName: plan.adapterName,
      reasonCode: EMPTY_PLAN_REASON_CODE,
      message:
        `Refusing to apply ${plan.recordKey}: applicable plan contains no file operations. ` +
        `An adapter that has nothing to do should return RefusedPlan or detect{detected: false}, ` +
        `not ApplicablePlan with empty ops.`,
    };
  }

  // Step 0c: duplicate-plan-path defense (no lock).
  const duplicatePaths = findDuplicatePlanPaths(plan);
  if (duplicatePaths.length > 0) {
    const lines = duplicatePaths.map((p) => `  - ${p}`).join("\n");
    return {
      status: "refused",
      recordKey: plan.recordKey,
      adapterName: plan.adapterName,
      reasonCode: DUPLICATE_PLAN_PATH_REASON_CODE,
      message:
        `Refusing to apply ${plan.recordKey}: plan has duplicate target paths:\n${lines}\n` +
        `v1 installer supports one managed op per target file per record.`,
    };
  }

  // Step 1: acquire lock. Throws IntegrationsLockError on conflict.
  const lockHandle = await acquireLock(ctx.repoRoot, "install");

  try {
    // Step 2a: pending journal scan.
    const pending = await scanForPendingJournals(ctx.repoRoot);
    if (pending.length > 0) {
      const journalDir = join(resolve(ctx.repoRoot), VIBEREVERT_DIR_NAME, JOURNAL_DIR_NAME);
      throw new PendingIntegrationRecoveryError({
        journalDir,
        pendingEntries: pending.map((p) => p.filename),
      });
    }

    // Step 2b: preflight every target.
    const resolvedTargets: ResolvedTarget[] = plan.ops.map((op) => ({
      op,
      absolutePath: resolvePath(op.target, { repoRoot: ctx.repoRoot }),
    }));
    for (const { op, absolutePath } of resolvedTargets) {
      const preflightOp: "write" | "merge" =
        op.kind === "write-new" || op.kind === "backup-and-write" ? "write" : "merge";
      await assertSafeTarget({
        repoRoot: ctx.repoRoot,
        targetPath: absolutePath,
        op: preflightOp,
      });
    }

    // Step 2c: read store.
    const integrationsFile = await readIntegrationsFile(ctx.repoRoot);
    const record = integrationsFile?.records[plan.recordKey] ?? null;

    // Step 2d: read current bytes per target as RAW Buffer + UTF-8 view.
    // ENOENT -> null in both maps.
    const currentRawBytesByPath = new Map<string, Buffer | null>();
    const currentTextByPath = new Map<string, string | null>();
    for (const { op, absolutePath } of resolvedTargets) {
      try {
        const raw = await readFile(absolutePath);
        currentRawBytesByPath.set(op.target.pathRelative, raw);
        currentTextByPath.set(op.target.pathRelative, raw.toString("utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          currentRawBytesByPath.set(op.target.pathRelative, null);
          currentTextByPath.set(op.target.pathRelative, null);
        } else {
          throw err;
        }
      }
    }

    // Step 2e: per-op classification with record-duplicate guard.
    const assessments: PerOpAssessment[] = plan.ops.map((op) => {
      const matchingRecordOps =
        record === null
          ? []
          : record.ops.filter((r) => r.target.pathRelative === op.target.pathRelative);
      if (matchingRecordOps.length > 1) {
        return refuseAssessment(
          op.target.pathRelative,
          op.kind,
          DUPLICATE_RECORD_PATH_REASON_CODE,
          `${op.target.pathRelative}: integrations record has ${matchingRecordOps.length} entries for this path; expected at most 1 (durable-schema invariant for v1)`,
        );
      }
      const recordOp = matchingRecordOps[0] ?? null;
      const currentBytes = currentTextByPath.get(op.target.pathRelative) ?? null;
      return classifyOp({ op, ctx, recordOp, currentBytes });
    });

    // Step 2f: aggregate.
    const aggregate = aggregateForApply(plan, assessments);

    // Step 2g + 2h: early outcomes.
    if (aggregate.kind === "refused") return aggregate.outcome;
    if (aggregate.kind === "noop") return aggregate.outcome;

    const isAdoptionOnly = aggregate.kind === "adoption";
    const isMutation = aggregate.kind === "mutation";

    // Step 2i: ONE transactionId; backupGroupId carries the same id.
    const txnId = randomUUID();
    const backupGroupId = `${utcSlugFromDate(ctx.now)}--${txnId}`;

    // Step 2j: OpExecutionPlan[] (excludes would-noop; precomputes
    // recordOp per included op).
    const opPlans = buildOpExecutionPlans({
      plan,
      assessments,
      currentTextByPath,
      currentRawBytesByPath,
      resolvedTargets,
      backupGroupId,
      repoRoot: ctx.repoRoot,
    });

    // Step 2k: journal init (mutation only).
    // plannedOps = target-mutation set ONLY (would-apply +
    // would-safe-update). Adopted backup-and-write ops appear under
    // backupPaths but NOT plannedOps (no target mutation planned).
    if (isMutation) {
      const plannedOps: PlannedJournalOp[] = opPlans
        .filter(
          (p) => p.assessment.kind === "would-apply" || p.assessment.kind === "would-safe-update",
        )
        .map((p) => fileEditOpToPlannedJournalOp(p.op));
      const journalEntry: JournalEntry = {
        txnId,
        recordKey: plan.recordKey,
        adapterName: plan.adapterName,
        startedAt: ctx.now.toISOString(),
        command: "install",
        cliVersion: ctx.cliVersion,
        phase: "writing-files",
        plannedOps,
        recordedOps: [],
        backupPaths: [],
      };
      await writeJournal(ctx.repoRoot, journalEntry);
    }

    // Step 2l: per-op backups (raw Buffer) + journal updates.
    const backupsCreated: string[] = [];
    const backupPathsAccumulator: PathSpec[] = [];
    for (const opPlan of opPlans) {
      if (!needsNewBackup(opPlan)) continue;
      if (opPlan.backupPathSpec === null || opPlan.backupAbsolutePath === null) {
        throw new Error("unreachable: needsNewBackup true but backup path spec/absolute null");
      }
      if (opPlan.currentRawBytes === null) {
        // backup-and-write classifier requires current present;
        // unreachable for adopt/apply/safe-update. Defensive.
        throw new Error(
          `unreachable: backup-and-write op ${opPlan.op.target.pathRelative} has null currentRawBytes at backup time`,
        );
      }
      await ensureBackupDirChain({
        repoRoot: ctx.repoRoot,
        recordKey: plan.recordKey,
        backupGroupId,
        eventualBackupAbsolutePath: opPlan.backupAbsolutePath,
      });
      try {
        // Raw Buffer write; no encoding parameter; preserves bytes
        // verbatim. wx flag = exclusive create.
        await writeFile(opPlan.backupAbsolutePath, opPlan.currentRawBytes, { flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new BackupCollisionError({ backupPath: opPlan.backupAbsolutePath });
        }
        throw err;
      }
      backupsCreated.push(opPlan.backupAbsolutePath);
      backupPathsAccumulator.push(opPlan.backupPathSpec);
      if (isMutation) {
        await updateJournal(ctx.repoRoot, txnId, {
          backupPaths: [...backupPathsAccumulator],
        });
      }
    }

    // Step 2m: per-op target mutation (mutation only).
    const filesWritten: string[] = [];
    const recordedOpsAccumulator: IntegrationFileEditRecord[] = [];
    if (isMutation) {
      for (const opPlan of opPlans) {
        if (
          opPlan.assessment.kind !== "would-apply" &&
          opPlan.assessment.kind !== "would-safe-update"
        ) {
          continue;
        }
        await ensureTargetParentDirChain({
          repoRoot: ctx.repoRoot,
          targetPath: opPlan.absolutePath,
        });
        await writeFileAtomic(opPlan.absolutePath, opPlan.desiredFullFileBytes);
        if (opPlan.op.kind === "write-new" || opPlan.op.kind === "backup-and-write") {
          await chmodIfPosix(opPlan.absolutePath, opPlan.op.mode);
        }
        // Only AFTER successful write + chmod: mark recorded and
        // update journal.
        recordedOpsAccumulator.push(opPlan.recordOp);
        await updateJournal(ctx.repoRoot, txnId, {
          recordedOps: [...recordedOpsAccumulator],
        });
        filesWritten.push(opPlan.absolutePath);
      }
      // Step 2o: journal phase advance.
      await updateJournal(ctx.repoRoot, txnId, { phase: "updating-integrations" });
    }

    // Step 2n + 2p: build + write integrations.json.
    const updatedFile = buildUpdatedIntegrationsFile({
      existing: integrationsFile,
      plan,
      assessments,
      opPlans,
      ctx,
      isAdoptionOnly,
    });
    await writeIntegrationsFile({
      repoRoot: ctx.repoRoot,
      next: updatedFile,
      backupGroupId,
    });

    // Step 2q + 2r: journal phase done + best-effort delete.
    if (isMutation) {
      await updateJournal(ctx.repoRoot, txnId, { phase: "done" });
      try {
        await deleteJournal(ctx.repoRoot, txnId);
      } catch (err) {
        process.stderr.write(
          `warning: install committed but failed to delete journal ${txnId}: ${(err as Error).message}\n` +
            `The transaction succeeded; the pending journal entry can be safely removed manually.\n`,
        );
      }
    }

    // Step 2s: build receipt.
    const integrationsJsonPath = join(
      resolve(ctx.repoRoot),
      VIBEREVERT_DIR_NAME,
      INTEGRATIONS_FILENAME,
    );
    const opsApplied = isMutation
      ? assessments.filter((a) => a.kind === "would-apply" || a.kind === "would-safe-update").length
      : 0;
    const receipt: InstallReceipt = {
      recordKey: plan.recordKey,
      adapterName: plan.adapterName,
      opsApplied,
      filesWritten,
      backupsCreated,
      integrationsJsonPath,
      humanSummary: isAdoptionOnly ? ADOPTION_HUMAN_SUMMARY : plan.humanSummary,
    };
    return { status: "applied", receipt };
  } finally {
    // Step 3: best-effort lock release.
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
