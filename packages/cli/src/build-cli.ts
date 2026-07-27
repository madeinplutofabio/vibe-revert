// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The registration authority + import-safe CLI construction. REGISTERED_COMMANDS
// is the single canonical registration list (order-significant); buildCli()
// consumes it. Importing this module has NO side effects: buildCli() constructs +
// registers; main() runs. index.ts is the thin, always-on-load bin. The command
// order/exposure invariants police REGISTERED_COMMANDS here (moved from index.ts
// with the registration authority; no behavior change).

import {
  CheckCommand,
  CheckpointCommand,
  CheckpointsCommand,
  DoctorCommand,
  EndCommand,
  HookInstallCommand,
  HookUninstallCommand,
  InitCommand,
  InstallCommand,
  PromptFixCommand,
  ReportCommand,
  RollbackCommand,
  RunCommand,
  SessionsCommand,
  ShellCommand,
  StartCommand,
  UninstallCommand,
  VersionCommand,
} from "@viberevert/cli-commands";
import { Builtins, Cli } from "clipanion";
import pkg from "../package.json" with { type: "json" };

import { MCPCommand } from "./commands/mcp.js";

/**
 * The canonical command registration list, in registration order. buildCli()
 * registers Builtins.HelpCommand first, then each of these in order. This array
 * is the single authority the command order/exposure invariants assert against.
 */
export const REGISTERED_COMMANDS = [
  VersionCommand,
  DoctorCommand,
  InitCommand,
  CheckpointsCommand,
  EndCommand,
  SessionsCommand,
  CheckpointCommand,
  StartCommand,
  RunCommand,
  ShellCommand,
  CheckCommand,
  ReportCommand,
  PromptFixCommand,
  RollbackCommand,
  HookInstallCommand,
  HookUninstallCommand,
  InstallCommand,
  UninstallCommand,
  MCPCommand,
] as const;

/**
 * Construct the VibeRevert CLI with every command registered in the original
 * order. Import-safe: no argv read and no command execution.
 */
export function buildCli(): Cli {
  const cli = new Cli({
    binaryName: "viberevert",
    binaryLabel: "VibeRevert",
    binaryVersion: pkg.version,
  });

  cli.register(Builtins.HelpCommand);
  for (const command of REGISTERED_COMMANDS) {
    cli.register(command);
  }

  return cli;
}

/** Executable entry: parse this process's argv and exit accordingly. */
export async function main(): Promise<void> {
  await buildCli().runExit(process.argv.slice(2));
}
