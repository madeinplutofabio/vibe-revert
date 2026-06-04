// packages/cli/test/golden-receipts.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Verify-mode driver for the M D rollback-receipt golden-fixture
// harness. Iterates every scenario dir under `tests/fixtures-rollback/`
// and calls `runReceiptFixture({ mode: "verify" })`, which compares
// the harness's actual output to each fixture's `expected/{receipt.json,
// receipt.terminal.txt, receipt.markdown.md}` byte-for-byte.
//
// Parallel to `golden-reports.test.ts` (M C). Both files share the
// build-driving machinery (`ensureCliBuilt`, `CLI_BIN_ABS_PATH`,
// `BEFORE_ALL_TIMEOUT_MS`) via the M D Step 8-extracted
// `tests/fixtures/cli-build.ts` module — see its file header for
// the full locked rationale on auto-build coordination, the
// mkdir-based build lock that serializes concurrent vitest
// workers, the Windows `cmd.exe /d /s /c pnpm.cmd ...` workaround,
// and the timeout budget formula.
//
// =============================================================================
// Locks (per Step 8 Substep B; mirrors golden-reports.test.ts's structure)
// =============================================================================
//
// 1. **Build-driving delegated to `tests/fixtures/cli-build.ts`.**
//    M D Step 8 introduces this SECOND golden-fixture test file
//    alongside the existing M C golden-reports.test.ts. Without
//    coordination, parallel vitest workers would both spawn
//    `pnpm --filter viberevert... build` on clean CI and race for
//    the same outputs. The shared cli-build.ts module solves this
//    via an mkdir-based exclusive build lock with retry-on-crashed-
//    owner semantics, a pre-build budget guard, ENOENT-only errno
//    discipline, and the inherited Windows `cmd.exe /d /s /c
//    pnpm.cmd ...` build invocation. This file's beforeAll just
//    calls the imported `ensureCliBuilt()` and trusts the shared
//    module's locks. See `tests/fixtures/cli-build.ts`'s 9-lock
//    header for the detailed concurrency contract.
//
// 2. **Top-level fixture discovery.** Uses ESM top-level await to
//    discover scenarios at module load, then registers one `it()`
//    per fixture via a for-loop. Per-iteration `const` bindings
//    capture `fixtureDir` + `name` correctly into each closure.
//
// 3. **Mandatory fixture coverage via REQUIRED_RECEIPT_FIXTURE_NAMES.**
//    Step 8 explicitly locks five receipt fixture scenarios as
//    mandatory (D78 + Substep B). A separate `it()` block asserts
//    that every required name exists in the discovered set; deletion
//    of any required scenario (e.g., someone removes `force-apply`
//    "to simplify the suite") fails this test loudly instead of
//    silently reducing coverage. Adding NEW fixture scenarios beyond
//    the 5 is allowed — the discovered-vs-required check is
//    superset-tolerant, not exact-equality. The required list and
//    per-fixture loop together give "at least these 5, but more is
//    fine."
//
// 4. **`lstat` for shape checks.** Mirrors the regen-goldens.ts and
//    codebase-wide convention — symlink-strict probes for file/dir
//    type so symlinked-fixture-dir pathologies don't slip through.
//
// 5. **Per-fixture timeout 90s (vs golden-reports.test.ts's 60s).**
//    Receipt-producing scenarios are heavier than report fixtures:
//    each runs the full setup-and-end sequence THREE times (once
//    per format flag: terminal / markdown / json) because
//    `viberevert rollback --apply` mutates state and D70 blocks
//    re-apply. Real measured time on typical hardware:
//    ~15-30s per receipt-producing fixture; ~5-8s per refusal
//    fixture. 90s gives substantial headroom on Windows CI where
//    subprocess invocation is slower than POSIX.

import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  BEFORE_ALL_TIMEOUT_MS,
  CLI_BIN_ABS_PATH,
  ensureCliBuilt,
} from "../../../tests/fixtures/cli-build.js";
import { runReceiptFixture } from "../../../tests/fixtures/harness.js";

// =============================================================================
// Path resolution + per-file constants
// =============================================================================

