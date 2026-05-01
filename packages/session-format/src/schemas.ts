// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// All persisted-artifact object schemas are STRICT (z.strictObject): unknown
// fields are rejected, not silently stripped. This prevents schema drift.
//
// Scalar string schemas are pure validators (no silent trimming). Trimming
// happens only in producer-side helpers like normalizeStringArray.

import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

// =============================================================================
// Path helpers
//
// All persisted relative paths in VibeRevert artifacts use forward slashes
// only and are canonical (no ".", no "..", no empty segments, no leading or
// trailing slash, not absolute, not UNC, not drive-letter-rooted).
//
// Two-function API:
//   - normalizeRelativePath: producer-side canonicalizer (representation only,
//     no semantic resolution; throws on any input that cannot be canonicalized
//     to a safe stored path).
//   - isSafeStoredRelativePath: schema-side predicate (no transformation,
//     returns true only if the input is already canonical).
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

const safeStoredRelativePath = z
  .string()
  .refine(isSafeStoredRelativePath, {
    message:
      "must be a canonical relative path: forward slashes only, no leading/trailing slash, no '.' or '..' segments, not absolute",
  });

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
 */
const nonBlankString = z.string().refine((s) => s.trim().length > 0, {
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
  return Array.from(
    new Set(input.map((s) => s.trim()).filter((s) => s.length > 0)),
  ).sort();
}

const sortedUniqueStringArray = z
  .array(nonBlankString)
  .refine(isSortedUniqueStringArray, {
    message:
      "must be sorted ascending, contain no duplicates, and contain no blank strings",
  });

// =============================================================================
// Enum atoms
// =============================================================================

export const RiskLevel = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const Confidence = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof Confidence>;

export const ChangedFileStatus = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "type_changed",
]);
export type ChangedFileStatus = z.infer<typeof ChangedFileStatus>;

// =============================================================================
// Evidence (strict)
//
// Refinement: if `line` is present, `file` must also be present.
// =============================================================================

export const Evidence = z
  .strictObject({
    detail: nonBlankString,
    file: safeStoredRelativePath.optional(),
    line: z.int().positive().optional(),
    command: nonBlankString.optional(),
  })
  .refine((e) => e.line === undefined || typeof e.file === "string", {
    message: "file is required when line is present",
    path: ["file"],
  });
export type Evidence = z.infer<typeof Evidence>;

// =============================================================================
// ChangedFile (strict)
//
// Refinements:
//   - status === "renamed" => previous_path required
//   - status !== "renamed" => previous_path must be absent
//   - previous_path (when present) must differ from path
// =============================================================================

export const ChangedFile = z
  .strictObject({
    path: safeStoredRelativePath,
    previous_path: safeStoredRelativePath.optional(),
    status: ChangedFileStatus,
    risk_tags: sortedUniqueStringArray,
    risk_level: RiskLevel,
  })
  .refine(
    (f) => f.status !== "renamed" || typeof f.previous_path === "string",
    {
      message: "previous_path is required when status is 'renamed'",
      path: ["previous_path"],
    },
  )
  .refine((f) => f.status === "renamed" || f.previous_path === undefined, {
    message: "previous_path must be absent when status is not 'renamed'",
    path: ["previous_path"],
  })
  .refine((f) => f.previous_path === undefined || f.previous_path !== f.path, {
    message: "previous_path must differ from path",
    path: ["previous_path"],
  });
export type ChangedFile = z.infer<typeof ChangedFile>;

// =============================================================================
// CheckResult (strict)
//
// Noise-budget rules:
//   - evidence array must be non-empty
//   - high/critical findings must include a recommendation
// =============================================================================

export const CheckResult = z
  .strictObject({
    id: nonBlankString,
    title: nonBlankString,
    level: RiskLevel,
    confidence: Confidence,
    category: nonBlankString,
    message: nonBlankString,
    evidence: z.array(Evidence).min(1),
    recommendation: nonBlankString.optional(),
  })
  .refine(
    (r) =>
      (r.level !== "high" && r.level !== "critical") ||
      typeof r.recommendation === "string",
    {
      message: "recommendation is required when level is 'high' or 'critical'",
      path: ["recommendation"],
    },
  );
export type CheckResult = z.infer<typeof CheckResult>;

// =============================================================================
// Manifest (strict; rollback contract)
//
// All path values are relative to the session directory root
// (.viberevert/sessions/<id>/). All hash values are SHA-256 (64-char hex).
// All timestamps are ISO 8601 with second precision and explicit offset.
// `git.porcelain_v1` may legitimately be the empty string (clean tree).
// =============================================================================

const FileHashMap = z.record(safeStoredRelativePath, z.hash("sha256"));

export const Manifest = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  session_id: nonBlankString,
  captured_at: z.iso.datetime({ offset: true, precision: 0 }),
  git: z.strictObject({
    head_sha: nonBlankString,
    branch: nonBlankString,
    porcelain_v1: z.string(),
  }),
  diffs: z.strictObject({
    unstaged_patch_path: safeStoredRelativePath,
    staged_patch_path: safeStoredRelativePath,
  }),
  snapshots: z.strictObject({
    tracked_dirty_archive_path: safeStoredRelativePath,
    file_hashes: FileHashMap,
  }),
  untracked: z.strictObject({
    archive_path: safeStoredRelativePath,
    file_hashes: FileHashMap,
  }),
  rollback_target_description: nonBlankString,
});
export type Manifest = z.infer<typeof Manifest>;

// =============================================================================
// SessionReport (strict; top-level session.json artifact)
// =============================================================================

export const SessionReport = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  session_id: nonBlankString,
  started_at: z.iso.datetime({ offset: true, precision: 0 }),
  ended_at: z.iso.datetime({ offset: true, precision: 0 }).optional(),
  agent_command: nonBlankString.optional(),
  detected_frameworks: sortedUniqueStringArray,
  task: nonBlankString.optional(),
  checkpoint_id: nonBlankString.optional(),
  risk_level: RiskLevel,
  changed_files: z.array(ChangedFile),
  results: z.array(CheckResult),
  rollback_available: z.boolean(),
  summary: nonBlankString.optional(),
});
export type SessionReport = z.infer<typeof SessionReport>;
