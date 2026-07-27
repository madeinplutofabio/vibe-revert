// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M H8.1: docs/commands.md coverage invariant. The CLI's own registration
// surface is the authority: the canonical inventory is derived from
// REGISTERED_COMMANDS[*].paths (all invokable paths, incl. `mcp serve` and the
// version-flag aliases that definitions() collapses) plus buildCli().definitions()
// (public options + positionals, hidden options already excluded by Clipanion).
// commands.md is parsed by LABELLED subsection only -- never by scanning prose --
// and asserted to match the canonical inventory EXACTLY in both directions. A
// separate presentation oracle confirms cli.usage(class,{detailed}) surfaces each
// public token (so metadata that Clipanion accidentally hid would still fail).

import { readFileSync } from "node:fs";

import { Builtins } from "clipanion";
import { describe, expect, it } from "vitest";

import { buildCli, REGISTERED_COMMANDS } from "../src/build-cli.js";

const BINARY = "viberevert";
const COMMANDS_MD = readFileSync(new URL("../../../docs/commands.md", import.meta.url), "utf8");

// ===========================================================================
// Canonical inventory (authority: the CLI's own registrations + definitions)
// ===========================================================================

interface PublicCommandDefinition {
  readonly primaryPath: string;
  readonly alternatePaths: readonly string[];
  readonly options: readonly string[];
  readonly positionals: readonly string[];
}

// The flag-spec is the first whitespace token of a Clipanion `definition`; split
// on "," for combined short/long spellings; the `#N` value placeholder is not
// part of an option NAME.
function parseOptionSpellings(definition: string): string[] {
  const flagSpec = definition.trim().split(/\s+/)[0] ?? "";
  return flagSpec.split(",").filter((s) => s.startsWith("-"));
}

// A positional is the usage line minus the command path prefix, kept WHOLE
// (`<session>`, `<arg> ...`).
function parsePositionals(usage: string, path: string): string[] {
  const rest = usage.startsWith(path) ? usage.slice(path.length).trim() : usage.trim();
  return rest.length > 0 ? [rest] : [];
}

function buildCanonicalInventory(): PublicCommandDefinition[] {
  const cli = buildCli();
  const defByPath = new Map(cli.definitions().map((d) => [d.path, d]));
  return REGISTERED_COMMANDS.map((CommandClass) => {
    const paths = (CommandClass.paths ?? []).map((segments) => segments.join(" "));
    const primaryPath = paths[0] ?? "";
    const def = defByPath.get(`${BINARY} ${primaryPath}`);
    return {
      primaryPath,
      alternatePaths: paths.slice(1),
      options: def ? (def.options ?? []).flatMap((o) => parseOptionSpellings(o.definition)) : [],
      positionals: def ? parsePositionals(def.usage, def.path) : [],
    };
  });
}

const CANONICAL = buildCanonicalInventory();
const HELP_OPTIONS = Builtins.HelpCommand.paths.flat(); // [["-h"],["--help"]] -> ["-h","--help"]

// ===========================================================================
// commands.md parse (LABELLED subsections only)
// ===========================================================================

interface DocSection {
  readonly primaryPath: string;
  readonly options: string[];
  readonly alternatePaths: string[];
  readonly positionals: string[];
}

