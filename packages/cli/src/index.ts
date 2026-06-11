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
  PromptFixCommand,
  ReportCommand,
  RollbackCommand,
  SessionsCommand,
  StartCommand,
  VersionCommand,
} from "@viberevert/cli-commands";
import { Builtins, Cli } from "clipanion";
import pkg from "../package.json" with { type: "json" };

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
cli.register(CheckCommand);
cli.register(ReportCommand);
cli.register(PromptFixCommand);
cli.register(RollbackCommand);
cli.register(HookInstallCommand);
cli.register(HookUninstallCommand);

await cli.runExit(process.argv.slice(2));
