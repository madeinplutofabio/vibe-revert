// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert end` — end the active session, capturing the session's
// contribution and post-session git status.
//
// =============================================================================
// Post-extraction architecture (M G2 Step 3, mirroring M G1a Option D)
// =============================================================================
//
// Domain logic lives in `../operations/end-session.ts`. This Command is
// now a thin presentation shell:
//   1. Call endSessionOperation(...).
//   2. Map typed errors to human stderr copy.
//   3. Surface any cleanup warnings on stderr.
//   4. Render the success summary to stdout.
//
// All architectural locks (D19 config-blind, D16/D17c git-through-
// @viberevert/git, deterministic timestamps, plain inputs to core, and
// as of M 0.8.0 step 4c the D22 lifecycle lock around the WHOLE end
// transaction) are owned by the operation. See
// `operations/end-session.ts` for the canonical documentation.
//
// The catch branches below are disjoint `instanceof` checks; their order
// carries no meaning.
//
// =============================================================================
// What M 0.8.0 step 4c changed for THIS file
// =============================================================================
//
// Ending a session now reconstructs the session's checkpoint and fences
// the terminal state before publishing. Four presentation consequences:
//
// 1. **Three persisted-state refusals became reachable.** Before 4c,
//    `end` never read the checkpoint, so none of these could occur here:
//      - `CheckpointNotFoundError`   — the checkpoint is gone.
//      - `CheckpointCorruptError`    — it is present but untrustworthy.
//      - `SessionCheckpointBindingError` — it is intact but belongs to a
//        DIFFERENT session.
//    All three are states a user can reach without any code defect: a
//    deleted directory, a partial backup restore, a copied or renamed
//    session dir. They share one explanation but get distinct leads,
//    because "missing", "untrustworthy", and "someone else's" call for
//    different user understanding. `CheckpointCorruptError` documents
//    that requirement on itself.
//
// 2. **The fence can refuse.** `EndStateChangedDuringCaptureError` means
//    the repository kept changing across every capture attempt, so
//    VibeRevert declined to publish evidence it could not verify as
//    stable. That is the fence working, not failing — a build watcher, a
//    code generator, or an editor saving during `end` all produce it.
//    Leaving it unmapped would let the mechanism's own success case
//    surface as a crash.
//
// 3. **ConcurrentOperationError is now reachable**, because the
//    operation holds the shared lifecycle lock. Rendered through
//    `formatConcurrentOperationRefusal`, the canonical D22 copy that
//    lives beside the error class.
//
// 4. **EndSessionRaceError MEANS something different**, and this file's
//    copy follows. A competing `viberevert end` is now refused at the
//    lock and never reaches core's re-check, so what remains is removal
//    of `active-session.json` by something outside the lifecycle-lock
//    protocol. The old "removed by another `viberevert end`" wording
//    would name the one cause that can no longer produce it.
//
// **Deliberately NOT mapped:** `ConflictingRenameProposalError`. It is
// raised only after four-state rename acceptance and duplicate collapsing
// have already run, so reaching it means the derivation hit a state it
// believes impossible. That is a defect signal, and dressing it as a
// user refusal would hide a bug. It stays loud.
//
// The pre-check refusal ("No active session...") and the race refusal
// remain two distinct presentations of two distinct conditions, which is
// why the operation keeps them as separate classes.

import { NoActiveSessionError, RepoRootNotFoundError } from "@viberevert/core";
import {
  CheckpointCorruptError,
  CheckpointNotFoundError,
  EndStateChangedDuringCaptureError,
  SessionCheckpointBindingError,
} from "@viberevert/git";
import { Command } from "clipanion";

import { ConcurrentOperationError, formatConcurrentOperationRefusal } from "../locks.js";
import {
  type EndSessionOperationResult,
  EndSessionRaceError,
  endSessionOperation,
} from "../operations/end-session.js";
import { START_LOCK_REL } from "../operations/start-session.js";
import { RuntimeEnvInvalidError } from "../runtime-env.js";

/**
 * Lead line for the three "this session's checkpoint cannot be used"
 * refusals. They share one explanation but not one diagnosis.
 */
