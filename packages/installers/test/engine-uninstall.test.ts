// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Buffer } from "node:buffer";
import { mkdir, readdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { FileEditOp, JsonValue, PathSpec } from "@viberevert/adapters";
import { renderSentinelBlock } from "@viberevert/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeDesiredManagedRegionSha,
  DRIFT_REASON_CODE,
  DUPLICATE_RECORD_PATH_REASON_CODE,
  sha256OfUtf8,
} from "../src/engine-classify.js";
import type { RecordKey, UninstallContext } from "../src/engine-types.js";
import { uninstall } from "../src/engine-uninstall.js";
import {
  IntegrationsLockError,
  PendingIntegrationRecoveryError,
  SymlinkTargetRefusal,
} from "../src/errors.js";
import type {
  IntegrationFileEditRecord,
  IntegrationRecord,
  IntegrationsFile,
} from "../src/integrations-schema.js";
import { readIntegrationsFile, writeIntegrationsFile } from "../src/integrations-store.js";
import { type JournalEntry, scanForPendingJournals, writeJournal } from "../src/journal.js";
import { encodeBackupPath } from "../src/path-encode.js";

import { createTempRepo, SYMLINKS_SUPPORTED } from "./helpers/temp-repo.js";

// Fixed SHA-shaped constants -- accidental wrong-length inputs are impossible.
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// Reason code declared as a private const in engine-uninstall.ts (NOT
// exported). Tests mirror the source string by value only; no source
// export change required.
const BACKUP_MISSING_REASON_CODE = "backup-file-missing-on-disk";

let tempRepo: Awaited<ReturnType<typeof createTempRepo>>;

beforeEach(async () => {
  tempRepo = await createTempRepo();
});

