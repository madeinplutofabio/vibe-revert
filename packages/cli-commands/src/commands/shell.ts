// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert shell [--task "..."]` -- guarded command loop (REPL) with
// per-command guard/confirm inside ONE session for the whole
// interactive session (M G3, D103).
//
// =============================================================================
// Locked contract (D103.A-G; docs/shell-contract.md is the user-facing form)
// =============================================================================
//
// D103.A -- this is a GUARDED COMMAND LOOP, not a transparent shell. It
//   opens ONE VibeRevert session (checkpoint + start), prints its own
//   prompt (`viberevert> ` to stderr), reads one submitted command line,
//   tokenizes it to argv via the v1 parser (NO shell expansion --
//   shell-tokenize.ts), guard-checks it, and -- if accepted -- spawns
//   exactly that argv with stdio "inherit", shell false, cwd = the
//   invocation cwd. It repeats until `exit`/EOF, then ends the session.
//   No native terminal-bridge dependency and no raw process.stdin/
//   stdout: the transparent terminal bridge is deferred to G4 (pinned by
//   D103.M.3/M.6).
//
// D103.B/C -- ONE base node:readline interface for the whole REPL
//   (input: this.context.stdin, output: this.context.stderr) and ONE
//   async iterator (`lines`). The async iterator is the only read
//   primitive we use for shell/control input; command reads AND the
//   confirm sub-read both consume from `lines` via lines.next(). It
//   preserves every buffered shell command line in order on Node 24
//   (rl.question drops lines buffered between calls; probe-verified).
//   EOF is lines.next() -> {done:true}. The async iterator reads ONLY
//   during `await lines.next()`, so a spawned child (which runs BETWEEN
//   reads) is never competing with an active read -- the interface is
//   deliberately NOT paused around the child, because rl.pause()/resume()
//   around a spawn closes the async iterator (the next lines.next() then
//   throws "readline was closed", probe-verified on Node 24). Child stdin
//   is therefore best-effort only; fully transparent stdin hand-off to an
//   interactive child is a G4 concern. On a TTY, a SIGINT at an idle
//   command prompt clears the partial line and reprints the prompt but
//   does NOT settle the pending lines.next(); it is suppressed during a
//   child and during a confirm read (Ctrl+C mid-confirmation is not a v1
//   contract). All wrapper text goes to stderr; children own stdout via
//   stdio "inherit".
//
// D103.D -- the v1 tokenizer (shell-tokenize.ts) does NO expansion:
//   globs/vars/operators are literal. Shell semantics require an
//   explicit `sh -c "..."` / `cmd /c "..."`, which the guard then sees
//   as that literal. shell.ts introduces no injection surface.
//
// D103.E -- the exact single-token `exit` line and EOF/Ctrl+D terminate
//   the REPL. `exit` is handled BEFORE guard/confirm policy -- never
//   tokenized-for-policy, spawned, or logged, and cannot be guarded
//   (`commands.guard: ["exit"]` does not trap the user). `exit 3` is an
//   ordinary attempted command, not the terminator. No `cd` in v1: the
//   REPL runs at the invocation cwd for its whole life.
//
// D103.F -- one session for the whole REPL. A guard refusal or confirm
//   decline SKIPS that one command and CONTINUES the loop (unlike run,
//   which exits). Each ACCEPTED command (non-empty, tokenized, non-empty
//   argv[0], not guarded, confirm-accepted) yields exactly ONE
//   commands.log entry, appended BEFORE the spawn (so an ENOENT/failed
//   spawn IS logged -- the audit records what the user asked VibeRevert
//   to run after policy accepted it). `at` is a FRESH
//   resolveNowForCliTimestamp() per command (deterministic under
//   VIBEREVERT_TEST_FIXED_NOW). `cwd` is the repo-relative POSIX path,
//   constant for the session. If the append (or timestamp resolution)
//   FAILS: stderr error, do NOT spawn, CONTINUE the loop, keep the
//   session OPEN -- a divergence from run's close-on-append-failure (a
//   REPL holds prior entries and the user is mid-session).
//
//   The guard/confirm policy is SNAPSHOTTED at shell start: config is
//   loaded once and `commandsPolicy` is fixed for the session. Edits to
//   .viberevert.yml during the REPL take effect in the NEXT shell
//   session, not mid-session (D103 snapshot semantics).
//
// D103.G -- active-session integrity + SCOPED teardown. Ownership is
//   re-checked BEFORE each accepted command is appended/spawned AND
//   after each child returns (checkActiveSessionOwnership): same id ->
//   continue; missing -> the session was ended externally, STOP;
//   different id -> another session took over, STOP; unreadable -> STOP.
//   Teardown (in the finally) re-reads the lock and ends ONLY our own
//   session: present-and-ours -> endSessionOperation + the two-line
//   summary (exit 0); missing -> do NOT end, no summary (exit 0);
//   different id -> do NOT end someone else's session, no summary
//   (exit 1); unreadable/end-failure -> exit 1 + manual `viberevert end`
//   hint. shell NEVER ends a session it does not own.
//
// Exit codes: 0 on a clean exit (`exit`/EOF) that ended (or found
//   already-gone) our own session; 1 for pre-loop refusals (session
//   already active, repo/config errors, empty --task, concurrent-op), a
//   changed-session lock, and endSession teardown failure. Per-command
//   child exit codes are DISPLAYED (`[exit: N]` / `[signal: SIG]`) and
//   SWALLOWED -- never propagated (shell is a loop, not a one-shot
//   wrapper; a different contract from run, so run's mapChildExitToCode
//   is deliberately not reused here).
//
// D103.M source-shape locks: adds shell.ts to the child_process
//   carve-out (M.1); spawns stdio "inherit" + shell false and references
//   no terminal-bridge implementation (M.3); imports no check/report
//   machinery (M.4); does not import appendFile -- core's
//   appendCommandsLogEntry is the single commands.log writer (M.5); no
//   native terminal-bridge dependency anywhere (M.6).

