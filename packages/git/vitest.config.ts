// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
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
    // These tests contend on process spawn and filesystem I/O rather than CPU,
    // so the default worker count oversubscribes badly and inflates every
    // filesystem-heavy case toward the timeout. Capping improved BOTH axes when
    // measured over 27 files: package wall time fell from ~73s to ~63s while the
    // slowest test fell from ~10.8s to ~3.0s.
    //
    // It does not replace the local suite timeout in
    // restore-selective-capture.test.ts, which was necessary under the
    // configuration that produced it.
    maxWorkers: 4,
  },
});
