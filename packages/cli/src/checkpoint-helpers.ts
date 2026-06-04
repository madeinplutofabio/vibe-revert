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
// `git.listCheckpoints`: corruption-class errors must be surfaced
// as a clean stderr message and trigger a typed-sentinel-driven
// exit-1, distinct from the "no checkpoints exist" case (which
// returns an empty array and allows the caller to proceed). Keeping
// that contract in one place prevents drift between the two
// commands' refusal copy and exit semantics.
//
// =============================================================================
// Scope
// =============================================================================
//
//   - Module lives at `packages/cli/src/checkpoint-helpers.ts` —
//     NOT in `@viberevert/core`, `@viberevert/git`, or
//     `@viberevert/session-format`. The helpers are command UX
//     plumbing (clean-stderr handling for corruption-error classes
//     + typed sentinel for the caller's outer catch). UX policy
//     stays at the CLI orchestration layer; the lower packages
//     keep their existing responsibilities and do not learn about
//     CLI refusal-copy/sentinel flow.
//
//   - The module is CLI-INTERNAL. No re-export from any package
//     barrel; no entry in `package.json` exports map. Consumers
//     are package-local imports only:
//       `import { CollisionExitSentinel, safeListCheckpoints }
//        from "../checkpoint-helpers.js";`
//
//   - Two exports ONLY: `safeListCheckpoints` (the helper) and
//     `CollisionExitSentinel` (the sentinel the caller's outer
//     catch recognizes for the exit-1-cleanly contract). No other
//     symbols.

import { CheckpointCorruptError, CheckpointNotFoundError, listCheckpoints } from "@viberevert/git";

/**
 * Internal sentinel used to break out of a possibly-locked
 * protected flow after a collision-class refusal — either
 * `safeListCheckpoints` reported corruption (already wrote to
 * stderr), OR the caller found a name-collision in the returned
 * list and wrote its own refusal copy. The caller's outer catch
 * block recognizes this sentinel and returns exit 1 cleanly,
 * without confusing the message-write logic with a separate "did
 * we already write the refusal?" flag.
 *
 * NOT part of any public package surface; CLI-internal only.
 */
export class CollisionExitSentinel extends Error {
  constructor() {
    super("collision exit (internal sentinel)");
    this.name = "CollisionExitSentinel";
  }
}

/**
 * Element type of the `listCheckpoints` result, derived from the
 * function's own return type so future shape changes either
 * compile-fail loudly OR stay aligned without manual updates here.
 * Adopted in preference to the older hand-rolled inline form
 * (`{ name: string | null }`) so the type carries the full
 * checkpoint-summary shape, not just the `name` field.
 */
type CheckpointSummary = Awaited<ReturnType<typeof listCheckpoints>>[number];

/**
 * Wrap `git.listCheckpoints` with clean-stderr handling for the
 * `CheckpointCorruptError` / `CheckpointNotFoundError` corruption
 * classes. Returns the array on success OR `null` if a
 * corruption-class error was surfaced to stderr (the caller should
 * treat null as "refusal already printed, exit 1 cleanly via
 * `CollisionExitSentinel`").
 *
 * Distinguishing "no checkpoints exist" (returns `[]`) from "could
 * not read checkpoints" (returns `null` after writing stderr) is
 * essential for the collision-scan flow: an empty repo should
 * proceed to creation; a corrupt repo should refuse cleanly.
 *
 * Non-corruption errors (e.g., I/O failures unrelated to checkpoint
 * shape) re-throw so the caller's outer error handler can surface
 * them with full diagnostics — the clean-stderr path is reserved
 * for the corruption classes that have user-friendly messages
 * already baked in.
 */
export async function safeListCheckpoints(
  repoRoot: string,
  cmd: { context: { stderr: { write(s: string): unknown } } },
): Promise<readonly CheckpointSummary[] | null> {
  try {
    return await listCheckpoints(repoRoot);
  } catch (err) {
    if (err instanceof CheckpointCorruptError || err instanceof CheckpointNotFoundError) {
      cmd.context.stderr.write(`Error reading existing checkpoints: ${err.message}\n`);
      return null;
    }
    throw err;
  }
}
