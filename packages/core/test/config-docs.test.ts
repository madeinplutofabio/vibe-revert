// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M H8.1: docs/config.md coverage invariant. ConfigSchema is the authority. A
// fail-loud structural walk of ConfigSchema (Zod 4.4.1) derives the canonical
// user-settable surface: 23 assignable leaf keys + 7 parent containers. The node
// shapes were inspected before writing this walker; it supports only the shapes
// ConfigSchema actually uses and throws (with the dotted path + encountered
// constructor name) on anything else, so a later schema change to an unhandled
// shape fails loud instead of silently dropping a key. Constructor NAMES (not
// instanceof) are the discriminator: RiskLevelSchema originates in
// @viberevert/session-format, which may resolve a distinct zod instance, and
// ZodArray also exposes .unwrap() -- both defeat instanceof/unwrap heuristics but
// not a name check. docs/config.md is parsed by its "Key" tables only (first cell
// of each data row), asserted free of duplicate rows, then matched to the
// canonical leaf-key set EXACTLY in both directions; containers get a separate
// presence check (cumulative dotted prefixes, so nested containers stay covered).

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ConfigSchema } from "../src/config.js";

const CONFIG_MD = readFileSync(new URL("../../../docs/config.md", import.meta.url), "utf8");

// ===========================================================================
// Canonical surface (authority: a fail-loud structural walk of ConfigSchema)
// ===========================================================================

// Minimal structural views of the zod nodes ConfigSchema uses. Reading
// constructor.name keeps this independent of which zod instance built each node.
interface ObjectNodeLike {
  readonly shape: Record<string, unknown>;
}
interface OptionalNodeLike {
  unwrap(): unknown;
}

const OPTIONAL = "ZodOptional";
const OBJECT = "ZodObject";
// The leaf node shapes actually present in ConfigSchema (verified by inspection):
// ZodLiteral (version, llm.enabled), ZodString (profile, project.*), ZodEnum
// (risk.*), ZodArray (frameworks, policies, rollback.exclude, commands.*,
// verify.commands), ZodBoolean (checks.*, rollback.enabled/include_untracked).
const LEAF_CTORS = new Set(["ZodString", "ZodBoolean", "ZodLiteral", "ZodEnum", "ZodArray"]);

// Defensive: an unexpected/malformed node still yields our own fail-loud
// diagnostics (e.g. "... : undefined") rather than a TypeError in the accessor.
function nameOf(node: unknown): string {
  if (
    node === null ||
    (typeof node !== "object" && typeof node !== "function") ||
    typeof (node as { constructor?: { name?: unknown } }).constructor?.name !== "string"
  ) {
    return typeof node;
  }
  return (node as { constructor: { name: string } }).constructor.name;
}

interface WalkResult {
  readonly leaves: string[];
  readonly containers: string[];
}

