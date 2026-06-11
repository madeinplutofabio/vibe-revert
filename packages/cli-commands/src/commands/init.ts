// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  type DetectionResult,
  detectFramework,
  ensureViberevertDirs,
  RepoRootNotFoundError,
  resolveRepoRoot,
} from "@viberevert/core";
import { Command, Option } from "clipanion";
import { ensureViberevertGitignore } from "../gitignore.js";
import {
  BUILTIN_PROFILES,
  type Generator,
  generateGenericProfile,
  getProfileGenerator,
} from "../profiles/index.js";

/**
 * Initializes a VibeRevert config and scaffold in the current repo.
 *
 * Algorithm (locked in the M A plan; Step 7b is the M B corrective fix
 * per gitignore.ts module header):
 *   1. Resolve repo root (or use CWD if none, since `init` may run before .git).
 *   2. Refuse to write if .viberevert.yml exists and is not a regular file
 *      (directory, socket, etc.) — even with --force. If it's a regular file,
 *      refuse without --force.
 *   3. Determine the profile:
 *      - --profile provided: use it (any non-blank string accepted; if not a
 *        built-in, falls back to generateGenericProfile with that name).
 *      - --profile absent: run detectFramework().
 *        - "single"    -> use that profile.
 *        - "generic"   -> use generic.
 *        - "ambiguous" -> if interactive (stdin AND stdout are TTY), prompt
 *                         restricted to the detected matches; otherwise
 *                         error and demand --profile.
 *   4. Always print the chosen profile before writing.
 *   5. Generate YAML via the profile generator.
 *   6. Write .viberevert.yml.
 *   7a. ensureViberevertDirs(repoRoot).
 *   7b. ensureViberevertGitignore(repoRoot) — M B trust-critical fix:
 *       guarantees `.viberevert/` is gitignored so checkpoint/session writes
 *       never leak into the user's `git status`. Idempotent.
 *   8. Print success.
 */
export class InitCommand extends Command {
  static override paths = [["init"]];

  static override usage = Command.Usage({
    description: "Initialize a VibeRevert config and scaffold in this repo",
    details: `
      Detects the framework from filesystem signatures and writes a
      .viberevert.yml plus the .viberevert/ working directory.

      Use --profile to override detection. Any non-blank string is accepted;
      built-in profiles produce a tailored config, others fall back to a
      generic shape with the given profile name.
    `,
    examples: [
      ["Initialize with auto-detection", "viberevert init"],
      ["Force a specific profile", "viberevert init --profile laravel"],
      ["Overwrite an existing config", "viberevert init --force"],
    ],
  });

  profile = Option.String("--profile", {
    description:
      "Force a specific profile. Built-in: " +
      BUILTIN_PROFILES.join(", ") +
      ". Custom names produce a generic-shaped config.",
  });

  force = Option.Boolean("--force", false, {
    description: "Overwrite an existing .viberevert.yml",
  });

  override async execute(): Promise<number> {
    // Step 1: resolve repo root, or fall back to CWD.
    let repoRoot: string;
    try {
      repoRoot = resolveRepoRoot();
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        repoRoot = process.cwd();
      } else {
        throw err;
      }
    }

    const projectName = basename(repoRoot);
    const configPath = join(repoRoot, ".viberevert.yml");

    // Step 2: handle pre-existing path at the config location.
    if (existsSync(configPath)) {
      let isFile: boolean;
      try {
        isFile = statSync(configPath).isFile();
      } catch {
        this.context.stderr.write(`Cannot stat existing path at ${configPath}\n`);
        return 1;
      }

      if (!isFile) {
        this.context.stderr.write(
          `${configPath} exists but is not a regular file ` +
            `(e.g. a directory or socket). Refusing to write here even with --force.\n`,
        );
        return 1;
      }

      if (!this.force) {
        this.context.stderr.write(
          `Refusing to overwrite existing .viberevert.yml at ${configPath}\n` +
            `Re-run with --force to overwrite.\n`,
        );
        return 1;
      }
      // Regular file + --force: fall through to overwrite.
    }

    // Step 3: choose profile.
    const profileName = await this.resolveProfileName(repoRoot);
    if (profileName === undefined) {
      // resolveProfileName already wrote a clear error message.
      return 1;
    }

    // Step 4: announce.
    this.context.stdout.write(`Using profile: ${profileName}\n`);

