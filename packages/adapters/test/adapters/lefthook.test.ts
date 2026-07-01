// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for lefthook adapter -- packages/adapters/src/adapters/lefthook.ts.
 *
 * Coverage map (35 tests):
 *   A. Interface conformance (1)
 *   B-F. detect() flow: lefthook.yml present (exact signal -- locked
 *        verbatim per hook-managers.ts arch lock #11); package.json
 *        devDeps (semantic match -- signal wording is hook-managers'
 *        contract); not-detected; LAYERING (vr direct hook on disk
 *        doesn't affect lefthook detect); read-only contract (5)
 *   G-R. plan() refusals (12):
 *        - non-file: lefthook.yml is a directory
 *        - non-file: lefthook-local.yml is a directory
 *        - local-only: only lefthook-local.yml exists (as file)
 *        - ambiguous: 2+ committed variants present
 *        - none: no config files at all
 *        - shape: no pre-commit.commands key
 *        - shape: flow-style YAML
 *        - shape: sibling key between
 *        - shape: tab indentation
 *        - shape: multiple top-level pre-commit.commands blocks
 *        - shape: ambiguous commands: line (commit-msg shares it)
 *        - already-present: existing manual viberevert-check
 *   S-Z3. plan() applicable (12):
 *        - sentinel block present in file -> applicable (NOT refused)
 *        - local-only-overridden-by-committed: lefthook-local.yml is
 *          ignored when a committed config also exists (target =
 *          committed file)
 *        - target matches each of 4 committed variants (describe.each)
 *        - 2-space indent -> viberevert-check sibling-aligns at 4 spaces
 *        - 4-space indent -> viberevert-check sibling-aligns at 8 spaces
 *        - empty commands: -> fallback to commandsIndent + 2 spaces
 *        - CRLF config -> applicable with no \r in marker
 *        - sentinel body semantic content check
 *        - anchor.marker captures matched commands: line verbatim
 *   AA. plan() invariants (5):
 *        - determinism
 *        - read-only via snapshot-tree
 *        - mutation safety: ops/target/meta (3)
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

import { lefthookAdapter } from "../../src/adapters/lefthook.js";
import { HOOK_SCRIPT_TEMPLATE } from "../../src/hook-script.js";
import type { AdapterContext } from "../../src/types.js";

// Fixture-relative paths.
const PACKAGE_JSON_REL = "package.json";
const DIRECT_HOOK_REL = ".git/hooks/pre-commit";
const LEFTHOOK_YML_REL = "lefthook.yml";
const LEFTHOOK_YAML_REL = "lefthook.yaml";
const DOT_LEFTHOOK_YML_REL = ".lefthook.yml";
const DOT_LEFTHOOK_YAML_REL = ".lefthook.yaml";
const LEFTHOOK_LOCAL_YML_REL = "lefthook-local.yml";

const ALL_COMMITTED_VARIANTS = [
  LEFTHOOK_YML_REL,
  LEFTHOOK_YAML_REL,
  DOT_LEFTHOOK_YML_REL,
  DOT_LEFTHOOK_YAML_REL,
] as const;

// ---------------------------------------------------------------------------
// Test content fixtures (LF-only). Constructed via array.join per
// D98.M.14 so cross-platform checkout (CRLF) cannot silently drift
// the fixture bytes.
// ---------------------------------------------------------------------------

const VALID_2SPACE = ["pre-commit:", "  commands:", "    eslint:", "      run: eslint .", ""].join(
  "\n",
);

const VALID_4SPACE = [
  "pre-commit:",
  "    commands:",
  "        eslint:",
  "            run: eslint .",
  "",
].join("\n");

const EMPTY_PRE_COMMIT_COMMANDS = ["pre-commit:", "  commands:", ""].join("\n");

const NO_PRE_COMMIT = ["commit-msg:", "  commands:", "    foo:", "      run: bar", ""].join("\n");

const FLOW_STYLE = "pre-commit: { commands: {} }\n";

const SIBLING_BETWEEN = [
  "pre-commit:",
  "  parallel: true",
  "  commands:",
  "    foo:",
  "      run: bar",
  "",
].join("\n");

const TAB_INDENT = ["pre-commit:", "\tcommands:", "\t\tfoo:", "\t\t\trun: bar", ""].join("\n");

const MULTI_PRE_COMMIT = [
  "pre-commit:",
  "  commands:",
  "    foo:",
  "      run: foo",
  "pre-commit:",
  "  commands:",
  "    bar:",
  "      run: bar",
  "",
].join("\n");

const COMMIT_MSG_AMBIGUITY = [
  "commit-msg:",
  "  commands:",
  "    lint:",
  "      run: echo ok",
  "",
  "pre-commit:",
  "  commands:",
  "    eslint:",
  "      run: eslint .",
  "",
].join("\n");

const MANUAL_VR_CHECK = [
  "pre-commit:",
  "  commands:",
  "    viberevert-check:",
  "      run: viberevert check --staged",
  "",
].join("\n");

const WITH_OUR_SENTINEL = [
  "pre-commit:",
  "  commands:",
  "# viberevert:begin:viberevert-lefthook-pre-commit",
  "    viberevert-check:",
  "      run: viberevert check --staged",
  "# viberevert:end:viberevert-lefthook-pre-commit",
  "    eslint:",
  "      run: eslint .",
  "",
].join("\n");

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-lefthook-test-"));
  // Pre-create .git/hooks/ so the LAYERING test can write a VR
  // direct hook (the only other fixture that touches .git/).
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

async function writeConfigFile(variant: string, content: string): Promise<void> {
  await writeFile(join(repoRoot, variant), content, "utf8");
}

async function createConfigDir(variant: string): Promise<void> {
  await mkdir(join(repoRoot, variant));
}

async function writeLefthookInPackageJsonDevDeps(): Promise<void> {
  const pkg = JSON.stringify({ devDependencies: { lefthook: "^1.0.0" } }, null, 2);
  await writeFile(join(repoRoot, PACKAGE_JSON_REL), `${pkg}\n`, "utf8");
}

async function writeVrDirectHook(): Promise<void> {
  await writeFile(join(repoRoot, DIRECT_HOOK_REL), HOOK_SCRIPT_TEMPLATE, "utf8");
}

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

describe("lefthookAdapter -- Adapter interface conformance", () => {
  it("exposes name, detect, and plan with correct types", () => {
    expect(typeof lefthookAdapter.name).toBe("string");
    expect(lefthookAdapter.name).toBe("Lefthook");
    expect(typeof lefthookAdapter.detect).toBe("function");
    expect(typeof lefthookAdapter.plan).toBe("function");
  });
});

// ===========================================================================
// B-F. detect() flow
// ===========================================================================

describe("lefthookAdapter.detect", () => {
  it("returns detected:true with lefthook signal when lefthook.yml is present (exact signal match -- locked verbatim per hook-managers.ts)", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    const result = await lefthookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    if (result.detected) {
      // Exact-match: "lefthook.yml" is locked verbatim per
      // hook-managers.ts architectural lock #11.
      expect(result.signal).toMatchObject({
        lefthook: { signal: "lefthook.yml" },
      });
    }
  });

  it("returns detected:true with lefthook signal when package.json devDeps has lefthook (semantic match -- signal wording is hook-managers.ts's contract)", async () => {
    await writeLefthookInPackageJsonDevDeps();
    const result = await lefthookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    if (result.detected) {
      // Semantic check: detectHookManagers owns the exact prose.
      // Package-json signal wording is allowed to evolve in
      // hook-managers.ts without breaking this test.
      const signal = result.signal as { lefthook?: { signal?: unknown } };
      expect(String(signal.lefthook?.signal)).toContain("package.json");
      expect(String(signal.lefthook?.signal)).toContain("lefthook");
    }
  });

  it("returns detected:false with reason when lefthook is not configured", async () => {
    const result = await lefthookAdapter.detect(makeCtx());
    expect(result.detected).toBe(false);
    if (!result.detected) {
      expect(result.reason).toContain("lefthook not detected");
    }
  });

  it("LAYERING: vr direct hook on disk does NOT affect lefthook detect (when lefthook IS configured)", async () => {
    // Lefthook IS configured AND a vr-managed direct hook is also
    // present. detect() must still return detected:true for lefthook
    // -- direct-hook presence is unrelated to lefthook detection.
    // (Unlike husky, lefthook adapter has no migration branch, so
    // direct-hook presence is doubly irrelevant.)
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    await writeVrDirectHook();
    const result = await lefthookAdapter.detect(makeCtx());
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.signal).toMatchObject({
        lefthook: { signal: "lefthook.yml" },
      });
    }
  });

  it("detect() is read-only -- no fs mutations after the call", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    await writeLefthookInPackageJsonDevDeps();
    const before = await snapshotRepoTree(repoRoot);
    await lefthookAdapter.detect(makeCtx());
    const after = await snapshotRepoTree(repoRoot);
    expect(after).toEqual(before);
  });
});

