// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// CLI runtime-env resolvers — D49 fixture-determinism foundation.
//
// Three single-purpose resolvers that produce values used in trust-
// critical CLI output (report timestamps, since-resolved SHAs, product
// version stamps). Each one:
//
//   1. Reads a designated test-only env var (VIBEREVERT_TEST_FIXED_NOW,
//      VIBEREVERT_TEST_FIXED_SHA, VIBEREVERT_TEST_FIXED_VERSION).
//   2. If set, validates the env value and returns the override.
//   3. If unset, returns the production value (live timestamp, real
//      SHA, or this package's package.json version).
//
// The env-var path is what makes golden-fixture comparisons in M C's
// check.test.ts / golden-reports.test.ts byte-stable across runs. Per
// D49, env-var-based seeding is the ONLY mechanism that works across
// the subprocess boundary the golden-fixture harness spawns the built
// CLI through; in-process deep-import setters would not survive a
// child process.
//
// Design rules locked at C.1:
//
//   - **Env injection, not global mutation.** Every resolver accepts an
//     optional `env` parameter (defaults to `process.env`), so unit
//     tests can pass a custom env without monkeypatching the real one.
//
//   - **Schema-safe normalization.** Wall-clock output flows through
//     `toIsoSecondString` from @viberevert/session-format. That's the
//     SAME helper consumed by every M C second-precision producer
//     (ReportFile.written_at, Manifest.captured_at, etc.), so the
//     resolver and the schemas agree on shape.
//
//   - **Fail loudly on bad fixed values.** A malformed
//     VIBEREVERT_TEST_FIXED_* env var must NOT silently fall through to
//     the live value — that would corrupt fixture output unobservably.
//     Each resolver throws `RuntimeEnvInvalidError` (extends Error)
//     with the offending env-var name + value + reason in the message.
//
//   - **Symmetric production-input validation where return value lands
//     in trust-critical output.** `resolveSinceResolvedShaForReport`
//     also validates `realSha` (its production input), so a malformed
//     caller value can't slip past the resolver into the report
//     builder. Production-path failures throw plain `Error` (caller
//     bug, distinct category from env-override misuse).
//
//   - **No CLI output.** No console, no process.stderr writes, no
//     Clipanion. Resolver returns are consumed by CLI orchestration
//     (check-orchestration.ts, future check.ts / report.ts) which owns
//     terminal stream writes per D29.
//
// Import policy (locked per the plan):
//   - viberevert checkpoint/start/end (M B commands, extended in
//     Phase E) import ONLY `resolveNowForCliTimestamp`.
//   - viberevert check (Phase D) imports all three.
//   - viberevert report (Phase D) imports `resolveProductVersionForReport`.
//   - check-orchestration.ts (Phase C) imports as needed.

import { toIsoSecondString, VIBEREVERT_TEST_FIXED_NOW } from "@viberevert/session-format";
import pkg from "../package.json" with { type: "json" };

// =============================================================================
// Env-var names (exported so tests reference them by name, not by string).
//
// NOW is re-exported from @viberevert/session-format because it is also
// consumed by ID factories in @viberevert/core and @viberevert/git per
// the shared-contract rule (D49 amendment / Precondition 2 commit).
// SHA and VERSION remain CLI-only — the CLI is the sole consumer, so
// they stay defined here. If a future cross-package consumer needs
// either, migrate it to packages/session-format/src/test-env-names.ts
// alongside NOW and ULID_SEED.
// =============================================================================

/**
 * Re-exported from @viberevert/session-format. See that module's
 * docstring for the full contract — production-unset, test-set
 * overrides the wall clock with a second-precision ISO 8601 string.
 * Re-exported here so existing CLI-internal imports
 * (`import { VIBEREVERT_TEST_FIXED_NOW } from "../runtime-env.js"`)
 * continue to work without churn — every test file landed in this
 * package already uses that import path.
 */
export { VIBEREVERT_TEST_FIXED_NOW };
/** Env var that, when set, fixes ReportFile.since_resolved_sha to its value. */
export const VIBEREVERT_TEST_FIXED_SHA = "VIBEREVERT_TEST_FIXED_SHA";
/** Env var that, when set, fixes the product version stamp to its value. */
export const VIBEREVERT_TEST_FIXED_VERSION = "VIBEREVERT_TEST_FIXED_VERSION";

// =============================================================================
// Shared validation (used by both env-override and production-input paths).
// =============================================================================

/** Canonical git SHA format: 40 lowercase hex characters. */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Asserts that `value` matches `SHA_RE`. Throws a plain `Error` with
 * the supplied `context` and the expected format if not. Used by the
 * production-input path of `resolveSinceResolvedShaForReport` (the
 * env-override path uses `RuntimeEnvInvalidError` instead — different
 * error classes for different failure categories).
 */
function assertCanonicalSha(value: string, context: string): void {
  if (!SHA_RE.test(value)) {
    throw new Error(`${context}: expected a 40-character lowercase-hex SHA`);
  }
}

// =============================================================================
// Error class
// =============================================================================

/**
 * Thrown when a `VIBEREVERT_TEST_FIXED_*` env var is set to a value
 * that cannot be used as the override. Carries the env-var name, the
 * bad value, and a short reason in the message so the surfacing CLI
 * command can render a clean diagnostic without re-parsing.
 *
 * Always preferred over a silent fallback: determinism knobs that
 * silently degrade to live values would let a typo'd sentinel corrupt
 * fixture output without anyone noticing.
 */
