// packages/cli/test/golden-reports.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Verify-mode driver for the M C golden-fixture harness. Iterates
// every scenario dir under `tests/fixtures/` and calls
// `runFixture({ mode: "verify" })`, which compares the harness's
// actual output to each fixture's `expected/{report.json,
// report.terminal.txt, report.markdown.md}` byte-for-byte.
//
// Parallel to `golden-receipts.test.ts` (M D). Both files share the
// build-driving machinery (`ensureCliBuilt`, `CLI_BIN_ABS_PATH`,
// `BEFORE_ALL_TIMEOUT_MS`) via the M D Step 8-extracted
// `tests/fixtures/cli-build.ts` module — see its file header for
// the full locked rationale on auto-build coordination, the
// mkdir-based build lock that serializes concurrent vitest
// workers, the Windows `cmd.exe /d /s /c pnpm.cmd ...` workaround,
// and the timeout budget formula.
//
// =============================================================================
// Locks (per Step 10.1 design; extended by M D Step 8 to share
//        build-driving with golden-receipts.test.ts)
// =============================================================================
//
// 1. **Build-driving delegated to `tests/fixtures/cli-build.ts`.**
//    M D Step 8 introduces a SECOND golden-fixture test file
//    (golden-receipts.test.ts). Without coordination, parallel
//    vitest workers would both spawn `pnpm --filter viberevert...
//    build` on clean CI and race for the same outputs. The shared
//    cli-build.ts module solves this via an mkdir-based exclusive
//    build lock with retry-on-crashed-owner semantics, a pre-build
//    budget guard, ENOENT-only errno discipline, and the inherited
//    Windows `cmd.exe /d /s /c pnpm.cmd ...` build invocation.
//    This file's beforeAll just calls the imported
//    `ensureCliBuilt()` and trusts the shared module's locks. See
//    `tests/fixtures/cli-build.ts`'s 9-lock header for the detailed
//    concurrency contract.
//
//    Pre-M D this file had its own local `ensureCliBuilt` + ~7
//    locks covering the build-driving machinery. M D Step 8
//    extracted that into the shared module so both consumers use
//    the same single source of truth. The historical Step 11
//    Windows `pnpm.cmd` bug is now documented in
//    cli-build.ts's lock #6.
//
// 2. **Top-level fixture discovery.** Uses ESM top-level await to
//    discover scenarios at module load, then registers one `it()`
//    per fixture via a for-loop. Per-iteration `const` bindings
//    capture `fixtureDir` + `name` correctly into each closure.
//
// 3. **Empty-discovery fallback.** If zero scenarios are found,
//    register a single failing `it()` so vitest reports a clear
//    error rather than the silent "no tests" warning that would
//    otherwise surface.
//
// 4. **`lstat` for shape checks.** Mirrors the regen-goldens.ts and
//    codebase-wide convention — symlink-strict probes for file/dir
//    type so symlinked-fixture-dir pathologies don't slip through.

import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  BEFORE_ALL_TIMEOUT_MS,
  CLI_BIN_ABS_PATH,
  ensureCliBuilt,
} from "../../../tests/fixtures/cli-build.js";
import { runFixture } from "../../../tests/fixtures/harness.js";

// =============================================================================
// Path resolution + per-file constants
// =============================================================================

const THIS_FILE = fileURLToPath(import.meta.url);
// packages/cli/test/golden-reports.test.ts → up 3 → repo root.
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");

/**
 * Per-fixture verify timeout. Each report fixture runs 5 subprocess
 * invocations (init + checkpoint + check + report + report --markdown)
 * + several git operations. Real measured time is ~5-10s; 60s
 * ceiling is generous headroom. Parallel to
 * golden-receipts.test.ts's 90s timeout — receipt fixtures are
 * heavier (3x setups per scenario), reports are lighter.
 */
const FIXTURE_TIMEOUT_MS = 60_000;

// =============================================================================
// Fixture discovery (mirrors scripts/regen-goldens.ts's logic)
// =============================================================================

/**
 * Discover scenario dirs under `tests/fixtures/`. Same filter rules
 * as `scripts/regen-goldens.ts`: only entries that are real dirs AND
 * contain a real `setup.json` file. `lstat` (not `stat`) on both
 * shape checks so symlinked-dir or symlinked-setup-json pathologies
 * don't slip through.
 *
 * Sorted lexicographically for deterministic test ordering across
 * platforms (macOS/Linux/Windows readdir order differs).
 */
async function discoverFixtures(): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(FIXTURES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const scenarioDirs: string[] = [];
  for (const name of entries) {
    const candidate = join(FIXTURES_DIR, name);
    try {
      const st = await lstat(candidate);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      const setupStat = await lstat(join(candidate, "setup.json"));
      if (!setupStat.isFile()) continue;
    } catch {
      continue;
    }
    scenarioDirs.push(candidate);
  }
  scenarioDirs.sort();
  return scenarioDirs;
}

// =============================================================================
// Test registration
// =============================================================================
//
// Top-level await: discover fixtures at module load so the for-loop
// below can register one `it()` per fixture. Vitest supports ESM
// top-level await; per-iteration `const` bindings make each closure
// capture its own `fixtureDir` + `name` correctly.

const fixtureDirs = await discoverFixtures();

describe("golden-fixture reports", () => {
  beforeAll(async () => {
    await ensureCliBuilt();
  }, BEFORE_ALL_TIMEOUT_MS);

  if (fixtureDirs.length === 0) {
    // Empty-discovery fallback. Register a single failing it() so
    // vitest reports an actionable error rather than the silent
    // "no tests" warning.
    it("at least one fixture scenario should exist", () => {
      expect.fail(
        `No fixture scenarios found under ${FIXTURES_DIR}.\n` +
          `Each scenario should be a subdirectory containing setup.json + diff.patch.`,
      );
    });
  } else {
    for (const fixtureDir of fixtureDirs) {
      // Convert absolute path to repo-relative POSIX-style name for
      // the test label. `replace(/\\/g, "/")` handles Windows
      // backslashes so test names look identical across platforms.
      const name = fixtureDir.slice(FIXTURES_DIR.length + 1).replace(/\\/g, "/");
      it(
        name,
        async () => {
          await runFixture({
            fixtureDir,
            cliBinAbsPath: CLI_BIN_ABS_PATH,
            mode: "verify",
          });
        },
        FIXTURE_TIMEOUT_MS,
      );
    }
  }
});