afterEach(async () => {
  await tempRepo.cleanup();
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function viberevertPath(): string {
  return join(tempRepo.repoRoot, ".viberevert");
}
function integrationsJsonPath(): string {
  return join(viberevertPath(), "integrations.json");
}
function lockDirPath(): string {
  return join(viberevertPath(), "integrations.lock");
}
function lockPidJsonPath(): string {
  return join(lockDirPath(), "pid.json");
}
function backupsRootPath(): string {
  return join(viberevertPath(), "integration-backups");
}

// ---------------------------------------------------------------------------
// utcSlug helper -- intentionally small + local. Mirrors source's
// utcSlugFromDate. Used only by the single-txnId test (P).
// ---------------------------------------------------------------------------

function expectedUtcSlug(d: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const pad3 = (n: number): string => String(n).padStart(3, "0");
  return (
    `${d.getUTCFullYear().toString().padStart(4, "0")}` +
    `${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}` +
    `${pad3(d.getUTCMilliseconds())}Z`
  );
}

// ---------------------------------------------------------------------------
// UninstallContext factory with options-deep-merge. UninstallContext is
// simpler than AdapterContext: only `forceUninstall` in options.
// ---------------------------------------------------------------------------

type UninstallContextOverrides = Omit<Partial<UninstallContext>, "options"> & {
  readonly options?: Partial<UninstallContext["options"]>;
};

function makeCtx(overrides: UninstallContextOverrides = {}): UninstallContext {
  const base: UninstallContext = {
    repoRoot: tempRepo.repoRoot,
    now: new Date("2026-06-27T12:00:00.000Z"),
    cliVersion: "0.7.1-beta.0",
    options: { forceUninstall: false },
  };
  return {
    ...base,
    ...overrides,
    options: { ...base.options, ...overrides.options },
  };
}

function forcedCtx(): UninstallContext {
  return makeCtx({ options: { forceUninstall: true } });
}

// ---------------------------------------------------------------------------
// Plan + op factories (op factories shared with record construction below)
// ---------------------------------------------------------------------------

function makePathSpec(pathRelative: string): PathSpec {
  return {
    scope: "repo",
    pathTemplate: `{repo}/${pathRelative}`,
    pathRelative,
  };
}

function makeWriteNewOp(
  pathRelative: string,
  overrides: Partial<Extract<FileEditOp, { kind: "write-new" }>> = {},
): FileEditOp {
  return {
    kind: "write-new",
    target: makePathSpec(pathRelative),
    content: "hello\n",
    ...overrides,
  };
}

function makeBackupAndWriteOp(
  pathRelative: string,
  overrides: Partial<Extract<FileEditOp, { kind: "backup-and-write" }>> = {},
): FileEditOp {
  return {
    kind: "backup-and-write",
    target: makePathSpec(pathRelative),
    content: "hello\n",
    ...overrides,
  };
}

function makeSentinelInsertOp(
  pathRelative: string,
  overrides: Partial<Extract<FileEditOp, { kind: "sentinel-block-insert" }>> = {},
): FileEditOp {
  return {
    kind: "sentinel-block-insert",
    target: makePathSpec(pathRelative),
    blockId: "test-block",
    content: "managed-content",
    anchor: { mode: "append" },
    ...overrides,
  };
}

function makeJsonKeyMergeOp(
  pathRelative: string,
  overrides: Partial<Extract<FileEditOp, { kind: "json-key-merge" }>> = {},
): FileEditOp {
  return {
    kind: "json-key-merge",
    target: makePathSpec(pathRelative),
    keyPath: ["mcpServers", "viberevert"],
    value: { command: "viberevert" } as JsonValue,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// IntegrationsFile + record factories
// ---------------------------------------------------------------------------

function makeIntegrationsFile(overrides: Partial<IntegrationsFile> = {}): IntegrationsFile {
  return {
    schemaVersion: 1,
    createdByVersion: "0.7.1-beta.0",
    updatedByVersion: "0.7.1-beta.0",
    records: {},
    history: [],
    ...overrides,
  };
}

function makeIntegrationRecord(
  recordKey: RecordKey,
  ops: ReadonlyArray<IntegrationFileEditRecord>,
  overrides: Partial<IntegrationRecord> = {},
): IntegrationRecord {
  return {
    recordKey,
    adapterName: `${recordKey}-test`,
    installedAt: "2026-06-27T12:00:00.000Z",
    installedByVersion: "0.7.1-beta.0",
    ops: [...ops],
    meta: {},
    ...overrides,
  };
}

/**
 * Path-aware record factory. Same shape as 2J.e1. For backup-and-write,
 * the default `backup` PathSpec is a placeholder under .viberevert/
 * integration-backups/test/group/file -- backup-and-write uninstall
 * tests OVERRIDE this via setupBackupAndWriteFixture so the record's
 * backup PathSpec points to the actual backup file on disk.
 */
function makeRecordOpFor(
  planOp: FileEditOp,
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  const target = planOp.target;
  switch (planOp.kind) {
    case "write-new":
      return {
        kind: "write-new",
        target,
        backup: null,
        managedBlockSha256: null,
        managedValueSha256: null,
        fullFileSha256AfterWrite: SHA_A,
        blockId: null,
        jsonKeyPath: null,
        mode: null,
        ...overrides,
      };
    case "backup-and-write":
      return {
        kind: "backup-and-write",
        target,
        backup: makePathSpec(".viberevert/integration-backups/test/group/file"),
        managedBlockSha256: null,
        managedValueSha256: null,
        fullFileSha256AfterWrite: SHA_A,
        blockId: null,
        jsonKeyPath: null,
        mode: null,
        ...overrides,
      };
    case "sentinel-block-insert":
    case "sentinel-block-replace":
      return {
        kind: planOp.kind,
        target,
        backup: null,
        managedBlockSha256: SHA_A,
        managedValueSha256: null,
        fullFileSha256AfterWrite: null,
        blockId: planOp.blockId,
        jsonKeyPath: null,
        mode: null,
        ...overrides,
      };
    case "json-key-merge":
      return {
        kind: "json-key-merge",
        target,
        backup: null,
        managedBlockSha256: null,
        managedValueSha256: SHA_A,
        fullFileSha256AfterWrite: null,
        blockId: null,
        jsonKeyPath: [...planOp.keyPath],
        mode: null,
        ...overrides,
      };
  }
}

// ---------------------------------------------------------------------------
// Explicit backup-and-write fixture helper.
//
// Three orthogonal knobs:
//   - installedTargetContent: SHA-clean UTF-8 text the installed target
//     contains (record's fullFileSha256AfterWrite is derived from this
//     by default).
//   - originalBackupBytes: raw Buffer the backup file contains (the
//     pre-install bytes uninstall would restore).
//   - createBackupFile: whether to actually create the backup file on
//     disk. False is used for backup-missing tests.
//
// The record's `backup` PathSpec ALWAYS points to the layout-correct
// location (.viberevert/integration-backups/cursor/<group>/<encoded>)
// regardless of whether the file exists; this proves backup-missing
// is detected via fs absence, not via record shape.
// ---------------------------------------------------------------------------

async function setupBackupAndWriteFixture(args: {
  readonly pathRelative: string;
  readonly installedTargetContent: string;
  readonly originalBackupBytes: Buffer;
  readonly createBackupFile: boolean;
  readonly backupGroupId: string;
  /** Override the recorded fullFileSha256AfterWrite. Default matches
   *  sha256OfUtf8(installedTargetContent) -- no drift. */
  readonly recordedSha?: string;
}): Promise<{
  readonly op: FileEditOp;
  readonly record: IntegrationFileEditRecord;
  readonly targetAbs: string;
  readonly backupAbs: string;
}> {
  const targetAbs = join(tempRepo.repoRoot, args.pathRelative);
  const targetParent = dirname(targetAbs);
  if (targetParent !== tempRepo.repoRoot) {
    await mkdir(targetParent, { recursive: true });
  }
  await writeFile(targetAbs, args.installedTargetContent);

  // Backup PathSpec ALWAYS points to layout-correct location.
  const backupRelative = `.viberevert/integration-backups/cursor/${args.backupGroupId}/${encodeBackupPath(args.pathRelative)}`;
  const backupAbs = join(tempRepo.repoRoot, backupRelative);

  if (args.createBackupFile) {
    await mkdir(dirname(backupAbs), { recursive: true });
    await writeFile(backupAbs, args.originalBackupBytes);
  }

  const op = makeBackupAndWriteOp(args.pathRelative, {
    content: args.installedTargetContent,
  });
  const record = makeRecordOpFor(op, {
    fullFileSha256AfterWrite: args.recordedSha ?? sha256OfUtf8(args.installedTargetContent),
    backup: {
      scope: "repo",
      pathTemplate: `{repo}/${backupRelative}`,
      pathRelative: backupRelative,
    },
  });

  return { op, record, targetAbs, backupAbs };
}

// ===========================================================================
// A. not-installed outcome
// ===========================================================================

describe("uninstall -- not-installed (no record for recordKey)", () => {
  it("returns not-installed; lock released; no journal added; store bytes + history unchanged", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile(),
      backupGroupId: "init",
    });
    const originalStoreBytes = await readFile(integrationsJsonPath());

    const result = await uninstall("cursor", makeCtx());
    expect(result.status).toBe("not-installed");
    if (result.status === "not-installed") {
      expect(result.recordKey).toBe("cursor");
      expect(result.reason.length).toBeGreaterThan(0);
    }

    await expect(stat(lockDirPath())).rejects.toThrow();
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.history).toEqual([]);
  });
});

