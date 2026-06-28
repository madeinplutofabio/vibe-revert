// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Buffer } from "node:buffer";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type {
  AdapterContext,
  ApplicablePlan,
  FileEditOp,
  JsonValue,
  PathSpec,
  RefusedPlan,
} from "@viberevert/adapters";
import { renderSentinelBlock } from "@viberevert/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { apply } from "../src/engine-apply.js";
import {
  ADOPTION_HUMAN_SUMMARY,
  computeDesiredManagedRegionSha,
  DRIFT_REASON_CODE,
  DUPLICATE_PLAN_PATH_REASON_CODE,
  EMPTY_PLAN_REASON_CODE,
  sha256OfUtf8,
} from "../src/engine-classify.js";
import type { RecordKey } from "../src/engine-types.js";
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
// utcSlugFromDate. Only used to derive the expected slug prefix for the
// single-transaction-id test; backup-path SHAPE checks rely on
// parseBackupPathSegments below.
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

/**
 * Parse an absolute backup file path under .viberevert/integration-backups/
 * into its semantic segments. Tolerates Windows separators by normalizing
 * via path.relative + split(sep).join("/"). Throws if the shape doesn't
 * match the locked layout (.viberevert/integration-backups/<recordKey>/
 * <backupGroupId>/<encodedLeaf>).
 */
function parseBackupPathSegments(
  repoRoot: string,
  backupAbsolutePath: string,
): { readonly recordKey: string; readonly backupGroupId: string; readonly encodedLeaf: string } {
  const rel = relative(repoRoot, backupAbsolutePath).split(sep).join("/");
  const segments = rel.split("/");
  const [d1, d2, recordKey, backupGroupId, encodedLeaf, ...rest] = segments;
  if (
    d1 !== ".viberevert" ||
    d2 !== "integration-backups" ||
    recordKey === undefined ||
    backupGroupId === undefined ||
    encodedLeaf === undefined ||
    rest.length !== 0
  ) {
    throw new Error(`unexpected backup path shape: ${rel}`);
  }
  return { recordKey, backupGroupId, encodedLeaf };
}

// ---------------------------------------------------------------------------
// AdapterContext factory with options-deep-merge (preserves 2J.d1 pattern).
// ---------------------------------------------------------------------------

type AdapterContextOverrides = Omit<Partial<AdapterContext>, "options"> & {
  readonly options?: Partial<AdapterContext["options"]>;
};

function makeCtx(overrides: AdapterContextOverrides = {}): AdapterContext {
  const base: AdapterContext = {
    repoRoot: tempRepo.repoRoot,
    now: new Date("2026-06-27T12:00:00.000Z"),
    cliVersion: "0.7.1-beta.0",
    intent: "explicit",
    options: { forceReinstall: false, migrateFromHookInstall: false, forceUninstall: false },
  };
  return {
    ...base,
    ...overrides,
    options: { ...base.options, ...overrides.options },
  };
}

function forcedCtx(): AdapterContext {
  return makeCtx({ options: { forceReinstall: true } });
}

// ---------------------------------------------------------------------------
// Plan + op factories
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

function makeApplicablePlan(overrides: Partial<ApplicablePlan> = {}): ApplicablePlan {
  return {
    status: "applicable",
    adapterName: "test-adapter",
    humanSummary: "test plan summary",
    ops: [makeWriteNewOp("test.json")],
    recordKey: "cursor",
    meta: {},
    ...overrides,
  };
}

function makeRefusedPlan(overrides: Partial<RefusedPlan> = {}): RefusedPlan {
  return {
    status: "refused",
    adapterName: "test-adapter",
    reasonCode: "adapter-refused-test",
    message: "refused for test",
    ...overrides,
  };
}

