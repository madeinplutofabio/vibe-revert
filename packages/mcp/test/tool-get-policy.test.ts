// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for tools/get-policy.ts.
//
// Test focus:
//   - input validation (empty pass, extras rejected)
//   - success path with projected snake_case shape
//   - MCP-boundary snapshot ownership for both data arrays/objects
//     and the validation issues array
//   - 3 typed-error paths (CONFIG_NOT_FOUND / CONFIG_PARSE_FAILED /
//     CONFIG_VALIDATION_FAILED with details.issues)
//   - INTERNAL_ERROR fallback for unknown errors, partitioned across
//     loadConfig vs mergeChecksConfig failure points
//   - definition smoke (name, no cwd-like inputs, empty input,
//     wire-contract additionalProperties:false)
//
// Mock strategy: stub @viberevert/core's loadConfig and
// mergeChecksConfig at the boundary; preserve the real Config*Error
// classes so `instanceof` works in the handler's ConfigValidationError
// branch (per slice 3.5 direction).

import type { Config } from "@viberevert/core";
import { ConfigNotFoundError, ConfigParseError, ConfigValidationError } from "@viberevert/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@viberevert/core", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/core")>("@viberevert/core");
  return {
    ...actual,
    loadConfig: vi.fn(),
    mergeChecksConfig: vi.fn(),
  };
});

const { handler, definition } = await import("../src/tools/get-policy.js");
const core = await import("@viberevert/core");
const mockedLoadConfig = vi.mocked(core.loadConfig);
const mockedMergeChecksConfig = vi.mocked(core.mergeChecksConfig);

const ABS_REPO_ROOT = "/abs/repo";

const MINIMAL_CONFIG: Config = { version: 1 };

const DEFAULT_RESOLVED = {
  riskBlockOn: "critical" as const,
  riskWarnOn: "medium" as const,
  checks: {
    secrets: true,
    dependencies: true,
    migrations: true,
    auth: true,
    payments: true,
    infra: true,
    tests: true,
    scope_expansion: true,
  },
  frameworks: ["laravel"] as readonly string[],
  rollbackExclude: ["vendor/**"] as readonly string[],
};

beforeEach(() => {
  mockedLoadConfig.mockReset();
  mockedMergeChecksConfig.mockReset();
});

// ============================================================================
// A. Input validation
// ============================================================================

