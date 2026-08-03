// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// H11.5 acceptance -- json-key-merge uninstall restoration.
//
// A json-key-merge adapter (Cursor, Claude) that CREATES its config file
// from absence now restores that absence on uninstall: apply records the
// targetWasAbsentBeforeApply marker, and reverse-json-key-merge unlinks the
// file when removing the managed key leaves the same canonical content as
// the empty-ancestor scaffold. A merge into a pre-existing file, a file with
// user content added after install (including a user-added EMPTY object),
// and a legacy record without the marker are all preserved via write-back.
//
// Grew from the H11.5 RED reproduction (json-key-merge-restoration-red).
// Evidence:
// vr-dogfood/evidence/findings/finding-uninstall-restoration-gap.md.
//
// Receipt semantics pinned to the exact target path: create-case restoration
// reports it under receipt.filesRemoved; preservation under filesRestored.
//
// Scope: FILE restoration only. The created parent directory (e.g. .cursor/)
// is the rollback-empty-dirs concern (H11.6) and is not asserted here.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AdapterContext } from "@viberevert/adapters";
import { claudeAdapter, cursorAdapter } from "@viberevert/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { apply } from "../src/engine-apply.js";
import type { UninstallContext } from "../src/engine-types.js";
import { uninstall } from "../src/engine-uninstall.js";
import { readIntegrationsFile } from "../src/integrations-store.js";

import { createTempRepo } from "./helpers/temp-repo.js";

const CLI_VERSION = "0.7.1-beta.0-smoke";
const FIXED_NOW = new Date("2026-06-29T12:00:00.000Z");

const CURSOR_TARGET_REL = ".cursor/mcp.json";

// Both adapters install via the shared json-key-merge op at
// mcpServers.viberevert; only the record key and target path differ.
const CREATE_CASE_ADAPTERS: ReadonlyArray<{
  readonly name: string;
  readonly adapter: typeof cursorAdapter;
  readonly recordKey: "cursor" | "claude";
  readonly targetRel: string;
}> = [
  { name: "cursor", adapter: cursorAdapter, recordKey: "cursor", targetRel: CURSOR_TARGET_REL },
  { name: "claude", adapter: claudeAdapter, recordKey: "claude", targetRel: ".mcp.json" },
];

// Declared-key test type: dot access on declared properties is valid under
// noPropertyAccessFromIndexSignature (avoids TS4111) and keeps biome's
// useLiteralKeys happy. mcpServers is an object we index by user key;
// userConfig is a user-added sibling.
type MutableMcpFile = { mcpServers: Record<string, unknown>; userConfig?: unknown };

let repoRoot: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const tmp = await createTempRepo();
  repoRoot = tmp.repoRoot;
  cleanup = tmp.cleanup;
});

afterEach(async () => {
  await cleanup();
});

function adapterCtx(): AdapterContext {
  return {
    repoRoot,
    now: FIXED_NOW,
    cliVersion: CLI_VERSION,
    intent: "explicit",
    options: { forceReinstall: false, migrateFromHookInstall: false, forceUninstall: false },
  };
}