function plan(op: FileEditOp): ApplicablePlan {
  return makeApplicablePlan({ ops: [op] });
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
 * Path-aware record factory. Same shape as 2J.d2: produces a record whose
 * target/blockId/jsonKeyPath matches the plan op so the apply orchestrator's
 * per-op filter actually finds it. Tests pass only SHA overrides for noop /
 * drift fixtures.
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

// ===========================================================================
// A. Pre-lock refusals (no lock acquired -> no .viberevert/)
// ===========================================================================

describe("apply -- pre-lock refusals do NOT acquire the lock", () => {
  it("adapter refused plan -> refused passthrough; no .viberevert/ created", async () => {
    const planRefused = makeRefusedPlan({
      adapterName: "cursor",
      reasonCode: "config-shape-bad",
      message: "manual install required",
      manualSnippet: "echo 'paste'",
    });
    const result = await apply(planRefused, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.adapterName).toBe("cursor");
      expect(result.reasonCode).toBe("config-shape-bad");
      expect(result.manualSnippet).toBe("echo 'paste'");
    }
    await expect(stat(viberevertPath())).rejects.toThrow();
  });

  it("empty applicable plan -> EMPTY_PLAN_REASON_CODE; no .viberevert/ created", async () => {
    const planEmpty = makeApplicablePlan({ ops: [] });
    const result = await apply(planEmpty, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(EMPTY_PLAN_REASON_CODE);
    }
    await expect(stat(viberevertPath())).rejects.toThrow();
  });

  it("duplicate plan paths -> DUPLICATE_PLAN_PATH_REASON_CODE; no .viberevert/ created", async () => {
    const planDup = makeApplicablePlan({
      ops: [makeWriteNewOp("dup.json"), makeWriteNewOp("dup.json")],
    });
    const result = await apply(planDup, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(DUPLICATE_PLAN_PATH_REASON_CODE);
    }
    await expect(stat(viberevertPath())).rejects.toThrow();
  });
});

// ===========================================================================
// B. write-new applied -- receipt shape + chmod (POSIX) + path absoluteness
// ===========================================================================

describe("apply -- write-new mutation", () => {
  it("applied: receipt fields populated, target written, record stored, history appended, journal cleaned, lock released", async () => {
    // mode 0o755 chosen so a POSIX chmod actually changes the file's mode
    // away from the default writeFile permissions -- a passing assertion
    // proves chmod ran (not just the umask default).
    const op = makeWriteNewOp("hooks/run.sh", {
      content: "#!/bin/sh\nexit 0\n",
      mode: 0o755,
    });
    const ctx = makeCtx();
    const planApp = makeApplicablePlan({ ops: [op] });
    const result = await apply(planApp, ctx);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    const { receipt } = result;

    // Receipt -- semantic fields + absoluteness.
    expect(receipt.recordKey).toBe("cursor");
    expect(receipt.adapterName).toBe("test-adapter");
    expect(receipt.opsApplied).toBe(1);
    expect(receipt.filesWritten).toHaveLength(1);
    const writtenAbs = receipt.filesWritten[0];
    expect(writtenAbs).toBeDefined();
    if (writtenAbs === undefined) return;
    expect(isAbsolute(writtenAbs)).toBe(true);
    expect(writtenAbs).toBe(join(tempRepo.repoRoot, "hooks", "run.sh"));
    expect(receipt.backupsCreated).toEqual([]);
    expect(isAbsolute(receipt.integrationsJsonPath)).toBe(true);
    expect(receipt.integrationsJsonPath).toBe(integrationsJsonPath());
    expect(receipt.humanSummary).toBe("test plan summary");

    // Target file has the expected content.
    expect(await readFile(writtenAbs, "utf8")).toBe("#!/bin/sh\nexit 0\n");

    // chmod proof (POSIX only).
    if (process.platform !== "win32") {
      const st = await stat(writtenAbs);
      expect(st.mode & 0o777).toBe(0o755);
    }

    // Integrations record stored with correct semantic fields.
    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations).not.toBeNull();
    const cursorRecord = integrations?.records.cursor;
    expect(cursorRecord).toBeDefined();
    if (cursorRecord === undefined) return;
    expect(cursorRecord.recordKey).toBe("cursor");
    expect(cursorRecord.adapterName).toBe("test-adapter");
    expect(cursorRecord.installedAt).toBe(ctx.now.toISOString());
    expect(cursorRecord.installedByVersion).toBe("0.7.1-beta.0");
    expect(cursorRecord.ops).toHaveLength(1);
    const op0 = cursorRecord.ops[0];
    expect(op0).toBeDefined();
    if (op0 === undefined) return;
    expect(op0.kind).toBe("write-new");
    expect(op0.target.pathRelative).toBe("hooks/run.sh");
    expect(op0.fullFileSha256AfterWrite).toBe(sha256OfUtf8("#!/bin/sh\nexit 0\n"));
    expect(op0.backup).toBeNull();
    expect(op0.mode).toBe(0o755);

    // History entry with action "install".
    expect(integrations?.history).toHaveLength(1);
    const h0 = integrations?.history[0];
    expect(h0?.action).toBe("install");
    expect(h0?.recordKey).toBe("cursor");
    expect(h0?.timestamp).toBe(ctx.now.toISOString());

    // Lock released, no pending journal.
    await expect(stat(lockDirPath())).rejects.toThrow();
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
  });
});

