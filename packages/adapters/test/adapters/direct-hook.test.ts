// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { directHookAdapter } from "../../src/adapters/direct-hook.js";
import { HOOK_SCRIPT_TEMPLATE, MANAGED_BY_MARKER } from "../../src/hook-script.js";
import type { AdapterContext } from "../../src/types.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-direct-hook-adapter-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AdapterContext factory (deep-merge options, same pattern as cursor).
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

// ---------------------------------------------------------------------------
// Fixture helpers -- compose hook content via MANAGED_BY_MARKER +
// HOOK_SCRIPT_TEMPLATE. No hardcoded marker syntax or template lines,
// so the tests stay tracking with hook-script.ts changes (D98.M.14
// lock + D98.A11 marker discipline).
// ---------------------------------------------------------------------------

async function ensureHooksDir(): Promise<void> {
  await mkdir(join(repoRoot, ".git", "hooks"), { recursive: true });
}

async function writeVrManagedHookLF(): Promise<void> {
  await ensureHooksDir();
  await writeFile(
    join(repoRoot, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\n${MANAGED_BY_MARKER}\nrest of vr-managed hook\n`,
  );
}

async function writeVrManagedHookCRLF(): Promise<void> {
  await ensureHooksDir();
  await writeFile(
    join(repoRoot, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\r\n${MANAGED_BY_MARKER}\r\nrest of vr-managed hook\r\n`,
  );
}

async function writeUserOwnedHook(): Promise<void> {
  await ensureHooksDir();
  await writeFile(
    join(repoRoot, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\necho 'user-owned hook'\n",
  );
}

async function writeHookWithMarkerOnWrongLine(): Promise<void> {
  // Marker on line 1 (not line 2) -- per D98.A11 strict check,
  // this is NOT a vr-managed hook.
  await ensureHooksDir();
  await writeFile(
    join(repoRoot, ".git", "hooks", "pre-commit"),
    `${MANAGED_BY_MARKER}\n#!/bin/sh\nrest\n`,
  );
}

async function createHookAsDirectory(): Promise<void> {
  await mkdir(join(repoRoot, ".git", "hooks", "pre-commit"), { recursive: true });
}

async function createHuskyDir(): Promise<void> {
  await mkdir(join(repoRoot, ".husky"));
}

async function createLefthookYml(): Promise<void> {
  await writeFile(join(repoRoot, "lefthook.yml"), "pre-commit:\n  commands: {}\n");
}

// ===========================================================================
// A. Adapter interface conformance
// ===========================================================================

describe("directHookAdapter -- interface conformance", () => {
  it("exports name (string), detect (function), plan (function)", () => {
    expect(typeof directHookAdapter.name).toBe("string");
    expect(directHookAdapter.name.length).toBeGreaterThan(0);
    expect(typeof directHookAdapter.detect).toBe("function");
    expect(typeof directHookAdapter.plan).toBe("function");
  });
  it("name is 'Direct hook' (display-only, distinct from durable recordKey)", () => {
    expect(directHookAdapter.name).toBe("Direct hook");
  });
});

// ===========================================================================
// B-D. detect -- hook manager refusal layer (independent of hook file state)
// ===========================================================================

describe("directHookAdapter.detect -- hook manager refusal", () => {
  it("husky detected (.husky/ dir) -> detected=false with reason mentioning husky", async () => {
    await createHuskyDir();
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(false);
    if (result.detected === false) {
      expect(result.reason).toContain("husky");
    }
    expect(result.signal).toMatchObject({ husky: { signal: ".husky/ directory" } });
  });

  it("lefthook detected (lefthook.yml) -> detected=false with reason mentioning lefthook", async () => {
    await createLefthookYml();
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(false);
    if (result.detected === false) {
      expect(result.reason).toContain("lefthook");
    }
    expect(result.signal).toMatchObject({ lefthook: { signal: "lefthook.yml" } });
  });

  it("both husky and lefthook detected -> detected=false with reason mentioning both", async () => {
    await createHuskyDir();
    await createLefthookYml();
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(false);
    if (result.detected === false) {
      expect(result.reason).toContain("husky");
      expect(result.reason).toContain("lefthook");
    }
    expect(result.signal).toMatchObject({
      husky: { signal: ".husky/ directory" },
      lefthook: { signal: "lefthook.yml" },
    });
  });
});

// ===========================================================================
// E + E'. detect -- hook file state (no hook manager present)
// ===========================================================================

describe("directHookAdapter.detect -- hook file state (no hook manager)", () => {
  it("no .git/hooks/pre-commit -> detected=true with hookState 'absent'", async () => {
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ hookState: "absent" });
  });

  it("vr-managed hook (LF line endings) -> detected=true with hookState 'vr-managed'", async () => {
    await writeVrManagedHookLF();
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ hookState: "vr-managed" });
  });

  it("vr-managed hook (CRLF line endings) -> detected=true with hookState 'vr-managed' (marker + \\r tolerated)", async () => {
    await writeVrManagedHookCRLF();
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ hookState: "vr-managed" });
  });

  it("hook with marker on wrong line (line 1, not line 2) -> hookState 'user-owned' (strict line-2 check)", async () => {
    await writeHookWithMarkerOnWrongLine();
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ hookState: "user-owned" });
  });

  it("user-owned hook (no marker anywhere) -> detected=true with hookState 'user-owned'", async () => {
    await writeUserOwnedHook();
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ hookState: "user-owned" });
  });

  it(".git/hooks/pre-commit exists as a directory -> detected=true with hookState 'non-file'", async () => {
    // Directory at the hook path -- engine preflight refuses non-file
    // targets later (IntegrationTargetNotFileError). The adapter just
    // surfaces the state; engine owns the actual safety refusal.
    await createHookAsDirectory();
    const result = await directHookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    expect(result.signal).toMatchObject({ hookState: "non-file" });
  });
});

