// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.viberevert/**"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/index.ts"],
    },
    testTimeout: 10000,
    passWithNoTests: true,
  },
});