// ===========================================================================
// B. Successful write-new reversal
// ===========================================================================

describe("uninstall -- write-new reversal", () => {
  it("uninstalled: receipt fields populated; target unlinked; record removed; history 'uninstall'; lock released; journals empty", async () => {
    const targetPath = "test.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    const content = "stable content\n";
    await writeFile(targetAbs, content);

    const op = makeWriteNewOp(targetPath, { content });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: sha256OfUtf8(content) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const ctx = makeCtx();
    const result = await uninstall("cursor", ctx);
    expect(result.status).toBe("uninstalled");
    if (result.status !== "uninstalled") return;
    const { receipt } = result;

    expect(receipt.recordKey).toBe("cursor");
    expect(receipt.adapterName).toBe("cursor-test");
    expect(receipt.filesRemoved).toEqual([targetAbs]);
    expect(receipt.filesRestored).toEqual([]);
    expect(isAbsolute(receipt.filesRemoved[0] ?? "")).toBe(true);
    expect(receipt.humanSummary).toBe("Uninstalled cursor-test (1 ops reversed)");

    await expect(stat(targetAbs)).rejects.toThrow();

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.records.cursor).toBeUndefined();

    const last = integrations?.history.at(-1);
    expect(last?.action).toBe("uninstall");
    expect(last?.recordKey).toBe("cursor");
    expect(last?.timestamp).toBe(ctx.now.toISOString());

    await expect(stat(lockDirPath())).rejects.toThrow();
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
  });
});

// ===========================================================================
// C. Successful backup-and-write reversal -- raw-byte backup restored
// ===========================================================================