// ===========================================================================
// F. detect is read-only (no fs mutation during detection)
// ===========================================================================

describe("directHookAdapter.detect -- read-only contract", () => {
  it("does not modify the repo directory tree (sorted readdir snapshots unchanged)", async () => {
    await writeUserOwnedHook();
    await writeFile(join(repoRoot, "user-file.txt"), "user content");

    // Sort entries -- directory iteration order is not part of the
    // POSIX contract; sorting before compare keeps the test future-
    // proof across filesystems.
    const before = (await readdir(repoRoot)).sort();
    const beforeGit = (await readdir(join(repoRoot, ".git"))).sort();
    const beforeHooks = (await readdir(join(repoRoot, ".git", "hooks"))).sort();

    await directHookAdapter.detect(makeCtx());

    const after = (await readdir(repoRoot)).sort();
    const afterGit = (await readdir(join(repoRoot, ".git"))).sort();
    const afterHooks = (await readdir(join(repoRoot, ".git", "hooks"))).sort();

    expect(after).toEqual(before);
    expect(afterGit).toEqual(beforeGit);
    expect(afterHooks).toEqual(beforeHooks);
  });
});

// ===========================================================================
// G. plan() -- shape + locked semantic fields
// ===========================================================================

describe("directHookAdapter.plan -- shape + locked semantic fields", () => {
  it("returns ApplicablePlan with adapterName 'Direct hook' and recordKey 'direct-hook'", async () => {
    const plan = await directHookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    expect(plan.adapterName).toBe("Direct hook");
    expect(plan.recordKey).toBe("direct-hook");
  });

  it("plan.humanSummary is a non-empty string", async () => {
    const plan = await directHookAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(typeof plan.humanSummary).toBe("string");
    expect(plan.humanSummary.length).toBeGreaterThan(0);
  });

  it("plan.meta is the empty object (no adapter-specific metadata in v1)", async () => {
    const plan = await directHookAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    expect(plan.meta).toEqual({});
  });
});

// ===========================================================================
// H-J + non-file. plan() -- op kind per hook state
// ===========================================================================

describe("directHookAdapter.plan -- op kind selection per hook state", () => {
  it("absent hook -> ops[0] is write-new with HOOK_SCRIPT_TEMPLATE content and mode 0o755", async () => {
    const plan = await directHookAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    const op = plan.ops[0];
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(op.kind).toBe("write-new");
    if (op.kind !== "write-new") return;
    expect(op.target.scope).toBe("repo");
    expect(op.target.pathRelative).toBe(".git/hooks/pre-commit");
    expect(op.target.pathTemplate).toBe("{repo}/.git/hooks/pre-commit");
    expect(op.content).toBe(HOOK_SCRIPT_TEMPLATE);
    expect(op.mode).toBe(0o755);
  });

  it("vr-managed hook -> ops[0] is write-new (classifier handles adoption/noop/safe-update later via record SHA)", async () => {
    await writeVrManagedHookLF();
    const plan = await directHookAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.kind).toBe("write-new");
  });

  it("user-owned hook -> ops[0] is backup-and-write with HOOK_SCRIPT_TEMPLATE content and mode 0o755", async () => {
    await writeUserOwnedHook();
    const plan = await directHookAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    const op = plan.ops[0];
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(op.kind).toBe("backup-and-write");
    if (op.kind !== "backup-and-write") return;
    expect(op.target.pathRelative).toBe(".git/hooks/pre-commit");
    expect(op.content).toBe(HOOK_SCRIPT_TEMPLATE);
    expect(op.mode).toBe(0o755);
  });

  it("non-file hook (.git/hooks/pre-commit is a directory) -> ops[0] is write-new (engine will refuse via preflight)", async () => {
    await createHookAsDirectory();
    const plan = await directHookAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable plan");
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.kind).toBe("write-new");
  });

  it("plan.humanSummary differs between absent (write summary) and user-owned (backup summary)", async () => {
    const planAbsent = await directHookAdapter.plan(makeCtx());
    if (planAbsent.status !== "applicable") throw new Error("expected applicable");
    await writeUserOwnedHook();
    const planUser = await directHookAdapter.plan(makeCtx());
    if (planUser.status !== "applicable") throw new Error("expected applicable");
    expect(planUser.humanSummary).not.toBe(planAbsent.humanSummary);
  });
});

