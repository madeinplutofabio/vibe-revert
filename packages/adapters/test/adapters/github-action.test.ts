// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { githubActionAdapter } from "../../src/adapters/github-action.js";
import { renderGitHubActionWorkflowInterior } from "../../src/adapters/github-action-template.js";
import type { AdapterContext } from "../../src/types.js";

const CLI_VERSION = "0.7.1-beta.0";
const BLOCK_ID = "github-action-workflow";
const SENTINEL_BEGIN_LINE = `# viberevert:begin:${BLOCK_ID}`;
const SENTINEL_END_LINE = `# viberevert:end:${BLOCK_ID}`;

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-github-action-adapter-"));
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
    cliVersion: CLI_VERSION,
    intent: "explicit",
    options: { forceReinstall: false, migrateFromHookInstall: false, forceUninstall: false },
  };
  return {
    ...base,
    ...overrides,
    options: { ...base.options, ...overrides.options },
  };
}

async function writeWorkflowFile(content: string): Promise<void> {
  await mkdir(join(repoRoot, ".github", "workflows"), { recursive: true });
  await writeFile(join(repoRoot, ".github", "workflows", "viberevert.yml"), content);
}

// A user-owned workflow that does NOT contain our sentinel.
const NON_VR_WORKFLOW = [
  "name: user CI",
  "on: [push]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hello",
  "",
].join("\n");

// ===========================================================================
// A. Adapter interface conformance
// ===========================================================================

describe("githubActionAdapter -- interface conformance", () => {
  it("exports name (string), detect (function), plan (function)", () => {
    expect(typeof githubActionAdapter.name).toBe("string");
    expect(githubActionAdapter.name.length).toBeGreaterThan(0);
    expect(typeof githubActionAdapter.detect).toBe("function");
    expect(typeof githubActionAdapter.plan).toBe("function");
  });
  it("name is 'GitHub Action' (display-only, distinct from durable recordKey)", () => {
    expect(githubActionAdapter.name).toBe("GitHub Action");
  });
});

// ===========================================================================
// B. detect() -- always positive (both intents)
// ===========================================================================

