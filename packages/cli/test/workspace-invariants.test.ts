// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Workspace-level architecture invariants. Three complementary checks
// that together prevent "works locally, fails on CI" drift:
//
//   1. TSCONFIG PATHS INVARIANT — every workspace package under
//      `packages/*` whose package.json has a `@viberevert/<name>` name
//      AND a `src/index.ts` MUST have a matching entry in the root
//      `tsconfig.base.json`'s `compilerOptions.paths` pointing at
//      `packages/<name>/src/index.ts`. Catches the file-level
//      resolution drift: without the mapping, TS falls back to
//      `package.json#main` → `dist/index.js`, which exists locally
//      from prior builds but is absent on CI where typecheck runs
//      BEFORE build.
//
//   2. PACKAGE.JSON DEPS INVARIANT — every workspace-package import
//      has to be declared in the CORRECT bucket of the consuming
//      package's package.json:
//        - src/ imports MUST be in `dependencies` (so production
//          installs `pnpm install --prod` still resolve them — devDeps
//          are stripped on production install);
//        - test/ imports may be in `dependencies` OR `devDependencies`
//          (test code never ships to consumers).
//
//   3. VITEST CONFIG ALIAS INVARIANT — every workspace import in a
//      package that has a `vitest.config.ts` MUST appear as a string
//      literal in that config (presumes a `resolve.alias` entry).
//      Without an alias, vitest falls back to package.json#main →
//      dist/index.js, which is absent on fresh clones. Phase C's
//      checks and reporters configs had NO aliases at all and were
//      surviving on stale local dist; CLI was missing the checks
//      alias added by Phase C imports.
//
// All three are **test-time architecture invariants**, NOT compile-
// time gates. They run in CI (via `pnpm test`) and fail with a clear
// invariant message that names the offender(s) and prints the exact
// fix. The CLI is the natural home: it's the "leaf consumer" of the
// workspace and the future host of the broader D48 architectural-
// invariants suite per the Phase F plan.
//
// IMPLEMENTATION NOTE: source scanning strips comments BEFORE regex
// matching. This file itself contains comment-block examples that
// would otherwise create false positives in invariant #2 (e.g. the
// example imports in the file header and helper docstrings) and
// false negatives in invariant #3 (e.g. an `// TODO: alias` comment
// in a vitest config would satisfy a naive `.includes` check without
// a real alias existing). The strip is applied in BOTH source-read
// helpers for symmetric defense.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const TSCONFIG_BASE = join(REPO_ROOT, "tsconfig.base.json");

// =============================================================================
// Shared discovery helpers
// =============================================================================

interface DiscoveredPackage {
  readonly dirName: string;
  readonly packageName: string;
  readonly pkgDir: string;
}

/**
 * All packages in `packages/*` that have a real package.json.
 * Returns packages sorted by packageName ASC so downstream failure
 * messages are byte-stable across runs and platforms (readdirSync
 * iteration order is non-deterministic on POSIX inode-order vs NTFS).
 */
function discoverAllPackages(): readonly DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const name of readdirSync(PACKAGES_DIR)) {
    const pkgDir = join(PACKAGES_DIR, name);
    if (!statSync(pkgDir).isDirectory()) continue;
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: unknown };
    if (typeof pkgJson.name !== "string") continue;
    out.push({ dirName: name, packageName: pkgJson.name, pkgDir });
  }
  out.sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));
  return out;
}

function readTsconfigPaths(): Record<string, readonly string[]> {
  const raw = JSON.parse(readFileSync(TSCONFIG_BASE, "utf8")) as {
    compilerOptions?: { paths?: Record<string, readonly string[]> };
  };
  return raw.compilerOptions?.paths ?? {};
}

interface DeclaredDeps {
  readonly dependencies: ReadonlySet<string>;
  readonly devDependencies: ReadonlySet<string>;
}

function readDeclaredDeps(pkgDir: string): DeclaredDeps {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    dependencies: new Set(Object.keys(pkgJson.dependencies ?? {})),
    devDependencies: new Set(Object.keys(pkgJson.devDependencies ?? {})),
  };
}

