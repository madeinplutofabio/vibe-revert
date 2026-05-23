#!/usr/bin/env tsx
// scripts/regen-goldens.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Write-mode driver for the golden-fixture harness. Iterates every
// scenario dir under `tests/fixtures/` and calls
// `runFixture({ mode: "regen" })`, which writes (or overwrites) each
// fixture's `expected/{report.json,report.terminal.txt,report.markdown.md}`.
//
// Invoked via `pnpm regen-goldens`. NOT auto-run by any test — this
// is a developer-explicit command. The intent: "I changed something
// that affects fixture output, and I want to re-baseline the
// goldens after manually reviewing the diff."
//
// =============================================================================
// Locks (per Step 10.1 design)
// =============================================================================
//
// 1. **Fail-fast on missing CLI build.** If
//    `packages/cli/dist/index.js` is absent OR is not a regular file
//    (dir, symlink, FIFO, etc.), exit 1 with a clear "run
//    `pnpm --filter viberevert build` first" message. Do NOT
//    auto-build. Reason: regen is the wrong place to silently
//    paper over stale state — the locked output of regen IS the
//    new baseline, and producing one from an unknown CLI version
//    is exactly the silent-corruption mode we're guarding against.
//    (The test-mode consumer `golden-reports.test.ts` deliberately
//    takes the opposite stance — it auto-builds in beforeAll
//    because the existing 4-gate order runs `test` before `build`.)
//
// 2. **Continue-on-error.** A failing fixture doesn't stop the run —
//    we collect all failures and report them at the end. Lets the
//    developer see EVERY regression in one shot instead of fix-one
//    rerun fix-one rerun.
//
// 3. **Stderr for progress.** All human-readable progress goes to
//    stderr; stdout is left clean. Lets a future caller pipe stdout
//    into machine-readable output without interleaving.
//
// 4. **Lexicographic fixture order.** `readdir` returns filesystem-
//    order entries, which differs across macOS / Linux / Windows.
//    Sorting alphabetically gives stable, predictable progress
//    output regardless of platform.
//
// 5. **`process.exitCode` over `process.exit()`.** `process.exit()`
//    flushes synchronously and can truncate buffered async stderr
//    writes (the multi-line per-failure block at the end of a
//    failed run is the worst-case scenario). Setting `exitCode`
//    lets Node drain naturally before exit.
//
// 6. **`lstat` for shape checks.** `stat()` follows symlinks, so a
//    symlinked regular file would pass `isFile()` — masking the
//    "wrong shape" cases the fail-fast checks exist to catch.
//    `lstat()` is symlink-strict and matches the codebase-wide
//    convention used by every other dir/file probe (checkpoint
//    loaders, paths helpers, report-paths resolver).

import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runFixture } from "../tests/fixtures/harness.js";

// =============================================================================
// Path resolution
// =============================================================================

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");
const CLI_BIN_ABS_PATH = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

// =============================================================================
// Locked error message — kept exact-string so a future test could
// assert against it without having to re-derive the wording.
// =============================================================================

const MISSING_CLI_MESSAGE =
  "Built CLI not found at packages/cli/dist/index.js.\n" +
  "Run `pnpm --filter viberevert build` before `pnpm regen-goldens`.\n";

// =============================================================================
// main
// =============================================================================

async function main(): Promise<number> {
  // 1. Fail-fast if the built CLI is missing OR is not a regular file.
  //    `access()` would silently accept a directory/symlink/FIFO with
  //    that name; `stat().isFile()` would silently accept a symlink
  //    pointing at a regular file. `lstat().isFile()` is the
  //    symlink-strict explicit check that catches all the wrong-shape
  //    cases at the earliest possible moment.
  try {
    const cliStat = await lstat(CLI_BIN_ABS_PATH);
    if (!cliStat.isFile()) {
      process.stderr.write(MISSING_CLI_MESSAGE);
      return 1;
    }
  } catch {
    process.stderr.write(MISSING_CLI_MESSAGE);
    return 1;
  }

  // 2. Discover scenario dirs. Filter to entries that are dirs AND
  //    contain a `setup.json` — so `harness.ts`, `README.md`, etc.
  //    at the top level of `tests/fixtures/` are skipped (they're
  //    not scenarios). `lstat` (not `stat`) on both shape checks so
  //    symlinked dirs and symlinked setup.json files don't slip
  //    through and confuse the harness downstream.
  let entries: readonly string[];
  try {
    entries = await readdir(FIXTURES_DIR);
  } catch (err) {
    process.stderr.write(
      `Failed to read fixtures dir ${FIXTURES_DIR}: ${(err as Error).message}\n`,
    );
    return 1;
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

  if (scenarioDirs.length === 0) {
    process.stderr.write(
      `No fixture scenarios found under ${FIXTURES_DIR}.\n` +
        `Each scenario should be a subdirectory containing setup.json + diff.patch.\n`,
    );
    return 1;
  }

  // 3. Regen each fixture; continue on failure, collect for final
  //    summary.
  process.stderr.write(`Regenerating ${scenarioDirs.length} fixture(s)...\n`);
  const failures: { name: string; error: string }[] = [];
  for (const fixtureDir of scenarioDirs) {
    const name = fixtureDir.slice(FIXTURES_DIR.length + 1).replace(/\\/g, "/");
    try {
      await runFixture({
        fixtureDir,
        cliBinAbsPath: CLI_BIN_ABS_PATH,
        mode: "regen",
      });
      process.stderr.write(`  ✓ ${name}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ name, error: message });
      process.stderr.write(`  ✗ ${name}: ${message.split("\n", 1)[0]}\n`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} of ${scenarioDirs.length} fixture(s) failed:\n`);
    for (const f of failures) {
      process.stderr.write(`\n--- ${f.name} ---\n${f.error}\n`);
    }
    return 1;
  }

  process.stderr.write(`\nAll ${scenarioDirs.length} fixture(s) regenerated.\n`);
  process.stderr.write(`Review the diff (\`git diff tests/fixtures\`) before committing.\n`);
  return 0;
}

process.exitCode = await main();