describe("githubActionAdapter.detect -- always positive", () => {
  it("returns detected=true with signal { detectPolicy: 'always' } under intent='explicit'", async () => {
    const result = await githubActionAdapter.detect(makeCtx({ intent: "explicit" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toEqual({ detectPolicy: "always" });
  });
  it("returns detected=true with signal { detectPolicy: 'always' } under intent='all' (--all exclusion lives at CLI, not adapter)", async () => {
    const result = await githubActionAdapter.detect(makeCtx({ intent: "all" }));
    expect(result.detected).toBe(true);
    expect(result.signal).toEqual({ detectPolicy: "always" });
  });
});

// ===========================================================================
// C. detect is read-only
// ===========================================================================

describe("githubActionAdapter.detect -- read-only contract", () => {
  it("does not modify the repo directory tree", async () => {
    await writeWorkflowFile(NON_VR_WORKFLOW);
    const before = (await readdir(repoRoot)).sort();
    const beforeGithub = (await readdir(join(repoRoot, ".github", "workflows"))).sort();

    await githubActionAdapter.detect(makeCtx());

    const after = (await readdir(repoRoot)).sort();
    const afterGithub = (await readdir(join(repoRoot, ".github", "workflows"))).sort();
    expect(after).toEqual(before);
    expect(afterGithub).toEqual(beforeGithub);
  });
});

// ===========================================================================
// D. plan() read-only across all four branches
// ===========================================================================

describe("githubActionAdapter.plan -- read-only contract", () => {
  it("branch 1 (file absent): does not modify the repo tree", async () => {
    const before = (await readdir(repoRoot)).sort();
    await githubActionAdapter.plan(makeCtx());
    const after = (await readdir(repoRoot)).sort();
    expect(after).toEqual(before);
  });

  it("branch 2 (sentinel present): does not modify the repo tree", async () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    const full = `${SENTINEL_BEGIN_LINE}\n${interior}\n${SENTINEL_END_LINE}\n`;
    await writeWorkflowFile(full);
    const before = (await readdir(join(repoRoot, ".github", "workflows"))).sort();
    await githubActionAdapter.plan(makeCtx());
    const after = (await readdir(join(repoRoot, ".github", "workflows"))).sort();
    expect(after).toEqual(before);
  });

  it("branch 3 (no sentinel + no force -> refused): does not modify the repo tree", async () => {
    await writeWorkflowFile(NON_VR_WORKFLOW);
    const before = (await readdir(join(repoRoot, ".github", "workflows"))).sort();
    await githubActionAdapter.plan(makeCtx());
    const after = (await readdir(join(repoRoot, ".github", "workflows"))).sort();
    expect(after).toEqual(before);
  });

  it("branch 4 (no sentinel + force -> backup-and-write): does not modify the repo tree", async () => {
    await writeWorkflowFile(NON_VR_WORKFLOW);
    const before = (await readdir(join(repoRoot, ".github", "workflows"))).sort();
    await githubActionAdapter.plan(makeCtx({ options: { forceReinstall: true } }));
    const after = (await readdir(join(repoRoot, ".github", "workflows"))).sort();
    expect(after).toEqual(before);
  });
});

// ===========================================================================
// E. plan() branch 1 -- file absent -> write-new
// ===========================================================================

describe("githubActionAdapter.plan -- branch 1: file absent -> write-new", () => {
  it("returns ApplicablePlan with a single write-new op targeting .github/workflows/viberevert.yml", async () => {
    const plan = await githubActionAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    expect(plan.recordKey).toBe("github-action");
    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.kind).toBe("write-new");
    if (op.kind !== "write-new") return;
    expect(op.target.scope).toBe("repo");
    expect(op.target.pathRelative).toBe(".github/workflows/viberevert.yml");
    expect(op.target.pathTemplate).toBe("{repo}/.github/workflows/viberevert.yml");
    expect(op.target.pathTemplate).toBe(`{repo}/${op.target.pathRelative}`);
  });

  it("write-new op content includes BOTH sentinel markers (interior is wrapped)", async () => {
    const plan = await githubActionAdapter.plan(makeCtx());
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "write-new") return;
    expect(op.content).toContain(SENTINEL_BEGIN_LINE);
    expect(op.content).toContain(SENTINEL_END_LINE);
    expect(op.content).toContain(renderGitHubActionWorkflowInterior(CLI_VERSION));
  });

  it("forceReinstall does NOT change branch 1 (absent -> write-new either way)", async () => {
    const plainPlan = await githubActionAdapter.plan(makeCtx());
    const forcedPlan = await githubActionAdapter.plan(
      makeCtx({ options: { forceReinstall: true } }),
    );
    if (plainPlan.status !== "applicable" || forcedPlan.status !== "applicable") return;
    expect(forcedPlan.ops[0]?.kind).toBe("write-new");
    expect(plainPlan.ops).toEqual(forcedPlan.ops);
  });
});

// ===========================================================================
// F. plan() branch 2 -- sentinel present -> sentinel-block-replace
// ===========================================================================

