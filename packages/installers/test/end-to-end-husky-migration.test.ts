// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// End-to-end migration smoke test for @viberevert/installers.
//
// Exercises the INSTALLERS-LEVEL parts of the M F -> M G1b Husky
// migration story:
//   1. Apply the real directHookAdapter through engine.apply -- creates
//      a VR-managed .git/hooks/pre-commit + direct-hook integration
//      record.
//   2. Apply the real huskyAdapter with ctx.options.migrateFromHookInstall
//      = true -- emits a husky integration record whose meta.
//      migrateFromDirectHook === "true" AND writes the VR sentinel
//      block into a pre-existing .husky/pre-commit boilerplate. Critically,
//      apply(husky) does NOT touch the direct-hook record or file --
//      the meta marker is a SIGNAL to the CLI orchestrator, not a
//      command to the engine.
//   3. Simulate the CLI-level migration choreography by explicitly
//      calling uninstall("direct-hook", ctx). This is what Step 6's
//      InstallCommand will eventually do after observing
//      meta.migrateFromDirectHook on the applied husky record. The
//      result: direct-hook record + file gone; husky record + sentinel
//      block preserved.
//
// The `describe.sequential` + shared temp repo pattern matches 3D's
// stateful lifecycle style (packages/installers/test/end-to-end.test.ts).
// Each phase depends on the prior phase's on-disk + integrations state;
// sequential execution makes cascade failures readable.
//
// Adapter import path: import { directHookAdapter, huskyAdapter,
// MANAGED_BY_MARKER } from "@viberevert/adapters" -- proves the M G1b
// Step 4 root barrel re-exports work from the installers package. The
// vitest.config.ts alias resolves @viberevert/adapters to source for
// test runs.
//
// SCOPE (locked): this smoke covers ONLY the installers-level parts of
// the migration -- adapter plan/apply/uninstall through the engine. It
// does NOT cover:
//   - CLI-level orchestration (Step 6's InstallCommand reading
//     meta.migrateFromDirectHook and deciding to call uninstall).
//   - Failure branches (husky apply fails midway; direct-hook uninstall
//     fails after husky commit). Engine unit tests already cover those.
//   - Adapter detect() (host detection is 4A's unit test scope).
//   - Refusal branches (vr direct hook + no migrate flag -> refused).
//     4A's unit test covers that.
//
// History assertions use an ORDERED PROJECTION over
// `.map(({ action, recordKey }) => ({ action, recordKey }))` to lock
// the exact choreography sequence:
//   [install direct-hook, install husky, uninstall direct-hook]
// If the engine ever adds a "migrate" history action or records
// something between phases, this assertion will loudly surface the
// change for reviewers to decide whether the choreography contract
// needs updating.

import { Buffer } from "node:buffer";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AdapterContext } from "@viberevert/adapters";
import { directHookAdapter, huskyAdapter, MANAGED_BY_MARKER } from "@viberevert/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apply } from "../src/engine-apply.js";
import type { UninstallContext } from "../src/engine-types.js";
import { uninstall } from "../src/engine-uninstall.js";
import { readIntegrationsFile } from "../src/integrations-store.js";

import { createTempRepo } from "./helpers/temp-repo.js";

const CLI_VERSION = "0.7.1-beta.0-smoke";
const FIXED_NOW = new Date("2026-06-29T12:00:00.000Z");

const DIRECT_HOOK_RECORD_KEY = "direct-hook" as const;
const HUSKY_RECORD_KEY = "husky" as const;

const DIRECT_HOOK_TARGET_REL = ".git/hooks/pre-commit";
const HUSKY_TARGET_REL = ".husky/pre-commit";

// Realistic minimal husky boilerplate. Real husky installations start
// with a shebang + husky.sh sourcing line; sentinel-block-insert
// APPENDS our block after this content, and we assert both the
// boilerplate AND the sentinel survive apply.
const HUSKY_BOILERPLATE = ["#!/bin/sh", '. "$(dirname -- "$0")/_/husky.sh"', ""].join("\n");

// The husky adapter's BLOCK_ID (from 4A) rendered as the BEGIN marker
// line. Semantic check via toContain -- we don't lock the full sentinel
// block bytes (adapter body content is checked separately in 4A).
const HUSKY_SENTINEL_BEGIN_MARKER = "# viberevert:begin:viberevert-husky-pre-commit";

// ---------------------------------------------------------------------------
// Context factories (mirror 3D's end-to-end.test.ts style)
// ---------------------------------------------------------------------------

