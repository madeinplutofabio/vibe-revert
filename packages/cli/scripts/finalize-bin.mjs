#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Post-build finalize step for the viberevert CLI binary.
//
// Runs after `tsc -p tsconfig.build.json` emits dist/index.js. Two jobs:
//
//   1. Verify the shebang survived. The shebang lives in src/index.ts
//      (`#!/usr/bin/env node`) and is preserved by tsc through emit. This
//      script does NOT prepend it — that's the source file's responsibility.
//      We sanity-check here so a regression (someone removes the shebang from
//      src/index.ts) fails the build loudly instead of producing a binary
//      that exits with "exec format error" the first time a user runs it.
//
//   2. Set the POSIX executable bit (chmod 0o755). No-op on Windows; npm's
//      bin-shim handles invocation there regardless of file permissions.

import { chmod, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(SCRIPT_DIR, "..", "dist", "index.js");

async function main() {
  // Verify the bin path exists AND is a regular file. If tsc didn't emit it,
  // or something replaced it with a directory/symlink-to-dir/etc., we want a
  // clear error here rather than a confusing one downstream.
  let binStat;
  try {
    binStat = await stat(BIN_PATH);
  } catch {
    console.error(`finalize-bin: ${BIN_PATH} not found. Run \`tsc -p tsconfig.build.json\` first.`);
    process.exitCode = 1;
    return;
  }

  if (!binStat.isFile()) {
    console.error(`finalize-bin: ${BIN_PATH} exists but is not a regular file.`);
    process.exitCode = 1;
    return;
  }

  // Verify the shebang. Read the file (a few KB at most for a CLI bundle).
  const content = await readFile(BIN_PATH, "utf8");
  if (!content.startsWith("#!/usr/bin/env node")) {
    console.error(
      `finalize-bin: ${BIN_PATH} does not start with the expected shebang. ` +
        `src/index.ts must begin with \`#!/usr/bin/env node\`.`,
    );
    process.exitCode = 1;
    return;
  }

  // Cross-platform chmod: Windows ignores executable bits.
  if (process.platform === "win32") {
    return;
  }

  // 0o755 = rwxr-xr-x. Owner can read/write/execute; others can read/execute.
  await chmod(BIN_PATH, 0o755);
}

await main();
