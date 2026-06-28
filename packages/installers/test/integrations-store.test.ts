// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Buffer } from "node:buffer";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RecordKey } from "../src/engine-types.js";
import {
  BackupCollisionError,
  IntegrationsCorruptedError,
  IntegrationsSchemaVersionError,
  IntegrationTargetNotFileError,
  IntegrationTargetParentNotDirectoryError,
  SymlinkTargetRefusal,
} from "../src/errors.js";
import type { IntegrationRecord, IntegrationsFile } from "../src/integrations-schema.js";
import { readIntegrationsFile, writeIntegrationsFile } from "../src/integrations-store.js";
import { encodeBackupPath } from "../src/path-encode.js";

import { createDirectorySymlink, createTempRepo, SYMLINKS_SUPPORTED } from "./helpers/temp-repo.js";

const SHA_A = "a".repeat(64);

let tempRepo: Awaited<ReturnType<typeof createTempRepo>>;

beforeEach(async () => {
  tempRepo = await createTempRepo();
});

afterEach(async () => {
  await tempRepo.cleanup();
});

// --- Path helpers: every backup path is computed via encodeBackupPath
// rather than hardcoded. path-encode.ts has its own dedicated 2J.a
// tests for the encoding contract; this file does not re-verify it. ---

function viberevertPath(): string {
  return join(tempRepo.repoRoot, ".viberevert");
}
function integrationsJsonPath(): string {
  return join(viberevertPath(), "integrations.json");
}
function storeBackupGroupDir(backupGroupId: string): string {
  return join(viberevertPath(), "integration-backups", "__store__", backupGroupId);
}
function storeBackupPath(backupGroupId: string): string {
  return join(
    storeBackupGroupDir(backupGroupId),
    encodeBackupPath(".viberevert/integrations.json"),
  );
}

// --- Minimal fixture builders ---

function makeMinimalRecord(recordKey: RecordKey): IntegrationRecord {
  return {
    recordKey,
    adapterName: `${recordKey}-test`,
    installedAt: "2026-06-27T12:00:00.000Z",
    installedByVersion: "0.7.1-beta.0",
    ops: [
      {
        kind: "write-new",
        target: { scope: "repo", pathTemplate: "{repo}/test.json", pathRelative: "test.json" },
        backup: null,
        managedBlockSha256: null,
        managedValueSha256: null,
        fullFileSha256AfterWrite: SHA_A,
        blockId: null,
        jsonKeyPath: null,
        mode: null,
      },
    ],
    meta: {},
  };
}

function makeMinimalIntegrationsFile(overrides: Partial<IntegrationsFile> = {}): IntegrationsFile {
  return {
    schemaVersion: 1,
    createdByVersion: "0.7.1-beta.0",
    updatedByVersion: "0.7.1-beta.0",
    records: {},
    history: [],
    ...overrides,
  };
}

// ===========================================================================
// readIntegrationsFile -- absence
// ===========================================================================

describe("readIntegrationsFile -- absence returns null", () => {
  it("returns null when .viberevert/ does not exist", async () => {
    expect(await readIntegrationsFile(tempRepo.repoRoot)).toBeNull();
  });
  it("returns null when .viberevert/ exists but integrations.json does not", async () => {
    await mkdir(viberevertPath());
    expect(await readIntegrationsFile(tempRepo.repoRoot)).toBeNull();
  });
});

// ===========================================================================
// readIntegrationsFile -- classification policy
// ===========================================================================

describe("readIntegrationsFile -- corruption (root level)", () => {
  it("throws IntegrationsCorruptedError on JSON syntax error", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), "{ this is not valid json");
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });
  it("throws IntegrationsCorruptedError on non-object root (null)", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), "null");
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });
  it("throws IntegrationsCorruptedError on non-object root (array)", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), "[]");
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });
  it("throws IntegrationsCorruptedError on non-object root (string)", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), '"hello"');
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });
  it("throws IntegrationsCorruptedError on non-object root (number)", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), "42");
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });
  it("throws IntegrationsCorruptedError on non-object root (boolean)", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), "true");
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });
});