// ===========================================================================
// G-R. plan() refusals
// ===========================================================================

describe("lefthookAdapter.plan -- non-file refusal (committed variant is directory)", () => {
  it("refuses with lefthook-config-shape when lefthook.yml exists but is a directory", async () => {
    await createConfigDir(LEFTHOOK_YML_REL);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
      expect(plan.message).toContain("lefthook.yml");
      expect(plan.message).toContain("not regular files");
    }
  });
});

describe("lefthookAdapter.plan -- non-file refusal (lefthook-local.yml is directory)", () => {
  it("refuses with lefthook-config-shape when lefthook-local.yml exists but is a directory", async () => {
    await createConfigDir(LEFTHOOK_LOCAL_YML_REL);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
      expect(plan.message).toContain("lefthook-local.yml");
      expect(plan.message).toContain("not regular files");
    }
  });
});

describe("lefthookAdapter.plan -- local-only refusal", () => {
  it("refuses with lefthook-config-only-in-local when only lefthook-local.yml exists (as a file)", async () => {
    await writeConfigFile(LEFTHOOK_LOCAL_YML_REL, VALID_2SPACE);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-only-in-local");
      expect(plan.message).toContain("lefthook-local.yml");
      expect(plan.manualSnippet).toContain("pre-commit:");
      expect(plan.manualSnippet).toContain("viberevert-check:");
    }
  });
});