describe("uninstall -- backup-and-write reversal (raw bytes restored, backup deleted)", () => {
  it("uninstalled: target bytes = backup bytes verbatim; backup file deleted; audit dirs + integrations.json preserved; record removed; history 'uninstall'", async () => {
    const installedContent = "current-installed-content\n";
    // Raw non-UTF-8 backup bytes -- proves restore is byte-faithful.
    const originalBackupBytes = Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x00, 0x82, 0xc0, 0xc1]);

    const { record, targetAbs, backupAbs } = await setupBackupAndWriteFixture({
      pathRelative: "config/managed.txt",
      installedTargetContent: installedContent,
      originalBackupBytes,
      createBackupFile: true,
      backupGroupId: "install-group",
    });
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({
        records: { cursor: makeIntegrationRecord("cursor", [record]) },
      }),
      backupGroupId: "init",
    });

    const ctx = makeCtx();
    const result = await uninstall("cursor", ctx);
    expect(result.status).toBe("uninstalled");
    if (result.status !== "uninstalled") return;
    const { receipt } = result;

    expect(receipt.filesRestored).toEqual([targetAbs]);
    expect(receipt.filesRemoved).toEqual([]);
    expect(isAbsolute(receipt.filesRestored[0] ?? "")).toBe(true);

    // Target now contains the backup bytes verbatim (raw Buffer compare).
    // Byte-only assertion -- no utf8 readFile here; the bytes are
    // intentionally non-UTF-8 to prove byte-faithful restore.
    expect(Buffer.compare(await readFile(targetAbs), originalBackupBytes)).toBe(0);

    // Backup file deleted (best-effort post-commit unlink).
    await expect(stat(backupAbs)).rejects.toThrow();

    // Parent audit dirs + integrations.json preserved (no overreach).
    const auditStat = await stat(backupsRootPath());
    expect(auditStat.isDirectory()).toBe(true);
    const integrationsStat = await stat(integrationsJsonPath());
    expect(integrationsStat.isFile()).toBe(true);

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.records.cursor).toBeUndefined();

    const last = integrations?.history.at(-1);
    expect(last?.action).toBe("uninstall");
    expect(last?.timestamp).toBe(ctx.now.toISOString());
  });
});

// ===========================================================================
// D. Successful sentinel-block-insert reversal
// ===========================================================================

describe("uninstall -- sentinel-block-insert reversal", () => {
  it("uninstalled: target loses the sentinel block; user's other content preserved", async () => {
    const targetPath = ".husky/pre-commit";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    await mkdir(join(tempRepo.repoRoot, ".husky"));

    const prefix = "#!/usr/bin/env sh\n";
    const blockContent = "viberevert check --staged";
    const suffix = "echo done\n";
    // Store the rendered block once -- assertions use this variable so
    // the test does not duplicate the marker syntax (renderer contract).
    const renderedBlock = renderSentinelBlock("husky-pre-commit", blockContent);
    const installedContent = `${prefix}${renderedBlock}${suffix}`;
    await writeFile(targetAbs, installedContent);

    const op = makeSentinelInsertOp(targetPath, {
      blockId: "husky-pre-commit",
      content: blockContent,
    });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { managedBlockSha256: sha256OfUtf8(blockContent) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const result = await uninstall("cursor", makeCtx());
    expect(result.status).toBe("uninstalled");
    if (result.status !== "uninstalled") return;
    expect(result.receipt.filesRestored).toEqual([targetAbs]);
    expect(isAbsolute(result.receipt.filesRestored[0] ?? "")).toBe(true);

    // Rendered block absent (asserted via renderer output, not via
    // marker string literal). User's surrounding content preserved.
    const newContent = await readFile(targetAbs, "utf8");
    expect(newContent).not.toContain(renderedBlock);
    expect(newContent).not.toContain(blockContent);
    expect(newContent).toContain(prefix);
    expect(newContent).toContain(suffix);

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.records.cursor).toBeUndefined();
  });
});

// ===========================================================================
// E. Successful json-key-merge reversal
// ===========================================================================