/**
 * Strip block and line comments from TS source so the downstream
 * regex/string scans don't pick up code examples that live in
 * comments. Two important edge cases handled:
 *   - URL-style `://` inside string literals (e.g. `"https://x"`) is
 *     NOT treated as the start of a line comment, thanks to the
 *     `[^:]` alternative in the line-comment regex.
 *   - Block comments are matched non-greedily and multi-line.
 *
 * False negatives possible inside template literals or regex literals
 * containing `//` (rare; the downstream invariants only LOSE matches
 * in those cases, never gain false ones — which is exactly the
 * conservative direction).
 */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Recursively collect `.ts` files under `rootDir`, skipping node_modules and dist. */
function walkTsFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Catches:
 *   - `from "<pkg>"` (incl. `import type … from`, `export … from`)
 *   - `import "<pkg>"` (side-effect import)
 *   - `import("<pkg>")` (dynamic import)
 *   - `from "<pkg>/sub"` (subpath imports — capture is the base
 *     package name; the `(?:\/[^"']*)?` group is non-capturing and discarded)
 *
 * Regex-based (good enough for this invariant — a false positive would
 * just demand an extra declared dep, which is defensive, not wrong).
 */
const WORKSPACE_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|import\s+)["'](@viberevert\/[a-z0-9-]+)(?:\/[^"']*)?["']/g;

function discoverWorkspaceImportsInSubdir(pkgDir: string, subdir: "src" | "test"): Set<string> {
  const imports = new Set<string>();
  const full = join(pkgDir, subdir);
  if (!existsSync(full)) return imports;

  for (const file of walkTsFiles(full)) {
    // Strip comments BEFORE regex scanning so the file's own JSDoc
    // examples don't surface as fake imports (this very test file
    // would otherwise self-fail on the example imports in its header).
    const content = stripTsComments(readFileSync(file, "utf8"));
    for (const m of content.matchAll(WORKSPACE_IMPORT_RE)) {
      const packageName = m[1];
      if (packageName !== undefined) imports.add(packageName);
    }
  }
  return imports;
}

// =============================================================================
// Invariant 1: tsconfig paths
// =============================================================================

describe("workspace tsconfig paths invariant", () => {
  it("every @viberevert/* workspace package with src/index.ts has a matching tsconfig path mapping", () => {
    const packages = discoverAllPackages().filter(
      (p) =>
        p.packageName.startsWith("@viberevert/") && existsSync(join(p.pkgDir, "src", "index.ts")),
    );
    // Sanity: discovery should always find at least the M B core trio.
    expect(packages.length).toBeGreaterThanOrEqual(3);

    const paths = readTsconfigPaths();
    const missing: DiscoveredPackage[] = [];
    const mismatched: string[] = [];
    for (const pkg of packages) {
      const expectedTarget = `packages/${pkg.dirName}/src/index.ts`;
      const entry = paths[pkg.packageName];
      if (entry === undefined) {
        missing.push(pkg);
        continue;
      }
      if (entry.length !== 1 || entry[0] !== expectedTarget) {
        mismatched.push(
          `${pkg.packageName}: expected ["${expectedTarget}"], got ${JSON.stringify(entry)}`,
        );
      }
    }

    if (missing.length === 0 && mismatched.length === 0) return;

    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(`Missing tsconfig.base.json path mappings for ${missing.length} package(s).`);
      lines.push(`Add the following entries to compilerOptions.paths:`);
      for (const pkg of missing) {
        lines.push(`  "${pkg.packageName}": ["packages/${pkg.dirName}/src/index.ts"],`);
      }
    }
    if (mismatched.length > 0) {
      lines.push(`Path mappings point at the wrong target:`);
      for (const m of mismatched) lines.push(`  ${m}`);
    }
    throw new Error(`\n${lines.join("\n")}`);
  });
});

// =============================================================================
// Invariant 2: package.json declared workspace deps (bucket-correct)
// =============================================================================

