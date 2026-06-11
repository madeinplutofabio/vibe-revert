// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert start [--task "..."]` — begin a new session, capturing
// the pre-session checkpoint and persisting the active-session lock.
//
// =============================================================================
// Post-extraction architecture (M G1a Step 1, Option D)
// =============================================================================
//
// Domain logic lives in `../operations/start-session.ts`. This Command
// is now a thin presentation shell:
//   1. Parse + validate CLI options (defensive --task whitespace check).
//   2. Call startSessionOperation(...).
//   3. Map typed errors to existing human stderr copy (byte-for-byte
//      preserved from the pre-extraction implementation).
//   4. Render success summary to stdout.
//
// All 7 architectural locks (D19/D16/D17c/D22/D17b/timestamps/D13)
// previously documented in this file's header are now owned by the
// operation. See `operations/start-session.ts` for the canonical
// documentation.

import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  RepoRootNotFoundError,
  SessionAlreadyActiveError,
} from "@viberevert/core";
import { Command, Option } from "clipanion";

import { truncateIdForDisplay } from "../format.js";
import { ConcurrentOperationError } from "../locks.js";
import {
  START_LOCK_REL,
  type StartSessionOperationResult,
  startSessionOperation,
} from "../operations/start-session.js";
import { RuntimeEnvInvalidError } from "../runtime-env.js";

export class StartCommand extends Command {
  static override paths = [["start"]];

  static override usage = Command.Usage({
    description: "Begin a new session, capturing the pre-session checkpoint",
  });

  task = Option.String("--task", {
    description: "Optional human-readable description of what this session will do",
  });

  override async execute(): Promise<number> {
    // Defensive --task validation (CLI-only; MCP's Zod schema rejects
    // empty/whitespace before calling the operation per its Input
    // validation boundary).
    if (this.task !== undefined && this.task.trim().length === 0) {
      this.context.stderr.write("--task must not be empty or whitespace-only.\n");
      return 1;
    }

    let result: StartSessionOperationResult;
    try {
      result = await startSessionOperation({
        cwd: process.cwd(),
        ...(this.task !== undefined ? { task: this.task } : {}),
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
      if (err instanceof SessionAlreadyActiveError) {
        // D74-unlocked refusal copy (M D Step 7). Truncated IDs match
        // the plan's example. The "Use:" footer's `end && rollback`
        // compound is intentional, not decorative: D63's state-machine
        // invariant requires ending a session before rolling it back,
        // so a bare `viberevert rollback <session>` on the active
        // session would refuse — the && compound is the only safe
        // "discard this session's changes" path.
        const lock = err.active;
        this.context.stderr.write("A session is already active in this repo.\n\n");
        this.context.stderr.write(`Session:     ${truncateIdForDisplay(lock.session_id)}\n`);
        this.context.stderr.write(`Started at:  ${lock.started_at}\n`);
        if (lock.task !== undefined) {
          this.context.stderr.write(`Task:        ${lock.task}\n`);
        }
        this.context.stderr.write(`Checkpoint:  ${truncateIdForDisplay(lock.checkpoint_id)}\n`);
        this.context.stderr.write("\nUse:\n");
        this.context.stderr.write("  viberevert sessions\n");
        this.context.stderr.write(
          "  viberevert end                                     (then start fresh)\n",
        );
        this.context.stderr.write(
          "  viberevert end && viberevert rollback <session>    (then discard that session's changes)\n",
        );
        return 1;
      }
      if (err instanceof ConcurrentOperationError) {
        // D22 locked refusal copy with TWO variants depending on
        // whether lock.json was readable. Path uses forward slashes
        // per D22's platform-neutral copy rule.
        this.context.stderr.write(
          err.info !== null
            ? `Another viberevert operation is already running:\n  command:  ${err.info.command}\n  pid:      ${err.info.pid}\n  since:    ${err.info.started_at}\n\nIf you're sure that command isn't running anymore (e.g., crashed),\nremove this stale lock directory manually:\n  ${START_LOCK_REL}\n`
            : `Another viberevert operation is already running (lock metadata unavailable).\n\nIf you're sure no other viberevert command is running,\nremove this stale lock directory manually:\n  ${START_LOCK_REL}\n`,
        );
        return 1;
      }
      throw err;
    }

    // Step 5: print success summary. Full IDs (NOT truncated) for
    // copy-paste utility — consistent with end.ts's success format.
    this.context.stdout.write("Session started.\n");
    this.context.stdout.write(`ID: ${result.sessionId}\n`);
    if (this.task !== undefined) {
      this.context.stdout.write(`Task: ${this.task}\n`);
    }
    this.context.stdout.write(`Checkpoint: ${result.checkpointId}\n`);
    this.context.stdout.write(`Started: ${result.startedAt}\n`);
    return 0;
  }
}
