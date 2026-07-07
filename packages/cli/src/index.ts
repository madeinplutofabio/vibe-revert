#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

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

const cli = new Cli({
  binaryName: "viberevert",
  binaryLabel: "VibeRevert",
  binaryVersion: pkg.version,
});

cli.register(Builtins.HelpCommand);
cli.register(VersionCommand);
cli.register(DoctorCommand);
cli.register(InitCommand);
cli.register(CheckpointsCommand);
cli.register(EndCommand);
cli.register(SessionsCommand);
cli.register(CheckpointCommand);
cli.register(StartCommand);
cli.register(RunCommand);
cli.register(ShellCommand);
cli.register(CheckCommand);
cli.register(ReportCommand);
cli.register(PromptFixCommand);
cli.register(RollbackCommand);
cli.register(HookInstallCommand);
cli.register(HookUninstallCommand);
cli.register(InstallCommand);
cli.register(UninstallCommand);
cli.register(MCPCommand);

await cli.runExit(process.argv.slice(2));
