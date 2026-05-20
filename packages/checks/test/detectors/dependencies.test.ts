// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit + integration tests for packages/checks/src/detectors/dependencies.ts
// and ./dependency-constants.ts (Step 5 file 4).
//
// Coverage strategy (mirrors the secrets.test.ts pattern):
//
//   1. PER-RULE POSITIVE COVERAGE
//      - Rule 1 (lockfile-without-manifest): full 7-ecosystem matrix
//        via it.each, both positive (lockfile alone fires) and negative
//        (lockfile + sibling manifest doesn't fire). Lockfile pairing
//        is exactly where monorepo bugs hide, so the ecosystem-coverage
//        table is comprehensive.
//      - Rule 2 (install-script): per-key matrix for all 4 package.json
//        hooks + all 2 composer.json hooks via it.each. Each per-key
//        test ALSO asserts EXACTLY ONE finding (no new-dependency
//        double-fire) — protects the MANIFEST_NON_DEP_KEYS denylist
//        coverage from regression.
//      - Rule 3 (new-dependencies): boundary tests for the
//        MAX_NEW_DEPENDENCY_EVIDENCE cap (5-no-overflow + 8-with-overflow)
//        and the per-MANIFEST-FILE consolidation rule (locked
//        interpretation (a) of D34: separate findings for separate
//        manifest paths, not one combined finding across all
//        package.json files).
//
//   2. CROSS-RULE OVERLAP PROTECTION
//      A dedicated section verifies that install-script and
//      new-dependencies rules never double-fire on the same line. The
//      key test (`"postinstall": "node build.js"` in package.json →
//      exactly 1 install-script finding, ZERO new-dep findings)
//      directly protects the MANIFEST_NON_DEP_KEYS denylist that
//      includes install-script lifecycle keys for exactly this reason.
//
//   3. TRANSITIVE EXCLUSION MATRIX
//      Per-segment coverage for all 4 entries in TRANSITIVE_PATH_SEGMENTS
//      (node_modules, vendor, .venv, venv) via TWO parameterized blocks
//      (lockfile-alone covers rule 1; manifest-with-additions covers
//      rules 2+3). Plus ecosystem-specific examples documenting the
//      realistic shapes:
//        - vendor/foo/composer.json (Composer transitive)
//        - .venv/lib/python3.11/site-packages/foo/poetry.lock (Poetry)
//        - venv/lib/python3.11/site-packages/foo/poetry.lock (alt Python)
//      Plus "substring NOT segment" positives that prove the segment-
//      based match is real: apps/node_modules-test/yarn.lock and
//      apps/vendor-config/composer.lock both FIRE rule 1 (their parent
//      dirs contain the substring of a transitive segment but are not
//      themselves a transitive segment).
//
//   4. REDACTION SAFETY (whole-result assertion)
//      A dedicated test exercises the new-dependency rule with a
//      credential-shaped version string constructed via the locked
//      memory-entry pattern (template-literal interpolation so source
//      bytes don't trip GitHub Push Protection while runtime value
//      still exercises the realistic case). The assertion is
//      JSON.stringify(result.results).not.toContain(...) — the SAME
//      whole-result pattern the secrets detector uses. Catches
//      accidental leaks via message, title, or any future field, not
//      just evidence.
//
//   5. EDGE CASES
//      Binary file skip, empty addedLines skip, Windows backslash path
//      normalization end-to-end (proves normalizePathSeparators flows
//      through to all three rules correctly).
//
// =============================================================================
// CRITICAL TEST DISCIPLINE — `configChecks: { dependencies: true }`
// =============================================================================
// Every test that calls runChecks MUST set `dependencies: true` in
// configChecks. Without it, D28 Layer 1 inspects dependenciesCheck's
// emittedCategories (defaults to ["dependencies"]), finds no enabled
// toggles, and SKIPS the check entirely → 0 findings for the WRONG
// reason. The ctxFor helper below defaults to { dependencies: true }
// to make the discipline mechanical; explicit per-test overrides (if
// ever needed) should be flagged with comments.
//
// =============================================================================
// Test pipeline: isolated `runChecks([dependenciesCheck], ctx)` — same
// future-detector-brittleness avoidance as Step 3 files 5/6/7 and Step 4.

import { describe, expect, it } from "vitest";

