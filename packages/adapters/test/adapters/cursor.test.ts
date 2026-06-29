// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cursorAdapter } from "../../src/adapters/cursor.js";
import type { AdapterContext } from "../../src/types.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-cursor-adapter-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AdapterContext factory with options-deep-merge (preserves per-flag
// overrides without dropping the other option defaults).
// ---------------------------------------------------------------------------

type AdapterContextOverrides = Omit<Partial<AdapterContext>, "options"> & {
  readonly options?: Partial<AdapterContext["options"]>;
};

function makeCtx(overrides: AdapterContextOverrides = {}): AdapterContext {
  const base: AdapterContext = {
    repoRoot,
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

// ===========================================================================
// A. Adapter interface conformance
// ===========================================================================

describe("cursorAdapter -- interface conformance", () => {
  it("exports name (string), detect (function), plan (function)", () => {
    expect(typeof cursorAdapter.name).toBe("string");
    expect(cursorAdapter.name.length).toBeGreaterThan(0);
    expect(typeof cursorAdapter.detect).toBe("function");
    expect(typeof cursorAdapter.plan).toBe("function");
  });
  it("name is 'Cursor' (display-only, distinct from durable recordKey)", () => {
    expect(cursorAdapter.name).toBe("Cursor");
  });
});

// ===========================================================================
// B. detect (intent: "explicit") -- always detected, regardless of fs
// ===========================================================================

describe("cursorAdapter.detect -- intent 'explicit'", () => {
  it("returns detected=true with intent signal even when no .cursor/ present", async () => {
    const result = await cursorAdapter.detect(makeCtx({ intent: "explicit" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "explicit" });
  });
  it("returns detected=true even with .cursor/ present (explicit always positive)", async () => {
    await mkdir(join(repoRoot, ".cursor"));
    const result = await cursorAdapter.detect(makeCtx({ intent: "explicit" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "explicit" });
  });
});

// ===========================================================================
// C-E + strict file-check. detect (intent: "all")
// ===========================================================================

describe("cursorAdapter.detect -- intent 'all'", () => {
  it("no .cursor/ at all -> detected=false with reason mentioning .cursor", async () => {
    const result = await cursorAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(false);
    if (result.detected === false) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toContain(".cursor");
    }
    expect(result.signal).toMatchObject({ intent: "all" });
  });

  it(".cursor/ directory present (no mcp.json) -> detected=true with cursor-dir trigger", async () => {
    await mkdir(join(repoRoot, ".cursor"));
    const result = await cursorAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "all", trigger: "cursor-dir-present" });
  });

  it(".cursor exists as a regular file (not a dir) -> detected=false with reason mentioning .cursor", async () => {
    // A regular file at .cursor is not a positive signal. The strict
    // dir-shape check guards against treating a broken parent path as
    // evidence of a Cursor install. Preflight would refuse later, but
    // detection stays conservative for "all" intent -- and the user-
    // facing reason makes the non-detection explainable, not just a
    // boolean.
    await writeFile(join(repoRoot, ".cursor"), "not a directory");
    const result = await cursorAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(false);
    if (result.detected === false) {
      expect(result.reason).toContain(".cursor");
    }
    expect(result.signal).toMatchObject({ intent: "all" });
  });

  it(".cursor/mcp.json present (under valid .cursor/ dir) -> detected=true with mcp.json trigger", async () => {
    await mkdir(join(repoRoot, ".cursor"));
    await writeFile(join(repoRoot, ".cursor", "mcp.json"), '{"mcpServers":{}}');
    const result = await cursorAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "all", trigger: "mcp.json-present" });
  });
});

// ===========================================================================
// F. detect is read-only (no fs mutation during detection)
// ===========================================================================

describe("cursorAdapter.detect -- read-only contract", () => {
  it("does not modify the repo directory tree (sorted readdir snapshot unchanged)", async () => {
    await mkdir(join(repoRoot, ".cursor"));
    await writeFile(join(repoRoot, ".cursor", "mcp.json"), '{"mcpServers":{}}');
    await writeFile(join(repoRoot, "user-file.txt"), "user content");

    // Sort entries -- directory iteration order is not part of the
    // POSIX contract; sorting before compare keeps the test future-
    // proof against filesystems that return entries in different orders.
    const before = (await readdir(repoRoot)).sort();
    const beforeCursor = (await readdir(join(repoRoot, ".cursor"))).sort();

    await cursorAdapter.detect(makeCtx({ intent: "all" }));

    const after = (await readdir(repoRoot)).sort();
    const afterCursor = (await readdir(join(repoRoot, ".cursor"))).sort();
    expect(after).toEqual(before);
    expect(afterCursor).toEqual(beforeCursor);
  });
});

// ===========================================================================
// G-K. plan() shape + locked semantic fields
// ===========================================================================

