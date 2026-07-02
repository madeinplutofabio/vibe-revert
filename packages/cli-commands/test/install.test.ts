// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as adapters from "@viberevert/adapters";
import * as installers from "@viberevert/installers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallCommand } from "../src/commands/install.js";
import { runCommandInProcess } from "../src/run-command-in-process.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-install-cli-"));
  await mkdir(join(repoRoot, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runInstall(...args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = await runCommandInProcess(InstallCommand, ["install", ...args], {
    cwd: repoRoot,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdoutBytes.toString("utf8"),
    stderr: result.stderrText,
  };
}

/**
 * Constructs an Error-like value whose prototype chain includes `cls`,
 * so `err instanceof cls` is true. Sidesteps binding to specific
 * installer/adapter constructor signatures.
 */
function makeKnownError(cls: { prototype: Error }, name: string, message: string): Error {
  const err = Object.create(cls.prototype) as Error;
  Object.assign(err, { name, message });
  return err;
}

function appliedOutcome(
  adapterName: string,
  recordKey: installers.RecordKey,
  humanSummary: string,
): installers.InstallOutcome {
  return {
    status: "applied",
    receipt: {
      recordKey,
      adapterName,
      opsApplied: 1,
      filesWritten: [],
      backupsCreated: [],
      integrationsJsonPath: join(repoRoot, ".viberevert", "integrations.json"),
      humanSummary,
    },
  };
}

// Minimal Husky ApplicablePlan factory with configurable migrate meta.
function huskyApplicablePlan(migrateFromDirectHook: boolean): adapters.AdapterPlan {
  return {
    status: "applicable",
    adapterName: "Husky",
    humanSummary: "Install pre-commit gate into Husky",
    ops: [],
    recordKey: "husky",
    meta: migrateFromDirectHook ? { migrateFromDirectHook: "true" } : {},
  };
}

// ===========================================================================
// A. Flag validation -- usage errors go to plain stderr + exit 1
// ===========================================================================

describe("InstallCommand -- flag validation", () => {
  it("no adapter flag and no --all -> stderr usage error, exit 1, no brackets", async () => {
    const { exitCode, stdout, stderr } = await runInstall();
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("No target adapter selected");
    expect(stderr).not.toContain("[");
  });

  it("--all + --cursor -> mutual-exclusivity error naming the offending flag", async () => {
    const { exitCode, stderr } = await runInstall("--all", "--cursor");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--all cannot be combined with explicit adapter flags");
    expect(stderr).toContain("--cursor");
  });

  it("--all + --github-action -> mutual-exclusivity error", async () => {
    const { exitCode, stderr } = await runInstall("--all", "--github-action");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--all cannot be combined");
  });

  it("--cursor + --claude -> multi-flag error", async () => {
    const { exitCode, stderr } = await runInstall("--cursor", "--claude");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Multiple explicit adapter flags");
  });

  it("--migrate-from-hook-install + --cursor -> requires-husky error", async () => {
    const { exitCode, stderr } = await runInstall("--cursor", "--migrate-from-hook-install");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--migrate-from-hook-install requires --husky alone");
  });

  it("--migrate-from-hook-install + --all -> rejected combination", async () => {
    const { exitCode, stderr } = await runInstall("--all", "--migrate-from-hook-install");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--migrate-from-hook-install cannot be combined with --all");
  });

  it("--dry-run + --migrate-from-hook-install -> semantic-conflict error", async () => {
    const { exitCode, stderr } = await runInstall(
      "--husky",
      "--migrate-from-hook-install",
      "--dry-run",
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--dry-run is incompatible with --migrate-from-hook-install");
  });

  it("validation runs BEFORE repo resolution (usage error surfaces outside a git repo)", async () => {
    await rm(join(repoRoot, ".git"), { recursive: true, force: true });
    const { exitCode, stdout, stderr } = await runInstall("--cursor", "--claude");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Multiple explicit adapter flags");
    expect(stderr).not.toMatch(/repo|\.git/i);
  });
});

// ===========================================================================
// B. --all iteration -- ship order + github-action excluded + mixed outcomes
// ===========================================================================

describe("InstallCommand -- --all iteration", () => {
  it("iterates 5 adapters in ship order; GitHub Action never invoked", async () => {
    const skip = { detected: false as const, reason: "test", signal: null };
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue(skip);
    vi.spyOn(adapters.directHookAdapter, "detect").mockResolvedValue(skip);
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue(skip);
    vi.spyOn(adapters.lefthookAdapter, "detect").mockResolvedValue(skip);
    vi.spyOn(adapters.claudeAdapter, "detect").mockResolvedValue(skip);
    const ghSpy = vi.spyOn(adapters.githubActionAdapter, "detect");

    const { exitCode, stdout } = await runInstall("--all");
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual([
      "[skipped: Cursor: test]",
      "[skipped: Direct hook: test]",
      "[skipped: Husky: test]",
      "[skipped: Lefthook: test]",
      "[skipped: Claude Code: test]",
    ]);
    expect(ghSpy).not.toHaveBeenCalled();
  });

  it("--all mixed outcomes preserve exact ship order + exit 1 on any refused", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({
      detected: false,
      reason: "no .cursor",
      signal: null,
    });
    vi.spyOn(adapters.directHookAdapter, "detect").mockResolvedValue({
      detected: true,
      signal: null,
    });
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.lefthookAdapter, "detect").mockResolvedValue({
      detected: true,
      signal: null,
    });
    vi.spyOn(adapters.claudeAdapter, "detect").mockResolvedValue({
      detected: false,
      reason: "no .mcp.json",
      signal: null,
    });

    // Real lefthook.plan() would refuse (no lefthook.yml on disk); mock
    // it to applicable so the apply-mock branch below controls the outcome.
    vi.spyOn(adapters.lefthookAdapter, "plan").mockResolvedValue({
      status: "applicable",
      adapterName: "Lefthook",
      humanSummary: "test",
      ops: [],
      recordKey: "lefthook",
      meta: {},
    });

    vi.spyOn(installers, "apply").mockImplementation(async (plan, _ctx) => {
      if (plan.status !== "applicable") throw new Error("test setup");
      if (plan.recordKey === "direct-hook") {
        return {
          status: "noop",
          recordKey: "direct-hook",
          adapterName: "Direct hook",
          reason: "already installed",
        };
      }
      if (plan.recordKey === "husky") {
        return appliedOutcome("Husky", "husky", "installed");
      }
      if (plan.recordKey === "lefthook") {
        return {
          status: "refused",
          recordKey: "lefthook",
          adapterName: "Lefthook",
          reasonCode: "IntegrationsContentDriftError",
          message: "drift",
        };
      }
      throw new Error(`unexpected recordKey: ${plan.recordKey}`);
    });

    const { exitCode, stdout } = await runInstall("--all");
    expect(exitCode).toBe(1);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual([
      "[skipped: Cursor: no .cursor]",
      "[noop: Direct hook: already installed]",
      "[applied: Husky: installed]",
      "[refused: Lefthook: IntegrationsContentDriftError: drift]",
      "[skipped: Claude Code: no .mcp.json]",
    ]);
  });
});

// ===========================================================================
// C. Detect flow
// ===========================================================================

describe("InstallCommand -- detect flow", () => {
  it("detected=false -> [skipped: <name>: <reason>]", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({
      detected: false,
      reason: "no .cursor directory",
      signal: null,
    });
    const { exitCode, stdout } = await runInstall("--cursor");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("[skipped: Cursor: no .cursor directory]\n");
  });

  it("detected=false -> plan/apply/preview NOT called (spy assertion)", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({
      detected: false,
      reason: "no .cursor",
      signal: null,
    });
    const planSpy = vi.spyOn(adapters.cursorAdapter, "plan");
    const applySpy = vi.spyOn(installers, "apply");
    const previewSpy = vi.spyOn(installers, "preview");
    await runInstall("--cursor");
    expect(planSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("detect() throws known adapter error -> [refused: <name>: <ErrName>: <message>]", async () => {
    const err = makeKnownError(
      adapters.HookManagerIoError,
      "HookManagerIoError",
      "EACCES on package.json",
    );
    vi.spyOn(adapters.huskyAdapter, "detect").mockRejectedValue(err);
    const { exitCode, stdout } = await runInstall("--husky");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("[refused: Husky: HookManagerIoError: EACCES on package.json]\n");
  });

  it("detect() throws unknown Error -> rethrown (harness surfaces the throw)", async () => {
    const err = new Error("mystery bug");
    vi.spyOn(adapters.cursorAdapter, "detect").mockRejectedValue(err);
    await expect(runInstall("--cursor")).rejects.toThrow("mystery bug");
  });
});

// ===========================================================================
// D. Plan flow
// ===========================================================================

describe("InstallCommand -- plan flow", () => {
  it("plan.status='refused' -> [refused: <name>: <reasonCode>: <message>]", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue({
      status: "refused",
      adapterName: "Husky",
      reasonCode: "vr-direct-hook-present",
      message: "existing vr direct hook",
    });
    const { exitCode, stdout } = await runInstall("--husky");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("[refused: Husky: vr-direct-hook-present: existing vr direct hook]\n");
  });

  it("plan() throws known installer error -> [refused: <name>: <ErrName>: <message>]", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    const err = makeKnownError(
      installers.IntegrationsLockError,
      "IntegrationsLockError",
      "Lock held",
    );
    vi.spyOn(adapters.cursorAdapter, "plan").mockRejectedValue(err);
    const { exitCode, stdout } = await runInstall("--cursor");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("[refused: Cursor: IntegrationsLockError: Lock held]\n");
  });
});

// ===========================================================================
// E. Apply outcomes
// ===========================================================================

describe("InstallCommand -- apply outcomes", () => {
  it("apply returns 'applied' -> [applied: <name>: <humanSummary>], exit 0", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(installers, "apply").mockResolvedValue(
      appliedOutcome("Cursor", "cursor", "Install VibeRevert MCP into Cursor"),
    );
    const { exitCode, stdout } = await runInstall("--cursor");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("[applied: Cursor: Install VibeRevert MCP into Cursor]\n");
  });

  it("apply returns 'noop' -> [noop: <name>: <reason>], exit 0", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(installers, "apply").mockResolvedValue({
      status: "noop",
      recordKey: "cursor",
      adapterName: "Cursor",
      reason: "already installed at current version",
    });
    const { exitCode, stdout } = await runInstall("--cursor");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("[noop: Cursor: already installed at current version]\n");
  });

  it("apply returns 'refused' -> [refused: <name>: <reasonCode>: <message>], exit 1", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(installers, "apply").mockResolvedValue({
      status: "refused",
      recordKey: "cursor",
      adapterName: "Cursor",
      reasonCode: "IntegrationsContentDriftError",
      message: "current on-disk SHA differs from record",
    });
    const { exitCode, stdout } = await runInstall("--cursor");
    expect(exitCode).toBe(1);
    expect(stdout).toBe(
      "[refused: Cursor: IntegrationsContentDriftError: current on-disk SHA differs from record]\n",
    );
  });

  it("apply throws known installer error -> [refused: <name>: <ErrName>: <message>]", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    const err = makeKnownError(
      installers.PendingIntegrationRecoveryError,
      "PendingIntegrationRecoveryError",
      "Recovery journal present",
    );
    vi.spyOn(installers, "apply").mockRejectedValue(err);
    const { exitCode, stdout } = await runInstall("--cursor");
    expect(exitCode).toBe(1);
    expect(stdout).toBe(
      "[refused: Cursor: PendingIntegrationRecoveryError: Recovery journal present]\n",
    );
  });

  it("apply throws unknown Error -> rethrown", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(installers, "apply").mockRejectedValue(new Error("engine bug"));
    await expect(runInstall("--cursor")).rejects.toThrow("engine bug");
  });
});