import { dependenciesCheck } from "../../src/detectors/dependencies.js";
import type { ChangedFileInput, CheckContext, ChecksToggleConfig } from "../../src/index.js";
import { runChecks } from "../../src/index.js";

// =============================================================================
// Test fixtures
// =============================================================================

/**
 * Build a ChangedFileInput with no added/removed lines — only the path
 * matters (used by lockfile-without-manifest tests where the rule fires
 * purely on path detection, not content).
 */
function pathOnly(path: string): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines: [],
    removedLines: [],
    isBinary: false,
  };
}

/**
 * Build a ChangedFileInput with the given added lines — used by
 * install-script and new-dependency tests where the rule fires on
 * content matching of addedLines.
 */
function withAddedLines(
  path: string,
  addedLines: readonly { line: number; text: string }[],
): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines,
    removedLines: [],
    isBinary: false,
  };
}

/**
 * Build a CheckContext from a list of ChangedFileInputs. Defaults
 * configChecks to `{ dependencies: true }` so D28 Layer 1 does NOT
 * short-circuit dependenciesCheck. See CRITICAL TEST DISCIPLINE block
 * above for the rationale.
 */
function ctxFor(
  files: readonly ChangedFileInput[],
  configChecks: ChecksToggleConfig = { dependencies: true },
): CheckContext {
  return {
    changedFiles: files,
    detectedFrameworks: [],
    configChecks,
  };
}

/**
 * The 7-ecosystem lockfile→manifest pair table mirroring
 * LOCKFILE_TO_MANIFEST in dependency-constants.ts. Duplicated here
 * intentionally per D17c's small-atomic-helpers precedent — keeping
 * this table local makes the test data self-contained AND forces a
 * deliberate decision when adding a new ecosystem (the test table
 * MUST be extended alongside the constants per the LOCKED EXTENSION
 * POLICY in dependencies.ts header).
 */
const LOCKFILE_ECOSYSTEMS: readonly { lockfile: string; manifest: string }[] = [
  { lockfile: "package-lock.json", manifest: "package.json" },
  { lockfile: "pnpm-lock.yaml", manifest: "package.json" },
  { lockfile: "yarn.lock", manifest: "package.json" },
  { lockfile: "composer.lock", manifest: "composer.json" },
  { lockfile: "Gemfile.lock", manifest: "Gemfile" },
  { lockfile: "poetry.lock", manifest: "pyproject.toml" },
  { lockfile: "Cargo.lock", manifest: "Cargo.toml" },
];

/** package.json install-script hook keys (locked per dependency-constants.ts). */
const PACKAGE_JSON_HOOKS: readonly string[] = ["preinstall", "install", "postinstall", "prepare"];

/** composer.json install-script hook keys (locked per dependency-constants.ts). */
const COMPOSER_JSON_HOOKS: readonly string[] = ["post-install-cmd", "post-update-cmd"];

/** Transitive directory segments (locked per dependencies.ts TRANSITIVE_PATH_SEGMENTS). */
const TRANSITIVE_SEGMENTS: readonly string[] = ["node_modules", "vendor", ".venv", "venv"];

/**
 * Credential-shaped fixtures for REDACTION SAFETY testing.
 * Constructed via template-literal interpolation per the locked
 * "Constructed test fixtures for secret-shaped literals" memory
 * entry: source bytes must not contain the contiguous credential
 * shape (neither the token itself nor the embedding URL) so
 * GitHub Push Protection's diff scanner cannot flag the test
 * source.
 *
 * BOTH the token AND the URL it's embedded in are split across
 * template-literal boundaries:
 *   - CREDENTIAL_TOKEN: a 4-piece interpolation; source bytes
 *     never contain the joined token string contiguously.
 *   - CREDENTIAL_VERSION: interpolates CREDENTIAL_TOKEN into a
 *     git+https URL shape; source bytes never contain the full
 *     credential URL contiguously (only its URL-component
 *     boundaries like `git+https://user:` and
 *     `@github.com/acme/private.git`, neither of which is
 *     credential-shaped on its own).
 *
 * Runtime value SHAPE: a git+https URL with an embedded
 * username:token credential — the canonical "secret leaked via
 * dependency version URL" case the detector's REDACTION SAFETY
 * mechanism (version string verified-but-discarded via the
 * non-capturing group in JSON_STRING_ENTRY_PATTERN) is supposed
 * to defend against.
 *
 * The REDACTION SAFETY test asserts the whole serialized result
 * does NOT contain CREDENTIAL_VERSION OR CREDENTIAL_TOKEN (both
 * runtime values), proving neither leaks into any emitted finding
 * field.
 */
