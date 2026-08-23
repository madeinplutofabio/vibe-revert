// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Shared validation atoms and producer-side normalizers for VibeRevert's
// persisted-artifact schemas.
//
// Extracted from schemas.ts (M 0.8.0 step 0) so the contribution, path-state,
// evaluation-snapshot, and rollback-attempt schema clusters can reuse the same
// atoms without schemas.ts absorbing all of them. Pure move: no behavior
// change, no renames.
//
// Module layout behind the package barrel is explicitly allowed to change
// without a major bump (see docs/session-format.md, "Stability and
// compatibility") -- the barrel is the stable surface, not this path.
//
// Exports fall into two groups:
//   - PUBLIC (re-exported by src/index.ts): isSafeStoredRelativePath,
//     normalizeRelativePath, normalizePathArray, isSortedUniqueStringArray,
//     normalizeStringArray.
//   - PACKAGE-INTERNAL (used by sibling schema modules, NOT barrel-exported):
//     nonBlankString, safeStoredRelativePath, sortedUniqueStringArray,
//     sortedUniquePathArray, gitObjectId, sha256ObjectRef.
//
// Scalar string schemas are pure validators (no silent trimming). Trimming
// happens only in producer-side helpers like normalizeStringArray; path
// helpers (normalizeRelativePath, normalizePathArray) deliberately do NOT
// trim, because pathnames with leading/trailing whitespace are legitimate
// filenames and silent rewriting at the manifest boundary would violate the
// trust-preserving principle that what we capture is what we restore.

import { z } from "zod";

// =============================================================================
// Path helpers
//
// All persisted relative paths in VibeRevert artifacts use forward slashes
// only and are canonical (no ".", no "..", no empty segments, no leading or
// trailing slash, not absolute, not UNC, not drive-letter-rooted).
//
// API:
//   - isSafeStoredRelativePath: schema-side predicate. No transformation;
//     returns true only if the input is already canonical.
//   - normalizeRelativePath: producer-side canonicalizer for a single path
//     (representation only, no semantic resolution; throws on any input that
//     cannot be canonicalized to a safe stored path).
//   - normalizePathArray: producer-side canonicalizer for an array of paths.
//     Maps each entry through normalizeRelativePath, dedupes via a Set, and
//     sorts ASCII-ascending. Distinct from normalizeStringArray, which is
//     wrong for paths because it trims: pathnames with leading/trailing
//     whitespace, while unusual, ARE legitimate filenames on most
//     filesystems, and silently rewriting them at the manifest boundary is
//     the opposite of trust-preserving.
// =============================================================================

const ABSOLUTE_DRIVE_LETTER = /^[a-zA-Z]:/;

/**
 * Schema-side predicate. Returns true iff `input` is a canonical, safe,
 * stored relative path. Performs no transformation.
 */
export function isSafeStoredRelativePath(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  if (input.includes("\\")) return false;
  if (input.startsWith("/")) return false;
  if (input.startsWith("//")) return false;
  if (ABSOLUTE_DRIVE_LETTER.test(input)) return false;
  const segments = input.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/**
 * Producer-side canonicalizer. Converts representational quirks (Windows
 * backslashes, leading "./", repeated "/") into the canonical form. Throws on
 * any input that cannot be made canonical without semantic resolution
 * (".." segments, absolute paths, etc.). Returns a string guaranteed to
 * satisfy isSafeStoredRelativePath().
 */
export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("normalizeRelativePath: input must be a non-empty string");
  }
  let p = input.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+/g, "/");
  if (!isSafeStoredRelativePath(p)) {
    throw new Error(`normalizeRelativePath: cannot canonicalize ${JSON.stringify(input)}`);
  }
  return p;
}

/**
 * Package-internal zod atom for a canonical stored relative path. Not
 * barrel-exported; sibling schema modules import it directly.
 */
export const safeStoredRelativePath = z.string().refine(isSafeStoredRelativePath, {
  message:
    "must be a canonical relative path: forward slashes only, no leading/trailing slash, no '.' or '..' segments, not absolute",
});

/**
 * Producer-side helper for arrays of relative paths. Maps each entry through
 * normalizeRelativePath (which throws on un-canonicalizable input), dedupes
 * via a Set, and sorts ASCII-ascending. Returns a string[] that satisfies
 * sortedUniquePathArray.
 *
 * Distinct from normalizeStringArray: that helper trims whitespace, which is
 * wrong for paths. Pathnames with leading/trailing whitespace, while unusual,
 * are legitimate filenames on most filesystems; trimming them at the manifest
 * boundary would silently rewrite the captured set and break the trust-
 * preserving principle that what we capture is what we restore.
 */
export function normalizePathArray(input: readonly string[]): string[] {
  return Array.from(new Set(input.map(normalizeRelativePath))).sort();
}

