// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeAdapter } from "../../src/adapters/claude.js";
import type { AdapterContext } from "../../src/types.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-claude-adapter-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

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

// The value the Claude adapter must emit -- kept as a single constant
// so schema-shape amendments (e.g. adding "type": "stdio" per
// docs.claude.com/docs/en/mcp-quickstart) touch exactly one spot.
const EXPECTED_MCP_VALUE = {
  type: "stdio",
  command: "viberevert",
  args: ["mcp", "serve"],
} as const;

// ===========================================================================
// A. Adapter interface conformance
// ===========================================================================

describe("claudeAdapter -- interface conformance", () => {
  it("exports name (string), detect (function), plan (function)", () => {
    expect(typeof claudeAdapter.name).toBe("string");
    expect(claudeAdapter.name.length).toBeGreaterThan(0);
    expect(typeof claudeAdapter.detect).toBe("function");
    expect(typeof claudeAdapter.plan).toBe("function");
  });
  it("name is 'Claude Code' (display-only, distinct from durable recordKey)", () => {
    expect(claudeAdapter.name).toBe("Claude Code");
  });
});

// ===========================================================================
// B. detect (intent: "explicit") -- always detected, regardless of fs
// ===========================================================================

describe("claudeAdapter.detect -- intent 'explicit'", () => {
  it("returns detected=true with intent signal even when no .mcp.json / no .claude/ present", async () => {
    const result = await claudeAdapter.detect(makeCtx({ intent: "explicit" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "explicit" });
  });
  it("returns detected=true with .mcp.json AND .claude/ present (explicit always positive; no trigger detail)", async () => {
    await writeFile(join(repoRoot, ".mcp.json"), '{"mcpServers":{}}');
    await mkdir(join(repoRoot, ".claude"));
    const result = await claudeAdapter.detect(makeCtx({ intent: "explicit" }));
    expect(result.detected).toBe(true);
    // explicit signal is intentionally coarse -- no trigger key.
    expect(result.signal).toEqual({ intent: "explicit" });
  });
});

// ===========================================================================
// C-H. detect (intent: "all") -- signal-driven with locked priority
// ===========================================================================

describe("claudeAdapter.detect -- intent 'all'", () => {
  it("no .mcp.json AND no .claude/ -> detected=false with reason mentioning both signals", async () => {
    const result = await claudeAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(false);
    if (result.detected === false) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toContain(".mcp.json");
      expect(result.reason).toContain(".claude");
    }
    expect(result.signal).toMatchObject({ intent: "all" });
  });

  it(".mcp.json present (no .claude/) -> detected=true with mcp.json-present trigger", async () => {
    await writeFile(join(repoRoot, ".mcp.json"), '{"mcpServers":{}}');
    const result = await claudeAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "all", trigger: "mcp.json-present" });
  });

  it(".claude/ directory present (no .mcp.json) -> detected=true with claude-dir-present trigger", async () => {
    await mkdir(join(repoRoot, ".claude"));
    const result = await claudeAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "all", trigger: "claude-dir-present" });
  });

  it(".mcp.json present AND .claude/ present -> detected=true with mcp.json-present trigger (target-file signal wins over dir signal)", async () => {
    await writeFile(join(repoRoot, ".mcp.json"), '{"mcpServers":{}}');
    await mkdir(join(repoRoot, ".claude"));
    const result = await claudeAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "all", trigger: "mcp.json-present" });
  });

  it(".claude exists as a regular file (not a dir) AND no .mcp.json -> detected=false with reason mentioning both signals", async () => {
    await writeFile(join(repoRoot, ".claude"), "not a directory");
    const result = await claudeAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(false);
    if (result.detected === false) {
      expect(result.reason).toContain(".mcp.json");
      expect(result.reason).toContain(".claude");
    }
    expect(result.signal).toMatchObject({ intent: "all" });
  });

  it(".claude exists as a regular file BUT .mcp.json present -> detected=true (mcp.json wins; .claude never inspected)", async () => {
    // Ordering lock: .mcp.json is checked FIRST and returns early;
    // the regular-file .claude never gets examined. If the check
    // order were reversed, this test would fail with detected=false.
    await writeFile(join(repoRoot, ".claude"), "not a directory");
    await writeFile(join(repoRoot, ".mcp.json"), '{"mcpServers":{}}');
    const result = await claudeAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ intent: "all", trigger: "mcp.json-present" });
  });
});

// ===========================================================================
// I. detect is read-only (no fs mutation during detection)
// ===========================================================================

describe("claudeAdapter.detect -- read-only contract", () => {
  it("does not modify the repo directory tree (sorted readdir snapshot unchanged)", async () => {
    await writeFile(join(repoRoot, ".mcp.json"), '{"mcpServers":{}}');
    await mkdir(join(repoRoot, ".claude"));
    await writeFile(join(repoRoot, ".claude", "settings.json"), "{}");
    await writeFile(join(repoRoot, "user-file.txt"), "user content");

    const before = (await readdir(repoRoot)).sort();
    const beforeClaudeDir = (await readdir(join(repoRoot, ".claude"))).sort();

    await claudeAdapter.detect(makeCtx({ intent: "all" }));

    const after = (await readdir(repoRoot)).sort();
    const afterClaudeDir = (await readdir(join(repoRoot, ".claude"))).sort();
    expect(after).toEqual(before);
    expect(afterClaudeDir).toEqual(beforeClaudeDir);
  });
});

// ===========================================================================
// J. plan is read-only (no fs mutation during planning)
// ===========================================================================

