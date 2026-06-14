// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for src/policy-resolve.ts.
//
// These tests were promoted from
// packages/cli-commands/test/check-orchestration.test.ts as part of
// M G1a Step 3.5a, together with the policy-resolution implementation.
//
// Test focus:
//   - D57-locked default constant shapes
//   - mergeChecksConfig behavior for risk threshold defaults
//   - checks.* default merging
//   - explicit framework configuration
//   - framework auto-detect fallback when no frameworks are configured
//   - rollback.exclude default merging

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Config,
  DEFAULT_CHECKS_CONFIG,
  DEFAULT_FRAMEWORKS_POLICY,
  DEFAULT_RISK_BLOCK_ON,
  DEFAULT_RISK_WARN_ON,
  mergeChecksConfig,
} from "../src/index.js";

// =============================================================================
// Helpers
// =============================================================================

function makeMinimalConfig(overrides: Partial<Config> = {}): Config {
  return { version: 1, ...overrides };
}

// =============================================================================
// Per-test temp repo (mergeChecksConfig -> detectFrameworks does fs probes)
// =============================================================================

let tmpRoot: string;
let repoRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-policy-resolve-test-"));
  repoRoot = join(tmpRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// =============================================================================
// D57 default constants
// =============================================================================

describe("D57 default constants", () => {
  it("DEFAULT_RISK_BLOCK_ON === 'critical'", () => {
    expect(DEFAULT_RISK_BLOCK_ON).toBe("critical");
  });

  it("DEFAULT_RISK_WARN_ON === 'medium'", () => {
    expect(DEFAULT_RISK_WARN_ON).toBe("medium");
  });

  it("DEFAULT_CHECKS_CONFIG has all 8 toggle keys set to true", () => {
    expect(DEFAULT_CHECKS_CONFIG).toEqual({
      secrets: true,
      dependencies: true,
      migrations: true,
      auth: true,
      payments: true,
      infra: true,
      tests: true,
      scope_expansion: true,
    });
  });

  it("DEFAULT_FRAMEWORKS_POLICY === 'auto-detect'", () => {
    expect(DEFAULT_FRAMEWORKS_POLICY).toBe("auto-detect");
  });
});

// =============================================================================
// mergeChecksConfig
// =============================================================================

describe("mergeChecksConfig -- D57 default merging", () => {
  it("empty config: applies all defaults; auto-detect returns [] on empty repo", async () => {
    const result = await mergeChecksConfig(makeMinimalConfig(), repoRoot);
    expect(result.riskBlockOn).toBe("critical");
    expect(result.riskWarnOn).toBe("medium");
    expect(result.checks).toEqual(DEFAULT_CHECKS_CONFIG);
    expect(result.frameworks).toEqual([]);
    expect(result.rollbackExclude).toEqual([]);
  });

  it("risk.block_on / warn_on overrides preserved", async () => {
    const result = await mergeChecksConfig(
      makeMinimalConfig({ risk: { block_on: "high", warn_on: "low" } }),
      repoRoot,
    );
    expect(result.riskBlockOn).toBe("high");
    expect(result.riskWarnOn).toBe("low");
  });

  it("explicit checks.* false overrides default true", async () => {
    const result = await mergeChecksConfig(
      makeMinimalConfig({ checks: { secrets: false, dependencies: false } }),
      repoRoot,
    );
    // Full-shape equality so a sparse return (only the overridden
    // subset, missing the 6 defaulted-true keys) fails here.
    expect(result.checks).toEqual({
      ...DEFAULT_CHECKS_CONFIG,
      secrets: false,
      dependencies: false,
    });
  });

  it("explicit frameworks array used verbatim (skips auto-detect)", async () => {
    const result = await mergeChecksConfig(
      makeMinimalConfig({ frameworks: ["laravel", "nextjs"] }),
      repoRoot,
    );
    expect(result.frameworks).toEqual(["laravel", "nextjs"]);
  });

  it("frameworks omitted OR empty array -> auto-detect invoked", async () => {
    const omitted = await mergeChecksConfig(makeMinimalConfig(), repoRoot);
    const empty = await mergeChecksConfig(makeMinimalConfig({ frameworks: [] }), repoRoot);
    expect(omitted.frameworks).toEqual([]);
    expect(empty.frameworks).toEqual([]);
  });

  it("rollback.exclude passed through; defaults to []", async () => {
    const withExcludes = await mergeChecksConfig(
      makeMinimalConfig({ rollback: { exclude: ["vendor/**"] } }),
      repoRoot,
    );
    expect(withExcludes.rollbackExclude).toEqual(["vendor/**"]);
    const without = await mergeChecksConfig(makeMinimalConfig(), repoRoot);
    expect(without.rollbackExclude).toEqual([]);
  });

  it("returns snapshots, not live references to config arrays", async () => {
    const frameworks = ["laravel"];
    const rollbackExclude = ["vendor/**"];
    const config = makeMinimalConfig({
      frameworks,
      rollback: { exclude: rollbackExclude },
    });

    const result = await mergeChecksConfig(config, repoRoot);

    // Mutate the caller-owned arrays AFTER the resolver call.
    // Snapshot semantics require result.frameworks / .rollbackExclude
    // to be unaffected.
    frameworks.push("nextjs");
    rollbackExclude.push("node_modules/**");

    expect(result.frameworks).toEqual(["laravel"]);
    expect(result.rollbackExclude).toEqual(["vendor/**"]);
  });
});
