// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Framework detection — D42 single source of truth for:
//   - `viberevert init` (M A): consumes the structured DetectionResult
//     for profile selection and the ambiguity-prompt path.
//   - `viberevert check` (M C): consumes the flat readonly string[] of
//     detected framework names to populate ctx.detectedFrameworks and
//     SessionReport.detected_frameworks.
//   - M 0.8.0 end-capture: derives `detected_frameworks_at_end` from a
//     captured observation set rather than from the live tree.
//
// This module was extracted from `packages/cli/src/detect.ts` to honor
// D42's "Single source of truth — no duplicate detector" lock. The CLI
// (M A's init) and the CLI's check command (M C) both import from here
// via the @viberevert/core barrel.
//
// ============================================================================
// Acquisition vs evaluation (M 0.8.0)
// ============================================================================
//
// The signature rules and the way they combine are ONE thing; how the
// filesystem facts are obtained is another. They are now separated:
//
//   PathProbe            answers isFile / isDirectory for one repo-relative
//                        POSIX path
//   DETECTORS            express every signature purely in terms of a probe
//   liveProbe            acquisition from the working tree, unchanged
//   observedProbe        acquisition from captured WorktreeStates
//
// Both acquisitions feed the SAME evaluator, so end-capture cannot grow a
// second detector that drifts from init's. That is D42 applied one level
// down: the rule was already centralized, and this keeps it centralized as
// a second caller appears.
//
// PathProbe carries the two predicates separately rather than a single
// tri-state classifier, because each signature must issue exactly the
// filesystem observations it issued before. Laravel asks only isFile,
// Lovable asks only isDirectory. A classifier that computed both up front
// would add observations that never happened, changing the live detector's
// race behavior even though its stable-tree answers would agree.
//
// **The two acquisitions are NOT equivalent for symlinks, deliberately.**
// Live isFile/isDirectory use `statSync`, which FOLLOWS symlinks, so a
// symlinked `composer.json` counts as a file, and that shipped behavior is
// unchanged. A captured `WorktreeState` records `symlink` as its own kind
// and carries only a digest of the target STRING, so an observed
// acquisition has nothing to resolve and answers false to both predicates.
// This asymmetry is forced by what each source can actually know, and it
// inherits the never-follow discipline the observation layer applies.
//
// **FRAMEWORK_OBSERVATION_PATHS is derived, not maintained, and enforced.**
// It is the sorted union of the paths each detector declares. A hand-written
// list beside the detectors would be exactly the drift D42 exists to
// prevent, one level down. `detectFrameworksFromObservedStates` validates
// the whole set is present BEFORE evaluating anything, so an incomplete
// capture raises rather than quietly reporting "framework not detected" and
// suppressing a framework the session introduced.
//
// Pure logic: file-presence signatures only (no content sniffing, no
// network, no process state mutation). Synchronous Node fs APIs under
// the hood; the async `detectFrameworks` surface is forward-looking in
// case future detectors need real I/O (e.g., parsing package.json).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { WorktreeState } from "@viberevert/session-format";

/**
 * The set of built-in profile names known to the detector. Other
 * profiles (provided by future plugins, or chosen by the user via
 * --profile) are not detectable but are still accepted as values
 * elsewhere in the CLI.
 */
export type KnownProfile = "laravel" | "nextjs" | "python" | "rails" | "lovable";

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
   * For "ambiguous" resolutions only: the profile that DISPLAY_PRIORITY
   * would suggest first. Provided for prompts/recommendations; never
   * auto-applied without user confirmation. Undefined for "single" and
   * "generic".
   */
  readonly recommended?: KnownProfile;
}

/**
 * Display priority for ambiguous resolutions. Used only to order
 * suggestions shown to the user — never to silently pick a winner. The
 * highest-priority profile that appears in the matches set becomes
 * `recommended`.
 */
const DISPLAY_PRIORITY: readonly KnownProfile[] = [
  "laravel",
  "rails",
  "nextjs",
  "python",
  "lovable",
];

// =============================================================================
// Acquisition
// =============================================================================

/**
 * What a signature is allowed to ask about one repo-relative POSIX path.
 *
 * Deliberately two independent predicates. See the header note on why this
 * is not a single tri-state classifier.
 */
type PathProbe = {
  readonly isFile: (relPath: string) => boolean;
  readonly isDirectory: (relPath: string) => boolean;
};

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

