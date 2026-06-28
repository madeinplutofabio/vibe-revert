// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PendingIntegrationRecoveryError, SymlinkTargetRefusal } from "../src/errors.js";
import type { IntegrationFileEditRecord, PathSpec } from "../src/integrations-schema.js";
import {
  deleteJournal,
  type JournalEntry,
  type JournalMutation,
  scanForPendingJournals,
  updateJournal,
  writeJournal,
} from "../src/journal.js";

import { createDirectorySymlink, createTempRepo, SYMLINKS_SUPPORTED } from "./helpers/temp-repo.js";

let tempRepo: Awaited<ReturnType<typeof createTempRepo>>;

beforeEach(async () => {
  tempRepo = await createTempRepo();
});

afterEach(async () => {
  await tempRepo.cleanup();
});

/**
 * Build a minimal valid JournalEntry. Caller can override specific
 * fields; identity defaults satisfy all schema validation (txnId is
 * a fresh UUID, plannedOps has one write-new entry with a valid
 * PathSpec, etc.).
 */
function minimalJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    txnId: randomUUID(),
    recordKey: "cursor",
    adapterName: "cursor-test",
    startedAt: new Date().toISOString(),
    command: "install",
    cliVersion: "0.0.0-test",
    phase: "writing-files",
    plannedOps: [
      {
        kind: "write-new",
        target: {
          scope: "repo",
          pathTemplate: "{repo}/.cursor/mcp.json",
          pathRelative: ".cursor/mcp.json",
        },
      },
    ],
    recordedOps: [],
    backupPaths: [],
    ...overrides,
  };
}

describe("writeJournal", () => {
  it("creates the journal file with the full entry", async () => {
    const entry = minimalJournalEntry();
    const path = await writeJournal(tempRepo.repoRoot, entry);
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as { txnId: unknown; recordKey: unknown; phase: unknown };
    expect(parsed.txnId).toBe(entry.txnId);
    expect(parsed.recordKey).toBe(entry.recordKey);
    expect(parsed.phase).toBe("writing-files");
  });
  it("returns the absolute path of the written journal file", async () => {
    const entry = minimalJournalEntry();
    const path = await writeJournal(tempRepo.repoRoot, entry);
    expect(path).toBe(
      join(tempRepo.repoRoot, ".viberevert", "integration-journal", `${entry.txnId}.json`),
    );
  });
  it("throws PendingIntegrationRecoveryError on second write with same txnId (wx flag)", async () => {
    const entry = minimalJournalEntry();
    await writeJournal(tempRepo.repoRoot, entry);
    await expect(writeJournal(tempRepo.repoRoot, entry)).rejects.toThrow(
      PendingIntegrationRecoveryError,
    );
  });
  it("rejects non-UUID txnId via Zod validation", async () => {
    const entry = minimalJournalEntry({ txnId: "not-a-uuid" });
    await expect(writeJournal(tempRepo.repoRoot, entry)).rejects.toThrow();
  });
});