const THIS_FILE = fileURLToPath(import.meta.url);
// packages/cli/test/golden-receipts.test.ts → up 3 → repo root.
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..", "..");
const FIXTURES_ROLLBACK_DIR = join(REPO_ROOT, "tests", "fixtures-rollback");

/**
 * Mandatory receipt fixture scenarios per M D Step 8 plan (D78 +
 * Substep B). Deletion of any required name fails the
 * "all required ... exist" test loudly; addition of NEW names
 * beyond this list is allowed (superset-tolerant). See lock #3.
 */
const REQUIRED_RECEIPT_FIXTURE_NAMES = [
  "clean-dry-run",
  "clean-apply",
  "dirty-refuse-fresh-session",
  "force-apply",
  "partial-failure-extraction-conflict",
] as const;

/**
 * Per-fixture verify timeout. Each receipt-producing fixture runs
 * the full setup-and-end sequence THREE times (one per format
 * flag: terminal / markdown / json) — per-format-fresh-setup is
 * required because `viberevert rollback --apply` mutates state and
 * D70 blocks re-apply, so the three formats can't share one
 * setup. Each setup chain is init + start + modify + end + rollback
 * = 5 subprocess invocations + several git operations. Real
 * measured time: ~15-30s for receipt-producing fixtures, ~5-8s
 * for refusal fixtures. 90s ceiling gives substantial headroom on
 * Windows CI where subprocesses are slower than POSIX. Compared
 * to golden-reports.test.ts's 60s budget per lock #5.
 */
const FIXTURE_TIMEOUT_MS = 90_000;

// =============================================================================
// Fixture discovery (mirrors scripts/regen-goldens.ts's discovery logic
// for the rollback root)
// =============================================================================

/**
 * Discover scenario dirs under `tests/fixtures-rollback/`. Same filter
 * rules as `scripts/regen-goldens.ts`: only entries that are real dirs
 * AND contain a real `setup.json` file. `lstat` (not `stat`) on both
 * shape checks so symlinked-dir or symlinked-setup-json pathologies
 * don't slip through.
 *
 * Sorted lexicographically for deterministic test ordering across
 * platforms (macOS/Linux/Windows readdir order differs).
 *
 * Returns `[]` if the rollback fixtures dir doesn't exist (Step 8
 * mid-state: this test file may land before the fixture scenarios
 * are authored). The mandatory-coverage check in `describe` then
 * fails with the exact list of missing required scenarios.
 */
async function discoverFixtures(): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(FIXTURES_ROLLBACK_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const scenarioDirs: string[] = [];
  for (const name of entries) {
    const candidate = join(FIXTURES_ROLLBACK_DIR, name);
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

describe("golden-fixture receipts", () => {
  beforeAll(async () => {
    await ensureCliBuilt();
  }, BEFORE_ALL_TIMEOUT_MS);

  // Lock #3 mandatory fixture coverage: every name in
  // REQUIRED_RECEIPT_FIXTURE_NAMES must appear in the discovered set.
  // Superset-tolerant: extra fixtures beyond the 5 are fine, missing
  // any required one fails loudly with the exact list.
  it("all required rollback receipt fixture scenarios exist", () => {
    const discovered = new Set(
      fixtureDirs.map((fixtureDir) =>
        fixtureDir.slice(FIXTURES_ROLLBACK_DIR.length + 1).replace(/\\/g, "/"),
      ),
    );
    const missing = REQUIRED_RECEIPT_FIXTURE_NAMES.filter((name) => !discovered.has(name));
    expect(missing).toEqual([]);
  });

  // Per-fixture verify loop. Runs unconditionally — if fixtureDirs
  // is empty, the loop registers zero tests AND the mandatory-
  // coverage check above fails with all 5 required names listed.
  for (const fixtureDir of fixtureDirs) {
    // Convert absolute path to repo-relative POSIX-style name for
    // the test label. `replace(/\\/g, "/")` handles Windows
    // backslashes so test names look identical across platforms.
    const name = fixtureDir.slice(FIXTURES_ROLLBACK_DIR.length + 1).replace(/\\/g, "/");
    it(
      name,
      async () => {
        await runReceiptFixture({
          fixtureDir,
          cliBinAbsPath: CLI_BIN_ABS_PATH,
          mode: "verify",
        });
      },
      FIXTURE_TIMEOUT_MS,
    );
  }
});