// ===========================================================================
// K. plan() target is repo-local POSIX
// ===========================================================================

describe("directHookAdapter.plan -- repo-local POSIX target", () => {
  it("target.pathRelative has no leading slash/backslash/colon/tilde", async () => {
    const plan = await directHookAdapter.plan(makeCtx());
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
// L. plan() content references HOOK_SCRIPT_TEMPLATE verbatim (constant
// reference equality; no hardcoded template lines anywhere in the test)
// ===========================================================================

describe("directHookAdapter.plan -- op.content references HOOK_SCRIPT_TEMPLATE verbatim", () => {
  it("absent + user-owned both emit op.content === HOOK_SCRIPT_TEMPLATE (renderer contract via constant compare)", async () => {
    const planAbsent = await directHookAdapter.plan(makeCtx());
    if (planAbsent.status !== "applicable") throw new Error("expected applicable");
    const opAbsent = planAbsent.ops[0];
    if (opAbsent === undefined) return;
    if (opAbsent.kind !== "write-new") return;
    expect(opAbsent.content).toBe(HOOK_SCRIPT_TEMPLATE);

    await writeUserOwnedHook();
    const planUser = await directHookAdapter.plan(makeCtx());
    if (planUser.status !== "applicable") throw new Error("expected applicable");
    const opUser = planUser.ops[0];
    if (opUser === undefined) return;
    if (opUser.kind !== "backup-and-write") return;
    expect(opUser.content).toBe(HOOK_SCRIPT_TEMPLATE);
  });
});

// ===========================================================================
// M. plan() mutation safety -- fresh nested structures per call
// (HOOK_SCRIPT_TEMPLATE is a primitive string and is NOT in the mutation
// set; the test mutates ops array + target + meta only)
// ===========================================================================

describe("directHookAdapter.plan -- mutation safety (fresh nested structures per call)", () => {
  it("mutating returned plan's ops array / target.pathRelative / meta does not affect a subsequent plan() call", async () => {
    const p1 = await directHookAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");

    // Cast through unknown so the test can mutate readonly types --
    // the contract under test is runtime freshness, not type-level
    // readonly. HOOK_SCRIPT_TEMPLATE (op.content) is intentionally NOT
    // in the mutation scope: strings are primitive and immutable.
    const p1Mut = p1 as unknown as {
      ops: Array<{ target: { pathRelative: string }; kind: string }>;
      meta: Record<string, unknown> & { extra?: unknown };
    };
    p1Mut.ops.push({ kind: "MUTATED-EXTRA", target: { pathRelative: "MUTATED" } });
    const op1 = p1Mut.ops[0];
    if (op1 !== undefined) {
      op1.target.pathRelative = "MUTATED-PATH";
    }
    p1Mut.meta.extra = "MUTATED-META";

    // Subsequent call: canonical ops length, canonical target,
    // empty meta. The fresh-nested-values discipline holds.
    const p2 = await directHookAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    expect(p2.ops).toHaveLength(1);
    const op2 = p2.ops[0];
    if (op2 === undefined) return;
    expect(op2.target.pathRelative).toBe(".git/hooks/pre-commit");
    expect(p2.meta).toEqual({});
  });
});

// ===========================================================================
// N. plan() determinism -- same fs state -> deep-equal plans
// ===========================================================================

describe("directHookAdapter.plan -- determinism", () => {
  it("two successive plan() calls against the same fs state return deep-equal plans", async () => {
    await writeUserOwnedHook();
    const p1 = await directHookAdapter.plan(makeCtx());
    const p2 = await directHookAdapter.plan(makeCtx());
    expect(p1).toEqual(p2);
  });
});
