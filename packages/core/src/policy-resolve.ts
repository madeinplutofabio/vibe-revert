// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Policy resolution -- applies M C defaults to a loaded Config and
// returns a fully-concrete ResolvedChecksConfig. Promoted from
// @viberevert/cli-commands/src/check-orchestration.ts as part of
// M G1a Step 3.5a so consumers other than the CLI's
// `viberevert check` can reach the resolver through
// @viberevert/core's public surface.
//
// Consumers in v0.7.0-beta:
//   - @viberevert/cli-commands/src/commands/check.ts (production CLI)
//   - @viberevert/mcp/src/tools/get-policy.ts (MCP tool -- slice 3.5)
//
// Locked design rules (unchanged by the promotion):
//
//   - **Defaults applied ONLY here.** Per D57, `loadConfig` returns
//     the parsed config with optional fields as `undefined`; defaults
//     flow in at the engine/CLI/MCP boundary via `mergeChecksConfig`.
//     No defaults in core's config schema; no defaults inside any
//     check implementation.
//
//   - **No I/O beyond `detectFrameworks` delegation.** When
//     `config.frameworks` is omitted or empty, `mergeChecksConfig`
//     calls `detectFrameworks(repoRoot)` (which does `fs.existsSync`
//     probes). Everything else is in-memory transformation.
//
//   - **The 4 DEFAULT_* constants are the SOLE place those defaults
//     exist** (D57). Do not define additional DEFAULT_RISK_,
//     DEFAULT_CHECKS_, or DEFAULT_FRAMEWORKS_ symbols in package src
//     files.

import type { RiskLevel } from "@viberevert/session-format";

import type { Config } from "./config.js";
import { detectFrameworks } from "./framework-detect.js";

// =============================================================================
// D57-locked default constants
// =============================================================================

/** Default `risk.block_on` per D24 / D57. */
export const DEFAULT_RISK_BLOCK_ON: RiskLevel = "critical";

/** Default `risk.warn_on` per D24 / D57. */
export const DEFAULT_RISK_WARN_ON: RiskLevel = "medium";

/**
 * Default per-category enable map per D57. All 8 keys default to true;
 * the user opts OUT by setting a key to `false` in `.viberevert.yml`.
 * Typed against `keyof ConfigChecks` so adding a new check toggle to
 * the schema forces an update here at compile time.
 */
type ConfigChecks = NonNullable<Config["checks"]>;
export type ChecksToggleKey = keyof ConfigChecks;
export const DEFAULT_CHECKS_CONFIG: Readonly<Record<ChecksToggleKey, boolean>> = {
  secrets: true,
  dependencies: true,
  migrations: true,
  auth: true,
  payments: true,
  infra: true,
  tests: true,
  scope_expansion: true,
};

/**
 * Sentinel that documents the default-frameworks policy per D42 / D57:
 * when `config.frameworks` is omitted or empty, `mergeChecksConfig`
 * invokes `detectFrameworks(repoRoot)`. The const is exported for
 * discoverability; the merge function does not branch on its value
 * (the branch is on `config.frameworks` being non-empty).
 */
export const DEFAULT_FRAMEWORKS_POLICY = "auto-detect" as const;

// =============================================================================
// ResolvedChecksConfig
// =============================================================================

export interface ResolvedChecksConfig {
  readonly riskBlockOn: RiskLevel;
  readonly riskWarnOn: RiskLevel;
  readonly checks: Readonly<Record<ChecksToggleKey, boolean>>;
  readonly frameworks: readonly string[];
  readonly rollbackExclude: readonly string[];
}

/**
 * Apply M C defaults per D57 to a loaded `Config`. Returns a fully-
 * resolved view with every field guaranteed non-undefined. Array
 * fields (`frameworks`, `rollbackExclude`) are returned as defensive
 * snapshots so downstream mutation of the caller's `Config` cannot
 * retroactively change a returned `ResolvedChecksConfig`:
 *
 *   - `risk.block_on` / `risk.warn_on` default to `DEFAULT_RISK_*`.
 *   - Each `checks.*` toggle defaults to true.
 *   - `frameworks`: if `config.frameworks` is non-empty, returned
 *     as a snapshot. Otherwise `detectFrameworks(repoRoot)` is invoked
 *     and its result is snapshotted.
 *   - `rollback.exclude` defaults to `[]`; snapshotted when provided.
 *
 * Per D57's "defaults applied at the engine boundary, not in
 * loadConfig" rule, this is the SOLE place those defaults exist.
 */
export async function mergeChecksConfig(
  config: Config,
  repoRoot: string,
): Promise<ResolvedChecksConfig> {
  const riskBlockOn = config.risk?.block_on ?? DEFAULT_RISK_BLOCK_ON;
  const riskWarnOn = config.risk?.warn_on ?? DEFAULT_RISK_WARN_ON;

  const checks: Record<ChecksToggleKey, boolean> = {
    secrets: config.checks?.secrets ?? DEFAULT_CHECKS_CONFIG.secrets,
    dependencies: config.checks?.dependencies ?? DEFAULT_CHECKS_CONFIG.dependencies,
    migrations: config.checks?.migrations ?? DEFAULT_CHECKS_CONFIG.migrations,
    auth: config.checks?.auth ?? DEFAULT_CHECKS_CONFIG.auth,
    payments: config.checks?.payments ?? DEFAULT_CHECKS_CONFIG.payments,
    infra: config.checks?.infra ?? DEFAULT_CHECKS_CONFIG.infra,
    tests: config.checks?.tests ?? DEFAULT_CHECKS_CONFIG.tests,
    scope_expansion: config.checks?.scope_expansion ?? DEFAULT_CHECKS_CONFIG.scope_expansion,
  };

  let frameworks: readonly string[];
  if (config.frameworks !== undefined && config.frameworks.length > 0) {
    frameworks = [...config.frameworks];
  } else {
    frameworks = [...(await detectFrameworks(repoRoot))];
  }

  const rollbackExclude = [...(config.rollback?.exclude ?? [])];

  return { riskBlockOn, riskWarnOn, checks, frameworks, rollbackExclude };
}
