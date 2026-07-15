// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4g -- unit tests for the privileged-surface module-reference collector.
// The collector is the SCANNER the D104.M.8/M.9 confinement invariants trust, so it
// is proven independently here: every supported import/export/dynamic syntax form
// is DETECTED with correct classification; false-positive sources (comments, string
// literals, same-named identifiers, unrelated symbols) are IGNORED; and malformed
// source FAILS CLOSED. Expected paths use the same node:path API as the collector,
// so assertions hold on POSIX and Windows.

import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectModuleReferencesFromSource,
  type ModuleReference,
  moduleExportsSymbolFromSource,
  type SpecifierTarget,
} from "./module-reference-collector.js";

const FILE = resolve("repo", "pkg", "commands", "consumer.ts");
const collect = (src: string): ModuleReference[] => collectModuleReferencesFromSource(FILE, src);
const only = (src: string): ModuleReference => {
  const refs = collect(src);
  expect(refs).toHaveLength(1);
  return refs[0] as ModuleReference;
};
const expectedTarget = (relativePath: string): SpecifierTarget => ({
  kind: "relative",
  path: resolve(dirname(FILE), relativePath),
});

describe("module-reference collector -- named imports", () => {
  it("detects a plain named import with its resolved target module path", () => {
    const ref = only(`import { mint } from "./secret.js";`);
    expect(ref.kind).toBe("named-import");
    expect(ref.originalName).toBe("mint");
    expect(ref.localName).toBe("mint");
    expect(ref.typeOnly).toBe(false);
    expect(ref.target).toEqual(expectedTarget("secret"));
  });

  it("records the ORIGINAL name for an aliased named import", () => {
    const ref = only(`import { mint as make } from "./secret.js";`);
    expect(ref.originalName).toBe("mint");
    expect(ref.localName).toBe("make");
  });

  it("flags `import type { mint }` as typeOnly (still a reference to the symbol)", () => {
    const ref = only(`import type { mint } from "./secret.js";`);
    expect(ref.kind).toBe("named-import");
    expect(ref.originalName).toBe("mint");
    expect(ref.typeOnly).toBe(true);
  });

  it("flags a per-specifier `type` import as typeOnly", () => {
    expect(only(`import { type mint } from "./secret.js";`).typeOnly).toBe(true);
  });
});

describe("module-reference collector -- default / namespace / side-effect / import-equals", () => {
  it("detects a default import", () => {
    const ref = only(`import secret from "./secret.js";`);
    expect(ref.kind).toBe("default-import");
    expect(ref.localName).toBe("secret");
    expect(ref.target).toEqual(expectedTarget("secret"));
  });

  it("detects a namespace import", () => {
    const ref = only(`import * as secret from "./secret.js";`);
    expect(ref.kind).toBe("namespace-import");
    expect(ref.localName).toBe("secret");
  });

  it("detects a side-effect import (module access with no bindings)", () => {
    const ref = only(`import "./secret.js";`);
    expect(ref.kind).toBe("side-effect-import");
    expect(ref.target).toEqual(expectedTarget("secret"));
  });

  it("emits BOTH a default-import and a named-import for a combined import", () => {
    const kinds = collect(`import secret, { mint } from "./secret.js";`)
      .map((r) => r.kind)
      .sort();
    expect(kinds).toEqual(["default-import", "named-import"]);
  });

  it("detects a TS import-equals require with a string literal", () => {
    const ref = only(`import secret = require("./secret.js");`);
    expect(ref.kind).toBe("import-equals-require");
    expect(ref.localName).toBe("secret");
    expect(ref.target).toEqual(expectedTarget("secret"));
  });
});

describe("module-reference collector -- re-exports", () => {
  it("detects a named re-export with its original AND exported names", () => {
    const ref = only(`export { mint as internalMint } from "./secret.js";`);
    expect(ref.kind).toBe("named-reexport");
    expect(ref.originalName).toBe("mint");
    expect(ref.exportedName).toBe("internalMint");
  });

  it("detects a plain wildcard re-export", () => {
    const ref = only(`export * from "./secret.js";`);
    expect(ref.kind).toBe("wildcard-reexport");
    expect(ref.target).toEqual(expectedTarget("secret"));
  });

  it("detects a namespace re-export distinctly from a wildcard re-export", () => {
    const ref = only(`export * as secret from "./secret.js";`);
    expect(ref.kind).toBe("namespace-reexport");
    expect(ref.exportedName).toBe("secret");
  });

  it("flags `export type { mint }` as typeOnly", () => {
    expect(only(`export type { mint } from "./secret.js";`).typeOnly).toBe(true);
  });
});

