// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Risk level and its total ordering.
//
// Extracted from schemas.ts (M 0.8.0 step 0) to break a real module cycle: the
// session-start evaluation snapshot records RESOLVED `risk_block_on` /
// `risk_warn_on`, so it needs RiskLevelSchema, while schemas.ts must import the
// snapshot schema to embed it in SessionState. These are zod values built at
// module-init time, so a cycle would fail at load rather than merely offending
// a linter.
//
// Pure move: no behavior change, no renames. schemas.ts re-exports every symbol
// here so the package barrel is unaffected.

import { z } from "zod";

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// =============================================================================
// Severity ordering (single source of truth for level comparison)
//
// Per D25 in the M C plan. The checks engine, reporters, and CLI MUST import
// `compareLevel` / `riskLevelAtOrAbove` from here -- no ad-hoc string
// comparison anywhere. The integer ranks are an implementation detail; only
// the helpers' return values are public.
// =============================================================================

const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Total order over `RiskLevel`: `low < medium < high < critical`. Returns
 * `-1` if `a < b`, `0` if `a === b`, `+1` if `a > b`. Intended for use as a
 * comparator (e.g. `[...levels].sort(compareLevel)`).
 */
export function compareLevel(a: RiskLevel, b: RiskLevel): -1 | 0 | 1 {
  const ra = LEVEL_RANK[a];
  const rb = LEVEL_RANK[b];
  if (ra < rb) return -1;
  if (ra > rb) return 1;
  return 0;
}

/**
 * True iff `actual` meets or exceeds `threshold` in the locked severity
 * ordering. Used by `viberevert check`'s gate (`actual >= risk.block_on`),
 * by `--threshold <level>` output filtering in renderers, and by 0.8.0's
 * `--risk <level>` selector, which is an at-or-above threshold rather than an
 * exact-match filter.
 */
export function riskLevelAtOrAbove(actual: RiskLevel, threshold: RiskLevel): boolean {
  return LEVEL_RANK[actual] >= LEVEL_RANK[threshold];
}
