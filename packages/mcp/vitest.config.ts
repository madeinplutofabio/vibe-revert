// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@viberevert/cli-commands": fileURLToPath(
        new URL("../cli-commands/src/index.ts", import.meta.url),
      ),
      "@viberevert/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    testTimeout: 10000,
    passWithNoTests: true,
    server: {
      deps: {
        // mcp does NOT import clipanion directly (D99.M.18 wall), BUT
        // mcp's source imports @viberevert/cli-commands (error classes).
        // The cli-commands barrel re-exports the 14 Command classes,
        // each of which imports clipanion at module-evaluation time.
        // clipanion 3.x has directory imports (e.g. `import "../platform"`)
        // that Node's strict ESM resolver rejects but work fine in the
        // CLI runtime path. Inlining tells Vitest to pre-bundle clipanion
        // through esbuild before running tests, which handles the
        // directory imports cleanly. This is a test-runner bundling
        // exception ONLY -- the wall against clipanion in src/** and
        // package.json deps still holds.
        inline: ["clipanion"],
      },
    },
  },
});