function adapterCtx(
  repoRoot: string,
  overrides: {
    readonly forceReinstall?: boolean;
    readonly migrateFromHookInstall?: boolean;
    readonly forceUninstall?: boolean;
  } = {},
): AdapterContext {
  return {
    repoRoot,
    now: FIXED_NOW,
    cliVersion: CLI_VERSION,
    intent: "explicit",
    options: {
      forceReinstall: overrides.forceReinstall ?? false,
      migrateFromHookInstall: overrides.migrateFromHookInstall ?? false,
      forceUninstall: overrides.forceUninstall ?? false,
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

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function readDirectHookBytes(repoRoot: string): Promise<Buffer> {
  return await readFile(join(repoRoot, DIRECT_HOOK_TARGET_REL));
}

async function readHuskyBytes(repoRoot: string): Promise<Buffer> {
  return await readFile(join(repoRoot, HUSKY_TARGET_REL));
}

async function directHookExists(repoRoot: string): Promise<boolean> {
  try {
    const st = await stat(join(repoRoot, DIRECT_HOOK_TARGET_REL));
    return st.isFile();
  } catch {
    return false;
  }
}

// Gate dependent-phase snapshot lookups: emits a clear "snapshot was
// not captured" diagnostic when an earlier phase failed before
// assigning the variable, instead of an opaque Buffer.compare-on-
// undefined runtime crash. Mirrors 3D's requireBuffer helper.
function requireBuffer(value: Buffer | undefined, label: string): Buffer {
  if (value === undefined) {
    throw new Error(`${label} was not captured by an earlier lifecycle phase`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe.sequential("Husky migration lifecycle (installers-level; simulated CLI choreography)", () => {
  let repoRoot: string;
  let cleanup: () => Promise<void>;

  // Snapshot for phase 2's "direct-hook bytes unchanged after Husky
  // apply" assertion. Typed Buffer | undefined + gated through
  // requireBuffer so a cascade failure emits a clear diagnostic
  // instead of a Buffer.compare-on-undefined crash.
  let phase1DirectHookBytes: Buffer | undefined;

  beforeAll(async () => {
    const tmp = await createTempRepo();
    repoRoot = tmp.repoRoot;
    cleanup = tmp.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("phase 1: install direct-hook via directHookAdapter (fresh repo -> VR-managed .git/hooks/pre-commit)", async () => {
    // Pre-condition: fresh temp repo. No .husky/, no .git/hooks/, no
    // .viberevert/. direct-hook adapter's plan() returns write-new
    // (hookState === "absent" -> useBackup === false).
    const plan = await directHookAdapter.plan(adapterCtx(repoRoot));
    if (plan.status !== "applicable") {
      throw new Error("phase 1: expected applicable direct-hook plan");
    }

    const result = await apply(plan, adapterCtx(repoRoot));
    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      throw new Error("phase 1: expected applied outcome");
    }

    // Direct-hook file exists and is VR-managed (line 2 marker check
    // matches direct-hook's isVrManagedHook logic).
    expect(await directHookExists(repoRoot)).toBe(true);
    const bytes = await readDirectHookBytes(repoRoot);
    const content = bytes.toString("utf8");
    expect(content.split("\n")[1]).toBe(MANAGED_BY_MARKER);

    // Integrations record for direct-hook.
    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) throw new Error("phase 1: integrations.json missing");
    const directHookRecord = integrations.records[DIRECT_HOOK_RECORD_KEY];
    if (directHookRecord === undefined) {
      throw new Error("phase 1: direct-hook record missing");
    }
    expect(directHookRecord.ops).toHaveLength(1);
    expect(directHookRecord.ops[0]?.kind).toBe("write-new");

    // History ordered projection: single install(direct-hook) entry.
    expect(integrations.history.map(({ action, recordKey }) => ({ action, recordKey }))).toEqual([
      { action: "install", recordKey: "direct-hook" },
    ]);

    // Snapshot for phase 2's byte-equality assertion.
    phase1DirectHookBytes = bytes;
  });

  it("phase 2: install husky with migrateFromHookInstall=true (husky record has meta marker; direct-hook is NOT touched)", async () => {
    // Pre-fixture: pre-create .husky/pre-commit with realistic
    // husky boilerplate so sentinel-block-insert APPENDS to it
    // rather than creating a file with only the sentinel block.
    // This exercises the "husky as good citizen" contract: our
    // sentinel joins existing user content.
    await mkdir(join(repoRoot, ".husky"), { recursive: true });
    await writeFile(join(repoRoot, HUSKY_TARGET_REL), HUSKY_BOILERPLATE, "utf8");

    // Plan-level assertion: husky plan is APPLICABLE (not refused;
    // not noop). The migrate flag + presence of VR direct hook flips
    // what would be a "vr-direct-hook-present" refusal into an
    // applicable plan with meta.migrateFromDirectHook === "true".
    const plan = await huskyAdapter.plan(adapterCtx(repoRoot, { migrateFromHookInstall: true }));
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") {
      throw new Error("phase 2: expected applicable husky plan");
    }
    expect(plan.meta).toEqual({ migrateFromDirectHook: "true" });

    // Apply husky plan.
    const result = await apply(plan, adapterCtx(repoRoot, { migrateFromHookInstall: true }));
    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      throw new Error("phase 2: expected applied outcome");
    }

    // Husky file has BOTH the boilerplate AND the sentinel block.
    // Semantic assertions (substring checks) -- do NOT lock exact
    // full-file bytes since adapter body content evolves.
    const huskyContent = (await readHuskyBytes(repoRoot)).toString("utf8");
    expect(huskyContent).toContain(HUSKY_SENTINEL_BEGIN_MARKER);
    expect(huskyContent).toContain("#!/bin/sh");
    expect(huskyContent).toContain('. "$(dirname -- "$0")/_/husky.sh"');

    // Integrations: husky record has 1 op of kind sentinel-block-insert
    // + meta.migrateFromDirectHook === "true".
    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) throw new Error("phase 2: integrations.json missing");
    const huskyRecord = integrations.records[HUSKY_RECORD_KEY];
    if (huskyRecord === undefined) throw new Error("phase 2: husky record missing");
    expect(huskyRecord.ops).toHaveLength(1);
    expect(huskyRecord.ops[0]?.kind).toBe("sentinel-block-insert");
    expect(huskyRecord.meta).toEqual({ migrateFromDirectHook: "true" });

    // Critical assertion: direct-hook record STILL PRESENT. apply(husky)
    // is NOT migration choreography -- Step 6's InstallCommand will
    // explicitly uninstall direct-hook after observing the meta marker.
    expect(integrations.records[DIRECT_HOOK_RECORD_KEY]).toBeDefined();

    // Direct-hook bytes UNCHANGED from phase 1 -- proves apply(husky)
    // does NOT touch .git/hooks/pre-commit at all.
    const currentDirectHookBytes = await readDirectHookBytes(repoRoot);
    expect(
      Buffer.compare(
        currentDirectHookBytes,
        requireBuffer(phase1DirectHookBytes, "phase1DirectHookBytes"),
      ),
    ).toBe(0);

    // History ordered projection: 2 entries.
    expect(integrations.history.map(({ action, recordKey }) => ({ action, recordKey }))).toEqual([
      { action: "install", recordKey: "direct-hook" },
      { action: "install", recordKey: "husky" },
    ]);
  });

  it("phase 3: simulated CLI choreography -- explicit uninstall(direct-hook) removes direct hook + keeps husky intact", async () => {
    // This step SIMULATES the CLI-level migration choreography that
    // Step 6's InstallCommand will eventually own. After apply(husky)
    // returns applied with meta.migrateFromDirectHook === "true", the
    // orchestrator explicitly calls uninstall("direct-hook", ctx) to
    // complete the migration. This test proves the resulting state
    // is correct; the "who calls this" question is Step 6's concern.
    const result = await uninstall(DIRECT_HOOK_RECORD_KEY, uninstallCtx(repoRoot));
    expect(result.status).toBe("uninstalled");
    if (result.status !== "uninstalled") {
      throw new Error("phase 3: expected uninstalled outcome");
    }

    // Semantic: filesRemoved INCLUDES the direct-hook absolute path
    // (write-new reverse = unlink). Avoid exact receipt match --
    // receipt shape may evolve.
    const expectedDirectHookAbs = join(repoRoot, DIRECT_HOOK_TARGET_REL);
    expect(result.receipt.filesRemoved).toContain(expectedDirectHookAbs);

    // Direct-hook file does NOT exist (unlinked).
    expect(await directHookExists(repoRoot)).toBe(false);

    // Integrations: direct-hook removed; husky STILL PRESENT with
    // meta.migrateFromDirectHook preserved (migration meta is durable
    // audit context, not conditional state).
    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) throw new Error("phase 3: integrations.json missing");
    expect(integrations.records[DIRECT_HOOK_RECORD_KEY]).toBeUndefined();
    const huskyRecord = integrations.records[HUSKY_RECORD_KEY];
    expect(huskyRecord).toBeDefined();
    if (huskyRecord === undefined) throw new Error("phase 3: husky record missing");
    expect(huskyRecord.meta).toEqual({ migrateFromDirectHook: "true" });

    // Husky sentinel + boilerplate STILL PRESENT (direct-hook
    // uninstall does NOT touch .husky/pre-commit).
    const huskyContent = (await readHuskyBytes(repoRoot)).toString("utf8");
    expect(huskyContent).toContain(HUSKY_SENTINEL_BEGIN_MARKER);
    expect(huskyContent).toContain("#!/bin/sh");

    // History EXACT ordered projection: locks the choreography sequence.
    // If a future engine change adds a "migrate" history action or
    // records something between phases, this assertion will loudly
    // surface the change for reviewers.
    expect(integrations.history.map(({ action, recordKey }) => ({ action, recordKey }))).toEqual([
      { action: "install", recordKey: "direct-hook" },
      { action: "install", recordKey: "husky" },
      { action: "uninstall", recordKey: "direct-hook" },
    ]);
  });
});
