// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@viberevert/adapters": fileURLToPath(new URL("../adapters/src/index.ts", import.meta.url)),
      "@viberevert/checks": fileURLToPath(new URL("../checks/src/index.ts", import.meta.url)),
      "@viberevert/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@viberevert/git": fileURLToPath(new URL("../git/src/index.ts", import.meta.url)),
      "@viberevert/reporters": fileURLToPath(new URL("../reporters/src/index.ts", import.meta.url)),
      "@viberevert/session-format": fileURLToPath(
        new URL("../session-format/src/index.ts", import.meta.url),
      ),
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
        // clipanion 3.x has directory imports inside its own ESM files
        // (e.g. `import "../platform"`) that Node's strict ESM resolver
        // rejects but works fine at the actual CLI runtime. Inlining tells
        // Vitest to pre-bundle clipanion through esbuild before running
        // tests, which handles the directory imports cleanly.
        inline: ["clipanion"],
      },
    },
  },
});