describe("workspace package.json deps invariant", () => {
  it("every workspace-package import is declared in the correct package.json dependency bucket", () => {
    const packages = discoverAllPackages();
    expect(packages.length).toBeGreaterThanOrEqual(3);

    const violations: string[] = [];

    for (const pkg of packages) {
      const declared = readDeclaredDeps(pkg.pkgDir);
      const srcImports = discoverWorkspaceImportsInSubdir(pkg.pkgDir, "src");
      const testImports = discoverWorkspaceImportsInSubdir(pkg.pkgDir, "test");

      const missingRuntimeDeps: string[] = [];
      const missingTestDeps: string[] = [];

      for (const imp of srcImports) {
        if (imp === pkg.packageName) continue;
        if (!declared.dependencies.has(imp)) missingRuntimeDeps.push(imp);
      }

      for (const imp of testImports) {
        if (imp === pkg.packageName) continue;
        if (declared.dependencies.has(imp) || declared.devDependencies.has(imp)) continue;
        missingTestDeps.push(imp);
      }

      missingRuntimeDeps.sort();
      missingTestDeps.sort();

      if (missingRuntimeDeps.length > 0) {
        violations.push(
          `${pkg.packageName} (packages/${pkg.dirName}): src/ imports but dependencies does not declare: ${missingRuntimeDeps.join(", ")}`,
        );
      }

      if (missingTestDeps.length > 0) {
        violations.push(
          `${pkg.packageName} (packages/${pkg.dirName}): test/ imports but neither dependencies nor devDependencies declares: ${missingTestDeps.join(", ")}`,
        );
      }
    }

    if (violations.length === 0) return;

    const lines: string[] = [
      `Workspace package.json deps invariant violated:`,
      ...violations.map((v) => `  ${v}`),
      ``,
      `Rules:`,
      `  - Imports from src/ must be declared in dependencies.`,
      `  - Imports used only from test/ may be declared in dependencies or devDependencies.`,
      ``,
      `Without this, pnpm strict/fresh installs can fail even when local transitive hoisting makes the import appear to work.`,
    ];

    throw new Error(`\n${lines.join("\n")}`);
  });
});

// =============================================================================
// Invariant 3: vitest config alias coverage
// =============================================================================

describe("workspace vitest config alias invariant", () => {
  it("every workspace import in a package's src/ or test/ appears as a string literal in that package's vitest.config.ts", () => {
    const packages = discoverAllPackages();
    expect(packages.length).toBeGreaterThanOrEqual(3);

    const violations: string[] = [];

    for (const pkg of packages) {
      const cfgPath = join(pkg.pkgDir, "vitest.config.ts");
      // No vitest config → no vitest runtime → nothing to alias.
      if (!existsSync(cfgPath)) continue;
      // Strip comments for symmetric reasons: a `// TODO: alias`
      // comment would otherwise satisfy the naive `.includes` check
      // without a real alias actually existing.
      const cfgSource = stripTsComments(readFileSync(cfgPath, "utf8"));

      const allImports = new Set<string>();
      for (const imp of discoverWorkspaceImportsInSubdir(pkg.pkgDir, "src")) allImports.add(imp);
      for (const imp of discoverWorkspaceImportsInSubdir(pkg.pkgDir, "test")) allImports.add(imp);

      const missing: string[] = [];
      for (const imp of allImports) {
        if (imp === pkg.packageName) continue;
        // Presume aliased iff the package name appears as a string literal
        // in the comment-stripped vitest.config.ts source. Cheap, regex-
        // free check; false positives elsewhere (e.g. inside an unrelated
        // string literal) are harmless because the actual test would fail
        // at runtime if no real alias exists.
        if (!cfgSource.includes(`"${imp}"`) && !cfgSource.includes(`'${imp}'`)) {
          missing.push(imp);
        }
      }
      missing.sort();

      if (missing.length > 0) {
        violations.push(
          `${pkg.packageName} (packages/${pkg.dirName}): vitest.config.ts has no mention of: ${missing.join(", ")}`,
        );
      }
    }

    if (violations.length === 0) return;

    const lines: string[] = [
      `Vitest config alias invariant violated:`,
      ...violations.map((v) => `  ${v}`),
      ``,
      `Each missing workspace import needs an entry in resolve.alias of the`,
      `package's vitest.config.ts, e.g.:`,
      ``,
      `  import { fileURLToPath } from "node:url";`,
      `  import { defineProject } from "vitest/config";`,
      `  export default defineProject({`,
      `    resolve: {`,
      `      alias: {`,
      `        "@viberevert/<name>": fileURLToPath(`,
      `          new URL("../<name>/src/index.ts", import.meta.url),`,
      `        ),`,
      `      },`,
      `    },`,
      `    test: { /* ... */ },`,
      `  });`,
      ``,
      `Without the alias, vitest falls back to package.json#main →`,
      `dist/index.js, which is absent on fresh clones / clean CI runs.`,
    ];
    throw new Error(`\n${lines.join("\n")}`);
  });
});