// =============================================================================
// String atom and string-array helpers
//
// nonBlankString is the default atom for required/optional human-meaningful
// scalar strings. It rejects both empty and whitespace-only strings. Use plain
// z.string() only where empty/whitespace is legitimately meaningful (e.g.,
// git.porcelain_v1 for a clean tree).
//
// Arrays like ChangedFile.risk_tags and SessionReport.detected_frameworks must
// be sorted ascending, unique, and contain no blank (empty or whitespace-only)
// strings in their persisted form. Producers call normalizeStringArray; the
// schema rejects non-canonical arrays.
// =============================================================================

/**
 * Default scalar string atom for VibeRevert persisted artifacts. Rejects empty
 * strings and whitespace-only strings. No transformation performed.
 *
 * Package-internal; not barrel-exported.
 */
export const nonBlankString = z.string().refine((s) => s.trim().length > 0, {
  message: "must not be empty or whitespace-only",
});

/**
 * Returns true iff `input` is sorted ASCII-ascending and contains no duplicates.
 */
export function isSortedUniqueStringArray(input: readonly string[]): boolean {
  for (let i = 1; i < input.length; i++) {
    const prev = input[i - 1];
    const curr = input[i];
    if (prev === undefined || curr === undefined) return false;
    if (curr <= prev) return false;
  }
  return true;
}

/**
 * Producer-side helper. Returns a new array that is trimmed, deduped, sorted
 * ASCII-ascending, with empty/whitespace-only entries dropped. Safe to call on
 * any string array; never throws.
 */
export function normalizeStringArray(input: readonly string[]): string[] {
  return Array.from(new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))).sort();
}

/**
 * Package-internal zod atom: sorted, deduped, blank-free string array.
 */
export const sortedUniqueStringArray = z.array(nonBlankString).refine(isSortedUniqueStringArray, {
  message: "must be sorted ascending, contain no duplicates, and contain no blank strings",
});

/**
 * Like `sortedUniqueStringArray` but with `safeStoredRelativePath` as the
 * element validator: each entry must be a canonical relative POSIX path
 * (forward slashes only, no leading/trailing slash, no '.' or '..' segments,
 * not absolute). Used by `Manifest.snapshots.tracked_dirty_paths`,
 * `RollbackFailure.affected_paths`, and
 * `ReceiptFile.forced_unrelated_dirty_paths`.
 *
 * The same lexicographic sorted-unique invariant as `sortedUniqueStringArray`
 * applies: producers MUST sort + dedupe (gitListTrackedDirty already does);
 * the schema rejects non-canonical arrays.
 *
 * Enforcing path canonicality here (not just ordering) protects A9 byte
 * stability of the persisted artifacts AND catches producer bugs that pass
 * non-canonical path strings.
 *
 * Package-internal; not barrel-exported.
 */
export const sortedUniquePathArray = z
  .array(safeStoredRelativePath)
  .refine(isSortedUniqueStringArray, {
    message:
      "must be sorted ascending, contain no duplicates, and contain only canonical relative POSIX paths",
  });

// =============================================================================
// Git and content-address atoms
//
// Shared by every schema cluster that references a Git object or a
// content-addressed blob, so the SAME validator governs
// SessionContributionFile.before_head_sha / after_head_sha,
// IndexState.entry.oid, UnmergedStage.oid, and every object reference in
// PathState. Defining these once removes the drift risk of each schema module
// re-deriving its own regex.
//
// Package-internal; not barrel-exported.
// =============================================================================

/**
 * A Git object id: 40 lowercase hex (SHA-1) or 64 lowercase hex (SHA-256
 * repositories, `git init --object-format=sha256`).
 *
 * Deliberately STRICTER than `Manifest.git.head_sha`, which is a plain
 * non-blank string. Object ids are a well-defined format and a truncated or
 * typo'd oid is a producer bug worth failing loudly on. The existing
 * `head_sha` looseness is left alone rather than tightened as a drive-by
 * change; the inconsistency is intentional and recorded here.
 *
 * A future Git object format is exactly the kind of change a contribution
 * schema-version bump should carry, not something to pre-accept here.
 */
export const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
  message: "must be a Git object id: 40 or 64 lowercase hex characters",
});

/**
 * A content-addressed object reference into `.viberevert/objects/`. Always a
 * SHA-256 of the referenced BYTES; the store derives the path from the hash
 * and verifies bytes against it on every read.
 *
 * Distinct from `gitObjectId`: this addresses VibeRevert's own object store,
 * not Git's. The two are never interchangeable even when both are 64 hex
 * characters, because a Git blob oid is computed over a header-prefixed
 * payload while this is a plain digest of the raw bytes.
 */
export const sha256ObjectRef = z.hash("sha256");
