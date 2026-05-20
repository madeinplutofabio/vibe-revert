// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Dependency detector (M C Step 5 file 2). Pure synchronous Check
// implementation. Three D34-locked rules emit `dependencies`-category
// findings; the check's top-level Check.id is "dependencies" while
// each emitted CheckResult carries a per-rule id ("dependencies.<rule>")
// per D40's identity-based dedup convention.
//
// =============================================================================
// THREE RULES
// =============================================================================
//
//   1. dependencies.lockfile-without-manifest (medium, confidence: high)
//      A known lockfile basename is in the diff but its
//      SIBLING-DIRECTORY manifest is NOT. Suggests a silent
//      dependency override (lockfile regenerated outside the
//      manifest-driven workflow). Pairing is by SIBLING-DIRECTORY,
//      not repo-root: `apps/web/yarn.lock` pairs with
//      `apps/web/package.json`, never with root `package.json`.
//
//   2. dependencies.install-script (medium, confidence: medium)
//      addedLines of a known manifest contain a JSON key matching
//      an install-script lifecycle hook (preinstall/install/
//      postinstall/prepare for package.json; post-install-cmd/
//      post-update-cmd for composer.json). Line-grep with documented
//      FP risk per D34.
//
//   3. dependencies.new-dependencies (low, confidence: medium)
//      addedLines of a known manifest contain JSON string-string
//      entry shapes whose key is NOT in MANIFEST_NON_DEP_KEYS (a
//      small module-private denylist of well-known top-level non-
//      dependency keys, INCLUDING install-script lifecycle keys per
//      the cross-rule overlap note below). Consolidated to ONE
//      finding per manifest with up to MAX_NEW_DEPENDENCY_EVIDENCE
//      entries; the rest summarized in the message as "+N more added".
//
// =============================================================================
// TRANSITIVE MANIFEST/LOCKFILE EXCLUSION (enforced, not just documented)
// =============================================================================
// Paths containing a transitive-dependency directory segment anywhere
// in their path are EXCLUDED from all three rules AND from the rule-1
// pre-pass set. This enforces the package/workspace-level scope
// locked in dependency-constants.ts (Step 5 file 1) and prevents the
// detector from emitting findings for transitive dependencies' own
// manifests/lockfiles when a transitive tree is accidentally
// committed or appears in the diff.
//
// Locked TRANSITIVE_PATH_SEGMENTS set (covers the transitive roots
// for all 7 ecosystems in dependency-constants.ts's
// LOCKFILE_TO_MANIFEST map):
//   - `node_modules` — JS/TS transitive root
//                       (npm/pnpm/yarn install destination)
//   - `vendor`       — Composer transitive root (`composer install`);
//                       ALSO covers Ruby Bundler's `vendor/bundle/`
//                       AND Cargo's vendored-crates layout
//                       (`cargo vendor` destination)
//   - `.venv`        — Python virtualenv (PEP 405 / standard tooling
//                       AND Poetry default)
//   - `venv`         — Python virtualenv (common alternate location;
//                       included for parity with `.venv`)
//
// Segment-based matching (split-on-`/`) rather than substring matching
// avoids false-positives on literal paths like
// `apps/node_modules-test/package.json` or `apps/vendor-config/...`
// (unusual but valid first-party directories whose names happen to
// contain the substring of a transitive segment).
//
// LOCKED EXTENSION POLICY: adding a new ecosystem to
// LOCKFILE_TO_MANIFEST / INSTALL_SCRIPT_KEYS / DEPENDENCY_SECTION_KEYS
// in dependency-constants.ts MUST be accompanied by adding its
// transitive-root segment(s) to TRANSITIVE_PATH_SEGMENTS here AND by
// extending the unit tests in dependencies.test.ts to cover BOTH the
// positive (rule fires for first-party manifests) AND the transitive-
// exclusion negative (rule skips under the new segment). The three
// changes belong in the same commit so the scope claim stays honest.
//
// Accepted trade-off: a deliberately-placed first-party manifest
// under one of these transitive paths (e.g., `vendor/my-internal-lib/
// package.json` for a vendored-first-party-library workflow) is
// silently skipped by the detector. Documented; users wanting such
// paths scanned should put first-party packages outside these
// segments.
//
// =============================================================================
// REDACTION SAFETY: VERSION STRINGS ARE NEVER EMITTED
// =============================================================================
// Dependency version strings can contain credentials or sensitive
// URLs: git+ssh URLs with auth tokens, tarball URLs with embedded
// API keys, private registry URLs with credentials. Emitting them
// into `evidence.detail` would propagate them to the persisted
// report.json, terminal output, JSON output, and markdown output —
// reintroducing the secrets-leak class that the secrets detector's
// D40 redaction-safety rule is supposed to prevent.
//
// The new-dependency rule (rule 3) uses the version string ONLY
// internally (to confirm the line matches the JSON string-string
// entry shape via a non-capturing group). The version is NEVER
// stored in CandidateDep and NEVER emitted in any finding field.
// Evidence detail carries the dependency NAME only:
//   detail: "new-dependency: lodash"     ✓
//   detail: "new-dependency: lodash@^4"  ✗ (version leak)
//
// =============================================================================
// SECTION TRACKING: DELIBERATELY OMITTED FOR M C
// =============================================================================
// A "proper" new-dependency detector would track whether each added
// line falls inside a `"dependencies"` / `"devDependencies"` /
// `"peerDependencies"` section by following JSON brace context. The
// detector here does NOT do this. Two reasons:
//
//   1. D34 LOCK: "the diff-line grep is intentionally simple (line-
//      based key match)". AST parsing or precise brace-context
//      tracking is explicitly deferred to a v0.8.x+ supply-chain
//      milestone.
//
//   2. PRACTICAL: ChangedFileInput.addedLines is sparse (only added
//      lines, no context lines from the surrounding hunk). The common
//      case of "developer adds a single new dep to an existing
//      `dependencies` block" produces a diff where ONLY the new entry
//      is added — the `"dependencies": {` opener was a context line
//      and is NOT in addedLines. Section tracking would miss the
//      most common real-world case.
//
// Trade-off: false positives possible when a non-dependency string-
// string entry has a key not covered by MANIFEST_NON_DEP_KEYS. The
// trade-off is locked: precision is sacrificed for M C scope;
// supply-chain analysis lands in a later milestone.
//
// =============================================================================
// MODULE-LOAD INVARIANT (defense in depth)
// =============================================================================
// At import time the module asserts that every manifest basename
// declared in INSTALL_SCRIPT_KEYS or DEPENDENCY_SECTION_KEYS also has
// a MANIFEST_NON_DEP_KEYS entry. Otherwise the new-dependency rule
// would emit pure pattern-matched findings (no denylist filter) for
// that manifest type. The invariant doesn't prove the denylist is
// COMPLETE for each manifest type — it just guarantees the rule has
// SOME denylist to fall back on. A missing denylist throws at the
// first import of this module, surfacing the bug before any check
// runs.

