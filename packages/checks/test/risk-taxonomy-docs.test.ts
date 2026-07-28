// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M H8.2: docs/risk-taxonomy.md coverage invariant. THREE explicit authorities:
//   (1) the risk-level table       <-> RiskLevelSchema.options   (ordered);
//   (2) the confidence table        <-> ConfidenceSchema.options  (ordered);
//   (3) the config->category mapping <-> CHECKS_TOGGLE_MAP.
// Engine-only ("summary") and reserved categories have no stable code authority
// (they live in comments), so they are prose and NOT machine-checked. Every table
// is located by its EXACT header, enforces column count, requires backtick-quoted
// tokens, rejects duplicate rows, and fails loud on malformed rows. Config keys
// must carry the "checks." prefix explicitly, and a mapping row may not repeat a
// category.

import { readFileSync } from "node:fs";

import { ConfidenceSchema, RiskLevelSchema } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { CHECKS_TOGGLE_MAP } from "../src/registry.js";

const DOC = readFileSync(new URL("../../../docs/risk-taxonomy.md", import.meta.url), "utf8");

const SEPARATOR_CELL = /^:?-{1,}:?$/;
const CODE = /`([^`]+)`/g;
const CHECKS_PREFIX = "checks.";

function rowCells(line: string): string[] {
  return line
    .trim()
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

function codeTokens(cell: string): string[] {
  return [...cell.matchAll(CODE)].map((m) => m[1] ?? "");
}

// Body rows (arrays of trimmed cells) of the table whose header EXACTLY matches.
// Enforces the column count on the separator and every body row; a malformed row
// throws rather than being skipped.
function tableRows(md: string, header: readonly string[]): string[][] {
  const lines = md.split(/\r?\n/);
  const cols = header.length;

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) {
      continue;
    }
    const cells = rowCells(line);
    if (cells.length === cols && cells.every((c, j) => c === header[j])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(`risk-taxonomy.md: no table with header | ${header.join(" | ")} |`);
  }

  const sep = rowCells(lines[headerIdx + 1] ?? "");
  if (sep.length !== cols || !sep.every((c) => SEPARATOR_CELL.test(c))) {
    throw new Error(`risk-taxonomy.md: malformed separator under | ${header.join(" | ")} |`);
  }

  const rows: string[][] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) {
      break;
    }
    const cells = rowCells(line);
    if (cells.length !== cols) {
      throw new Error(`risk-taxonomy.md: row is not ${cols} columns: "${line.trim()}"`);
    }
    rows.push(cells);
  }
  return rows;
}

function singleToken(cell: string, ctx: string): string {
  const tokens = codeTokens(cell);
  if (tokens.length !== 1) {
    throw new Error(`risk-taxonomy.md: expected one backtick token in ${ctx}, got "${cell}"`);
  }
  return tokens[0] ?? "";
}

function duplicatesOf(values: readonly string[]): string[] {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

function expectSameSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const have = new Set(actual);
  const want = new Set(expected);
  const missing = [...want].filter((x) => !have.has(x));
  const ghost = [...have].filter((x) => !want.has(x));
  expect(
    { missing, ghost },
    `${label}: missing ${JSON.stringify(missing)}, ghost ${JSON.stringify(ghost)}`,
  ).toEqual({ missing: [], ghost: [] });
}

// Authority 1: risk levels (ordered) <-> RiskLevelSchema
const DOC_LEVELS = tableRows(DOC, ["Level", "What it means"]).map((r) =>
  singleToken(r[0] ?? "", "Level cell"),
);

// Authority 2: confidence (ordered) <-> ConfidenceSchema
const DOC_CONFIDENCE = tableRows(DOC, ["Confidence", "Meaning"]).map((r) =>
  singleToken(r[0] ?? "", "Confidence cell"),
);

// Authority 3: config -> category mapping <-> CHECKS_TOGGLE_MAP
const DOC_MAP = tableRows(DOC, ["Config key", "Emitted categories"]).map((r) => {
  const documentedKey = singleToken(r[0] ?? "", "Config key cell");
  if (!documentedKey.startsWith(CHECKS_PREFIX)) {
    throw new Error(`risk-taxonomy.md: config key must start with "checks.": ${documentedKey}`);
  }
  const key = documentedKey.slice(CHECKS_PREFIX.length);
  const cats = codeTokens(r[1] ?? "");
  if (cats.length === 0) {
    throw new Error(`risk-taxonomy.md: mapping row for checks.${key} lists no categories`);
  }
  const duplicateCategories = duplicatesOf(cats);
  if (duplicateCategories.length > 0) {
    throw new Error(
      `risk-taxonomy.md: checks.${key} repeats categories: ${JSON.stringify(duplicateCategories)}`,
    );
  }
  return { key, cats };
});

describe("risk-taxonomy.md risk levels match RiskLevelSchema", () => {
  it("documents the risk levels in exact schema order", () => {
    expect(DOC_LEVELS).toEqual([...RiskLevelSchema.options]);
  });
});

describe("risk-taxonomy.md confidence levels match ConfidenceSchema", () => {
  it("documents the confidence levels in exact schema order", () => {
    expect(DOC_CONFIDENCE).toEqual([...ConfidenceSchema.options]);
  });
});

describe("risk-taxonomy.md config-to-category mapping matches CHECKS_TOGGLE_MAP", () => {
  it("has no duplicate config-key rows", () => {
    expect(
      duplicatesOf(DOC_MAP.map((r) => r.key)),
      "risk-taxonomy.md mapping has duplicate config-key rows",
    ).toEqual([]);
  });

  it("documents exactly the CHECKS_TOGGLE_MAP config keys", () => {
    expectSameSet(
      DOC_MAP.map((r) => r.key),
      Object.keys(CHECKS_TOGGLE_MAP),
      "config keys",
    );
  });

  it.each(
    Object.keys(CHECKS_TOGGLE_MAP),
  )("checks.%s maps to exactly its emitted categories", (key) => {
    const row = DOC_MAP.find((r) => r.key === key);
    expect(row, `risk-taxonomy.md mapping missing for checks.${key}`).toBeDefined();
    expectSameSet(row?.cats ?? [], CHECKS_TOGGLE_MAP[key] ?? [], `checks.${key} categories`);
  });
});