/**
 * Acquisition from the live working tree. Each predicate delegates
 * straight to the helper the signatures called before this split, over
 * the same `join(root, relPath)` argument, so the observations issued are
 * unchanged in kind, count, and order.
 */
function liveProbe(root: string): PathProbe {
  return {
    isFile: (relPath) => isFile(join(root, relPath)),
    isDirectory: (relPath) => isDirectory(join(root, relPath)),
  };
}

/**
 * Acquisition from captured worktree states.
 *
 * A path with no captured state THROWS rather than answering false. An
 * actually-absent path is already represented explicitly as
 * `{ kind: "absent" }`, so a missing map entry can only mean the caller
 * did not supply a required observation.
 *
 * This is defense in depth: `detectFrameworksFromObservedStates` has
 * already proven the whole observation set present before evaluation
 * begins, so reaching this throw means a future internal caller built a
 * probe without that check.
 *
 * `symlink` answers false to both predicates rather than following the
 * target. See the asymmetry note in this file's header.
 */
function observedProbe(states: ReadonlyMap<string, WorktreeState>): PathProbe {
  const kindOf = (relPath: string): WorktreeState["kind"] => {
    const state = states.get(relPath);
    if (state === undefined) {
      throw new Error(
        `detectFrameworksFromObservedStates: missing required observation for ${JSON.stringify(relPath)}`,
      );
    }
    return state.kind;
  };
  return {
    isFile: (relPath) => kindOf(relPath) === "regular",
    isDirectory: (relPath) => kindOf(relPath) === "directory",
  };
}

// =============================================================================
// Per-profile signature checks (file-presence only — no content sniffing).
// Signatures are documented inline so future contributors know exactly what
// each detector requires.
// =============================================================================

/** Laravel: requires composer.json AND artisan (both regular files). */
function detectLaravel(probe: PathProbe): boolean {
  return probe.isFile("composer.json") && probe.isFile("artisan");
}

/** Next.js: any of next.config.{js,ts,mjs,cjs} (regular file). */
function detectNextjs(probe: PathProbe): boolean {
  return (
    probe.isFile("next.config.js") ||
    probe.isFile("next.config.ts") ||
    probe.isFile("next.config.mjs") ||
    probe.isFile("next.config.cjs")
  );
}

/** Python: any of pyproject.toml OR manage.py OR requirements.txt. */
function detectPython(probe: PathProbe): boolean {
  return (
    probe.isFile("pyproject.toml") || probe.isFile("manage.py") || probe.isFile("requirements.txt")
  );
}

/** Rails: requires Gemfile AND config/routes.rb (both regular files). */
function detectRails(probe: PathProbe): boolean {
  return probe.isFile("Gemfile") && probe.isFile("config/routes.rb");
}

/**
 * Lovable: presence of a `.lovable/` directory. This is an early
 * heuristic; Lovable's repo conventions may evolve, and additional
 * markers may be added later.
 */
function detectLovable(probe: PathProbe): boolean {
  return probe.isDirectory(".lovable");
}

/**
 * Detector registry. Order is irrelevant; results are sorted at the end.
 *
 * `paths` declares every repo-relative path the entry's `check` may probe.
 * FRAMEWORK_OBSERVATION_PATHS is derived from these declarations, and a
 * test asserts no detector probes a path it did not declare.
 */
const DETECTORS: ReadonlyArray<{
  profile: KnownProfile;
  paths: readonly string[];
  check: (probe: PathProbe) => boolean;
}> = [
  { profile: "laravel", paths: ["composer.json", "artisan"], check: detectLaravel },
  { profile: "lovable", paths: [".lovable"], check: detectLovable },
  {
    profile: "nextjs",
    paths: ["next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs"],
    check: detectNextjs,
  },
  {
    profile: "python",
    paths: ["pyproject.toml", "manage.py", "requirements.txt"],
    check: detectPython,
  },
  { profile: "rails", paths: ["Gemfile", "config/routes.rb"], check: detectRails },
];

/**
 * Every repo-relative path any built-in signature inspects, sorted and
 * deduplicated.
 *
 * M 0.8.0 end-capture unions this with its candidate set so the signature
 * paths are observed exactly once, in the same coherent pass, whether or
 * not they also changed during the session.
 *
 * This is a hard input requirement of
 * `detectFrameworksFromObservedStates`, not advice: that function refuses
 * a states map missing any member.
 */
export const FRAMEWORK_OBSERVATION_PATHS: readonly string[] = [
  ...new Set(DETECTORS.flatMap((d) => d.paths)),
].sort();