function walkConfigSchema(objectNode: ObjectNodeLike, prefix: string, acc: WalkResult): void {
  for (const [key, field] of Object.entries(objectNode.shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // ConfigSchema currently wraps each optional field in one ZodOptional. Unwrap
    // by NAME, not by .unwrap presence -- ZodArray also has .unwrap(). A future
    // stacked wrapper is intentionally unsupported and fails loud below.
    const node: unknown = nameOf(field) === OPTIONAL ? (field as OptionalNodeLike).unwrap() : field;
    const name = nameOf(node);
    if (name === OBJECT) {
      acc.containers.push(path);
      walkConfigSchema(node as ObjectNodeLike, path, acc);
    } else if (LEAF_CTORS.has(name)) {
      acc.leaves.push(path);
    } else {
      throw new Error(`unsupported ConfigSchema node at ${path}: ${name}`);
    }
  }
}

// Narrow root assertion so a future wrapper/composition around the root fails
// with the same actionable diagnostics rather than a blind cast.
const rootName = nameOf(ConfigSchema);
if (rootName !== OBJECT) {
  throw new Error(`unsupported ConfigSchema root: ${rootName}`);
}

const WALK: WalkResult = { leaves: [], containers: [] };
walkConfigSchema(ConfigSchema as unknown as ObjectNodeLike, "", WALK);
const CANONICAL_LEAF_KEYS = WALK.leaves;
const CANONICAL_CONTAINERS = WALK.containers;

// ===========================================================================
// docs/config.md parse ("Key" tables only)
// ===========================================================================

const SEPARATOR_CELL = /^:?-{1,}:?$/;
const CODE_CELL = /^`([^`]+)`$/;

// Cells of a `| a | b | c |` line, trimmed (outer empties dropped).
function rowCells(line: string): string[] {
  return line
    .trim()
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

// The backtick-quoted token in the FIRST cell of every data row of every table
// whose header first cell is exactly "Key". Only the first cell is read, so
// Type/Default/Notes backticks and prose are never mistaken for keys.
function parseDocumentedKeys(md: string): string[] {
  const keys: string[] = [];
  let state: "outside" | "await-separator" | "in-body" = "outside";
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      state = "outside";
      continue;
    }
    const cells = rowCells(line);
    const first = cells[0] ?? "";
    if (state === "outside") {
      state = first === "Key" ? "await-separator" : "outside";
      continue;
    }
    if (state === "await-separator") {
      state = cells.every((c) => SEPARATOR_CELL.test(c)) ? "in-body" : "outside";
      continue;
    }
    // state === "in-body": a data row.
    const match = CODE_CELL.exec(first);
    if (match?.[1] !== undefined) {
      keys.push(match[1]);
    }
  }
  return keys;
}

const DOCUMENTED_KEYS = parseDocumentedKeys(CONFIG_MD);

// Every cumulative dotted prefix of a key (`a.b.c` -> `a`, `a.b`), so nested
// containers are derived on both sides identically.
function containerPrefixes(key: string): string[] {
  const parts = key.split(".");
  const prefixes: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    prefixes.push(parts.slice(0, i).join("."));
  }
  return prefixes;
}

// Exact set equality with a directional diff message.
function expectSameSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const have = new Set(actual);
  const want = new Set(expected);
  const missingFromDoc = [...want].filter((x) => !have.has(x));
  const ghostInDoc = [...have].filter((x) => !want.has(x));
  expect(
    { missingFromDoc, ghostInDoc },
    `${label}: docs/config.md must match ConfigSchema exactly. Missing from doc: ${JSON.stringify(missingFromDoc)}; documented but not in schema (ghost): ${JSON.stringify(ghostInDoc)}.`,
  ).toEqual({ missingFromDoc: [], ghostInDoc: [] });
}

function duplicatesOf(values: readonly string[]): string[] {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

// ===========================================================================
// Tests
// ===========================================================================

describe("config.md coverage (bidirectional vs ConfigSchema)", () => {
  it("documents each config key exactly once (no duplicate rows)", () => {
    expect(
      duplicatesOf(DOCUMENTED_KEYS),
      "docs/config.md contains duplicate config-key rows",
    ).toEqual([]);
  });

  it("derives duplicate-free canonical leaf keys and containers from the schema", () => {
    // A strict object schema cannot produce duplicate paths, but the walker's
    // output is asserted unique before it is used as an oracle.
    expect(
      duplicatesOf(CANONICAL_LEAF_KEYS),
      "ConfigSchema walker produced duplicate leaf keys",
    ).toEqual([]);
    expect(
      duplicatesOf(CANONICAL_CONTAINERS),
      "ConfigSchema walker produced duplicate container paths",
    ).toEqual([]);
  });

  it("documents exactly the schema's user-settable leaf keys", () => {
    expectSameSet(DOCUMENTED_KEYS, CANONICAL_LEAF_KEYS, "config leaf keys");
  });

  it("documents exactly the schema's parent containers (separate presence check)", () => {
    const documentedContainers = [...new Set(DOCUMENTED_KEYS.flatMap(containerPrefixes))];
    expectSameSet(documentedContainers, CANONICAL_CONTAINERS, "config parent containers");
  });
});
