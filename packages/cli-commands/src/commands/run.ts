// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert run [--task "..."] <cmd...>` — guarded pipe-based
// subprocess wrapper with session capture (M G2, D102).
//
// =============================================================================
// Locked contract (D102.A-H; docs/run-contract.md is the user-facing form)
// =============================================================================
//
// D102.A — wraps exactly ONE child from the proxied argv:
//   spawn(argv[0], argv.slice(1), { stdio: "inherit", shell: false,
//   cwd: process.cwd() }). shell: false is LOCKED — no shell
//   interpretation, no injection surface. Guarding applies to the
//   TOP-LEVEL invocation only; commands the child runs internally are
//   NOT intercepted, and terminal output is NOT captured (sessions
//   capture FILE changes). clipanion consumes one leading `--` before
//   the first positional natively (Step 0 probe) — NO manual stripping
//   here; embedded `--` reaches the child untouched.
//
// D102.B — run OWNS its session: config → guard → confirm →
//   startSessionOperation → commands.log entry → spawn → wait →
//   endSessionOperation → summary. The child NEVER runs under the D22
//   start lock (the lock lives inside startSessionOperation). If the
//   session was already ended when end runs (ended inside the child —
//   NoActiveSessionError), warn on stderr, still print the summary (the
//   id is known), still propagate the child's exit code.
//
//   **M 0.8.0 step 4c:** EndSessionRaceError no longer belongs in that
//   already-ended family. End now holds the shared lifecycle lock for its
//   whole transaction, so a competing `viberevert end` is refused at
//   acquisition and cannot reach core's re-check. What remains is
//   active-session.json disappearing through something outside the
//   lifecycle-lock protocol — and core did NOT publish terminal session
//   state. It is therefore an end FAILURE, reported through the
//   contextual "could not be closed" path, never as a successfully
//   already-ended session.
//
//   A successful end can also return non-fatal `cleanupWarnings` (the
//   contribution oracle's scratch worktree could not be reclaimed).
//   Those are surfaced with the SESSION presentation, immediately before
//   the two-line summary — never at the call site, which would interleave
//   session-cleanup noise ahead of the user learning what happened to
//   their command. They never change an exit code.
//
// D102.D stream lock — ALL wrapper text (refusals, prompts, warnings,
//   the two-line summary) goes to STDERR. The child owns stdout via
//   stdio: "inherit"; wrapper control-plane text must not pollute
//   stdout pipelines.
//
// D102.E — exit codes: child's code propagates VERBATIM (the ambiguity
//   vs wrapper codes 1/2/126/127 is documented — same as any shell).
//   Guard/confirm refusals: 2 (pre-session). Config/internal errors: 1.
//   Spawn ENOENT: 127; EACCES: 126; Windows .cmd EINVAL: 1 + hint
//   (synchronous throw on Node 24 — hence the try/catch around spawn
//   in ADDITION to the 'error' listener). Signal death (POSIX):
//   128 + signal number. endSession failure after the child ran: 1,
//   with the child's original code printed — the ONE exception to
//   verbatim propagation (a broken session means the wrapper failed
//   its core job).
//
// D102.F — exactly one commands.log JSONL entry per run session,
//   appended via core's appendCommandsLogEntry. `at` reuses the
//   session's startedAt (single-timestamp policy; deterministic under
//   VIBEREVERT_TEST_FIXED_NOW). `cwd` is repo-relative POSIX ("." at
//   the repo root). argv is recorded verbatim — no secret redaction
//   (documented privacy boundary; also in --help). If the append fails,
//   the child is NOT spawned: running unaudited would violate this
//   contract. The session is closed if possible, and the close outcome
//   is reported honestly (closed / already ended / unknown).
//
// D102.G — NO auto-check (D102.M.5 enforces: no check/report imports
//   here). The summary is exactly two stderr lines:
//     Session: sess_<id>
//     Next: viberevert check --since sess_<id>
//
// D102.H — child is spawned non-detached: the terminal delivers Ctrl+C
//   to wrapper AND child. While the child runs, SIGINT/SIGTERM handlers
//   that only record are installed so Node's default die-immediately
//   cannot skip end-session; the awaited flow proceeds when the child
//   exits. Wrapper never forwards signals in v1. SIGKILL / terminal
//   close leaves a stale active-session.json — the existing documented
//   recovery applies (next start refuses; manual `viberevert end`).
//
// Note: config is loaded here ONCE (for the guard) and threaded into
// startSessionOperation via loadedConfig (M G4 4e-iv-a0), so the guard
// evaluation and the session start derive from ONE on-disk read — no
// second internal load, no TOCTOU window between them. The
// startSessionOperation catch still maps the repo-root/config error
// family via the shared copy helpers below (retained defensively; the
// config arms do not fire when loadedConfig is supplied).

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { relative } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import {
  appendCommandsLogEntry,
  type Config,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  NoActiveSessionError,
  RepoRootNotFoundError,
  resolveRepoRoot,
  SessionAlreadyActiveError,
} from "@viberevert/core";
import { EndStateChangedDuringCaptureError } from "@viberevert/git";
import { Command, Option } from "clipanion";