import { normalizePathSeparators } from "../path-normalization.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import {
  DEPENDENCY_SECTION_KEYS,
  INSTALL_SCRIPT_KEYS,
  LOCKFILE_TO_MANIFEST,
  MAX_NEW_DEPENDENCY_EVIDENCE,
} from "./dependency-constants.js";

// =============================================================================
// Transitive-path segment set (module-private)
// =============================================================================

/**
 * Locked set of directory segments that mark a path as transitive
 * (NOT first-party). All three detector rules and the rule-1 pre-pass
 * skip any path containing ANY of these segments anywhere in its
 * `/`-delimited components.
 *
 * Locked entries for v0.7.0-beta, covering the transitive roots for
 * all 7 ecosystems in dependency-constants.ts's LOCKFILE_TO_MANIFEST:
 *   - `node_modules` — JS/TS (npm/pnpm/yarn)
 *   - `vendor`       — Composer (PHP), Bundler (Ruby; `vendor/bundle/`),
 *                       Cargo (Rust; `cargo vendor` layout)
 *   - `.venv`        — Python virtualenv (Poetry default, PEP 405)
 *   - `venv`         — Python virtualenv (common alternate location)
 *
 * See file-header "TRANSITIVE MANIFEST/LOCKFILE EXCLUSION" block for
 * the segment-vs-substring rationale, accepted trade-offs, and the
 * locked extension policy (any new ecosystem in
 * dependency-constants.ts must extend this set AND its tests in the
 * same commit).
 *
 * Module-private (not exported from the package barrel) — adding an
 * entry here doesn't change the dependency detector's contract, just
 * its scope-enforcement coverage.
 */
