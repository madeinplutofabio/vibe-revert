// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert checkpoint [--name <label>]` — create a standalone
// checkpoint of the current working tree.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
// 1. **D19: REQUIRES valid config.** Unlike end/checkpoints/sessions
//    (which are config-blind per D19), this command MUST load and
//    validate `.viberevert.yml` — `rollback.exclude` directly
//    determines what is captured (D3 symmetry: capture excludes ↔
//    restore excludes), so silently using an empty default would
//    diverge later restore behavior from user expectations. Hard-fail
//    on missing/invalid config with the locked directive copy.
//
// 2. **D16/D17c: git invocation through @viberevert/git only.** This
//    command MUST NOT import `child_process`. Checkpoint creation
//    happens via `git.createCheckpoint`; name-collision scanning via
//    `git.listCheckpoints`. The architectural-invariants test from
//    Step 3f polices this for the whole `cli/src/commands/**` tree.
//
// 3. **D17: standalone, never touches active-session.json.** Even when
//    a session is active, `viberevert checkpoint` runs as a standalone
//    checkpoint — does NOT mutate the session's `checkpoint_id` and
//    does NOT create an inner-session checkpoint. Users expect
//    `checkpoint` to work at any time as an extra safety recovery
//    point. This command intentionally does NOT call
//    `loadActiveSessionLock` — touching the lock would break the
//    invariant that `active-session.json.checkpoint_id` always points
//    to the session-start checkpoint.
//
// 4. **D5b + D22: name-collision protection via D22 mkdir lock IFF
//    --name is supplied.** Nameless checkpoints have no uniqueness
//    invariant to protect, so they skip the lock entirely (saves an
//    fs round-trip per nameless invocation). When `--name X` IS
//    supplied, the lock is held from the start of the manifest scan
//    through the atomic outer rename — closes the race window where
//    two concurrent `--name X` invocations could both pass the
//    pre-write collision check and both write.
//
// 5. **D17b: CLI generates the temp dir; git generates the checkpoint
//    id internally.** The temp name is generic
//    (`.tmp-checkpoint-<random-hex>`) — NOT id-bearing — because the
//    CLI does not pre-generate checkpoint ids (git owns checkpoint
//    identity per D5/D17b). After `git.createCheckpoint` returns
//    `{ checkpointId }`, the CLI uses ITS OWN private `renameDirAtomic`
//    (NOT core's, NOT git's) to atomically rename the temp dir to
//    `<checkpointId>/`. The returned `checkpointId` already includes
//    the `cp_` prefix per D5; do NOT prepend `cp_` again or the final
//    dir becomes `cp_cp_…/`.
//
// 6. **D13/D17c: cleanup on createCheckpoint failure.** If
//    `git.createCheckpoint` throws, we attempt `rm -rf` on the temp
//    dir to avoid leaking stale `.tmp-checkpoint-<hex>/` siblings.
//    Cleanup errors are swallowed (the original failure is what the
//    user needs to see). On createCheckpoint SUCCESS but rename
//    failure, the tmp dir is left in place — its contents are valid
//    and the user may want to recover them; D13's locked rule
//    tolerates leftover `.tmp-*` entries (loaders skip them).
//
// 7. **D22 refusal copy is locked verbatim.** The
//    `ConcurrentOperationError` refusal message has TWO variants
//    (lock.json present → name pid+command+started_at; lock.json
//    missing → "lock metadata unavailable"). Both name the lock-dir
//    path and the action ("remove this stale lock directory
//    manually") in platform-neutral copy — no shell-specific command
//    (vibe-revert is cross-platform per the locked plan). The path
//    uses forward slashes per D17c's canonical-path rule, even on
//    Windows.

import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  RepoRootNotFoundError,
  resolveRepoRoot,
} from "@viberevert/core";
import {
  CheckpointCorruptError,
  CheckpointNotFoundError,
  createCheckpoint,
  listCheckpoints,
} from "@viberevert/git";
import { Command, Option } from "clipanion";

import { renameDirAtomic } from "../atomic.js";
import {
  ConcurrentOperationError,
  type LockInfo,
  withExclusiveLock,
} from "../locks.js";

const CHECKPOINT_NAME_LOCK_REL = ".viberevert/.locks/checkpoint-name.lock";