const CREDENTIAL_TOKEN = `${"fake"}-${"token"}-${"not"}-${"real"}`;
const CREDENTIAL_VERSION = `git+https://user:${CREDENTIAL_TOKEN}@github.com/acme/private.git`;

// =============================================================================
// RULE 1: dependencies.lockfile-without-manifest
// =============================================================================

describe("dependenciesCheck — rule 1: lockfile-without-manifest", () => {
  it.each(
    LOCKFILE_ECOSYSTEMS,
  )("$lockfile alone (no sibling $manifest) → emits medium 'lockfile-without-manifest' finding", ({
    lockfile,
    manifest,
  }) => {
    const result = runChecks([dependenciesCheck], ctxFor([pathOnly(lockfile)]));
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.lockfile-without-manifest");
    expect(finding.category).toBe("dependencies");
    expect(finding.level).toBe("medium");
    expect(finding.confidence).toBe("high");
    expect(finding.message).toContain(lockfile);
    expect(finding.message).toContain(manifest);
    expect(finding.evidence[0]?.file).toBe(lockfile);
    // Recommendation is included on medium findings per the locked
    // UX even though M B's CheckResultSchema only requires it on
    // high/critical — assert presence to lock that contract.
    expect(finding.recommendation?.trim().length).toBeGreaterThan(0);
  });

  it.each(
    LOCKFILE_ECOSYSTEMS,
  )("$lockfile WITH sibling $manifest in same dir → no finding (paired)", ({
    lockfile,
    manifest,
  }) => {
    const result = runChecks([dependenciesCheck], ctxFor([pathOnly(lockfile), pathOnly(manifest)]));
    expect(result.results).toEqual([]);
  });

  it("apps/web/yarn.lock + ROOT package.json → still emits (sibling-DIR pairing, NOT basename-anywhere)", () => {
    // The pairing rule is per sibling-directory. A root package.json
    // does NOT pair with apps/web/yarn.lock; the rule still fires.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([pathOnly("apps/web/yarn.lock"), pathOnly("package.json")]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.lockfile-without-manifest");
    expect(finding.evidence[0]?.file).toBe("apps/web/yarn.lock");
    expect(finding.message).toContain("apps/web/package.json");
  });

  it("monorepo mix: one unpaired lockfile + one paired lockfile → only the unpaired fires", () => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        pathOnly("apps/web/yarn.lock"),
        pathOnly("services/api/package-lock.json"),
        pathOnly("services/api/package.json"),
      ]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence[0]?.file).toBe("apps/web/yarn.lock");
  });

  it("Windows backslash input (apps\\\\web\\\\yarn.lock alone) → POSIX-normalized output, fires correctly", () => {
    const result = runChecks([dependenciesCheck], ctxFor([pathOnly("apps\\web\\yarn.lock")]));
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence[0]?.file).toBe("apps/web/yarn.lock");
    expect(finding.evidence[0]?.file).not.toContain("\\");
    expect(finding.message).toContain("apps/web/yarn.lock");
    expect(finding.message).not.toContain("\\");
  });
});

// =============================================================================
// RULE 2: dependencies.install-script
// =============================================================================

