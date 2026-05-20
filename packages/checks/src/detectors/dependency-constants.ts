// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Data layer for the dependency detector (M C Step 5 file 1).
//
// Three D34-locked rules consume the constants here:
//
//   1. LOCKFILE-WITHOUT-MANIFEST: lockfile in diff, paired manifest NOT
//      in diff → emit medium finding. Pairing is by SIBLING-DIRECTORY:
//      same directory must contain both, otherwise the pairing is
//      ambiguous in monorepos with multiple manifests. The 7 locked
//      pairs are in LOCKFILE_TO_MANIFEST below.
//
//   2. INSTALL-SCRIPT: addedLines of a known manifest matching one of
//      the locked install-script JSON keys → emit medium finding per
//      detected hook. The detector scans line-by-line; AST parsing is
//      explicitly deferred per D34's "diff-line grep is intentionally
//      simple" lock.
//
//   3. NEW-DEPENDENCY: addedLines of a known manifest matching a JSON
//      string-string entry shape under a dependency section → emit ONE
//      consolidated low finding PER MANIFEST FILE (locked
//      interpretation of D34's "per manifest" wording — a diff
//      touching both `package.json` and `apps/web/package.json` emits
//      TWO findings, one per file path, NOT one for "all package.json
//      changes combined"). Up to MAX_NEW_DEPENDENCY_EVIDENCE entries
//      per finding, summarizing the rest as "+N more added" in the
//      message. Per-manifest consolidation happens INSIDE the detector
//      so D40's clustering pipeline never sees the unconsolidated set.
//
// D34 scope locks (re-emphasized):
//   - Scoped to package/workspace-level manifests only. Transitive
//     manifests such as node_modules/<dep>/package.json are NOT scanned
//     (deferred to a v0.8.x+ supply-chain milestone).
//   - No online lookups (per dependency-boundary.json's
//     `requiresReview` rule — M C is local-only deterministic).
//   - Line-based grep with documented false-positive risk (e.g. a
//     `"vite-plugin-install"` JSON key on its own line could trip the
//     install-script pattern). The trade-off is locked: precision is
//     sacrificed for M C scope; supply-chain analysis lands in a later
//     milestone.

/**
 * Lockfile basename → expected sibling-manifest basename. Pairing is
 * by sibling directory in the diff:
 *
 *   - `apps/web/yarn.lock` pairs with `apps/web/package.json`
 *   - `services/api/Gemfile.lock` pairs with `services/api/Gemfile`
 *
 * A diff that touches the lockfile but NOT the sibling manifest fires
 * the lockfile-without-manifest rule (D34 #1, medium finding). The
 * pairing direction is one-way: a diff that touches the manifest but
 * NOT the lockfile does NOT fire — that's a normal "edited dep list,
 * lockfile regenerated later" workflow, not a suspicious case.
 *
 * Locked 7-pair set per D34. Adding a new ecosystem requires extending
 * this map AND adding a unit test exercising the pair.
 */
export const LOCKFILE_TO_MANIFEST: Readonly<Record<string, string>> = {
  "package-lock.json": "package.json",
  "pnpm-lock.yaml": "package.json",
  "yarn.lock": "package.json",
  "composer.lock": "composer.json",
  "Gemfile.lock": "Gemfile",
  "poetry.lock": "pyproject.toml",
  "Cargo.lock": "Cargo.toml",
};

/**
 * Install/lifecycle script JSON keys per manifest type. Matched on
 * addedLines via the `"<key>":` pattern (D34's line-based grep —
 * AST-based section detection deferred). False positives possible
 * if the same string appears outside a `scripts` block; documented
 * in packages/checks/README.md.
 *
 * package.json install scripts run during `npm/pnpm/yarn install`:
 *   preinstall, install, postinstall, prepare.
 *
 * composer.json:
 *   post-install-cmd (after `composer install`),
 *   post-update-cmd (after `composer update`).
 *
 * NOT included: `prepublish`, `prepublishOnly`, `prepack`, `postpack`
 * — those run during PUBLISH, not install, and aren't a vector for
 * silent code execution on a consumer's machine. Adding them is a
 * separate locked decision if the scope ever broadens.
 */
export const INSTALL_SCRIPT_KEYS: Readonly<Record<string, readonly string[]>> = {
  "package.json": ["preinstall", "install", "postinstall", "prepare"],
  "composer.json": ["post-install-cmd", "post-update-cmd"],
};

/**
 * Dependency-section keys per manifest type. The new-dependency rule
 * (D34 #3) treats addedLines inside one of these sections as candidate
 * dependency additions.
 *
 * Locked simplification: the detector's section identification is
 * line-grep-based, NOT AST-based. A `"dependencies": {` marker line
 * in addedLines opens the section; a closing brace line returns to
 * out-of-section state. In the common case of "only new entries
 * added, section opener/closer unchanged", the section marker may
 * not appear in addedLines at all — the detector then falls back to
 * a pattern-only match (any `"<name>": "<version>"` shape in a
 * manifest is treated as a candidate). False positives are accepted
 * per D34's scope lock.
 *
 * package.json sections:
 *   dependencies, devDependencies, peerDependencies.
 *   (NOT bundledDependencies, optionalDependencies — those are
 *   v0.8.x+ supply-chain analysis.)
 *
 * composer.json sections:
 *   require, require-dev.
 *   (NOT autoload, suggest, replace, provide, conflict — those are
 *   different concerns.)
 */
export const DEPENDENCY_SECTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  "package.json": ["dependencies", "devDependencies", "peerDependencies"],
  "composer.json": ["require", "require-dev"],
};

/**
 * D34-locked cap on per-manifest new-dependency evidence entries.
 * The detector consolidates ALL detected new dependencies for a single
 * manifest into ONE finding with up to this many name+version evidence
 * entries; remaining entries are counted in the message tail as
 * "+N more added".
 *
 * Locked at 5 for v0.7.0-beta (closed Open Question #4 in the M C
 * plan). Bumping this requires a new locked decision.
 *
 * Enforcing the cap INSIDE the detector (rather than letting D40's
 * clustering pipeline absorb it) prevents two failure modes:
 *   - Wasted engine cycles: producing N findings per manifest that
 *     immediately get clustered away.
 *   - Spurious cluster summaries: a `cluster.dependencies-tail`
 *     summary triggered by a single 6-dep change would mislead a
 *     reviewer into thinking multiple risky manifests changed.
 */
export const MAX_NEW_DEPENDENCY_EVIDENCE = 5 as const;
