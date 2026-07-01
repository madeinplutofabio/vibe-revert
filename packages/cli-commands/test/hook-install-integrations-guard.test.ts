// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for hook-install-integrations-guard.ts.
 *
 * Coverage map (10 tests):
 *   A. Silent-return cases (4): no .viberevert/, no integrations.json,
 *      empty records, cursor-only record.
 *   B. Throw cases (3):
 *      - throws with correct class + name + repoRoot field + message
 *        content (semantic assertions on 2 recovery commands +
 *        docs/hook-contract.md; NOT exact-match on full message)
 *      - direct-hook record wins even if adapterName is misleading
 *        (durable key is what matters, not display name)
 *      - direct-hook record with a realistic history entry still throws
 *        (validates the guard against a "normal" store state, not just
 *        the minimal empty-history fixture)
 *   C. Error propagation by class (2): corrupt JSON propagates
 *      IntegrationsCorruptedError; wrong schemaVersion propagates
 *      IntegrationsSchemaVersionError. Assertions use toBeInstanceOf
 *      only -- installer error wording is installers' contract.
 *   D. Read-only invariant (1): guard is idempotent on both no-conflict
 *      and conflict paths -- repo tree snapshot before and after is
 *      unchanged whether the guard threw or returned. The snapshot
 *      captures path tree only (not file bytes); the guard has no write
 *      path, so tree-identity is sufficient for this slice.
 *
 * Uses REAL fixtures (no mocks). The tests write real
 * .viberevert/integrations.json files and let hasRepoIntegrationRecord
 * exercise the actual installer store-read code path.
 *
 * Fixtures are explicitly typed against the schema-derived types
 * exported from @viberevert/installers (IntegrationRecord,
 * IntegrationFileEditRecord, IntegrationsFile). This catches fixture
 * drift at typecheck instead of runtime -- if the schema changes,
 * TypeScript surfaces the mismatch before the fixture is ever
 * serialized to JSON.
 *
 * D101.M.5 note: the guard MODULE imports only `hasRepoIntegrationRecord`
 * from installers. This TEST file imports additional error classes +
 * types for assertions -- that's OK because D101.M.5 applies to the
 * production surface, not to tests.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type IntegrationFileEditRecord,
  type IntegrationRecord,
  IntegrationsCorruptedError,
  type IntegrationsFile,
  IntegrationsSchemaVersionError,
} from "@viberevert/installers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNoIntegrationsHookConflict,
  IntegrationsRecordsHookConflictError,
} from "../src/commands/hook-install-integrations-guard.js";

const CLI_VERSION = "0.7.1-beta.0-test";
const FIXED_TIMESTAMP = "2026-07-01T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixture data -- explicitly typed against schema-derived types so any
// fixture drift surfaces at typecheck.
// ---------------------------------------------------------------------------

const DIRECT_HOOK_WRITE_NEW_OP: IntegrationFileEditRecord = {
  kind: "write-new",
  target: {
    scope: "repo",
    pathTemplate: "{repo}/.git/hooks/pre-commit",
    pathRelative: ".git/hooks/pre-commit",
  },
  backup: null,
  managedBlockSha256: null,
  managedValueSha256: null,
  fullFileSha256AfterWrite: "a".repeat(64),
  blockId: null,
  jsonKeyPath: null,
  mode: 493, // 0o755
};

const DIRECT_HOOK_RECORD: IntegrationRecord = {
  recordKey: "direct-hook",
  adapterName: "Direct hook",
  installedAt: FIXED_TIMESTAMP,
  installedByVersion: CLI_VERSION,
  ops: [DIRECT_HOOK_WRITE_NEW_OP],
  meta: {},
};

// Same recordKey ("direct-hook" -- the durable key) but a misleading
// adapterName. The guard MUST key off recordKey, not adapterName.
const DIRECT_HOOK_RECORD_WITH_MISLEADING_NAME: IntegrationRecord = {
  ...DIRECT_HOOK_RECORD,
  adapterName: "Cursor",
};

const CURSOR_JSON_KEY_MERGE_OP: IntegrationFileEditRecord = {
  kind: "json-key-merge",
  target: {
    scope: "repo",
    pathTemplate: "{repo}/.cursor/mcp.json",
    pathRelative: ".cursor/mcp.json",
  },
  backup: null,
  managedBlockSha256: null,
  managedValueSha256: "b".repeat(64),
  fullFileSha256AfterWrite: null,
  blockId: null,
  jsonKeyPath: ["mcpServers", "viberevert"],
  mode: null,
};

