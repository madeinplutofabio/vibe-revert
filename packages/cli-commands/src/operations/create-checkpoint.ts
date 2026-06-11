// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Typed operation backing `viberevert checkpoint` (CLI) and
// `create_checkpoint` (MCP). Owns all domain logic: repo-root
// resolution, config load, optional D22 name-uniqueness lock,
// `git.createCheckpoint`, atomic rename to final `cp_<id>/`,
// D13 cleanup-on-failure.
//
// Owns NO presentation: never writes to process.stdout / process.stderr,
// never calls console.*, never reads process.cwd() (uses opts.cwd).
//
// =============================================================================
// Architectural locks (carried over from CheckpointCommand verbatim)
// =============================================================================
//
// 1. **D19** — REQUIRES valid config. `rollback.exclude` directly
//    determines what is captured (D3 symmetry); silently defaulting
//    to `[]` would diverge later restore behavior. Hard-fail with
//    typed errors on missing/invalid `.viberevert.yml`.
//
// 2. **D16/D17c** — git invocation through `@viberevert/git` only.
//    NO `child_process` imports here.
//
// 3. **D17** — standalone, never touches `active-session.json`. Even
//    when a session is active, this operation runs as a standalone
//    checkpoint — does NOT mutate the session's `checkpoint_id` and
//    does NOT create an inner-session checkpoint. Users expect
//    `checkpoint` to work at any time as an extra safety recovery
//    point. The operation intentionally does NOT call
//    `loadActiveSessionLock`.
//
// 4. **D5b + D22** — name-collision protection via D22 mkdir lock
//    IFF `opts.name` is supplied. Nameless checkpoints have no
//    uniqueness invariant to protect, so they skip the lock entirely
//    (saves an fs round-trip per nameless invocation). When `name`
//    IS supplied, the lock is held from the start of the manifest
//    scan through the atomic outer rename.
//
// 5. **D17b** — operation generates the temp dir; `@viberevert/git`
//    generates the checkpoint id internally. The temp name is
//    generic (`.tmp-checkpoint-<random-hex>`) — NOT id-bearing —
//    because the operation does not pre-generate checkpoint ids
//    (git owns checkpoint identity per D5/D17b). After
//    `git.createCheckpoint` returns `{ checkpointId }`, the operation
//    uses cli-commands' private `renameDirAtomic` (NOT core's, NOT
//    git's) to atomically rename the temp dir to `<checkpointId>/`.
//    The returned `checkpointId` already includes the `cp_` prefix
//    per D5; do NOT prepend `cp_` again.
//
//    Note: the parent dir `.viberevert/checkpoints/` is NOT
//    pre-created here. `git.createCheckpoint` internally calls
//    `mkdir(opts.checkpointDir, { recursive: true })` which creates
//    intermediate directories as needed. This matches the
//    pre-extraction CheckpointCommand behavior exactly — no luck
//    dependency on parent-dir existence.
//
// 6. **D13/D17c** — cleanup on `createCheckpoint` failure. If
//    `git.createCheckpoint` throws, we attempt `rm -rf` on the temp
//    dir to avoid leaking stale `.tmp-checkpoint-<hex>/` siblings.
//    Cleanup errors are swallowed (the original failure is what the
//    user needs to see). On createCheckpoint SUCCESS but rename
//    failure, the tmp dir is left in place — its contents are valid
//    and D13 tolerates leftover `.tmp-*` entries.
//
// 7. **Deterministic timestamps** — `resolveNowForCliTimestamp()`
//    runs ONCE per operation invocation. Threaded into TWO slots:
//    the new checkpoint's `manifest.captured_at` (via
//    `createCheckpoint({ capturedAt: now })`) AND the D22 lock
//    metadata (`lockInfo.started_at`). Returned to the caller as
//    `result.createdAt`.
//
// =============================================================================
// Callers must catch these typed errors and map to presentation
// =============================================================================
//
// Operation-public errors (defined in this file; barrel-exported;
// keyed by MCP's constructor-keyed envelope map):
//   - CheckpointNameCollisionError          → CLI: D5b refusal copy; MCP: CHECKPOINT_NAME_COLLISION
//   - CreateCheckpointListLoadError         → CLI: "Error reading existing checkpoints: ..."; MCP: CHECKPOINT_LIST_LOAD_FAILED
//
// Passthrough errors (defined elsewhere; barrel-exported by their
// owning packages; mapped at @viberevert/core / locks layer). The
// operation does NOT import these symbols — consumers catch them by
// importing from their canonical owners:
//   - RepoRootNotFoundError                 (from @viberevert/core)
//   - ConfigNotFoundError, ConfigParseError, ConfigValidationError  (from @viberevert/core)
//   - RuntimeEnvInvalidError                (from ../runtime-env.js)
//   - ConcurrentOperationError              (from ../locks.js)
//
// =============================================================================
// Input validation boundary
// =============================================================================
//
// This operation accepts `opts.name` as-is. CLI flag-parse and MCP
// Zod `inputSchema` MUST reject empty/whitespace-only `name` BEFORE
// calling. The operation remains defensive-light to avoid
// double-validation drift between the two callers.
//
// `message?` is intentionally NOT in `CreateCheckpointOperationOpts`
// — `@viberevert/git/createCheckpoint` does not accept a message
// parameter as of M G1a Step 1. Adding `message?` here would create
// a lying contract (caller sets it, nothing happens). When the git
// plumbing supports messages, this opts type grows and the MCP
// input schema follows.

