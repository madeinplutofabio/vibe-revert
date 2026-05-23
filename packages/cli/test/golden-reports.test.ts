// packages/cli/test/golden-reports.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Verify-mode driver for the golden-fixture harness. Iterates every
// scenario dir under `tests/fixtures/` and calls
// `runFixture({ mode: "verify" })`, which compares the harness's
// actual output to each fixture's `expected/{report.json,
// report.terminal.txt, report.markdown.md}` byte-for-byte.
//
// =============================================================================
// Locks (per Step 10.1 design)
// =============================================================================
//
// 1. **Auto-build-if-missing in beforeAll.** This is the asymmetric
//    counterpart to `scripts/regen-goldens.ts`'s fail-fast on missing
//    dist. The full 4-gate order is `typecheck && lint && test && build`
//    — `test` runs BEFORE `build`, so on a clean CI checkout the CLI's
//    `dist/index.js` does NOT exist when this test file loads. A
//    fail-fast there would make valid CI red even though the repo is
//    fine; an auto-build in `beforeAll` honors the gate order without
//    reshuffling it. The build is idempotent and safe to invoke when
//    already built. This file owns the missing-dist precondition
//    without reshuffling the gate order.
//
//    Timeout budgeting: the `beforeAll` hook timeout is set LARGER
//    than the inner subprocess timeout (BUILD_TIMEOUT_MS + 30s)
//    deliberately. Without the buffer, a build that approaches its
//    own 120s ceiling can race with vitest's hook timer — vitest
//    might fire first, reporting "hook timed out" and discarding
//    the wrapped stdout/stderr enrichment from `ensureCliBuilt`'s
//    catch block. The 30s buffer guarantees the inner timeout
//    always fires first, so the catch block always gets to surface
//    the build output.
//
// 2. **Build-if-missing, not build-if-stale.** We check for dist
//    existence but do NOT compare source mtimes. Developers running
//    `pnpm test` repeatedly after source edits would test against the
//    stale binary; the documented workflow is `pnpm build && pnpm
//    test` (or the full gate cycle). For CI this is moot — clean
//    checkout always triggers the build branch.
//
// 3. **Dependency-closed build filter.** The build invocation uses
//    `--filter viberevert...` (trailing `...`) which builds the CLI
//    AND all its workspace dependencies in topological order, not
//    just the CLI package alone. On clean CI, `packages/git/dist/`,
//    `packages/core/dist/`, etc. are also missing — a CLI-only
//    `--filter viberevert` (without the `...`) would fail to resolve
//    workspace deps at link time OR produce a binary that crashes
//    at runtime trying to import missing dist.
//
// 4. **Top-level fixture discovery.** Uses ESM top-level await to
//    discover scenarios at module load, then registers one `it()`
//    per fixture via a for-loop. Per-iteration `const` bindings
//    capture `fixtureDir` + `name` correctly into each closure.
//
// 5. **Empty-discovery fallback.** If zero scenarios are found,
//    register a single failing `it()` so vitest reports a clear
//    error rather than the silent "no tests" warning that would
//    otherwise surface.
//
// 6. **`lstat` for shape checks.** Mirrors the regen-goldens.ts and
//    codebase-wide convention — symlink-strict probes for file/dir
//    type so symlinked-CLI-binary or symlinked-fixture-dir
//    pathologies don't slip through.
//
// 7. **Platform-conditional `pnpm` binary name.** On Windows, pnpm
//    installs as `pnpm.cmd` (batch wrapper); `execFile("pnpm", ...)`
//    without `shell: true` ENOENTs because Node's child_process
//    does NOT auto-resolve `.cmd` extensions. `pnpm.cmd` explicitly
//    avoids the issue without inviting `shell: true`'s escaping
//    hazards.

import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import { runFixture } from "../../../tests/fixtures/harness.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Path resolution + locked timing/binary constants
// =============================================================================

const THIS_FILE = fileURLToPath(import.meta.url);
// packages/cli/test/golden-reports.test.ts → up 3 → repo root.
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");
const CLI_BIN_ABS_PATH = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