import { type CommandsPolicyConfig, evaluateCommandPolicy } from "../command-guard.js";
import { truncateIdForDisplay } from "../format.js";
import { ConcurrentOperationError, formatConcurrentOperationRefusal } from "../locks.js";
import { endSessionOperation } from "../operations/end-session.js";
import { START_LOCK_REL, startSessionOperation } from "../operations/start-session.js";
import { RuntimeEnvInvalidError } from "../runtime-env.js";
import { classifyResolvedTarget, type ResolvedTargetKind } from "./command-launcher.js";
import { createHostExecutablePathResolver } from "./executable-probe.js";

/** Confirmation phrase for commands.require_confirm matches (D102.D, USER-LOCKED). */
const CONFIRM_PHRASE = "run anyway";

/** Max length of the D22 lock-metadata command label (D102.B). */
const LOCK_COMMAND_MAX = 200;

// Shared stderr copy for errors that can surface from BOTH the
// guard-phase config load and startSessionOperation's internal load
// (TOCTOU window between the two reads). One writer per message so the
// two catch sites stay byte-identical.

function writeRepoRootNotFoundCopy(stderr: Writable): void {
  stderr.write(
    "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
  );
  stderr.write("Run `viberevert init` to create a project here.\n");
}

function writeConfigNotFoundCopy(stderr: Writable): void {
  stderr.write("No .viberevert.yml found in this repo.\n");
  stderr.write("Run:\n");
  stderr.write("  viberevert init\n\n");
  stderr.write("to create one.\n");
}

function writeInvalidConfigCopy(stderr: Writable, message: string): void {
  stderr.write(`Invalid .viberevert.yml: ${message}\n`);
  stderr.write("Fix the file, or re-run:\n");
  stderr.write("  viberevert init\n\n");
  stderr.write("to start fresh.\n");
}

/**
 * Emit non-fatal end-of-session cleanup diagnostics (M 0.8.0), in the
 * same `warning: ` form `end.ts` and `sessions.ts` use. An empty list
 * writes nothing, and this never influences an exit code: the session
 * WAS ended, only its scratch state outlived it.
 *
 * Shared because run has two end call sites and both owe the same
 * contract — `endSessionOperation` documents that no caller may silently
 * discard a non-empty list.
 */
function writeCleanupWarnings(stderr: Writable, warnings: readonly string[]): void {
  for (const warning of warnings) {
    stderr.write(`warning: ${warning}\n`);
  }
}

export interface ChildExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * D102.E pure mapper: child exit status -> wrapper exit code.
 * Exit code N propagates verbatim; POSIX signal death maps to
 * 128 + signal number via os.constants.signals. The defensive final
 * branch (neither code nor signal) cannot happen per Node's exit-event
 * contract but returns 1 rather than throwing.
 */
export function mapChildExitToCode(status: ChildExitStatus): number {
  if (status.code !== null) {
    return status.code;
  }
  if (status.signal !== null) {
    const signalNumber = osConstants.signals[status.signal];
    if (typeof signalNumber === "number") {
      return 128 + signalNumber;
    }
  }
  return 1;
}

type RunOutcome =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "spawn-error"; readonly err: NodeJS.ErrnoException }
  | { readonly kind: "unresolved" }
  | { readonly kind: "cmd-gated"; readonly resolvedTarget: string }
  | {
      readonly kind: "unsupported";
      readonly resolvedTarget: string;
      readonly targetKind: ResolvedTargetKind;
    };