import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveRepoRoot } from "@viberevert/core";
import { createCheckpoint } from "@viberevert/git";

import { renameDirAtomic } from "../atomic.js";
import { CheckpointListLoadError, safeListCheckpoints } from "../checkpoint-helpers.js";
import { type LockInfo, withExclusiveLock } from "../locks.js";
import { resolveNowForCliTimestamp } from "../runtime-env.js";

/**
 * Lock-path constant used by:
 *   - this operation, for the D22 `withExclusiveLock` lockDir, and
 *   - CheckpointCommand's stderr template for the
 *     `ConcurrentOperationError` refusal copy.
 *
 * Single source of truth for both call sites.
 *
 * D99.M.19 barrel guard (substep 8): MUST NOT be re-exported from
 * `src/index.ts`. Internal display/lock-path plumbing for
 * package-internal Commands only; not part of the MCP-facing public
 * API. Same treatment as `START_LOCK_REL` from `operations/start-session.ts`.
 */
export const CHECKPOINT_NAME_LOCK_REL = ".viberevert/.locks/checkpoint-name.lock";

// =============================================================================
// Operation-public errors (barrel-exported; MCP constructor-keyed map keys)
// =============================================================================

/**
 * Thrown when `opts.name` collides with an existing checkpoint's name
 * in the same repo. Operation-public; the helper-level scan logic
 * (corruption detection) is hidden behind `CreateCheckpointListLoadError`.
 *
 * Carries structured fields only — each consumer renders or maps:
 *   - CLI Command: D5b refusal copy referencing `checkpointName`.
 *   - MCP handler: envelope `{ok:false, error:{code:"CHECKPOINT_NAME_COLLISION", details:{name}}}`.
 */
export class CheckpointNameCollisionError extends Error {
  override readonly name = "CheckpointNameCollisionError";
  /** The colliding name the caller supplied. */
  readonly checkpointName: string;
  constructor(opts: { checkpointName: string }) {
    super(`checkpoint name already exists: ${opts.checkpointName}`);
    this.checkpointName = opts.checkpointName;
  }
}

/**
 * Thrown when the pre-create collision scan can't read existing
 * checkpoints because they're corrupt. Wraps the helper-internal
 * `CheckpointListLoadError` into an operation-public type the MCP
 * envelope map keys on without depending on helper internals.
 *
 * Carries structured fields only:
 *   - CLI Command: `"Error reading existing checkpoints: ${err.message}\n"` (existing copy).
 *   - MCP handler: envelope `{ok:false, error:{code:"CHECKPOINT_LIST_LOAD_FAILED"}}`.
 */
export class CreateCheckpointListLoadError extends Error {
  override readonly name = "CreateCheckpointListLoadError";
  /** The repo root the failing list scan was rooted at. */
  readonly repoRoot: string;
  /**
   * The wrapped internal error. Publicly typed as `unknown` so
   * helper-internal types do not leak through the operation API
   * (D99.M.19 barrier). Consumers narrow with `instanceof Error` +
   * `.message` for display; MCP keys on this CLASS (not on `cause`'s
   * type) for envelope mapping.
   */
  override readonly cause: unknown;
  constructor(opts: { repoRoot: string; cause: unknown }) {
    super(opts.cause instanceof Error ? opts.cause.message : String(opts.cause));
    this.repoRoot = opts.repoRoot;
    this.cause = opts.cause;
  }
}

// =============================================================================
// Operation public surface
// =============================================================================

export type CreateCheckpointOperationOpts = {
  /** Directory to resolve the repo root from. Caller-supplied; the
   *  operation MUST NOT read `process.cwd()`. */
  cwd: string;
  /** Optional human-readable label, unique within the repo when
   *  supplied. Caller MUST pre-validate (non-empty, non-whitespace) —
   *  operation does not re-validate. */
  name?: string;
  /** Optional D22 lock-metadata label identifying who holds the lock.
   *  Defaults to the existing CLI literal
   *  (`viberevert checkpoint --name <json>`) so CLI behavior is
   *  unchanged when omitted. MCP handlers should pass something like
   *  `"viberevert mcp create_checkpoint"` so D22 concurrent-operation
   *  refusal copy is truthful about the actual holder without leaking
   *  raw MCP argument bytes into lock metadata. Only used when
   *  `name` is supplied (nameless checkpoints skip the lock entirely
   *  per D5b lock #4). */
  lockCommand?: string;
};

