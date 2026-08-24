// packages/git/src/checkpoint-oracle.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// The checkpoint ORACLE: a disposable linked worktree holding a checkpoint's
// captured state, so a consumer can compare the live repository against what a
// session actually started from.
//
// M 0.8.0 step 2. This is a BEHAVIOR-PRESERVING extraction of the lifecycle
// `getDiffSinceCheckpoint` has owned since M C. It is not a redesign: every
// operation, its order, and its failure handling are what that function already
// did. `contribution.ts` (step 4) becomes the second consumer, which is why the
// lifecycle now stands on its own instead of living inside the diff.
//
// INTERNAL. Deliberately NOT exported from the package barrel: both consumers
// live inside `@viberevert/git`, and publishing a scratch-lifecycle helper
// would describe the package's plumbing rather than its domain.
//
// ============================================================================
// The locked ordering
// ============================================================================
//
//   1. load the checkpoint manifest
//   2. create tempRoot
//   3. prepareTempRoot()   <- caller-owned, while NO worktree exists yet
//   4. git worktree add --detach at manifest.git.head_sha
//   5. restoreCheckpoint() using the CAPTURED exclude patterns
//   6. run()
//   7. cleanup (best effort, never throws)
//
// Step 3 exists solely to preserve failure ordering, and its position IS the
// contract. `getDiffSinceCheckpoint` creates its two mirror directories before
// the worktree add. If one of those mkdirs fails today, no worktree exists and
// cleanup only removes the scratch root. Move the same mkdir after step 4 and
// the identical failure would instead engage `worktree remove`, then possibly
// `worktree prune`, each able to push its own cleanup warning. That is a
// different observable failure, and the golden fixtures cannot catch it because
// they only exercise the success path.
//
// Step 5 passes the manifest's OWN `untracked.exclude_patterns` rather than
// current configuration. The oracle reproduces capture state faithfully;
// whether current config also matters is a separate question each consumer
// answers for itself.
//
// ============================================================================
// Cleanup and warnings
// ============================================================================
//
// Cleanup NEVER throws (D29 + D17c terminal-write rule). It appends to a
// warnings list, returned on success and attached to the thrown error as a
// `cleanupWarnings` property on failure so warnings survive the throw.
//
// The returned list is a snapshot taken AFTER cleanup completes. The shipped
// code returned the live array from inside its `try`, relying on `finally`
// pushing into that same instance before the caller could observe it. That is
// observably identical, since the promise cannot resolve until `finally` has
// run, but it depends on aliasing a later refactor could quietly break. The
// result is therefore assembled once cleanup has genuinely finished.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Manifest } from "@viberevert/session-format";

import { loadCheckpoint } from "./checkpoint.js";
import { runGit } from "./git-cli.js";
import { restoreCheckpoint } from "./restore.js";

/** Basename of the linked worktree inside tempRoot. */
const WORKTREE_DIR = "worktree";

/** What a consumer receives once the oracle is fully materialized. */
export interface CheckpointOracleContext {
  /** Scratch root. Removed recursively during cleanup. */
  readonly tempRoot: string;
  /** Linked worktree holding the checkpoint's captured state. */
  readonly worktreePath: string;
  /** The checkpoint's manifest, already loaded. */
  readonly manifest: Manifest;
}

export interface CheckpointOracleOptions<T> {
  /**
   * Prefix for the scratch directory. Required rather than defaulted, because
   * it appears verbatim in cleanup warnings: a shared default would mislabel
   * whichever consumer did not choose it.
   */
  readonly tempDirPrefix: string;
  /**
   * Caller-owned preparation of `tempRoot`, run BEFORE the worktree is added.
   * See the locked ordering above; this position is load-bearing, not
   * cosmetic.
   */
  readonly prepareTempRoot?: (tempRoot: string) => Promise<void>;
  /** The consumer's work, run against a fully materialized oracle. */
  readonly run: (ctx: CheckpointOracleContext) => Promise<T>;
}

