// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The project's own verification commands, run after a selective transplant.
//
// Structured argv, never a shell. `"npm test"` is not an executable, and
// tokenizing it would put quoting rules between the user's configuration and
// what actually runs.
//
// RESOLVE THEN LAUNCH (ADR 0005), identical to `run`: resolve the requested
// name to an exact path, classify the RESOLVED target, and spawn only a native
// one. A `.cmd` shim is refused WITHOUT spawning while Decision 7 is open,
// rather than mediated through cmd.exe, so this runner ships the same honest
// contract the rest of the CLI does.
//
// A NONZERO EXIT IS A RESULT, NOT AN ERROR. These are the project's commands;
// their failing is the answer, not a malfunction. Returning it keeps the
// transaction's `execution.failed` arm for genuinely unexpected faults, so a
// receipt can distinguish "your tests failed" from "the runner broke".
//
// The line between the two is whether the command ANSWERED. An unresolved name
// and a non-native target are facts about the user's configuration, so they are
// returned and rendered. A resolved native binary that fails to spawn is
// infrastructure failure, so it is thrown: the transaction records
// `execution.failed` and still acquires the post-command observation.
//
// STDIN IS NOT INHERITED. These are batch checks, unlike the interactive agent
// `run` launches. A command that prompted for input would otherwise consume the
// user's keystrokes mid-rollback, or block forever with no timeout to save it.
// Output IS inherited rather than captured: a rollback is interactive, and
// buffering an unbounded test log to put in a receipt would trade a real risk
// for a marginal record.

import { spawn } from "node:child_process";
import type { VerifyCommand } from "@viberevert/session-format";
import { classifyResolvedTarget, type ResolvedTargetKind } from "./commands/command-launcher.js";
import { createHostExecutablePathResolver } from "./commands/executable-probe.js";

export type VerifyCommandResult =
  | { readonly outcome: "exited"; readonly exitCode: number }
  | { readonly outcome: "signalled"; readonly signal: string }
  /** The name resolved to nothing on PATH. No spawn was attempted. */
  | { readonly outcome: "unresolved" }
  /** Resolved, but not a native executable. No spawn was attempted. */
  | {
      readonly outcome: "unsupported_target";
      readonly resolvedTarget: string;
      readonly kind: ResolvedTargetKind;
    }
  /** An earlier command did not pass, so this one was never attempted. */
  | { readonly outcome: "not_run"; readonly reason: "earlier_command_did_not_pass" };

export interface VerifyCommandRun {
  /** The configured command, verbatim, so a receipt renders what was asked for. */
  readonly command: VerifyCommand;
  readonly result: VerifyCommandResult;
}

export interface VerifyCommandsResult {
  /** One entry per CONFIGURED command, in order, including ones never run. */
  readonly runs: readonly VerifyCommandRun[];
  readonly allPassed: boolean;
}

export interface RunVerificationCommandsOptions {
  /** From the SESSION-START evaluation snapshot, never live config. */
  readonly commands: readonly VerifyCommand[];
  readonly cwd: string;
}

/** Passing means it ran and exited zero. Nothing else counts. */
function passed(result: VerifyCommandResult): boolean {
  return result.outcome === "exited" && result.exitCode === 0;
}

/**
 * Spawn an already-resolved native target.
 *
 * Rejects rather than resolving when the spawn itself fails, whether
 * synchronously or through the `error` event. That is not the command's answer,
 * so it must not be recorded as one.
 */
function spawnNative(
  resolvedTarget: string,
  args: readonly string[],
  cwd: string,
): Promise<VerifyCommandResult> {
  return new Promise<VerifyCommandResult>((resolve, reject) => {
    let settled = false;
    const settle = (result: VerifyCommandResult): void => {
      // One-shot: 'error' and 'exit' can both fire in edge sequences.
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const fail = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };

    // A synchronous throw here rejects this promise through the executor
    // contract, so it needs no separate catch. The EXACT resolved path is
    // spawned, so the OS never re-resolves the name.
    const child = spawn(resolvedTarget, [...args], {
      stdio: ["ignore", "inherit", "inherit"],
      shell: false,
      cwd,
    });

    child.once("error", (err) => fail(err));
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        settle({ outcome: "signalled", signal });
        return;
      }
      // Node delivers a code whenever no signal was involved. The fallback
      // fails closed rather than reporting an unreachable state as success.
      settle({ outcome: "exited", exitCode: code ?? 1 });
    });
  });
}

async function runOne(
  command: VerifyCommand,
  cwd: string,
  resolveExecutablePath: (file: string) => string | null,
): Promise<VerifyCommandResult> {
  const resolvedTarget = resolveExecutablePath(command.command);
  if (resolvedTarget === null) {
    return { outcome: "unresolved" };
  }
  const kind = classifyResolvedTarget(process.platform, resolvedTarget);
  if (kind !== "native") {
    return { outcome: "unsupported_target", resolvedTarget, kind };
  }
  return spawnNative(resolvedTarget, command.args, cwd);
}

/**
 * Run the configured commands in order, stopping at the first that does not
 * pass.
 *
 * FAIL FAST, because a verification suite's later stages routinely assume the
 * earlier ones held. The commands that were skipped are still recorded, so the
 * receipt shows the whole configured list rather than a silently truncated one.
 *
 * ONE RESOLVER for the whole run, built once here. Every command in a single
 * verification pass then resolves against one environment, and the PATH scan is
 * not rebuilt per command.
 */
export async function runVerificationCommands(
  opts: RunVerificationCommandsOptions,
): Promise<VerifyCommandsResult> {
  const resolveExecutablePath = createHostExecutablePathResolver();
  const runs: VerifyCommandRun[] = [];
  let stopped = false;

  for (const command of opts.commands) {
    if (stopped) {
      runs.push({
        command,
        result: { outcome: "not_run", reason: "earlier_command_did_not_pass" },
      });
      continue;
    }
    const result = await runOne(command, opts.cwd, resolveExecutablePath);
    runs.push({ command, result });
    if (!passed(result)) {
      stopped = true;
    }
  }

  return { runs, allPassed: !stopped };
}