describe("lefthookAdapter.plan -- ambiguous refusal", () => {
  it("refuses with lefthook-config-ambiguous when 2 committed variants exist", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    await writeConfigFile(DOT_LEFTHOOK_YML_REL, VALID_2SPACE);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-ambiguous");
      expect(plan.message).toContain("lefthook.yml");
      expect(plan.message).toContain(".lefthook.yml");
    }
  });
});

describe("lefthookAdapter.plan -- none refusal (no config files at all)", () => {
  it("refuses with lefthook-config-shape when no lefthook config files exist", async () => {
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
      expect(plan.message).toContain("No lefthook configuration file found");
    }
  });
});

describe("lefthookAdapter.plan -- shape refusals (single reason code, multiple message variants)", () => {
  it("refuses with lefthook-config-shape when pre-commit.commands key is absent", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, NO_PRE_COMMIT);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
      expect(plan.message).toContain("does not contain a recognized pre-commit.commands block");
    }
  });

  it("refuses with lefthook-config-shape for flow-style YAML", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, FLOW_STYLE);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
    }
  });

  it("refuses with lefthook-config-shape for sibling key between pre-commit and commands", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, SIBLING_BETWEEN);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
    }
  });

  it("refuses with lefthook-config-shape for tab-indented commands: line", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, TAB_INDENT);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
    }
  });

  it("refuses with lefthook-config-shape when multiple top-level pre-commit.commands blocks exist", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, MULTI_PRE_COMMIT);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
      expect(plan.message).toContain("top-level pre-commit.commands blocks");
    }
  });

  it("refuses with lefthook-config-shape (ambiguous) when commit-msg.commands shares the same commands: line as pre-commit", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, COMMIT_MSG_AMBIGUITY);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-config-shape");
      expect(plan.message).toContain("ambiguous");
      expect(plan.message).toContain("commands:");
    }
  });
});