    // Step 5: generate YAML.
    const generator: Generator =
      getProfileGenerator(profileName) ??
      ((opts) => generateGenericProfile({ ...opts, profileName }));
    const yaml = generator({ projectName });

    // Step 6: write .viberevert.yml.
    await writeFile(configPath, yaml, "utf8");
    this.context.stdout.write(`Wrote ${configPath}\n`);

    // Step 7a: scaffold .viberevert/ subdirs.
    await ensureViberevertDirs(repoRoot);
    this.context.stdout.write(`Created .viberevert/ subdirectories\n`);

    // Step 7b: ensure `.viberevert/` is gitignored (M B trust-critical fix
    // per gitignore.ts module header — idempotent on re-run).
    const gitignoreAction = await ensureViberevertGitignore(repoRoot);
    switch (gitignoreAction) {
      case "created":
        this.context.stdout.write(`Created .gitignore with .viberevert/ entry\n`);
        break;
      case "appended":
        this.context.stdout.write(`Added .viberevert/ to .gitignore\n`);
        break;
      case "already-present":
        this.context.stdout.write(`Confirmed .viberevert/ already in .gitignore\n`);
        break;
    }

    // Step 8: success.
    this.context.stdout.write(`\nDone. Next: viberevert doctor\n`);
    return 0;
  }

  /**
   * Returns the chosen profile name, or undefined if resolution failed (an
   * error message was already written to stderr).
   */
  private async resolveProfileName(repoRoot: string): Promise<string | undefined> {
    // --profile wins over detection. Any non-blank string accepted.
    if (this.profile !== undefined) {
      const trimmed = this.profile.trim();
      if (trimmed.length === 0) {
        this.context.stderr.write("--profile must not be empty\n");
        return undefined;
      }
      return trimmed;
    }

    const detection = detectFramework(repoRoot);
    switch (detection.resolution) {
      case "single":
        return detection.matches[0];
      case "generic":
        return "generic";
      case "ambiguous":
        return await this.resolveAmbiguous(detection);
    }
  }

  /**
   * Handles the "ambiguous" detection case: prompt the user (interactive
   * only) restricted to the set of detected matches, otherwise demand
   * --profile non-interactively.
   */
  private async resolveAmbiguous(detection: DetectionResult): Promise<string | undefined> {
    const prettyMatches = detection.matches.join(", ");

    if (!this.isInteractive()) {
      this.context.stderr.write(
        `Multiple framework signatures detected (${prettyMatches}).\n` +
          `Re-run with --profile <name> to choose one.\n`,
      );
      return undefined;
    }

    const recommended = detection.recommended ?? detection.matches[0];
    if (recommended === undefined) {
      // By construction, ambiguous resolution implies matches.length >= 2.
      throw new Error("internal invariant broken: ambiguous detection with empty matches");
    }

    const validChoices = new Set<string>(detection.matches);
    const rl = createInterface({
      input: this.context.stdin,
      output: this.context.stdout,
    });
    let answer: string;
    try {
      answer = await rl.question(
        `Multiple frameworks detected: ${prettyMatches}\n` + `Which profile? [${recommended}]: `,
      );
    } finally {
      rl.close();
    }

    const trimmed = answer.trim();
    const chosen = trimmed.length === 0 ? recommended : trimmed;

    if (!validChoices.has(chosen)) {
      this.context.stderr.write(
        `"${chosen}" is not one of the detected profiles (${prettyMatches}).\n` +
          `Re-run with --profile <name> to choose any profile (built-in or custom).\n`,
      );
      return undefined;
    }

    return chosen;
  }

  /**
   * Returns true iff both stdin and stdout from the command context are
   * connected to a TTY. Uses the context streams (not process.stdin/stdout)
   * so test/embedded contexts that swap streams are honored correctly.
   */
  private isInteractive(): boolean {
    return streamIsTTY(this.context.stdin) && streamIsTTY(this.context.stdout);
  }
}

/**
 * Returns true iff a stream has a truthy `isTTY` property. Clipanion's
 * BaseContext types don't expose `isTTY` (they're typed as plain
 * NodeJS.ReadableStream / NodeJS.WritableStream), but the actual instances
 * passed in at runtime are typically process.stdin/stdout which do have it.
 */
function streamIsTTY(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return "isTTY" in stream && Boolean((stream as { readonly isTTY?: boolean }).isTTY);
}