// ===========================================================================
// C. backup-and-write mutation -- raw-byte backup verification
// ===========================================================================

describe("apply -- backup-and-write mutation", () => {
  it("applied: backup file contains pre-mutation bytes verbatim (Buffer-faithful), target updated", async () => {
    // Pre-create target with deliberately non-UTF-8 bytes to prove the
    // backup write does NOT decode through utf8 (which would replace
    // invalid sequences with U+FFFD and lose crash evidence).
    const targetPath = "config/binaryish";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    await mkdir(join(tempRepo.repoRoot, "config"));
    const originalBytes = Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x00, 0x82, 0xc0, 0xc1]);
    await writeFile(targetAbs, originalBytes);

    const op = makeBackupAndWriteOp(targetPath, { content: "new desired content\n" });
    const ctx = makeCtx();
    const planApp = makeApplicablePlan({ ops: [op] });
    const result = await apply(planApp, ctx);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    const { receipt } = result;

    expect(receipt.opsApplied).toBe(1);
    expect(receipt.filesWritten).toEqual([targetAbs]);
    expect(receipt.backupsCreated).toHaveLength(1);
    const backupAbs = receipt.backupsCreated[0];
    expect(backupAbs).toBeDefined();
    if (backupAbs === undefined) return;
    expect(isAbsolute(backupAbs)).toBe(true);

    // Backup bytes byte-for-byte equal the original target bytes.
    const backupBytes = await readFile(backupAbs);
    expect(Buffer.compare(backupBytes, originalBytes)).toBe(0);

    // Target updated to desired content.
    expect(await readFile(targetAbs, "utf8")).toBe("new desired content\n");

    // Backup path matches the expected layout (Windows-safe parsing).
    const { recordKey, encodedLeaf } = parseBackupPathSegments(tempRepo.repoRoot, backupAbs);
    expect(recordKey).toBe("cursor");
    expect(encodedLeaf).toBe(encodeBackupPath(targetPath));

    // Record carries the backup PathSpec.
    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    const recordOp = integrations?.records.cursor?.ops[0];
    expect(recordOp?.kind).toBe("backup-and-write");
    expect(recordOp?.backup).not.toBeNull();
    expect(recordOp?.fullFileSha256AfterWrite).toBe(sha256OfUtf8("new desired content\n"));

    await expect(stat(lockDirPath())).rejects.toThrow();
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
  });
});

// ===========================================================================
// D. sentinel-block-insert mutation
// ===========================================================================

describe("apply -- sentinel-block-insert mutation", () => {
  it("applied: target contains rendered sentinel block; record SHA = sha256(op.content)", async () => {
    const targetPath = ".husky/pre-commit";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    await mkdir(join(tempRepo.repoRoot, ".husky"));
    await writeFile(targetAbs, '#!/usr/bin/env sh\n. "$(dirname $0)/_/husky.sh"\n');

    const op = makeSentinelInsertOp(targetPath, {
      blockId: "husky-pre-commit",
      content: "viberevert check --staged",
    });
    const result = await apply(plan(op), makeCtx());

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.receipt.opsApplied).toBe(1);

    const targetContent = await readFile(targetAbs, "utf8");
    expect(targetContent).toContain(
      renderSentinelBlock("husky-pre-commit", "viberevert check --staged"),
    );

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    const recordOp = integrations?.records.cursor?.ops[0];
    expect(recordOp?.kind).toBe("sentinel-block-insert");
    expect(recordOp?.managedBlockSha256).toBe(sha256OfUtf8("viberevert check --staged"));
    expect(recordOp?.blockId).toBe("husky-pre-commit");
  });
});

// ===========================================================================
// D'. Apply preflight propagation -- symlinked target
// ===========================================================================