import { spawn } from "node:child_process";
import { relative } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Writable } from "node:stream";
import {
  appendCommandsLogEntry,
  type Config,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadActiveSessionLock,
  loadConfig,
  NoActiveSessionError,
  RepoRootNotFoundError,
  resolveRepoRoot,
  SessionAlreadyActiveError,
} from "@viberevert/core";
import { Command, Option } from "clipanion";

import { type CommandsPolicyConfig, evaluateCommandPolicy } from "../command-guard.js";
import { truncateIdForDisplay } from "../format.js";
import { ConcurrentOperationError } from "../locks.js";
import { EndSessionRaceError, endSessionOperation } from "../operations/end-session.js";
import { START_LOCK_REL, startSessionOperation } from "../operations/start-session.js";
import { RuntimeEnvInvalidError, resolveNowForCliTimestamp } from "../runtime-env.js";
import { tokenizeShellLine } from "./shell-tokenize.js";

/** Confirmation phrase for commands.require_confirm matches (shared with run; D102.D). */
const CONFIRM_PHRASE = "run anyway";

/** The REPL prompt, written to stderr before each command read (D103.B). */
const PROMPT = "viberevert> ";

/** The exact single-token line that terminates the REPL (D103.E). */
const EXIT_WORD = "exit";

/**
 * The internal engine model (M G4, D104.A). `--pty` is thin sugar for the
 * transparent PTY bridge; the default is the guarded REPL.
 */
type ShellEngine = "repl" | "pty";

/**
 * Refusal copy for the not-yet-enabled `shell --pty` path (D104.M.5). Until
 * interception lands (Step 4), the public `--pty` path REFUSES and never reaches
 * the PTY engine -- no unguarded transparent shell on main; the engine
 * (shell-pty.ts) is exercised by tests via a direct import of runPtyShell only.
 */