/**
 * Platform-conditional pnpm binary name. On Windows, pnpm installs
 * as `pnpm.cmd`; Node's child_process won't resolve the `.cmd`
 * extension automatically for `execFile`. Hardcoding the right name
 * per-platform avoids `shell: true` (which has escaping hazards).
 */
const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/**
 * Build-step subprocess timeout passed to `execFile`. CLI's tsc +
 * finalize-bin runs in ~5-10s on typical hardware; 2-min ceiling
 * accommodates slow CI runners AND the dependency-closed build
 * (which builds session-format, git, core, checks, reporters, and
 * cli in topological order).
 */
const BUILD_TIMEOUT_MS = 120_000;

/**
 * Vitest `beforeAll` hook timeout. Deliberately LARGER than
 * BUILD_TIMEOUT_MS by 30s so the inner subprocess timeout always
 * fires first — without the buffer, vitest's hook timer can race
 * the subprocess timer and report "hook timed out" before the
 * catch block in `ensureCliBuilt` gets to surface the build's
 * stdout/stderr. See lock #1's timeout-budgeting paragraph.
 */
const BEFORE_ALL_TIMEOUT_MS = BUILD_TIMEOUT_MS + 30_000;

/**
 * Per-fixture verify timeout. Each fixture runs 5 subprocess
 * invocations (init + checkpoint + check + report + report --markdown)
 * + several git operations. Real measured time is ~5-10s; 60s
 * ceiling is generous headroom.
 */
const FIXTURE_TIMEOUT_MS = 60_000;

/**
 * Subprocess buffer cap matching the harness's own EXEC_MAX_BUFFER_BYTES.
 * The build itself can produce substantial stdout (per-package tsc
 * compilation messages), so default 1MB is too tight under -r mode.
 */
const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

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

/**
 * Ensure `packages/cli/dist/index.js` exists as a real file. If
 * missing OR wrong shape, shell out to
 * `pnpm --filter viberevert... build` (dependency-closed) from the
 * repo root. Verifies the build actually produced the expected file
 * before returning.
 *
 * Asymmetric to regen-goldens.ts (which fail-fasts) — see lock #1
 * for rationale. Uses the dependency-closed filter per lock #3 so
 * all transitive workspace builds run too.
 *
 * Failure wrapping: execFile's default rejection message is
 * unhelpful for a multi-package build. The catch surfaces both
 * stdout AND stderr in the thrown Error so a CI build failure says
 * exactly what tsc complained about.
 */
async function ensureCliBuilt(): Promise<void> {
  let needBuild = false;
  try {
    const st = await lstat(CLI_BIN_ABS_PATH);
    if (!st.isFile()) needBuild = true;
  } catch {
    needBuild = true;
  }
  if (needBuild) {
    try {
      await execFileAsync(PNPM_BIN, ["--filter", "viberevert...", "build"], {
        cwd: REPO_ROOT,
        windowsHide: true,
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      throw new Error(
        `Failed to auto-build CLI for golden fixture tests.\n` +
          `Command: ${PNPM_BIN} --filter viberevert... build\n` +
          `stdout:\n${String(e.stdout ?? "")}\n` +
          `stderr:\n${String(e.stderr ?? e.message ?? "")}`,
      );
    }
  }
  // Post-build sanity. Covers BOTH failure modes with the same
  // precise message:
  //   - lstat throws ENOENT (build exited 0 but produced no file
  //     at the expected path — tsconfig misemit, wrong outDir, etc.)
  //   - lstat succeeds but isFile() is false (path exists as dir,
  //     symlink, FIFO, etc. — wrong shape)
  // Without the try/catch around lstat, the ENOENT case would leak
  // a raw Node-formatted error and contradict the comment above.
  try {
    const st = await lstat(CLI_BIN_ABS_PATH);
    if (!st.isFile()) {
      throw new Error(
        `CLI build did not produce a regular file at ${CLI_BIN_ABS_PATH}. ` +
          `Check the build output for errors.`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `CLI build did not produce a regular file at ${CLI_BIN_ABS_PATH}. ` +
          `Check the build output for errors.`,
      );
    }
    throw err;
  }
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
