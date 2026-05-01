// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Secret-pattern redaction.
//
// This is a deliberate STUB for v0.7.0-beta. No production code path
// currently calls redact(); it exists as the documented seam for the future
// cloud-sync surface (Phase 3+) so that when sync arrives, callers already
// have the right hook in place.
//
// The pattern set is intentionally conservative: well-known prefixed tokens
// only. Real entropy-based detection arrives in Milestone C as part of the
// secrets check in @viberevert/checks. The two systems serve different
// purposes:
//   - redact() here: scrub already-known-leaked text before it leaves the
//     local machine.
//   - checks/secrets.ts (M C): detect possibly-leaked secrets in repository
//     diffs to surface them to the user.

const REDACTED = "[REDACTED]";

/**
 * Internal readonly pattern set for well-known prefixed tokens. Each match is
 * replaced wholesale by [REDACTED]. Patterns are global (`g` flag) so all
 * occurrences in a string are replaced, not just the first.
 *
 * Sources: VibeRevert CLI build plan §12.4 secrets-check pattern list.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Stripe live secret keys
  /sk_live_[A-Za-z0-9]+/g,
  // GitHub personal access tokens (classic and fine-grained)
  /ghp_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]+/g,
  // Slack tokens (bot, user, app, refresh, etc. — covers xoxb, xoxp, xoxa, xoxr, xoxs)
  /xox[bpars]-[A-Za-z0-9-]+/g,
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // PEM-armored private keys (any algorithm)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Number of distinct secret patterns currently in the redaction set.
 *
 * Exposed for `viberevert doctor` (which can show "redaction patterns: N" as
 * part of its environment report) and for tests that want to assert the
 * pattern set hasn't drifted unexpectedly.
 */
export const SECRET_PATTERN_COUNT = SECRET_PATTERNS.length;

/**
 * Returns a copy of `value` with any matching secret-like substring replaced
 * by `[REDACTED]`. Pure function — never throws, never mutates input.
 */
export function redact(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
