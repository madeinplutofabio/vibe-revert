// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as adapters from "@viberevert/adapters";
import * as installers from "@viberevert/installers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UninstallCommand } from "../src/commands/uninstall.js";
import { runCommandInProcess } from "../src/run-command-in-process.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-uninstall-cli-"));
  await mkdir(join(repoRoot, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runUninstall(...args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = await runCommandInProcess(UninstallCommand, ["uninstall", ...args], {
    cwd: repoRoot,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdoutBytes.toString("utf8"),
    stderr: result.stderrText,
  };
}

function makeKnownError(cls: { prototype: Error }, name: string, message: string): Error {
  const err = Object.create(cls.prototype) as Error;
  Object.assign(err, { name, message });
  return err;
}

function uninstalledOutcome(
  adapterName: string,
  recordKey: installers.RecordKey,
  humanSummary: string,
): installers.UninstallOutcome {
  return {
    status: "uninstalled",
    receipt: {
      recordKey,
      adapterName,
      filesRemoved: [],
      filesRestored: [],
      humanSummary,
    },
  };
}

// ===========================================================================
// A. Flag validation -- usage errors go to plain stderr + exit 1
// ===========================================================================

describe("UninstallCommand -- flag validation", () => {
  it("no adapter flag and no --all -> stderr usage error, exit 1, no brackets", async () => {
    const { exitCode, stdout, stderr } = await runUninstall();
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("No target adapter selected");
    expect(stderr).not.toContain("[");
  });

  it("--all + --cursor -> mutual-exclusivity error", async () => {
    const { exitCode, stderr } = await runUninstall("--all", "--cursor");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--all cannot be combined with explicit adapter flags");
    expect(stderr).toContain("--cursor");
  });

  it("--all + --github-action -> mutual-exclusivity error", async () => {
    const { exitCode, stderr } = await runUninstall("--all", "--github-action");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--all cannot be combined");
  });

  it("--cursor + --claude -> multi-flag error", async () => {
    const { exitCode, stderr } = await runUninstall("--cursor", "--claude");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Multiple explicit adapter flags");
  });

  it("--force alone (no target) -> usage error", async () => {
    const { exitCode, stderr } = await runUninstall("--force");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No target adapter selected");
  });

  it("validation runs BEFORE repo resolution (usage error surfaces outside a git repo)", async () => {
    await rm(join(repoRoot, ".git"), { recursive: true, force: true });
    const { exitCode, stdout, stderr } = await runUninstall("--cursor", "--claude");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Multiple explicit adapter flags");
    expect(stderr).not.toMatch(/repo|\.git/i);
  });

  it("--dry-run is not declared on uninstall (unknown flag rejected)", async () => {
    await expect(runUninstall("--cursor", "--dry-run")).rejects.toThrow(/dry-run/);
  });
});

// ===========================================================================
// B. --all iteration + continue-on-refusal + unknown-stops
// ===========================================================================

describe("UninstallCommand -- --all iteration", () => {
  it("iterates 5 adapters in ship order; GitHub Action never invoked", async () => {
    const uninstallSpy = vi
      .spyOn(installers, "uninstall")
      .mockImplementation(async (recordKey) => ({
        status: "not-installed",
        recordKey,
        reason: "no record",
      }));

    const { exitCode, stdout } = await runUninstall("--all");
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual([
      "[noop: Cursor: no record]",
      "[noop: Direct hook: no record]",
      "[noop: Husky: no record]",
      "[noop: Lefthook: no record]",
      "[noop: Claude Code: no record]",
    ]);
    const recordKeysCalled = uninstallSpy.mock.calls.map((c) => c[0]);
    expect(recordKeysCalled).toEqual(["cursor", "direct-hook", "husky", "lefthook", "claude"]);
    expect(recordKeysCalled).not.toContain("github-action");
  });

  it("--all mixed outcomes preserve exact ship order + continue after refusal (exit 1)", async () => {
    vi.spyOn(installers, "uninstall").mockImplementation(async (recordKey) => {
      if (recordKey === "cursor") {
        return uninstalledOutcome("Cursor", "cursor", "removed");
      }
      if (recordKey === "direct-hook") {
        return { status: "not-installed", recordKey: "direct-hook", reason: "no record" };
      }
      if (recordKey === "husky") {
        return { status: "not-installed", recordKey: "husky", reason: "no record" };
      }
      if (recordKey === "lefthook") {
        return {
          status: "refused",
          recordKey: "lefthook",
          reasonCode: "IntegrationsContentDriftError",
          message: "drift",
        };
      }
      if (recordKey === "claude") {
        return { status: "not-installed", recordKey: "claude", reason: "no record" };
      }
      throw new Error(`unexpected ${recordKey}`);
    });

    const { exitCode, stdout } = await runUninstall("--all");
    expect(exitCode).toBe(1);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual([
      "[uninstalled: Cursor: removed]",
      "[noop: Direct hook: no record]",
      "[noop: Husky: no record]",
      "[refused: Lefthook: IntegrationsContentDriftError: drift]",
      "[noop: Claude Code: no record]",
    ]);
  });

  it("--all continues after known thrown InstallerError; final exit 1", async () => {
    vi.spyOn(installers, "uninstall").mockImplementation(async (recordKey) => {
      if (recordKey === "direct-hook") {
        throw makeKnownError(
          installers.IntegrationsLockError,
          "IntegrationsLockError",
          "lock held",
        );
      }
      return { status: "not-installed", recordKey, reason: "no record" };
    });

    const { exitCode, stdout } = await runUninstall("--all");
    expect(exitCode).toBe(1);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual([
      "[noop: Cursor: no record]",
      "[refused: Direct hook: IntegrationsLockError: lock held]",
      "[noop: Husky: no record]",
      "[noop: Lefthook: no record]",
      "[noop: Claude Code: no record]",
    ]);
  });

  it("--all STOPS immediately on unknown thrown error (rethrown; later adapters NOT called)", async () => {
    const uninstallSpy = vi.spyOn(installers, "uninstall").mockImplementation(async (recordKey) => {
      if (recordKey === "cursor") {
        return { status: "not-installed", recordKey: "cursor", reason: "no record" };
      }
      if (recordKey === "direct-hook") {
        throw new Error("mystery bug");
      }
      return { status: "not-installed", recordKey, reason: "no record" };
    });

    await expect(runUninstall("--all")).rejects.toThrow("mystery bug");
    const recordKeysCalled = uninstallSpy.mock.calls.map((c) => c[0]);
    expect(recordKeysCalled).toEqual(["cursor", "direct-hook"]);
  });
});

// ===========================================================================
// C. Uninstall outcomes
// ===========================================================================

describe("UninstallCommand -- outcomes", () => {
  it("'uninstalled' -> [uninstalled: <name>: <humanSummary>], exit 0", async () => {
    vi.spyOn(installers, "uninstall").mockResolvedValue(
      uninstalledOutcome("Cursor", "cursor", "removed .cursor/mcp.json"),
    );
    const { exitCode, stdout } = await runUninstall("--cursor");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("[uninstalled: Cursor: removed .cursor/mcp.json]\n");
  });

  it("'not-installed' -> [noop: <name>: <engine reason>], exit 0 (reason from engine, not invented)", async () => {
    vi.spyOn(installers, "uninstall").mockResolvedValue({
      status: "not-installed",
      recordKey: "cursor",
      reason: "no cursor record in integrations.json",
    });
    const { exitCode, stdout } = await runUninstall("--cursor");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("[noop: Cursor: no cursor record in integrations.json]\n");
  });

  it("'refused' -> [refused: <name>: <reasonCode>: <message>], exit 1", async () => {
    vi.spyOn(installers, "uninstall").mockResolvedValue({
      status: "refused",
      recordKey: "cursor",
      reasonCode: "IntegrationsContentDriftError",
      message: "target bytes differ from record",
    });
    const { exitCode, stdout } = await runUninstall("--cursor");
    expect(exitCode).toBe(1);
    expect(stdout).toBe(
      "[refused: Cursor: IntegrationsContentDriftError: target bytes differ from record]\n",
    );
  });
});

// ===========================================================================
// D. Thrown errors
// ===========================================================================

describe("UninstallCommand -- thrown errors", () => {
  it("throws known InstallerError -> [refused: <name>: <ErrName>: <message>]", async () => {
    const err = makeKnownError(
      installers.PendingIntegrationRecoveryError,
      "PendingIntegrationRecoveryError",
      "recovery journal present",
    );
    vi.spyOn(installers, "uninstall").mockRejectedValue(err);
    const { exitCode, stdout } = await runUninstall("--cursor");
    expect(exitCode).toBe(1);
    expect(stdout).toBe(
      "[refused: Cursor: PendingIntegrationRecoveryError: recovery journal present]\n",
    );
  });

  it("throws unknown Error -> rethrown", async () => {
    vi.spyOn(installers, "uninstall").mockRejectedValue(new Error("engine bug"));
    await expect(runUninstall("--cursor")).rejects.toThrow("engine bug");
  });
});

// ===========================================================================
// E. --force flag propagation
// ===========================================================================

describe("UninstallCommand -- --force flag propagation", () => {
  it("--force sets uninstallCtx.options.forceUninstall=true", async () => {
    const uninstallSpy = vi
      .spyOn(installers, "uninstall")
      .mockResolvedValue(uninstalledOutcome("Cursor", "cursor", "removed"));
    await runUninstall("--cursor", "--force");
    const ctxArg = uninstallSpy.mock.calls[0]?.[1];
    expect(ctxArg?.options.forceUninstall).toBe(true);
  });

  it("no --force -> uninstallCtx.options.forceUninstall=false", async () => {
    const uninstallSpy = vi
      .spyOn(installers, "uninstall")
      .mockResolvedValue(uninstalledOutcome("Cursor", "cursor", "removed"));
    await runUninstall("--cursor");
    const ctxArg = uninstallSpy.mock.calls[0]?.[1];
    expect(ctxArg?.options.forceUninstall).toBe(false);
  });
});

// ===========================================================================
// F. RecordKey mapping + no detect/plan calls + --github-action explicit
// ===========================================================================

describe("UninstallCommand -- recordKey mapping", () => {
  it("--cursor -> uninstall('cursor', ctx); no adapter detect/plan called", async () => {
    const uninstallSpy = vi
      .spyOn(installers, "uninstall")
      .mockResolvedValue(uninstalledOutcome("Cursor", "cursor", "removed"));
    const detectSpy = vi.spyOn(adapters.cursorAdapter, "detect");
    const planSpy = vi.spyOn(adapters.cursorAdapter, "plan");
    await runUninstall("--cursor");
    expect(uninstallSpy).toHaveBeenCalledTimes(1);
    expect(uninstallSpy.mock.calls[0]?.[0]).toBe("cursor");
    expect(detectSpy).not.toHaveBeenCalled();
    expect(planSpy).not.toHaveBeenCalled();
  });

  it("--direct -> uninstall('direct-hook', ctx) [flag 'direct' maps to recordKey 'direct-hook']", async () => {
    const uninstallSpy = vi
      .spyOn(installers, "uninstall")
      .mockResolvedValue(uninstalledOutcome("Direct hook", "direct-hook", "removed"));
    await runUninstall("--direct");
    expect(uninstallSpy.mock.calls[0]?.[0]).toBe("direct-hook");
  });

  it("--github-action explicit is allowed -> uninstall('github-action', ctx)", async () => {
    const uninstallSpy = vi
      .spyOn(installers, "uninstall")
      .mockResolvedValue(uninstalledOutcome("GitHub Action", "github-action", "removed"));
    const { exitCode, stdout } = await runUninstall("--github-action");
    expect(exitCode).toBe(0);
    expect(uninstallSpy.mock.calls[0]?.[0]).toBe("github-action");
    expect(stdout).toContain("[uninstalled: GitHub Action:");
  });
});

// ===========================================================================
// G. RepoRootNotFoundError -> plain stderr, no brackets, no uninstall calls
// ===========================================================================

describe("UninstallCommand -- RepoRootNotFoundError", () => {
  it("temp dir with no .git -> plain stderr, exit 1, no brackets, no uninstall() invoked", async () => {
    await rm(join(repoRoot, ".git"), { recursive: true, force: true });
    const uninstallSpy = vi.spyOn(installers, "uninstall");
    const { exitCode, stdout, stderr } = await runUninstall("--cursor");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).not.toContain("[");
    expect(uninstallSpy).not.toHaveBeenCalled();
  });
});