describe("updateJournal", () => {
  it("merges phase + recordedOps + backupPaths, preserving identity fields", async () => {
    const entry = minimalJournalEntry();
    await writeJournal(tempRepo.repoRoot, entry);

    // Construct a valid IntegrationFileEditRecord for write-new
    // (per per-kind discipline: backup=null, fullFileSha256AfterWrite
    // non-null hex, all other SHA fields null, blockId=null,
    // jsonKeyPath=null, mode=null).
    const recordedOp: IntegrationFileEditRecord = {
      kind: "write-new",
      target: {
        scope: "repo",
        pathTemplate: "{repo}/.cursor/mcp.json",
        pathRelative: ".cursor/mcp.json",
      },
      backup: null,
      managedBlockSha256: null,
      managedValueSha256: null,
      fullFileSha256AfterWrite: "a".repeat(64),
      blockId: null,
      jsonKeyPath: null,
      mode: null,
    };
    // backupPaths is PathSpec[] per schema -- NOT string[]. Construct
    // a full PathSpec for the test.
    const backupPathSpec: PathSpec = {
      scope: "repo",
      pathTemplate: "{repo}/.viberevert/integration-backups/cursor/group/file",
      pathRelative: ".viberevert/integration-backups/cursor/group/file",
    };

    await updateJournal(tempRepo.repoRoot, entry.txnId, {
      phase: "updating-integrations",
      recordedOps: [recordedOp],
      backupPaths: [backupPathSpec],
    });

    const pending = await scanForPendingJournals(tempRepo.repoRoot);
    expect(pending.length).toBe(1);
    const updated = pending[0];
    expect(updated).toBeDefined();
    if (updated === undefined) throw new Error("unreachable: length check above");

    // Mutation fields updated.
    expect(updated.entry.phase).toBe("updating-integrations");
    expect(updated.entry.recordedOps).toEqual([recordedOp]);
    expect(updated.entry.backupPaths).toEqual([backupPathSpec]);

    // Identity fields preserved verbatim.
    expect(updated.entry.txnId).toBe(entry.txnId);
    expect(updated.entry.recordKey).toBe(entry.recordKey);
    expect(updated.entry.adapterName).toBe(entry.adapterName);
    expect(updated.entry.command).toBe(entry.command);
    expect(updated.entry.cliVersion).toBe(entry.cliVersion);
    expect(updated.entry.startedAt).toBe(entry.startedAt);
    expect(updated.entry.plannedOps.length).toBe(1);
  });
  it("rejects identity fields in mutation (Zod .strict())", async () => {
    const entry = minimalJournalEntry();
    await writeJournal(tempRepo.repoRoot, entry);
    // Bypass TypeScript's check on JournalMutation shape to verify
    // the runtime Zod .strict() rejection. The schema permits only
    // phase/recordedOps/backupPaths; identity fields are smuggling.
    await expect(
      updateJournal(tempRepo.repoRoot, entry.txnId, {
        txnId: randomUUID(),
      } as unknown as JournalMutation),
    ).rejects.toThrow();
  });
});

describe("deleteJournal", () => {
  it("removes the journal file", async () => {
    const entry = minimalJournalEntry();
    const path = await writeJournal(tempRepo.repoRoot, entry);
    await deleteJournal(tempRepo.repoRoot, entry.txnId);
    await expect(stat(path)).rejects.toThrow();
  });
});

describe("scanForPendingJournals", () => {
  it("returns empty array when .viberevert/ does not exist", async () => {
    const result = await scanForPendingJournals(tempRepo.repoRoot);
    expect(result).toEqual([]);
  });
  it("returns empty array when .viberevert/ exists but journal dir does not", async () => {
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    const result = await scanForPendingJournals(tempRepo.repoRoot);
    expect(result).toEqual([]);
  });
  it("returns sorted PendingJournal[] for UUID-named files (deterministic ordering)", async () => {
    const entries = [minimalJournalEntry(), minimalJournalEntry(), minimalJournalEntry()];
    for (const entry of entries) {
      await writeJournal(tempRepo.repoRoot, entry);
    }
    const result = await scanForPendingJournals(tempRepo.repoRoot);
    expect(result.length).toBe(3);
    const filenames = result.map((p) => p.filename);
    expect([...filenames].sort()).toEqual(filenames);
  });
  it("ignores non-UUID-named files in the journal dir", async () => {
    // Locked behavior: non-UUID filenames are ignored entirely.
    // UUID-named filenames with bad content block (next two tests).
    const entry = minimalJournalEntry();
    await writeJournal(tempRepo.repoRoot, entry);
    const journalDir = join(tempRepo.repoRoot, ".viberevert", "integration-journal");
    await writeFile(join(journalDir, "notes.json"), "irrelevant");
    await writeFile(join(journalDir, "editor.swp"), "irrelevant");
    await writeFile(join(journalDir, "README.md"), "irrelevant");
    const result = await scanForPendingJournals(tempRepo.repoRoot);
    expect(result.length).toBe(1);
    expect(result[0]?.entry.txnId).toBe(entry.txnId);
  });
  it("throws on UUID-named file with invalid JSON syntax", async () => {
    // The exact thrown type is JSON.parse's SyntaxError, but the
    // assertion uses bare toThrow() to stay decoupled from
    // implementation specifics (Zod vs native SyntaxError).
    const journalDir = join(tempRepo.repoRoot, ".viberevert", "integration-journal");
    await mkdir(journalDir, { recursive: true });
    const fakeTxnId = randomUUID();
    await writeFile(join(journalDir, `${fakeTxnId}.json`), "not valid json {");
    await expect(scanForPendingJournals(tempRepo.repoRoot)).rejects.toThrow();
  });
  it("throws on UUID-named file with valid JSON but invalid journal shape", async () => {
    // Zod schema validation rejects a structurally-wrong journal
    // entry. Bare toThrow() avoids coupling to the specific ZodError
    // class import.
    const journalDir = join(tempRepo.repoRoot, ".viberevert", "integration-journal");
    await mkdir(journalDir, { recursive: true });
    const fakeTxnId = randomUUID();
    await writeFile(join(journalDir, `${fakeTxnId}.json`), '{"not": "a valid journal entry"}');
    await expect(scanForPendingJournals(tempRepo.repoRoot)).rejects.toThrow();
  });
});