// =============================================================================
// Evaluation
// =============================================================================

/** Run every signature against one acquisition. Sorted alphabetically. */
function evaluate(probe: PathProbe): KnownProfile[] {
  const matches: KnownProfile[] = [];
  for (const { profile, check } of DETECTORS) {
    if (check(probe)) matches.push(profile);
  }
  matches.sort();
  return matches;
}

/**
 * Detects which built-in framework profiles match the given repository
 * root. M A's `viberevert init` consumes the structured result for
 * profile selection and the ambiguity-prompt path.
 *
 * Algorithm (locked in the M A plan):
 *   1. Run every signature check against `root`.
 *   2. Collect the matching profiles into a sorted-alphabetical set.
 *   3. Branch on the size of the set:
 *      - 0 matches → resolution "generic", no recommended.
 *      - 1 match  → resolution "single", no recommended.
 *      - 2+       → resolution "ambiguous", recommended = highest-
 *                   priority match per DISPLAY_PRIORITY.
 *
 * Pure function. Does not chdir, does not mutate process state.
 */
export function detectFramework(root: string): DetectionResult {
  const matches = evaluate(liveProbe(root));

  if (matches.length === 0) {
    return { matches: [], resolution: "generic" };
  }
  if (matches.length === 1) {
    return { matches, resolution: "single" };
  }

  const recommended = DISPLAY_PRIORITY.find((p) => matches.includes(p));
  if (recommended === undefined) {
    // Invariant: matches is non-empty and DISPLAY_PRIORITY contains every
    // KnownProfile. Reaching here means a new KnownProfile was added
    // without also being added to DISPLAY_PRIORITY.
    throw new Error(
      "detectFramework: internal invariant broken — matches non-empty but no DISPLAY_PRIORITY hit",
    );
  }
  return { matches, resolution: "ambiguous", recommended };
}

/**
 * M C convenience surface for `viberevert check`. Returns the flat
 * list of detected framework names (sorted alphabetically, possibly
 * empty), discarding the structured Resolution/recommended fields that
 * only init.ts cares about.
 *
 * Per D42, this is the M C-side API into the SAME detection logic that
 * `viberevert init` uses — no duplicate detector. The Promise-returning
 * signature is forward-looking: today the implementation is sync
 * underneath (returns `Promise.resolve(...)`, NOT an async function, to
 * keep biome's useAwait rule happy), but future detectors that need to
 * read file content (e.g., parse package.json) can land here without
 * breaking callers.
 *
 * Used by:
 *   - the CLI's `check` command, to populate `ctx.detectedFrameworks`
 *     (handed into the @viberevert/checks engine) and
 *     `SessionReport.detected_frameworks` (audit field on the
 *     persisted report).
 */
export function detectFrameworks(repoRoot: string): Promise<readonly string[]> {
  return Promise.resolve(detectFramework(repoRoot).matches);
}

/**
 * M 0.8.0: the same signatures evaluated against CAPTURED worktree states
 * instead of the live tree.
 *
 * End-capture must derive `detected_frameworks_at_end` from the coherent
 * observation set it fenced, not from a fresh filesystem read that could
 * disagree with everything else the contribution asserts. Feeding those
 * states through the shared evaluator keeps the signature rules in one
 * place while changing only where the facts come from.
 *
 * Returns sorted, duplicate-free names, which is what the contribution's
 * `detected_frameworks_at_end` requires.
 *
 * **Refuses an incomplete observation map.** Every
 * FRAMEWORK_OBSERVATION_PATHS member must be present before any signature
 * is evaluated. Validating eagerly rather than on demand matters because
 * short-circuit evaluation would otherwise let a missing mandatory
 * observation through whenever an earlier predicate already decided the
 * signature, accepting evidence that does not meet the contract.
 * `{ kind: "absent" }` is the way to say a path is not there.
 *
 * Symlinked signature files do NOT match here even though they would
 * match `detectFramework`. See this file's header.
 */
export function detectFrameworksFromObservedStates(
  states: ReadonlyMap<string, WorktreeState>,
): readonly string[] {
  for (const path of FRAMEWORK_OBSERVATION_PATHS) {
    if (!states.has(path)) {
      throw new Error(
        `detectFrameworksFromObservedStates: missing required observation for ${JSON.stringify(path)}`,
      );
    }
  }
  return evaluate(observedProbe(states));
}

// =============================================================================
// Test-only exports (NOT in barrel; _*ForTests convention)
// =============================================================================

export const _detectorsForTests = DETECTORS;
