// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { defineProject } from "vitest/config";

export default defineProject({
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