describe("cursorAdapter.plan -- shape + locked semantic fields", () => {
  it("returns ApplicablePlan with adapterName 'Cursor'", async () => {
    const plan = await cursorAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status === "applicable") {
      expect(plan.adapterName).toBe("Cursor");
    }
  });

  it("plan.recordKey === 'cursor' (durable storage key)", async () => {
    const plan = await cursorAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(plan.recordKey).toBe("cursor");
  });

  it("plan.humanSummary is a non-empty string", async () => {
    const plan = await cursorAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(typeof plan.humanSummary).toBe("string");
    expect(plan.humanSummary.length).toBeGreaterThan(0);
  });

  it("plan.meta is the empty object (no adapter-specific metadata in v1)", async () => {
    const plan = await cursorAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(plan.meta).toEqual({});
  });

  it("plan.ops has exactly one op", async () => {
    const plan = await cursorAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(plan.ops).toHaveLength(1);
  });

  it("plan.ops[0] is a json-key-merge with target=.cursor/mcp.json + keyPath=[mcpServers, viberevert] + value={command, args}", async () => {
    const plan = await cursorAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    const op = plan.ops[0];
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(op.kind).toBe("json-key-merge");
    if (op.kind !== "json-key-merge") return;
    expect(op.target.scope).toBe("repo");
    expect(op.target.pathRelative).toBe(".cursor/mcp.json");
    expect(op.target.pathTemplate).toBe("{repo}/.cursor/mcp.json");
    expect(op.keyPath).toEqual(["mcpServers", "viberevert"]);
    expect(op.value).toEqual({ command: "viberevert", args: ["mcp", "serve"] });
  });

  it("plan.ops[0] target.pathRelative is repo-local POSIX (no leading slash/backslash/colon/tilde)", async () => {
    const plan = await cursorAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    const op = plan.ops[0];
    if (op === undefined) return;
    const path = op.target.pathRelative;
    expect(path.startsWith("/")).toBe(false);
    expect(path.startsWith("~")).toBe(false);
    expect(path.includes("\\")).toBe(false);
    expect(path.includes(":")).toBe(false);
  });
});

// ===========================================================================
// L. plan() determinism -- two calls return deep-equal results, even
// across varying ctx (plan is declarative; ctx must not influence output)
// ===========================================================================

describe("cursorAdapter.plan -- determinism + ctx-independence", () => {
  it("two successive plan() calls with the same ctx return deep-equal plans", async () => {
    const p1 = await cursorAdapter.plan(makeCtx());
    const p2 = await cursorAdapter.plan(makeCtx());
    expect(p1).toEqual(p2);
  });

  it("plan() ignores ctx differences (intent / options / cliVersion / now) -- declarative output", async () => {
    // The Adapter interface declares plan(ctx); the implementation
    // takes zero args (method bivariance). This test protects against
    // accidentally making cursor planning ctx-dependent later -- the
    // plan must stay declarative regardless of intent, force flags,
    // cliVersion, or now.
    const pExplicit = await cursorAdapter.plan(makeCtx({ intent: "explicit" }));
    const pAllForced = await cursorAdapter.plan(
      makeCtx({
        intent: "all",
        cliVersion: "9.9.9",
        now: new Date("2099-01-01T00:00:00.000Z"),
        options: { forceReinstall: true, migrateFromHookInstall: true, forceUninstall: true },
      }),
    );
    expect(pExplicit).toEqual(pAllForced);
  });
});

// ===========================================================================
// M. plan() mutation safety -- mutating one returned plan does NOT leak
// into a subsequent plan() call (fresh nested structures per call)
// ===========================================================================

describe("cursorAdapter.plan -- mutation safety (fresh nested structures per call)", () => {
  it("mutating returned plan's keyPath/value/target does not affect a subsequent plan() call", async () => {
    const p1 = await cursorAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const op1 = p1.ops[0];
    if (op1 === undefined) throw new Error("expected one op");
    if (op1.kind !== "json-key-merge") throw new Error("expected json-key-merge");

    // Cast through unknown so the test can mutate readonly types --
    // the contract under test is runtime freshness, not type-level
    // readonly.
    const opMut = op1 as unknown as {
      keyPath: string[];
      value: { command: string; args: string[] };
      target: { pathRelative: string };
    };
    opMut.keyPath.push("MUTATED");
    opMut.value.command = "MUTATED";
    opMut.value.args.push("MUTATED");
    opMut.target.pathRelative = "MUTATED";

    // Second call: every nested structure must be canonical.
    const p2 = await cursorAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    const op2 = p2.ops[0];
    if (op2 === undefined) throw new Error("expected one op");
    if (op2.kind !== "json-key-merge") throw new Error("expected json-key-merge");
    expect(op2.keyPath).toEqual(["mcpServers", "viberevert"]);
    expect(op2.value).toEqual({ command: "viberevert", args: ["mcp", "serve"] });
    expect(op2.target.pathRelative).toBe(".cursor/mcp.json");
  });
});