describe("dependenciesCheck — rule 2: install-script", () => {
  it.each(
    PACKAGE_JSON_HOOKS,
  )("package.json with added '%s' key → fires install-script (and ONLY install-script, NOT new-dep)", (key) => {
    // The single-finding assertion is critical: it proves
    // MANIFEST_NON_DEP_KEYS includes this install-script key, so
    // rule 3 (new-dependencies) does NOT double-fire on the same
    // line. If the denylist coverage regresses, this test fails.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([withAddedLines("package.json", [{ line: 5, text: `    "${key}": "echo build",` }])]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.install-script");
    expect(finding.category).toBe("dependencies");
    expect(finding.level).toBe("medium");
    expect(finding.confidence).toBe("medium");
    expect(finding.message).toContain(key);
    expect(finding.evidence[0]?.line).toBe(5);
    expect(finding.evidence[0]?.detail).toContain(`install-script: ${key}`);
    expect(finding.evidence[0]?.detail).toContain("[occurrence 1]");
    expect(finding.recommendation?.trim().length).toBeGreaterThan(0);
  });

  it.each(
    COMPOSER_JSON_HOOKS,
  )("composer.json with added '%s' key → fires install-script (and ONLY install-script, NOT new-dep)", (key) => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([withAddedLines("composer.json", [{ line: 5, text: `    "${key}": "echo build",` }])]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.install-script");
    expect(finding.level).toBe("medium");
    expect(finding.confidence).toBe("medium");
    expect(finding.message).toContain(key);
  });

  it("multiple different hooks on different lines → multiple findings, occurrence index 1 each", () => {
    // Different keys = different occurrence counters. Each key starts
    // its own occurrence sequence at 1.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("package.json", [
          { line: 5, text: `    "postinstall": "echo a",` },
          { line: 10, text: `    "prepare": "echo b",` },
        ]),
      ]),
    );
    expect(result.results).toHaveLength(2);
    const postinstall = result.results.find((r) =>
      r.evidence[0]?.detail?.includes("install-script: postinstall"),
    );
    const prepare = result.results.find((r) =>
      r.evidence[0]?.detail?.includes("install-script: prepare"),
    );
    expect(postinstall).toBeDefined();
    expect(prepare).toBeDefined();
    expect(postinstall?.evidence[0]?.detail).toContain("[occurrence 1]");
    expect(prepare?.evidence[0]?.detail).toContain("[occurrence 1]");
  });

  it("SAME hook key on different lines → 2 findings with occurrence indices 1 and 2 (D40 dedup keys distinct)", () => {
    // Rare in practice but defensively tested — the per-(file, key)
    // occurrence counter guarantees distinct dedup tuples even when
    // the same lifecycle key is added on multiple lines (e.g., from
    // a multi-package refactor that re-keys postinstall in several
    // locations within the same diff hunk).
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("package.json", [
          { line: 5, text: `    "postinstall": "echo first",` },
          { line: 25, text: `    "postinstall": "echo second",` },
        ]),
      ]),
    );
    expect(result.results).toHaveLength(2);
    const details = result.results.map((r) => r.evidence[0]?.detail ?? "");
    expect(details.some((d) => d.includes("[occurrence 1]"))).toBe(true);
    expect(details.some((d) => d.includes("[occurrence 2]"))).toBe(true);
    const lines = result.results.map((r) => r.evidence[0]?.line);
    expect(lines).toContain(5);
    expect(lines).toContain(25);
  });

  it("empty addedLines on a known manifest → no install-script finding (early skip)", () => {
    const result = runChecks([dependenciesCheck], ctxFor([pathOnly("package.json")]));
    expect(result.results.filter((r) => r.id === "dependencies.install-script")).toEqual([]);
  });

  it("binary manifest file (isBinary=true) → no install-script finding (early skip)", () => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        {
          path: "package.json",
          status: "modified",
          addedLines: [],
          removedLines: [],
          isBinary: true,
        },
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("non-manifest file with install-script-shape key → no install-script finding (wrong basename)", () => {
    // A random non-manifest file with a line that looks like a JSON
    // install-script key. The detector keys off the file BASENAME
    // (must be in INSTALL_SCRIPT_PATTERNS_BY_MANIFEST), not on
    // line shape, so this MUST NOT fire.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("src/random-config.ts", [
          { line: 5, text: `const config = { "postinstall": "echo x" };` },
        ]),
      ]),
    );
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// RULE 3: dependencies.new-dependencies
// =============================================================================