// ===========================================================================
// F. --dry-run
// ===========================================================================

describe("InstallCommand -- --dry-run", () => {
  it("--dry-run does NOT call apply() (spy assertion)", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    const applySpy = vi.spyOn(installers, "apply");
    vi.spyOn(installers, "preview").mockResolvedValue({
      status: "applicable",
      recordKey: "cursor",
      adapterName: "Cursor",
      diff: { perFile: [] },
      humanSummary: "Install VibeRevert MCP into Cursor",
    });
    await runInstall("--cursor", "--dry-run");
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("--dry-run 'applicable' with per-file diff -> [applicable:] header + indented diff", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(installers, "preview").mockResolvedValue({
      status: "applicable",
      recordKey: "cursor",
      adapterName: "Cursor",
      humanSummary: "Install VibeRevert MCP into Cursor",
      diff: {
        perFile: [
          {
            pathRelative: ".cursor/mcp.json",
            opKind: "json-key-merge",
            unifiedDiff: "@@ -1 +1,3 @@\n-{}\n+{...}",
          },
        ],
      },
    });
    const { exitCode, stdout } = await runInstall("--cursor", "--dry-run");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[applicable: Cursor: Install VibeRevert MCP into Cursor]\n");
    expect(stdout).toContain("  .cursor/mcp.json (json-key-merge)");
    expect(stdout).toContain("    @@ -1 +1,3 @@");
    expect(stdout).toContain("    -{}");
    expect(stdout).toContain("    +{...}");
  });

  it("--dry-run 'applicable' with empty perFile -> ONLY the header line (no blank indented tail)", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(installers, "preview").mockResolvedValue({
      status: "applicable",
      recordKey: "cursor",
      adapterName: "Cursor",
      humanSummary: "adopted existing managed state",
      diff: { perFile: [] },
    });
    const { exitCode, stdout } = await runInstall("--cursor", "--dry-run");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("[applicable: Cursor: adopted existing managed state]\n");
  });

  it("--dry-run 'refused' -> [refused] + exit 1", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(installers, "preview").mockResolvedValue({
      status: "refused",
      adapterName: "Cursor",
      reasonCode: "SymlinkTargetRefusal",
      message: "target through symlink",
    });
    const { exitCode, stdout } = await runInstall("--cursor", "--dry-run");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("[refused: Cursor: SymlinkTargetRefusal: target through symlink]\n");
  });

  it("--dry-run preview() throws unknown Error -> rethrown", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(installers, "preview").mockRejectedValue(new Error("preview bug"));
    await expect(runInstall("--cursor", "--dry-run")).rejects.toThrow("preview bug");
  });
});