describe.skipIf(!SYMLINKS_SUPPORTED)("apply -- symlinked target preflight propagation", () => {
  it("throws SymlinkTargetRefusal before any mutation; lock released; no journal written", async () => {
    const realFile = join(tempRepo.repoRoot, "real-backing");
    await writeFile(realFile, "backing\n");
    const symlinkedTarget = join(tempRepo.repoRoot, "linked.json");
    await symlink(realFile, symlinkedTarget, "file");

    const op = makeWriteNewOp("linked.json", { content: "should not be written\n" });
    await expect(apply(plan(op), makeCtx())).rejects.toBeInstanceOf(SymlinkTargetRefusal);

    // Lock released after the throw (acquireLock succeeded, then
    // assertSafeTarget threw inside the try, finally released).
    await expect(stat(lockDirPath())).rejects.toThrow();
    // No journal got past the early throw.
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
    // Real backing file untouched (symlink target was the symlink itself).
    expect(await readFile(realFile, "utf8")).toBe("backing\n");
  });
});

// ===========================================================================
// E. json-key-merge mutation
// ===========================================================================

describe("apply -- json-key-merge mutation", () => {
  it("applied: target JSON gains merged value; record stores managedValueSha256 + jsonKeyPath", async () => {
    const targetPath = ".cursor/mcp.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    await mkdir(join(tempRepo.repoRoot, ".cursor"));
    await writeFile(targetAbs, '{"mcpServers":{"other":{}}}');

    const op = makeJsonKeyMergeOp(targetPath, {
      keyPath: ["mcpServers", "viberevert"],
      value: { command: "viberevert", args: ["mcp", "serve"] } as JsonValue,
    });
    const result = await apply(plan(op), makeCtx());
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.receipt.opsApplied).toBe(1);

    const parsed = JSON.parse(await readFile(targetAbs, "utf8")) as {
      mcpServers: { other: object; viberevert: { command: string; args: string[] } };
    };
    expect(parsed.mcpServers.viberevert).toEqual({
      command: "viberevert",
      args: ["mcp", "serve"],
    });
    expect(parsed.mcpServers.other).toEqual({});

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    const recordOp = integrations?.records.cursor?.ops[0];
    expect(recordOp?.kind).toBe("json-key-merge");
    expect(recordOp?.jsonKeyPath).toEqual(["mcpServers", "viberevert"]);
    const expectedSha = computeDesiredManagedRegionSha({ op, desiredFullFileBytes: "" });
    expect(recordOp?.managedValueSha256).toBe(expectedSha);
  });
});

// ===========================================================================
// F. Aggregate noop -- store + target bytes byte-for-byte unchanged
// ===========================================================================

describe("apply -- aggregate noop", () => {
  it("noop: outcome.status === 'noop'; target and integrations.json bytes UNCHANGED; no journal; lock released", async () => {
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

    const originalStoreBytes = await readFile(integrationsJsonPath());
    const originalTargetBytes = await readFile(targetAbs);

    const result = await apply(plan(op), makeCtx());
    expect(result.status).toBe("noop");
    if (result.status === "noop") {
      expect(result.recordKey).toBe("cursor");
      expect(result.adapterName).toBe("test-adapter");
      expect(result.reason.length).toBeGreaterThan(0);
    }

    // Byte-for-byte unchanged.
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    expect(Buffer.compare(await readFile(targetAbs), originalTargetBytes)).toBe(0);

    // No journal, lock released.
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
    await expect(stat(lockDirPath())).rejects.toThrow();
  });
});

// ===========================================================================
// G. Aggregate refused -- two drifting write-new ops, both paths in message
// ===========================================================================

describe("apply -- aggregate refused via two drifted write-new ops", () => {
  it("refused: outcome reasonCode = DRIFT; both target paths surfaced; store + targets UNCHANGED; no journal", async () => {
    const path1 = "drift-a.json";
    const path2 = "drift-b.json";
    const current1 = "user-edited-a\n";
    const current2 = "user-edited-b\n";
    await writeFile(join(tempRepo.repoRoot, path1), current1);
    await writeFile(join(tempRepo.repoRoot, path2), current2);

    const op1 = makeWriteNewOp(path1, { content: "desired-a\n" });
    const op2 = makeWriteNewOp(path2, { content: "desired-b\n" });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op1, { fullFileSha256AfterWrite: SHA_B }),
      makeRecordOpFor(op2, { fullFileSha256AfterWrite: SHA_B }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const originalStoreBytes = await readFile(integrationsJsonPath());
    const originalT1 = await readFile(join(tempRepo.repoRoot, path1));
    const originalT2 = await readFile(join(tempRepo.repoRoot, path2));

    const planTwo = makeApplicablePlan({ ops: [op1, op2] });
    const result = await apply(planTwo, makeCtx());

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
      expect(result.message).toContain(path1);
      expect(result.message).toContain(path2);
    }

    // Store + both targets unchanged.
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(tempRepo.repoRoot, path1)), originalT1)).toBe(0);
    expect(Buffer.compare(await readFile(join(tempRepo.repoRoot, path2)), originalT2)).toBe(0);

    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
    await expect(stat(lockDirPath())).rejects.toThrow();
  });
});