function checkpointRefusalLead(
  err: CheckpointNotFoundError | CheckpointCorruptError | SessionCheckpointBindingError,
): string {
  if (err instanceof CheckpointNotFoundError) {
    return "Cannot end this session: its checkpoint is missing.";
  }
  if (err instanceof CheckpointCorruptError) {
    return "Cannot end this session: its checkpoint is corrupt.";
  }
  return "Cannot end this session: its checkpoint belongs to a different session.";
}

export class EndCommand extends Command {
  static override paths = [["end"]];

  static override usage = Command.Usage({
    description: "End the active session, capturing post-session git status",
  });

  override async execute(): Promise<number> {
    let result: EndSessionOperationResult;
    try {
      result = await endSessionOperation({ cwd: process.cwd() });
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        this.context.stderr.write(
          "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
        );
        this.context.stderr.write("Run `viberevert init` to create a project here.\n");
        return 1;
      }
      if (err instanceof NoActiveSessionError) {
        this.context.stderr.write("No active session in this repo.\n\n");
        this.context.stderr.write("Use:\n");
        this.context.stderr.write("  viberevert start\n\n");
        this.context.stderr.write("to start a new session.\n");
        return 1;
      }
      if (err instanceof ConcurrentOperationError) {
        // D22 locked refusal copy, rendered by the formatter that lives
        // beside the error class. The lock path is the shared lifecycle
        // lock, repo-relative with forward slashes per D22.
        this.context.stderr.write(formatConcurrentOperationRefusal(err.info, START_LOCK_REL));
        return 1;
      }
      if (
        err instanceof CheckpointNotFoundError ||
        err instanceof CheckpointCorruptError ||
        err instanceof SessionCheckpointBindingError
      ) {
        this.context.stderr.write(`${checkpointRefusalLead(err)}\n`);
        // The error's own message carries the path (or the two session
        // ids) and the specific reason.
        this.context.stderr.write(`${err.message}\n\n`);
        this.context.stderr.write(
          "Ending a session records what it changed, which requires reconstructing\n",
        );
        this.context.stderr.write(
          "that session's checkpoint. The session is left active and unchanged.\n",
        );
        return 1;
      }
      if (err instanceof EndStateChangedDuringCaptureError) {
        this.context.stderr.write(
          "Cannot end this session because the project kept changing during capture.\n\n",
        );
        this.context.stderr.write(
          "VibeRevert refused to publish an end state that it could not verify as stable.\n",
        );
        this.context.stderr.write(
          "Stop other writers or background processes changing the repo, then retry:\n",
        );
        this.context.stderr.write("  viberevert end\n");
        return 1;
      }
      if (err instanceof RuntimeEnvInvalidError) {
        this.context.stderr.write(`${err.message}\n`);
        return 1;
      }
      if (err instanceof EndSessionRaceError) {
        this.context.stderr.write("Active session was removed while ending it.\n\n");
        this.context.stderr.write(
          "Something outside VibeRevert's lifecycle-lock protocol removed\n",
        );
        this.context.stderr.write(".viberevert/active-session.json mid-operation.\n");
        return 1;
      }
      throw err;
    }

    // D13/D20: stderr is the warnings channel, and warnings are written
    // BEFORE the stdout summary so they appear above it in interleaved
    // terminal display. These are non-fatal: the session IS ended, and the
    // exit code stays 0. An empty list writes nothing, so a clean end is
    // byte-identical on both streams to the pre-0.8.0 output.
    for (const warning of result.cleanupWarnings) {
      this.context.stderr.write(`warning: ${warning}\n`);
    }

    // Success summary — byte-identical to the pre-extraction output.
    this.context.stdout.write("Session ended.\n");
    this.context.stdout.write(`ID: ${result.sessionId}\n`);
    if (result.task !== undefined) {
      this.context.stdout.write(`Task: ${result.task}\n`);
    }
    this.context.stdout.write(`Started: ${result.startedAt}\n`);
    this.context.stdout.write(`Ended: ${result.endedAt}\n`);
    return 0;
  }
}
