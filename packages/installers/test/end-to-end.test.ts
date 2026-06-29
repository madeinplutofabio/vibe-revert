// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// End-to-end smoke test for @viberevert/installers.
//
// Exercises the REAL cursor adapter (imported via the public
// @viberevert/adapters barrel; the installer vitest.config.ts alias
// resolves this to source) through the REAL engine.apply +
// engine.uninstall surface, validating adapter-to-engine integration
// end-to-end for M G1b Step 3.
//
// Two describe blocks reflect their different lifecycle needs:
//
//   1. Lifecycle (describe.sequential): ONE shared temp repo set up
//      in beforeAll; teardown in afterAll. Five tests run in declared
//      order, each depending on the prior test's on-disk state.
//      Covers: first install applied (+ user-content preservation via
//      a pre-existing other-server entry); second install noop;
//      user-drift refused; force-reinstall; uninstall round-trip.
//      .sequential is intentional: if a checkpoint fails, subsequent
//      ones provide diagnostic context but their failures are cascade
//      artifacts, not independent regressions. Snapshot variables are
//      typed `Buffer | undefined` and gated through requireBuffer so a
//      cascade emits a clear "snapshot was not captured" diagnostic
//      instead of a confusing Buffer.compare-on-undefined runtime
//      crash in the dependent scenario.
//
//   2. Adoption: per-test fresh temp repo (different initial
//      condition: .cursor/mcp.json pre-existing with mcpServers
//      .viberevert matching what plan would write; NO integrations
//      record). One test: adoption path classifies as would-adopt and
//      apply returns applied with opsApplied=0 +
//      ADOPTION_HUMAN_SUMMARY; target bytes unchanged; integrations
//      record + history entry with action "adopt".
//
// Adapter import path: import { cursorAdapter } from
// "@viberevert/adapters" -- proves the M G1b Step 3 root barrel
// re-export from ./adapters/index.js. (The installer package's
// vitest.config.ts alias resolves @viberevert/adapters to source
// for test runs.)
//
// One detect() call appears before the first apply (lifecycle
// scenario 1). Unit-level cursor detection coverage lives in
// packages/adapters/test/adapters/cursor.test.ts; this smoke
// asserts only that the public adapter surface participates in the
// engine flow, not the full detect() decision tree.
//
// json-key-merge has NO per-op target backup (the engine's backup
// machinery fires for backup-and-write only). Cursor's
// receipt.backupsCreated is therefore EMPTY for all six tests.
// Reverse path uses deleteAtKeyPath on the target itself, which the
// engine reports under filesRestored (engine-uninstall.ts REVERSE
// PER KIND table). Per amendment 3, semantic effects (key removed,
// other-server preserved, record removed, history "uninstall",
// target file still exists) are asserted FIRST; filesRestored is
// confirmed as a secondary check after the semantic guarantees.
//
// .cursor/mcp.json never carries a _viberevert_managed sidecar key:
// per D101.A the managed-value SHA lives only in our integrations
// record. Scenario 1 asserts this directly.
//
// Test-only narrowing types (CursorMcpConfig, CursorMcpServers)
// declare the known keys we touch on the parsed JSON; declared
// properties on a JsonObject intersection are valid dot-accesses
// regardless of noPropertyAccessFromIndexSignature, which keeps
// biome's useLiteralKeys lint happy without forcing dot-vs-bracket
// drift if installers' tsconfig later adopts that flag. User keys
// with hyphens ("other-server") fall through to bracket access via
// the index signature, which biome correctly does NOT flag (they
// are not valid JS identifiers). The types are intentionally NOT
// `readonly`: scenario 3 mutates driftedMcpServers.viberevert to
// simulate user drift, and that mutation is part of the contract
// under test.

import { Buffer } from "node:buffer";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { AdapterContext } from "@viberevert/adapters";
import { cursorAdapter } from "@viberevert/adapters";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { apply } from "../src/engine-apply.js";
import { ADOPTION_HUMAN_SUMMARY, DRIFT_REASON_CODE } from "../src/engine-classify.js";
import type { UninstallContext } from "../src/engine-types.js";
import { uninstall } from "../src/engine-uninstall.js";
import { readIntegrationsFile } from "../src/integrations-store.js";

import { createTempRepo } from "./helpers/temp-repo.js";