const COMMAND_HEADING = /^### `viberevert (.+?)`\s*$/;
const ANY_HEADING = /^#{2,3}\s/;
const BOLD_LABEL = /^\*\*(.+?)\*\*\s*$/;
const BULLET_CODE = /^-\s+`([^`]+)`/;

function parseCommandsMd(md: string): { sections: DocSection[]; helpSection: string } {
  const lines = md.split(/\r?\n/);

  // The `## Getting help` block (global forms live here, not in command sections).
  const helpIdx = lines.findIndex((l) => /^##\s+Getting help\s*$/.test(l));
  let helpSection = "";
  if (helpIdx >= 0) {
    const buf: string[] = [];
    for (let j = helpIdx + 1; j < lines.length && !ANY_HEADING.test(lines[j] ?? ""); j++) {
      buf.push(lines[j] ?? "");
    }
    helpSection = buf.join("\n");
  }

  const sections: DocSection[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = COMMAND_HEADING.exec(lines[i] ?? "");
    if (heading === null) {
      continue;
    }
    const primaryPath = heading[1] ?? "";
    const options: string[] = [];
    const alternatePaths: string[] = [];
    const positionals: string[] = [];
    // Only bullets under a recognized labelled block are collected; any other
    // bold label (e.g. **Behavior and constraints**) clears the active label so
    // prose/behavior bullets are never mistaken for API declarations.
    let label: "Options" | "Alternate invocations" | "Arguments" | null = null;
    for (let j = i + 1; j < lines.length && !ANY_HEADING.test(lines[j] ?? ""); j++) {
      const line = lines[j] ?? "";
      const boldLabel = BOLD_LABEL.exec(line);
      if (boldLabel !== null) {
        const name = boldLabel[1]?.trim();
        label =
          name === "Options" || name === "Alternate invocations" || name === "Arguments"
            ? name
            : null;
        continue;
      }
      const bullet = BULLET_CODE.exec(line);
      if (bullet === null || label === null) {
        continue;
      }
      const code = (bullet[1] ?? "").trim();
      if (label === "Options") {
        options.push(code.split(/\s+/)[0] ?? "");
      } else if (label === "Alternate invocations") {
        alternatePaths.push(code.startsWith(`${BINARY} `) ? code.slice(BINARY.length + 1) : code);
      } else {
        positionals.push(code);
      }
    }
    sections.push({ primaryPath, options, alternatePaths, positionals });
  }

  return { sections, helpSection };
}

const DOC = parseCommandsMd(COMMANDS_MD);
const docByPath = new Map(DOC.sections.map((s) => [s.primaryPath, s]));

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
    `${label}: commands.md must match the canonical CLI surface exactly. Missing from doc: ${JSON.stringify(missingFromDoc)}; documented but not real (ghost): ${JSON.stringify(ghostInDoc)}.`,
  ).toEqual({ missingFromDoc: [], ghostInDoc: [] });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("commands.md coverage (bidirectional vs the CLI surface)", () => {
  it("documents exactly the canonical set of command primary paths", () => {
    expectSameSet(
      DOC.sections.map((s) => s.primaryPath),
      CANONICAL.map((c) => c.primaryPath),
      "command primary paths",
    );
  });

  it.each(
    CANONICAL.map((c) => [c.primaryPath, c] as const),
  )("%s: documented options / positionals / alternate invocations match exactly", (primaryPath, canonical) => {
    const doc = docByPath.get(primaryPath);
    expect(doc, `commands.md has no section for \`viberevert ${primaryPath}\``).toBeDefined();
    if (doc === undefined) {
      return;
    }
    expectSameSet(doc.options, canonical.options, `${primaryPath} options`);
    expectSameSet(doc.positionals, canonical.positionals, `${primaryPath} positionals`);
    expectSameSet(doc.alternatePaths, canonical.alternatePaths, `${primaryPath} alternate paths`);
  });

  it("documents the global help forms only under `## Getting help`", () => {
    for (const helpOption of HELP_OPTIONS) {
      expect(
        DOC.helpSection.includes(helpOption),
        `\`## Getting help\` must document ${helpOption}`,
      ).toBe(true);
    }
    for (const section of DOC.sections) {
      for (const helpOption of HELP_OPTIONS) {
        expect(
          section.options.includes(helpOption),
          `\`${section.primaryPath}\` must not document the global ${helpOption} as a command option`,
        ).toBe(false);
      }
    }
  });

  it("never documents the hidden --llm flag", () => {
    expect(
      COMMANDS_MD.includes("--llm"),
      "commands.md must not mention the hidden --llm flag",
    ).toBe(false);
  });
});

describe("commands.md presentation oracle (cli.usage matches user-visible help)", () => {
  const cli = buildCli();
  it.each(
    REGISTERED_COMMANDS.map((C) => [C.paths?.[0]?.join(" ") ?? "", C] as const),
  )("%s: rendered help contains every public option spelling + positional label", (primaryPath, CommandClass) => {
    const canonical = CANONICAL.find((c) => c.primaryPath === primaryPath);
    expect(canonical, `no canonical entry for ${primaryPath}`).toBeDefined();
    if (canonical === undefined) {
      return;
    }
    const help = cli.usage(CommandClass, { detailed: true });
    for (const option of canonical.options) {
      expect(help.includes(option), `usage(${primaryPath}) must render option ${option}`).toBe(
        true,
      );
    }
    for (const positional of canonical.positionals) {
      const token = positional.split(/\s+/)[0] ?? positional;
      expect(help.includes(token), `usage(${primaryPath}) must render positional ${token}`).toBe(
        true,
      );
    }
  });
});
