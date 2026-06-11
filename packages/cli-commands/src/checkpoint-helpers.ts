// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// CLI-internal shared helpers for checkpoint name-collision handling.
//
// Extracted after M D Step 9 from byte-conservative duplicates that
// previously lived in:
//   - packages/cli/src/commands/checkpoint.ts (the
//     `viberevert checkpoint --name` collision-scan path)
//   - packages/cli/src/commands/rollback.ts (the D65 emergency
//     pre-rollback checkpoint name-uniqueness path inside
//     `createEmergencyCheckpoint`)
//
// Both call sites need the SAME error-handling contract around
// `git.listCheckpoints`: corruption-class errors must surface as a
// typed, structured error that consumers can render or wrap without
// the helper baking presentation in. Keeping that contract in one
// place prevents drift between the two commands' refusal copy and
// the createCheckpointOperation's public error contract.
//
// =============================================================================
// Post M G1a Step 1 (Option D) contract change
// =============================================================================
//
// PRE-M-G1a: `safeListCheckpoints(repoRoot, cmd)` wrote to
// `cmd.context.stderr` on corruption and returned `null`. The caller
// then threw `CollisionExitSentinel` to signal "refusal already
// printed, exit 1 cleanly".
//
// POST-M-G1a (this file): `safeListCheckpoints(repoRoot)` throws a
// typed `CheckpointListLoadError` on corruption. NO stderr write
// inside the helper. NO presentation logic inside the helper.
//
// =============================================================================
// Layering (D99.M.19 barrier between package-internal and public surface)
// =============================================================================
//
// All three exports of this module — `safeListCheckpoints`,
// `CheckpointListLoadError`, `CollisionExitSentinel` — are
// PACKAGE-INTERNAL implementation details of `@viberevert/cli-commands`.
// D99.M.19 forbids re-exporting any of them from the package barrel
// (`src/index.ts`); the `@viberevert/cli-commands/src/index.ts` exports
// list must omit them.
//
// `@viberevert/mcp` MUST NOT import `CheckpointListLoadError` or any
// other symbol from this file — directly or via a deep import path.
// MCP's constructor-keyed error map (D99.I source 1) keys on the
// operation-level wrapped errors, NOT on helper-internal errors. The
// operation owns its public error contract independent of how its
// internal helpers happen to throw — refactoring this helper later
// (e.g., splitting the corruption classes apart) must not ripple to
// MCP's envelope code map.
//
// Each consumer maps the helper error according to its layer:
//   - CLI Commands (`commands/checkpoint.ts`, `commands/rollback.ts`):
//     catch `CheckpointListLoadError` → write the existing
//     `"Error reading existing checkpoints: ${err.message}\n"` stderr
//     line → throw `CollisionExitSentinel` (preserves the existing
//     exit-1 flow with no message-write tracking flag needed).
//   - Operation (`operations/create-checkpoint.ts`):
//     catch `CheckpointListLoadError` → re-throw as an
//     operation-public error (e.g., `CreateCheckpointListLoadError`)
//     that IS barrel-exported and IS in MCP's constructor-keyed map.
//
// =============================================================================
// Exports
// =============================================================================
//
//   - `safeListCheckpoints` (the helper).
//   - `CheckpointListLoadError` (the typed corruption error the
//     helper throws — package-internal).
//   - `CollisionExitSentinel` (the presentation-side sentinel used by
//     the CLI Commands' outer catch).
//
// All three are package-local imports only:
//   `import { CollisionExitSentinel, CheckpointListLoadError,
//             safeListCheckpoints } from "../checkpoint-helpers.js";`

import { CheckpointCorruptError, CheckpointNotFoundError, listCheckpoints } from "@viberevert/git";

/**
 * Internal sentinel used to break out of a possibly-locked
 * protected flow after a collision-class refusal — either a typed
 * `CheckpointListLoadError` caught by the caller (which wrote its
 * own corruption stderr copy), OR the caller found a name-collision
 * in the returned list and wrote its own refusal copy. The caller's
 * outer catch block recognizes this sentinel and returns exit 1
 * cleanly, without confusing the message-write logic with a
 * separate "did we already write the refusal?" flag.
 *
 * NOT part of any public package surface; CLI-internal only.
 * D99.M.19: never re-exported from the package barrel.
 */
export class CollisionExitSentinel extends Error {
  constructor() {
    super("collision exit (internal sentinel)");
    this.name = "CollisionExitSentinel";
  }
}

/**
 * Thrown by `safeListCheckpoints` when `listCheckpoints` encounters
 * a corruption-class error (`CheckpointCorruptError` or
 * `CheckpointNotFoundError`). Carries structured fields only — no
 * preformatted stderr text. Each consumer renders or wraps it
 * according to its layer:
 *
 *   - CLI Command:  `Error reading existing checkpoints: ${err.message}\n`
 *     (the `message` field inherits the underlying cause's message,
 *     so this existing template keeps working unchanged.)
 *   - Operation:    catch + re-throw as a barrel-exported
 *     operation-level error (e.g., `CreateCheckpointListLoadError`)
 *     that MCP's constructor-keyed envelope map keys on. The
 *     operation never lets this helper-internal type cross its
 *     boundary.
 *
 * NOT part of any public package surface; CLI-internal only.
 * D99.M.19: never re-exported from the package barrel.
 */
export class CheckpointListLoadError extends Error {
  override readonly name = "CheckpointListLoadError";
  /** The repo root the failing list scan was rooted at. */
  readonly repoRoot: string;
  /**
   * The original `CheckpointCorruptError` or `CheckpointNotFoundError`
   * raised by `listCheckpoints`. Exposed structurally so operation
   * code can wrap it into a public operation-level error without
   * parsing strings. Inherits `Error.cause` semantics — TypeScript
   * types it as `unknown` per the standard library, so consumers
   * narrow with `instanceof`.
   */
  override readonly cause: unknown;
  constructor(opts: { repoRoot: string; cause: unknown }) {
    super(opts.cause instanceof Error ? opts.cause.message : String(opts.cause));
    this.repoRoot = opts.repoRoot;
    this.cause = opts.cause;
  }
}

/**
 * Element type of the `listCheckpoints` result, derived from the
 * function's own return type so future shape changes either
 * compile-fail loudly OR stay aligned without manual updates here.
 */
type CheckpointSummary = Awaited<ReturnType<typeof listCheckpoints>>[number];

/**
 * Wrap `git.listCheckpoints` with structured-error handling for the
 * `CheckpointCorruptError` / `CheckpointNotFoundError` corruption
 * classes. Returns the array on success; throws
 * `CheckpointListLoadError` if a corruption-class error fires.
 *
 * Distinguishing "no checkpoints exist" (returns `[]`) from "could
 * not read checkpoints" (throws) is essential for the collision-scan
 * flow: an empty repo should proceed to creation; a corrupt repo
 * should refuse cleanly.
 *
 * Non-corruption errors (e.g., I/O failures unrelated to checkpoint
 * shape) re-throw unmodified so the caller's outer error handler can
 * surface them with full diagnostics — the typed-error path is
 * reserved for the corruption classes that have user-friendly
 * messages already baked into the underlying error's `message`.
 */
export async function safeListCheckpoints(repoRoot: string): Promise<readonly CheckpointSummary[]> {
  try {
    return await listCheckpoints(repoRoot);
  } catch (err) {
    if (err instanceof CheckpointCorruptError || err instanceof CheckpointNotFoundError) {
      throw new CheckpointListLoadError({ repoRoot, cause: err });
    }
    throw err;
  }
}