describe("claudeAdapter.plan -- read-only contract", () => {
  it("does not modify the repo directory tree", async () => {
    await writeFile(join(repoRoot, ".mcp.json"), '{"mcpServers":{}}');
    const before = (await readdir(repoRoot)).sort();

    await claudeAdapter.plan(makeCtx());

    const after = (await readdir(repoRoot)).sort();
    expect(after).toEqual(before);
  });
});

// ===========================================================================
// K-Q. plan() shape + locked semantic fields
// ===========================================================================

describe("claudeAdapter.plan -- shape + locked semantic fields", () => {
  it("returns ApplicablePlan with adapterName 'Claude Code'", async () => {
    const plan = await claudeAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status === "applicable") {
      expect(plan.adapterName).toBe("Claude Code");
    }
  });

  it("plan.recordKey === 'claude' (durable storage key)", async () => {
    const plan = await claudeAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(plan.recordKey).toBe("claude");
  });

  it("plan.humanSummary is a non-empty string mentioning Claude Code", async () => {
    const plan = await claudeAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(typeof plan.humanSummary).toBe("string");
    expect(plan.humanSummary.length).toBeGreaterThan(0);
    expect(plan.humanSummary).toContain("Claude Code");
  });

  it("plan.meta is the empty object (no adapter-specific metadata in v1)", async () => {
    const plan = await claudeAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(plan.meta).toEqual({});
  });

  it("plan.ops has exactly one op", async () => {
    const plan = await claudeAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(plan.ops).toHaveLength(1);
  });

  it("plan.ops[0] is a json-key-merge with target=.mcp.json + keyPath=[mcpServers, viberevert] + value={type:stdio, command, args}", async () => {
    const plan = await claudeAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    const op = plan.ops[0];
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(op.kind).toBe("json-key-merge");
    if (op.kind !== "json-key-merge") return;
    expect(op.target.scope).toBe("repo");
    expect(op.target.pathRelative).toBe(".mcp.json");
    expect(op.target.pathTemplate).toBe("{repo}/.mcp.json");
    // Consistency lock between the two representations of the same path.
    expect(op.target.pathTemplate).toBe(`{repo}/${op.target.pathRelative}`);
    expect(op.keyPath).toEqual(["mcpServers", "viberevert"]);
    // Value is stdio-typed per docs.claude.com/docs/en/mcp-quickstart
    // (verified 2026-06-30); every documented stdio example carries
    // "type": "stdio".
    expect(op.value).toEqual(EXPECTED_MCP_VALUE);
  });

  it("plan.ops[0] target.pathRelative is a REPO-ROOT POSIX filename (no separators, no leading slash/backslash/colon/tilde; not under .claude/)", async () => {
    const plan = await claudeAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    const op = plan.ops[0];
    if (op === undefined) return;
    const path = op.target.pathRelative;
    expect(path.startsWith("/")).toBe(false);
    expect(path.startsWith("~")).toBe(false);
    expect(path.includes("\\")).toBe(false);
    expect(path.includes(":")).toBe(false);
    // Claude Code's project-scoped MCP config lives at the repo root
    // (--scope project); NOT under .claude/. Assert absence of "/"
    // (Cursor's .cursor/mcp.json DOES contain "/", so this is a
    // Claude-specific lock).
    expect(path.includes("/")).toBe(false);
    // Explicit protection against a future .claude/mcp.json confusion.
    expect(path).not.toBe(".claude/mcp.json");
  });
});

// ===========================================================================
// R. plan() determinism -- two calls return deep-equal results, even
// across varying ctx (plan is declarative; ctx must not influence output)
// ===========================================================================

describe("claudeAdapter.plan -- determinism + ctx-independence", () => {
  it("two successive plan() calls with the same ctx return deep-equal plans", async () => {
    const p1 = await claudeAdapter.plan(makeCtx());
    const p2 = await claudeAdapter.plan(makeCtx());
    expect(p1).toEqual(p2);
  });

  it("plan() ignores ctx differences (intent / options / cliVersion / now) -- declarative output", async () => {
    const pExplicit = await claudeAdapter.plan(makeCtx({ intent: "explicit" }));
    const pAllForced = await claudeAdapter.plan(
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
// S. plan() mutation safety -- mutating one returned plan does NOT leak
// into a subsequent plan() call (fresh nested structures per call)
// ===========================================================================

describe("claudeAdapter.plan -- mutation safety (fresh nested structures per call)", () => {
  it("mutating returned plan's keyPath/value/target does not affect a subsequent plan() call", async () => {
    const p1 = await claudeAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const op1 = p1.ops[0];
    if (op1 === undefined) throw new Error("expected one op");
    if (op1.kind !== "json-key-merge") throw new Error("expected json-key-merge");

    // Cast through unknown so the test can mutate readonly types --
    // the contract under test is runtime freshness, not type-level
    // readonly.
    const opMut = op1 as unknown as {
      keyPath: string[];
      value: { type: string; command: string; args: string[] };
      target: { pathRelative: string };
    };
    opMut.keyPath.push("MUTATED");
    opMut.value.type = "MUTATED";
    opMut.value.command = "MUTATED";
    opMut.value.args.push("MUTATED");
    opMut.target.pathRelative = "MUTATED";

    // Second call: every nested structure must be canonical.
    const p2 = await claudeAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    const op2 = p2.ops[0];
    if (op2 === undefined) throw new Error("expected one op");
    if (op2.kind !== "json-key-merge") throw new Error("expected json-key-merge");
    expect(op2.keyPath).toEqual(["mcpServers", "viberevert"]);
    expect(op2.value).toEqual(EXPECTED_MCP_VALUE);
    expect(op2.target.pathRelative).toBe(".mcp.json");
  });
});