const TRANSITIVE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  "vendor",
  ".venv",
  "venv",
]);

// =============================================================================
// Module-private denylist for new-dependency rule
// =============================================================================

/**
 * Well-known non-dependency keys per manifest type. The new-dependency
 * rule skips added lines whose JSON key is in this set, reducing the
 * most common false positives without requiring brace-context
 * tracking.
 *
 * LOCKED INCLUSIONS:
 *   - Common top-level metadata keys (name, version, description,
 *     license, etc.) — filters the most-common per-line false
 *     positives in manifest top-level adds.
 *   - INSTALL-SCRIPT LIFECYCLE KEYS (preinstall, install, postinstall,
 *     prepare for package.json; post-install-cmd, post-update-cmd
 *     for composer.json). These match the JSON string-string entry
 *     shape AND are also picked up by rule 2 (install-script
 *     detection). Without their inclusion in this denylist, the SAME
 *     added line (e.g., `"postinstall": "node build.js"`) would emit
 *     BOTH an install-script finding (rule 2) AND a new-dependency
 *     finding (rule 3) with name="postinstall" — duplicate,
 *     misleading, AND would emit the script body as a "version
 *     string" if the version-emission discipline weren't separately
 *     enforced.
 *
 *     Trade-off: a real npm package named "install" (low-profile)
 *     would not be detected as a new dependency. Documented; the
 *     install-script lifecycle-hook semantics dominate the real-
 *     name overlap risk in practice.
 *
 * The denylist is INTENTIONALLY incomplete — D34's "intentionally
 * simple" lock applies. Adding less-common keys (e.g., framework-
 * specific configuration keys like `"prettier"`, `"eslintConfig"`,
 * `"jest"`) is deferred until real-world false positives demonstrate
 * the need.
 *
 * Module-private (not exported from the package barrel) because it's
 * implementation detail of THIS detector's filtering — adding new
 * keys here doesn't change the dependency detector's contract, just
 * its precision.
 */
const MANIFEST_NON_DEP_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  "package.json": new Set([
    // Common top-level metadata
    "name",
    "version",
    "description",
    "main",
    "module",
    "type",
    "types",
    "license",
    "author",
    "homepage",
    "repository",
    "bugs",
    "keywords",
    "scripts",
    "engines",
    "files",
    "private",
    "workspaces",
    "exports",
    "imports",
    "sideEffects",
    "packageManager",
    "browserslist",
    // Install-script lifecycle keys (overlap with rule 2; see JSDoc
    // above for the cross-rule rationale).
    "preinstall",
    "install",
    "postinstall",
    "prepare",
  ]),
  "composer.json": new Set([
    // Common top-level metadata
    "name",
    "description",
    "type",
    "keywords",
    "homepage",
    "readme",
    "license",
    "authors",
    "support",
    "funding",
    "autoload",
    "autoload-dev",
    "scripts",
    "archive",
    "abandoned",
    "minimum-stability",
    "prefer-stable",
    "repositories",
    "config",
    "extra",
    "bin",
    // Install-script lifecycle keys (overlap with rule 2; see JSDoc
    // above for the cross-rule rationale).
    "post-install-cmd",
    "post-update-cmd",
  ]),
};

// =============================================================================
// Module-load invariant
// =============================================================================

const KNOWN_MANIFESTS_WITHOUT_DENYLIST: readonly string[] = Array.from(
  new Set([...Object.keys(INSTALL_SCRIPT_KEYS), ...Object.keys(DEPENDENCY_SECTION_KEYS)]),
)
  .filter((basename) => MANIFEST_NON_DEP_KEYS[basename] === undefined)
  .sort();

