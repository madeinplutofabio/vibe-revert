// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M H8.2: docs/session-format.md light version-constant invariant. The
// INDEPENDENT schema-version constants exported by @viberevert/session-format are
// the authority. The doc's version table is located by its EXACT header, required
// to have three columns per row with backtick-quoted constant names + values and
// no duplicate constant rows; a malformed row fails loud rather than being
// skipped. The documented constant set must equal the exported set exactly (both
// directions) and each documented value must equal the imported constant. This
// checks ONLY the version constants -- not field-level schema shape.
//
// M 0.8.0: the constant set is now DERIVED from the barrel rather than written
// out by hand. The hand-written list was a silent-drift hole: adding a new
// exported version constant left this test green while the doc went stale, which
// is exactly what happened when the 0.8 schema substrate landed three new axes.
// Deriving it means a future axis forces a doc row on the commit that introduces
// it, which is the invariant this file was supposed to provide all along.
//
// The derivation matches on NAME ONLY. Filtering on `typeof value === "string"`
// would look tidier and would be wrong: a future `FOO_SCHEMA_VERSION = 1` would
// silently vanish from the derived set, and the string-value assertion below --
// the one whose whole job is to catch that -- would never see it.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as sessionFormat from "../src/index.js";

const DOC = readFileSync(new URL("../../../docs/session-format.md", import.meta.url), "utf8");

// Matches `SCHEMA_VERSION` itself and every `*_SCHEMA_VERSION` axis. The leading
// `(?:^|_)` is what admits the bare `SCHEMA_VERSION`, whose name does not carry
// the suffix form; it is the member most likely to be lost to a careless tweak
// of this pattern, so it is asserted present on its own below.
const VERSION_CONSTANT_NAME = /(?:^|_)SCHEMA_VERSION$/;

// The exported schema-version constants, keyed by exported NAME. The version
// table cites the name, so drift in a value or in the documented set is caught.
const CONSTANTS: Record<string, unknown> = Object.fromEntries(
  Object.entries(sessionFormat).filter(([name]) => VERSION_CONSTANT_NAME.test(name)),
);

const REQUIRED_HEADER = ["Format axis", "Version constant", "Current version"] as const;
const SEPARATOR_CELL = /^:?-{1,}:?$/;
const CODE_CELL = /^`([^`]+)`$/;

function rowCells(line: string): string[] {
  return line
    .trim()
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

interface VersionRow {
  readonly name: string;
  readonly version: string;
}

// Locate the version table by its EXACT header, enforce a 3-column separator and
// 3-column backtick-quoted body rows, and fail loud on any malformed row.
function parseVersionTable(md: string): VersionRow[] {
  const lines = md.split(/\r?\n/);
  const cols = REQUIRED_HEADER.length;

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) {
      continue;
    }
    const cells = rowCells(line);
    if (cells.length === cols && cells.every((c, j) => c === REQUIRED_HEADER[j])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(
      `session-format.md: no version table with header | ${REQUIRED_HEADER.join(" | ")} |`,
    );
  }

  const sepCells = rowCells(lines[headerIdx + 1] ?? "");
  if (sepCells.length !== cols || !sepCells.every((c) => SEPARATOR_CELL.test(c))) {
    throw new Error("session-format.md: version table separator row is malformed");
  }

  const rows: VersionRow[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) {
      break;
    }
    const cells = rowCells(line);
    if (cells.length !== cols) {
      throw new Error(`session-format.md: version row is not ${cols} columns: "${line.trim()}"`);
    }
    const name = CODE_CELL.exec(cells[1] ?? "")?.[1];
    const version = CODE_CELL.exec(cells[2] ?? "")?.[1];
    if (name === undefined) {
      throw new Error(`session-format.md: constant name not backtick-quoted: "${line.trim()}"`);
    }
    if (version === undefined) {
      throw new Error(`session-format.md: version value not backtick-quoted: "${line.trim()}"`);
    }
    rows.push({ name, version });
  }
  return rows;
}

const ROWS = parseVersionTable(DOC);

describe("the derived constant set is the authority", () => {
  it("finds constants at all", () => {
    // Guards the derivation itself. Without this, a pattern that matched nothing
    // would turn every assertion below into a comparison of two empty sets, and
    // the whole file would pass while checking nothing.
    expect(Object.keys(CONSTANTS).length).toBeGreaterThan(0);
  });

  it("includes the bare SCHEMA_VERSION, not only the suffixed axes", () => {
    expect(CONSTANTS).toHaveProperty("SCHEMA_VERSION");
  });

  it("derives only string values", () => {
    // Reachable precisely because the derivation matches on name alone.
    for (const [name, value] of Object.entries(CONSTANTS)) {
      expect(value, `${name} must be a string version`).toBeTypeOf("string");
      expect((value as string).length, `${name} must not be blank`).toBeGreaterThan(0);
    }
  });
});

describe("session-format.md version table matches the exported schema-version constants", () => {
  it("has no duplicate constant rows", () => {
    const names = ROWS.map((r) => r.name);
    const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    expect(duplicates, "session-format.md version table has duplicate constant rows").toEqual([]);
  });

  it("documents exactly the exported schema-version constants", () => {
    expect(ROWS.map((r) => r.name).sort()).toEqual(Object.keys(CONSTANTS).sort());
  });

  it.each(
    Object.entries(CONSTANTS),
  )("%s is documented with its exact current value", (name, value) => {
    const row = ROWS.find((r) => r.name === name);
    expect(row, `session-format.md must document ${name}`).toBeDefined();
    expect(row?.version, `session-format.md must list ${name} = ${String(value)}`).toBe(value);
  });
});
