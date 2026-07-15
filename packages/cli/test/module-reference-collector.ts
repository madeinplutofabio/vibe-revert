// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4g -- a TypeScript-AST module-reference collector for the privileged-
// surface confinement invariants (D104.M.8/M.9).
//
// It collects every SUPPORTED STATIC import/export form -- named/default/namespace/
// side-effect imports, named/namespace/wildcard re-exports, TS import-equals -- and
// the EXPLICITLY AUDITED dynamic-loading forms: import(), require(),
// require.resolve(), module.require(). It is a SYNTAX-level scanner: it does NOT
// resolve indirect loaders (createRequire, eval, vm, aliased loader functions), so
// Piece 2 forbids `unresolved-dynamic-reference` within the audited scope rather
// than claiming full semantic module resolution. Loader-shaped calls (import()/
// require()/require.resolve()/module.require()) are classified SYNTACTICALLY, even
// when the callee is locally shadowed (e.g. `const require = customLoader`); it
// over-detects rather than under-detects, so false positives fail closed. Regex
// scanners miss aliases, namespace access, and re-exports -- a green invariant on a
// blind scanner enforces nothing -- so the AST is the source of truth (comments/
// string literals inherently ignored). It FAILS CLOSED on parse errors. TEST-ONLY
// infrastructure.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as ts from "typescript";

export type ModuleReferenceKind =
  | "named-import"
  | "default-import"
  | "namespace-import"
  | "side-effect-import"
  | "named-reexport"
  | "namespace-reexport"
  | "wildcard-reexport"
  | "dynamic-import"
  | "require"
  | "require-resolve"
  | "module-require"
  | "import-equals-require"
  | "unresolved-dynamic-reference";

/** Where a specifier points, WITHOUT resolving bare ids as filesystem paths. */
export type SpecifierTarget =
  // Relative: resolved against the importing file, stripped of a js/ts/mjs/cjs
  // extension (native, extensionless absolute path).
  | { readonly kind: "relative"; readonly path: string }
  // Non-relative (package / node: / workspace-barrel) -- NOT resolved on disk.
  | { readonly kind: "bare"; readonly specifier: string }
  // A dynamic import()/require()/import-equals whose argument is not static.
  | { readonly kind: "unresolved" };

export interface ModuleReference {
  readonly file: string;
  readonly line: number; // 1-indexed
  readonly column: number; // 1-indexed
  readonly kind: ModuleReferenceKind;
  readonly specifier: string | null; // null ONLY for unresolved-dynamic-reference
  readonly target: SpecifierTarget;
  /** Named import/re-export: ORIGINAL exported name in the source module (pre-alias). */
  readonly originalName?: string;
  /** Named/default/namespace import + import-equals: the local binding name. */
  readonly localName?: string;
  /** Named/namespace re-export: the re-exported (possibly aliased) name. */
  readonly exportedName?: string;
  /** `import type` / `export type` / per-specifier `type` modifier. */
  readonly typeOnly: boolean;
}

const RELATIVE_EXT = /\.(?:js|ts|mjs|cjs)$/;

function classifySpecifier(importingFileAbs: string, specifier: string): SpecifierTarget {
  if (specifier.startsWith(".")) {
    return {
      kind: "relative",
      path: resolve(dirname(importingFileAbs), specifier.replace(RELATIVE_EXT, "")),
    };
  }
  return { kind: "bare", specifier };
}

/**
 * Parse a source file, FAILING CLOSED on any syntactic parse error. `parseDiagnostics`
 * is @internal but the standard way to read syntactic errors from a standalone parse;
 * a malformed file can otherwise yield a PARTIAL (falsely-green) result, so any parse
 * error is fatal.
 */