describe("githubActionAdapter.plan -- branch 2: sentinel present -> sentinel-block-replace", () => {
  it("returns ApplicablePlan with sentinel-block-replace op carrying INTERIOR ONLY (no markers)", async () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    const full = `${SENTINEL_BEGIN_LINE}\n${interior}\n${SENTINEL_END_LINE}\n`;
    await writeWorkflowFile(full);

    const plan = await githubActionAdapter.plan(makeCtx());
    if (plan.status !== "applicable") throw new Error("expected applicable");
    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.kind).toBe("sentinel-block-replace");
    if (op.kind !== "sentinel-block-replace") return;
    // Target lock -- same canonical target as branches 1/4.
    expect(op.target.scope).toBe("repo");
    expect(op.target.pathRelative).toBe(".github/workflows/viberevert.yml");
    expect(op.target.pathTemplate).toBe("{repo}/.github/workflows/viberevert.yml");
    expect(op.target.pathTemplate).toBe(`{repo}/${op.target.pathRelative}`);
    expect(op.blockId).toBe(BLOCK_ID);
    expect(op.content).toBe(interior);
    // Interior alone must NOT carry BEGIN/END markers -- installer wraps.
    expect(op.content).not.toContain(SENTINEL_BEGIN_LINE);
    expect(op.content).not.toContain(SENTINEL_END_LINE);
  });

  it("forceReinstall does NOT change branch 2 (sentinel-replace either way -- prevents needless backup of VR-owned workflow)", async () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    const full = `${SENTINEL_BEGIN_LINE}\n${interior}\n${SENTINEL_END_LINE}\n`;
    await writeWorkflowFile(full);

    const plainPlan = await githubActionAdapter.plan(makeCtx());
    const forcedPlan = await githubActionAdapter.plan(
      makeCtx({ options: { forceReinstall: true } }),
    );
    if (plainPlan.status !== "applicable" || forcedPlan.status !== "applicable") return;
    expect(plainPlan.ops[0]?.kind).toBe("sentinel-block-replace");
    expect(forcedPlan.ops[0]?.kind).toBe("sentinel-block-replace");
    expect(plainPlan.ops).toEqual(forcedPlan.ops);
  });

  it("uses CURRENT ctx.cliVersion even when disk block was written by an older CLI (installer decides noop/safe-update via SHA)", async () => {
    const oldInterior = renderGitHubActionWorkflowInterior("0.7.0-beta.0");
    const oldFull = `${SENTINEL_BEGIN_LINE}\n${oldInterior}\n${SENTINEL_END_LINE}\n`;
    await writeWorkflowFile(oldFull);

    const plan = await githubActionAdapter.plan(makeCtx({ cliVersion: CLI_VERSION }));
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "sentinel-block-replace") return;
    expect(op.content).toContain(CLI_VERSION);
    expect(op.content).not.toContain("0.7.0-beta.0");
  });
});

// ===========================================================================
// G. plan() branch 3 -- no sentinel + no force -> RefusedPlan
// ===========================================================================

describe("githubActionAdapter.plan -- branch 3: no sentinel + no force -> refused", () => {
  it("returns RefusedPlan { reasonCode: 'non-vr-workflow-present' } with actionable message + manualSnippet", async () => {
    await writeWorkflowFile(NON_VR_WORKFLOW);
    const plan = await githubActionAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status !== "refused") return;
    expect(plan.adapterName).toBe("GitHub Action");
    expect(plan.reasonCode).toBe("non-vr-workflow-present");
    expect(plan.message.length).toBeGreaterThan(0);
    expect(plan.message).toContain("viberevert.yml");
    // Message must name the recovery path so the CLI user can act on it.
    expect(plan.message).toContain("--force-reinstall");
    expect(plan.manualSnippet).toBe("viberevert install --github-action --force-reinstall");
  });
});

// ===========================================================================
// H. plan() branch 4 -- no sentinel + force -> backup-and-write
// ===========================================================================

describe("githubActionAdapter.plan -- branch 4: no sentinel + force -> backup-and-write", () => {
  it("returns ApplicablePlan with backup-and-write op carrying full wrapped content when forceReinstall=true", async () => {
    await writeWorkflowFile(NON_VR_WORKFLOW);
    const plan = await githubActionAdapter.plan(makeCtx({ options: { forceReinstall: true } }));
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.kind).toBe("backup-and-write");
    if (op.kind !== "backup-and-write") return;
    // Target lock -- same canonical target as branches 1/2.
    expect(op.target.scope).toBe("repo");
    expect(op.target.pathRelative).toBe(".github/workflows/viberevert.yml");
    expect(op.target.pathTemplate).toBe("{repo}/.github/workflows/viberevert.yml");
    expect(op.target.pathTemplate).toBe(`{repo}/${op.target.pathRelative}`);
    expect(op.content).toContain(SENTINEL_BEGIN_LINE);
    expect(op.content).toContain(SENTINEL_END_LINE);
    expect(op.content).toContain(renderGitHubActionWorkflowInterior(CLI_VERSION));
  });
});

// ===========================================================================
// I. plan() branch selection with non-file target (adapter-level only;
// engine preflight owns the final target-shape refusal)
// ===========================================================================