const CLI_VERSION = "0.7.1-beta.0-smoke";
const FIXED_NOW = new Date("2026-06-29T12:00:00.000Z");

const CURSOR_RECORD_KEY = "cursor" as const;
const CURSOR_ADAPTER_NAME = "Cursor";
const CURSOR_TARGET_REL = ".cursor/mcp.json";
const CURSOR_DESIRED_VALUE = {
  command: "viberevert",
  args: ["mcp", "serve"],
};
const PRE_EXISTING_OTHER_SERVER = {
  command: "unrelated-foo",
  args: ["--baz"],
};
const PRE_EXISTING_FILE_CONTENT = `${JSON.stringify(
  { mcpServers: { "other-server": PRE_EXISTING_OTHER_SERVER } },
  null,
  2,
)}\n`;

// Test-only narrowing types -- see header comment.
type JsonObject = Record<string, unknown>;

type CursorMcpConfig = JsonObject & {
  mcpServers?: unknown;
  _viberevert_managed?: unknown;
};

type CursorMcpServers = JsonObject & {
  viberevert?: unknown;
  _viberevert_managed?: unknown;
};

function adapterCtx(
  repoRoot: string,
  overrides: { readonly forceReinstall?: boolean } = {},
): AdapterContext {
  return {
    repoRoot,
    now: FIXED_NOW,
    cliVersion: CLI_VERSION,
    intent: "explicit",
    options: {
      forceReinstall: overrides.forceReinstall ?? false,
      migrateFromHookInstall: false,
      forceUninstall: false,
    },
  };
}

function uninstallCtx(repoRoot: string): UninstallContext {
  return {
    repoRoot,
    now: FIXED_NOW,
    cliVersion: CLI_VERSION,
    options: { forceUninstall: false },
  };
}

async function readTargetParsed(repoRoot: string): Promise<CursorMcpConfig> {
  const text = await readFile(join(repoRoot, CURSOR_TARGET_REL), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`expected ${CURSOR_TARGET_REL} to be a JSON object`);
  }
  return parsed as CursorMcpConfig;
}

async function readTargetBytes(repoRoot: string): Promise<Buffer> {
  return await readFile(join(repoRoot, CURSOR_TARGET_REL));
}

async function readIntegrationsBytes(repoRoot: string): Promise<Buffer> {
  return await readFile(join(repoRoot, ".viberevert", "integrations.json"));
}

// Gate dependent-scenario snapshot lookups: emits a clear "snapshot
// was not captured" diagnostic when an earlier lifecycle scenario
// failed before assigning the variable, instead of an opaque
// Buffer.compare(currentBytes, undefined) runtime crash.
function requireBuffer(value: Buffer | undefined, label: string): Buffer {
  if (value === undefined) {
    throw new Error(`${label} was not captured by an earlier lifecycle scenario`);
  }
  return value;
}

// Runtime-narrow + type-assert an `unknown` JSON-shaped value to a
// JsonObject. Callers may further `as` to a more specific
// known-keys intersection (e.g. CursorMcpServers) to enable
// declared-property dot access.
function requireObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

