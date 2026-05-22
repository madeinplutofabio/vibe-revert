// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert end` — end the active session, capturing post-session
// git status.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
// 1. **D19: config-blind.** This command MUST NOT import or call
//    `loadConfig` from `@viberevert/core`. Operates purely on persisted
//    `.viberevert/` state (active-session.json + the session dir it
//    references). The architectural-invariants test in 5d-2 will police
//    this by grep — ensure the import list below stays free of
//    `loadConfig`.
//
// 2. **D16/D17c: git invocation through @viberevert/git only.** This
//    command MUST NOT import `child_process`. Git status is fetched via
//    `getStatusPorcelainText` from `@viberevert/git`, which is the
//    single owner of git-binary invocation in the codebase. The
//    architectural-invariants test from Step 3f already polices this
//    for the whole `cli/src/commands/**` tree.
//
// 3. **session.ts architectural lock #2: deterministic timestamps.**
//    `core.endSession` accepts `endedAt` as a plain string input — it
//    never calls `new Date()` internally. The CLI generates the
//    timestamp here via `resolveNowForCliTimestamp()` from
//    `runtime-env.ts`, which (a) produces second-precision ISO 8601
//    with Z offset to satisfy `SessionStateSchema.ended_at`'s
//    `z.iso.datetime({offset: true, precision: 0})` validator, and
//    (b) honors `VIBEREVERT_TEST_FIXED_NOW` for fixture determinism
//    per D49 (M C addition). Production behavior is unchanged.
//
// 4. **D17c: plain inputs to core.** `core.endSession` receives
//    `{repoRoot, endedAt, afterStatusText}` only. No config, no git
//    refs, no derived state. Matches the "core takes plain typed
//    inputs from the orchestration layer" boundary.
//
// 5. **D11: refusal exit code is 1.** Both refusal cases (no repo
//    root, no active session) exit 1 with a directive stderr message
//    pointing the user at the next action. The "session already
//    active" refusal copy in D11 is locked verbatim; the "no active
//    session" copy is not locked, so the wording below is
//    structurally consistent with D11's pattern (informative + "Use:"
//    footer naming only commands that exist in M B).
//
// 6. **No D22 lock around end.** Per the plan, only `start.ts` and
//    `checkpoint.ts --name` acquire D22 mkdir locks. End is unlocked;
//    concurrent-end safety relies on core's in-function
//    `loadActiveSessionLock` re-check (per session.ts's `endSession`
//    pre-conditions docstring as of the 5d-1 fix). The narrower
//    double-end race after both calls pass the re-check is documented
//    there.

import {
  endSession,
  loadActiveSessionLock,
  NoActiveSessionError,
  RepoRootNotFoundError,
  resolveRepoRoot,
} from "@viberevert/core";
import { getStatusPorcelainText } from "@viberevert/git";
import { Command } from "clipanion";

import { RuntimeEnvInvalidError, resolveNowForCliTimestamp } from "../runtime-env.js";

export class EndCommand extends Command {
  static override paths = [["end"]];

  static override usage = Command.Usage({
    description: "End the active session, capturing post-session git status",
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
        this.context.stderr.write("Run `viberevert init` to create a project here.\n");
        return 1;
      }
      throw err;
    }

    // Step 2: pre-check active lock for friendly refusal copy AND for
    // the success-message data (lock.session_id, lock.started_at,
    // lock.task). core.endSession would also re-check the lock and
    // throw NoActiveSessionError if absent, but the pre-check lets us
    // print the directive message without going through git first.
    const lock = await loadActiveSessionLock(repoRoot);
    if (lock === null) {
      this.context.stderr.write("No active session in this repo.\n\n");
      this.context.stderr.write("Use:\n");
      this.context.stderr.write("  viberevert start\n\n");
      this.context.stderr.write("to start a new session.\n");
      return 1;
    }

    // Step 3: fetch raw `git status --porcelain=v1` text via
    // @viberevert/git (single owner of git invocation per D16/D17c).
    const afterStatusText = await getStatusPorcelainText(repoRoot);

    // Step 4: generate ISO timestamp via the CLI's runtime-env
    // resolver. Production path: `resolveNowForCliTimestamp()` returns
    // `new Date()` normalized to second-precision ISO 8601 with Z
    // offset (same shape as M B's prior `slice(0, 19) + "Z"` form, but
    // routed through @viberevert/session-format's `toIsoSecondString`
    // helper for cross-package consistency). Test path:
    // `VIBEREVERT_TEST_FIXED_NOW` overrides the value verbatim, making
    // `session.json.ended_at` byte-deterministic under Step 10's
    // golden-fixture harness (D49).
    //
    // RuntimeEnvInvalidError fires only when the env var is set AND
    // malformed — a test-only failure mode. Catch and surface as exit 1
    // with the error's pre-formatted message (envVar=value: reason).
    let endedAt: string;
    try {
      endedAt = resolveNowForCliTimestamp();
    } catch (err) {
      if (err instanceof RuntimeEnvInvalidError) {
        this.context.stderr.write(`${err.message}\n`);
        return 1;
      }
      throw err;
    }

    // Step 5: call core to perform the atomic mutations.
    try {
      await endSession({ repoRoot, endedAt, afterStatusText });
    } catch (err) {
      if (err instanceof NoActiveSessionError) {
        // Race: another `viberevert end` operation deleted
        // active-session.json between our pre-check and core's
        // re-check. In M B, `active-session.json` is only deleted by
        // endSession itself, so the only realistic source of this
        // race is a concurrent `viberevert end` that won the
        // delete first. The narrower double-pass-recheck race is
        // documented in core's `endSession` pre-conditions and
        // surfaces as ENOENT (not NoActiveSessionError) — that one
        // propagates as an uncaught error to the user.
        this.context.stderr.write(
          "Active session was removed by another `viberevert end` between check and end.\n",
        );
        return 1;
      }
      throw err;
    }

    // Step 6: print success summary.
    this.context.stdout.write("Session ended.\n");
    this.context.stdout.write(`ID: ${lock.session_id}\n`);
    if (lock.task !== undefined) {
      this.context.stdout.write(`Task: ${lock.task}\n`);
    }
    this.context.stdout.write(`Started: ${lock.started_at}\n`);
    this.context.stdout.write(`Ended: ${endedAt}\n`);
    return 0;
  }
}
