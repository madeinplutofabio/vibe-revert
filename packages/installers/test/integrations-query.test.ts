// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RecordKey } from "../src/engine-types.js";
import { IntegrationsCorruptedError, IntegrationsSchemaVersionError } from "../src/errors.js";
import { hasRepoIntegrationRecord } from "../src/integrations-query.js";
import type { IntegrationRecord, IntegrationsFile } from "../src/integrations-schema.js";
import { writeIntegrationsFile } from "../src/integrations-store.js";

import { createTempRepo } from "./helpers/temp-repo.js";

const SHA_A = "a".repeat(64);

let tempRepo: Awaited<ReturnType<typeof createTempRepo>>;

beforeEach(async () => {
  tempRepo = await createTempRepo();
});

afterEach(async () => {
  await tempRepo.cleanup();
});

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

function makeIntegrationsFileWith(records: IntegrationsFile["records"]): IntegrationsFile {
  return {
    schemaVersion: 1,
    createdByVersion: "0.7.1-beta.0",
    updatedByVersion: "0.7.1-beta.0",
    records,
    history: [],
  };
}

describe("hasRepoIntegrationRecord -- absence returns false", () => {
  it("returns false when .viberevert/ does not exist", async () => {
    expect(await hasRepoIntegrationRecord(tempRepo.repoRoot, "cursor")).toBe(false);
  });
  it("returns false when .viberevert/ exists but integrations.json does not", async () => {
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    expect(await hasRepoIntegrationRecord(tempRepo.repoRoot, "cursor")).toBe(false);
  });
});

describe("hasRepoIntegrationRecord -- present/absent record", () => {
  // Valid-case fixtures go through writeIntegrationsFile (amendment 5)
  // so this test exercises the real serialization-read round trip
  // rather than duplicating it via hand-written JSON.

  it("returns true for a recordKey present in a valid store", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFileWith({ cursor: makeMinimalRecord("cursor") }),
      backupGroupId: "init",
    });
    expect(await hasRepoIntegrationRecord(tempRepo.repoRoot, "cursor")).toBe(true);
  });

  it("returns false for a recordKey absent from a valid store", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFileWith({ cursor: makeMinimalRecord("cursor") }),
      backupGroupId: "init",
    });
    expect(await hasRepoIntegrationRecord(tempRepo.repoRoot, "claude")).toBe(false);
  });

  it("returns true and false correctly across multi-record store", async () => {
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFileWith({
        cursor: makeMinimalRecord("cursor"),
        claude: makeMinimalRecord("claude"),
      }),
      backupGroupId: "init",
    });
    expect(await hasRepoIntegrationRecord(tempRepo.repoRoot, "cursor")).toBe(true);
    expect(await hasRepoIntegrationRecord(tempRepo.repoRoot, "claude")).toBe(true);
    expect(await hasRepoIntegrationRecord(tempRepo.repoRoot, "husky")).toBe(false);
  });
});

describe("hasRepoIntegrationRecord -- error propagation", () => {
  // Per amendment 12: corrupted / wrong-version stores are hand-written
  // (intentionally invalid). hasRepoIntegrationRecord must NOT collapse
  // these into a `false` -- it must surface the typed error so the CLI
  // guard can distinguish "no record" from "your store is broken or
  // unsafe".

  it("propagates IntegrationsCorruptedError from invalid JSON", async () => {
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    await writeFile(
      join(tempRepo.repoRoot, ".viberevert", "integrations.json"),
      "not valid json {",
    );
    await expect(hasRepoIntegrationRecord(tempRepo.repoRoot, "cursor")).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });

  it("propagates IntegrationsCorruptedError from valid-v1 file with bad shape", async () => {
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    await writeFile(
      join(tempRepo.repoRoot, ".viberevert", "integrations.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdByVersion: "0.0.0-test",
        updatedByVersion: "0.0.0-test",
        records: { cursor: "not-a-record" },
        history: [],
      }),
    );
    await expect(hasRepoIntegrationRecord(tempRepo.repoRoot, "cursor")).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });

  it("propagates IntegrationsSchemaVersionError from wrong schemaVersion", async () => {
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    await writeFile(
      join(tempRepo.repoRoot, ".viberevert", "integrations.json"),
      JSON.stringify({ schemaVersion: 2 }),
    );
    await expect(hasRepoIntegrationRecord(tempRepo.repoRoot, "cursor")).rejects.toBeInstanceOf(
      IntegrationsSchemaVersionError,
    );
  });
});