describe("uninstall -- json-key-merge reversal", () => {
  it("uninstalled: key absent semantically; sibling keys preserved", async () => {
    const targetPath = ".cursor/mcp.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    await mkdir(join(tempRepo.repoRoot, ".cursor"));
    await writeFile(
      targetAbs,
      JSON.stringify({
        mcpServers: { other: {}, viberevert: { command: "vr" } },
      }),
    );

    const op = makeJsonKeyMergeOp(targetPath, {
      keyPath: ["mcpServers", "viberevert"],
      value: { command: "vr" } as JsonValue,
    });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, {
        managedValueSha256: computeDesiredManagedRegionSha({ op, desiredFullFileBytes: "" }),
      }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const result = await uninstall("cursor", makeCtx());
    expect(result.status).toBe("uninstalled");
    if (result.status !== "uninstalled") return;
    expect(result.receipt.filesRestored).toEqual([targetAbs]);
    expect(isAbsolute(result.receipt.filesRestored[0] ?? "")).toBe(true);

    const parsed = JSON.parse(await readFile(targetAbs, "utf8")) as {
      mcpServers: { other: object; viberevert?: unknown };
    };
    expect(parsed.mcpServers).not.toHaveProperty("viberevert");
    expect(parsed.mcpServers.other).toEqual({});

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.records.cursor).toBeUndefined();
  });
});

// ===========================================================================
// F + G + shared drift fixture
// ===========================================================================

async function setupDriftWriteNewFixture(): Promise<{
  readonly targetAbs: string;
  readonly originalTargetBytes: Buffer;
  readonly originalStoreBytes: Buffer;
}> {
  const targetPath = "drift.json";
  const targetAbs = join(tempRepo.repoRoot, targetPath);
  await writeFile(targetAbs, "user-edited\n");
  const op = makeWriteNewOp(targetPath, { content: "any-desired\n" });
  const record = makeIntegrationRecord("cursor", [
    makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_B }),
  ]);
  await writeIntegrationsFile({
    repoRoot: tempRepo.repoRoot,
    next: makeIntegrationsFile({ records: { cursor: record } }),
    backupGroupId: "init",
  });
  return {
    targetAbs,
    originalTargetBytes: await readFile(targetAbs),
    originalStoreBytes: await readFile(integrationsJsonPath()),
  };
}

describe("uninstall -- drift refusal under default ctx", () => {
  it("refused with DRIFT_REASON_CODE; target + store unchanged; no journal; lock released", async () => {
    const { targetAbs, originalTargetBytes, originalStoreBytes } =
      await setupDriftWriteNewFixture();

    const result = await uninstall("cursor", makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }

    expect(Buffer.compare(await readFile(targetAbs), originalTargetBytes)).toBe(0);
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
    await expect(stat(lockDirPath())).rejects.toThrow();
  });
});

describe("uninstall -- force overrides drift (write-new)", () => {
  it("uninstalled: target unlinked; record removed", async () => {
    const { targetAbs } = await setupDriftWriteNewFixture();

    const result = await uninstall("cursor", forcedCtx());
    expect(result.status).toBe("uninstalled");
    if (result.status === "uninstalled") {
      expect(result.receipt.filesRemoved).toEqual([targetAbs]);
    }
    await expect(stat(targetAbs)).rejects.toThrow();
    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.records.cursor).toBeUndefined();
  });
});

// ===========================================================================
// H. Backup-missing refusal -- NOT overrideable (default + force=true)
// ===========================================================================

describe("uninstall -- backup-missing refusal is NOT overrideable", () => {
  async function setupBackupMissingFixture(): Promise<{
    readonly targetAbs: string;
    readonly originalTargetBytes: Buffer;
    readonly originalStoreBytes: Buffer;
  }> {
    const { record, targetAbs } = await setupBackupAndWriteFixture({
      pathRelative: "backup-missing.txt",
      installedTargetContent: "installed\n",
      originalBackupBytes: Buffer.from("does not matter"),
      createBackupFile: false,
      backupGroupId: "install-group",
    });
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({
        records: { cursor: makeIntegrationRecord("cursor", [record]) },
      }),
      backupGroupId: "init",
    });
    return {
      targetAbs,
      originalTargetBytes: await readFile(targetAbs),
      originalStoreBytes: await readFile(integrationsJsonPath()),
    };
  }

  it("default ctx -> refused with BACKUP_MISSING_REASON_CODE; target + store unchanged; lock released", async () => {
    const { targetAbs, originalTargetBytes, originalStoreBytes } =
      await setupBackupMissingFixture();

    const result = await uninstall("cursor", makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(BACKUP_MISSING_REASON_CODE);
    }

    // Refusal is non-mutating.
    expect(Buffer.compare(await readFile(targetAbs), originalTargetBytes)).toBe(0);
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    await expect(stat(lockDirPath())).rejects.toThrow();
  });

  it("forced ctx -> STILL refused with BACKUP_MISSING_REASON_CODE; target + store unchanged; lock released", async () => {
    const { targetAbs, originalTargetBytes, originalStoreBytes } =
      await setupBackupMissingFixture();

    const result = await uninstall("cursor", forcedCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(BACKUP_MISSING_REASON_CODE);
    }

    expect(Buffer.compare(await readFile(targetAbs), originalTargetBytes)).toBe(0);
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    await expect(stat(lockDirPath())).rejects.toThrow();
  });
});

