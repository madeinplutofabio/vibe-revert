#!/usr/bin/env tsx
// scripts/regen-goldens.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Write-mode driver for the golden-fixture harness. Iterates every
// scenario dir under BOTH `tests/fixtures/` (M C report goldens) AND
// `tests/fixtures-rollback/` (M D receipt goldens), dispatches to the
// matching harness entrypoint based on the fixture kind, and writes
// (or overwrites) each fixture's expected/* artifacts:
//   - report fixtures → expected/{report.json, report.terminal.txt,
//     report.markdown.md}
//   - receipt fixtures → expected/{receipt.json, receipt.terminal.txt,
//     receipt.markdown.md}
//
// Invoked via `pnpm regen-goldens`. NOT auto-run by any test — this
// is a developer-explicit command. The intent: "I changed something
// that affects fixture output, and I want to re-baseline the
// goldens after manually reviewing the diff."
//
// =============================================================================
// Locks (per Step 10.1 design; extended by M D Step 8 for receipt fixtures)
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
//    (The test-mode consumers `golden-reports.test.ts` and
//    `golden-receipts.test.ts` deliberately take the opposite
//    stance — they auto-build in beforeAll because the existing
//    4-gate order runs `test` before `build`.)
//
// 2. **Continue-on-error.** A failing fixture doesn't stop the run —
//    we collect all failures and report them at the end. Lets the
//    developer see EVERY regression in one shot instead of fix-one
//    rerun fix-one rerun.
//
// 3. **Stderr for progress, prefixed by fixture kind.** All human-
//    readable progress goes to stderr; stdout is left clean. Lets a
//    future caller pipe stdout into machine-readable output without
//    interleaving. Each progress line carries an explicit
//    `report:` or `receipt:` prefix so the reader can distinguish
//    the two kinds at a glance — a failing report fixture and a
//    failing receipt fixture have different remediation paths
//    (regen the report harness vs the receipt harness).
//
// 4. **Lexicographic fixture order within each kind; reports listed
//    before receipts in the combined output.** `readdir` returns
//    filesystem-order entries, which differs across macOS / Linux /
//    Windows. Sorting alphabetically within each kind gives stable,
//    predictable progress output. Reports come before receipts so
//    the historical M C ordering is preserved at the head of the
//    output and the M D additions append cleanly at the tail.
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
//
// 7. **Tagged entry type with exhaustive switch dispatch (M D
//    Step 8).** Each discovered fixture is materialized as a
//    `GoldenFixtureEntry` with an explicit `kind: "report" |
//    "receipt"` tag — NOT inferred from the path at dispatch time.
//    The dispatch site uses an exhaustive switch with a
//    `default` branch that assigns to `const exhaustive: never =
//    entry` then throws — so adding a third fixture kind in the
//    future (e.g., a prompt-fix fixture in M E) fails the compile
//    until every dispatch site is updated, AND if something
//    impossible reaches runtime the throw produces a diagnosable
//    error instead of silently falling through. This is the same
//    future-proofing pattern used by the orchestration layer's
//    refusal enums.
//
// 8. **Graceful missing rollback-fixture-dir handling.** Step 8
//    creates `tests/fixtures-rollback/` partway through its
//    implementation — between the harness extension landing and
//    the fixture scenarios being authored. During that window,
//    running `pnpm regen-goldens` against a checkout without the
//    rollback dir should succeed against the M C fixtures alone,
//    not fail with ENOENT. The discovery helper returns `[]` for
//    a missing root (only fails-fast if BOTH roots are missing).

import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runFixture, runReceiptFixture } from "../tests/fixtures/harness.js";

// =============================================================================
// Path resolution
// =============================================================================

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");
const FIXTURES_ROLLBACK_DIR = join(REPO_ROOT, "tests", "fixtures-rollback");
const CLI_BIN_ABS_PATH = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

// =============================================================================
// Locked error messages — kept exact-string so a future test could
// assert against them without having to re-derive the wording.
// =============================================================================

const MISSING_CLI_MESSAGE =
  "Built CLI not found at packages/cli/dist/index.js.\n" +
  "Run `pnpm --filter viberevert build` before `pnpm regen-goldens`.\n";

// =============================================================================
// Tagged entry type (lock #7)
// =============================================================================

/**
 * Fixture kind discriminant. Drives the dispatch in `main` and the
 * progress-line prefix. Adding a new kind requires updating every
 * `switch (entry.kind)` site — the exhaustive default branch
 * enforces this at compile time (via `const exhaustive: never =
 * entry`) AND surfaces a clear runtime error if something
 * impossible happens.
 */