export class RunCommand extends Command {
  static override paths = [["run"]];

  static override usage = Command.Usage({
    description: "Run a command inside a VibeRevert session (guarded wrapper)",
    details: `
      Runs a single child command inside a VibeRevert session: guard
      check, session start (with checkpoint), spawn, session end, then a
      hint to run \`viberevert check\`.

      Guarding applies to the TOP-LEVEL invocation only — commands the
      wrapped program runs internally (agent tool calls, subshells,
      scripts) are NOT intercepted. Terminal output is NOT captured;
      sessions capture FILE changes.

      The child is spawned with shell: false — no shell interpretation.
      On Windows, .bat/.cmd files cannot be spawned directly; use
      \`viberevert run cmd /c <script>\` (the guard then sees the
      cmd /c form).

      Note: command arguments are recorded in the session's
      commands.log; do not pass secrets as command-line arguments.

      Exit codes: the child's exit code is propagated verbatim. Guard or
      confirmation refusals exit 2 before any session starts. Spawn
      failures: 127 (not found), 126 (not executable). A child killed by
      a POSIX signal exits 128+N. If the session cannot be closed after
      the child ran, run exits 1 and prints the child's code to stderr.
    `,
    examples: [
      ["Run an agent inside a session", "viberevert run claude"],
      ["Pass flags to the child untouched", "viberevert run -- npm test --watch"],
      ["Label the session", 'viberevert run --task "refactor auth" claude'],
    ],
  });

  task = Option.String("--task", {
    description: "Optional human-readable description of what this session will do",
  });

  args = Option.Proxy({ required: 1 });

  override async execute(): Promise<number> {
    const stderr = this.context.stderr;

    // Defensive --task validation (mirrors StartCommand).
    if (this.task !== undefined && this.task.trim().length === 0) {
      stderr.write("--task must not be empty or whitespace-only.\n");
      return 1;
    }

    // Defensive argv[0] validation: core's appendCommandsLogEntry
    // rejects an empty command name — refuse HERE so no session is
    // created just to hit that rejection.
    if (this.args[0] === "") {
      stderr.write("Command name must not be empty.\n");
      return 1;
    }

    const invocationCwd = process.cwd();

    // Step 1: resolve repo root (needed for config + commands.log cwd).
    let repoRoot: string;
    try {
      repoRoot = resolveRepoRoot(invocationCwd);
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        writeRepoRootNotFoundCopy(stderr);
        return 1;
      }
      throw err;
    }

    // Step 2: load config for the guard evaluation (D19: run REQUIRES
    // valid config, like start). The SAME validated Config object is
    // threaded into startSessionOperation below (loadedConfig) so the
    // guard evaluation and the session derive from ONE on-disk read
    // (M G4 4e-iv-a0).
    let loadedConfig: Config;
    let commandsPolicy: CommandsPolicyConfig | undefined;
    try {
      loadedConfig = await loadConfig(repoRoot);
      commandsPolicy = loadedConfig.commands;
    } catch (err) {
      if (err instanceof ConfigNotFoundError) {
        writeConfigNotFoundCopy(stderr);
        return 1;
      }
      if (err instanceof ConfigParseError || err instanceof ConfigValidationError) {
        writeInvalidConfigCopy(stderr, err.message);
        return 1;
      }
      throw err;
    }

    // Step 3: guard + confirm (D102.C/D102.D) — BEFORE any session
    // exists, so refusals leave zero session residue.
    const decision = evaluateCommandPolicy(this.args, commandsPolicy);
    if (decision.kind === "guard") {
      stderr.write("Refused: this command matches a guarded pattern in .viberevert.yml.\n");
      stderr.write(`  matched rule:  ${decision.entry}\n`);
      stderr.write(`  command:       ${decision.normalized}\n`);
      stderr.write(
        "\nGuarding applies to this top-level invocation only. Edit `commands.guard` in .viberevert.yml to change the policy.\n",
      );
      return 2;
    }
    if (decision.kind === "confirm") {
      const stdinIsTty = (this.context.stdin as NodeJS.ReadStream).isTTY === true;
      if (!stdinIsTty) {
        stderr.write(
          "Refused: this command matches a confirm-required pattern in .viberevert.yml, and stdin is not a TTY (interactive confirmation is impossible).\n",
        );
        stderr.write(`  matched rule:  ${decision.entry}\n`);
        stderr.write(`  command:       ${decision.normalized}\n`);
        return 2;
      }
      stderr.write("This command matches a confirm-required pattern in .viberevert.yml.\n");
      stderr.write(`  matched rule:  ${decision.entry}\n`);
      stderr.write(`  command:       ${decision.normalized}\n\n`);
      const rl = createInterface({ input: this.context.stdin, output: stderr });
      let answer: string;
      try {
        answer = await rl.question(`Type "${CONFIRM_PHRASE}" to run this command: `);
      } finally {
        rl.close();
      }
      if (answer.trim() !== CONFIRM_PHRASE) {
        stderr.write("Confirmation did not match. Command not run.\n");
        return 2;
      }
    }

