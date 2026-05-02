// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Command } from "clipanion";
import pkg from "../../package.json" with { type: "json" };

/**
 * Prints the CLI version. Available as both a subcommand (`viberevert version`)
 * and a global flag (`viberevert --version`, `viberevert -v`).
 *
 * The version is imported from this package's package.json at module load time.
 */
export class VersionCommand extends Command {
  static override paths = [["version"], ["--version"], ["-v"]];

  static override usage = Command.Usage({
    description: "Print the viberevert CLI version",
  });

  override async execute(): Promise<number> {
    this.context.stdout.write(`${pkg.version}\n`);
    return 0;
  }
}