describe.sequential("cursor end-to-end lifecycle (stateful: shared temp repo)", () => {
  let repoRoot: string;
  let cleanup: () => Promise<void>;

  let scenario1TargetBytes: Buffer | undefined;
  let scenario1IntegrationsBytes: Buffer | undefined;
  let scenario3TargetBytes: Buffer | undefined;
  let scenario3IntegrationsBytes: Buffer | undefined;

  beforeAll(async () => {
    const tmp = await createTempRepo();
    repoRoot = tmp.repoRoot;
    cleanup = tmp.cleanup;

    // Pre-seed .cursor/mcp.json with an unrelated mcpServers entry.
    // Validates that json-key-merge preserves user content through
    // the full install/drift/force/uninstall cycle (other-server
    // must survive all five scenarios).
    await mkdir(join(repoRoot, ".cursor"));
    await writeFile(join(repoRoot, CURSOR_TARGET_REL), PRE_EXISTING_FILE_CONTENT, "utf8");
  });

  afterAll(async () => {
    await cleanup();
  });

  it("scenario 1: first install -- applied; merges into existing mcpServers; record + history written", async () => {
    // One detect() call across the smoke proves the public adapter
    // surface participates in the engine flow; cursor's detect
    // decision tree is unit-tested in 3A.
    const detected = await cursorAdapter.detect(adapterCtx(repoRoot));
    expect(detected.detected).toBe(true);

    const plan = await cursorAdapter.plan(adapterCtx(repoRoot));
    const result = await apply(plan, adapterCtx(repoRoot));

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("scenario 1: expected applied");

    expect(result.receipt.recordKey).toBe(CURSOR_RECORD_KEY);
    expect(result.receipt.adapterName).toBe(CURSOR_ADAPTER_NAME);
    expect(result.receipt.opsApplied).toBe(1);
    expect(result.receipt.filesWritten).toHaveLength(1);
    const writtenPath = result.receipt.filesWritten[0];
    expect(writtenPath).toBeDefined();
    if (writtenPath !== undefined) {
      expect(isAbsolute(writtenPath)).toBe(true);
    }
    // json-key-merge has no per-op target backup.
    expect(result.receipt.backupsCreated).toEqual([]);
    expect(isAbsolute(result.receipt.integrationsJsonPath)).toBe(true);

    // Semantic content: viberevert key inserted; other-server preserved.
    const parsed = await readTargetParsed(repoRoot);
    expect(parsed).toHaveProperty("mcpServers");
    const mcpServers = requireObject(parsed.mcpServers, "mcpServers") as CursorMcpServers;
    expect(mcpServers.viberevert).toEqual(CURSOR_DESIRED_VALUE);
    expect(mcpServers["other-server"]).toEqual(PRE_EXISTING_OTHER_SERVER);

    // D101.A: NO _viberevert_managed sidecar key anywhere in the
    // user's file. SHA lives only in our integrations record.
    expect(parsed).not.toHaveProperty("_viberevert_managed");
    expect(mcpServers).not.toHaveProperty("_viberevert_managed");
    expect(mcpServers.viberevert).not.toHaveProperty("_viberevert_managed");

    // Integrations record + history.
    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) throw new Error("scenario 1: integrations.json missing");
    const record = integrations.records[CURSOR_RECORD_KEY];
    if (record === undefined) throw new Error("scenario 1: cursor record missing");
    expect(record.adapterName).toBe(CURSOR_ADAPTER_NAME);
    expect(record.ops).toHaveLength(1);
    const op = record.ops[0];
    if (op === undefined) throw new Error("scenario 1: cursor record op missing");
    expect(op.kind).toBe("json-key-merge");
    expect(typeof op.managedValueSha256).toBe("string");
    expect(integrations.history).toHaveLength(1);
    const installEntry = integrations.history[0];
    expect(installEntry?.action).toBe("install");
    expect(installEntry?.recordKey).toBe(CURSOR_RECORD_KEY);

    scenario1TargetBytes = await readTargetBytes(repoRoot);
    scenario1IntegrationsBytes = await readIntegrationsBytes(repoRoot);
  });

  it("scenario 2: second install -- noop; bytes unchanged", async () => {
    const plan = await cursorAdapter.plan(adapterCtx(repoRoot));
    const result = await apply(plan, adapterCtx(repoRoot));

    expect(result.status).toBe("noop");
    if (result.status !== "noop") throw new Error("scenario 2: expected noop");
    expect(result.recordKey).toBe(CURSOR_RECORD_KEY);
    expect(result.adapterName).toBe(CURSOR_ADAPTER_NAME);

    const currentTargetBytes = await readTargetBytes(repoRoot);
    expect(
      Buffer.compare(
        currentTargetBytes,
        requireBuffer(scenario1TargetBytes, "scenario1TargetBytes"),
      ),
    ).toBe(0);
    const currentIntegrationsBytes = await readIntegrationsBytes(repoRoot);
    expect(
      Buffer.compare(
        currentIntegrationsBytes,
        requireBuffer(scenario1IntegrationsBytes, "scenario1IntegrationsBytes"),
      ),
    ).toBe(0);
  });

  it("scenario 3: user-drift refusal -- mutate viberevert.command; apply without force; refused with drift", async () => {
    // User manually mutates the managed value.
    const driftedParsed = await readTargetParsed(repoRoot);
    const driftedMcpServers = requireObject(
      driftedParsed.mcpServers,
      "mcpServers",
    ) as CursorMcpServers;
    driftedMcpServers.viberevert = { command: "user-modified", args: ["foo"] };
    const driftedJson = `${JSON.stringify(driftedParsed, null, 2)}\n`;
    await writeFile(join(repoRoot, CURSOR_TARGET_REL), driftedJson, "utf8");

    const integrationsBytesBeforeRefusal = await readIntegrationsBytes(repoRoot);

    const plan = await cursorAdapter.plan(adapterCtx(repoRoot));
    const result = await apply(plan, adapterCtx(repoRoot));

    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("scenario 3: expected refused");
    expect(result.recordKey).toBe(CURSOR_RECORD_KEY);
    expect(result.adapterName).toBe(CURSOR_ADAPTER_NAME);
    expect(result.reasonCode).toBe(DRIFT_REASON_CODE);

    // User's drifted bytes preserved; integrations.json unchanged.
    const currentTargetBytes = await readTargetBytes(repoRoot);
    expect(Buffer.compare(currentTargetBytes, Buffer.from(driftedJson, "utf8"))).toBe(0);
    const currentIntegrationsBytes = await readIntegrationsBytes(repoRoot);
    expect(Buffer.compare(currentIntegrationsBytes, integrationsBytesBeforeRefusal)).toBe(0);

    scenario3TargetBytes = currentTargetBytes;
    scenario3IntegrationsBytes = currentIntegrationsBytes;
  });

  it("scenario 4: force-reinstall -- overrides drift; restores canonical value; preserves other-server", async () => {
    // Sanity-check the prior state (still drifted from scenario 3).
    const beforeForce = await readTargetBytes(repoRoot);
    expect(
      Buffer.compare(beforeForce, requireBuffer(scenario3TargetBytes, "scenario3TargetBytes")),
    ).toBe(0);

    const plan = await cursorAdapter.plan(adapterCtx(repoRoot));
    const result = await apply(plan, adapterCtx(repoRoot, { forceReinstall: true }));

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("scenario 4: expected applied");
    expect(result.receipt.opsApplied).toBe(1);
    expect(result.receipt.filesWritten).toHaveLength(1);
    expect(result.receipt.backupsCreated).toEqual([]);

    // Canonical viberevert restored; other-server still preserved.
    const parsed = await readTargetParsed(repoRoot);
    const mcpServers = requireObject(parsed.mcpServers, "mcpServers") as CursorMcpServers;
    expect(mcpServers.viberevert).toEqual(CURSOR_DESIRED_VALUE);
    expect(mcpServers["other-server"]).toEqual(PRE_EXISTING_OTHER_SERVER);

    // Integrations record present with non-null managedValueSha256;
    // history grew by exactly one "install" entry (force-reinstall
    // still records action "install" per engine-apply.ts).
    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) throw new Error("scenario 4: integrations.json missing");
    const record = integrations.records[CURSOR_RECORD_KEY];
    if (record === undefined) throw new Error("scenario 4: cursor record missing");
    const op = record.ops[0];
    if (op === undefined) throw new Error("scenario 4: cursor record op missing");
    expect(op.kind).toBe("json-key-merge");
    expect(typeof op.managedValueSha256).toBe("string");
    expect(integrations.history).toHaveLength(2);
    expect(integrations.history.every((h) => h.action === "install")).toBe(true);
    expect(integrations.history.every((h) => h.recordKey === CURSOR_RECORD_KEY)).toBe(true);

    // Confirms scenario 4 was a real apply (not noop) -- the history
    // append caused integrations.json bytes to differ from the
    // pre-force snapshot.
    const currentIntegrationsBytes = await readIntegrationsBytes(repoRoot);
    expect(
      Buffer.compare(
        currentIntegrationsBytes,
        requireBuffer(scenario3IntegrationsBytes, "scenario3IntegrationsBytes"),
      ),
    ).not.toBe(0);
  });

  it("scenario 5: uninstall round-trip -- viberevert key removed; other-server preserved; record removed", async () => {
    const result = await uninstall(CURSOR_RECORD_KEY, uninstallCtx(repoRoot));

    expect(result.status).toBe("uninstalled");
    if (result.status !== "uninstalled") throw new Error("scenario 5: expected uninstalled");
    expect(result.receipt.recordKey).toBe(CURSOR_RECORD_KEY);
    expect(result.receipt.adapterName).toBe(CURSOR_ADAPTER_NAME);

    // Semantic effects first (engine contract guarantees these
    // regardless of receipt naming; per amendment 3).
    const parsed = await readTargetParsed(repoRoot);
    expect(parsed).toHaveProperty("mcpServers");
    const mcpServers = requireObject(parsed.mcpServers, "mcpServers") as CursorMcpServers;
    expect(mcpServers).not.toHaveProperty("viberevert");
    expect(mcpServers["other-server"]).toEqual(PRE_EXISTING_OTHER_SERVER);

    // Target file still exists (json-key-merge reverse rewrites; never deletes).
    const targetStat = await stat(join(repoRoot, CURSOR_TARGET_REL));
    expect(targetStat.isFile()).toBe(true);

    // Record removed; uninstall history entry appended.
    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) throw new Error("scenario 5: integrations.json missing");
    expect(integrations.records[CURSOR_RECORD_KEY]).toBeUndefined();
    expect(integrations.history).toHaveLength(3);
    const lastHistory = integrations.history.at(-1);
    expect(lastHistory?.action).toBe("uninstall");
    expect(lastHistory?.recordKey).toBe(CURSOR_RECORD_KEY);

    // Secondary: receipt reporting. engine-uninstall.ts REVERSE PER
    // KIND table records json-key-merge reverse writes under
    // filesRestored; filesRemoved is empty (no write-new ops).
    expect(result.receipt.filesRemoved).toEqual([]);
    expect(result.receipt.filesRestored).toHaveLength(1);
    const restored = result.receipt.filesRestored[0];
    expect(restored).toBeDefined();
    if (restored !== undefined) {
      expect(isAbsolute(restored)).toBe(true);
    }
  });
});

