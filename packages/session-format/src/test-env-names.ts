// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Test-only environment-variable name constants shared across
// packages.
//
// Why session-format owns these: @viberevert/core (id factories) AND
// @viberevert/git (id factory) AND the CLI (runtime-env resolvers)
// all need to agree on the EXACT string spelling of these env-var
// names. Defining them in session-format — the only sibling package
// both core and git already depend on — eliminates the "two
// definitions of the same string, kept in sync by hand" drift risk
// that would otherwise emerge as soon as a second package starts
// reading the env directly.
//
// Strict scope (locked): this module exports ONLY env-var-name
// constants for test-time determinism knobs that are read across
// package boundaries. NO runtime logic, NO parsing, NO PRNG helpers,
// NO resolvers. Each consumer (core/git ids.ts, cli/runtime-env.ts)
// implements its own env-reading behavior against these names.
//
// Env vars NOT exposed here (CLI-only, intentional):
//   - VIBEREVERT_TEST_FIXED_SHA      — only resolveSinceResolvedShaForReport
//                                       reads it; CLI is the only consumer.
//   - VIBEREVERT_TEST_FIXED_VERSION  — only resolveProductVersionForReport
//                                       reads it; CLI is the only consumer.
// They remain defined as local consts in packages/cli/src/runtime-env.ts.
// If a future cross-package need arises (e.g., a non-CLI rendering
// package needing the version stamp), they migrate here too.

/**
 * Test-only env var. When set to a second-precision ISO 8601 string
 * with `Z` offset (e.g., `"2026-01-01T00:00:00Z"`), CLI timestamp
 * resolvers use the value verbatim and ID factories in
 * @viberevert/core and @viberevert/git use it as the ULID time
 * component instead of sampling the wall clock. Used by the D49
 * fixture harness (M C Step 10) for byte-deterministic persisted
 * artifacts. Unset in production.
 *
 * Each consumer validates the value before parsing (precise shape
 * regex + `Date.parse` to ms). The CLI surfaces malformed values via
 * `RuntimeEnvInvalidError`; core/git surface them via plain `Error`
 * (cannot import the CLI's typed error per the dep-direction rule).
 */
export const VIBEREVERT_TEST_FIXED_NOW = "VIBEREVERT_TEST_FIXED_NOW";

/**
 * Test-only env var. When set to any non-empty string, ID factories
 * in @viberevert/core (session/report) and @viberevert/git
 * (checkpoint) initialize seeded deterministic ULID sequences from
 * the value (per-namespace subseeded so the three ID streams produce
 * independent sequences). Used by the D49 fixture harness (M C Step
 * 10) so `report_id`, `session_id`, and `checkpoint_id` are
 * byte-stable across golden-fixture regeneration runs. Unset in
 * production.
 *
 * In seeded mode, the ULID time component is sourced from
 * `VIBEREVERT_TEST_FIXED_NOW` when also set, OR from a fallback
 * fixed timestamp (`2026-01-01T00:00:00Z`) otherwise — guaranteeing
 * the ULID is fully deterministic even when only the seed is set.
 * The fallback exists so deterministic-ID tests that don't care
 * about NOW don't have to set two env vars.
 *
 * Namespace subseeds (locked, used internally by the ID factories):
 *   - `core:session`     → generateSessionId
 *   - `core:report`      → generateReportId
 *   - `git:checkpoint`   → generateCheckpointId
 *
 * Without per-namespace subseeding, all three factories would produce
 * ULIDs with identical random-suffix progressions under the same
 * seed — easy to miss in casual inspection, painful when it breaks
 * something cross-cutting.
 */
export const VIBEREVERT_TEST_FIXED_ULID_SEED = "VIBEREVERT_TEST_FIXED_ULID_SEED";
