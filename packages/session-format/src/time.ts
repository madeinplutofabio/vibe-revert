// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Time-formatting helper for VibeRevert persisted artifacts.
//
// All M B / M C persisted timestamps validate against
// `z.iso.datetime({ offset: true, precision: 0 })` — i.e., second-precision
// ISO 8601 with explicit offset (e.g., "2026-05-04T10:30:11Z"). Native
// `Date.prototype.toISOString()` always emits milliseconds
// ("2026-05-04T10:30:11.123Z"), which the schemas REJECT.
//
// `toIsoSecondString` is the canonical producer-side bridge: every code path
// that builds a Manifest, SessionState, ActiveSessionLock, SessionReport, or
// ReportFile MUST route its wall-clock timestamps through this helper rather
// than calling `Date.prototype.toISOString()` directly. (M C's
// `buildReportFile` uses the CLI's `resolveNowForCliTimestamp()` resolver
// per the M C plan's Step 9 / D49 env-var-overridable contract; that
// resolver internally calls `toIsoSecondString` so the production path and
// the fixture/golden-determinism path share one normalization point.)
//
// Throws (via the underlying `toISOString()`) on an Invalid Date — that's
// the desired failure mode: an invalid env-overridden value should surface
// immediately rather than silently producing schema-invalid output.

/**
 * Returns an ISO 8601 string at SECOND precision from the given Date by
 * stripping the millisecond segment that `Date.prototype.toISOString()`
 * always emits. **This truncates to the second; it does not round.**
 *
 * Throws `RangeError: Invalid time value` when `date` is an Invalid Date —
 * via the underlying `toISOString()` call; we don't catch it, the caller
 * surfaces the failure.
 *
 * Examples:
 *   toIsoSecondString(new Date("2026-05-04T10:30:11.123Z"))
 *     -> "2026-05-04T10:30:11Z"
 *   toIsoSecondString(new Date("2026-05-04T10:30:11.999Z"))
 *     -> "2026-05-04T10:30:11Z"     // truncated, NOT rounded up to :12
 *   toIsoSecondString(new Date("2026-05-04T10:30:11Z"))
 *     -> "2026-05-04T10:30:11Z"     // already second-precision, unchanged
 *
 * Non-goal: this helper does NOT validate that the input represents a
 * future or past time, a particular timezone, etc. It is a pure
 * representation-narrowing utility — schema validation happens at
 * `z.iso.datetime({ offset: true, precision: 0 })` parse time, not here.
 */
export function toIsoSecondString(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