// ===========================================================================
// I. Backup-missing precedence: wins over drift
// ===========================================================================

describe("uninstall -- backup-missing wins over drift", () => {
  it("backup-and-write with drifted target + missing backup -> refused with BACKUP_MISSING_REASON_CODE (NOT DRIFT); target + store unchanged", async () => {
    const { record, targetAbs } = await setupBackupAndWriteFixture({
      pathRelative: "drift-and-missing.txt",
      installedTargetContent: "installed\n",
      originalBackupBytes: Buffer.from("does not matter"),
      createBackupFile: false,
      backupGroupId: "install-group",
      // Mismatched recorded SHA -> would-be drift if not for backup-missing.
      recordedSha: SHA_A,
    });
    // Make target drifted from recorded SHA.
    await writeFile(targetAbs, "user-edited\n");

    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({
        records: { cursor: makeIntegrationRecord("cursor", [record]) },
      }),
      backupGroupId: "init",
    });

    const originalTargetBytes = await readFile(targetAbs);
    const originalStoreBytes = await readFile(integrationsJsonPath());

    const result = await uninstall("cursor", makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      // Backup-missing wins over drift -- proves source's precedence
      // rule "non-forceable backup-missing wins over forceable drift".
      expect(result.reasonCode).toBe(BACKUP_MISSING_REASON_CODE);
    }

    // Non-mutating refusal.
    expect(Buffer.compare(await readFile(targetAbs), originalTargetBytes)).toBe(0);
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    await expect(stat(lockDirPath())).rejects.toThrow();
  });
});

// ===========================================================================
// J. Duplicate-record-path refusal -- NOT overrideable
// ===========================================================================

describe("uninstall -- duplicate-record-path is NOT overrideable", () => {
  it("force=true still refused with DUPLICATE_RECORD_PATH_REASON_CODE; store unchanged", async () => {
    const targetPath = "shared.json";
    const op = makeWriteNewOp(targetPath, { content: "x\n" });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_A }),
      makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_B }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });
    const originalStoreBytes = await readFile(integrationsJsonPath());

    const result = await uninstall("cursor", forcedCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(DUPLICATE_RECORD_PATH_REASON_CODE);
    }

    // Pre-mutation non-overrideable refusal: store unchanged.
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    await expect(stat(lockDirPath())).rejects.toThrow();
  });
});

// ===========================================================================
// K. Force + all-skip (single write-new with absent target)
// ===========================================================================

describe("uninstall -- force + all-skip path", () => {
  it("uninstalled with 0 ops reversed; record removed; history 'uninstall'; updatedByVersion overwritten; no journal; target still absent; lock released", async () => {
    const targetPath = "absent.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);

    const op = makeWriteNewOp(targetPath, { content: "any-desired\n" });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_A }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const ctx = forcedCtx();
    const result = await uninstall("cursor", ctx);
    expect(result.status).toBe("uninstalled");
    if (result.status !== "uninstalled") return;
    const { receipt } = result;

    expect(receipt.filesRemoved).toEqual([]);
    expect(receipt.filesRestored).toEqual([]);
    expect(receipt.humanSummary).toBe("Uninstalled cursor-test (0 ops reversed)");

    // Record removed (proves all-skip is a COMMITTED uninstall, not noop).
    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.records.cursor).toBeUndefined();

    // History entry appended.
    const last = integrations?.history.at(-1);
    expect(last?.action).toBe("uninstall");
    expect(last?.recordKey).toBe("cursor");
    expect(last?.timestamp).toBe(ctx.now.toISOString());

    // updatedByVersion overwritten by ctx.cliVersion.
    expect(integrations?.updatedByVersion).toBe(ctx.cliVersion);

    // No journal (all-skip path).
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);

    // Target still absent.
    await expect(stat(targetAbs)).rejects.toThrow();

    // Lock released.
    await expect(stat(lockDirPath())).rejects.toThrow();
  });
});