export class CheckpointCommand extends Command {
  static override paths = [["checkpoint"]];

  static override usage = Command.Usage({
    description:
      "Create a standalone checkpoint of the current working tree",
  });

  name = Option.String("--name", {
    description:
      "Optional human-readable label for this checkpoint (must be unique within the repo)",
  });

  override async execute(): Promise<number> {
    // Step 1: resolve repo root.
    let repoRoot: string;
    try {
      repoRoot = resolveRepoRoot();
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        this.context.stderr.write(
          "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
        );
        this.context.stderr.write(
          "Run `viberevert init` to create a project here.\n",
        );
        return 1;
      }
      throw err;
    }

    // Step 2: validate --name input (defensive — schema also rejects,
    // but a clean CLI-level error is friendlier than a deep zod issue).
    if (this.name !== undefined && this.name.trim().length === 0) {
      this.context.stderr.write(
        "--name must not be empty or whitespace-only.\n",
      );
      return 1;
    }

    // Step 3: load+validate config (D19). Required because
    // rollback.exclude directly determines what we capture (D3
    // symmetry); silently defaulting to [] would diverge later
    // restore behavior from user expectations.
    let rollbackExcludePatterns: readonly string[];
    try {
      const config = await loadConfig(repoRoot);
      rollbackExcludePatterns = config.rollback?.exclude ?? [];
    } catch (err) {
      if (err instanceof ConfigNotFoundError) {
        this.context.stderr.write(
          "No .viberevert.yml found in this repo.\n",
        );
        this.context.stderr.write("Run:\n");
        this.context.stderr.write("  viberevert init\n\n");
        this.context.stderr.write("to create one.\n");
        return 1;
      }
      if (
        err instanceof ConfigParseError ||
        err instanceof ConfigValidationError
      ) {
        this.context.stderr.write(`Invalid .viberevert.yml: ${err.message}\n`);
        this.context.stderr.write("Fix the file, or re-run:\n");
        this.context.stderr.write("  viberevert init\n\n");
        this.context.stderr.write("to start fresh.\n");
        return 1;
      }
      throw err;
    }

    // Step 4: branch on --name. With a name, acquire the D22 lock
    // and run scan+create inside it. Without a name, skip the lock
    // entirely (no uniqueness invariant to protect).
    const protectedFlow = async (): Promise<{ checkpointId: string }> => {
      // Inside the (optional) D22 lock: collision scan first, then
      // create+rename. With the lock held, no concurrent invocation
      // can pass the scan after we've already passed it.
      if (this.name !== undefined) {
        const existing = await safeListCheckpoints(repoRoot, this);
        if (existing === null) {
          // safeListCheckpoints already wrote to stderr; signal exit
          // via a sentinel. Returning anything other than throwing
          // would require a richer return type; throwing a typed
          // sentinel keeps the happy path linear.
          throw new CollisionExitSentinel();
        }
        const collision = existing.find((c) => c.name === this.name);
        if (collision !== undefined) {
          // D5b locked refusal copy.
          this.context.stderr.write(
            `Checkpoint name already exists: ${this.name}\n`,
          );
          this.context.stderr.write(
            "Use a different name, or list existing checkpoints with:\n",
          );
          this.context.stderr.write("  viberevert checkpoints\n");
          throw new CollisionExitSentinel();
        }
      }

      // Generate a generic random temp dir name (NOT id-bearing —
      // the checkpoint id is owned by git and generated inside
      // createCheckpoint, per D17b).
      const tmpName = `.tmp-checkpoint-${randomBytes(8).toString("hex")}`;
      const tmpDirAbs = join(
        repoRoot,
        ".viberevert",
        "checkpoints",
        tmpName,
      );

      let result: { checkpointId: string };
      try {
        result = await createCheckpoint({
          repoRoot,
          checkpointDir: tmpDirAbs,
          rollbackExcludePatterns,
          ...(this.name !== undefined ? { name: this.name } : {}),
          // sessionId intentionally omitted — git defaults to
          // checkpointId for standalone checkpoints (D6: "this
          // manifest's parent record").
        });
      } catch (err) {
        // Cleanup the temp dir on failure to avoid leaking stale
        // `.tmp-checkpoint-<hex>/` siblings. Cleanup errors are
        // swallowed (the original createCheckpoint failure is what
        // the user needs to see). D13 tolerates leftover .tmp-*
        // entries even if cleanup fails.
        await rm(tmpDirAbs, { recursive: true, force: true }).catch(() => {});
        throw err;
      }

      // Atomically rename tmp → final. CLI uses its OWN private
      // renameDirAtomic (NOT core's, NOT git's — D17c discipline).
      // result.checkpointId already includes the `cp_` prefix per
      // D5; do NOT prepend `cp_` again.
      const finalDirAbs = join(
        repoRoot,
        ".viberevert",
        "checkpoints",
        result.checkpointId,
      );
      await renameDirAtomic(tmpDirAbs, finalDirAbs);

      return result;
    };