function parseSourceFileStrict(fileAbs: string, sourceText: string): ts.SourceFile {
  const sf = ts.createSourceFile(
    fileAbs,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics =
    (sf as unknown as { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ??
    [];
  if (parseDiagnostics.length > 0) {
    const details = parseDiagnostics
      .map((d) => {
        const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
        return `${fileAbs}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
      })
      .join("\n");
    throw new Error(`Cannot analyze malformed source (fail closed):\n${details}`);
  }
  return sf;
}

/** Collect module references from in-memory source text (drives the unit tests). */
export function collectModuleReferencesFromSource(
  fileAbs: string,
  sourceText: string,
): ModuleReference[] {
  const sf = parseSourceFileStrict(fileAbs, sourceText);
  const refs: ModuleReference[] = [];
  const posOf = (node: ts.Node): { readonly line: number; readonly column: number } => {
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: lc.line + 1, column: lc.character + 1 };
  };

  const staticArg = (node: ts.CallExpression): string | undefined => {
    const arg = node.arguments[0];
    return arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
      ? arg.text
      : undefined;
  };

  const pushDynamic = (node: ts.CallExpression, literalKind: ModuleReferenceKind): void => {
    const spec = staticArg(node);
    if (spec === undefined) {
      refs.push({
        file: fileAbs,
        ...posOf(node),
        kind: "unresolved-dynamic-reference",
        specifier: null,
        target: { kind: "unresolved" },
        typeOnly: false,
      });
      return;
    }
    refs.push({
      file: fileAbs,
      ...posOf(node),
      kind: literalKind,
      specifier: spec,
      target: classifySpecifier(fileAbs, spec),
      typeOnly: false,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const target = classifySpecifier(fileAbs, specifier);
      const clause = node.importClause;
      if (clause === undefined) {
        refs.push({
          file: fileAbs,
          ...posOf(node),
          kind: "side-effect-import",
          specifier,
          target,
          typeOnly: false,
        });
      } else {
        const importTypeOnly = clause.isTypeOnly;
        if (clause.name !== undefined) {
          refs.push({
            file: fileAbs,
            ...posOf(clause.name),
            kind: "default-import",
            specifier,
            target,
            localName: clause.name.text,
            typeOnly: importTypeOnly,
          });
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          refs.push({
            file: fileAbs,
            ...posOf(bindings.name),
            kind: "namespace-import",
            specifier,
            target,
            localName: bindings.name.text,
            typeOnly: importTypeOnly,
          });
        } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            refs.push({
              file: fileAbs,
              ...posOf(el),
              kind: "named-import",
              specifier,
              target,
              originalName: (el.propertyName ?? el.name).text,
              localName: el.name.text,
              typeOnly: importTypeOnly || el.isTypeOnly,
            });
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expr = node.moduleReference.expression;
      if (
        expr !== undefined &&
        (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
      ) {
        refs.push({
          file: fileAbs,
          ...posOf(node),
          kind: "import-equals-require",
          specifier: expr.text,
          target: classifySpecifier(fileAbs, expr.text),
          localName: node.name.text,
          typeOnly: node.isTypeOnly,
        });
      } else {
        refs.push({
          file: fileAbs,
          ...posOf(node),
          kind: "unresolved-dynamic-reference",
          specifier: null,
          target: { kind: "unresolved" },
          typeOnly: false,
        });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const target = classifySpecifier(fileAbs, specifier);
      const exportTypeOnly = node.isTypeOnly;
      const clause = node.exportClause;
      if (clause === undefined) {
        refs.push({
          file: fileAbs,
          ...posOf(node),
          kind: "wildcard-reexport",
          specifier,
          target,
          typeOnly: exportTypeOnly,
        });
      } else if (ts.isNamespaceExport(clause)) {
        refs.push({
          file: fileAbs,
          ...posOf(node),
          kind: "namespace-reexport",
          specifier,
          target,
          exportedName: clause.name.text,
          typeOnly: exportTypeOnly,
        });
      } else if (ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          refs.push({
            file: fileAbs,
            ...posOf(el),
            kind: "named-reexport",
            specifier,
            target,
            originalName: (el.propertyName ?? el.name).text,
            exportedName: el.name.text,
            typeOnly: exportTypeOnly || el.isTypeOnly,
          });
        }
      }
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (expr.kind === ts.SyntaxKind.ImportKeyword) {
        pushDynamic(node, "dynamic-import");
      } else if (ts.isIdentifier(expr) && expr.text === "require") {
        pushDynamic(node, "require");
      } else if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        ts.isIdentifier(expr.name)
      ) {
        const receiver = expr.expression.text;
        const method = expr.name.text;
        if (receiver === "require" && method === "resolve") {
          pushDynamic(node, "require-resolve");
        } else if (receiver === "module" && method === "require") {
          pushDynamic(node, "module-require");
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return refs;
}

/** Collect module references from a file on disk. */
export function collectModuleReferences(fileAbs: string): ModuleReference[] {
  return collectModuleReferencesFromSource(fileAbs, readFileSync(fileAbs, "utf8"));
}

/** Whether a (possibly destructuring) binding name binds `symbol` anywhere. */
function bindingNameContains(name: ts.BindingName, symbol: string): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === symbol;
  }
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name, symbol),
  );
}

/**
 * True if `sourceText` LOCALLY exports a RUNTIME binding named `symbol` -- via an
 * exported function/class/variable declaration (identifier or destructuring pattern),
 * or a NON-type-only local export list (`export { symbol }` / `export { local as symbol }`).
 * Only TOP-LEVEL module statements are inspected (a nested `export` inside a namespace
 * does NOT export a module binding). Re-exports FROM another module
 * (`export { symbol } from "..."`) are NOT counted -- those are references surfaced by
 * collectModuleReferences. AST-backed (no declaration regex); type-only exports are
 * excluded (the privileged symbols are runtime capabilities). Fails closed on parse
 * errors. It proves module-export SYNTAX confinement, not full symbol resolution --
 * the package typecheck gate proves that `local` in `export { local as symbol }` exists.
 */
export function moduleExportsSymbolFromSource(
  fileAbs: string,
  sourceText: string,
  symbol: string,
): boolean {
  const sf = parseSourceFileStrict(fileAbs, sourceText);
  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false);

  for (const statement of sf.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === symbol &&
      hasExportModifier(statement)
    ) {
      return true;
    }
    if (
      ts.isVariableStatement(statement) &&
      hasExportModifier(statement) &&
      statement.declarationList.declarations.some((declaration) =>
        bindingNameContains(declaration.name, symbol),
      )
    ) {
      return true;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      !statement.isTypeOnly &&
      statement.exportClause.elements.some(
        (element) => !element.isTypeOnly && element.name.text === symbol,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** True if the file on disk LOCALLY exports a RUNTIME binding named `symbol`. */
export function moduleExportsSymbol(fileAbs: string, symbol: string): boolean {
  return moduleExportsSymbolFromSource(fileAbs, readFileSync(fileAbs, "utf8"), symbol);
}