describe("lefthookAdapter.plan -- already-present refusal", () => {
  it("refuses with lefthook-viberevert-command-already-present when unmanaged viberevert-check exists (no sentinel)", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, MANUAL_VR_CHECK);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") {
      expect(plan.reasonCode).toBe("lefthook-viberevert-command-already-present");
      expect(plan.message).toContain("viberevert-check:");
    }
  });
});

// ===========================================================================
// S-Z3. plan() applicable
// ===========================================================================

describe("lefthookAdapter.plan -- our sentinel block already present", () => {
  it("returns applicable (NOT refused) so engine classifier can determine noop/safe-update for managed sentinel content", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, WITH_OUR_SENTINEL);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
  });
});

describe("lefthookAdapter.plan -- local-only overridden by committed config", () => {
  it("ignores lefthook-local.yml when exactly one committed config exists (target = committed file)", async () => {
    // Locked behavior of resolveLefthookConfigTarget: when both a
    // committed variant AND lefthook-local.yml exist as regular
    // files, the committed variant wins; lefthook-local.yml is
    // ignored. The "local-only refusal" rule only fires when
    // lefthook-local.yml is the ONLY config file present.
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    await writeConfigFile(LEFTHOOK_LOCAL_YML_REL, VALID_4SPACE);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.target.pathRelative).toBe("lefthook.yml");
  });
});

describe.each(
  ALL_COMMITTED_VARIANTS,
)("lefthookAdapter.plan -- target matches detected variant (%s)", (variant) => {
  it(`emits op targeting ${variant} when ${variant} is the sole committed config`, async () => {
    await writeConfigFile(variant, VALID_2SPACE);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0];
    if (op === undefined) return;
    expect(op.target.pathRelative).toBe(variant);
    expect(op.target.pathTemplate).toBe(`{repo}/${variant}`);
  });
});

describe("lefthookAdapter.plan -- indentation handling", () => {
  it("2-space commands: with 4-space existing child -> viberevert-check sibling-aligns at 4 spaces", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "sentinel-block-insert") return;
    // viberevert-check at 4 spaces (aligns with existing eslint at 4 spaces).
    expect(op.content).toContain("    viberevert-check:");
    expect(op.content).toContain("      run: viberevert check --staged");
  });

  it("4-space commands: with 8-space existing child -> viberevert-check sibling-aligns at 8 spaces", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_4SPACE);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "sentinel-block-insert") return;
    // viberevert-check at 8 spaces (aligns with existing eslint at 8 spaces).
    expect(op.content).toContain("        viberevert-check:");
    expect(op.content).toContain("          run: viberevert check --staged");
  });

  it("empty commands: section -> falls back to commandsIndent + 2 spaces (no existing children to align with)", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, EMPTY_PRE_COMMIT_COMMANDS);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "sentinel-block-insert") return;
    // commandsIndent = "  " (2 spaces). Fallback childIndent = "    "
    // (4 spaces). runIndent = "      " (6 spaces).
    expect(op.content).toContain("    viberevert-check:");
    expect(op.content).toContain("      run: viberevert check --staged");
  });
});

describe("lefthookAdapter.plan -- CRLF config", () => {
  it('applicable with no "\\r" in anchor.marker (engine handles CRLF normalization per D101.Q)', async () => {
    const crlfContent = VALID_2SPACE.replace(/\n/g, "\r\n");
    await writeConfigFile(LEFTHOOK_YML_REL, crlfContent);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "sentinel-block-insert") return;
    if (op.anchor.mode !== "after-marker") return;
    // The regex's commands:[ \t]* group captures ONLY horizontal
    // whitespace before the \r?\n; the \r is consumed by the regex
    // boundary, not by the marker group. Marker has no \r.
    expect(op.anchor.marker.includes("\r")).toBe(false);
    expect(op.anchor.marker).toBe("  commands:");
  });
});