function uninstallCtx(): UninstallContext {
  return {
    repoRoot,
    now: FIXED_NOW,
    cliVersion: CLI_VERSION,
    options: { forceUninstall: false },
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function readParsed(rel: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(join(repoRoot, rel), "utf8"));
  return parsed;
}

function requireFirstOp(
  integrations: Awaited<ReturnType<typeof readIntegrationsFile>>,
  recordKey: "cursor" | "claude",
) {
  if (integrations === null) {
    throw new Error("integrations.json missing");
  }
  const record = integrations.records[recordKey];
  if (record === undefined) {
    throw new Error(`${recordKey} record missing`);
  }
  const op = record.ops[0];
  if (op === undefined) {
    throw new Error(`${recordKey} record has no ops`);
  }
  return op;
}

describe("json-key-merge restoration (H11.5)", () => {
  for (const config of CREATE_CASE_ADAPTERS) {
    it(`create-from-absence (${config.name}): uninstall unlinks the file and reports filesRemoved`, async () => {
      const targetAbs = join(repoRoot, config.targetRel);
      expect(await fileExists(targetAbs)).toBe(false);

      // Pin the shared planned mechanism for this adapter.
      const ctx = adapterCtx();
      const plan = await config.adapter.plan(ctx);
      if (plan.status !== "applicable") {
        throw new Error(`expected ${config.name} plan to be applicable`);
      }
      expect(plan.ops).toHaveLength(1);
      const plannedOp = plan.ops[0];
      if (plannedOp === undefined) {
        throw new Error(`expected ${config.name} config operation`);
      }
      expect(plannedOp.kind).toBe("json-key-merge");
      if (plannedOp.kind !== "json-key-merge") {
        throw new Error(`expected ${config.name} json-key-merge operation`);
      }
      expect(plannedOp.target.pathRelative).toBe(config.targetRel);
      expect(plannedOp.keyPath).toEqual(["mcpServers", "viberevert"]);

      const applied = await apply(plan, ctx);
      expect(applied.status).toBe("applied");
      if (applied.status !== "applied") {
        throw new Error(`expected ${config.name} install to be applied`);
      }
      expect(await fileExists(targetAbs)).toBe(true);

      // The record proves the file was created from absence.
      const recordOp = requireFirstOp(await readIntegrationsFile(repoRoot), config.recordKey);
      expect(recordOp.kind).toBe("json-key-merge");
      expect(recordOp.targetWasAbsentBeforeApply).toBe(true);

      // Uninstall restores absence by unlinking; the receipt reports the
      // exact target under filesRemoved, not filesRestored.
      const removed = await uninstall(config.recordKey, uninstallCtx());
      expect(removed.status).toBe("uninstalled");
      if (removed.status !== "uninstalled") {
        throw new Error(`expected ${config.name} uninstall to succeed`);
      }
      expect(removed.receipt.filesRemoved).toEqual([targetAbs]);
      expect(removed.receipt.filesRestored).toEqual([]);
      expect(await fileExists(targetAbs)).toBe(false);
    });
  }

  it("preserve pre-existing: a merge into a user file is written back (no marker, filesRestored)", async () => {
    const targetAbs = join(repoRoot, CURSOR_TARGET_REL);
    await mkdir(join(repoRoot, ".cursor"));
    await writeFile(
      targetAbs,
      `${JSON.stringify({ mcpServers: { "other-server": { command: "x" } } }, null, 2)}\n`,
      "utf8",
    );

    const ctx = adapterCtx();
    const applied = await apply(await cursorAdapter.plan(ctx), ctx);
    expect(applied.status).toBe("applied");

    // The target pre-existed, so the record carries NO creation marker.
    const recordOp = requireFirstOp(await readIntegrationsFile(repoRoot), "cursor");
    expect(recordOp.targetWasAbsentBeforeApply).toBeUndefined();

    const removed = await uninstall("cursor", uninstallCtx());
    expect(removed.status).toBe("uninstalled");
    if (removed.status !== "uninstalled") {
      throw new Error("expected uninstall to succeed");
    }
    expect(removed.receipt.filesRestored).toEqual([targetAbs]);
    expect(removed.receipt.filesRemoved).toEqual([]);

    // The user's server survives; only the managed key is removed.
    expect(await fileExists(targetAbs)).toBe(true);
    expect(await readParsed(CURSOR_TARGET_REL)).toEqual({
      mcpServers: { "other-server": { command: "x" } },
    });
  });

  it("preserve user addition: content added after install is written back (marker set, scaffold mismatch)", async () => {
    const targetAbs = join(repoRoot, CURSOR_TARGET_REL);
    const ctx = adapterCtx();
    const applied = await apply(await cursorAdapter.plan(ctx), ctx);
    expect(applied.status).toBe("applied");

    const recordOp = requireFirstOp(await readIntegrationsFile(repoRoot), "cursor");
    expect(recordOp.targetWasAbsentBeforeApply).toBe(true);

    // The user adds their own server, leaving the managed viberevert value
    // untouched (no drift), so a plain uninstall applies.
    const installed = JSON.parse(await readFile(targetAbs, "utf8")) as MutableMcpFile;
    installed.mcpServers["user-server"] = { command: "y" };
    await writeFile(targetAbs, `${JSON.stringify(installed, null, 2)}\n`, "utf8");

    const removed = await uninstall("cursor", uninstallCtx());
    expect(removed.status).toBe("uninstalled");
    if (removed.status !== "uninstalled") {
      throw new Error("expected uninstall to succeed");
    }
    // Post-delete document differs from the empty scaffold -> preserved.
    expect(removed.receipt.filesRestored).toEqual([targetAbs]);
    expect(removed.receipt.filesRemoved).toEqual([]);
    expect(await fileExists(targetAbs)).toBe(true);
    expect(await readParsed(CURSOR_TARGET_REL)).toEqual({
      mcpServers: { "user-server": { command: "y" } },
    });
  });

  it("preserve user-added empty object: an empty sibling still prevents unlink (exact scaffold, not prune-to-empty)", async () => {
    const targetAbs = join(repoRoot, CURSOR_TARGET_REL);
    const ctx = adapterCtx();
    const applied = await apply(await cursorAdapter.plan(ctx), ctx);
    expect(applied.status).toBe("applied");

    // Establish create-from-absence: the marker must be true so this test
    // exercises the scaffold-comparison branch (not preservation-by-missing-
    // marker).
    const recordOp = requireFirstOp(await readIntegrationsFile(repoRoot), "cursor");
    expect(recordOp.kind).toBe("json-key-merge");
    expect(recordOp.targetWasAbsentBeforeApply).toBe(true);

    // The user adds an EMPTY top-level object alongside viberevert (managed
    // value untouched, so no drift). If uninstall recursively pruned empty
    // objects it would wrongly unlink; exact-scaffold comparison preserves.
    const installed = JSON.parse(await readFile(targetAbs, "utf8")) as MutableMcpFile;
    installed.userConfig = {};
    await writeFile(targetAbs, `${JSON.stringify(installed, null, 2)}\n`, "utf8");

    const removed = await uninstall("cursor", uninstallCtx());
    expect(removed.status).toBe("uninstalled");
    if (removed.status !== "uninstalled") {
      throw new Error("expected uninstall to succeed");
    }
    expect(removed.receipt.filesRestored).toEqual([targetAbs]);
    expect(removed.receipt.filesRemoved).toEqual([]);
    expect(await fileExists(targetAbs)).toBe(true);
    expect(await readParsed(CURSOR_TARGET_REL)).toEqual({ mcpServers: {}, userConfig: {} });
  });

  it("legacy record without the marker is never unlinked (conservative write-back)", async () => {
    const targetAbs = join(repoRoot, CURSOR_TARGET_REL);
    const ctx = adapterCtx();
    const applied = await apply(await cursorAdapter.plan(ctx), ctx);
    expect(applied.status).toBe("applied");

    // Simulate a pre-H11.5 record by stripping the marker from the store
    // (JSON.stringify omits a property set to undefined).
    const integrationsPath = join(repoRoot, ".viberevert", "integrations.json");
    const stored = JSON.parse(await readFile(integrationsPath, "utf8")) as {
      records: { cursor: { ops: Array<{ targetWasAbsentBeforeApply?: unknown }> } };
    };
    const legacyOp = stored.records.cursor.ops[0];
    if (legacyOp !== undefined) {
      legacyOp.targetWasAbsentBeforeApply = undefined;
    }
    await writeFile(integrationsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const recordOp = requireFirstOp(await readIntegrationsFile(repoRoot), "cursor");
    expect(recordOp.targetWasAbsentBeforeApply).toBeUndefined();

    const removed = await uninstall("cursor", uninstallCtx());
    expect(removed.status).toBe("uninstalled");
    if (removed.status !== "uninstalled") {
      throw new Error("expected uninstall to succeed");
    }
    // Conservative: no marker means no unlink; the empty scaffold is written
    // back rather than removed.
    expect(removed.receipt.filesRestored).toEqual([targetAbs]);
    expect(removed.receipt.filesRemoved).toEqual([]);
    expect(await fileExists(targetAbs)).toBe(true);
    expect(await readParsed(CURSOR_TARGET_REL)).toEqual({ mcpServers: {} });
  });
});
