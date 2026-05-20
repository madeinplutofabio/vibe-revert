// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Shared path-separator normalization helper for the @viberevert/checks
// package.
//
// CONTEXT: every detector and classifier in this package needs to
// normalize incoming `file.path` values from `ChangedFileInput` to
// canonical POSIX form (forward slashes only) for TWO purposes:
//   1. Reliable glob matching (picomatch's `posixSlashes` option is
//      platform-dependent in practice — works on Windows but treats
//      `\` as a literal escape character on Linux — so explicit
//      normalization is the only OS-independent guarantee; see
//      ./classifiers/match.ts header for the full rationale).
//   2. Schema validation on emitted `evidence.file` values.
//      `safeStoredRelativePath` in @viberevert/session-format rejects
//      backslash separators; emitting raw backslashes fails the
//      engine's D28 layer-2 CheckResultSchema.parse step and throws a
//      ZodError that drops the entire detector output.
//
// Co-locating ONE helper here avoids the bug class where a detector
// normalizes for matching but forgets to normalize for emission, OR
// where multiple detectors duplicate the helper inline and one
// silently diverges. M C Step 4 (secrets detector) and the Step 4
// follow-up (path-classifier emission fix) both ran into the emission
// half of this bug; this helper is the durable convention preventing
// Steps 5-7 (dependency, migration, test-gap, scope-expansion
// detectors) from reintroducing it.

/**
 * Normalize path separators to POSIX form for check matching and emission.
 *
 * Important: this is separator normalization ONLY.
 * It does NOT sanitize, resolve, remove "." / "..", strip leading slashes,
 * or make unsafe paths acceptable. Schema validation
 * (`safeStoredRelativePath` in @viberevert/session-format) remains
 * responsible for rejecting non-canonical or unsafe paths.
 *
 * Fast-path: returns the input unchanged when no backslashes are present
 * (avoids allocating a new string in the common POSIX case).
 */
export function normalizePathSeparators(path: string): string {
  return path.includes("\\") ? path.replace(/\\/g, "/") : path;
}