describe("get_policy handler: input validation", () => {
  it("empty input passes validation and proceeds to load+merge", async () => {
    mockedLoadConfig.mockResolvedValueOnce(MINIMAL_CONFIG);
    mockedMergeChecksConfig.mockResolvedValueOnce(DEFAULT_RESOLVED);
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    expect(mockedLoadConfig).toHaveBeenCalledWith(ABS_REPO_ROOT);
    expect(mockedMergeChecksConfig).toHaveBeenCalledWith(MINIMAL_CONFIG, ABS_REPO_ROOT);
  });

  it("rejects extra key with INVALID_TOOL_INPUT and does not call core", async () => {
    const env = await handler({ extra: 1 }, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INVALID_TOOL_INPUT");
    expect(mockedLoadConfig).not.toHaveBeenCalled();
    expect(mockedMergeChecksConfig).not.toHaveBeenCalled();
  });
});

// ============================================================================
// B. Success projection
// ============================================================================

describe("get_policy handler: success projection", () => {
  it("projects ResolvedPolicy camelCase to MCP snake_case shape", async () => {
    mockedLoadConfig.mockResolvedValueOnce(MINIMAL_CONFIG);
    mockedMergeChecksConfig.mockResolvedValueOnce({
      riskBlockOn: "high",
      riskWarnOn: "low",
      checks: { ...DEFAULT_RESOLVED.checks, secrets: false },
      frameworks: ["laravel", "nextjs"],
      rollbackExclude: ["vendor/**", "node_modules/**"],
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true) {
      expect(env.data).toEqual({
        risk: { block_on: "high", warn_on: "low" },
        frameworks: ["laravel", "nextjs"],
        checks_enabled: {
          secrets: false,
          dependencies: true,
          migrations: true,
          auth: true,
          payments: true,
          infra: true,
          tests: true,
          scope_expansion: true,
        },
        rollback_exclude: ["vendor/**", "node_modules/**"],
      });
    }
  });

  it("data fields are snapshots (mutating mocked-resolved post-call does not change env.data)", async () => {
    // Mutable references handed to the resolver mock.
    const frameworks = ["laravel"];
    const rollbackExclude = ["vendor/**"];
    const checks = { ...DEFAULT_RESOLVED.checks };
    mockedLoadConfig.mockResolvedValueOnce(MINIMAL_CONFIG);
    mockedMergeChecksConfig.mockResolvedValueOnce({
      riskBlockOn: "critical",
      riskWarnOn: "medium",
      checks,
      frameworks,
      rollbackExclude,
    });
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);

    // Mutate the original references AFTER the handler returned.
    // MCP boundary owns the snapshot -> env.data must be unchanged.
    frameworks.push("nextjs");
    rollbackExclude.push("node_modules/**");
    checks.secrets = false;

    if (env.ok === true) {
      expect(env.data.frameworks).toEqual(["laravel"]);
      expect(env.data.rollback_exclude).toEqual(["vendor/**"]);
      expect(env.data.checks_enabled.secrets).toBe(true);
    }
  });
});

// ============================================================================
// C. Typed-error mapping
// ============================================================================

describe("get_policy handler: typed-error mapping", () => {
  it("ConfigNotFoundError -> CONFIG_NOT_FOUND; mergeChecksConfig never called", async () => {
    mockedLoadConfig.mockRejectedValueOnce(new ConfigNotFoundError("/abs/repo/.viberevert.yml"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("CONFIG_NOT_FOUND");
    expect(mockedMergeChecksConfig).not.toHaveBeenCalled();
  });

  it("ConfigParseError -> CONFIG_PARSE_FAILED; mergeChecksConfig never called", async () => {
    mockedLoadConfig.mockRejectedValueOnce(
      new ConfigParseError("/abs/repo/.viberevert.yml", new Error("bad YAML: line 3")),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("CONFIG_PARSE_FAILED");
    expect(mockedMergeChecksConfig).not.toHaveBeenCalled();
  });

  it("ConfigValidationError -> CONFIG_VALIDATION_FAILED with details.issues populated", async () => {
    // Build a real ZodError with non-empty issues so the wrapped
    // ConfigValidationError carries them through.
    const realSchema = z.strictObject({ version: z.literal(1), foo: z.string() });
    const safeParseResult = realSchema.safeParse({ version: 1 });
    expect(safeParseResult.success).toBe(false);
    if (safeParseResult.success === false) {
      mockedLoadConfig.mockRejectedValueOnce(
        new ConfigValidationError("/abs/repo/.viberevert.yml", safeParseResult.error),
      );

      const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
      expect(env.ok).toBe(false);
      if (env.ok === false) {
        expect(env.error.code).toBe("CONFIG_VALIDATION_FAILED");
        const details = env.error.details as { issues?: unknown };
        expect(Array.isArray(details.issues)).toBe(true);
        expect((details.issues as unknown[]).length).toBeGreaterThan(0);
      }
      expect(mockedMergeChecksConfig).not.toHaveBeenCalled();
    }
  });

  it("CONFIG_VALIDATION_FAILED details.issues is a different array reference than the source", async () => {
    const realSchema = z.strictObject({ version: z.literal(1), foo: z.string() });
    const safeParseResult = realSchema.safeParse({ version: 1 });
    if (safeParseResult.success === false) {
      const validationErr = new ConfigValidationError(
        "/abs/repo/.viberevert.yml",
        safeParseResult.error,
      );
      mockedLoadConfig.mockRejectedValueOnce(validationErr);

      const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
      expect(env.ok).toBe(false);
      if (env.ok === false) {
        const detailsIssues = (env.error.details as { issues: unknown }).issues;
        // Snapshot identity: not the same array; equal content.
        expect(detailsIssues).not.toBe(validationErr.issues);
        expect(detailsIssues).toEqual(validationErr.issues);
      }
    }
  });

  it("unknown error from loadConfig -> INTERNAL_ERROR fallback; mergeChecksConfig never called", async () => {
    mockedLoadConfig.mockRejectedValueOnce(new Error("disk on fire"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INTERNAL_ERROR");
    expect(mockedMergeChecksConfig).not.toHaveBeenCalled();
  });

  it("unknown error from mergeChecksConfig -> INTERNAL_ERROR fallback (config loaded, merger threw)", async () => {
    mockedLoadConfig.mockResolvedValueOnce(MINIMAL_CONFIG);
    mockedMergeChecksConfig.mockRejectedValueOnce(new Error("framework detect blew up"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) expect(env.error.code).toBe("INTERNAL_ERROR");
    expect(mockedLoadConfig).toHaveBeenCalledTimes(1);
    expect(mockedMergeChecksConfig).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// D. Definition smoke
// ============================================================================

describe("get_policy definition export", () => {
  it("name is 'get_policy'", () => {
    expect(definition.name).toBe("get_policy");
  });

  it("inputSchema has no cwd-like keys (D99.M.17)", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    const forbidden = ["cwd", "target_repo", "repo", "directory", "repo_path", "working_directory"];
    for (const k of Object.keys(props)) expect(forbidden).not.toContain(k);
  });

  it("inputSchema is empty (no properties declared; extras rejected)", () => {
    const props = (definition.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).toHaveLength(0);
  });

  it("inputSchema rejects additional properties at the JSON-schema layer", () => {
    expect(definition.inputSchema.additionalProperties).toBe(false);
  });
});