// ===========================================================================
// H. Adoption-only backup-and-write (ADOPTION-AND-BACKUP rule)
// ===========================================================================

describe("apply -- adoption-only backup-and-write", () => {
  it("applied: opsApplied=0, filesWritten=[], backupsCreated=[1]; target unchanged; backup bytes = pre-apply target bytes; history 'adopt'; does not leave a journal", async () => {
    const targetPath = "config/already-managed";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    await mkdir(join(tempRepo.repoRoot, "config"));
    const adoptedContent = "already-managed-content\n";
    await writeFile(targetAbs, adoptedContent);
    const originalTargetBytes = await readFile(targetAbs);

    // op.content matches existing target -> adoption.
    // NO existing record for "cursor" -> classifier's no-record adoption.
    const op = makeBackupAndWriteOp(targetPath, { content: adoptedContent });
    const ctx = makeCtx();
    const result = await apply(plan(op), ctx);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    const { receipt } = result;

    expect(receipt.opsApplied).toBe(0);
    expect(receipt.filesWritten).toEqual([]);
    expect(receipt.backupsCreated).toHaveLength(1);
    expect(receipt.humanSummary).toBe(ADOPTION_HUMAN_SUMMARY);

    // Target bytes UNCHANGED.
    expect(Buffer.compare(await readFile(targetAbs), originalTargetBytes)).toBe(0);

    // Backup bytes = pre-apply target bytes (the ADOPTION-AND-BACKUP rule:
    // backup happens even though target doesn't mutate).
    const backupAbs = receipt.backupsCreated[0];
    expect(backupAbs).toBeDefined();
    if (backupAbs === undefined) return;
    expect(Buffer.compare(await readFile(backupAbs), originalTargetBytes)).toBe(0);

    // History action "adopt".
    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.history).toHaveLength(1);
    expect(integrations?.history[0]?.action).toBe("adopt");

    // Does not leave a journal (adoption-only writes none).
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);

    // Lock released.
    await expect(stat(lockDirPath())).rejects.toThrow();
  });
});

// ===========================================================================
// I. Force scope at the apply boundary (same fixture, two ctx variants)
// ===========================================================================

describe("apply -- force scope at the apply boundary", () => {
  async function setupDriftFixture(): Promise<{
    readonly plan: ApplicablePlan;
    readonly originalTargetBytes: Buffer;
    readonly originalStoreBytes: Buffer;
    readonly targetAbs: string;
  }> {
    const targetPath = "drift.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    await writeFile(targetAbs, "user-edited\n");
    const op = makeWriteNewOp(targetPath, { content: "desired\n" });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_B }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });
    return {
      plan: makeApplicablePlan({ ops: [op] }),
      originalTargetBytes: await readFile(targetAbs),
      originalStoreBytes: await readFile(integrationsJsonPath()),
      targetAbs,
    };
  }

  it("default ctx -> refused with DRIFT_REASON_CODE; target + store bytes unchanged", async () => {
    const {
      plan: planDrift,
      originalTargetBytes,
      originalStoreBytes,
      targetAbs,
    } = await setupDriftFixture();
    const result = await apply(planDrift, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
    expect(Buffer.compare(await readFile(targetAbs), originalTargetBytes)).toBe(0);
    expect(Buffer.compare(await readFile(integrationsJsonPath()), originalStoreBytes)).toBe(0);
    await expect(stat(lockDirPath())).rejects.toThrow();
  });

  it("forced ctx -> applied; target rewritten to desired content; no backup (write-new has no backup discipline)", async () => {
    const { plan: planDrift, targetAbs } = await setupDriftFixture();
    const result = await apply(planDrift, forcedCtx());
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.receipt.opsApplied).toBe(1);
    expect(result.receipt.backupsCreated).toEqual([]);
    expect(await readFile(targetAbs, "utf8")).toBe("desired\n");
  });
});

// ===========================================================================
// J. Single transaction id discipline -- target backup + __store__ backup
//    share the same <utcSlug>--<uuid> group id
// ===========================================================================

