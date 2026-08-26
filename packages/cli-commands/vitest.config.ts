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
      "@viberevert/installers": fileURLToPath(
        new URL("../installers/src/index.ts", import.meta.url),
      ),
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
    // 20s rather than the 10s used elsewhere in the workspace. This package's
    // integration tests spawn real child processes AND drive full session
    // lifecycles, and M 0.8.0 step 4c added ~0.89s to `end` across the measured
    // trivial Windows lifecycle fixtures (the contribution-capture oracle
    // reconstructs the session's checkpoint before the fence). Under contention
    // that pushed the heaviest of them past 10s. Which tests cross is
    // LOAD-DEPENDENT, so a per-test allowlist would be incomplete by
    // construction: two tests crossed the threshold under full package load,
    // while a third crossed only under the heavier full-workspace load; all
    // passed under focused low-load execution.
    //
    // This is a HANG GUARD, not a performance budget: it separates "completed"
    // from "probably wedged". Latency regressions are owned by the M 0.8.0
    // step 15 benchmarks, not by this number. Raising it does mean a test
    // silently degrading from ~1.4s to ~19s would not be caught here; that is
    // the accepted cost of not encoding an arbitrary allowlist.
    testTimeout: 20000,
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