// ===========================================================================
// L. Reverse execution order (two write-new on distinct paths)
// ===========================================================================

describe("uninstall -- reverse execution order", () => {
  it("record.ops [A, B] -> receipt.filesRemoved [absB, absA] (reverse order)", async () => {
    const pathA = "ordering-first.json";
    const pathB = "ordering-second.json";
    const absA = join(tempRepo.repoRoot, pathA);
    const absB = join(tempRepo.repoRoot, pathB);
    const contentA = "content-A\n";
    const contentB = "content-B\n";
    await writeFile(absA, contentA);
    await writeFile(absB, contentB);

    const opA = makeWriteNewOp(pathA, { content: contentA });
    const opB = makeWriteNewOp(pathB, { content: contentB });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(opA, { fullFileSha256AfterWrite: sha256OfUtf8(contentA) }),
      makeRecordOpFor(opB, { fullFileSha256AfterWrite: sha256OfUtf8(contentB) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const result = await uninstall("cursor", makeCtx());
    expect(result.status).toBe("uninstalled");
    if (result.status === "uninstalled") {
      // Execution order = reverse of record.ops -> [opB first, opA second].
      expect(result.receipt.filesRemoved).toEqual([absB, absA]);
    }
    await expect(stat(absA)).rejects.toThrow();
    await expect(stat(absB)).rejects.toThrow();
  });
});

// ===========================================================================
// N. Pending journal blocks uninstall
// ===========================================================================

describe("uninstall -- pending journal blocks the call", () => {
  it("throws PendingIntegrationRecoveryError; lock released; target + store bytes unchanged; pending journal still present", async () => {
    const targetPath = "test.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    const content = "x\n";
    await writeFile(targetAbs, content);

    const op = makeWriteNewOp(targetPath, { content });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: sha256OfUtf8(content) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const originalStoreBytes = await readFile(integrationsJsonPath());
    const originalTargetBytes = await readFile(targetAbs);

    const pendingTxnId = "00000000-0000-4000-8000-000000000001";
    const pendingEntry: JournalEntry = {
      txnId: pendingTxnId,
      recordKey: "cursor",
      adapterName: "cursor-test",
      startedAt: "2026-06-27T11:00:00.000Z",
      command: "install",
      cliVersion: "0.7.0-beta.0",
      phase: "writing-files",
      plannedOps: [{ kind: "write-new", target: makePathSpec("other.json") }],
      recordedOps: [],
      backupPaths: [],
    };
    await writeJournal(tempRepo.repoRoot, pendingEntry);

    await expect(uninstall("cursor", makeCtx())).rejects.toBeInstanceOf(
      PendingIntegrationRecoveryError,
    );

    await expect(stat(lockDirPath())).rejects.toThrow();
    expect(Buffer.compare(await readFile(targetAbs), originalTargetBytes)).toBe(0);
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    const pending = await scanForPendingJournals(tempRepo.repoRoot);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.entry.txnId).toBe(pendingTxnId);
  });
});

// ===========================================================================
// O. Lock conflict
// ===========================================================================

describe("uninstall -- lock conflict refusal", () => {
  it("throws IntegrationsLockError; existingPid exposed; lock dir preserved; pre-existing store bytes unchanged", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile(),
      backupGroupId: "init",
    });
    const originalStoreBytes = await readFile(integrationsJsonPath());

    await mkdir(lockDirPath());
    await writeFile(
      lockPidJsonPath(),
      JSON.stringify({
        pid: 12345,
        startedAt: "2026-06-27T11:00:00.000Z",
        command: "install",
      }),
    );

    try {
      await uninstall("cursor", makeCtx());
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationsLockError);
      expect((err as IntegrationsLockError).existingPid).toBe(12345);
    }

    const lockSt = await stat(lockDirPath());
    expect(lockSt.isDirectory()).toBe(true);
    const pidSt = await stat(lockPidJsonPath());
    expect(pidSt.isFile()).toBe(true);

    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
  });
});

// ===========================================================================
// P. Single transaction id discipline -- __store__ before/after diff
// ===========================================================================

