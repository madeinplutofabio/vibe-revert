// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  detectFramework,
  loadConfig,
  RepoRootNotFoundError,
  resolveRepoRoot,
  SECRET_PATTERN_COUNT,
  viberevertDir,
} from "@viberevert/core";
import { probeGitVersion } from "@viberevert/git";
import { Command } from "clipanion";

import { buildCommandLaunchPlan, classifyResolvedTarget } from "./command-launcher.js";
import { createHostExecutablePathResolver } from "./executable-probe.js";

/**
 * Reports environment status as a series of key:value lines.
 *
 * Each check is independent: a missing repo root or config does not abort the
 * doctor run; it just renders that check (and any dependents) with a specific
 * "skipped" or failure message.
 *
 * Doctor always exits 0. It is informational, not a gate. If you need a
 * gating behavior in CI, use `viberevert check --threshold=...` (M C+).
 */
export class DoctorCommand extends Command {
  static override paths = [["doctor"]];

  static override usage = Command.Usage({
    description: "Report VibeRevert environment status (node, pnpm, git, repo, config)",
  });

  override async execute(): Promise<number> {
    const lines: Array<[string, string]> = [];

    // Node version (from process.version, always available)
    lines.push(["Node", process.version]);

    // pnpm via local spawnSync (the carve-out: doctor.ts is the only
    // place in the CLI allowed to spawn non-git diagnostic binaries —
    // see D17c). git goes through @viberevert/git's probeGitVersion()
    // helper to honor the "git invocation single-owner" rule:
    // GitNotAvailableError (raised on missing/unusable git) is caught
    // and converted to "not found" to preserve doctor.ts's
    // never-throws-on-missing-binary semantic.
    lines.push(["pnpm", probeVersion("pnpm")]);
    let gitVersion: string;
    try {
      gitVersion = await probeGitVersion();
    } catch {
      gitVersion = "not found";
    }
    lines.push(["git", gitVersion]);

    // Repo root
    let repoRoot: string | undefined;
    try {
      repoRoot = resolveRepoRoot();
      lines.push(["Repo root", repoRoot]);
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        lines.push(["Repo root", "not found (run `viberevert init`)"]);
      } else {
        throw err;
      }
    }

    // Framework detection (depends on repo root)
    if (repoRoot !== undefined) {
      const detection = detectFramework(repoRoot);
      const matches = detection.matches.length > 0 ? detection.matches.join(", ") : "(none)";
      lines.push(["Framework", `${matches} [${detection.resolution}]`]);
    } else {
      lines.push(["Framework", "skipped (no repo root)"]);
    }

    // Config presence + validity (depends on repo root)
    if (repoRoot !== undefined) {
      try {
        await loadConfig(repoRoot);
        lines.push(["Config", "valid (.viberevert.yml)"]);
      } catch (err) {
        if (err instanceof ConfigNotFoundError) {
          lines.push(["Config", "not found (run `viberevert init`)"]);
        } else if (err instanceof ConfigParseError) {
          lines.push(["Config", "INVALID YAML"]);
          this.context.stderr.write(`\nConfig YAML error:\n  ${err.message}\n\n`);
        } else if (err instanceof ConfigValidationError) {
          lines.push(["Config", `INVALID schema (${err.issues.length} issue(s))`]);
          this.context.stderr.write(`\nConfig schema error:\n  ${err.message}\n\n`);
        } else {
          throw err;
        }
      }
    } else {
      lines.push(["Config", "skipped (no repo root)"]);
    }

    // .viberevert/ directory presence (depends on repo root)
    if (repoRoot !== undefined) {
      const dir = viberevertDir(repoRoot);
      if (existsSync(dir) && safeIsDir(dir)) {
        lines.push([".viberevert/ dir", "present"]);
      } else {
        lines.push([".viberevert/ dir", "missing (run `viberevert init`)"]);
      }
    } else {
      lines.push([".viberevert/ dir", "skipped (no repo root)"]);
    }

    // Redaction patterns (always available)
    lines.push(["Redaction patterns", String(SECRET_PATTERN_COUNT)]);

    this.context.stdout.write(formatLines(lines));
    this.context.stdout.write("\n");

    return 0;
  }
}

/**
 * Resolve `<cmd>` to an exact path, then spawn `<resolved> --version` and return
 * the first line of stdout, or "not found" if the command cannot be resolved or
 * launched, or returns a non-zero exit. Resolve-then-launch per ADR 0005: a
 * resolved native target is spawned directly; a resolved `.cmd` shim uses
 * bounded one-shot `cmd.exe` mediation (Decision 3 — doctor's probe is a
 * one-shot diagnostic with no lifecycle contract). Synchronous; doctor invokes a
 * small fixed number of probes so async concurrency is unnecessary.
 */
function probeVersion(cmd: string): string {
  try {
    const resolvedTarget = createHostExecutablePathResolver()(cmd);
    if (resolvedTarget === null) {
      return "not found";
    }
    const plan = buildProbeLaunchPlan(cmd, resolvedTarget);
    if (plan === null) {
      return "not found";
    }
    const result = spawnSync(plan.command, [...plan.args], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    if (result.error || result.status !== 0) {
      return "not found";
    }
    const firstLine = result.stdout.trim().split(/\r?\n/)[0];
    return firstLine !== undefined && firstLine.length > 0 ? firstLine : "(no output)";
  } catch {
    return "not found";
  }
}

/**
 * Build a one-shot `--version` launch plan for a resolved probe target, or null
 * if it cannot be launched. A native target spawns directly and does NOT depend
 * on ComSpec; only a `.cmd` target reads `ComSpec` (the launch-plan builder
 * validates it and constructs bounded `cmd.exe` mediation). Any other resolved
 * kind (batch, ps1, script, ...) is not probed.
 */
function buildProbeLaunchPlan(
  requestedCommand: string,
  resolvedTarget: string,
): { command: string; args: readonly string[]; windowsVerbatimArguments: boolean } | null {
  const targetKind = classifyResolvedTarget(process.platform, resolvedTarget);
  if (targetKind === "native") {
    const result = buildCommandLaunchPlan({
      platform: process.platform,
      resolvedTarget,
      requestedCommand,
      args: ["--version"],
    });
    if (!result.ok || result.plan.kind !== "direct") {
      return null;
    }
    return {
      command: result.plan.command,
      args: result.plan.args,
      windowsVerbatimArguments: false,
    };
  }
  if (targetKind === "cmd-shim") {
    const resolvedComSpec = process.env["ComSpec"] ?? process.env["COMSPEC"] ?? null;
    const result = buildCommandLaunchPlan({
      platform: process.platform,
      resolvedTarget,
      requestedCommand,
      args: ["--version"],
      resolvedComSpec,
    });
    if (!result.ok || result.plan.kind !== "windows-cmd") {
      return null;
    }
    return {
      command: result.plan.command,
      args: result.plan.args,
      windowsVerbatimArguments: result.plan.windowsVerbatimArguments,
    };
  }
  return null;
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Renders [label, value] pairs as `label: value` lines, padded to align. */
function formatLines(lines: ReadonlyArray<readonly [string, string]>): string {
  const labelWidth = Math.max(...lines.map(([label]) => label.length)) + 2;
  return lines.map(([label, value]) => `${`${label}:`.padEnd(labelWidth)} ${value}`).join("\n");
}