// ===========================================================================
// G. --force-reinstall + --migrate-from-hook-install propagation into ctx
// ===========================================================================

describe("InstallCommand -- flag -> ctx.options propagation", () => {
  it("--force-reinstall sets ctx.options.forceReinstall=true", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    const applySpy = vi
      .spyOn(installers, "apply")
      .mockResolvedValue(appliedOutcome("Cursor", "cursor", "installed"));
    await runInstall("--cursor", "--force-reinstall");
    const ctxArg = applySpy.mock.calls[0]?.[1];
    expect(ctxArg?.options.forceReinstall).toBe(true);
  });

  it("no --force-reinstall -> ctx.options.forceReinstall=false", async () => {
    vi.spyOn(adapters.cursorAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    const applySpy = vi
      .spyOn(installers, "apply")
      .mockResolvedValue(appliedOutcome("Cursor", "cursor", "installed"));
    await runInstall("--cursor");
    const ctxArg = applySpy.mock.calls[0]?.[1];
    expect(ctxArg?.options.forceReinstall).toBe(false);
  });

  it("--migrate-from-hook-install sets ctx.options.migrateFromHookInstall=true in Husky plan/apply ctx", async () => {
    const detectSpy = vi
      .spyOn(adapters.huskyAdapter, "detect")
      .mockResolvedValue({ detected: true, signal: null });
    const planSpy = vi
      .spyOn(adapters.huskyAdapter, "plan")
      .mockResolvedValue(huskyApplicablePlan(false));
    const applySpy = vi
      .spyOn(installers, "apply")
      .mockResolvedValue(appliedOutcome("Husky", "husky", "installed"));
    await runInstall("--husky", "--migrate-from-hook-install");
    expect(detectSpy.mock.calls[0]?.[0].options.migrateFromHookInstall).toBe(true);
    expect(planSpy.mock.calls[0]?.[0].options.migrateFromHookInstall).toBe(true);
    expect(applySpy.mock.calls[0]?.[1].options.migrateFromHookInstall).toBe(true);
  });
});

