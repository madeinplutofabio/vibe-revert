// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for husky adapter -- packages/adapters/src/adapters/husky.ts.
 *
 * Coverage map (20 tests):
 *   A. Interface conformance (1)
 *   B-F. detect() flow: .husky/ dir (exact-match signal -- locked
 *        verbatim per hook-managers.ts architectural lock #11);
 *        package.json devDeps (SEMANTIC match -- package-json signal
 *        wording is hook-managers.ts's contract, not the adapter's);
 *        not-detected; LAYERING protection (vr direct hook does NOT
 *        affect detect when husky IS configured); read-only contract (5)
 *   G-L. plan() branches: vr direct-hook (LF marker) + no migrate ->
 *        refused; vr direct-hook (CRLF marker variant) + no migrate ->
 *        refused; vr direct-hook + migrate -> applicable + meta string
 *        "true"; no vr direct-hook + no migrate -> applicable + empty
 *        meta; migrate flag true + no vr direct-hook -> applicable +
 *        empty meta (NO marker -- flag alone is no-op); non-vr user
 *        direct hook -> applicable; marker-on-wrong-line -> applicable
 *        (7)
 *   M. Sentinel body semantic content -- contains required tokens
 *      (viberevert check / __VR_EC / prompt-fix / exit "$__VR_EC"),
 *      does NOT equal HOOK_SCRIPT_TEMPLATE (husky body must remain an
 *      embeddable block, not the full direct-hook script), does NOT
 *      contain direct-hook's `exit "$EC"` pattern (husky uses the
 *      namespaced __VR_EC) (1)
 *   N-O. Single sentinel-block-insert op against .husky/pre-commit
 *      (NOT .git/hooks/pre-commit -- redundant-but-load-bearing
 *      assertion: 4A's central promise is the husky adapter never
 *      emits an op touching the direct hook); repo-local POSIX path (2)
 *   P. Determinism -- two successive plan() calls deep-equal (1)
 *   Q-S. Mutation safety -- fresh ops/target/meta per call (3)
 *
 * Imports the adapter from its source file directly (per the locked
 * "Adapter tests should not require barrel export" pattern -- the
 * public barrel re-export is tested end-to-end in installers' smoke;
 * unit tests stay narrow and source-direct).
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { huskyAdapter } from "../../src/adapters/husky.js";
import { HOOK_SCRIPT_TEMPLATE, MANAGED_BY_MARKER } from "../../src/hook-script.js";
import type { AdapterContext } from "../../src/types.js";

const DIRECT_HOOK_REL = ".git/hooks/pre-commit";
const HUSKY_DIR_REL = ".husky";
const PACKAGE_JSON_REL = "package.json";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-husky-test-"));
  // Pre-create .git/hooks/ so DIRECT_HOOK_REL writes can land.
  await mkdir(join(repoRoot, ".git", "hooks"), { recursive: true });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCtx(
  opts: {
    readonly intent?: "explicit" | "all";
    readonly forceReinstall?: boolean;
    readonly migrateFromHookInstall?: boolean;
    readonly forceUninstall?: boolean;
  } = {},
): AdapterContext {
  return {
    repoRoot,
    now: new Date("2026-07-01T12:00:00.000Z"),
    cliVersion: "0.7.1-beta.0-test",
    intent: opts.intent ?? "explicit",
    options: {
      forceReinstall: opts.forceReinstall ?? false,
      migrateFromHookInstall: opts.migrateFromHookInstall ?? false,
      forceUninstall: opts.forceUninstall ?? false,
    },
  };
}

/**
 * Write the canonical VR-managed pre-commit hook (LF line endings)
 * using HOOK_SCRIPT_TEMPLATE verbatim so the marker lands on line 2
 * per D98.A11 (constant-reference fixture: drift in the template
 * propagates to the test automatically).
 */
async function writeVrDirectHookLF(): Promise<void> {
  await writeFile(join(repoRoot, DIRECT_HOOK_REL), HOOK_SCRIPT_TEMPLATE, "utf8");
}

/**
 * Write the canonical VR-managed pre-commit hook with CRLF line
 * endings. Exercises the CRLF-tolerance branch of
 * isVrManagedDirectHook (line 2 split on "\n" leaves trailing "\r"
 * on the marker; the helper accepts MANAGED_BY_MARKER + "\r" per
 * hook-script.ts D98.A11 narrow CRLF tolerance).
 */
async function writeVrDirectHookCRLF(): Promise<void> {
  const crlfContent = HOOK_SCRIPT_TEMPLATE.replace(/\n/g, "\r\n");
  await writeFile(join(repoRoot, DIRECT_HOOK_REL), crlfContent, "utf8");
}