    // Step 4: start the session (D22 lock lives inside the operation;
    // the child never runs under it). The repo root is still re-resolved
    // internally; the CONFIG is threaded via loadedConfig so the session
    // shares this command's ONE on-disk read (M G4 4e-iv-a0). The
    // config-error catch arms below are retained defensively (with
    // loadedConfig supplied, the operation performs no config load, so they
    // do not fire from this path).
    const lockCommandFull = `viberevert run ${decision.normalized}`;
    const lockCommand =
      lockCommandFull.length > LOCK_COMMAND_MAX
        ? lockCommandFull.slice(0, LOCK_COMMAND_MAX)
        : lockCommandFull;
    let sessionId: string;
    let startedAt: string;
    try {
      const started = await startSessionOperation({
        cwd: invocationCwd,
        lockCommand,
        agentCommand: decision.normalized,
        loadedConfig,
        ...(this.task !== undefined ? { task: this.task } : {}),
      });
      sessionId = started.sessionId;
      startedAt = started.startedAt;
    } catch (err) {
      if (err instanceof RuntimeEnvInvalidError) {
        stderr.write(`${err.message}\n`);
        return 1;
      }
      if (err instanceof SessionAlreadyActiveError) {
        const lock = err.active;
        stderr.write("A session is already active in this repo.\n\n");
        stderr.write(`Session:     ${truncateIdForDisplay(lock.session_id)}\n`);
        stderr.write(`Started at:  ${lock.started_at}\n`);
        if (lock.task !== undefined) {
          stderr.write(`Task:        ${lock.task}\n`);
        }
        stderr.write(`Checkpoint:  ${truncateIdForDisplay(lock.checkpoint_id)}\n`);
        stderr.write("\nUse:\n");
        stderr.write("  viberevert sessions\n");
        stderr.write("  viberevert end                                     (then start fresh)\n");
        stderr.write(
          "  viberevert end && viberevert rollback <session>    (then discard that session's changes)\n",
        );
        return 1;
      }
      if (err instanceof ConcurrentOperationError) {
        // D22 locked refusal copy, rendered by the canonical formatter
        // beside the error class. This is the START lock: end contention
        // is handled by the contextual end-failure branch further down,
        // which supplies information this standalone block cannot.
        stderr.write(formatConcurrentOperationRefusal(err.info, START_LOCK_REL));
        return 1;
      }
      if (err instanceof RepoRootNotFoundError) {
        writeRepoRootNotFoundCopy(stderr);
        return 1;
      }
      if (err instanceof ConfigNotFoundError) {
        writeConfigNotFoundCopy(stderr);
        return 1;
      }
      if (err instanceof ConfigParseError || err instanceof ConfigValidationError) {
        writeInvalidConfigCopy(stderr, err.message);
        return 1;
      }
      throw err;
    }