type FixtureKind = "report" | "receipt";

/**
 * In-memory representation of one discovered fixture. The `kind`
 * tag is set at discovery time (from the source root) — NOT inferred
 * from the dir path at dispatch time. Keeps the dispatch site
 * type-safe and lets a future kind addition fail-compile loudly.
 */
interface GoldenFixtureEntry {
  readonly kind: FixtureKind;
  readonly name: string;
  readonly dir: string;
}

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

  // 2. Discover scenario dirs from BOTH roots. Each root tolerates
  //    its own absence (per lock #8) — only fails if BOTH are
  //    missing, which would indicate a corrupted checkout.
  const reportEntries = await discoverFixturesInRoot(FIXTURES_DIR, "report");
  const receiptEntries = await discoverFixturesInRoot(FIXTURES_ROLLBACK_DIR, "receipt");
  const allEntries: readonly GoldenFixtureEntry[] = [...reportEntries, ...receiptEntries];

  if (allEntries.length === 0) {
    process.stderr.write(
      `No fixture scenarios found under ${FIXTURES_DIR} or ${FIXTURES_ROLLBACK_DIR}.\n` +
        `Each scenario should be a subdirectory containing setup.json.\n`,
    );
    return 1;
  }

  // 3. Regen each fixture; continue on failure, collect for final
  //    summary. Dispatch via exhaustive switch on entry.kind (lock #7).
  process.stderr.write(
    `Regenerating ${allEntries.length} fixture(s) (${reportEntries.length} report, ${receiptEntries.length} receipt)...\n`,
  );
  const failures: { name: string; kind: FixtureKind; error: string }[] = [];
  for (const entry of allEntries) {
    try {
      switch (entry.kind) {
        case "report":
          await runFixture({
            fixtureDir: entry.dir,
            cliBinAbsPath: CLI_BIN_ABS_PATH,
            mode: "regen",
          });
          break;
        case "receipt":
          await runReceiptFixture({
            fixtureDir: entry.dir,
            cliBinAbsPath: CLI_BIN_ABS_PATH,
            mode: "regen",
          });
          break;
        default: {
          // Exhaustiveness check — compile error if a new
          // FixtureKind variant is added without a case here.
          // Runtime throw produces a diagnosable error if something
          // impossible reaches here at runtime.
          const exhaustive: never = entry;
          throw new Error(`Unhandled fixture kind: ${JSON.stringify(exhaustive)}`);
        }
      }
      process.stderr.write(`  ✓ ${entry.kind}:${entry.name}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ name: entry.name, kind: entry.kind, error: message });
      process.stderr.write(`  ✗ ${entry.kind}:${entry.name}: ${message.split("\n", 1)[0]}\n`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} of ${allEntries.length} fixture(s) failed:\n`);
    for (const f of failures) {
      process.stderr.write(`\n--- ${f.kind}:${f.name} ---\n${f.error}\n`);
    }
    return 1;
  }

  process.stderr.write(`\nAll ${allEntries.length} fixture(s) regenerated.\n`);
  process.stderr.write(
    `Review the diff (\`git diff tests/fixtures tests/fixtures-rollback\`) before committing.\n`,
  );
  return 0;
}

// =============================================================================
// Discovery helper (per-root; tagged-entry materialization)
// =============================================================================

/**
 * Discover fixture scenarios under one root dir. Filters to entries
 * that are dirs AND contain a `setup.json` — so `harness.ts`,
 * `README.md`, etc. at the top level of the root are skipped (they're
 * not scenarios). `lstat` (not `stat`) on both shape checks so
 * symlinked dirs and symlinked setup.json files don't slip through
 * and confuse the harness downstream.
 *
 * Returns `[]` if the root dir doesn't exist (per lock #8 — graceful
 * handling during Step 8's in-progress state). Other I/O errors
 * propagate; the caller surfaces them.
 *
 * Results are sorted lexicographically by name within the root.
 */
async function discoverFixturesInRoot(
  root: string,
  kind: FixtureKind,
): Promise<readonly GoldenFixtureEntry[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Root dir absent — graceful per lock #8.
      return [];
    }
    process.stderr.write(`Failed to read fixtures dir ${root}: ${(err as Error).message}\n`);
    throw err;
  }

  const found: GoldenFixtureEntry[] = [];
  for (const name of entries) {
    const candidate = join(root, name);
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
    found.push({ kind, name, dir: candidate });
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found;
}

process.exitCode = await main();