describe("lefthookAdapter.plan -- sentinel body content", () => {
  it("body contains required tokens; blockId namespaced; recordKey matches lefthook", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "sentinel-block-insert") return;
    // Semantic content (exact body NOT asserted to keep future message
    // tweaks cheap).
    expect(op.content).toContain("viberevert-check:");
    expect(op.content).toContain("run: viberevert check --staged");
    // Lefthook body is plain YAML -- must NOT contain shell-specific
    // tokens from direct-hook / husky bodies.
    expect(op.content).not.toContain("__VR_EC");
    expect(op.content).not.toContain('exit "$EC"');
    expect(op.blockId).toBe("viberevert-lefthook-pre-commit");
    expect(plan.recordKey).toBe("lefthook");
  });
});

describe("lefthookAdapter.plan -- anchor.marker captures matched commands: line verbatim (including trailing whitespace)", () => {
  it("preserves trailing horizontal whitespace on the commands: line", async () => {
    // The user's commands: line has trailing 2 spaces; the regex
    // captures it verbatim into commandsLine, and that EXACT line
    // becomes the after-marker target. findWholeLine does whole-line
    // matching, so the trailing-whitespace variant only matches the
    // user's actual line (no false positives on a stripped variant).
    const withTrailingSpace = [
      "pre-commit:",
      "  commands:  ",
      "    eslint:",
      "      run: eslint .",
      "",
    ].join("\n");
    await writeConfigFile(LEFTHOOK_YML_REL, withTrailingSpace);
    const plan = await lefthookAdapter.plan(makeCtx());
    expect(plan.status).toBe("applicable");
    if (plan.status !== "applicable") return;
    const op = plan.ops[0];
    if (op === undefined || op.kind !== "sentinel-block-insert") return;
    if (op.anchor.mode !== "after-marker") return;
    expect(op.anchor.marker).toBe("  commands:  ");
  });
});

// ===========================================================================
// AA. plan() invariants
// ===========================================================================

describe("lefthookAdapter.plan -- determinism", () => {
  it("two successive plan() calls against the same fs state return deep-equal plans", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    const p1 = await lefthookAdapter.plan(makeCtx());
    const p2 = await lefthookAdapter.plan(makeCtx());
    expect(p1).toEqual(p2);
  });
});

describe("lefthookAdapter.plan -- read-only contract", () => {
  it("plan() is read-only -- no fs mutations after the call (applicable path with config read)", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    const before = await snapshotRepoTree(repoRoot);
    await lefthookAdapter.plan(makeCtx());
    const after = await snapshotRepoTree(repoRoot);
    expect(after).toEqual(before);
  });
});

describe("lefthookAdapter.plan -- mutation safety (fresh nested values per call)", () => {
  it("mutating returned plan's ops array does not affect a subsequent plan() call", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    const p1 = await lefthookAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const p1Mut = p1 as unknown as {
      ops: Array<{ kind: string }>;
    };
    p1Mut.ops.push({ kind: "MUTATED-EXTRA" });
    const p2 = await lefthookAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    expect(p2.ops).toHaveLength(1);
  });

  it("mutating returned plan's target.pathRelative does not affect a subsequent plan() call", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    const p1 = await lefthookAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const p1Mut = p1 as unknown as {
      ops: Array<{ target: { pathRelative: string } }>;
    };
    const op1 = p1Mut.ops[0];
    if (op1 !== undefined) {
      op1.target.pathRelative = "MUTATED-PATH";
    }
    const p2 = await lefthookAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    const op2 = p2.ops[0];
    if (op2 === undefined) return;
    expect(op2.target.pathRelative).toBe("lefthook.yml");
  });

  it("mutating returned plan's meta does not affect a subsequent plan() call", async () => {
    await writeConfigFile(LEFTHOOK_YML_REL, VALID_2SPACE);
    const p1 = await lefthookAdapter.plan(makeCtx());
    if (p1.status !== "applicable") throw new Error("expected applicable");
    const p1Mut = p1 as unknown as {
      meta: Record<string, unknown> & { extra?: unknown };
    };
    p1Mut.meta.extra = "MUTATED-META";
    const p2 = await lefthookAdapter.plan(makeCtx());
    if (p2.status !== "applicable") throw new Error("expected applicable");
    // Lefthook always emits empty meta; ensure mutation didn't persist.
    expect(p2.meta).toEqual({});
  });
});