const PTY_MODE_NOT_ENABLED_MESSAGE =
  "PTY mode (--pty) is not enabled yet: the transparent PTY bridge is still under development.\n" +
  "Use `viberevert shell` for the guarded command loop.\n";

/** Result of the D103.G active-session ownership re-check. */
type SessionOwnership = "ours" | "missing" | "different" | "unknown";

// Shared stderr copy for errors that can surface from BOTH the
// guard-phase config load and startSessionOperation's internal load
// (the TOCTOU window between the two reads). Duplicated from run.ts for
// v1 (a future refactor extracts one shared copy module); kept
// byte-identical so the two commands' pre-loop error copy cannot drift.

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
 * Clear readline's partially typed input line before re-prompting after
 * an idle Ctrl+C: simulate Ctrl+U so a half-typed command is dropped
 * (display AND internal buffer), not silently prepended to the next
 * line. TTY polish only; non-TTY scripted input never emits readline
 * SIGINT and follows the pure async-iterator path.
 */
function clearReadlineBuffer(rl: Interface): void {
  rl.write("", { ctrl: true, name: "u" });
}

/**
 * Per-command spawn outcome (LOCAL to shell -- shell DISPLAYS child
 * status and continues; it never maps a child code to its own exit
 * code, so run's mapChildExitToCode is deliberately not reused).
 */
type SpawnOutcome =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "spawn-error"; readonly err: NodeJS.ErrnoException };

/** Everything the read loop needs that is fixed for the whole session. */
interface ShellLoopContext {
  readonly repoRoot: string;
  readonly sessionId: string;
  readonly invocationCwd: string;
  readonly repoRelCwd: string;
  readonly commandsPolicy: CommandsPolicyConfig | undefined;
}

export class ShellCommand extends Command {
  static override paths = [["shell"]];

  static override usage = Command.Usage({
    description: "Open a guarded command loop inside a VibeRevert session",
    details: `
      \`viberevert shell\` is a guarded command loop, not a transparent
      shell. It opens ONE VibeRevert session (checkpoint + start), then
      prompts for one command at a time. Every command is guard-checked
      against \`.viberevert.yml\` BEFORE it runs -- exactly like
      \`viberevert run\`, but for a whole interactive session.

      Each line is tokenized with a small v1 parser that does no shell
      expansion: globs, variables, pipes, and redirection are ordinary
      characters, not operators. To use shell features, invoke a shell
      explicitly -- e.g. \`sh -c "echo hi > out"\`; the guard then sees
      that literal command.

      Each accepted command spawns with shell: false at the directory
      where you launched the shell (there is no \`cd\`; the working
      directory is fixed for the session). A guarded command is refused
      and the loop continues; a confirm-required command prompts for
      confirmation. Type \`exit\` (or press Ctrl+D) to end the session.
      The guard policy is read once when the shell starts.

      Note: command arguments are recorded in the session's commands.log;
      do not pass secrets as command-line arguments.

      In short: a guarded command loop, not a transparent shell; no shell
      expansion; use sh -c / cmd /c for shell features.

      Exit codes: 0 on a clean exit that closed this shell's own session;
      1 if the shell cannot start (a session is already active, or config
      errors), if another session takes over mid-loop, or if the session
      cannot be closed at the end. Individual command exit codes are
      shown ([exit: N] / [signal: SIG]) but do not change the shell's own
      exit code.
    `,
    examples: [
      ["Open a guarded shell session", "viberevert shell"],
      ["Label the session", 'viberevert shell --task "refactor auth"'],
    ],
  });

  task = Option.String("--task", {
    description: "Optional human-readable description of what this session will do",
  });

  pty = Option.Boolean("--pty", false, {
    description:
      "Experimental: transparent PTY bridge instead of the guarded REPL (not enabled yet)",
  });

  /** True while a child is spawned -- suppresses the TTY SIGINT re-prompt. */
  private childRunning = false;

  /** True while awaiting a confirm answer -- suppresses the TTY SIGINT
   *  re-prompt (Ctrl+C mid-confirmation is not a v1 contract; never lie
   *  by reprinting the command prompt while a confirm answer is pending). */
  private awaitingConfirm = false;