describe("module-reference collector -- dynamic loading", () => {
  it("detects a static-literal dynamic import()", () => {
    const ref = only(`const m = import("./secret.js");`);
    expect(ref.kind).toBe("dynamic-import");
    expect(ref.target).toEqual(expectedTarget("secret"));
  });

  it("treats a no-substitution template literal as a static specifier", () => {
    expect(only("const m = import(`./secret.js`);").target).toEqual(expectedTarget("secret"));
    expect(only("require(`./secret.js`);").kind).toBe("require");
  });

  it("detects require(), require.resolve(), and module.require() with string literals", () => {
    expect(only(`require("./secret.js");`).kind).toBe("require");
    expect(only(`require.resolve("./secret.js");`).kind).toBe("require-resolve");
    expect(only(`module.require("./secret.js");`).kind).toBe("module-require");
  });

  it("emits unresolved-dynamic-reference for non-literal dynamic import/require", () => {
    const dyn = only(`const m = import(name);`);
    expect(dyn.kind).toBe("unresolved-dynamic-reference");
    expect(dyn.specifier).toBeNull();
    expect(dyn.target).toEqual({ kind: "unresolved" });
    expect(only(`require(name);`).kind).toBe("unresolved-dynamic-reference");
    expect(only(`require.resolve(name);`).kind).toBe("unresolved-dynamic-reference");
  });
});

describe("module-reference collector -- specifier normalization + classification", () => {
  it("normalizes .js/.ts/.mjs/.cjs/extensionless to the same relative target", () => {
    for (const spec of ["./secret.js", "./secret.ts", "./secret.mjs", "./secret.cjs", "./secret"]) {
      expect(only(`import { mint } from "${spec}";`).target).toEqual(expectedTarget("secret"));
    }
  });

  it("resolves parent-relative specifiers against the importing file", () => {
    expect(only(`import { mint } from "../secret.js";`).target).toEqual(
      expectedTarget("../secret"),
    );
  });

  it("classifies bare / package / barrel specifiers WITHOUT filesystem resolution", () => {
    expect(only(`import { x } from "@viberevert/cli-commands";`).target).toEqual({
      kind: "bare",
      specifier: "@viberevert/cli-commands",
    });
    expect(only(`import { createServer } from "node:net";`).target).toEqual({
      kind: "bare",
      specifier: "node:net",
    });
  });

  it("records 1-indexed line and column", () => {
    const ref = only(`\n  import { mint } from "./secret.js";`);
    expect(ref.line).toBe(2);
    expect(ref.column).toBeGreaterThan(1);
  });
});

describe("module-reference collector -- ignores false positives", () => {
  it("ignores imports written inside line and block comments", () => {
    expect(collect(`// import { mint } from "./secret.js";`)).toEqual([]);
    expect(collect(`/* import { mint } from "./secret.js"; */`)).toEqual([]);
  });

  it("ignores an import-like string literal", () => {
    expect(collect(`const s = 'import { mint } from "./secret.js"';`)).toEqual([]);
  });

  it("ignores a same-named local identifier that is never imported", () => {
    expect(collect(`const mint = 1; export function make() { return mint; }`)).toEqual([]);
  });

  it("ignores a `require`-named binding used as a value, not a call", () => {
    expect(collect(`const require = 1; const y = require;`)).toEqual([]);
  });

  it("still returns UNRELATED imports (the invariant filters by name+target, not the collector)", () => {
    const ref = only(`import { Unrelated } from "./other.js";`);
    expect(ref.originalName).toBe("Unrelated");
    expect(ref.target).toEqual(expectedTarget("other"));
  });
});

describe("module-reference collector -- fails closed on malformed source", () => {
  it("throws on a syntactically malformed import rather than returning a partial set", () => {
    expect(() => collect(`import { mint } from ;`)).toThrow(/malformed source/);
  });
});

describe("moduleExportsSymbol -- local runtime export detection (AST, top-level only)", () => {
  const exportsMint = (src: string): boolean => moduleExportsSymbolFromSource(FILE, src, "mint");

  it("detects an exported function / async function / class / const declaration", () => {
    expect(exportsMint(`export function mint() {}`)).toBe(true);
    expect(exportsMint(`export async function mint() {}`)).toBe(true);
    expect(exportsMint(`export class mint {}`)).toBe(true);
    expect(exportsMint(`export const mint = () => {};`)).toBe(true);
  });

  it("detects an exported destructuring binding (object and array patterns)", () => {
    expect(exportsMint(`export const { mint } = factories;`)).toBe(true);
    expect(exportsMint(`export const [mint] = factories;`)).toBe(true);
  });

  it("detects a local export list and an aliased local export", () => {
    expect(exportsMint(`function mint() {}\nexport { mint };`)).toBe(true);
    expect(exportsMint(`function local() {}\nexport { local as mint };`)).toBe(true);
  });

  it("does NOT count an export nested inside a namespace (not a module binding)", () => {
    expect(exportsMint(`namespace N { export function mint() {} }`)).toBe(false);
  });

  it("does NOT count a type-only export (privileged symbols are runtime)", () => {
    expect(exportsMint(`type Local = {}; export type { Local as mint };`)).toBe(false);
    expect(exportsMint(`const Local = 1; export { type Local as mint };`)).toBe(false);
  });

  it("does NOT count a re-export FROM another module as a local export", () => {
    expect(exportsMint(`export { mint } from "./secret.js";`)).toBe(false);
  });

  it("does NOT count a mere import, an unexported declaration, or an unrelated export", () => {
    expect(exportsMint(`import { mint } from "./secret.js";`)).toBe(false);
    expect(exportsMint(`const mint = 1;`)).toBe(false);
    expect(exportsMint(`export function other() {}`)).toBe(false);
  });
});