    let result: { checkpointId: string };
    try {
      if (this.name !== undefined) {
        const lockDir = join(repoRoot, CHECKPOINT_NAME_LOCK_REL);
        const lockInfo: LockInfo = {
          pid: process.pid,
          command: `viberevert checkpoint --name ${JSON.stringify(this.name)}`,
          started_at: `${new Date().toISOString().slice(0, 19)}Z`,
          host: hostname(),
        };
        result = await withExclusiveLock(lockDir, lockInfo, protectedFlow);
      } else {
        // No --name → no lock needed (D22 lock is only for the
        // name-uniqueness invariant; nameless checkpoints don't
        // have one).
        result = await protectedFlow();
      }
    } catch (err) {
      if (err instanceof CollisionExitSentinel) {
        // safeListCheckpoints OR the collision branch already wrote
        // the refusal message to stderr. Just exit 1.
        return 1;
      }
      if (err instanceof ConcurrentOperationError) {
        // D22 locked refusal copy with TWO variants depending on
        // whether lock.json was readable.
        this.context.stderr.write(
          err.info !== null
            ? `Another viberevert operation is already running:\n  command:  ${err.info.command}\n  pid:      ${err.info.pid}\n  since:    ${err.info.started_at}\n\nIf you're sure that command isn't running anymore (e.g., crashed),\nremove this stale lock directory manually:\n  ${CHECKPOINT_NAME_LOCK_REL}\n`
            : `Another viberevert operation is already running (lock metadata unavailable).\n\nIf you're sure no other viberevert command is running,\nremove this stale lock directory manually:\n  ${CHECKPOINT_NAME_LOCK_REL}\n`,
        );
        return 1;
      }
      throw err;
    }

    // Step 5: print success summary.
    this.context.stdout.write("Checkpoint created.\n");
    this.context.stdout.write(`ID: ${result.checkpointId}\n`);
    if (this.name !== undefined) {
      this.context.stdout.write(`Name: ${this.name}\n`);
    }
    return 0;
  }
}

/**
 * Internal sentinel used to break out of the (possibly locked)
 * `protectedFlow` after a collision-class refusal. The catch block
 * in `execute()` recognizes it and returns exit 1 cleanly — without
 * confusing the message-write logic with a separate "did we already
 * write the refusal?" flag. NOT exported; not a public API.
 */
class CollisionExitSentinel extends Error {
  constructor() {
    super("collision exit (internal sentinel)");
    this.name = "CollisionExitSentinel";
  }
}

/**
 * Wrap `git.listCheckpoints` with the same clean-stderr error
 * handling as the `viberevert checkpoints` command. Returns the
 * array on success, OR `null` if a corruption/not-found error was
 * surfaced (the caller should treat this as a refusal that has
 * already been printed and exit 1).
 *
 * Distinguishing "no checkpoints exist" (returns `[]`) from "could
 * not read checkpoints" (returns `null` after writing stderr) is
 * essential for the collision-scan flow: an empty repo should
 * proceed to creation; a corrupt repo should refuse cleanly.
 */
async function safeListCheckpoints(
  repoRoot: string,
  cmd: { context: { stderr: { write(s: string): unknown } } },
): Promise<readonly { name: string | null }[] | null> {
  try {
    return await listCheckpoints(repoRoot);
  } catch (err) {
    if (
      err instanceof CheckpointCorruptError ||
      err instanceof CheckpointNotFoundError
    ) {
      cmd.context.stderr.write(
        `Error reading existing checkpoints: ${err.message}\n`,
      );
      return null;
    }
    throw err;
  }
}