describe("readIntegrationsFile -- schema version mismatch", () => {
  it("throws IntegrationsSchemaVersionError on missing schemaVersion (foundVersion undefined)", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), "{}");
    try {
      await readIntegrationsFile(tempRepo.repoRoot);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationsSchemaVersionError);
      expect((err as IntegrationsSchemaVersionError).foundVersion).toBeUndefined();
      expect((err as IntegrationsSchemaVersionError).expectedVersion).toBe(1);
    }
  });
  it("throws IntegrationsSchemaVersionError on schemaVersion: 2", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), '{"schemaVersion": 2}');
    try {
      await readIntegrationsFile(tempRepo.repoRoot);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationsSchemaVersionError);
      expect((err as IntegrationsSchemaVersionError).foundVersion).toBe(2);
    }
  });
  it('throws IntegrationsSchemaVersionError on schemaVersion: "1" (string, not number)', async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), '{"schemaVersion": "1"}');
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsSchemaVersionError,
    );
  });
  it("throws IntegrationsSchemaVersionError on schemaVersion: null", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), '{"schemaVersion": null}');
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsSchemaVersionError,
    );
  });
});

describe("readIntegrationsFile -- valid v1 but bad shape", () => {
  it("throws IntegrationsCorruptedError when records.cursor is a non-object", async () => {
    // schemaVersion is 1 (right version) but records["cursor"] is a
    // string -- schema.parse fails inside partialRecord. Per source
    // policy this is CORRUPTION (file LOOKS LIKE an integrations file
    // but doesn't match shape), NOT a version mismatch.
    await mkdir(viberevertPath());
    await writeFile(
      integrationsJsonPath(),
      JSON.stringify({
        schemaVersion: 1,
        createdByVersion: "0.0.0-test",
        updatedByVersion: "0.0.0-test",
        records: { cursor: "not-a-record" },
        history: [],
      }),
    );
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });
});

describe("readIntegrationsFile -- valid empty file", () => {
  it("reads an empty file successfully (records: {}, history: [])", async () => {
    await mkdir(viberevertPath());
    const file = makeMinimalIntegrationsFile();
    await writeFile(integrationsJsonPath(), JSON.stringify(file));
    const parsed = await readIntegrationsFile(tempRepo.repoRoot);
    expect(parsed).not.toBeNull();
    expect(parsed?.schemaVersion).toBe(1);
    expect(parsed?.records).toEqual({});
    expect(parsed?.history).toEqual([]);
  });
});

// ===========================================================================
// readIntegrationsFile -- FS safety
// ===========================================================================

describe("readIntegrationsFile -- non-symlink FS safety", () => {
  it("refuses .viberevert/ as a regular file", async () => {
    await writeFile(viberevertPath(), "not a directory");
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationTargetParentNotDirectoryError,
    );
  });
  it("refuses integrations.json as a directory", async () => {
    await mkdir(viberevertPath());
    await mkdir(integrationsJsonPath());
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      IntegrationTargetNotFileError,
    );
  });
});

describe.skipIf(!SYMLINKS_SUPPORTED)("readIntegrationsFile -- symlink refusals", () => {
  it("refuses symlinked .viberevert/ dir", async () => {
    const elsewhere = join(tempRepo.repoRoot, "elsewhere");
    await mkdir(elsewhere);
    await createDirectorySymlink(elsewhere, viberevertPath());
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      SymlinkTargetRefusal,
    );
  });
  it("refuses symlinked integrations.json file", async () => {
    await mkdir(viberevertPath());
    const realFile = join(tempRepo.repoRoot, "real-integrations.json");
    await writeFile(realFile, JSON.stringify(makeMinimalIntegrationsFile()));
    await symlink(realFile, integrationsJsonPath(), "file");
    await expect(readIntegrationsFile(tempRepo.repoRoot)).rejects.toBeInstanceOf(
      SymlinkTargetRefusal,
    );
  });
});

// ===========================================================================
// writeIntegrationsFile -- creates new
// ===========================================================================

describe("writeIntegrationsFile -- creates new file from scratch", () => {
  it("creates .viberevert/integrations.json when neither exists", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId: "init-group",
    });
    const st = await stat(integrationsJsonPath());
    expect(st.isFile()).toBe(true);
  });
  it("creates .viberevert/ as part of the write", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId: "init-group",
    });
    const st = await stat(viberevertPath());
    expect(st.isDirectory()).toBe(true);
  });
  it("does NOT create any backup chain when there is no existing file", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId: "init-group",
    });
    // No backups dir at all -- writeIntegrationsFile only creates the
    // backup chain inside the `if (existingBytes !== null)` block.
    await expect(stat(join(viberevertPath(), "integration-backups"))).rejects.toThrow();
  });
});

// ===========================================================================
// writeIntegrationsFile -- on-disk format
// ===========================================================================