describe("apply -- single transaction id discipline", () => {
  it("target backup and __store__ self-backup share the same <utcSlug>--<uuid> group id", async () => {
    // Pre-existing integrations.json so writeIntegrationsFile's __store__
    // self-backup fires (it only runs when the file pre-exists). Use an
    // empty-records store so the cursor record is added by apply.
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile(),
      backupGroupId: "preexisting",
    });
    const targetPath = "config/managed";
    const targetAbs = join(tempRepo.repoRoot, targetPath);
    await mkdir(join(tempRepo.repoRoot, "config"));
    await writeFile(targetAbs, "pre-existing target\n");

    const op = makeBackupAndWriteOp(targetPath, { content: "new content\n" });
    const ctx = makeCtx();
    const result = await apply(plan(op), ctx);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.receipt.backupsCreated).toHaveLength(1);
    const targetBackupAbs = result.receipt.backupsCreated[0];
    expect(targetBackupAbs).toBeDefined();
    if (targetBackupAbs === undefined) return;

    // Parse the target-backup path to extract the group id.
    const { recordKey, backupGroupId, encodedLeaf } = parseBackupPathSegments(
      tempRepo.repoRoot,
      targetBackupAbs,
    );
    expect(recordKey).toBe("cursor");
    expect(encodedLeaf).toBe(encodeBackupPath(targetPath));

    // Group id shape: <utcSlug>--<uuid>; slug derived from ctx.now.
    expect(backupGroupId).toMatch(
      /^\d{8}T\d{9}Z--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(backupGroupId.startsWith(`${expectedUtcSlug(ctx.now)}--`)).toBe(true);

    // __store__ self-backup MUST use the SAME backupGroupId.
    const storeBackupAbs = join(
      backupsRootPath(),
      "__store__",
      backupGroupId,
      encodeBackupPath(".viberevert/integrations.json"),
    );
    const storeBackupStat = await stat(storeBackupAbs);
    expect(storeBackupStat.isFile()).toBe(true);
  });
});

// ===========================================================================
// L. createdByVersion preserved; updatedByVersion overwritten (via safe-update)
// ===========================================================================

describe("apply -- createdByVersion preserved + updatedByVersion overwritten on safe-update", () => {
  it("two applies with different cliVersion: createdByVersion stays first; updatedByVersion = second", async () => {
    const targetPath = "test.json";
    const targetAbs = join(tempRepo.repoRoot, targetPath);

    // Apply 1: write-new with cliVersion 0.7.1-beta.0, content A. Missing
    // target -> would-apply (mutation).
    const opA = makeWriteNewOp(targetPath, { content: "content-A\n" });
    const ctxFirst = makeCtx({ cliVersion: "0.7.1-beta.0" });
    const r1 = await apply(plan(opA), ctxFirst);
    expect(r1.status).toBe("applied");
    expect(await readFile(targetAbs, "utf8")).toBe("content-A\n");

    // Apply 2: same op kind + target, content B, cliVersion 0.8.0. The
    // existing record has SHA(A); current bytes (still content A) match
    // recorded; desired SHA(B) differs from recorded -> would-safe-update
    // (the only path that actually writes the store with a NEW
    // updatedByVersion AND preserves createdByVersion).
    const opB = makeWriteNewOp(targetPath, { content: "content-B\n" });
    const ctxSecond = makeCtx({ cliVersion: "0.8.0" });
    const r2 = await apply(plan(opB), ctxSecond);
    expect(r2.status).toBe("applied");
    expect(await readFile(targetAbs, "utf8")).toBe("content-B\n");

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.createdByVersion).toBe("0.7.1-beta.0");
    expect(integrations?.updatedByVersion).toBe("0.8.0");
  });
});

// ===========================================================================
// M. History trim at 999 + new entry boundary
// ===========================================================================

