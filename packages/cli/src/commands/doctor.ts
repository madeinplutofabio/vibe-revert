// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { Command } from "clipanion";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  RepoRootNotFoundError,
  SECRET_PATTERN_COUNT,
  loadConfig,
  resolveRepoRoot,
  viberevertDir,
} from "@viberevert/core";
import { detectFramework } from "../detect.js";

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
    description:
      "Report VibeRevert environment status (node, pnpm, git, repo, config)",
  });

  override async execute(): Promise<number> {
    const lines: Array<[string, string]> = [];

    // Node version (from process.version, always available)
    lines.push(["Node", process.version]);

    // pnpm + git via spawnSync
    lines.push(["pnpm", probeVersion("pnpm")]);
    lines.push(["git", probeVersion("git")]);

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
      const matches =
        detection.matches.length > 0
          ? detection.matches.join(", ")
          : "(none)";
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
          this.context.stderr.write(
            `\nConfig YAML error:\n  ${err.message}\n\n`,
          );
        } else if (err instanceof ConfigValidationError) {
          lines.push([
            "Config",
            `INVALID schema (${err.issues.length} issue(s))`,
          ]);
          this.context.stderr.write(
            `\nConfig schema error:\n  ${err.message}\n\n`,
          );
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
 * Spawns `<cmd> --version` and returns the first line of stdout, or
 * "not found" if the binary cannot be invoked or returns a non-zero exit.
 * Synchronous; doctor invokes a small fixed number of probes so async
 * concurrency is unnecessary.
 */
function probeVersion(cmd: string): string {
  try {
    const result = spawnSync(cmd, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      return "not found";
    }
    const firstLine = result.stdout.trim().split("\n")[0];
    return firstLine !== undefined && firstLine.length > 0
      ? firstLine
      : "(no output)";
  } catch {
    return "not found";
  }
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Renders [label, value] pairs as `label: value` lines, padded to align. */
function formatLines(
  lines: ReadonlyArray<readonly [string, string]>,
): string {
  const labelWidth = Math.max(...lines.map(([label]) => label.length)) + 2;
  return lines
    .map(([label, value]) => `${`${label}:`.padEnd(labelWidth)} ${value}`)
    .join("\n");
}
