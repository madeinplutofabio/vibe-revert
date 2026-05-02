// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The set of built-in profile names known to the detector. Other profiles
 * (provided by future plugins, or chosen by the user via --profile) are not
 * detectable but are still accepted as values elsewhere in the CLI.
 */
export type KnownProfile =
  | "laravel"
  | "nextjs"
  | "python"
  | "rails"
  | "lovable";

/**
 * Resolution outcome of detectFramework.
 *   - "generic":   no built-in signatures matched.
 *   - "single":    exactly one built-in signature matched.
 *   - "ambiguous": two or more built-in signatures matched.
 */
export type Resolution = "generic" | "single" | "ambiguous";

export interface DetectionResult {
  /** All built-in profiles whose signatures matched, sorted alphabetically. */
  readonly matches: readonly KnownProfile[];
  /** How many matches were found, expressed as a categorical resolution. */
  readonly resolution: Resolution;
  /**
   * For "ambiguous" resolutions only: the profile that DISPLAY_PRIORITY would
   * suggest first. Provided for prompts/recommendations; never auto-applied
   * without user confirmation. Undefined for "single" and "generic".
   */
  readonly recommended?: KnownProfile;
}

/**
 * Display priority for ambiguous resolutions. Used only to order suggestions
 * shown to the user — never to silently pick a winner. The highest-priority
 * profile that appears in the matches set becomes `recommended`.
 */
const DISPLAY_PRIORITY: readonly KnownProfile[] = [
  "laravel",
  "rails",
  "nextjs",
  "python",
  "lovable",
];

// =============================================================================
// Per-profile signature checks (file-presence only — no content sniffing).
// Signatures are documented inline so future contributors know exactly what
// each detector requires.
// =============================================================================

function isFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Laravel: requires composer.json AND artisan (both regular files). */
function detectLaravel(root: string): boolean {
  return isFile(join(root, "composer.json")) && isFile(join(root, "artisan"));
}

/** Next.js: any of next.config.{js,ts,mjs,cjs} (regular file). */
function detectNextjs(root: string): boolean {
  return (
    isFile(join(root, "next.config.js")) ||
    isFile(join(root, "next.config.ts")) ||
    isFile(join(root, "next.config.mjs")) ||
    isFile(join(root, "next.config.cjs"))
  );
}

/** Python: any of pyproject.toml OR manage.py OR requirements.txt. */
function detectPython(root: string): boolean {
  return (
    isFile(join(root, "pyproject.toml")) ||
    isFile(join(root, "manage.py")) ||
    isFile(join(root, "requirements.txt"))
  );
}

/** Rails: requires Gemfile AND config/routes.rb (both regular files). */
function detectRails(root: string): boolean {
  return (
    isFile(join(root, "Gemfile")) && isFile(join(root, "config/routes.rb"))
  );
}

/**
 * Lovable: presence of a `.lovable/` directory. This is an early heuristic;
 * Lovable's repo conventions may evolve, and additional markers may be added
 * later.
 */
function detectLovable(root: string): boolean {
  return isDirectory(join(root, ".lovable"));
}

/** Detector registry. Order is irrelevant; results are sorted at the end. */
const DETECTORS: ReadonlyArray<{
  profile: KnownProfile;
  check: (root: string) => boolean;
}> = [
  { profile: "laravel", check: detectLaravel },
  { profile: "lovable", check: detectLovable },
  { profile: "nextjs", check: detectNextjs },
  { profile: "python", check: detectPython },
  { profile: "rails", check: detectRails },
];

/**
 * Detects which built-in framework profiles match the given repository root.
 *
 * Algorithm (locked in the M A plan):
 *   1. Run every signature check against `root`.
 *   2. Collect the matching profiles into a sorted-alphabetical set.
 *   3. Branch on the size of the set:
 *      - 0 matches → resolution "generic", no recommended.
 *      - 1 match  → resolution "single", no recommended.
 *      - 2+       → resolution "ambiguous", recommended = highest-priority
 *                   match per DISPLAY_PRIORITY.
 *
 * Pure function. Does not chdir, does not mutate process state.
 */
export function detectFramework(root: string): DetectionResult {
  const matches: KnownProfile[] = [];
  for (const { profile, check } of DETECTORS) {
    if (check(root)) matches.push(profile);
  }
  matches.sort();

  if (matches.length === 0) {
    return { matches: [], resolution: "generic" };
  }
  if (matches.length === 1) {
    return { matches, resolution: "single" };
  }

  const recommended = DISPLAY_PRIORITY.find((p) => matches.includes(p));
  if (recommended === undefined) {
    // Invariant: matches is non-empty and DISPLAY_PRIORITY contains every
    // KnownProfile. Reaching here means a new KnownProfile was added without
    // also being added to DISPLAY_PRIORITY.
    throw new Error(
      "detectFramework: internal invariant broken — matches non-empty but no DISPLAY_PRIORITY hit",
    );
  }
  return { matches, resolution: "ambiguous", recommended };
}