describe("uninstall -- single transaction id discipline", () => {
  it("__store__/ gains exactly one new group dir matching <utcSlug>--<uuid>; expected encoded leaf present inside", async () => {
    const targetPath = "test.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    const content = "x\n";
    await writeFile(targetAbs, content);

    const op = makeWriteNewOp(targetPath, { content });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: sha256OfUtf8(content) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "fixture",
    });

    // Snapshot __store__/ before uninstall via before/after diff. This
    // is robust whether or not the fixture writeIntegrationsFile
    // happened to create the directory.
    const storeDir = join(backupsRootPath(), "__store__");
    let beforeEntries: string[] = [];
    try {
      beforeEntries = await readdir(storeDir);
    } catch {
      beforeEntries = [];
    }

    const ctx = makeCtx();
    const result = await uninstall("cursor", ctx);
    expect(result.status).toBe("uninstalled");

    const afterEntries = await readdir(storeDir);
    const newEntries = afterEntries.filter((x) => !beforeEntries.includes(x));
    expect(newEntries).toHaveLength(1);
    const groupId = newEntries[0];
    expect(groupId).toBeDefined();
    if (groupId === undefined) return;

    // Group id matches <utcSlug>--<uuid>; slug derived from ctx.now.
    expect(groupId).toMatch(
      /^\d{8}T\d{9}Z--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(groupId.startsWith(`${expectedUtcSlug(ctx.now)}--`)).toBe(true);

    // Expected encoded leaf file exists inside.
    const backupAbs = join(storeDir, groupId, encodeBackupPath(".viberevert/integrations.json"));
    const backupStat = await stat(backupAbs);
    expect(backupStat.isFile()).toBe(true);
  });
});

// ===========================================================================
// Q. Uninstall preflight propagation -- symlinked target
// ===========================================================================

describe.skipIf(!SYMLINKS_SUPPORTED)("uninstall -- symlinked target preflight propagation", () => {
  it("throws SymlinkTargetRefusal; lock released; backing file + store bytes unchanged", async () => {
    const op = makeWriteNewOp("linked.json", { content: "any-desired\n" });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_A }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });
    const originalStoreBytes = await readFile(integrationsJsonPath());

    const realFile = join(tempRepo.repoRoot, "real-backing");
    await writeFile(realFile, "backing\n");
    const symlinkedTarget = join(tempRepo.repoRoot, "linked.json");
    await symlink(realFile, symlinkedTarget, "file");
    const originalRealBytes = await readFile(realFile);

    await expect(uninstall("cursor", makeCtx())).rejects.toBeInstanceOf(SymlinkTargetRefusal);

    await expect(stat(lockDirPath())).rejects.toThrow();
    expect(Buffer.compare(await readFile(realFile), originalRealBytes)).toBe(0);
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);

    // Defensive cleanup so tempRepo.cleanup rm -rf can remove the temp
    // dir safely on Windows. Swallow errors -- if source ever removed
    // the symlink during refusal cleanup, this should not fail the test.
    try {
      await unlink(symlinkedTarget);
    } catch {
      // no-op
    }
  });
});

// ===========================================================================
// R. integrations.json preserved after last record removal
// ===========================================================================

describe("uninstall -- integrations.json preserved after last-record removal", () => {
  it("after removing the only record: integrations.json still exists; records === {}; history has uninstall entry; createdByVersion preserved", async () => {
    const targetPath = "test.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    const content = "x\n";
    await writeFile(targetAbs, content);

    const op = makeWriteNewOp(targetPath, { content });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: sha256OfUtf8(content) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({
        createdByVersion: "0.7.1-beta.0",
        records: { cursor: record },
      }),
      backupGroupId: "init",
    });

    const ctx = makeCtx();
    const result = await uninstall("cursor", ctx);
    expect(result.status).toBe("uninstalled");

    // integrations.json STILL EXISTS (uninstall never deletes the file).
    const integrationsStat = await stat(integrationsJsonPath());
    expect(integrationsStat.isFile()).toBe(true);

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    // R-specific: records is exactly the empty object after removal.
    expect(integrations?.records).toEqual({});

    // History has the uninstall entry.
    const last = integrations?.history.at(-1);
    expect(last?.action).toBe("uninstall");
    expect(last?.timestamp).toBe(ctx.now.toISOString());

    // createdByVersion preserved (audit trail).
    expect(integrations?.createdByVersion).toBe("0.7.1-beta.0");
  });
});