describe("githubActionAdapter.plan -- non-file target shape (branch selection only; preflight ownership defers to installers)", () => {
  it("directory at .github/workflows/viberevert.yml + no force -> RefusedPlan (non-vr-workflow-present)", async () => {
    // A directory at the target path cannot contain our sentinel, so
    // the adapter treats it identically to the "no sentinel" branch.
    // Without force, it returns RefusedPlan -- adapter-level short-
    // circuit, never reaches engine preflight.
    await mkdir(join(repoRoot, ".github", "workflows", "viberevert.yml"), { recursive: true });
    const plan = await githubActionAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status !== "refused") return;
    expect(plan.reasonCode).toBe("non-vr-workflow-present");
  });

  it("directory at .github/workflows/viberevert.yml + force -> ApplicablePlan backup-and-write (engine preflight refuses at write time; not an adapter concern)", async () => {
    // The adapter emits backup-and-write for the force path regardless
    // of whether the target is a regular file. Engine preflight owns
    // the target-shape / symlink refusal via
    // IntegrationTargetNotFileError / SymlinkTargetRefusal; this test
    // only asserts the adapter's branch selection.
    await mkdir(join(repoRoot, ".github", "workflows", "viberevert.yml"), { recursive: true });
    const plan = await githubActionAdapter.plan(makeCtx({ options: { forceReinstall: true } }));
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.kind).toBe("backup-and-write");
  });
});

// ===========================================================================
// J. Template locks -- pinning, permissions, security, LF/ASCII,
// package-manager scope, unpinned-action refs
// ===========================================================================

describe("renderGitHubActionWorkflowInterior -- content locks", () => {
  it("cliVersion is fully interpolated (no literal '<PINNED>' remains)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    expect(interior).not.toContain("<PINNED>");
    expect(interior).toContain(CLI_VERSION);
    expect(interior).toContain(`npm install -g viberevert@${CLI_VERSION}`);
  });

  it("different cliVersion inputs produce different interiors (proves cliVersion is threaded through)", () => {
    const a = renderGitHubActionWorkflowInterior("0.7.0-beta.0");
    const b = renderGitHubActionWorkflowInterior("0.7.1-beta.0");
    expect(a).not.toBe(b);
    expect(a).toContain("0.7.0-beta.0");
    expect(b).toContain("0.7.1-beta.0");
  });

  it("does NOT use unpinned `@latest` / `@beta` for the viberevert CLI (D101.K pinning discipline)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    expect(interior).not.toContain("viberevert@latest");
    expect(interior).not.toContain("viberevert@beta");
    expect(interior).toContain(`viberevert@${CLI_VERSION}`);
  });

  it("uses `npm install -g` with pinned version; NO npx, NO pnpm add -g (package-manager scope lock)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    expect(interior).toContain(`npm install -g viberevert@${CLI_VERSION}`);
    expect(interior).not.toContain("npx viberevert");
    expect(interior).not.toContain("pnpm add -g");
  });

  it("actions/checkout and actions/setup-node are pinned to major versions (never @main / @master)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    expect(interior).not.toContain("actions/checkout@main");
    expect(interior).not.toContain("actions/checkout@master");
    expect(interior).not.toContain("actions/setup-node@main");
    expect(interior).not.toContain("actions/setup-node@master");
    // Sanity: the intended pinned versions ARE present.
    expect(interior).toContain("actions/checkout@v5");
    expect(interior).toContain("actions/setup-node@v6");
  });

  it("full wrapped file parses as valid YAML via js-yaml; trigger keys present at string level (defense-in-depth against YAML 1.1 `on` boolean overlap)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    const full = `${SENTINEL_BEGIN_LINE}\n${interior}\n${SENTINEL_END_LINE}\n`;
    // String-level trigger locks first -- js-yaml's default schema is
    // YAML 1.2 core (where `on` is a plain string), but the string
    // check is a belt-and-braces guard against schema drift.
    expect(interior).toContain("on:");
    expect(interior).toContain("  pull_request:");
    expect(interior).toContain("  push:");
    const parsed = yaml.load(full) as {
      name?: unknown;
      permissions?: unknown;
      jobs?: unknown;
      on?: unknown;
    };
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    expect(parsed.name).toBe("VibeRevert risk check");
    expect(parsed).toHaveProperty("jobs");
    expect(parsed).toHaveProperty("permissions");
  });

  it("parsed YAML has permissions.contents: 'read' at the workflow level (D101.K least-privilege lock)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    const full = `${SENTINEL_BEGIN_LINE}\n${interior}\n${SENTINEL_END_LINE}\n`;
    const parsed = yaml.load(full) as { permissions?: { contents?: string } };
    expect(parsed.permissions).toBeDefined();
    expect(parsed.permissions?.contents).toBe("read");
  });

  it("does NOT declare `pull_request_target` as a trigger (D101.K security lock; interior AND full wrapped content)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    const full = `${SENTINEL_BEGIN_LINE}\n${interior}\n${SENTINEL_END_LINE}\n`;
    expect(interior).not.toContain("pull_request_target");
    // Wrapped-content check: the final emitted workflow (including
    // sentinel markers) must ALSO not mention pull_request_target.
    expect(full).not.toContain("pull_request_target");
    const parsed = yaml.load(full) as { on?: Record<string, unknown> };
    expect(parsed.on).toBeDefined();
    expect(parsed.on).not.toHaveProperty("pull_request_target");
    expect(parsed.on).toHaveProperty("pull_request");
    expect(parsed.on).toHaveProperty("push");
  });

  it("uses `viberevert check --since` for both PR and push diff ranges (verify-item 11 alignment)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    expect(interior).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax, not a JS template literal
      "viberevert check --since ${{ github.event.pull_request.base.sha }}",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax, not a JS template literal
    expect(interior).toContain("viberevert check --since ${{ github.event.before }}");
  });

  it("initial-push guard step is present (github.event.before all-zeros)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    expect(interior).toContain("0000000000000000000000000000000000000000");
    expect(interior).toContain("Initial push");
  });

  it("uses LF line endings (no CR characters in the interior)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    expect(interior.includes("\r")).toBe(false);
  });

  it("interior is ASCII-only (no bytes above 0x7F)", () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    for (let i = 0; i < interior.length; i++) {
      const codePoint = interior.codePointAt(i);
      expect(codePoint).toBeDefined();
      if (codePoint !== undefined) {
        expect(codePoint).toBeLessThanOrEqual(0x7f);
      }
    }
  });
});

