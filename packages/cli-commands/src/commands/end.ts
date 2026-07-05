// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert end` — end the active session, capturing post-session
// git status.
//
// =============================================================================
// Post-extraction architecture (M G2 Step 3, mirroring M G1a Option D)
// =============================================================================
//
// Domain logic lives in `../operations/end-session.ts`. This Command is
// now a thin presentation shell:
//   1. Call endSessionOperation(...).
//   2. Map typed errors to existing human stderr copy (byte-for-byte
//      preserved from the pre-extraction implementation).
//   3. Render the success summary to stdout.
//
// All architectural locks (D19 config-blind, D16/D17c git-through-
// @viberevert/git, deterministic timestamps, plain inputs to core, no
// D22 lock around end) previously documented in this file's header are
// now owned by the operation. See `operations/end-session.ts` for the
// canonical documentation.
//
// The pre-extraction implementation distinguished two NoActiveSession
// presentations: the pre-check refusal ("No active session...") and the
// concurrent-end race ("removed by another `viberevert end`..."). The
// operation preserves that split by wrapping the race case in
// EndSessionRaceError, so both messages remain byte-identical here.

import { NoActiveSessionError, RepoRootNotFoundError } from "@viberevert/core";
import { Command } from "clipanion";

import {
  type EndSessionOperationResult,
  EndSessionRaceError,
  endSessionOperation,
} from "../operations/end-session.js";
import { RuntimeEnvInvalidError } from "../runtime-env.js";

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
      if (err instanceof RuntimeEnvInvalidError) {
        this.context.stderr.write(`${err.message}\n`);
        return 1;
      }
      if (err instanceof EndSessionRaceError) {
        this.context.stderr.write(
          "Active session was removed by another `viberevert end` between check and end.\n",
        );
        return 1;
      }
      throw err;
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