// ===========================================================================
// H. Migration choreography (--migrate-from-hook-install)
// ===========================================================================

describe("InstallCommand -- --migrate-from-hook-install", () => {
  it("husky plan meta.migrateFromDirectHook='true' + apply succeeds -> uninstall called AFTER apply", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue(huskyApplicablePlan(true));
    const applySpy = vi
      .spyOn(installers, "apply")
      .mockResolvedValue(appliedOutcome("Husky", "husky", "Installed pre-commit gate into Husky"));
    const uninstallSpy = vi.spyOn(installers, "uninstall").mockResolvedValue({
      status: "uninstalled",
      receipt: {
        recordKey: "direct-hook",
        adapterName: "Direct hook",
        filesRemoved: [".git/hooks/pre-commit"],
        filesRestored: [],
        humanSummary: "Removed .git/hooks/pre-commit",
      },
    });

    const { exitCode, stdout } = await runInstall("--husky", "--migrate-from-hook-install");

    expect(exitCode).toBe(0);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(uninstallSpy).toHaveBeenCalledTimes(1);
    expect(uninstallSpy.mock.calls[0]?.[0]).toBe("direct-hook");
    const applyOrder = applySpy.mock.invocationCallOrder[0];
    const uninstallOrder = uninstallSpy.mock.invocationCallOrder[0];
    expect(applyOrder).toBeDefined();
    expect(uninstallOrder).toBeDefined();
    if (applyOrder !== undefined && uninstallOrder !== undefined) {
      expect(applyOrder).toBeLessThan(uninstallOrder);
    }
    expect(stdout).toContain("[applied: Husky:");
    expect(stdout).toContain("[applied: Direct hook: removed migrated direct hook]");
  });

  it("husky success WITHOUT plan meta migrate flag -> uninstall NOT called (plan-meta gate)", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue(huskyApplicablePlan(false));
    vi.spyOn(installers, "apply").mockResolvedValue(appliedOutcome("Husky", "husky", "installed"));
    const uninstallSpy = vi.spyOn(installers, "uninstall");

    const { exitCode, stdout } = await runInstall("--husky", "--migrate-from-hook-install");

    expect(exitCode).toBe(0);
    expect(uninstallSpy).not.toHaveBeenCalled();
    expect(stdout).toContain("[applied: Husky:");
    expect(stdout).not.toContain("Direct hook");
  });

  it("FAILED husky apply -> uninstall NOT called (control-flow lock)", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue(huskyApplicablePlan(true));
    vi.spyOn(installers, "apply").mockResolvedValue({
      status: "refused",
      recordKey: "husky",
      adapterName: "Husky",
      reasonCode: "SomeInstallerRefusal",
      message: "cannot apply",
    });
    const uninstallSpy = vi.spyOn(installers, "uninstall");

    const { exitCode, stdout } = await runInstall("--husky", "--migrate-from-hook-install");

    expect(exitCode).toBe(1);
    expect(uninstallSpy).not.toHaveBeenCalled();
    expect(stdout).toContain("[refused: Husky:");
    expect(stdout).not.toContain("Direct hook");
  });

  it("husky ADAPTER plan refused (RefusedPlan) -> neither apply nor uninstall called", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue({
      status: "refused",
      adapterName: "Husky",
      reasonCode: "vr-direct-hook-present",
      message: "direct hook already exists",
    });
    const applySpy = vi.spyOn(installers, "apply");
    const uninstallSpy = vi.spyOn(installers, "uninstall");

    const { exitCode } = await runInstall("--husky", "--migrate-from-hook-install");

    expect(exitCode).toBe(1);
    expect(applySpy).not.toHaveBeenCalled();
    expect(uninstallSpy).not.toHaveBeenCalled();
  });

  it("husky migration + cleanup 'not-installed' -> NO cleanup line, exit 0", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue(huskyApplicablePlan(true));
    vi.spyOn(installers, "apply").mockResolvedValue(appliedOutcome("Husky", "husky", "installed"));
    vi.spyOn(installers, "uninstall").mockResolvedValue({
      status: "not-installed",
      recordKey: "direct-hook",
      reason: "no direct-hook record",
    });

    const { exitCode, stdout } = await runInstall("--husky", "--migrate-from-hook-install");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[applied: Husky:");
    expect(stdout).not.toContain("Direct hook");
  });

  it("husky migration + cleanup 'refused' -> [refused: Direct hook: ...] + exit 1", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue(huskyApplicablePlan(true));
    vi.spyOn(installers, "apply").mockResolvedValue(appliedOutcome("Husky", "husky", "installed"));
    vi.spyOn(installers, "uninstall").mockResolvedValue({
      status: "refused",
      recordKey: "direct-hook",
      reasonCode: "IntegrationsContentDriftError",
      message: "hook bytes differ from record",
    });

    const { exitCode, stdout } = await runInstall("--husky", "--migrate-from-hook-install");

    expect(exitCode).toBe(1);
    expect(stdout).toContain("[applied: Husky:");
    expect(stdout).toContain(
      "[refused: Direct hook: IntegrationsContentDriftError: hook bytes differ from record]",
    );
  });

  it("husky migration + cleanup throws known installer error -> [refused: Direct hook: ...] + exit 1", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue(huskyApplicablePlan(true));
    vi.spyOn(installers, "apply").mockResolvedValue(appliedOutcome("Husky", "husky", "installed"));
    const err = makeKnownError(
      installers.IntegrationsLockError,
      "IntegrationsLockError",
      "lock held",
    );
    vi.spyOn(installers, "uninstall").mockRejectedValue(err);

    const { exitCode, stdout } = await runInstall("--husky", "--migrate-from-hook-install");

    expect(exitCode).toBe(1);
    expect(stdout).toContain("[applied: Husky:");
    expect(stdout).toContain("[refused: Direct hook: IntegrationsLockError: lock held]");
  });

  it("husky migration + cleanup uninstall throws unknown Error -> rethrown", async () => {
    vi.spyOn(adapters.huskyAdapter, "detect").mockResolvedValue({ detected: true, signal: null });
    vi.spyOn(adapters.huskyAdapter, "plan").mockResolvedValue(huskyApplicablePlan(true));
    vi.spyOn(installers, "apply").mockResolvedValue(appliedOutcome("Husky", "husky", "installed"));
    vi.spyOn(installers, "uninstall").mockRejectedValue(new Error("uninstall bug"));
    await expect(runInstall("--husky", "--migrate-from-hook-install")).rejects.toThrow(
      "uninstall bug",
    );
  });
});

// ===========================================================================
// I. RepoRootNotFoundError -> plain stderr, no brackets, no adapter calls
// ===========================================================================

describe("InstallCommand -- RepoRootNotFoundError", () => {
  it("temp dir with no .git -> plain stderr, exit 1, no brackets, no adapter methods invoked", async () => {
    await rm(join(repoRoot, ".git"), { recursive: true, force: true });
    const detectSpy = vi.spyOn(adapters.cursorAdapter, "detect");
    const { exitCode, stdout, stderr } = await runInstall("--cursor");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).not.toContain("[");
    expect(detectSpy).not.toHaveBeenCalled();
  });
});