/**
 * Write a user-owned (non-VR) pre-commit hook without the marker.
 */
async function writeUserDirectHook(): Promise<void> {
  const userScript = '#!/bin/sh\necho "user-owned pre-commit"\nexit 0\n';
  await writeFile(join(repoRoot, DIRECT_HOOK_REL), userScript, "utf8");
}

/**
 * Write a pre-commit hook whose content INCLUDES MANAGED_BY_MARKER but
 * NOT on line 2 (here it's on line 3). isVrManagedDirectHook MUST
 * return false -- protects against a future content.includes(MARKER)
 * drift.
 */
async function writeWrongLineMarkerDirectHook(): Promise<void> {
  const wrongLine = `#!/bin/sh\n# user comment\n${MANAGED_BY_MARKER}\necho "marker on wrong line"\nexit 0\n`;
  await writeFile(join(repoRoot, DIRECT_HOOK_REL), wrongLine, "utf8");
}

/**
 * Create .husky/ directory so detectHookManagers returns
 * husky.detected = true via the .husky/ directory signal.
 */
async function writeHuskyDir(): Promise<void> {
  await mkdir(join(repoRoot, HUSKY_DIR_REL));
}

/**
 * Create a package.json with husky in devDependencies so
 * detectHookManagers returns husky.detected = true via the
 * package.json devDeps signal. The signal STRING WORDING is owned by
 * hook-managers.ts; the adapter test asserts only that the signal
 * mentions "package.json" + "husky" (semantic), not the exact prose.
 */
async function writeHuskyInPackageJsonDevDeps(): Promise<void> {
  const pkg = JSON.stringify({ devDependencies: { husky: "^9.0.0" } }, null, 2);
  await writeFile(join(repoRoot, PACKAGE_JSON_REL), `${pkg}\n`, "utf8");
}