describe("cursor end-to-end adoption case (fresh repo per test)", () => {
  let repoRoot: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await createTempRepo();
    repoRoot = tmp.repoRoot;
    cleanup = tmp.cleanup;

    // Pre-create .cursor/mcp.json with mcpServers.viberevert matching
    // what cursor's plan would write. No integrations record.
    // Classifier sees the existing managed-region SHA == desired ->
    // would-adopt.
    await mkdir(join(repoRoot, ".cursor"));
    const adoptedContent = `${JSON.stringify(
      { mcpServers: { viberevert: CURSOR_DESIRED_VALUE } },
      null,
      2,
    )}\n`;
    await writeFile(join(repoRoot, CURSOR_TARGET_REL), adoptedContent, "utf8");
  });

  afterEach(async () => {
    await cleanup();
  });

  it("adoption -- applied with opsApplied=0 and adoption humanSummary; target bytes unchanged; history action 'adopt'", async () => {
    const targetBytesBefore = await readTargetBytes(repoRoot);

    const plan = await cursorAdapter.plan(adapterCtx(repoRoot));
    const result = await apply(plan, adapterCtx(repoRoot));

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("adoption: expected applied");
    expect(result.receipt.recordKey).toBe(CURSOR_RECORD_KEY);
    expect(result.receipt.adapterName).toBe(CURSOR_ADAPTER_NAME);
    expect(result.receipt.opsApplied).toBe(0);
    expect(result.receipt.filesWritten).toEqual([]);
    expect(result.receipt.backupsCreated).toEqual([]);
    expect(result.receipt.humanSummary).toBe(ADOPTION_HUMAN_SUMMARY);

    // Target bytes UNCHANGED -- adoption only writes the integrations record.
    const targetBytesAfter = await readTargetBytes(repoRoot);
    expect(Buffer.compare(targetBytesAfter, targetBytesBefore)).toBe(0);

    // Integrations record created with action "adopt" in history.
    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) throw new Error("adoption: integrations.json missing");
    const record = integrations.records[CURSOR_RECORD_KEY];
    if (record === undefined) throw new Error("adoption: cursor record missing");
    expect(record.adapterName).toBe(CURSOR_ADAPTER_NAME);
    expect(record.ops).toHaveLength(1);
    const op = record.ops[0];
    if (op === undefined) throw new Error("adoption: cursor record op missing");
    expect(op.kind).toBe("json-key-merge");
    expect(typeof op.managedValueSha256).toBe("string");
    expect(integrations.history).toHaveLength(1);
    const adoptEntry = integrations.history[0];
    expect(adoptEntry?.action).toBe("adopt");
    expect(adoptEntry?.recordKey).toBe(CURSOR_RECORD_KEY);
  });
});