describe("writeIntegrationsFile -- on-disk format", () => {
  it("writes valid JSON that round-trips through readIntegrationsFile", async () => {
    const file = makeMinimalIntegrationsFile({
      records: { cursor: makeMinimalRecord("cursor") },
    });
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: file,
      backupGroupId: "rt-group",
    });
    const parsed = await readIntegrationsFile(tempRepo.repoRoot);
    expect(parsed).toEqual(file);
  });
  it("ends file with a single trailing newline (not double)", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId: "nl-group",
    });
    const raw = await readFile(integrationsJsonPath(), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);
  });
  it("writes human-readable pretty JSON (2-space indent)", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId: "pp-group",
    });
    const raw = await readFile(integrationsJsonPath(), "utf8");
    expect(raw).toContain('\n  "schemaVersion"');
  });
});

// ===========================================================================
// writeIntegrationsFile -- backs up existing file (byte-preserving)
// ===========================================================================

describe("writeIntegrationsFile -- backs up existing file (byte-preserving)", () => {
  it("writes backup at the path computed via encodeBackupPath", async () => {
    // Pre-create an existing integrations.json (writeIntegrationsFile
    // reads it as Buffer without validation; any bytes are fine).
    await mkdir(viberevertPath());
    const originalBytes = Buffer.from("any existing content");
    await writeFile(integrationsJsonPath(), originalBytes);

    const backupGroupId = "test-group-001";
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId,
    });

    const expectedBackupPath = storeBackupPath(backupGroupId);
    const backupBytes = await readFile(expectedBackupPath);
    expect(Buffer.compare(backupBytes, originalBytes)).toBe(0);
  });

  it("preserves non-UTF-8 bytes verbatim (raw Buffer, no encoding transformation)", async () => {
    // Write deliberately invalid UTF-8 to the existing integrations.json.
    // writeIntegrationsFile MUST NOT decode through utf8 -- otherwise
    // invalid sequences would be replaced with U+FFFD and the backup
    // would lose its value as crash evidence. The test does NOT route
    // through readIntegrationsFile (which would correctly throw on
    // invalid JSON); it calls writeIntegrationsFile directly to
    // exercise the byte-preservation contract.
    await mkdir(viberevertPath());
    const garbageBytes = Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x00, 0x82, 0xc0, 0xc1]);
    await writeFile(integrationsJsonPath(), garbageBytes);

    const backupGroupId = "garbage-group";
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId,
    });

    const backupBytes = await readFile(storeBackupPath(backupGroupId));
    expect(Buffer.compare(backupBytes, garbageBytes)).toBe(0);
  });
});

// ===========================================================================
// writeIntegrationsFile -- backup collision
// ===========================================================================

describe("writeIntegrationsFile -- backup collision", () => {
  it("throws BackupCollisionError with the exact collision path as .backupPath", async () => {
    // Pre-existing integrations.json so a backup will be attempted.
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), "pretend-existing");

    // Pre-create the EXACT backup path that writeIntegrationsFile is
    // about to write to. Use encodeBackupPath to derive the leaf --
    // do NOT hardcode the SHA prefix.
    const backupGroupId = "collision-group";
    const expectedBackupPath = storeBackupPath(backupGroupId);
    await mkdir(storeBackupGroupDir(backupGroupId), { recursive: true });
    await writeFile(expectedBackupPath, "stale backup contents");

    try {
      await writeIntegrationsFile({
        repoRoot: tempRepo.repoRoot,
        next: makeMinimalIntegrationsFile(),
        backupGroupId,
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BackupCollisionError);
      expect((err as BackupCollisionError).backupPath).toBe(expectedBackupPath);
    }
  });
});

// ===========================================================================
// writeIntegrationsFile -- schema validation prevents disk write
// ===========================================================================

describe("writeIntegrationsFile -- schema validation prevents disk write", () => {
  it("with no existing file: invalid `next` throws + integrations.json not created", async () => {
    // Cast at the call boundary only (amendment 2). Factory types stay
    // pure; the invalid value is constructed inline and cast just for
    // the call site.
    const badNext = {
      ...makeMinimalIntegrationsFile(),
      schemaVersion: 2,
    } as unknown as IntegrationsFile;

    await expect(
      writeIntegrationsFile({
        repoRoot: tempRepo.repoRoot,
        next: badNext,
        backupGroupId: "any-group",
      }),
    ).rejects.toThrow();

    // Schema fires BEFORE ensureSafeDir, so .viberevert/ is not
    // created either.
    await expect(stat(viberevertPath())).rejects.toThrow();
    await expect(stat(integrationsJsonPath())).rejects.toThrow();
  });

  it("with existing valid file: invalid `next` throws + existing bytes byte-for-byte unchanged + no new backup", async () => {
    // Establish a valid baseline on disk via the real writer.
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId: "first-group",
    });
    const originalBytes = await readFile(integrationsJsonPath());

    const badNext = {
      ...makeMinimalIntegrationsFile(),
      schemaVersion: 2,
    } as unknown as IntegrationsFile;

    await expect(
      writeIntegrationsFile({
        repoRoot: tempRepo.repoRoot,
        next: badNext,
        backupGroupId: "second-group",
      }),
    ).rejects.toThrow();

    // Bytes byte-for-byte unchanged via Buffer.compare (amendment 5).
    const currentBytes = await readFile(integrationsJsonPath());
    expect(Buffer.compare(currentBytes, originalBytes)).toBe(0);

    // No backup created under the second group dir -- schema failure
    // happens before any backup work.
    await expect(stat(storeBackupGroupDir("second-group"))).rejects.toThrow();
  });
});