/**
 * Snapshot the repo's full file tree (sorted) for read-only assertions.
 * Returns relative POSIX paths; directories suffix with "/".
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
// A. Interface conformance
// ===========================================================================

describe("huskyAdapter -- Adapter interface conformance", () => {
  it("exposes name, detect, and plan with correct types", () => {
    expect(typeof huskyAdapter.name).toBe("string");
    expect(huskyAdapter.name).toBe("Husky");
    expect(typeof huskyAdapter.detect).toBe("function");
    expect(typeof huskyAdapter.plan).toBe("function");
  });
});

// ===========================================================================
// B-F. detect() flow
// ===========================================================================

describe("huskyAdapter.detect", () => {
  it("returns detected:true with husky signal when .husky/ directory is present (exact-match signal -- locked verbatim per hook-managers.ts)", async () => {
    await writeHuskyDir();
    const result = await huskyAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    if (result.detected) {
      // Exact-match: ".husky/ directory" is locked verbatim per
      // hook-managers.ts architectural lock #11.
      expect(result.signal).toMatchObject({
        husky: { signal: ".husky/ directory" },
      });
    }
  });

  it("returns detected:true with husky signal when package.json devDeps has husky (semantic match -- signal wording is hook-managers.ts's contract)", async () => {
    await writeHuskyInPackageJsonDevDeps();
    const result = await huskyAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    if (result.detected) {
      // Semantic check: detectHookManagers owns the exact prose.
      // The adapter just propagates the signal verbatim; package-
      // json signal wording is allowed to evolve in hook-managers.ts
      // without breaking this test.
      const signal = result.signal as { husky?: { signal?: unknown } };
      expect(String(signal.husky?.signal)).toContain("package.json");
      expect(String(signal.husky?.signal)).toContain("husky");
    }
  });

  it("returns detected:false with reason when husky is not configured", async () => {
    const result = await huskyAdapter.detect(makeCtx());
    expect(result.detected).toBe(false);
    if (!result.detected) {
      expect(result.reason).toContain("husky not detected");
    }
  });

  it("LAYERING: vr direct hook on disk does NOT affect husky detect (when husky IS configured)", async () => {
    // Husky IS configured AND a vr-managed direct hook is also present.
    // detect() must still return detected:true for husky -- the direct
    // hook conflict is plan()'s concern, not detect()'s. Protects the
    // layering between auto-discovery (detect) and install applicability
    // (plan).
    await writeHuskyDir();
    await writeVrDirectHookLF();
    const result = await huskyAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.signal).toMatchObject({
        husky: { signal: ".husky/ directory" },
      });
    }
  });

  it("detect() is read-only -- no fs mutations after the call", async () => {
    await writeHuskyDir();
    await writeVrDirectHookLF();
    const before = await snapshotRepoTree(repoRoot);
    await huskyAdapter.detect(makeCtx());
    const after = await snapshotRepoTree(repoRoot);
    expect(after).toEqual(before);
  });
});

// ===========================================================================
// G-L. plan() refusal / migration / non-vr / wrong-line branches
// ===========================================================================

describe("huskyAdapter.plan -- vr direct-hook (LF) present + no migrate flag", () => {
  it("returns RefusedPlan with vr-direct-hook-present reasonCode + user-facing message + manualSnippet", async () => {
    await writeVrDirectHookLF();
    const plan = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: false }));
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.adapterName).toBe("Husky");
      expect(plan.reasonCode).toBe("vr-direct-hook-present");
      expect(plan.message).toContain(".git/hooks/pre-commit");
      expect(plan.message).toContain("--migrate-from-hook-install");
      expect(plan.manualSnippet).toBe("viberevert install --husky --migrate-from-hook-install");
    }
  });
});

describe("huskyAdapter.plan -- vr direct-hook (CRLF marker variant) present + no migrate flag", () => {
  it("returns RefusedPlan when marker line is followed by CR (CRLF-drifted hook tolerated per D98.A11)", async () => {
    // CRLF tolerance: isVrManagedDirectHook accepts line 2 == MARKER
    // OR line 2 == MARKER + "\r" (when the hook file was checked out
    // on Windows with autocrlf=true). The husky adapter MUST refuse
    // both variants for symmetry with the LF case.
    await writeVrDirectHookCRLF();
    const plan = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: false }));
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("vr-direct-hook-present");
    }
  });
});

describe("huskyAdapter.plan -- vr direct-hook present + migrate flag", () => {
  it('returns ApplicablePlan with meta.migrateFromDirectHook = "true" (string, not boolean)', async () => {
    await writeVrDirectHookLF();
    const plan = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: true }));
    expect(plan.status).toBe("applicable");
    if (plan.status === "applicable") {
      // Step 2 integrations schema requires meta as Record<string, string>;
      // a boolean true would fail Zod parse downstream in
      // writeIntegrationsFile. toEqual would fail if the value were boolean
      // true, but an explicit typeof check is clearer about the contract.
      expect(plan.meta).toEqual({ migrateFromDirectHook: "true" });
      const metaTyped = plan.meta as Record<string, unknown> & {
        migrateFromDirectHook?: unknown;
      };
      expect(typeof metaTyped.migrateFromDirectHook).toBe("string");
      expect(metaTyped.migrateFromDirectHook).toBe("true");
    }
  });
});

describe("huskyAdapter.plan -- no vr direct-hook + no migrate flag", () => {
  it("returns ApplicablePlan with empty meta (no migration marker)", async () => {
    const plan = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: false }));
    expect(plan.status).toBe("applicable");
    if (plan.status === "applicable") {
      expect(plan.meta).toEqual({});
    }
  });
});

describe("huskyAdapter.plan -- migrate flag true + no vr direct-hook (no-op flag)", () => {
  it("returns ApplicablePlan with empty meta -- the flag alone does NOT set the migration marker", async () => {
    // No vr direct hook on disk; migrate flag passed. The marker is set
    // ONLY when we are actually migrating (vr direct hook present AND
    // flag true). The flag alone is a no-op signal -- otherwise
    // migrateFromDirectHook="true" would be a meaningless badge that
    // doesn't reflect a real migration.
    const plan = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: true }));
    expect(plan.status).toBe("applicable");
    if (plan.status === "applicable") {
      expect(plan.meta).toEqual({});
    }
  });
});

describe("huskyAdapter.plan -- non-vr-managed direct hook present", () => {
  it("returns ApplicablePlan (user-owned direct hook does NOT trigger vr-direct-hook-present refusal)", async () => {
    await writeUserDirectHook();
    const plan = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: false }));
    expect(plan.status).toBe("applicable");
    if (plan.status === "applicable") {
      expect(plan.meta).toEqual({});
    }
  });
});

describe("huskyAdapter.plan -- marker on wrong line of direct hook", () => {
  it("returns ApplicablePlan -- strict line-2 check rejects marker-on-wrong-line (protects against content.includes drift)", async () => {
    await writeWrongLineMarkerDirectHook();
    const plan = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: false }));
    expect(plan.status).toBe("applicable");
    if (plan.status === "applicable") {
      expect(plan.meta).toEqual({});
    }
  });
});

// ===========================================================================
// M. Sentinel body semantic content
// ===========================================================================

describe("huskyAdapter.plan -- sentinel body content", () => {
  it('body contains required tokens, is NOT the full HOOK_SCRIPT_TEMPLATE, and does NOT use direct-hook\'s exit "$EC" pattern', async () => {
    const plan = await huskyAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "sentinel-block-insert") return;

    // Required tokens (semantic check; exact body NOT asserted to keep
    // future message tweaks cheap).
    expect(op.content).toContain("viberevert check --staged");
    expect(op.content).toContain("__VR_EC=$?");
    expect(op.content).toContain("viberevert prompt-fix");
    expect(op.content).toContain('exit "$__VR_EC"');

    // Husky body is an EMBEDDABLE BLOCK, not the full direct-hook
    // script. Asserting NOT equal to HOOK_SCRIPT_TEMPLATE catches
    // future drift where someone might accidentally reuse the full
    // template here.
    expect(op.content).not.toBe(HOOK_SCRIPT_TEMPLATE);

    // Husky must use the namespaced __VR_EC (not direct-hook's `EC`)
    // to avoid clashing with a user-defined EC variable in their
    // husky chain. Catches a future drift where the body might be
    // copy-pasted from direct-hook.
    expect(op.content).not.toContain('exit "$EC"');
  });
});

// ===========================================================================
// N-O. Ops shape + repo-local POSIX
// ===========================================================================

describe("huskyAdapter.plan -- ops shape", () => {
  it("emits exactly one sentinel-block-insert op targeting .husky/pre-commit (NOT .git/hooks/pre-commit -- adapter never touches the direct hook)", async () => {
    const plan = await huskyAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.kind).toBe("sentinel-block-insert");
    if (op.kind !== "sentinel-block-insert") return;
    expect(op.target.pathRelative).toBe(".husky/pre-commit");
    // Redundant-but-load-bearing: 4A's central promise is that the
    // husky adapter never emits an op touching the direct hook. An
    // explicit negative assertion makes accidental regression noisy.
    expect(op.target.pathRelative).not.toBe(".git/hooks/pre-commit");
    expect(op.blockId).toBe("viberevert-husky-pre-commit");
    expect(op.anchor).toEqual({ mode: "append" });
    expect(plan.recordKey).toBe("husky");
  });
});

describe("huskyAdapter.plan -- repo-local POSIX path", () => {
  it("pathRelative + pathTemplate use POSIX forward slashes (no backslashes on Windows)", async () => {
    const plan = await huskyAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.target.pathRelative.includes("\\")).toBe(false);
    expect(op.target.pathTemplate.includes("\\")).toBe(false);
    expect(op.target.pathTemplate.startsWith("{repo}/")).toBe(true);
  });
});

// ===========================================================================
// P. Determinism
// ===========================================================================

describe("huskyAdapter.plan -- determinism", () => {
  it("two successive plan() calls against the same fs state return deep-equal plans", async () => {
    await writeUserDirectHook();
    const p1 = await huskyAdapter.plan(makeCtx());
    const p2 = await huskyAdapter.plan(makeCtx());
    expect(p1).toEqual(p2);
  });
});

// ===========================================================================
// Q-S. Mutation safety (fresh nested values per call)
// ===========================================================================

describe("huskyAdapter.plan -- mutation safety (fresh nested values per call)", () => {
  it("mutating returned plan's ops array does not affect a subsequent plan() call", async () => {
    const p1 = await huskyAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const p1Mut = p1 as unknown as {
      ops: Array<{ kind: string }>;
    };
    p1Mut.ops.push({ kind: "MUTATED-EXTRA" });
    const p2 = await huskyAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    expect(p2.ops).toHaveLength(1);
  });

  it("mutating returned plan's target.pathRelative does not affect a subsequent plan() call", async () => {
    const p1 = await huskyAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const p1Mut = p1 as unknown as {
      ops: Array<{ target: { pathRelative: string } }>;
    };
    const op1 = p1Mut.ops[0];
    if (op1 !== undefined) {
      op1.target.pathRelative = "MUTATED-PATH";
    }
    const p2 = await huskyAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    const op2 = p2.ops[0];
    if (op2 === undefined) return;
    expect(op2.target.pathRelative).toBe(".husky/pre-commit");
  });

  it("mutating returned plan's meta does not affect a subsequent plan() call", async () => {
    await writeVrDirectHookLF();
    const p1 = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: true }));
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const p1Mut = p1 as unknown as {
      meta: Record<string, unknown> & { extra?: unknown };
    };
    p1Mut.meta.extra = "MUTATED-META";
    const p2 = await huskyAdapter.plan(makeCtx({ migrateFromHookInstall: true }));
    if (p2.status !== "applicable") throw new Error("expected applicable");
    expect(p2.meta).toEqual({ migrateFromDirectHook: "true" });
  });
});
