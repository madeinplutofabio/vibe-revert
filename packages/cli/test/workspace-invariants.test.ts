// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Workspace-level architecture invariants. Three complementary checks
// that together prevent "works locally, fails on CI" drift:
//
//   1. TSCONFIG PATHS INVARIANT -- every workspace package under
//      `packages/*` whose package.json has a `@viberevert/<name>` name
//      AND a `src/index.ts` MUST have a matching entry in the root
//      `tsconfig.base.json`'s `compilerOptions.paths` pointing at
//      `packages/<name>/src/index.ts`. Catches the file-level
//      resolution drift: without the mapping, TS falls back to
//      `package.json#main` -> `dist/index.js`, which exists locally
//      from prior builds but is absent on CI where typecheck runs
//      BEFORE build.
//
//   2. PACKAGE.JSON DEPS INVARIANT -- every workspace-package import
//      has to be declared in the CORRECT bucket of the consuming
//      package's package.json:
//        - src/ imports MUST be in `dependencies` (so production
//          installs `pnpm install --prod` still resolve them -- devDeps
//          are stripped on production install);
//        - test/ imports may be in `dependencies` OR `devDependencies`
//          (test code never ships to consumers).
//      Import DETECTION uses the TypeScript compiler API to walk the
//      AST and collect string-literal module specifiers from only the
//      6 real import-statement shapes (see discoverWorkspaceImportsInSubdir
//      below). Statement-aware detection is the correct fix for the
//      "false positive on test description strings" failure mode the
//      old regex-based detector hit: a test description like
//      'default import from "@viberevert/core"' is just text inside a
//      string literal -- the AST visitor sees a StringLiteral node in
//      an ObjectLiteralExpression / PropertyAssignment context, NOT a
//      module specifier of an ImportDeclaration, so it's correctly
//      ignored.
//
//   3. VITEST CONFIG ALIAS INVARIANT -- every workspace import in a
//      package that has a `vitest.config.ts` MUST appear as a string
//      literal in that config (presumes a `resolve.alias` entry).
//      Without an alias, vitest falls back to package.json#main ->
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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
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
 * Strip block and line comments from TS source. Still used by
 * invariant #3 (vitest config alias check) so a `// TODO: alias`
 * comment in a vitest config cannot satisfy the naive `.includes`
 * check without a real alias actually existing.
 *
 * NO LONGER used by the package.json deps invariant (#2) -- that
 * one now uses the TypeScript AST via discoverWorkspaceImportsInSubdir,
 * which is structurally immune to source-text false positives
 * (comments, string literals, regex literals, template literals
 * all stay distinct from real import-statement nodes).
 *
 * Two edge cases handled:
 *   - URL-style `://` inside string literals (e.g. `"https://x"`) is
 *     NOT treated as the start of a line comment, thanks to the
 *     `[^:]` alternative in the line-comment regex.
 *   - Block comments are matched non-greedily and multi-line.
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
 * Collect base @viberevert/<pkg> specifiers from every real import-
 * shape AST node under `pkgDir/subdir`. Statement-aware: a string
 * literal that merely CONTAINS the text `@viberevert/core` (such as
 * a test description, an error message template, a regex pattern)
 * is invisible here because it's a StringLiteral inside an unrelated
 * AST context, not the moduleSpecifier of an ImportDeclaration.
 *
 * Six AST shapes covered, matching the 5-form import surface from
 * the M G1a D99.M block plus re-export:
 *
 *   1. ImportDeclaration                     `import ... from "X"`  and `import "X"`
 *   2. ExportDeclaration (with from)         `export ... from "X"`
 *   3. CallExpression (ImportKeyword)        `import("X")`
 *   4. CallExpression (require identifier)   `require("X")`
 *   5. ImportEqualsDeclaration               `import x = require("X")`
 *
 * Specifier-normalization regex: `/^(@viberevert\/[a-z0-9-]+)(?:\/|$)/`.
 * Requires the captured base package name to be followed by either
 * `/` (subpath import) or end-of-string (bare package). Rejects
 * malformed strings like `@viberevert/core.foo` which would otherwise
 * partial-match and pollute the discovered set with a non-existent
 * package name.
 *
 * Returns a Set of base package names actually imported.
 */
function discoverWorkspaceImportsInSubdir(pkgDir: string, subdir: "src" | "test"): Set<string> {
  const imports = new Set<string>();
  const full = join(pkgDir, subdir);
  if (!existsSync(full)) return imports;

  const addIfWorkspace = (specifier: ts.Node | undefined): void => {
    if (specifier === undefined) return;
    if (!ts.isStringLiteralLike(specifier)) return;
    const match = specifier.text.match(/^(@viberevert\/[a-z0-9-]+)(?:\/|$)/);
    if (match !== null && match[1] !== undefined) imports.add(match[1]);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      addIfWorkspace(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      addIfWorkspace(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length > 0) addIfWorkspace(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      if (node.arguments.length > 0) addIfWorkspace(node.arguments[0]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addIfWorkspace(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };

  for (const file of walkTsFiles(full)) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );
    visit(sourceFile);
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
      // No vitest config -> no vitest runtime -> nothing to alias.
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
      `Without the alias, vitest falls back to package.json#main ->`,
      `dist/index.js, which is absent on fresh clones / clean CI runs.`,
    ];
    throw new Error(`\n${lines.join("\n")}`);
  });
});