if (KNOWN_MANIFESTS_WITHOUT_DENYLIST.length > 0) {
  throw new Error(
    `dependencies detector: manifest types declared in install-script or dependency-section maps lack a MANIFEST_NON_DEP_KEYS entry: ${KNOWN_MANIFESTS_WITHOUT_DENYLIST.join(", ")}`,
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Split a POSIX path into (dir, basename). The path is assumed to be
 * already normalized (callers pass `normalizePathSeparators(file.path)`).
 *
 *   "package.json"            → { dir: "",         basename: "package.json" }
 *   "apps/web/package.json"   → { dir: "apps/web", basename: "package.json" }
 *
 * No `node:path` import per D29/D48. The single split-on-last-slash
 * is sufficient for all repo-relative POSIX paths.
 */
function splitPath(path: string): { dir: string; basename: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { dir: "", basename: path }
    : { dir: path.slice(0, idx), basename: path.slice(idx + 1) };
}

/**
 * Build a `dir + basename` POSIX path. Empty dir produces just the basename.
 */
function joinPath(dir: string, basename: string): string {
  return dir === "" ? basename : `${dir}/${basename}`;
}

/**
 * Escape RegExp metacharacters in a literal string so it can be embedded
 * in a dynamic RegExp constructor (used by INSTALL_SCRIPT_PATTERNS_BY_MANIFEST
 * below).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns true if the path contains ANY segment in
 * TRANSITIVE_PATH_SEGMENTS as a full `/`-delimited component. All
 * three detector rules and the rule-1 pre-pass skip these paths to
 * enforce the package/workspace-level scope locked in
 * dependency-constants.ts.
 *
 * Segment-based (`.split("/").some(...)`) rather than substring match
 * so a literal path like `apps/node_modules-test/package.json` or
 * `apps/vendor-config/...` (unusual but valid first-party directories)
 * does NOT match. See the file-header "TRANSITIVE MANIFEST/LOCKFILE
 * EXCLUSION" block for the full rationale.
 */
function isTransitiveManifestOrLockfilePath(path: string): boolean {
  return path.split("/").some((segment) => TRANSITIVE_PATH_SEGMENTS.has(segment));
}

// =============================================================================
// Pre-compiled patterns
// =============================================================================

/**
 * Per-manifest install-script-key matcher patterns, compiled ONCE at
 * module load. Each map entry is `basename → Map<key, RegExp>`. The
 * regex tests for the JSON property-name shape `"<key>":` (optional
 * whitespace around the colon).
 *
 * Pre-compilation avoids reconstructing the RegExp on every per-line
 * per-key match attempt in rule 2's hot loop. RegExps without the /g
 * flag are stateless under .test(), so sharing across invocations is
 * safe (no clone-first discipline required — contrast with the
 * SECRET_PATTERNS clone-first pattern in detectors/secrets.ts which
 * does carry /g).
 */
const INSTALL_SCRIPT_PATTERNS_BY_MANIFEST: Readonly<Record<string, ReadonlyMap<string, RegExp>>> =
  (() => {
    const result: Record<string, Map<string, RegExp>> = {};
    for (const [basename, keys] of Object.entries(INSTALL_SCRIPT_KEYS)) {
      const map = new Map<string, RegExp>();
      for (const key of keys) {
        map.set(key, new RegExp(`"${escapeRegExp(key)}"\\s*:`));
      }
      result[basename] = map;
    }
    return result;
  })();

/**
 * Pattern for a JSON string-string entry (e.g., `"lodash": "^4.0.0"`).
 * Only the KEY is captured (group 1); the value-string structure is
 * verified by the trailing `"[^"]+"` non-capturing block but the
 * value content is NOT extracted. This is the REDACTION SAFETY
 * mechanism — the version string is verified-but-discarded so it
 * cannot leak into any emitted finding field. See the file-header
 * "REDACTION SAFETY" block for the full rationale.
 *
 * Anchored to the start of the line (with leading whitespace) so
 * multi-entry lines don't double-match.
 *
 * Limited to string-string entries because dependency-section values
 * are always strings in both package.json and composer.json. Object-
 * valued entries (rare; would be a deeply-nested configuration error
 * inside a dep section) are silently skipped.
 *
 * No /g flag — used with .exec() (single-match) per line, stateless
 * across calls.
 */
const JSON_STRING_ENTRY_PATTERN = /^\s*"([^"]+)"\s*:\s*"[^"]+"/;

// =============================================================================
// Locked recommendation strings
// =============================================================================

/**
 * Recommendation text for lockfile-without-manifest findings. M B's
 * CheckResultSchema does NOT require recommendation on medium
 * findings (only high/critical), but including it keeps the emission
 * shape uniform and gives the user actionable next steps.
 */
const LOCKFILE_RECOMMENDATION =
  "Review the lockfile diff and confirm no unexpected dependency upgrades or substitutions. " +
  "Re-run `npm install` / `pnpm install` / equivalent locally and re-commit the lockfile if drift is unintentional.";

/**
 * Recommendation text for install-script findings.
 */
const INSTALL_SCRIPT_RECOMMENDATION =
  "Install scripts execute on every consumer machine that runs `npm install` (or equivalent). " +
  "Verify the script body is intentional and doesn't shell out to untrusted commands, network calls, or filesystem writes.";

// =============================================================================
// The dependencies check
// =============================================================================

/**
 * The dependency check. Single-category (`dependencies`) toggleable
 * via `checks.dependencies` in `.viberevert.yml`. Emits findings under
 * three distinct per-rule ids per D40's identity-based dedup
 * convention. Pure synchronous, no I/O, no async per D29/D48.
 *
 * Transitive manifest/lockfile paths (anything under a transitive
 * directory listed in TRANSITIVE_PATH_SEGMENTS) are skipped at every
 * rule's entry per the file-header "TRANSITIVE MANIFEST/LOCKFILE
 * EXCLUSION" lock.
 */
export const dependenciesCheck: Check = {
  id: "dependencies",
  category: "dependencies",
  run: (ctx: CheckContext): readonly CheckResult[] => {
    const results: CheckResult[] = [];

    // Pre-pass: build a normalized-path Set for sibling-pairing
    // lookups in rule 1. O(N) up-front avoids O(N²) per-lockfile
    // scans when the diff is large. Transitive paths are excluded
    // here so a transitive lockfile's sibling-lookup against the
    // first-party diff cannot accidentally match a first-party
    // manifest (or vice-versa); rule 1 itself also re-checks
    // (defense-in-depth) but the pre-pass exclusion keeps the
    // candidate set conceptually clean.
    const normalizedPathsInDiff = new Set<string>();
    for (const file of ctx.changedFiles) {
      const normalized = normalizePathSeparators(file.path);
      if (isTransitiveManifestOrLockfilePath(normalized)) continue;
      normalizedPathsInDiff.add(normalized);
    }

    // -------------------------------------------------------------------
    // Rule 1: dependencies.lockfile-without-manifest
    // -------------------------------------------------------------------
    for (const file of ctx.changedFiles) {
      const normalized = normalizePathSeparators(file.path);
      if (isTransitiveManifestOrLockfilePath(normalized)) continue;
      const { dir, basename } = splitPath(normalized);
      const expectedManifestBasename = LOCKFILE_TO_MANIFEST[basename];
      if (expectedManifestBasename === undefined) continue;

      const expectedManifestPath = joinPath(dir, expectedManifestBasename);
      if (normalizedPathsInDiff.has(expectedManifestPath)) continue;

      results.push({
        id: "dependencies.lockfile-without-manifest",
        category: "dependencies",
        level: "medium",
        confidence: "high",
        title: "Lockfile changed without manifest change",
        message: `Lockfile '${normalized}' changed but sibling manifest '${expectedManifestPath}' did not. Possible silent dependency override.`,
        evidence: [
          {
            file: normalized,
            detail: `lockfile-without-manifest: expected sibling ${expectedManifestPath}`,
          },
        ],
        recommendation: LOCKFILE_RECOMMENDATION,
      });
    }

    // -------------------------------------------------------------------
    // Rule 2: dependencies.install-script
    // -------------------------------------------------------------------
    for (const file of ctx.changedFiles) {
      if (file.isBinary || file.addedLines.length === 0) continue;
      const normalized = normalizePathSeparators(file.path);
      if (isTransitiveManifestOrLockfilePath(normalized)) continue;
      const { basename } = splitPath(normalized);
      const patterns = INSTALL_SCRIPT_PATTERNS_BY_MANIFEST[basename];
      if (patterns === undefined) continue;

      // Per-key occurrence counter — keeps D40 dedup tuples distinct
      // when the same hook key is added multiple times on different
      // lines (rare but possible if a refactor re-keys multiple
      // package.json entries simultaneously).
      const occurrenceCounter = new Map<string, number>();

      for (const addedLine of file.addedLines) {
        for (const [key, pattern] of patterns) {
          if (!pattern.test(addedLine.text)) continue;
          const n = (occurrenceCounter.get(key) ?? 0) + 1;
          occurrenceCounter.set(key, n);
          results.push({
            id: "dependencies.install-script",
            category: "dependencies",
            level: "medium",
            confidence: "medium",
            title: "Install script added",
            message: `Install/lifecycle script '${key}' added to ${normalized}:${addedLine.line}`,
            evidence: [
              {
                file: normalized,
                line: addedLine.line,
                detail: `install-script: ${key} [occurrence ${n}]`,
              },
            ],
            recommendation: INSTALL_SCRIPT_RECOMMENDATION,
          });
        }
      }
    }

    // -------------------------------------------------------------------
    // Rule 3: dependencies.new-dependencies (per-manifest consolidated)
    // -------------------------------------------------------------------
    for (const file of ctx.changedFiles) {
      if (file.isBinary || file.addedLines.length === 0) continue;
      const normalized = normalizePathSeparators(file.path);
      if (isTransitiveManifestOrLockfilePath(normalized)) continue;
      const { basename } = splitPath(normalized);
      const sectionKeys = DEPENDENCY_SECTION_KEYS[basename];
      if (sectionKeys === undefined) continue;

      // Module-load invariant guarantees denylist is defined for every
      // basename in DEPENDENCY_SECTION_KEYS. The `?? new Set()` is
      // belt-and-suspenders against future edits that might bypass
      // the invariant.
      const denylist = MANIFEST_NON_DEP_KEYS[basename] ?? new Set<string>();

      // Collect candidate dependency adds, preserving line order.
      // CandidateDep deliberately does NOT carry the version string —
      // see the file-header REDACTION SAFETY block. The regex verifies
      // the line is a string-string entry shape (via the non-capturing
      // tail `"[^"]+"`) but only captures and stores the KEY.
      interface CandidateDep {
        readonly name: string;
        readonly line: number;
      }
      const newDeps: CandidateDep[] = [];
      for (const addedLine of file.addedLines) {
        const match = JSON_STRING_ENTRY_PATTERN.exec(addedLine.text);
        if (match === null) continue;
        const name = match[1];
        if (name === undefined) continue; // defensive
        if (denylist.has(name)) continue;
        newDeps.push({ name, line: addedLine.line });
      }

      if (newDeps.length === 0) continue;

      // Consolidate to ONE finding per manifest, capped at
      // MAX_NEW_DEPENDENCY_EVIDENCE entries. Remaining count
      // surfaces in the message tail.
      //
      // Evidence detail carries the dependency NAME only — version
      // strings are NEVER persisted (REDACTION SAFETY lock).
      const evidenceCount = Math.min(newDeps.length, MAX_NEW_DEPENDENCY_EVIDENCE);
      const evidence = newDeps.slice(0, evidenceCount).map((dep) => ({
        file: normalized,
        line: dep.line,
        detail: `new-dependency: ${dep.name}`,
      }));

      const overflow = newDeps.length - evidenceCount;
      const overflowSuffix = overflow > 0 ? ` (+${overflow} more added)` : "";
      const countWord = newDeps.length === 1 ? "dependency" : "dependencies";

      results.push({
        id: "dependencies.new-dependencies",
        category: "dependencies",
        level: "low",
        confidence: "medium",
        title: "New dependencies added",
        message: `${newDeps.length} new ${countWord} added to ${normalized}${overflowSuffix}`,
        evidence,
      });
    }

    return results;
  },
};