const CURSOR_RECORD: IntegrationRecord = {
  recordKey: "cursor",
  adapterName: "Cursor",
  installedAt: FIXED_TIMESTAMP,
  installedByVersion: CLI_VERSION,
  ops: [CURSOR_JSON_KEY_MERGE_OP],
  meta: {},
};

const DIRECT_HOOK_HISTORY_ENTRY: IntegrationsFile["history"][number] = {
  timestamp: FIXED_TIMESTAMP,
  action: "install",
  recordKey: "direct-hook",
  cliVersion: CLI_VERSION,
};

/**
 * Build a schema-valid IntegrationsFile JSON string. Typed against
 * IntegrationsFile so any drift in the durable schema is caught at
 * typecheck. Serialization uses 2-space pretty-print matching the
 * store's own writeIntegrationsFile output for readability.
 */
function buildValidIntegrationsFile(opts: {
  readonly records: IntegrationsFile["records"];
  readonly history?: IntegrationsFile["history"];
}): string {
  const file: IntegrationsFile = {
    schemaVersion: 1,
    createdByVersion: CLI_VERSION,
    updatedByVersion: CLI_VERSION,
    records: opts.records,
    history: opts.history ?? [],
  };
  return JSON.stringify(file, null, 2);
}

// ---------------------------------------------------------------------------
// Test lifecycle + helpers
// ---------------------------------------------------------------------------

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-guard-test-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

async function writeIntegrationsFile(content: string): Promise<void> {
  await mkdir(join(repoRoot, ".viberevert"), { recursive: true });
  await writeFile(join(repoRoot, ".viberevert", "integrations.json"), content, "utf8");
}

async function makeViberevertDirEmpty(): Promise<void> {
  await mkdir(join(repoRoot, ".viberevert"), { recursive: true });
}

/**
 * Snapshot the repo's full file tree (sorted) for read-only assertions.
 * Returns relative POSIX paths; directories suffix with "/". Path tree
 * only -- does NOT hash file bytes. Sufficient for the guard's read-
 * only invariant because the guard has no write code path; if it
 * mutated bytes without adding/removing paths, that would be a separate
 * bug the tree snapshot wouldn't catch, but the guard's source is a
 * single read-through function with no write surface at all.
 */
async function snapshotRepoTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = join(dir, entry.name);
      const childRel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(`${childRel}/`);
        await walk(childAbs, childRel);
      } else {
        out.push(childRel);
      }
    }
  }
  await walk(root, "");
  return out.sort();
}

// ===========================================================================
// A. Silent-return cases
// ===========================================================================

describe("assertNoIntegrationsHookConflict -- silent return", () => {
  it("returns silently when no .viberevert/ directory exists (clean repo)", async () => {
    await expect(assertNoIntegrationsHookConflict(repoRoot)).resolves.toBeUndefined();
  });

  it("returns silently when .viberevert/ exists but no integrations.json", async () => {
    await makeViberevertDirEmpty();
    await expect(assertNoIntegrationsHookConflict(repoRoot)).resolves.toBeUndefined();
  });

  it("returns silently when integrations.json has empty records", async () => {
    await writeIntegrationsFile(buildValidIntegrationsFile({ records: {} }));
    await expect(assertNoIntegrationsHookConflict(repoRoot)).resolves.toBeUndefined();
  });

  it("returns silently when integrations.json has cursor record but no direct-hook", async () => {
    await writeIntegrationsFile(buildValidIntegrationsFile({ records: { cursor: CURSOR_RECORD } }));
    await expect(assertNoIntegrationsHookConflict(repoRoot)).resolves.toBeUndefined();
  });
});

// ===========================================================================
// B. Throw cases
// ===========================================================================

