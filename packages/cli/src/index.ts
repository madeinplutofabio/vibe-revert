#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Builtins, Cli } from "clipanion";
import pkg from "../package.json" with { type: "json" };
import { CheckpointsCommand } from "./commands/checkpoints.js";
import { DoctorCommand } from "./commands/doctor.js";
import { EndCommand } from "./commands/end.js";
import { InitCommand } from "./commands/init.js";
import { SessionsCommand } from "./commands/sessions.js";
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

await cli.runExit(process.argv.slice(2));
