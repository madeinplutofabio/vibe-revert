// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Thrown by resolveRepoRoot when no `.git` or `.viberevert.yml` is found
 * walking up from the given start directory to the filesystem root.
 *
 * Callers can use `instanceof RepoRootNotFoundError` to handle this case
 * specifically (e.g., `viberevert init` may want to bootstrap from CWD even
 * without .git, while `viberevert doctor` should fail informatively).
 */
export class RepoRootNotFoundError extends Error {
  constructor(startDir: string) {
    super(
      `Could not find a VibeRevert repo root: walked up from ${startDir} without finding .git or .viberevert.yml`,
    );
    this.name = "RepoRootNotFoundError";
  }
}

/**
 * Checks whether `dir` contains a VibeRevert repo-root marker.
 *
 * A directory qualifies as a repo root if either:
 *   - It contains a `.git` file OR directory (regular repo, worktree gitlink,
 *     or submodule). Other filesystem object types (sockets, FIFOs, devices,
 *     etc.) named `.git` do NOT count.
 *   - It contains a `.viberevert.yml` regular file (project marker for
 *     directories that may not be Git repos yet). A `.viberevert.yml`
 *     directory does NOT count.
 */
function hasRepoMarker(dir: string): boolean {
  const gitPath = join(dir, ".git");
  if (existsSync(gitPath)) {
    try {
      const gitStat = statSync(gitPath);
      if (gitStat.isFile() || gitStat.isDirectory()) {
        return true;
      }
    } catch {
      // ignore and fall through to .viberevert.yml check
    }
  }

  const configPath = join(dir, ".viberevert.yml");
  if (existsSync(configPath)) {
    try {
      return statSync(configPath).isFile();
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Walks up from `startDir` (default: process.cwd()) looking for a repo-root
 * marker (see hasRepoMarker for the precise definition).
 *
 * Returns the absolute path of the first matching directory.
 *
 * Behavior to keep in mind: NEAREST marker wins. A nested `.viberevert.yml`
 * inside a larger Git repository resolves to the nested project root, not the
 * outer Git root. This is intentional — it lets a sub-project inside a
 * monorepo declare its own VibeRevert scope.
 *
 * Throws RepoRootNotFoundError if the filesystem root is reached without a
 * match.
 *
 * Pure: does not chdir, does not mutate process state.
 */
export function resolveRepoRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  while (true) {
    if (hasRepoMarker(current)) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new RepoRootNotFoundError(resolve(startDir));
    }
    current = parent;
  }
}

/**
 * Returns the absolute path to the .viberevert/ directory within `repoRoot`.
 * Pure path-join; does not check existence.
 */
export function viberevertDir(repoRoot: string): string {
  return join(repoRoot, ".viberevert");
}

/**
 * Creates the standard .viberevert/ subdirectories under `repoRoot`:
 * sessions/, checkpoints/, reports/. Idempotent (uses `recursive: true`).
 */
export async function ensureViberevertDirs(repoRoot: string): Promise<void> {
  const root = viberevertDir(repoRoot);
  await Promise.all([
    mkdir(join(root, "sessions"), { recursive: true }),
    mkdir(join(root, "checkpoints"), { recursive: true }),
    mkdir(join(root, "reports"), { recursive: true }),
  ]);
}