export interface CheckpointOracleResult<T> {
  readonly value: T;
  /**
   * Empty in normal flows. Populated when worktree removal or scratch cleanup
   * partially failed. NEVER causes a throw.
   */
  readonly cleanupWarnings: readonly string[];
}

// ============================================================================
// Cleanup (best-effort; populates warnings; never throws)
// ============================================================================

async function cleanupBestEffort(
  repoRoot: string,
  tempRoot: string | null,
  worktreePath: string | null,
  worktreeAdded: boolean,
  warnings: string[],
): Promise<void> {
  if (worktreeAdded && worktreePath !== null) {
    try {
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch (e) {
      warnings.push(`git worktree remove --force failed for ${worktreePath}: ${stringifyErr(e)}`);
      try {
        await runGit(repoRoot, ["worktree", "prune"]);
      } catch (e2) {
        warnings.push(`git worktree prune fallback failed: ${stringifyErr(e2)}`);
      }
    }
  }
  if (tempRoot !== null) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (e) {
      warnings.push(`rm -rf ${tempRoot} failed: ${stringifyErr(e)}`);
    }
  }
}

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ============================================================================
// The oracle
// ============================================================================

/**
 * Materialize a checkpoint as a disposable worktree, run `opts.run` against it,
 * and clean up unconditionally.
 *
 * Throws whatever `opts.prepareTempRoot` or `opts.run` throws, with cleanup
 * warnings attached to the error as `cleanupWarnings` when any occurred.
 */
export async function withCheckpointOracle<T>(
  repoRoot: string,
  checkpointDir: string,
  opts: CheckpointOracleOptions<T>,
): Promise<CheckpointOracleResult<T>> {
  const warnings: string[] = [];
  let tempRoot: string | null = null;
  let worktreePath: string | null = null;
  let worktreeAdded = false;
  let mainError: unknown = null;
  // Held rather than returned from inside the `try`, so the warnings snapshot
  // below is taken after cleanup has finished appending to the list.
  let outcome: { readonly value: T } | undefined;

  try {
    const manifest = await loadCheckpoint(checkpointDir);
    const headSha = manifest.git.head_sha;

    // Single bounded tempRoot; all scratch state lives under it.
    tempRoot = await mkdtemp(join(tmpdir(), opts.tempDirPrefix));
    worktreePath = join(tempRoot, WORKTREE_DIR);

    // Caller-owned scratch preparation, deliberately BEFORE the worktree
    // exists. See the locked ordering in this file's header.
    await opts.prepareTempRoot?.(tempRoot);

    // Bootstrap linked worktree at captured HEAD.
    await runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, headSha]);
    worktreeAdded = true;

    // Overlay captured dirt using the CAPTURED exclude patterns (faithful
    // reproduction of capture state, NOT current config).
    await restoreCheckpoint(checkpointDir, {
      repoRoot: worktreePath,
      rollbackExcludePatterns: manifest.untracked.exclude_patterns ?? [],
    });

    outcome = { value: await opts.run({ tempRoot, worktreePath, manifest }) };
  } catch (e) {
    mainError = e;
    throw e;
  } finally {
    await cleanupBestEffort(repoRoot, tempRoot, worktreePath, worktreeAdded, warnings);
    // If the main algorithm threw AND cleanup also produced warnings, attach
    // them to the thrown error so the CLI can surface them.
    if (mainError !== null && warnings.length > 0 && mainError instanceof Error) {
      (mainError as Error & { cleanupWarnings?: readonly string[] }).cleanupWarnings = [
        ...warnings,
      ];
    }
  }

  // Unreachable when `run` threw: the catch above rethrows. Present so the
  // value is definitely assigned without a `!` assertion in lifecycle code.
  if (outcome === undefined) {
    throw new Error("withCheckpointOracle: run() neither returned a value nor threw");
  }

  return { value: outcome.value, cleanupWarnings: [...warnings] };
}