    // Step 5: record the top-level command in commands.log (D102.F).
    // `at` reuses startedAt (single-timestamp policy). cwd is
    // repo-relative POSIX; resolveRepoRoot walked UP from cwd, so the
    // relative path never contains "..".
    const repoRelCwd = relative(repoRoot, invocationCwd).replaceAll("\\", "/") || ".";
    try {
      await appendCommandsLogEntry({
        repoRoot,
        sessionId,
        at: startedAt,
        cwd: repoRelCwd,
        argv: this.args,
      });
    } catch (err) {
      // A session exists but its commands.log is unusable (corruption).
      // Do NOT spawn: running the child without its audit entry would
      // violate D102.F's contract. Close the session if possible, and
      // report the close outcome honestly — three states, consistent
      // with the post-child end handling in Step 7.
      //
      // Only NoActiveSessionError proves the session was already ended.
      // EndSessionRaceError falls through to "unknown": the active marker
      // vanished out of protocol, and core did not publish terminal state,
      // so claiming a successful close would be false.
      let closeState: "closed" | "already-ended" | "unknown" = "unknown";
      let closeWarnings: readonly string[] = [];
      try {
        const closed = await endSessionOperation({ cwd: invocationCwd });
        closeState = "closed";
        closeWarnings = closed.cleanupWarnings;
      } catch (closeErr) {
        if (closeErr instanceof NoActiveSessionError) {
          closeState = "already-ended";
        }
      }
      stderr.write(
        `Could not record the command in the session's commands.log: ${(err as Error).message}\n`,
      );
      stderr.write("Command not run.\n");
      // Cleanup diagnostics sit with the session guidance, after the user
      // has been told what happened to their command. The contract is the
      // same here as on the success path: an unrelated failure mode must
      // not make these disappear.
      writeCleanupWarnings(stderr, closeWarnings);
      if (closeState === "closed") {
        stderr.write("The session was closed.\n");
      } else if (closeState === "already-ended") {
        stderr.write("The session was already ended.\n");
      } else {
        stderr.write("The session may still be active. Close it manually with:\n");
        stderr.write("  viberevert end\n");
      }
      return 1;
    }

    // Step 6: resolve the requested command to an exact path (no OS
    // re-resolution), classify the RESOLVED target, and act by kind
    // (ADR 0005 resolve-then-launch):
    //   - unresolved -> command-not-found (no spawn).
    //   - native     -> direct-spawn the resolved path (D102.A + D102.H).
    //   - cmd-shim   -> Decision 7 gated reject (no spawn; interactive .cmd
    //                   mediation not yet eligible).
    //   - other      -> unsupported resolved target (no spawn).
    const argv0 = this.args[0] as string;
    const childArgs = this.args.slice(1);
    const resolvedTarget = createHostExecutablePathResolver()(argv0);
    let outcome: RunOutcome;
    if (resolvedTarget === null) {
      outcome = { kind: "unresolved" };
    } else {
      const targetKind = classifyResolvedTarget(process.platform, resolvedTarget);
      if (targetKind === "native") {
        // Sync try/catch for a synchronous spawn throw; 'error' listener for
        // async spawn failure; record-only signal handlers so end-session
        // always runs.
        try {
          const child = spawn(resolvedTarget, childArgs, {
            stdio: "inherit",
            shell: false,
            cwd: invocationCwd,
          });
          outcome = await new Promise<RunOutcome>((resolveOutcome) => {
            const recordOnly = (): void => {
              // D102.H: recording handler. The terminal already delivered
              // the signal to the child (shared process group / console);
              // the wrapper just refuses to die before end-session runs.
            };
            process.on("SIGINT", recordOnly);
            process.on("SIGTERM", recordOnly);
            let settled = false;
            const settle = (result: RunOutcome): void => {
              // One-shot: 'error' and 'exit' can both fire in edge
              // sequences; the first settles, later calls are no-ops.
              if (settled) {
                return;
              }
              settled = true;
              process.removeListener("SIGINT", recordOnly);
              process.removeListener("SIGTERM", recordOnly);
              resolveOutcome(result);
            };
            child.once("error", (err) =>
              settle({ kind: "spawn-error", err: err as NodeJS.ErrnoException }),
            );
            child.once("exit", (code, signal) => settle({ kind: "exited", code, signal }));
          });
        } catch (err) {
          // Synchronous spawn throw.
          outcome = { kind: "spawn-error", err: err as NodeJS.ErrnoException };
        }
      } else if (targetKind === "cmd-shim") {
        outcome = { kind: "cmd-gated", resolvedTarget };
      } else {
        outcome = { kind: "unsupported", resolvedTarget, targetKind };
      }
    }