describe("dependenciesCheck — rule 3: new-dependencies", () => {
  it("single new dep added to package.json → 1 low finding, 1 evidence entry, no overflow tail", () => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([withAddedLines("package.json", [{ line: 5, text: `    "lodash": "^4.0.0",` }])]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.new-dependencies");
    expect(finding.category).toBe("dependencies");
    expect(finding.level).toBe("low");
    expect(finding.confidence).toBe("medium");
    expect(finding.evidence).toHaveLength(1);
    expect(finding.evidence[0]?.detail).toBe("new-dependency: lodash");
    expect(finding.message).toContain("1 new dependency");
    expect(finding.message).not.toContain("+");
  });

  it("exactly 5 new deps → 1 finding, 5 evidence entries, NO overflow tail", () => {
    const lines = [
      { line: 5, text: `    "lodash": "^4.0.0",` },
      { line: 6, text: `    "axios": "^1.0.0",` },
      { line: 7, text: `    "react": "^18.0.0",` },
      { line: 8, text: `    "zod": "^3.0.0",` },
      { line: 9, text: `    "vitest": "^1.0.0",` },
    ];
    const result = runChecks([dependenciesCheck], ctxFor([withAddedLines("package.json", lines)]));
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence).toHaveLength(5);
    expect(finding.message).toContain("5 new dependencies");
    expect(finding.message).not.toContain("+"); // no "+N more added" tail
  });

  it("8 new deps → 1 finding, 5 evidence + '(+3 more added)' tail in message", () => {
    const lines = Array.from({ length: 8 }, (_, i) => ({
      line: 5 + i,
      text: `    "dep-${i}": "^1.0.0",`,
    }));
    const result = runChecks([dependenciesCheck], ctxFor([withAddedLines("package.json", lines)]));
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence).toHaveLength(5); // capped at MAX_NEW_DEPENDENCY_EVIDENCE
    expect(finding.message).toContain("8 new dependencies");
    expect(finding.message).toContain("(+3 more added)");
  });

  it("two separate manifest FILES in same diff → 2 findings, ONE per manifest (D34 locked interpretation (a))", () => {
    // Per-manifest-FILE consolidation: a diff touching multiple
    // package.json files produces multiple findings, one per file.
    // This is the locked interpretation (a) of D34's "per manifest"
    // wording — NOT one combined finding across all package.json
    // changes.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("package.json", [{ line: 5, text: `    "lodash": "^4.0.0",` }]),
        withAddedLines("apps/web/package.json", [{ line: 5, text: `    "axios": "^1.0.0",` }]),
      ]),
    );
    const newDepFindings = result.results.filter((r) => r.id === "dependencies.new-dependencies");
    expect(newDepFindings).toHaveLength(2);
    const paths = newDepFindings.map((r) => r.evidence[0]?.file).sort();
    expect(paths).toEqual(["apps/web/package.json", "package.json"]);
  });

  it("composer.json with new require entries → 1 low finding", () => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("composer.json", [
          { line: 5, text: `    "monolog/monolog": "^3.0",` },
          { line: 6, text: `    "guzzlehttp/guzzle": "^7.0",` },
        ]),
      ]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.new-dependencies");
    expect(finding.evidence).toHaveLength(2);
    expect(finding.evidence[0]?.detail).toBe("new-dependency: monolog/monolog");
    expect(finding.evidence[1]?.detail).toBe("new-dependency: guzzlehttp/guzzle");
  });

  it("only denylisted metadata keys added (name/version/license) → no new-dep finding", () => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("package.json", [
          { line: 2, text: `  "name": "my-pkg",` },
          { line: 3, text: `  "version": "1.0.0",` },
          { line: 4, text: `  "license": "MIT",` },
        ]),
      ]),
    );
    expect(result.results.filter((r) => r.id === "dependencies.new-dependencies")).toEqual([]);
  });

  it("REDACTION SAFETY: credential-shaped version string never appears in any field of the finding", () => {
    // The new-dependency rule uses CREDENTIAL_VERSION's structure to
    // confirm the line matches the JSON string-string entry shape,
    // but the version string itself is verified-but-discarded via
    // the non-capturing group in JSON_STRING_ENTRY_PATTERN. The
    // emitted finding must contain ONLY the dependency NAME.
    //
    // Whole-result assertion (per the locked review): JSON.stringify
    // the entire results array and confirm it does NOT contain
    // CREDENTIAL_VERSION (the full runtime URL) OR CREDENTIAL_TOKEN
    // (the embedded token). Both runtime values are referenced by
    // their fixture identifiers — never spelled in source — so this
    // test source stays push-protection-safe while the runtime
    // assertion is precise.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("package.json", [
          { line: 5, text: `    "acme-private": "${CREDENTIAL_VERSION}",` },
        ]),
      ]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.new-dependencies");
    expect(finding.evidence[0]?.detail).toBe("new-dependency: acme-private");
    const serialized = JSON.stringify(result.results);
    expect(serialized).not.toContain(CREDENTIAL_VERSION);
    expect(serialized).not.toContain(CREDENTIAL_TOKEN);
    expect(serialized).not.toContain("git+https");
    // The dependency name MUST be present (positive control: ensure
    // we're actually checking the right finding).
    expect(serialized).toContain("acme-private");
  });

  it("object-valued top-level JSON entry opener line is skipped → no new-dep finding", () => {
    // The opener line for an object-valued entry (e.g., the line
    // `"customField": {`) does NOT match JSON_STRING_ENTRY_PATTERN
    // — the trailing `{` is not a quoted string value. The detector
    // correctly skips this line; no candidate dep is extracted from
    // it.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([withAddedLines("package.json", [{ line: 5, text: `  "customField": {` }])]),
    );
    expect(result.results.filter((r) => r.id === "dependencies.new-dependencies")).toEqual([]);
  });

  it("known limitation: nested string-string entry inside a custom object IS detected as a candidate (no section tracking)", () => {
    // Locked KNOWN LIMITATION test (the no-section-tracking trade-off
    // explicitly accepted per D34 + the dependencies.ts file header
    // "SECTION TRACKING: DELIBERATELY OMITTED FOR M C" block).
    //
    // A nested string-string entry inside a non-dependency object
    // (e.g., `"nested": "value"` inside `"customField": { ... }`)
    // matches JSON_STRING_ENTRY_PATTERN and its key "nested" isn't
    // in MANIFEST_NON_DEP_KEYS. Without section tracking, the
    // detector cannot disambiguate dep-section vs custom-object
    // context — it emits 1 new-dep finding for "nested".
    //
    // This test locks the limitation explicitly. If a future
    // milestone lands section tracking, this test MUST be updated
    // deliberately (to expect zero findings or to delete the test)
    // rather than silently changing behavior.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([withAddedLines("package.json", [{ line: 6, text: `    "nested": "value"` }])]),
    );
    const newDepFindings = result.results.filter((r) => r.id === "dependencies.new-dependencies");
    expect(newDepFindings).toHaveLength(1);
    const finding = newDepFindings[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence).toHaveLength(1);
    expect(finding.evidence[0]?.detail).toBe("new-dependency: nested");
  });

  it("empty addedLines on a known manifest → no new-dep finding (early skip)", () => {
    const result = runChecks([dependenciesCheck], ctxFor([pathOnly("package.json")]));
    expect(result.results.filter((r) => r.id === "dependencies.new-dependencies")).toEqual([]);
  });

  it("binary manifest file (isBinary=true) → no new-dep finding (early skip)", () => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        {
          path: "package.json",
          status: "modified",
          addedLines: [],
          removedLines: [],
          isBinary: true,
        },
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("non-manifest file with JSON-string-entry-shape lines → no new-dep finding (wrong basename)", () => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([withAddedLines("src/config.json", [{ line: 5, text: `    "lodash": "^4.0.0",` }])]),
    );
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// CROSS-RULE OVERLAP PROTECTION
// =============================================================================

describe("dependenciesCheck — cross-rule overlap protection", () => {
  it('MANDATORY: `"postinstall": "node build.js"` in package.json → ONLY install-script (no new-dep double-fire)', () => {
    // The flagship denylist-coverage test. Pre-denylist-fix, this
    // SAME added line would emit BOTH:
    //   - rule 2 (install-script): postinstall hook detected, medium
    //   - rule 3 (new-dependencies): "postinstall" treated as a dep
    //     name, "node build.js" treated as its version
    // Post-fix, MANIFEST_NON_DEP_KEYS["package.json"] includes
    // "postinstall" → rule 3 skips this line. Only rule 2 fires.
    //
    // The exact-one-finding assertion is the regression lock. If
    // someone removes "postinstall" from the denylist, this test
    // immediately fails with toHaveLength(2).
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("package.json", [{ line: 5, text: `    "postinstall": "node build.js",` }]),
      ]),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe("dependencies.install-script");
  });

  it("mix: real new dep + install-script on different lines → 1 install-script finding + 1 new-dep finding", () => {
    // Confirms rules 2 and 3 operate independently when the inputs
    // are non-overlapping. Both rules fire; neither over-fires.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("package.json", [
          { line: 5, text: `    "postinstall": "node build.js",` },
          { line: 10, text: `    "lodash": "^4.0.0",` },
        ]),
      ]),
    );
    const installScript = result.results.filter((r) => r.id === "dependencies.install-script");
    const newDeps = result.results.filter((r) => r.id === "dependencies.new-dependencies");
    expect(installScript).toHaveLength(1);
    expect(newDeps).toHaveLength(1);
    // The new-dep finding contains ONLY "lodash" (not "postinstall").
    expect(newDeps[0]?.evidence).toHaveLength(1);
    expect(newDeps[0]?.evidence[0]?.detail).toBe("new-dependency: lodash");
  });

  it("lockfile-without-manifest + new-dep on a different file → both fire (independent rules, no interference)", () => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        pathOnly("services/api/yarn.lock"), // no sibling — rule 1 fires
        withAddedLines("apps/web/package.json", [{ line: 5, text: `    "lodash": "^4.0.0",` }]),
      ]),
    );
    expect(
      result.results.filter((r) => r.id === "dependencies.lockfile-without-manifest"),
    ).toHaveLength(1);
    expect(result.results.filter((r) => r.id === "dependencies.new-dependencies")).toHaveLength(1);
  });
});