export class RuntimeEnvInvalidError extends Error {
  override readonly name = "RuntimeEnvInvalidError";
  constructor(
    readonly envVar: string,
    readonly value: string,
    readonly reason: string,
  ) {
    super(`${envVar}=${JSON.stringify(value)} is not a valid override: ${reason}`);
  }
}

// =============================================================================
// Resolvers
// =============================================================================

/**
 * Returns the current time as a schema-safe second-precision ISO 8601
 * string with `Z` offset (e.g. `2026-05-04T10:30:11Z`). Matches the
 * shape every M C second-precision producer expects.
 *
 * When `env[VIBEREVERT_TEST_FIXED_NOW]` is SET (defined; empty string
 * also counts as set per the fail-loud rule), the env value is parsed
 * as a Date and the resulting time is returned, normalized through
 * `toIsoSecondString` so any sub-second precision in the input is
 * stripped. An unparseable env value (empty string, garbage text,
 * etc.) throws `RuntimeEnvInvalidError`.
 *
 * When the env var is UNSET (undefined), `new Date()` is used (live
 * wall clock), normalized through the same helper. Whitespace in the
 * env value doesn't need an explicit guard here: `toIsoSecondString`
 * re-canonicalizes whatever `new Date()` produced, so a leading or
 * trailing space in the env value cannot leak into the output.
 */
export function resolveNowForCliTimestamp(env: NodeJS.ProcessEnv = process.env): string {
  const fixed = env[VIBEREVERT_TEST_FIXED_NOW];
  if (fixed !== undefined) {
    const d = new Date(fixed);
    if (Number.isNaN(d.getTime())) {
      throw new RuntimeEnvInvalidError(
        VIBEREVERT_TEST_FIXED_NOW,
        fixed,
        "not a parseable date string",
      );
    }
    return toIsoSecondString(d);
  }
  return toIsoSecondString(new Date());
}

/**
 * Returns `realSha` verbatim in production, or the value of
 * `env[VIBEREVERT_TEST_FIXED_SHA]` when set. Used by CLI code that
 * populates `ReportFile.since_resolved_sha` so the golden-fixture
 * harness can pin the audit field to a deterministic value.
 *
 * Both branches return a canonical 40-character lowercase-hex SHA:
 *
 *   - Production path: `realSha` is asserted to match SHA_RE. A
 *     malformed caller input throws a plain Error (caller bug; the
 *     symmetry-of-contract principle — whatever this function returns
 *     IS canonical).
 *
 *   - Env-override path: the env value MUST match SHA_RE. Otherwise
 *     throws `RuntimeEnvInvalidError` — a typo'd sentinel would
 *     silently corrupt fixture output, which is exactly what D49's
 *     fail-loud rule exists to prevent. Different error class than
 *     the production-path Error: env-override misuse and caller-input
 *     misuse are distinct failure categories.
 *
 * The SHA_RE character class is the implicit whitespace guard for
 * both paths: leading/trailing space cannot satisfy `[0-9a-f]{40}`.
 */
export function resolveSinceResolvedShaForReport(
  realSha: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fixed = env[VIBEREVERT_TEST_FIXED_SHA];
  if (fixed === undefined) {
    assertCanonicalSha(realSha, "resolveSinceResolvedShaForReport(realSha)");
    return realSha;
  }
  if (!SHA_RE.test(fixed)) {
    throw new RuntimeEnvInvalidError(
      VIBEREVERT_TEST_FIXED_SHA,
      fixed,
      "expected a 40-character lowercase-hex SHA",
    );
  }
  return fixed;
}

/**
 * Returns this CLI's package.json `version` field in production, or
 * the value of `env[VIBEREVERT_TEST_FIXED_VERSION]` when set. Used by
 * the report renderer's markdown footer
 * (`Generated by VibeRevert v...`) so golden-fixture comparisons
 * against `expected/report.markdown.md` stay byte-stable across
 * version bumps.
 *
 * The production fallback reads `pkg.version` from the static
 * `with { type: "json" }` import at the top of this module — the SAME
 * mechanism `viberevert --version` uses (`commands/version.ts`),
 * preserving the single-source-of-truth contract on what the running
 * CLI calls itself.
 *
 * When the env var is SET, the override MUST be non-blank AND must
 * not carry leading/trailing whitespace (which would silently embed
 * into the markdown footer and break byte-equality of golden output —
 * VERSION is the one resolver with no downstream normalization, so
 * the whitespace check is explicit here). Otherwise throws
 * `RuntimeEnvInvalidError`.
 */
export function resolveProductVersionForReport(env: NodeJS.ProcessEnv = process.env): string {
  const fixed = env[VIBEREVERT_TEST_FIXED_VERSION];
  if (fixed === undefined) {
    return pkg.version;
  }
  if (fixed.trim().length === 0) {
    throw new RuntimeEnvInvalidError(
      VIBEREVERT_TEST_FIXED_VERSION,
      fixed,
      "must be a non-blank string",
    );
  }
  if (fixed !== fixed.trim()) {
    throw new RuntimeEnvInvalidError(
      VIBEREVERT_TEST_FIXED_VERSION,
      fixed,
      "must not contain leading or trailing whitespace",
    );
  }
  return fixed;
}