// ===========================================================================
// writeIntegrationsFile -- backupGroupId rejection corpus
// ===========================================================================

describe("writeIntegrationsFile -- backupGroupId rejection corpus", () => {
  // Per amendment 1: BackupGroupIdSchema is NOT exported. The public
  // refusal contract is "invalid backupGroupId throws before any disk
  // write". For each rejected entry: throws + integrations.json is
  // not created. The corpus mirrors the source's validation rules:
  // length bounds, control chars, path separators, leading ~, "."/"..",
  // Windows reserved device names (with/without extension), trailing
  // dot/space.

  const REJECTED_GROUP_IDS: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }> = [
    { label: "empty string", value: "" },
    { label: "over 256 chars (257)", value: "a".repeat(257) },
    { label: "contains control char (\\x01)", value: "abc\x01def" },
    { label: "contains forward slash", value: "abc/def" },
    { label: "contains backslash", value: "abc\\def" },
    { label: "contains colon", value: "abc:def" },
    { label: "starts with tilde", value: "~abc" },
    { label: "exactly '.'", value: "." },
    { label: "exactly '..'", value: ".." },
    { label: "Windows reserved CON", value: "CON" },
    { label: "Windows reserved PRN", value: "PRN" },
    { label: "Windows reserved NUL", value: "NUL" },
    { label: "Windows reserved COM5", value: "COM5" },
    { label: "Windows reserved LPT9", value: "LPT9" },
    { label: "Windows reserved with extension CON.txt", value: "CON.txt" },
    { label: "Windows reserved with extension lpt1.bak (case-insensitive)", value: "lpt1.bak" },
    { label: "trailing dot", value: "foo." },
    { label: "trailing space", value: "foo " },
  ];

  it.each(REJECTED_GROUP_IDS)("rejects backupGroupId: $label", async ({ value }) => {
    await expect(
      writeIntegrationsFile({
        repoRoot: tempRepo.repoRoot,
        next: makeMinimalIntegrationsFile(),
        backupGroupId: value,
      }),
    ).rejects.toThrow();
    await expect(stat(integrationsJsonPath())).rejects.toThrow();
  });

  it("rejected backupGroupId with existing file: bytes byte-for-byte unchanged + no backup dir created for that group", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeMinimalIntegrationsFile(),
      backupGroupId: "valid-first-group",
    });
    const originalBytes = await readFile(integrationsJsonPath());

    await expect(
      writeIntegrationsFile({
        repoRoot: tempRepo.repoRoot,
        next: makeMinimalIntegrationsFile(),
        backupGroupId: "..",
      }),
    ).rejects.toThrow();

    // Bytes byte-for-byte unchanged.
    const currentBytes = await readFile(integrationsJsonPath());
    expect(Buffer.compare(currentBytes, originalBytes)).toBe(0);

    // Per amendment 5: invalid backupGroupId is refused BEFORE any
    // backup-path creation. Asserting the rejected group's dir does
    // NOT exist proves the refusal happens at the validation step,
    // not after partial mkdir work.
    await expect(stat(storeBackupGroupDir(".."))).rejects.toThrow();
  });
});

describe("writeIntegrationsFile -- backupGroupId accepted boundaries", () => {
  it("accepts single character 'a' (min length 1 boundary)", async () => {
    await expect(
      writeIntegrationsFile({
        repoRoot: tempRepo.repoRoot,
        next: makeMinimalIntegrationsFile(),
        backupGroupId: "a",
      }),
    ).resolves.toBeUndefined();
    const st = await stat(integrationsJsonPath());
    expect(st.isFile()).toBe(true);
  });
  it("accepts realistic timestamp-uuid slug", async () => {
    await expect(
      writeIntegrationsFile({
        repoRoot: tempRepo.repoRoot,
        next: makeMinimalIntegrationsFile(),
        backupGroupId: "20260627T120000Z--550e8400-e29b-41d4-a716-446655440000",
      }),
    ).resolves.toBeUndefined();
  });
});