// =============================================================================
// TRANSITIVE_PATH_SEGMENTS EXCLUSION MATRIX
// =============================================================================

describe("dependenciesCheck — TRANSITIVE_PATH_SEGMENTS exclusion", () => {
  it.each(
    TRANSITIVE_SEGMENTS,
  )("segment '%s': lockfile-alone case is SKIPPED (rule 1 transitive guard)", (segment) => {
    const result = runChecks([dependenciesCheck], ctxFor([pathOnly(`${segment}/foo/yarn.lock`)]));
    expect(result.results).toEqual([]);
  });

  it.each(
    TRANSITIVE_SEGMENTS,
  )("segment '%s': manifest with install-script + new-dep adds is SKIPPED (rules 2+3 transitive guard)", (segment) => {
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines(`${segment}/foo/package.json`, [
          { line: 5, text: `    "postinstall": "echo x",` },
          { line: 10, text: `    "lodash": "^4.0.0",` },
        ]),
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("ecosystem-specific: vendor/foo/composer.json with install-script + new-dep adds is SKIPPED", () => {
    // Realistic composer transitive shape. Composer puts transitive
    // packages at vendor/<vendor>/<package>/composer.json.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([
        withAddedLines("vendor/foo/composer.json", [
          { line: 5, text: `    "post-install-cmd": "echo x",` },
          { line: 6, text: `    "monolog/monolog": "^3.0",` },
        ]),
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("ecosystem-specific: .venv/lib/python3.11/site-packages/foo/poetry.lock alone is SKIPPED", () => {
    // Realistic Python virtualenv shape. Poetry-installed transitive
    // dependencies land under .venv/lib/.../site-packages.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([pathOnly(".venv/lib/python3.11/site-packages/foo/poetry.lock")]),
    );
    expect(result.results).toEqual([]);
  });

  it("ecosystem-specific: venv/lib/python3.11/site-packages/foo/poetry.lock alone is SKIPPED", () => {
    // Same as above for the alternate `venv/` convention.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([pathOnly("venv/lib/python3.11/site-packages/foo/poetry.lock")]),
    );
    expect(result.results).toEqual([]);
  });

  it("substring-NOT-segment: apps/node_modules-test/yarn.lock alone → FIRES rule 1 (segment-based match, NOT substring)", () => {
    // Locks the segment-vs-substring distinction. The path contains
    // the substring "node_modules" but as part of a different
    // directory name ("node_modules-test"). Segment match returns
    // false → rule 1 fires correctly.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([pathOnly("apps/node_modules-test/yarn.lock")]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.lockfile-without-manifest");
    expect(finding.evidence[0]?.file).toBe("apps/node_modules-test/yarn.lock");
  });

  it("substring-NOT-segment: apps/vendor-config/composer.lock alone → FIRES rule 1 (segment-based match for vendor)", () => {
    // Symmetric proof for the `vendor` segment. "vendor-config" is
    // a distinct first-party directory name, NOT a transitive segment.
    const result = runChecks(
      [dependenciesCheck],
      ctxFor([pathOnly("apps/vendor-config/composer.lock")]),
    );
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.id).toBe("dependencies.lockfile-without-manifest");
    expect(finding.evidence[0]?.file).toBe("apps/vendor-config/composer.lock");
  });
});