describe("apply -- history trim to last 999 + append new entry", () => {
  it("pre-existing 1000-entry history is trimmed to last 999 + new entry; resulting length 1000; first remaining is original index-1; last is new install", async () => {
    // Build 1000 valid history entries. Each carries a per-index marker
    // in cliVersion ("old-0" .. "old-999") so we can prove which entries
    // survived the trim.
    const oldHistory = Array.from({ length: 1000 }, (_, i) => ({
      timestamp: "2026-01-01T00:00:00.000Z",
      action: "install" as const,
      recordKey: "cursor" as RecordKey,
      cliVersion: `old-${i}`,
    }));
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ history: oldHistory }),
      backupGroupId: "init",
    });

    // Apply a fresh write-new to trigger mutation + new history entry.
    const ctx = makeCtx({ cliVersion: "0.7.1-beta.0" });
    const op = makeWriteNewOp("histtest.json", { content: "x\n" });
    const r = await apply(plan(op), ctx);
    expect(r.status).toBe("applied");

    const integrations = await readIntegrationsFile(tempRepo.repoRoot);
    expect(integrations?.history).toHaveLength(1000);

    // The slice(-999) drops original index 0; index 1 ("old-1") survives
    // as the new first entry.
    expect(integrations?.history[0]?.cliVersion).toBe("old-1");

    // Last entry = the just-installed entry.
    const last = integrations?.history[999];
    expect(last?.action).toBe("install");
    expect(last?.recordKey).toBe("cursor");
    expect(last?.cliVersion).toBe("0.7.1-beta.0");
    expect(last?.timestamp).toBe(ctx.now.toISOString());
  });
});

// ===========================================================================
// N. Pending journal blocks new install (via writeJournal helper)
// ===========================================================================

describe("apply -- pending journal blocks new install", () => {
  it("throws PendingIntegrationRecoveryError before any mutation; lock released; no fresh journal added", async () => {
    // Seed a valid pending journal via the real writer (so the journal
    // shape exactly matches what the scanner expects -- no hand-written
    // schema brittleness).
    const pendingTxnId = "00000000-0000-4000-8000-000000000001";
    const pendingEntry: JournalEntry = {
      txnId: pendingTxnId,
      recordKey: "cursor",
      adapterName: "cursor-test",
      startedAt: "2026-06-27T11:00:00.000Z",
      command: "install",
      cliVersion: "0.7.0-beta.0",
      phase: "writing-files",
      plannedOps: [{ kind: "write-new", target: makePathSpec("test.json") }],
      recordedOps: [],
      backupPaths: [],
    };
    await writeJournal(tempRepo.repoRoot, pendingEntry);

    const op = makeWriteNewOp("fresh.json", { content: "x\n" });
    await expect(apply(plan(op), makeCtx())).rejects.toBeInstanceOf(
      PendingIntegrationRecoveryError,
    );

    // Lock released (acquired, then scan threw inside try, finally released).
    await expect(stat(lockDirPath())).rejects.toThrow();

    // Pending journal still exists (the seeded one, not a new apply
    // journal). Apply must not have written its own journal because
    // pending-scan refused before that step.
    const pending = await scanForPendingJournals(tempRepo.repoRoot);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.entry.txnId).toBe(pendingTxnId);
  });
});

// ===========================================================================
// O. Lock conflict -- realistic pid.json + existingPid assertion
// ===========================================================================

describe("apply -- lock conflict refusal", () => {
  it("throws IntegrationsLockError; existingPid exposed; lock dir preserved (no auto-clean)", async () => {
    // Simulate a concurrent / crashed installer's lock with realistic
    // pid.json content matching lock.ts's writer shape.
    await mkdir(viberevertPath());
    await mkdir(lockDirPath());
    await writeFile(
      lockPidJsonPath(),
      JSON.stringify({
        pid: 12345,
        startedAt: "2026-06-27T11:00:00.000Z",
        command: "install",
      }),
    );

    const op = makeWriteNewOp("any.json", { content: "x\n" });
    try {
      await apply(plan(op), makeCtx());
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationsLockError);
      expect((err as IntegrationsLockError).existingPid).toBe(12345);
    }

    // Lock dir + pid.json preserved (no auto-clean).
    const lockSt = await stat(lockDirPath());
    expect(lockSt.isDirectory()).toBe(true);
    const pidSt = await stat(lockPidJsonPath());
    expect(pidSt.isFile()).toBe(true);
  });
});

// ===========================================================================
// P. Mutation journal cleanup -- scanForPendingJournals empty after commit
// ===========================================================================

describe("apply -- mutation journal cleanup after commit", () => {
  it("scanForPendingJournals returns [] after a successful mutation apply", async () => {
    const op = makeWriteNewOp("clean.json", { content: "x\n" });
    const r = await apply(plan(op), makeCtx());
    expect(r.status).toBe("applied");
    expect(await scanForPendingJournals(tempRepo.repoRoot)).toEqual([]);
  });
});