  override async execute(): Promise<number> {
    const stderr = this.context.stderr;

    // M G4 (D104.A / D104.M.5): --pty selects the transparent PTY engine. Until
    // interception lands (Step 4), the public --pty path REFUSES here -- BEFORE
    // any --task/repo/config/session work -- and never reaches the PTY engine.
    // The engine (shell-pty.ts) stays unwired; tests exercise it via a direct
    // import of runPtyShell only.
    const engine: ShellEngine = this.pty ? "pty" : "repl";
    if (engine === "pty") {
      stderr.write(PTY_MODE_NOT_ENABLED_MESSAGE);
      return 1;
    }

    // Defensive --task validation (mirrors StartCommand / RunCommand).
    if (this.task !== undefined && this.task.trim().length === 0) {
      stderr.write("--task must not be empty or whitespace-only.\n");
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

    // Step 2: load config for the guard evaluation (D19: shell REQUIRES
    // valid config, like start/run). Snapshot the guard/confirm policy
    // at shell start (D103 snapshot semantics): edits to .viberevert.yml
    // during the REPL take effect in the NEXT shell session, not
    // mid-session. The SAME validated Config object is threaded into
    // startSessionOperation below (loadedConfig) so the shell's guard
    // policy and the session derive from ONE on-disk read (M G4 4e-iv-a0).
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

    // Step 3: start the ONE session for the whole REPL (D103.F). No
    // agentCommand -- there is no single child. The repo root is still
    // re-resolved internally; the CONFIG is threaded via loadedConfig so
    // the session shares the shell's ONE on-disk read (M G4 4e-iv-a0). The
    // config-error catch arms below are retained defensively (with
    // loadedConfig supplied, the operation performs no config load, so they
    // do not fire from this path).
    let sessionId: string;
    try {
      const started = await startSessionOperation({
        cwd: invocationCwd,
        lockCommand: "viberevert shell",
        loadedConfig,
        ...(this.task !== undefined ? { task: this.task } : {}),
      });
      sessionId = started.sessionId;
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
        stderr.write(
          err.info !== null
            ? `Another viberevert operation is already running:\n  command:  ${err.info.command}\n  pid:      ${err.info.pid}\n  since:    ${err.info.started_at}\n\nIf you're sure that command isn't running anymore (e.g., crashed),\nremove this stale lock directory manually:\n  ${START_LOCK_REL}\n`
            : `Another viberevert operation is already running (lock metadata unavailable).\n\nIf you're sure no other viberevert command is running,\nremove this stale lock directory manually:\n  ${START_LOCK_REL}\n`,
        );
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

    // Step 4: the repo-relative POSIX cwd, constant for the session.
    // resolveRepoRoot resolves the repo containing cwd, so the relative
    // cwd is expected to stay inside the repo.
    const repoRelCwd = relative(repoRoot, invocationCwd).replaceAll("\\", "/") || ".";

    // Step 5: one readline interface + one async iterator for the whole
    // REPL (D103.B/C). A TTY SIGINT at an idle command prompt clears the
    // partial line and reprints the prompt but does NOT settle the
    // pending read; it is suppressed during a child (the terminal
    // delivers Ctrl+C to the child) and during a confirm read.
    const rl = createInterface({ input: this.context.stdin, output: stderr });
    const lines = rl[Symbol.asyncIterator]();
    const onSigint = (): void => {
      if (this.childRunning || this.awaitingConfirm) {
        return;
      }
      clearReadlineBuffer(rl);
      stderr.write("\n");
      stderr.write(PROMPT);
    };
    rl.on("SIGINT", onSigint);

    let hadUnexpectedError = false;
    try {
      await this.runLoop(lines, stderr, {
        repoRoot,
        sessionId,
        invocationCwd,
        repoRelCwd,
        commandsPolicy,
      });
    } catch (err) {
      // The read loop should not throw; if it does, do not leak the
      // session -- fall through to the scoped teardown below.
      hadUnexpectedError = true;
      stderr.write(`Unexpected error in shell: ${(err as Error).message}\n`);
    } finally {
      rl.off("SIGINT", onSigint);
      rl.close();
    }

    // Step 6: SCOPED teardown (D103.G) -- re-read the lock and end ONLY
    // our own session. Never throws; returns this shell's exit code.
    const teardownCode = await this.scopedTeardown(stderr, repoRoot, sessionId, invocationCwd);
    return hadUnexpectedError ? 1 : teardownCode;
  }

  /**
   * The REPL read loop (D103.B-G). Reads command lines from the single
   * async iterator, guard-checks each, and spawns accepted ones. Returns
   * when the user types `exit`, at EOF, or when the active session is
   * ended or replaced (D103.G ownership check, run before append and
   * after each child).
   */
  private async runLoop(
    lines: NodeJS.AsyncIterator<string>,
    stderr: Writable,
    ctx: ShellLoopContext,
  ): Promise<void> {
    while (true) {
      stderr.write(PROMPT);
      const next = await lines.next();
      if (next.done === true) {
        // EOF / Ctrl+D -- end the REPL (D103.C).
        break;
      }
      const line = next.value;

      // `exit` control-word BEFORE policy (D103.E) -- unguardable.
      if (line.trim() === EXIT_WORD) {
        break;
      }

      // Tokenize (D103.D). empty -> re-prompt; error -> soft message.
      const tokenized = tokenizeShellLine(line);
      if (tokenized.kind === "empty") {
        continue;
      }
      if (tokenized.kind === "error") {
        stderr.write(`${tokenized.message}\n`);
        continue;
      }
      const argv = tokenized.argv;

      // Defensive: a first token that is the empty string (e.g. `""`) is
      // refused before append/spawn -- core's appendCommandsLogEntry
      // rejects an empty command name, and spawn("") is meaningless.
      const command = argv[0];
      if (command === undefined || command === "") {
        stderr.write("Command name must not be empty.\n");
        continue;
      }

      // Guard + confirm (D103.F): refusal/decline SKIPS this command and
      // CONTINUES the loop (unlike run, which exits).
      const decision = evaluateCommandPolicy(argv, ctx.commandsPolicy);
      if (decision.kind === "guard") {
        stderr.write("Refused: this command matches a guarded pattern in .viberevert.yml.\n");
        stderr.write(`  matched rule:  ${decision.entry}\n`);
        stderr.write(`  command:       ${decision.normalized}\n`);
        stderr.write(
          "\nGuarding applies to this command only. Edit `commands.guard` in .viberevert.yml to change the policy.\n",
        );
        continue;
      }
      if (decision.kind === "confirm") {
        const stdinIsTty = (this.context.stdin as NodeJS.ReadStream).isTTY === true;
        if (!stdinIsTty) {
          // Non-TTY: refuse WITHOUT reading a line (D103.C / matrix #5 --
          // no confirm line consumed, next line stays a command).
          stderr.write(
            "Refused: this command matches a confirm-required pattern in .viberevert.yml, and stdin is not a TTY (interactive confirmation is impossible).\n",
          );
          stderr.write(`  matched rule:  ${decision.entry}\n`);
          stderr.write(`  command:       ${decision.normalized}\n`);
          continue;
        }
        stderr.write("This command matches a confirm-required pattern in .viberevert.yml.\n");
        stderr.write(`  matched rule:  ${decision.entry}\n`);
        stderr.write(`  command:       ${decision.normalized}\n\n`);
        stderr.write(`Type "${CONFIRM_PHRASE}" to run this command: `);
        // Confirm sub-read consumes EXACTLY the next line from the SAME
        // iterator (D103.C). EOF here ends the REPL. SIGINT is suppressed
        // while awaitingConfirm so the handler cannot reprint the prompt.
        this.awaitingConfirm = true;
        const answer = await lines.next().finally(() => {
          this.awaitingConfirm = false;
        });
        if (answer.done === true) {
          stderr.write("\nConfirmation did not match. Command not run.\n");
          break;
        }
        if (answer.value.trim() !== CONFIRM_PHRASE) {
          stderr.write("Confirmation did not match. Command not run.\n");
          continue;
        }
      }

      // Ownership re-check BEFORE append/spawn (D103.G): the session may
      // have been ended or replaced while this shell was idle at the
      // prompt. Never append to / spawn under a session we no longer own.
      const ownershipBefore = await this.checkActiveSessionOwnership(stderr, ctx);
      if (ownershipBefore !== "ours") {
        break;
      }

      // Accepted (D103.F): append ONE commands.log entry BEFORE the
      // spawn. `at` is a FRESH timestamp per command. If the append (or
      // timestamp resolution) fails, do NOT spawn, keep the session
      // OPEN, and continue the loop.
      try {
        const at = resolveNowForCliTimestamp();
        await appendCommandsLogEntry({
          repoRoot: ctx.repoRoot,
          sessionId: ctx.sessionId,
          at,
          cwd: ctx.repoRelCwd,
          argv,
        });
      } catch (err) {
        stderr.write(
          `Could not record the command in the session's commands.log: ${(err as Error).message}\n`,
        );
        stderr.write("Command not run.\n");
        continue;
      }

      // Spawn + wait (D103.A + D103.C). The readline async iterator is
      // NOT paused around the child (see the D103.B/C header): reading
      // only happens during lines.next(), and pausing would close the
      // iterator.
      const outcome = await this.spawnAndWait(command, argv.slice(1), ctx.invocationCwd);

      // Per-command display (D103.E): shell DISPLAYS and SWALLOWS child
      // status -- it never propagates a child code to its own exit code.
      if (outcome.kind === "spawn-error") {
        const code = outcome.err.code;
        if (code === "ENOENT") {
          stderr.write(`Command not found: ${command}\n`);
        } else if (code === "EACCES") {
          stderr.write(`Command found but not executable: ${command}\n`);
        } else if (code === "EINVAL" && process.platform === "win32") {
          stderr.write(
            `Could not spawn ${command} directly (Windows refuses .bat/.cmd with shell disabled).\n`,
          );
          stderr.write("Run it through the shell explicitly, e.g.: cmd /c npm test\n");
          stderr.write("(The guard then sees the `cmd /c ...` form.)\n");
        } else {
          stderr.write(`Could not spawn ${command}: ${outcome.err.message}\n`);
        }
      } else if (outcome.signal !== null) {
        stderr.write(`[signal: ${outcome.signal}]\n`);
      } else if (outcome.code !== null && outcome.code !== 0) {
        stderr.write(`[exit: ${outcome.code}]\n`);
      }

      // Ownership re-check AFTER the child (D103.G): a command may have
      // ended or replaced the session. Missing/different/unknown -> STOP;
      // the scoped teardown re-reads and decides the exit code.
      const ownershipAfter = await this.checkActiveSessionOwnership(stderr, ctx);
      if (ownershipAfter !== "ours") {
        break;
      }
      // Same id -- continue the loop.
    }
  }

  /**
   * D103.G active-session ownership re-check, shared by the pre-append
   * and post-child call sites. Writes the appropriate stderr note and
   * returns the status; the caller stops the loop on anything but
   * "ours". The scoped teardown remains the final exit-code authority.
   */
  private async checkActiveSessionOwnership(
    stderr: Writable,
    ctx: ShellLoopContext,
  ): Promise<SessionOwnership> {
    try {
      const lock = await loadActiveSessionLock(ctx.repoRoot);
      if (lock === null) {
        stderr.write("Note: the active session was ended externally; the shell will stop.\n");
        return "missing";
      }
      if (lock.session_id !== ctx.sessionId) {
        stderr.write(
          "Warning: the active session now belongs to a different session; the shell will stop without touching it.\n",
        );
        return "different";
      }
      return "ours";
    } catch (err) {
      stderr.write(`Could not verify the active session: ${(err as Error).message}\n`);
      stderr.write("The shell will stop.\n");
      return "unknown";
    }
  }

  /**
   * Spawn one accepted command and await its exit (D103.A + D103.C). The
   * readline interface is deliberately NOT paused around the child: the
   * async iterator reads only during lines.next() (a child runs BETWEEN
   * reads), and rl.pause()/resume() around a spawn closes the iterator so
   * the next lines.next() throws "readline was closed" (probe-verified on
   * Node 24). Record-only SIGINT/SIGTERM handlers keep the shell alive so
   * the loop can continue after Ctrl+C; childRunning suppresses the TTY
   * SIGINT re-prompt while the child owns the terminal.
   */
  private async spawnAndWait(command: string, args: string[], cwd: string): Promise<SpawnOutcome> {
    this.childRunning = true;
    try {
      const child = spawn(command, args, { stdio: "inherit", shell: false, cwd });
      return await new Promise<SpawnOutcome>((resolveOutcome) => {
        const recordOnly = (): void => {
          // The terminal already delivered Ctrl+C to the child (shared
          // group/console); the shell just refuses to die before it can
          // loop on. Mirrors run's D102.H record-only handlers.
        };
        process.on("SIGINT", recordOnly);
        process.on("SIGTERM", recordOnly);
        let settled = false;
        const settle = (result: SpawnOutcome): void => {
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
      // Synchronous spawn throw (Node Windows .cmd/.bat EINVAL).
      return { kind: "spawn-error", err: err as NodeJS.ErrnoException };
    } finally {
      this.childRunning = false;
    }
  }

  /**
   * Scoped teardown (D103.G): re-read the active lock and end ONLY this
   * shell's own session. Never throws; returns this shell's exit code.
   *  - present AND ours -> end + two-line summary (exit 0)
   *  - missing          -> already ended/lost; no end, no summary (0)
   *  - different id      -> another session; never end it, no summary (1)
   *  - read/end failure  -> manual `viberevert end` hint (exit 1)
   */
  private async scopedTeardown(
    stderr: Writable,
    repoRoot: string,
    sessionId: string,
    invocationCwd: string,
  ): Promise<number> {
    let lock: Awaited<ReturnType<typeof loadActiveSessionLock>>;
    try {
      lock = await loadActiveSessionLock(repoRoot);
    } catch (err) {
      stderr.write(
        `Could not read the active session state while shutting down: ${(err as Error).message}\n`,
      );
      stderr.write("If a session is still active, close it manually with:\n");
      stderr.write("  viberevert end\n");
      return 1;
    }

    if (lock === null) {
      stderr.write("Note: the session was already ended; nothing to close.\n");
      return 0;
    }
    if (lock.session_id !== sessionId) {
      stderr.write(
        "Warning: the active session belongs to a different session; leaving it untouched.\n",
      );
      return 1;
    }

    // Present AND ours: end it, then print the two-line summary (the
    // D102.G shape). NoActiveSessionError / EndSessionRaceError mean it
    // was ended between the re-read and the end -- the id is still known,
    // so the summary still prints.
    try {
      await endSessionOperation({ cwd: invocationCwd });
    } catch (err) {
      if (err instanceof NoActiveSessionError || err instanceof EndSessionRaceError) {
        stderr.write("Note: the session was already ended before the shell could close it.\n");
        stderr.write(`Session: ${sessionId}\n`);
        stderr.write(`Next: viberevert check --since ${sessionId}\n`);
        return 0;
      }
      stderr.write(`The session could not be closed: ${(err as Error).message}\n`);
      stderr.write("Close it manually with:\n");
      stderr.write("  viberevert end\n");
      return 1;
    }

    stderr.write(`Session: ${sessionId}\n`);
    stderr.write(`Next: viberevert check --since ${sessionId}\n`);
    return 0;
  }
}