    // Step 7: end the session (finally-shaped: every outcome path
    // arrives here). D102.B/D102.E end-failure semantics.
    //
    // NoActiveSessionError means the session was already ended before this
    // wrapper could close it. EndSessionRaceError is different after step 4c:
    // disappearance of active-session.json inside the lifecycle lock is an
    // out-of-protocol mutation, so it remains an end failure rather than being
    // reported as an already-ended session.
    let sessionAlreadyEnded = false;
    let endFailureMessage: string | null = null;
    let endFailureHint: string | null = null;
    let endWarnings: readonly string[] = [];
    try {
      const ended = await endSessionOperation({ cwd: invocationCwd });
      endWarnings = ended.cleanupWarnings;
    } catch (err) {
      if (err instanceof NoActiveSessionError) {
        sessionAlreadyEnded = true;
      } else if (err instanceof EndStateChangedDuringCaptureError) {
        // The fence refused. Its message enumerates every changed
        // observation, which is internal vocabulary `end` deliberately
        // withholds; forwarding it here would give ONE failure two
        // different privacy contracts depending on which command hit it.
        // Substitute the user-facing reason and add the actionable hint.
        endFailureMessage = "the project kept changing during capture";
        endFailureHint = "Stop other writers or background processes changing the repo, then";
      } else {
        // Everything else keeps the generic contextual wrapper, which is
        // more informative than any standalone refusal would be here --
        // including lock contention and EndSessionRaceError, where "the
        // command ran but its session could not be closed" plus a retry is
        // exactly the right report.
        endFailureMessage = (err as Error).message;
      }
    }

    // Step 8: map the outcome + report (stderr only).
    let exitCode: number;
    if (outcome.kind === "exited") {
      exitCode = mapChildExitToCode(outcome);
    } else if (outcome.kind === "unresolved") {
      stderr.write(`Command not found: ${argv0}\n`);
      exitCode = 127;
    } else if (outcome.kind === "cmd-gated") {
      stderr.write(`Resolved ${argv0} to a Windows .cmd shim: ${outcome.resolvedTarget}\n`);
      stderr.write(
        "Interactive .cmd execution via `viberevert run` is not yet eligible " +
          "(blocked by ADR 0005 Decision 7, pending the manual Ctrl+C lifecycle gate).\n",
      );
      stderr.write(
        "Run the command through the shell explicitly, for example: " +
          "viberevert run cmd /c <command> ...\n",
      );
      stderr.write("(The guard then sees the explicit `cmd /c ...` form.)\n");
      exitCode = 1;
    } else if (outcome.kind === "unsupported") {
      stderr.write(
        `Resolved ${argv0} to ${outcome.resolvedTarget}, a ${outcome.targetKind} target that ` +
          "`viberevert run` cannot execute directly.\n",
      );
      stderr.write(
        "Run the command through the shell or an interpreter explicitly, for example: " +
          "viberevert run cmd /c <command> ...\n",
      );
      exitCode = 1;
    } else {
      // spawn-error. The old `.cmd`-specific EINVAL branch is removed because
      // resolved `.cmd` targets are gated before spawn() and never reach here;
      // any other EINVAL falls through to the generic message below.
      const code = outcome.err.code;
      if (code === "ENOENT") {
        stderr.write(`Command not found: ${argv0}\n`);
        exitCode = 127;
      } else if (code === "EACCES") {
        stderr.write(`Command found but not executable: ${argv0}\n`);
        exitCode = 126;
      } else {
        stderr.write(`Could not spawn ${argv0}: ${outcome.err.message}\n`);
        exitCode = 1;
      }
    }

    if (endFailureMessage !== null) {
      if (outcome.kind !== "exited") {
        stderr.write(
          `The wrapped command did not run, and the session could not be closed: ${endFailureMessage}\n`,
        );
      } else {
        stderr.write(
          `The wrapped command finished (exit status: ${exitCode}), but the session could not be closed: ${endFailureMessage}\n`,
        );
      }
      if (endFailureHint !== null) {
        stderr.write(`${endFailureHint}\n`);
      }
      stderr.write("Close it manually with:\n");
      stderr.write("  viberevert end\n");
      return 1;
    }
    if (sessionAlreadyEnded) {
      stderr.write("Note: the session was already ended before the wrapper could close it.\n");
    }

    // Session-scoped diagnostics, grouped with the summary below rather
    // than emitted at the end call site (which sits above the command
    // outcome). The user learns what happened to their command first.
    writeCleanupWarnings(stderr, endWarnings);

    stderr.write(`Session: ${sessionId}\n`);
    stderr.write(`Next: viberevert check --since ${sessionId}\n`);
    return exitCode;
  }
}
