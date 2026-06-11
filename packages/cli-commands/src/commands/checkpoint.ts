// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert checkpoint [--name <label>]` — create a standalone
// checkpoint of the current working tree.
//
// =============================================================================
// Post-extraction architecture (M G1a Step 1, Option D)
// =============================================================================
//
// Domain logic lives in `../operations/create-checkpoint.ts`. This
// Command is now a thin presentation shell:
//   1. Parse + validate CLI options (defensive --name whitespace check).
//   2. Call createCheckpointOperation(...).
//   3. Map typed errors to existing human stderr copy (byte-for-byte
//      preserved from the pre-extraction implementation).
//   4. Render success summary to stdout.
//
// All 7 architectural locks (D19/D16/D17c/D17/D5b+D22/D17b/D13)
// previously documented in this file's header are now owned by the
// operation. See `operations/create-checkpoint.ts` for the canonical
// documentation.
//
// Note: this Command no longer uses `safeListCheckpoints` or
// `CollisionExitSentinel` directly. The operation throws the typed
// `CreateCheckpointListLoadError` and `CheckpointNameCollisionError`
// classes instead, eliminating the sentinel-passes-by-throw pattern
// for the operation-driven path. `CollisionExitSentinel` stays in
// `checkpoint-helpers.ts` for `commands/rollback.ts`'s
// `createEmergencyCheckpoint` path (separate flow with its own
// suffix-counter semantics).

import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  RepoRootNotFoundError,
} from "@viberevert/core";
import { Command, Option } from "clipanion";

import { ConcurrentOperationError } from "../locks.js";
import {
  CHECKPOINT_NAME_LOCK_REL,
  CheckpointNameCollisionError,
  CreateCheckpointListLoadError,
  type CreateCheckpointOperationResult,
  createCheckpointOperation,
} from "../operations/create-checkpoint.js";
import { RuntimeEnvInvalidError } from "../runtime-env.js";

export class CheckpointCommand extends Command {
  static override paths = [["checkpoint"]];

  static override usage = Command.Usage({
    description: "Create a standalone checkpoint of the current working tree",
  });

  name = Option.String("--name", {
    description:
      "Optional human-readable label for this checkpoint (must be unique within the repo)",
  });

  override async execute(): Promise<number> {
    // Defensive --name validation (CLI-only; MCP's Zod schema rejects
    // empty/whitespace before calling the operation per its Input
    // validation boundary).
    if (this.name !== undefined && this.name.trim().length === 0) {
      this.context.stderr.write("--name must not be empty or whitespace-only.\n");
      return 1;
    }

    let result: CreateCheckpointOperationResult;
    try {
      result = await createCheckpointOperation({
        cwd: process.cwd(),
        ...(this.name !== undefined ? { name: this.name } : {}),
      });
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        this.context.stderr.write(
          "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
        );
        this.context.stderr.write("Run `viberevert init` to create a project here.\n");
        return 1;
      }
      if (err instanceof ConfigNotFoundError) {
        this.context.stderr.write("No .viberevert.yml found in this repo.\n");
        this.context.stderr.write("Run:\n");
        this.context.stderr.write("  viberevert init\n\n");
        this.context.stderr.write("to create one.\n");
        return 1;
      }
      if (err instanceof ConfigParseError || err instanceof ConfigValidationError) {
        this.context.stderr.write(`Invalid .viberevert.yml: ${err.message}\n`);
        this.context.stderr.write("Fix the file, or re-run:\n");
        this.context.stderr.write("  viberevert init\n\n");
        this.context.stderr.write("to start fresh.\n");
        return 1;
      }
      if (err instanceof RuntimeEnvInvalidError) {
        this.context.stderr.write(`${err.message}\n`);
        return 1;
      }
      if (err instanceof CheckpointNameCollisionError) {
        // D5b locked refusal copy. References the carried
        // `checkpointName` from the typed error (not `this.name`) so
        // the message identifies the actually-collided name. The
        // operation only throws this when `opts.name` was supplied,
        // so they always match — but routing through the typed field
        // keeps the Command independent of operation internals.
        this.context.stderr.write(`Checkpoint name already exists: ${err.checkpointName}\n`);
        this.context.stderr.write("Use a different name, or list existing checkpoints with:\n");
        this.context.stderr.write("  viberevert checkpoints\n");
        return 1;
      }
      if (err instanceof CreateCheckpointListLoadError) {
        // Existing stderr copy preserved byte-identical: `${err.message}`
        // is the underlying CheckpointCorruptError /
        // CheckpointNotFoundError message (the operation wrapper
        // preserves the cause's message in `Error.message`).
        this.context.stderr.write(`Error reading existing checkpoints: ${err.message}\n`);
        return 1;
      }
      if (err instanceof ConcurrentOperationError) {
        // D22 locked refusal copy with TWO variants depending on
        // whether lock.json was readable. Path uses forward slashes
        // per D22's platform-neutral copy rule.
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