describe.skipIf(!SYMLINKS_SUPPORTED)("journal -- symlink refusals", () => {
  it("scanForPendingJournals refuses symlinked .viberevert/ dir", async () => {
    const elsewhere = join(tempRepo.repoRoot, "elsewhere");
    await mkdir(elsewhere);
    await createDirectorySymlink(elsewhere, join(tempRepo.repoRoot, ".viberevert"));
    try {
      await scanForPendingJournals(tempRepo.repoRoot);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SymlinkTargetRefusal);
      expect((err as SymlinkTargetRefusal).symlinkedComponentPath).toBe(
        join(tempRepo.repoRoot, ".viberevert"),
      );
    }
  });
  it("scanForPendingJournals refuses symlinked journal dir", async () => {
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    const elsewhere = join(tempRepo.repoRoot, "elsewhere-journal");
    await mkdir(elsewhere);
    const journalDir = join(tempRepo.repoRoot, ".viberevert", "integration-journal");
    await createDirectorySymlink(elsewhere, journalDir);
    try {
      await scanForPendingJournals(tempRepo.repoRoot);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SymlinkTargetRefusal);
      expect((err as SymlinkTargetRefusal).symlinkedComponentPath).toBe(journalDir);
    }
  });
  it("scanForPendingJournals refuses symlinked UUID-named journal file", async () => {
    // The journal module is supposed to lstat-guard journal FILES
    // too, not just the parent dirs. Create a real journal file
    // outside the journal dir, then symlink to it from a
    // UUID-named entry inside the journal dir. scanForPendingJournals
    // should refuse before reading the link.
    const journalDir = join(tempRepo.repoRoot, ".viberevert", "integration-journal");
    await mkdir(journalDir, { recursive: true });

    const realFile = join(tempRepo.repoRoot, "real-journal.json");
    await writeFile(realFile, JSON.stringify(minimalJournalEntry()));

    const symlinkedJournalPath = join(journalDir, `${randomUUID()}.json`);
    // File-mode symlink (third arg "file" for Windows compatibility;
    // ignored on POSIX). Called directly here rather than via
    // createDirectorySymlink helper since this is a one-off file
    // symlink in the suite.
    await symlink(realFile, symlinkedJournalPath, "file");

    try {
      await scanForPendingJournals(tempRepo.repoRoot);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SymlinkTargetRefusal);
      expect((err as SymlinkTargetRefusal).symlinkedComponentPath).toBe(symlinkedJournalPath);
    }
  });
});
