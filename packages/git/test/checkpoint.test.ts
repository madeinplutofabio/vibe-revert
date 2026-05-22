// packages/git/test/checkpoint.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// createCheckpoint — focused tests for the M C `capturedAt` option
// (the deterministic-timestamp precondition for Step 10 golden
// fixtures).
//
// What this file covers:
//   - Determinism: opts.capturedAt is used verbatim in manifest.captured_at
//     AND flows through to manifest.rollback_target_description's audit
//     string. Exact-equality assertion — a future regression that drifts
//     either field surfaces here.
//   - Fallback: omitting opts.capturedAt preserves the original M B
//     behavior of sampling the wall clock via nowIsoSecondPrecision().
//     Asserted via the second-precision ISO 8601 regex (matches
//     ManifestSchema's `precision: 0, offset: true` constraint) plus a
//     tolerant before/after second-bound — a deliberately broad window
//     because real-clock equality would be brittle.
//
// What this file does NOT cover (already covered elsewhere):
//   - Manifest schema validation: every existing createCheckpoint test
//     in restore.test.ts / diff.test.ts / find-checkpoint-by-name.test.ts
//     parses the resulting manifest via ManifestSchema; further coverage
//     here would just duplicate.
//   - D17b temp+rename flow: that's CLI orchestration (checkpoint.ts /
//     start.ts), not createCheckpoint itself, and is exercised end-to-end
//     by the CLI integration tests.
//   - Hash/snapshot correctness: that's restore.test.ts / restore-matrix.test.ts.
//
// Harness pattern mirrors find-checkpoint-by-name.test.ts: per-test
// setupRepo + try/finally cleanup. No monotonic temp counter needed
// (each test creates exactly one checkpoint).

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ManifestSchema } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { createCheckpoint } from "../src/checkpoint.js";

// =============================================================================
// Test helpers
// =============================================================================

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-createckpt-test-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await runGit(repoRoot, ["add", ".gitignore", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return {
    repoRoot,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("createCheckpoint capturedAt option (M C addition)", () => {
  it("uses the provided opts.capturedAt verbatim in manifest.captured_at AND in rollback_target_description", async () => {
    const repo = await setupRepo();
    try {
      // Pre-create an empty checkpoint dir under the realistic
      // `.viberevert/checkpoints/.tmp-checkpoint-*/` path — mirrors how
      // the CLI orchestrates the temp+rename flow. createCheckpoint
      // itself would mkdir this idempotently, but pre-creating keeps
      // the test setup explicit.
      const checkpointDir = join(
        repo.repoRoot,
        ".viberevert",
        "checkpoints",
        ".tmp-checkpoint-fixed-clock",
      );
      await mkdir(checkpointDir, { recursive: true });

      // Locked sentinel value — second-precision ISO 8601 with Z
      // offset. Matches the format ManifestSchema enforces via
      // `z.iso.datetime({ precision: 0, offset: true })`. Identical
      // shape to the VIBEREVERT_TEST_FIXED_NOW value the M C golden-
      // fixture harness uses (D49).
      const FIXED_CAPTURED_AT = "2026-01-01T00:00:00Z";

      await createCheckpoint({
        repoRoot: repo.repoRoot,
        checkpointDir,
        rollbackExcludePatterns: [],
        capturedAt: FIXED_CAPTURED_AT,
      });

      const manifest = ManifestSchema.parse(
        JSON.parse(await readFile(join(checkpointDir, "manifest.json"), "utf8")),
      );

      // Primary contract: captured_at is the caller's value verbatim,
      // not the wall clock.
      expect(manifest.captured_at).toBe(FIXED_CAPTURED_AT);

      // Secondary contract: rollback_target_description embeds the
      // capturedAt value via template literal in createCheckpoint's
      // manifest construction. Asserting this catches a regression
      // where capturedAt accidentally diverges across the two slots
      // (e.g., if someone later refactored the description string to
      // re-sample the clock — silent drift that ManifestSchema would
      // happily accept).
      expect(manifest.rollback_target_description).toContain(FIXED_CAPTURED_AT);
    } finally {
      await repo.cleanup();
    }
  });

  it("falls back to wall-clock second-precision ISO 8601 when opts.capturedAt is omitted", async () => {
    const repo = await setupRepo();
    try {
      const checkpointDir = join(
        repo.repoRoot,
        ".viberevert",
        "checkpoints",
        ".tmp-checkpoint-wall-clock",
      );
      await mkdir(checkpointDir, { recursive: true });

      // Sample wall-clock bounds around the createCheckpoint call.
      // Both bounds are millisecond-precision (Date.now()), so we
      // floor `before` and ceil `after` to the nearest whole second
      // when comparing against the manifest's second-precision value
      // — gives a tolerant boundary that ALWAYS contains the true
      // captured time regardless of where in the second the sample
      // fell. Brittle exact-clock equality is avoided per the locked
      // rule: "deterministic test asserts exact equality, fallback
      // test asserts shape + tolerant bound."
      const before = Date.now();
      await createCheckpoint({
        repoRoot: repo.repoRoot,
        checkpointDir,
        rollbackExcludePatterns: [],
      });
      const after = Date.now();

      const manifest = ManifestSchema.parse(
        JSON.parse(await readFile(join(checkpointDir, "manifest.json"), "utf8")),
      );

      // Shape: second-precision ISO 8601 with Z offset. Matches the
      // private `nowIsoSecondPrecision()` helper's output AND
      // ManifestSchema's `precision: 0, offset: true` constraint. A
      // regression that re-introduced millisecond precision (e.g., by
      // accidentally calling `new Date().toISOString()` directly) would
      // fail this regex AND would have failed ManifestSchema.parse
      // above — double safety net.
      expect(manifest.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

      // Tolerant bound. Floor `before` and ceil `after` to seconds so
      // the comparison window always contains the true captured value
      // even when the sample fell mid-second.
      const captured = Date.parse(manifest.captured_at);
      expect(captured).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(captured).toBeLessThanOrEqual(Math.ceil(after / 1000) * 1000);
    } finally {
      await repo.cleanup();
    }
  });
});