describe("assertNoIntegrationsHookConflict -- throw on direct-hook record", () => {
  it("throws IntegrationsRecordsHookConflictError with correct class + name + repoRoot field + message content", async () => {
    await writeIntegrationsFile(
      buildValidIntegrationsFile({ records: { "direct-hook": DIRECT_HOOK_RECORD } }),
    );
    let caught: unknown;
    try {
      await assertNoIntegrationsHookConflict(repoRoot);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntegrationsRecordsHookConflictError);
    if (!(caught instanceof IntegrationsRecordsHookConflictError)) {
      throw new Error("expected IntegrationsRecordsHookConflictError to be thrown");
    }
    // Stable error name.
    expect(caught.name).toBe("IntegrationsRecordsHookConflictError");
    // Typed field carries repoRoot (path-light in message but exposed as field).
    expect(caught.repoRoot).toBe(repoRoot);
    // Semantic message assertions -- do NOT exact-match the full multi-
    // line message. Assert the two recovery commands + docs pointer only.
    expect(caught.message).toContain("viberevert uninstall --direct");
    expect(caught.message).toContain("viberevert install --husky --migrate-from-hook-install");
    expect(caught.message).toContain("docs/hook-contract.md");
  });

  it("throws even when the direct-hook record's adapterName is misleading (durable recordKey is what matters, not display name)", async () => {
    await writeIntegrationsFile(
      buildValidIntegrationsFile({
        records: { "direct-hook": DIRECT_HOOK_RECORD_WITH_MISLEADING_NAME },
      }),
    );
    await expect(assertNoIntegrationsHookConflict(repoRoot)).rejects.toBeInstanceOf(
      IntegrationsRecordsHookConflictError,
    );
  });

  it("throws for a direct-hook record with a realistic history entry (not just the minimal empty-history fixture)", async () => {
    await writeIntegrationsFile(
      buildValidIntegrationsFile({
        records: { "direct-hook": DIRECT_HOOK_RECORD },
        history: [DIRECT_HOOK_HISTORY_ENTRY],
      }),
    );
    await expect(assertNoIntegrationsHookConflict(repoRoot)).rejects.toBeInstanceOf(
      IntegrationsRecordsHookConflictError,
    );
  });
});

// ===========================================================================
// C. Error propagation by class
// ===========================================================================

describe("assertNoIntegrationsHookConflict -- error propagation", () => {
  it("propagates IntegrationsCorruptedError for invalid JSON (guard does NOT swallow installer errors)", async () => {
    await writeIntegrationsFile("{ this is not valid json }");
    await expect(assertNoIntegrationsHookConflict(repoRoot)).rejects.toBeInstanceOf(
      IntegrationsCorruptedError,
    );
  });

  it("propagates IntegrationsSchemaVersionError for wrong schemaVersion", async () => {
    // schemaVersion: 99 is object-shaped but not v1; readIntegrationsFile
    // maps this to IntegrationsSchemaVersionError (distinct from
    // Corrupted per the store's classification policy).
    const wrongVersion = JSON.stringify(
      {
        schemaVersion: 99,
        createdByVersion: CLI_VERSION,
        updatedByVersion: CLI_VERSION,
        records: {},
        history: [],
      },
      null,
      2,
    );
    await writeIntegrationsFile(wrongVersion);
    await expect(assertNoIntegrationsHookConflict(repoRoot)).rejects.toBeInstanceOf(
      IntegrationsSchemaVersionError,
    );
  });
});

// ===========================================================================
// D. Read-only invariant
// ===========================================================================

describe("assertNoIntegrationsHookConflict -- read-only invariant", () => {
  it("is idempotent + read-only on both no-conflict and conflict paths (repo tree before and after is unchanged)", async () => {
    // Phase 1: no-conflict path (cursor record only). Guard returns
    // silently and must not add or remove any tree entries.
    await writeIntegrationsFile(buildValidIntegrationsFile({ records: { cursor: CURSOR_RECORD } }));
    const beforeNoConflict = await snapshotRepoTree(repoRoot);
    await assertNoIntegrationsHookConflict(repoRoot);
    const afterNoConflict = await snapshotRepoTree(repoRoot);
    expect(afterNoConflict).toEqual(beforeNoConflict);

    // Phase 2: conflict path (direct-hook record). Guard throws;
    // catch the error and confirm the tree is still unchanged.
    await writeIntegrationsFile(
      buildValidIntegrationsFile({ records: { "direct-hook": DIRECT_HOOK_RECORD } }),
    );
    const beforeConflict = await snapshotRepoTree(repoRoot);
    try {
      await assertNoIntegrationsHookConflict(repoRoot);
    } catch {
      // Expected. Continue to tree comparison.
    }
    const afterConflict = await snapshotRepoTree(repoRoot);
    expect(afterConflict).toEqual(beforeConflict);
  });
});