export type CreateCheckpointOperationResult = {
  checkpointId: string; // cp_<ULID>
  createdAt: string; // ISO-8601 UTC (second precision)
};

export async function createCheckpointOperation(
  opts: CreateCheckpointOperationOpts,
): Promise<CreateCheckpointOperationResult> {
  // Step 1: resolve repo root from caller-supplied cwd.
  const repoRoot = resolveRepoRoot(opts.cwd);

  // Step 2: load+validate config (D19).
  const config = await loadConfig(repoRoot);
  const rollbackExcludePatterns: readonly string[] = config.rollback?.exclude ?? [];

  // Step 3: resolve the wall-clock timestamp ONCE per operation. See
  // header lock #7.
  const now = resolveNowForCliTimestamp();

  // Step 4: branch on `name`. With a name, acquire the D22 lock and
  // run scan+create inside it. Without a name, skip the lock entirely
  // (no uniqueness invariant to protect — D5b lock #4).
  const protectedFlow = async (): Promise<{ checkpointId: string }> => {
    // Step 4a: name-collision scan (only when name supplied).
    if (opts.name !== undefined) {
      let existing: Awaited<ReturnType<typeof safeListCheckpoints>>;
      try {
        existing = await safeListCheckpoints(repoRoot);
      } catch (err) {
        if (err instanceof CheckpointListLoadError) {
          // Wrap the helper-internal error into the operation-public
          // type. MCP's constructor-keyed map keys on this wrapped
          // type, NOT on the helper-internal type — preserving the
          // package-internal/public-surface boundary per D99.M.19.
          throw new CreateCheckpointListLoadError({ repoRoot, cause: err });
        }
        throw err;
      }
      const collision = existing.find((c) => c.name === opts.name);
      if (collision !== undefined) {
        throw new CheckpointNameCollisionError({ checkpointName: opts.name });
      }
    }

    // Step 4b: generate a generic random temp dir name (NOT
    // id-bearing — the checkpoint id is owned by git per D17b).
    // Parent `.viberevert/checkpoints/` is NOT pre-created here;
    // git.createCheckpoint's internal `mkdir({recursive:true})`
    // handles it. See header lock #5 final paragraph.
    const tmpName = `.tmp-checkpoint-${randomBytes(8).toString("hex")}`;
    const tmpDirAbs = join(repoRoot, ".viberevert", "checkpoints", tmpName);

    let result: { checkpointId: string };
    try {
      // Step 4c: create the checkpoint. `sessionId` is intentionally
      // omitted — git defaults `manifest.session_id` to the checkpoint
      // id for standalone checkpoints (D6: "this manifest's parent
      // record").
      result = await createCheckpoint({
        repoRoot,
        checkpointDir: tmpDirAbs,
        rollbackExcludePatterns,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        capturedAt: now,
      });
    } catch (err) {
      // Best-effort cleanup of tmpDirAbs. Failures here are silently
      // swallowed (original createCheckpoint failure is what the
      // caller needs to see). D13 tolerates leftover .tmp-* entries
      // even if cleanup itself fails.
      await rm(tmpDirAbs, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    // Step 4d: atomically rename tmp → final. cli-commands uses its
    // OWN private renameDirAtomic (NOT core's, NOT git's — D17c
    // discipline). result.checkpointId already includes the `cp_`
    // prefix per D5; do NOT prepend `cp_` again.
    const finalDirAbs = join(repoRoot, ".viberevert", "checkpoints", result.checkpointId);
    await renameDirAtomic(tmpDirAbs, finalDirAbs);

    return result;
  };

  let result: { checkpointId: string };
  if (opts.name !== undefined) {
    const lockDir = join(repoRoot, CHECKPOINT_NAME_LOCK_REL);
    // Compose the D22 lock metadata `command` label. Defaults to the
    // existing CLI literal so callers that omit `lockCommand` get
    // byte-identical lock metadata to the pre-extraction
    // CheckpointCommand. MCP handlers pass
    // `lockCommand: "viberevert mcp create_checkpoint"`.
    const command = opts.lockCommand ?? `viberevert checkpoint --name ${JSON.stringify(opts.name)}`;
    const lockInfo: LockInfo = {
      pid: process.pid,
      command,
      started_at: now,
      host: hostname(),
    };
    result = await withExclusiveLock(lockDir, lockInfo, protectedFlow);
  } else {
    // No name → no D22 lock needed (no uniqueness invariant).
    result = await protectedFlow();
  }

  return { checkpointId: result.checkpointId, createdAt: now };
}
