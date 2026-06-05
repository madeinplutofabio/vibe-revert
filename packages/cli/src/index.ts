#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Builtins, Cli } from "clipanion";
import pkg from "../package.json" with { type: "json" };
import { CheckCommand } from "./commands/check.js";
import { CheckpointCommand } from "./commands/checkpoint.js";
import { CheckpointsCommand } from "./commands/checkpoints.js";
import { DoctorCommand } from "./commands/doctor.js";
import { EndCommand } from "./commands/end.js";
import { InitCommand } from "./commands/init.js";
import { PromptFixCommand } from "./commands/prompt-fix.js";
import { ReportCommand } from "./commands/report.js";
import { RollbackCommand } from "./commands/rollback.js";
import { SessionsCommand } from "./commands/sessions.js";
import { StartCommand } from "./commands/start.js";
import { VersionCommand } from "./commands/version.js";

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

await cli.runExit(process.argv.slice(2));