// ===========================================================================
// K. plan() determinism -- deep-equal across successive calls
// ===========================================================================

describe("githubActionAdapter.plan -- determinism", () => {
  it("two successive plan() calls with the same absent-file scenario return deep-equal plans", async () => {
    const p1 = await githubActionAdapter.plan(makeCtx());
    const p2 = await githubActionAdapter.plan(makeCtx());
    expect(p1).toEqual(p2);
  });

  it("two successive plan() calls with the same sentinel-present scenario return deep-equal plans", async () => {
    const interior = renderGitHubActionWorkflowInterior(CLI_VERSION);
    const full = `${SENTINEL_BEGIN_LINE}\n${interior}\n${SENTINEL_END_LINE}\n`;
    await writeWorkflowFile(full);
    const p1 = await githubActionAdapter.plan(makeCtx());
    const p2 = await githubActionAdapter.plan(makeCtx());
    expect(p1).toEqual(p2);
  });
});

// ===========================================================================
// L. plan() mutation safety
// ===========================================================================

describe("githubActionAdapter.plan -- mutation safety", () => {
  it("mutating a returned plan's ops/target/content does not affect a subsequent plan() call", async () => {
    const p1 = await githubActionAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const op1 = p1.ops[0];
    if (op1 === undefined) throw new Error("expected one op");
    if (op1.kind !== "write-new") throw new Error("expected write-new");

    const opMut = op1 as unknown as {
      content: string;
      target: { pathRelative: string };
    };
    opMut.content = "MUTATED";
    opMut.target.pathRelative = "MUTATED";

    const p2 = await githubActionAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    const op2 = p2.ops[0];
    if (op2 === undefined) throw new Error("expected one op");
    if (op2.kind !== "write-new") throw new Error("expected write-new");
    expect(op2.content).toContain(SENTINEL_BEGIN_LINE);
    expect(op2.content).toContain(renderGitHubActionWorkflowInterior(CLI_VERSION));
    expect(op2.target.pathRelative).toBe(".github/workflows/viberevert.yml");
  });
});
