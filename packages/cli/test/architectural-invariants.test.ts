// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Architectural-invariants tests.
//
// Grep-based tests that enforce locked architectural invariants -- they
// catch regressions where source code drifts from a contractual
// constraint that's not enforced by TypeScript types or runtime checks.
// Each invariant references the originating M B plan section / decision
// lock so future readers can see WHY the constraint exists.
//
// All tests in this file READ source code via node:fs and assert on
// content patterns. They do not run the source code; they don't need a
// fixture or a temp dir. Fast (sub-100ms) and tightly scoped.
//
// File location (in cli/test/, not git/test/) is intentional per the
// M B plan's literal specification -- and pragmatic, since cli is the
// orchestration layer that depends on all the others, so making cli's
// test suite responsible for verifying workspace-wide invariants is
// the right place for this kind of cross-cutting check.
//
// Comment-line filtering: each invariant uses the `findOffenders`
// helper to skip line-comments (`//`), block-comment bodies
// (`/* ... */`), AND JSDoc continuation lines (lines whose trimmed
// start is `*` or `*/`) before regex matching. Reason: file-header
// docs and JSDoc blocks in our sources LITERALLY mention antipatterns
// to document them (e.g., restore.ts says `// NOT Readable.from(buf)`,
// receipt renderers may have `/** @returns ... */` mentioning forbidden
// types), and a naive grep would flag those as violations.
//
// Adding a new invariant: add a new `it()` block, read the relevant
// file(s), grep for the antipattern via `findOffenders`, assert empty.
// Always cite the plan/decision lock that motivates the invariant.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

function readSource(relPathFromRepoRoot: string): string {
  return readFileSync(join(REPO_ROOT, relPathFromRepoRoot), "utf8");
}

/**
 * Recursively find all *.ts files under `dir`. Skips node_modules and
 * dist directories defensively, though they wouldn't contain our source
 * files anyway.
 */
function findTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      result.push(...findTsFiles(full));
    } else if (extname(entry) === ".ts") {
      result.push(full);
    }
  }
  return result;
}

interface Offender {
  readonly lineNumber: number;
  readonly content: string;
}

/**
 * Return all lines in `source` that match `pattern`, with their original
 * 1-indexed line numbers. Skips comment lines so file-header docs and
 * JSDoc blocks that mention antipatterns by literal text don't trigger
 * false positives. Three comment forms are filtered:
 *
 *   - Line comments: trimmed start === "//"
 *   - Block comments: from a line containing "/*" through the line
 *     containing "*\/" (inclusive on both ends)
 *   - JSDoc continuation lines inside a block comment: trimmed start
 *     === "*" or "*\/" (handled by the in-block-comment branch above,
 *     but also defensively filtered for safety against non-standard
 *     comment shapes that don't start with /*)
 *
 * The block-comment tracking is stateful across the .filter() callback
 * -- `inBlockComment` persists between iterations because the filter
 * runs sequentially over the lines array.
 */
function findOffenders(source: string, pattern: RegExp): Offender[] {
  let inBlockComment = false;
  return source
    .split("\n")
    .map((line, idx) => ({ line, lineNumber: idx + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      // If we're inside a block comment, skip the line and check
      // whether this line closes the comment.
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        return false;
      }
      // Standalone line comment.
      if (trimmed.startsWith("//")) return false;
      // Block-comment opener. If it doesn't also close on the same
      // line, enter block-comment mode for subsequent lines.
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        return false;
      }
      // JSDoc continuation line (* or */ at trimmed start) -- should
      // already be covered by the inBlockComment branch above, but
      // defensive belt-and-suspenders catch for non-standard shapes.
      if (trimmed.startsWith("*")) return false;
      return true;
    })
    .filter(({ line }) => pattern.test(line))
    .map(({ line, lineNumber }) => ({ lineNumber, content: line.trim() }));
}

/**
 * Locate the CLI binary's single multi-line import statement from
 * `@viberevert/cli-commands` and return its named-imports body (the
 * comma-separated symbol list between the braces). Used by the M E
 * command-exposure and M F D98.M.9 hook-exposure invariants to
 * verify specific Command classes appear in the barrel import
 * exactly once each.
 *
 * Asserts there is exactly one such import statement; failure here
 * means a future maintainer split the barrel import into multiple
 * statements OR removed it entirely (M G1a Step 1 substep 9 lock).
 */
function getCliCommandsBarrelImportBody(source: string): string {
  const matches = [
    ...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']@viberevert\/cli-commands["']/g),
  ];
  expect(
    matches.length,
    `packages/cli/src/index.ts must have exactly one @viberevert/cli-commands import statement (M G1a Step 1 substep 9). Found ${matches.length}.`,
  ).toBe(1);
  return matches[0]?.[1] ?? "";
}

/**
 * Strip TypeScript line comments and block comments from a source
 * string. Used by invariants that run regex / substring checks on
 * full source where a documentation comment mention of an antipattern
 * would otherwise false-positive.
 *
 * Block-comment replacement preserves newline characters so the
 * stripped string's line numbering matches the original -- important
 * for callers that pass the stripped output through `findOffenders`,
 * which reports 1-indexed line numbers from offender content.
 *
 * Known limitation: this is regex-based, not a TypeScript parser.
 * A forbidden token literally appearing inside a string literal can
 * still trip substring checks. None of the architectural invariants
 * below forbid tokens that realistically appear in legitimate string
 * literals or stderr templates, so this is acceptable.
 */
function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, "$1");
}

/**
 * Parse the cli-commands barrel for the union of named symbols it
 * re-exports. Used by D99.M.19 (present + absent checks) and
 * D99.M.21c (lock-constant defense-in-depth) to assert the public
 * surface of the package boundary.
 *
 * Comment stripping (delegated to `stripTsComments`) is critical
 * because the barrel's bottom "Intentionally NOT exported" doc block
 * literally mentions the forbidden symbols by name. Without
 * stripping, those documentation mentions would falsely register
 * as exports.
 *
 * Handles three export shapes:
 *   - `export { a, b as c, type d } from "..."`
 *   - `export type { a } from "..."`
 *   - `export function foo(...)` / `export const foo = ...` / etc.
 *
 * For `X as Y` re-exports, registers the EXPORTED name Y.
 */
function collectBarrelExports(barrelSource: string): Set<string> {
  const stripped = stripTsComments(barrelSource);

  const exported = new Set<string>();

  const braceMatches = stripped.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}/g);
  for (const match of braceMatches) {
    const body = match[1] ?? "";
    for (const raw of body.split(",")) {
      let symbol = raw.trim();
      if (!symbol) continue;
      symbol = symbol.replace(/^type\s+/, "");
      const asMatch = symbol.match(/^(\w+)\s+as\s+(\w+)$/);
      const renamedTo = asMatch?.[2];
      if (renamedTo) {
        exported.add(renamedTo);
      } else if (/^\w+$/.test(symbol)) {
        exported.add(symbol);
      }
    }
  }

  const directMatches = stripped.matchAll(
    /(?:^|\n)\s*export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface)\s+(\w+)/g,
  );
  for (const match of directMatches) {
    if (match[1]) exported.add(match[1]);
  }

  return exported;
}

describe("Architectural invariants -- git invocation single-owner (D17c)", () => {
  // The git binary may only be invoked from @viberevert/git. Other
  // packages (including the CLI) reach for git via @viberevert/git's
  // public helpers (probeGitVersion, getStatusPorcelainText, etc.).
  // doctor.ts is a NARROW carve-out: it is allowed to spawn non-git
  // diagnostic binaries (pnpm), but MUST NOT spawn git directly.

  it('doctor.ts does NOT pass the literal "git" to spawn family functions or to its local probeVersion helper', () => {
    // The git probe in doctor.ts must go through @viberevert/git's
    // probeGitVersion() helper. This grep catches accidental regressions
    // where someone reintroduces a direct spawn of "git" from doctor --
    // OR re-routes it through the local `probeVersion` helper (which
    // was the actual historical regression path we fixed in M B Step 3f
    // when we swapped `probeVersion("git")` for `await probeGitVersion()`).
    //
    // Maintenance note: the `probeVersion` regex is specific to
    // doctor.ts's CURRENT helper name. If a future change renames that
    // helper, this regex stops protecting against the historical
    // regression. That's acceptable because any such rename is a
    // structural change inviting fresh review -- but the maintainer
    // should update this regex (or remove it if `probeVersion` is
    // also removed) at the same time as the rename.
    const source = readSource("packages/cli-commands/src/commands/doctor.ts");
    const antipatterns: ReadonlyArray<RegExp> = [
      /spawnSync\s*\(\s*["']git["']/,
      /\bspawn\s*\(\s*["']git["']/,
      /execFile\s*\(\s*["']git["']/,
      /execFileSync\s*\(\s*["']git["']/,
      /\bprobeVersion\s*\(\s*["']git["']/,
    ];
    for (const pattern of antipatterns) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `doctor.ts must not spawn git directly. Matches for ${pattern}: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  it("packages/cli-commands/src/**/*.ts (excluding doctor.ts, run.ts, and shell.ts) does NOT import child_process", () => {
    // doctor.ts is the locked carve-out for diagnostic binary probing.
    // run.ts is the D102.M.1 carve-out (M G2): `viberevert run`'s whole
    // purpose is spawning exactly ONE wrapped child (D102.A); its spawn
    // shape is separately locked by D102.M.3. shell.ts is the D103.M.1
    // carve-out (M G3): `viberevert shell`'s guarded REPL spawns each
    // accepted command as one child; its spawn shape is separately
    // locked by D103.M.3. No other CLI source file may import
    // child_process -- the rest of the CLI is forbidden to spawn
    // subprocesses, and any subprocess need (git or otherwise) goes
    // through the appropriate package's public API. Regex matches both
    // the modern `node:child_process` form and the legacy bare
    // `child_process` form (the project's verbatimModuleSyntax setting
    // nudges toward `node:` but doesn't enforce it, so both are valid
    // Node import specifiers).
    const cliSrcDir = join(REPO_ROOT, "packages/cli-commands/src");
    const allTs = findTsFiles(cliSrcDir);
    const CARVE_OUTS = new Set(["commands/doctor.ts", "commands/run.ts", "commands/shell.ts"]);
    const targets = allTs.filter(
      (p) => !CARVE_OUTS.has(relative(cliSrcDir, p).replace(/\\/g, "/")),
    );
    const childProcessImport = /from\s+["'](?:node:)?child_process["']/;
    for (const file of targets) {
      const source = readFileSync(file, "utf8");
      const offenders = findOffenders(source, childProcessImport);
      expect(
        offenders,
        `${relative(REPO_ROOT, file).replace(/\\/g, "/")} must not import child_process -- only doctor.ts (D17c), run.ts (D102.M.1), and shell.ts (D103.M.1) are allowed. Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });
});

describe("Architectural invariants -- restore.ts stream handling", () => {
  // file-header invariant #2 of restore.ts locks two stream-handling
  // rules that aren't enforced by TypeScript:
  //   1. `Readable.from([buf])` (single-chunk) -- NOT `Readable.from(buf)`
  //      (which iterates the Buffer as bytes and fragments archives).
  //   2. `tar.list({ onentry })` / `tar.extract({ cwd, filter })` -- NOT
  //      `new tar.Parser()` / `new tar.Unpack()` (which don't
  //      auto-decompress gzip and would silently consume our .tar.gz
  //      bytes as raw tar headers).
  // Both rules are critical for trust-critical archive handling; grep
  // tests catch regressions early.

  it("restore.ts does NOT use bare Readable.from(<identifier>) (must wrap in [...] for single-chunk semantics)", () => {
    const source = readSource("packages/git/src/restore.ts");
    // Match Readable.from( followed by an identifier (NOT `[`), which
    // is the antipattern. The negative lookbehind for backtick excludes
    // `Readable.from(buf)` mentions inside JSDoc backtick-wrapped code
    // references; the comment-line filter (via findOffenders) handles
    // line-comment mentions.
    const antipattern = /(?<!`)Readable\.from\(\s*([a-zA-Z_$][\w$]*)/;
    const offenders = findOffenders(source, antipattern);
    expect(
      offenders,
      `restore.ts must use Readable.from([buf]) (single-chunk array form), NOT Readable.from(buf) which iterates the Buffer as bytes. Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("restore.ts does NOT use new tar.Parser() (must use tar.list named export -- auto-detects gzip)", () => {
    const source = readSource("packages/git/src/restore.ts");
    const antipattern = /new\s+tar\.Parser\b/;
    const offenders = findOffenders(source, antipattern);
    expect(
      offenders,
      `restore.ts must use tar.list({ onentry }) (auto-decompresses gzip), NOT new tar.Parser() (treats input as raw tar headers, would silently consume gzip bytes). Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("restore.ts does NOT use new tar.Unpack() (must use tar.extract named export -- auto-detects gzip)", () => {
    const source = readSource("packages/git/src/restore.ts");
    const antipattern = /new\s+tar\.Unpack\b/;
    const offenders = findOffenders(source, antipattern);
    expect(
      offenders,
      `restore.ts must use tar.extract({ cwd, filter }) (auto-decompresses gzip), NOT new tar.Unpack() (treats input as raw tar headers, would silently consume gzip bytes). Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

describe("Architectural invariants -- D19 config-blind commands", () => {
  // D19: `viberevert end`, `viberevert checkpoints`, and
  // `viberevert sessions` MUST NOT import or reference `loadConfig`
  // from @viberevert/core. They operate purely on persisted
  // `.viberevert/` state and have no config-driven behavior. Allowing
  // config loading would create surprising failures in recovery paths
  // (a corrupt `.viberevert.yml` would block the listing commands the
  // user needs to clean up state).
  //
  // The `\bloadConfig\b` pattern catches imports, call sites, and any
  // other mention of the symbol. The findOffenders helper's `//`
  // comment filter skips the lines where these files document the
  // invariant by mentioning `loadConfig` in plain English (e.g., the
  // "MUST NOT import or call `loadConfig`" architectural-lock blocks
  // in each command's file header).

  it.each(["end", "checkpoints", "sessions"])("%s.ts does NOT reference loadConfig", (cmd) => {
    const source = readSource(`packages/cli-commands/src/commands/${cmd}.ts`);
    const offenders = findOffenders(source, /\bloadConfig\b/);
    expect(
      offenders,
      `${cmd}.ts must not reference loadConfig per D19 config-blind contract. Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

describe("Architectural invariants -- M D D77 rollback module boundaries", () => {
  // D77 locks 5 invariants for the rollback subsystem. The locked
  // layering (THIS IS THE CONTRACT -- do not move the restoreCheckpoint
  // call back into rollback.ts; do not call planRestoreCheckpoint from
  // orchestration):
  //
  //   rollback.ts owns CLI flag handling, dry-run planning, locking,
  //   receipt-path persistence, and rendering dispatch. It calls
  //   planRestoreCheckpoint for the dry-run path. It does NOT call
  //   restoreCheckpoint directly.
  //
  //   rollback-orchestration.ts owns the apply receipt attempt and is
  //   the layer that calls restoreCheckpoint. Per Lock #16 (the apply
  //   receipt = ATTEMPT semantic), buildReceiptForApply wraps the call
  //   so the receipt persists even when restoreCheckpoint throws --
  //   keeping that wrapping in one place is what makes the
  //   apply-receipt-ATTEMPT contract enforceable.
  //
  // Invariant 1 (`packages/cli-commands/src/commands/rollback.ts` MUST NOT
  // import `child_process`) is AUTO-COVERED by the workspace-wide
  // "cli/src/**/*.ts (excluding doctor.ts) does NOT import
  // child_process" test in the D17c describe block above -- no
  // separate test needed because rollback.ts is under
  // packages/cli-commands/src/commands/ and is NOT the doctor.ts carve-out.
  //
  // Invariant 2 splits into 2a (rollback.ts boundaries -- has plan,
  // does NOT have restore) and 2b (rollback-orchestration.ts owns
  // the real restore call). Invariants 3, 4, 5 get one test each.

  it("rollback.ts references planRestoreCheckpoint but NOT restoreCheckpoint directly (D77 invariant 2a)", () => {
    // The rollback command owns the dry-run planning path (via
    // planRestoreCheckpoint) and orchestrates the apply path through
    // rollback-orchestration.ts's buildReceiptForApply. It does NOT
    // call restoreCheckpoint directly -- that call lives in the
    // orchestration module so Lock #16 (apply receipt = ATTEMPT)
    // can wrap it in one place.
    //
    // A regression that pulls restoreCheckpoint into rollback.ts
    // would either bypass the receipt-ATTEMPT wrapping (breaking
    // the "receipt persists on restore throw" contract) or duplicate
    // it across layers (drift risk). Either way, the layering is
    // wrong -- fail the test loudly.
    const source = readSource("packages/cli-commands/src/commands/rollback.ts");
    expect(
      findOffenders(source, /\bplanRestoreCheckpoint\b/),
      "rollback.ts must reference planRestoreCheckpoint in non-comment code (D77 invariant 2a -- dry-run planning path)",
    ).not.toEqual([]);
    expect(
      findOffenders(source, /\brestoreCheckpoint\b/),
      "rollback.ts must NOT reference restoreCheckpoint directly; the apply restore call belongs in rollback-orchestration.ts so Lock #16 (apply receipt = ATTEMPT) can wrap it (D77 invariant 2a)",
    ).toEqual([]);
  });

  it("rollback-orchestration.ts references restoreCheckpoint (D77 invariant 2b)", () => {
    // The orchestration module's buildReceiptForApply wraps
    // restoreCheckpoint per Lock #16 (apply receipt = ATTEMPT -- the
    // receipt persists even when the restore throws partway). A
    // regression that loses this reference would mean either the
    // apply path is broken (no real restore happens) OR it moved to
    // the wrong layer (e.g., back into rollback.ts, defeating
    // invariant 2a).
    const source = readSource("packages/cli-commands/src/rollback-orchestration.ts");
    expect(
      findOffenders(source, /\brestoreCheckpoint\b/),
      "rollback-orchestration.ts must reference restoreCheckpoint in non-comment code (D77 invariant 2b -- apply path owns the real restore call)",
    ).not.toEqual([]);
  });

  it("rollback-orchestration.ts does NOT import @viberevert/checks or @viberevert/reporters (static, dynamic, or subpath) (D77 invariant 3)", () => {
    // D77 invariant 3: orchestration composes git + core +
    // session-format primitives only. Reporters render the receipt
    // at the CLI layer (rollback.ts owns format dispatch); checks is
    // irrelevant to rollback. A regression that pulls either in here
    // would muddle the layering -- orchestration is supposed to be a
    // pure-data-shaping module potentially reusable by future
    // entrypoints (MCP, hook), not coupled to CLI-specific render or
    // check-domain code.
    //
    // The patterns cover THREE forms:
    //   - Static exact:   from "@viberevert/checks"
    //   - Static subpath: from "@viberevert/checks/foo"
    //   - Dynamic exact / subpath: import("@viberevert/checks") /
    //                              import("@viberevert/checks/foo")
    // The trailing `(?:["'/])` after the package name matches either
    // the closing quote (exact import) OR a forward slash (subpath
    // import). Without subpath coverage, `from "@viberevert/reporters
    // /receipt-render"` would slip through -- a clear D29 violation
    // since orchestration is forbidden to depend on reporters at all.
    const source = readSource("packages/cli-commands/src/rollback-orchestration.ts");
    const antipatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      {
        name: "@viberevert/checks",
        pattern:
          /(?:from\s+["']@viberevert\/checks(?:["'/])|import\s*\(\s*["']@viberevert\/checks(?:["'/]))/,
      },
      {
        name: "@viberevert/reporters",
        pattern:
          /(?:from\s+["']@viberevert\/reporters(?:["'/])|import\s*\(\s*["']@viberevert\/reporters(?:["'/]))/,
      },
    ];
    for (const { name, pattern } of antipatterns) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `rollback-orchestration.ts must not import ${name} (D77 invariant 3, static or dynamic, exact or subpath). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  it("packages/reporters/src/receipt-*.ts honors D29 (no I/O, no terminal writes, no async, no clock/random/ulid, no cross-package deps beyond @viberevert/session-format) (D77 invariant 4)", () => {
    // D77 invariant 4 / D29: receipt renderers are pure synchronous
    // functions operating on a validated ReceiptFile input. Same
    // invariants enforced on M C's report renderers by package.json
    // deps + code review. M D adds a grep-based test for receipt-*.ts
    // because they're newly authored and grep is the cheapest catch-
    // mechanism for regressions before code review.
    //
    // The forbidden-imports checks cover BOTH static `from "..."` and
    // dynamic `import("...")` forms -- same dynamic-bypass concern as
    // invariant 3 above. Two paths:
    //   - `from "node:..."` OR `import("node:...")` -- any Node
    //     built-in (I/O, child_process, etc.). Biome's
    //     useNodejsImportProtocol="error" already forbids the bare
    //     `from "fs"` legacy form, so we don't need to enumerate
    //     built-in names.
    //   - `from "@viberevert/X"` OR `import("@viberevert/X")` where
    //     X !== "session-format" -- any other workspace package
    //     (D29's "session-format only" rule).
    const reportersSrcDir = join(REPO_ROOT, "packages/reporters/src");
    const receiptFiles = readdirSync(reportersSrcDir)
      .filter((name) => /^receipt-.*\.ts$/.test(name))
      .map((name) => join(reportersSrcDir, name));
    // Sanity: Step 5 shipped at least 5 receipt-*.ts files (types,
    // json, render, terminal, markdown). A regression that removed
    // files would silently pass this test -- fail loudly instead.
    expect(
      receiptFiles.length,
      `expected at least 5 receipt-*.ts files under packages/reporters/src; got ${receiptFiles.length}`,
    ).toBeGreaterThanOrEqual(5);

    const antipatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      {
        name: "no node:* imports, static or dynamic (I/O, paths, etc.)",
        pattern: /(?:from\s+["']node:|import\s*\(\s*["']node:)/,
      },
      {
        name: "no @viberevert/* imports beyond session-format, static or dynamic",
        pattern:
          /(?:from\s+["']@viberevert\/(?!session-format["'])|import\s*\(\s*["']@viberevert\/(?!session-format["']\s*\)))/,
      },
      { name: "no process.stdout/stderr writes", pattern: /process\.std(?:out|err)\.write/ },
      {
        name: "no console.log/info/warn/error/debug",
        pattern: /\bconsole\.(?:log|info|warn|error|debug)\b/,
      },
      {
        name: "no async functions/methods/arrows",
        pattern: /\basync\s+(?:function|\(|[a-zA-Z_$])/,
      },
      { name: "no Date.now() clock reads", pattern: /\bDate\.now\b/ },
      { name: "no new Date() construction", pattern: /\bnew\s+Date\b/ },
      { name: "no Math.random()", pattern: /\bMath\.random\b/ },
      { name: "no ulid() generation", pattern: /\bulid\(/ },
    ];
    for (const file of receiptFiles) {
      const source = readFileSync(file, "utf8");
      for (const { name, pattern } of antipatterns) {
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${relative(REPO_ROOT, file).replace(/\\/g, "/")} violates D29: ${name}. Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  it("start.ts D11 refusal copy contains the paired end-before-rollback sequence (D77 invariant 5 / D74 unlock)", () => {
    // D77 invariant 5: the D74-unlocked refusal copy honors D63's
    // state-machine invariant ("end before rollback"). Catches
    // regressions where the && compound is dropped (leaving a bare
    // `viberevert rollback` directive that would refuse on the active
    // session per D63) OR where the rollback reference is dropped
    // entirely (reverting to the pre-D74 copy that omitted the
    // recovery path).
    //
    // The single regex `viberevert end && viberevert rollback` locks
    // BOTH pieces in one shot -- proximity is intrinsic because both
    // pieces share the same match. findOffenders' comment filter
    // (line + block + JSDoc) ensures we assert on the ACTUAL stderr-
    // bound refusal copy at the implementation site, not on the
    // architectural-lock #6 block at the top of start.ts that
    // documents the same paired sequence for header-level context.
    const source = readSource("packages/cli-commands/src/commands/start.ts");
    expect(
      findOffenders(source, /viberevert end && viberevert rollback/),
      "start.ts must contain the literal 'viberevert end && viberevert rollback' paired sequence in non-comment code (D77 invariant 5 / D74 unlock -- locks both the rollback reference AND the D63-required end-before-rollback sequencing in one assertion)",
    ).not.toEqual([]);
  });
});

describe("Architectural invariants -- M E D90 prompt-fix module boundaries", () => {
  // D90 locks 8 invariants for the prompt-fix subsystem. The locked
  // boundaries:
  //
  //   prompt-fix.ts owns CLI flag handling, the --llm pre-resolve
  //   precedence, target resolution (delegated to prompt-fix-targets.ts),
  //   the D88 byte-level drift guard, the D86 empty-findings refusal
  //   with drift-guarded stale-removal, the D81 file-before-stdout
  //   write order, and the locked D90.6 filesystem-access surface
  //   (exactly three operations against exactly two paths via typed-
  //   target helpers).
  //
  //   prompt-fix-targets.ts is a pure path-math wrapper around
  //   resolveReportPaths -- the resolver's no-fs invariant is locked
  //   by its own test file (prompt-fix-targets.test.ts Section 5).
  //
  //   packages/reporters/src/fix-prompt-*.ts are D29-pure renderers
  //   covered by D90.5 (mirrors D77 invariant 4 for receipt renderers).
  //
  // 14 tests total -- 13 D90.X invariant tests plus one M E command
  // exposure test (locks the CLI registration in packages/cli/src/
  // index.ts so a future maintainer that removes the
  // cli.register(PromptFixCommand) line cannot ship a CLI binary
  // where the command is unreachable while the integration tests
  // continue to pass via their in-test Cli registration; also locks
  // the registration ORDER between ReportCommand and RollbackCommand
  // to preserve the locked check -> report -> prompt-fix -> rollback
  // workflow grouping).
  //
  // **Import-form coverage:** D90.1, D90.2, D90.3, and D90.6f all
  // scan for FOUR import forms -- static ESM (`from "..."`), dynamic
  // ESM (`import("...")`), CommonJS require (`require("...")`), AND
  // TS import-equals (`import x = require("...")`). The project is
  // ESM, but an invariant block should not have CJS-shaped escape
  // hatches: a future maintainer using tsconfig interop or copying
  // snippet code could land either CJS form. The patterns cover all
  // realistic bypass routes.
  //
  // All 8 D90 invariants get explicit tests inside this describe
  // block -- including D90.1 (no child_process imports). Although the
  // workspace-wide D17c "cli/src/**/*.ts (excluding doctor.ts)" check
  // also covers prompt-fix.ts, that defense is indirect (different
  // describe block, different decision lock). Making D90 self-
  // contained means a future refactor that loosens the D17c carve-out
  // or moves prompt-fix.ts out from under packages/cli-commands/src/commands/
  // would not silently de-protect the prompt-fix subsystem. The
  // D90.1/D90.2/D90.3 tests scan BOTH prompt-fix.ts AND
  // prompt-fix-targets.ts -- the resolver is part of the subsystem
  // and must honor the same forbidden-import contract.
  //
  // D90.6 splits into SIX sub-tests (a-f) so each failure carries a
  // precise diagnostic. D90.6a-e enforce specific call-site
  // patterns (correct target + counts + no aliasing); D90.6f is the
  // broad future-proofing scan that locks the canonical fs import
  // shape (exactly one named-import statement, exactly {readFile,
  // rm}, no aliases on those names, no namespace/default/dynamic/
  // require/import-equals forms) and forbids ALL other fs call
  // tokens.
  //
  // D90.6 and D90.7 stay scoped to prompt-fix.ts only -- the
  // fs-surface lock and single-renderer-call contract are command-
  // specific (the resolver has its own no-fs purity test in
  // prompt-fix-targets.test.ts Section 5, and only the command
  // invokes the renderer).
  //
  // The KNOWN_LLM_SDKS list is deliberately broad -- it covers not
  // just the direct provider SDKs but also the high-level framework
  // SDKs (Vercel's `ai`, `@ai-sdk/*`, LangChain, llamaindex, etc.)
  // and the runtime adapters (`ollama`, `@aws-sdk/client-bedrock-
  // runtime`, etc.). D90.8's "dependency added but not yet imported"
  // drift class is exactly the case where a maintainer adds one of
  // these packages to package.json BEFORE wiring the hidden --llm
  // path, signaling intent to land an LLM feature outside the M G1
  // MCP `generate_fix_prompt` milestone.

  const PROMPT_FIX_REL = "packages/cli-commands/src/commands/prompt-fix.ts";
  const PROMPT_FIX_TARGETS_REL = "packages/cli-commands/src/prompt-fix-targets.ts";
  // M G1a Step 1 Option D: the prompt-fix domain logic (fs writes,
  // renderer call) moved from PromptFixCommand into
  // generateFixPromptOperation. The D90.6 fs-surface locks and the
  // D90.7 single-renderer-call lock now target the operation file;
  // PromptFixCommand is a presentation shell (D99.M.22's absence
  // wall asserts those tokens are gone from it). D90.4 still targets
  // PROMPT_FIX_REL because --llm is a CLI flag, parsed in the Command.
  //
  // PROMPT_FIX_SOURCE_RELS includes the operation file so the
  // subsystem-wide bans (D90.1 child_process, D90.2 @viberevert/checks,
  // D90.3 known LLM SDKs) follow the domain logic into the operation.
  // The operation already passes those bans today; the inclusion
  // locks the protection in place before a future maintainer adds
  // an LLM-adapter import there.
  const GENERATE_FIX_PROMPT_OPERATION_REL =
    "packages/cli-commands/src/operations/generate-fix-prompt.ts";
  const PROMPT_FIX_SOURCE_RELS: ReadonlyArray<string> = [
    PROMPT_FIX_REL,
    PROMPT_FIX_TARGETS_REL,
    GENERATE_FIX_PROMPT_OPERATION_REL,
  ];
  const CLI_INDEX_REL = "packages/cli/src/index.ts";

  /**
   * Known LLM-SDK package specifiers banned per D90.3 (imports) and
   * D90.8 (package.json dependency maps). Deliberately broad -- covers
   * direct provider SDKs (@anthropic-ai/sdk, openai, cohere-ai,
   * @google/generative-ai, replicate, mistralai, @mistralai/mistralai),
   * AWS Bedrock runtime adapters (@anthropic-ai/bedrock-sdk,
   * @aws-sdk/client-bedrock-runtime), high-level framework SDKs
   * (Vercel's `ai`, `@ai-sdk/*`, LangChain ecosystem, llamaindex),
   * and other realistic adapters (ollama, groq-sdk, @groq/sdk,
   * @huggingface/inference). NOT exhaustive -- but the list covers
   * the realistic precursor packages a maintainer would add before
   * wiring the hidden --llm path.
   */
  const KNOWN_LLM_SDKS: ReadonlyArray<string> = [
    "@anthropic-ai/sdk",
    "@anthropic-ai/bedrock-sdk",
    "openai",
    "cohere-ai",
    "@google/generative-ai",
    "replicate",
    "mistralai",
    "@mistralai/mistralai",
    "ai",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@ai-sdk/mistral",
    "@langchain/openai",
    "@langchain/anthropic",
    "langchain",
    "ollama",
    "groq-sdk",
    "@groq/sdk",
    "@huggingface/inference",
    "llamaindex",
    "@aws-sdk/client-bedrock-runtime",
  ];

  /** Escape a string for use inside a RegExp constructor. */
  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Build a regex that matches all four realistic import forms of a
   * given package name (allowing subpath imports via trailing `/`):
   *   - Static ESM:        `from "name"` or `from "name/sub"`
   *   - Dynamic ESM:       `import("name")` or `import("name/sub")`
   *   - CommonJS require:  `require("name")` or `require("name/sub")`
   *   - TS import-equals:  `import x = require("name")` or `require("name/sub")`
   * Used by D90.3's per-SDK loop. D90.1 and D90.2 use hand-written
   * patterns with the same structure (they have package-specific
   * shapes -- `(?:node:)?` for child_process, exact `@viberevert/checks`
   * package for the checks dep).
   */
  function buildSdkForbiddenPattern(sdkName: string): RegExp {
    const escaped = escapeRegExp(sdkName);
    return new RegExp(
      `(?:from\\s+["']${escaped}(?:["'/])` +
        `|import\\s*\\(\\s*["']${escaped}(?:["'/])` +
        `|require\\s*\\(\\s*["']${escaped}(?:["'/])` +
        `|import\\s+\\w+\\s*=\\s*require\\s*\\(\\s*["']${escaped}(?:["'/]))`,
    );
  }

  it("prompt-fix subsystem does NOT import process-spawning modules in any form (D90.1)", () => {
    // D90.1: the prompt-fix subsystem MUST NOT spawn subprocesses.
    // Self-contained scan of BOTH prompt-fix.ts AND
    // prompt-fix-targets.ts so this invariant survives a future
    // refactor that loosens the D17c workspace-wide carve-out or
    // moves files out from under packages/cli-commands/src/commands/. The
    // regex covers static ESM + dynamic ESM + CJS require + TS
    // import-equals shapes for `child_process` / `node:child_process`.
    const pattern =
      /(?:from\s+["'](?:node:)?child_process["']|import\s*\(\s*["'](?:node:)?child_process["']\s*\)|require\s*\(\s*["'](?:node:)?child_process["']\s*\)|import\s+\w+\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\))/;
    for (const rel of PROMPT_FIX_SOURCE_RELS) {
      const offenders = findOffenders(readSource(rel), pattern);
      expect(
        offenders,
        `${rel} must not import child_process / node:child_process in any form (D90.1 -- static, dynamic, require, or import-equals). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  it("prompt-fix subsystem does NOT import @viberevert/checks in any form (D90.2)", () => {
    // Prompt-fix consumes a persisted ReportFile; it never re-runs
    // checks. Pulling @viberevert/checks in here would couple the
    // post-check viewer to the checks domain and break the locked
    // M E plan boundary (D95: "checks: NO changes" for prompt-fix).
    // Scans BOTH command and resolver across all four import forms
    // (static ESM + dynamic ESM + require + import-equals) AND
    // subpath imports (the trailing `(?:["'/])` matches either the
    // closing quote or a forward slash).
    const pattern =
      /(?:from\s+["']@viberevert\/checks(?:["'/])|import\s*\(\s*["']@viberevert\/checks(?:["'/])|require\s*\(\s*["']@viberevert\/checks(?:["'/])|import\s+\w+\s*=\s*require\s*\(\s*["']@viberevert\/checks(?:["'/]))/;
    for (const rel of PROMPT_FIX_SOURCE_RELS) {
      const offenders = findOffenders(readSource(rel), pattern);
      expect(
        offenders,
        `${rel} must not import @viberevert/checks in any form (D90.2 -- static, dynamic, require, import-equals, exact or subpath). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  it("prompt-fix subsystem does NOT import any known LLM SDK in any form (D90.3)", () => {
    // The --llm flag is reserved as a hidden seam per D84; no LLM
    // code path exists in v0.7.0. Any direct import of a known SDK
    // would either signal an in-progress LLM implementation (which
    // should land via a different milestone) OR an accidental
    // dependency creep through a transitive helper. Scans BOTH
    // command and resolver across the broad KNOWN_LLM_SDKS list
    // using buildSdkForbiddenPattern (covers all four import forms).
    for (const rel of PROMPT_FIX_SOURCE_RELS) {
      const source = readSource(rel);
      for (const sdk of KNOWN_LLM_SDKS) {
        const pattern = buildSdkForbiddenPattern(sdk);
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${rel} must not import ${sdk} in any form (D90.3 -- known LLM SDK). Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  it("prompt-fix.ts declares --llm with `hidden: true` near the Option.Boolean call (D90.4)", () => {
    // D84 + D90.4: --llm is the reserved hidden seam for v0.8.x+.
    // If a future maintainer accidentally removes `hidden: true`,
    // the flag would start appearing in `--help` output, advertising
    // a feature that exit-1-refuses with the deferred-feature copy.
    // The 200-char window allows for the description option +
    // surrounding whitespace + comment-free formatting between the
    // Option.Boolean opening paren and the `hidden: true` token.
    //
    // Defensive comment-strip via the shared stripTsComments helper
    // BEFORE the multi-line regex test -- even though prompt-fix.ts's
    // comments are already prose-safe per Step 3's hygiene
    // discipline, stripping survives future comment-style changes
    // that might accidentally form the
    // `Option.Boolean("--llm"... hidden: true` shape in a docstring.
    // Uses the shared helper instead of an inline regex
    // (consistency with D90.6 / D90.7 + D99.M).
    const stripped = stripTsComments(readSource(PROMPT_FIX_REL));
    const pattern = /Option\.Boolean\s*\(\s*["']--llm["'][\s\S]{0,200}hidden:\s*true/;
    expect(
      pattern.test(stripped),
      "prompt-fix.ts must declare --llm with `hidden: true` within 200 chars of the Option.Boolean call (D90.4 + D84). The flag must NOT appear in --help output.",
    ).toBe(true);
  });

  it("packages/reporters/src/fix-prompt-*.ts honors D29 (no I/O, no terminal writes, no async, no clock/random/ulid, no cross-package deps beyond @viberevert/session-format) (D90.5)", () => {
    // D90.5 mirrors D77 invariant 4's matrix for receipt renderers.
    // The fix-prompt renderers are M E Step 2 additions; this test
    // is the cheapest catch-mechanism for regressions before code
    // review. Same antipattern set as receipts.
    const reportersSrcDir = join(REPO_ROOT, "packages/reporters/src");
    const fixPromptFiles = readdirSync(reportersSrcDir)
      .filter((name) => /^fix-prompt-.*\.ts$/.test(name))
      .map((name) => join(reportersSrcDir, name));
    // Sanity: Step 2 shipped at least 3 fix-prompt-*.ts files
    // (types, template, render). A regression that removed files
    // would silently pass this test -- fail loudly instead.
    expect(
      fixPromptFiles.length,
      `expected at least 3 fix-prompt-*.ts files under packages/reporters/src; got ${fixPromptFiles.length}`,
    ).toBeGreaterThanOrEqual(3);

    const antipatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      {
        name: "no node:* imports, static or dynamic (I/O, paths, etc.)",
        pattern: /(?:from\s+["']node:|import\s*\(\s*["']node:)/,
      },
      {
        name: "no @viberevert/* imports beyond session-format, static or dynamic",
        pattern:
          /(?:from\s+["']@viberevert\/(?!session-format["'])|import\s*\(\s*["']@viberevert\/(?!session-format["']\s*\)))/,
      },
      { name: "no process.stdout/stderr writes", pattern: /process\.std(?:out|err)\.write/ },
      {
        name: "no console.log/info/warn/error/debug",
        pattern: /\bconsole\.(?:log|info|warn|error|debug)\b/,
      },
      {
        name: "no async functions/methods/arrows",
        pattern: /\basync\s+(?:function|\(|[a-zA-Z_$])/,
      },
      { name: "no Date.now() clock reads", pattern: /\bDate\.now\b/ },
      { name: "no new Date() construction", pattern: /\bnew\s+Date\b/ },
      { name: "no Math.random()", pattern: /\bMath\.random\b/ },
      { name: "no ulid() generation", pattern: /\bulid\(/ },
    ];
    for (const file of fixPromptFiles) {
      const source = readFileSync(file, "utf8");
      for (const { name, pattern } of antipatterns) {
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${relative(REPO_ROOT, file).replace(/\\/g, "/")} violates D29 (D90.5): ${name}. Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  it("generate-fix-prompt.ts has exactly two readFile calls AND every readFile call targets target.reportPath (D90.6a -- D88 drift-guard reads A + B)", () => {
    // D90.6a locks the D88 drift-guard reads -- exactly two source
    // occurrences of `readFile(target.reportPath`, one inside
    // `readReportBytes` (read A) and one inside
    // `assertSourceReportUnchanged` (read B). Both helpers take
    // the typed PromptFixReportTarget so the literal expression
    // appears at the call site inside each helper body.
    //
    // Additionally locks: NO readFile call whose first argument
    // is NOT target.reportPath (negative-lookahead pattern). A
    // regression that accidentally read target.fixPromptPath
    // would be caught at code time, not just by the operation's
    // byte-identity assertion.
    //
    // M G1a Step 1: targets generate-fix-prompt.ts (operation),
    // not prompt-fix.ts (Command). The operation now owns the
    // D88 drift-guard reads; the Command is a presentation shell.
    // Source is pre-stripped via stripTsComments so a doc comment
    // mentioning the locked tokens cannot trip the regex (uniform
    // discipline across all retargeted D90.6 / D90.7 scans).
    const source = stripTsComments(readSource(GENERATE_FIX_PROMPT_OPERATION_REL));

    const correctTarget = findOffenders(source, /\breadFile\s*\(\s*target\.reportPath\b/);
    expect(
      correctTarget.length,
      `generate-fix-prompt.ts must call readFile(target.reportPath, ...) EXACTLY twice (D90.6a -- D88 reads A + B). Found ${correctTarget.length} occurrences: ${JSON.stringify(correctTarget)}`,
    ).toBe(2);

    const wrongTarget = findOffenders(source, /\breadFile\s*\((?!\s*target\.reportPath\b)/);
    expect(
      wrongTarget,
      `generate-fix-prompt.ts readFile calls must use target.reportPath as the first argument (D90.6a). Wrong-target call sites: ${JSON.stringify(wrongTarget)}`,
    ).toEqual([]);
  });

  it("generate-fix-prompt.ts has exactly one rm call AND every rm / unlink call targets target.fixPromptPath (D90.6b -- D86 empty-findings stale removal)", () => {
    // D90.6b locks the D86 empty-findings stale-removal -- exactly
    // one source occurrence of `rm(target.fixPromptPath` inside
    // `removeStaleFixPrompt`. NO other rm targets are allowed
    // (catches accidental `rm(target.reportPath)` which would
    // destroy the source report on the deletion path), AND no
    // `unlink(` calls at all (the locked operation is rm with
    // force-removal; unlink would bypass the ENOENT-tolerant
    // discipline).
    //
    // M G1a Step 1: targets generate-fix-prompt.ts (operation).
    // Source is pre-stripped via stripTsComments (uniform D90.6
    // / D90.7 comment-strip discipline).
    const source = stripTsComments(readSource(GENERATE_FIX_PROMPT_OPERATION_REL));

    const correctTarget = findOffenders(source, /\brm\s*\(\s*target\.fixPromptPath\b/);
    expect(
      correctTarget.length,
      `generate-fix-prompt.ts must call rm(target.fixPromptPath, ...) EXACTLY once (D90.6b -- D86 stale removal). Found ${correctTarget.length} occurrences: ${JSON.stringify(correctTarget)}`,
    ).toBe(1);

    const wrongRmTarget = findOffenders(source, /\brm\s*\((?!\s*target\.fixPromptPath\b)/);
    expect(
      wrongRmTarget,
      `generate-fix-prompt.ts rm calls must use target.fixPromptPath as the first argument (D90.6b). Wrong-target call sites: ${JSON.stringify(wrongRmTarget)}`,
    ).toEqual([]);

    const anyUnlink = findOffenders(source, /\bunlink\s*\(/);
    expect(
      anyUnlink,
      `generate-fix-prompt.ts must not call unlink (D90.6b -- locked operation is rm with force-removal). Call sites: ${JSON.stringify(anyUnlink)}`,
    ).toEqual([]);
  });

  it("generate-fix-prompt.ts has exactly one writeFileAtomic call AND it targets target.fixPromptPath (D90.6c -- D81 file-before-stdout write order)", () => {
    // D90.6c locks the D81 success-path write -- exactly one
    // source occurrence of `writeFileAtomic(target.fixPromptPath`
    // inside `persistFixPrompt`. NO other writeFileAtomic targets
    // are allowed (catches accidental `writeFileAtomic(target.reportPath`
    // which would overwrite the source report).
    //
    // M G1a Step 1: targets generate-fix-prompt.ts (operation).
    // Source is pre-stripped via stripTsComments (uniform D90.6
    // / D90.7 comment-strip discipline).
    const source = stripTsComments(readSource(GENERATE_FIX_PROMPT_OPERATION_REL));

    const correctTarget = findOffenders(source, /\bwriteFileAtomic\s*\(\s*target\.fixPromptPath\b/);
    expect(
      correctTarget.length,
      `generate-fix-prompt.ts must call writeFileAtomic(target.fixPromptPath, ...) EXACTLY once (D90.6c -- D81 success path). Found ${correctTarget.length} occurrences: ${JSON.stringify(correctTarget)}`,
    ).toBe(1);

    const wrongTarget = findOffenders(
      source,
      /\bwriteFileAtomic\s*\((?!\s*target\.fixPromptPath\b)/,
    );
    expect(
      wrongTarget,
      `generate-fix-prompt.ts writeFileAtomic calls must use target.fixPromptPath as the first argument (D90.6c). Wrong-target call sites: ${JSON.stringify(wrongTarget)}`,
    ).toEqual([]);
  });

  it("generate-fix-prompt.ts contains NO readdir or lstat calls (D90.6d -- fs-surface lock)", () => {
    // D90.6d: the locked fs surface is readFile + rm +
    // writeFileAtomic only. Any readdir or lstat call would
    // indicate a broader fs operation creeping in (e.g.,
    // enumerating sibling files, checking symlink status). The
    // resolver's structural checks already cover layout
    // validation; the operation should never need to enumerate or
    // stat anything.
    //
    // M G1a Step 1: targets generate-fix-prompt.ts (operation).
    // Source is pre-stripped via stripTsComments (uniform D90.6
    // / D90.7 comment-strip discipline).
    const source = stripTsComments(readSource(GENERATE_FIX_PROMPT_OPERATION_REL));

    const readdirCalls = findOffenders(source, /\breaddir\s*\(/);
    expect(
      readdirCalls,
      `generate-fix-prompt.ts must not call readdir (D90.6d). Call sites: ${JSON.stringify(readdirCalls)}`,
    ).toEqual([]);

    const lstatCalls = findOffenders(source, /\blstat\s*\(/);
    expect(
      lstatCalls,
      `generate-fix-prompt.ts must not call lstat (D90.6d). Call sites: ${JSON.stringify(lstatCalls)}`,
    ).toEqual([]);
  });

  it("generate-fix-prompt.ts does NOT alias any filesystem helper via const/let assignment OR import rename (D90.6e -- code-review mechanical-check lock)", () => {
    // D90.6e: the D90.6 grep invariants depend on the literal
    // call-site patterns being legible. Aliasing
    // (`const myRead = readFile`) or import renaming
    // (`import { readFile as foo }`) would bypass the grep
    // without changing observable behavior -- that drift class
    // is what this lock prevents.
    //
    // Two patterns checked:
    //   - const/let/var assignment of one of the fs helpers
    //     (matched by helper NOT being followed by `(` -- i.e.,
    //     it's a value reference, not a call).
    //   - import { X as Y } rename inside an import statement.
    //
    // M G1a Step 1: targets generate-fix-prompt.ts (operation).
    // Source is pre-stripped via stripTsComments (uniform D90.6
    // / D90.7 comment-strip discipline).
    const source = stripTsComments(readSource(GENERATE_FIX_PROMPT_OPERATION_REL));

    const fsHelpers = "(?:readFile|rm|writeFileAtomic|lstat|readdir)";

    const aliasAssign = new RegExp(`\\b(?:const|let|var)\\s+\\w+\\s*=\\s*${fsHelpers}(?!\\s*\\()`);
    const assignOffenders = findOffenders(source, aliasAssign);
    expect(
      assignOffenders,
      `generate-fix-prompt.ts must not alias fs helpers via const/let/var assignment (D90.6e). Offenders: ${JSON.stringify(assignOffenders)}`,
    ).toEqual([]);

    const aliasImport = new RegExp(`\\b${fsHelpers}\\s+as\\s+\\w+`);
    const importOffenders = findOffenders(source, aliasImport);
    expect(
      importOffenders,
      `generate-fix-prompt.ts must not rename fs helpers in import statements (D90.6e). Offenders: ${JSON.stringify(importOffenders)}`,
    ).toEqual([]);
  });

  it("generate-fix-prompt.ts imports only readFile/rm from node:fs/promises via a single un-aliased named-import statement and uses no other fs call tokens (D90.6f -- broad future-proofing surface lock)", () => {
    // D90.6f future-proofs the fs surface against ANY new fs
    // operation a future maintainer might add. D90.6a-e enforce
    // the specific locked operations; D90.6f locks the surface
    // shape itself with self-contained checks for the canonical
    // import shape AND for any non-locked fs call tokens.
    //
    //   1. Exactly ONE named-import statement from node:fs/promises.
    //
    //   2. The raw imported names MUST NOT contain any `as`-rename
    //      (aliases are also forbidden by D90.6e, but D90.6f is
    //      self-contained -- locks the canonical shape directly so
    //      each test can be read in isolation without depending on
    //      another test's coverage).
    //
    //   3. The set of names imported MUST be exactly {readFile, rm}
    //      AND `importedRaw.length === 2` (catches a `{ readFile,
    //      readFile, rm }` duplicate that Set would silently dedupe).
    //
    //   4. NO namespace-import or default-import form
    //      (`import * as fs from ...` / `import fs from ...`).
    //
    //   5. NO bare node:fs static import (sync API).
    //
    //   6. NO dynamic import of `node:fs` OR `node:fs/promises`.
    //
    //   7. NO CJS `require("node:fs[/promises]")` OR TS
    //      `import x = require("node:fs[/promises]")` -- same
    //      routing-around concern as the dynamic-import case.
    //
    //   8. NO call to any other fs-promises function token --
    //      access / appendFile / chmod / chown / copyFile / cp /
    //      lstat / mkdir / mkdtemp / open / opendir / readdir /
    //      readlink / realpath / rename / rmdir / stat /
    //      symlink / truncate / unlink / utimes / watch /
    //      writeFile.
    //
    // Defensive comment-strip first (consistency with D90.4). The
    // \b word-boundary in each pattern ensures `writeFile\s*\(`
    // does NOT match `writeFileAtomic(` (the engine matches
    // `writeFile` then tries `\s*\(`, sees `A` from `Atomic` next,
    // fails). Same for `lstat`, `unlink`, etc. vs. any locally-
    // defined identifiers that contain those substrings.
    //
    // M G1a Step 1: targets generate-fix-prompt.ts (operation).
    // The comment-strip uses the shared stripTsComments helper --
    // its block-comment replacement preserves newline characters
    // so findOffenders line numbers stay accurate.
    const source = readSource(GENERATE_FIX_PROMPT_OPERATION_REL);
    const stripped = stripTsComments(source);

    // Check 1: exactly one named-import statement.
    const fsPromisesImportMatches = [
      ...stripped.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']node:fs\/promises["']/g),
    ];
    expect(
      fsPromisesImportMatches.length,
      `generate-fix-prompt.ts must have EXACTLY one named-import statement from node:fs/promises (D90.6f). Found ${fsPromisesImportMatches.length}.`,
    ).toBe(1);

    // Parse imported names from the captured group.
    const importedRaw = fsPromisesImportMatches.flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    );

    // Check 2: no aliased names in the raw imported parts.
    expect(
      importedRaw.some((part) => /\s+as\s+\w+$/.test(part)),
      `generate-fix-prompt.ts node:fs/promises import must not use aliased names (D90.6f -- canonical shape). Got: ${JSON.stringify(importedRaw)}`,
    ).toBe(false);

    // Check 3: exactly {readFile, rm} with no duplicates. Since
    // alias check above already passed, importedRaw contains
    // plain identifier names -- no need to strip `as X` suffixes.
    expect(
      importedRaw.length,
      `generate-fix-prompt.ts node:fs/promises import must contain exactly 2 names (catches duplicates) (D90.6f). Got ${importedRaw.length}: ${JSON.stringify(importedRaw)}`,
    ).toBe(2);
    expect(
      new Set(importedRaw),
      `generate-fix-prompt.ts must import EXACTLY {readFile, rm} from node:fs/promises (D90.6f). Got: ${JSON.stringify([...new Set(importedRaw)])}`,
    ).toEqual(new Set(["readFile", "rm"]));

    // Check 4: no namespace or default-import forms from node:fs/promises.
    const namespaceOrDefaultFsImports = findOffenders(
      stripped,
      /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+["']node:fs\/promises["']/,
    );
    expect(
      namespaceOrDefaultFsImports,
      `generate-fix-prompt.ts must not use namespace or default-import forms from node:fs/promises (D90.6f). Matches: ${JSON.stringify(namespaceOrDefaultFsImports)}`,
    ).toEqual([]);

    // Check 5: no bare node:fs static import.
    const bareFsStaticImports = findOffenders(stripped, /from\s+["']node:fs["']/);
    expect(
      bareFsStaticImports,
      `generate-fix-prompt.ts must not import from the bare node:fs (sync) API -- only node:fs/promises (D90.6f). Matches: ${JSON.stringify(bareFsStaticImports)}`,
    ).toEqual([]);

    // Check 6: no dynamic import of node:fs or node:fs/promises.
    const dynamicFsImports = findOffenders(
      stripped,
      /import\s*\(\s*["']node:fs(?:\/promises)?["']\s*\)/,
    );
    expect(
      dynamicFsImports,
      `generate-fix-prompt.ts must not dynamic-import node:fs or node:fs/promises (D90.6f). Matches: ${JSON.stringify(dynamicFsImports)}`,
    ).toEqual([]);

    // Check 7: no CJS require or TS import-equals of node:fs[/promises].
    const requireFsImports = findOffenders(
      stripped,
      /require\s*\(\s*["']node:fs(?:\/promises)?["']\s*\)/,
    );
    expect(
      requireFsImports,
      `generate-fix-prompt.ts must not CJS-require node:fs or node:fs/promises (D90.6f). Matches: ${JSON.stringify(requireFsImports)}`,
    ).toEqual([]);

    const importEqualsFsImports = findOffenders(
      stripped,
      /import\s+\w+\s*=\s*require\s*\(\s*["']node:fs(?:\/promises)?["']\s*\)/,
    );
    expect(
      importEqualsFsImports,
      `generate-fix-prompt.ts must not TS-import-equals node:fs or node:fs/promises (D90.6f). Matches: ${JSON.stringify(importEqualsFsImports)}`,
    ).toEqual([]);

    // Check 8: no forbidden fs call tokens.
    const forbiddenFsCalls = findOffenders(
      stripped,
      /\b(?:access|appendFile|chmod|chown|copyFile|cp|lstat|mkdir|mkdtemp|open|opendir|readdir|readlink|realpath|rename|rmdir|stat|symlink|truncate|unlink|utimes|watch|writeFile)\s*\(/,
    );
    expect(
      forbiddenFsCalls,
      `generate-fix-prompt.ts must not call any fs operation outside the D90.6 locked surface (D90.6f). Forbidden call sites: ${JSON.stringify(forbiddenFsCalls)}`,
    ).toEqual([]);
  });

  it("generate-fix-prompt.ts contains EXACTLY ONE renderFixPrompt call site (D90.7 -- single renderer call lock)", () => {
    // D90.7: the renderer is invoked exactly once per execution
    // and the source MUST reflect that -- a second call site
    // would risk drift if any future template helper accidentally
    // sneaks in a clock/random/ulid read (which D90.5 currently
    // prohibits, but defense-in-depth). The single call lives on
    // the operation's success path (post-drift-check, post-render).
    //
    // Comments in generate-fix-prompt.ts are written as prose
    // ("the renderer call" / "the render invocation") rather than
    // the literal name-plus-paren form per the M E #6 prose-comment
    // discipline carried over into the operation -- findOffenders
    // strips comments anyway, but the prose convention adds a
    // second layer of safety against this grep false-matching.
    //
    // M G1a Step 1: targets generate-fix-prompt.ts (operation).
    // Source is pre-stripped via stripTsComments (uniform D90.6
    // / D90.7 comment-strip discipline).
    const source = stripTsComments(readSource(GENERATE_FIX_PROMPT_OPERATION_REL));
    const renderCalls = findOffenders(source, /\brenderFixPrompt\s*\(/);
    expect(
      renderCalls.length,
      `generate-fix-prompt.ts must contain EXACTLY one renderFixPrompt call site (D90.7). Found ${renderCalls.length} occurrences: ${JSON.stringify(renderCalls)}`,
    ).toBe(1);
  });

  it("no known LLM SDK appears in any package.json dependency map (D90.8 -- workspace-wide LLM-free contract)", () => {
    // D90.8 catches the "dependency added but not yet imported"
    // drift class. Even if no source file imports an LLM SDK,
    // declaring one in any package.json signals intent to land
    // an LLM path before the M G1 MCP `generate_fix_prompt`
    // milestone is ready. Walks: root package.json + every
    // packages/*/package.json + scripts/package.json (if present).
    //
    // Checks all four dependency-map fields per pnpm semantics:
    // dependencies, devDependencies, peerDependencies,
    // optionalDependencies. A dev-only LLM dep would still leak
    // into the lockfile and pnpm-install output, which the
    // contract intentionally forbids.
    const depFields: ReadonlyArray<string> = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];

    const pkgJsonPaths: string[] = [join(REPO_ROOT, "package.json")];
    const packagesDir = join(REPO_ROOT, "packages");
    for (const entry of readdirSync(packagesDir)) {
      const candidate = join(packagesDir, entry, "package.json");
      try {
        if (statSync(candidate).isFile()) {
          pkgJsonPaths.push(candidate);
        }
      } catch {
        // not present -- skip
      }
    }
    const scriptsPkgJson = join(REPO_ROOT, "scripts", "package.json");
    try {
      if (statSync(scriptsPkgJson).isFile()) {
        pkgJsonPaths.push(scriptsPkgJson);
      }
    } catch {
      // not present -- skip (the project's scripts/ may or may not
      // have its own package.json)
    }

    const violations: string[] = [];
    for (const pkgPath of pkgJsonPaths) {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      for (const depField of depFields) {
        const deps = parsed[depField];
        if (deps === undefined || deps === null || typeof deps !== "object") continue;
        for (const sdk of KNOWN_LLM_SDKS) {
          if (sdk in (deps as Record<string, unknown>)) {
            violations.push(
              `${relative(REPO_ROOT, pkgPath).replace(/\\/g, "/")} -> ${depField}.${sdk}`,
            );
          }
        }
      }
    }
    expect(
      violations,
      `No package.json may declare a dependency on a known LLM SDK (D90.8). Violations: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("CLI index imports and registers PromptFixCommand exactly once AND preserves the Report -> PromptFix -> Rollback workflow order (M E command exposure lock)", () => {
    // Locked separately from D90.X because this is about EXPOSURE
    // (the command is reachable through the binary) and ORDER (the
    // intentional check -> report -> prompt-fix -> rollback workflow
    // grouping), not internal code-level boundaries. The
    // integration tests in prompt-fix.test.ts register
    // PromptFixCommand manually via their in-test Cli, so if a
    // future maintainer removes the `cli.register(PromptFixCommand)`
    // line from packages/cli/src/index.ts, EVERY test still passes
    // but the binary `viberevert prompt-fix` becomes unreachable.
    // This test closes that gap.
    //
    // Defensive: also asserts each of the three registration lines
    // referenced by the order check actually exists. Without that,
    // `indexOf` returning -1 (for a missing line) would silently
    // satisfy the `-1 < someIndex` comparison and the ordering
    // assertion would pass incorrectly.
    const source = readSource(CLI_INDEX_REL);

    // M G1a Step 1 substep 9: the CLI binary now imports its 17
    // Command classes from the @viberevert/cli-commands barrel
    // (not from local ./commands/*.js paths). Find that multi-line
    // import block and assert PromptFixCommand appears in it
    // exactly once.
    const barrelImportBody = getCliCommandsBarrelImportBody(source);
    const promptFixMatches = barrelImportBody.match(/\bPromptFixCommand\b/g) ?? [];
    expect(
      promptFixMatches.length,
      `packages/cli/src/index.ts must import PromptFixCommand exactly once from @viberevert/cli-commands (M E command exposure). Found ${promptFixMatches.length}.`,
    ).toBe(1);

    const registers = findOffenders(source, /\bcli\.register\s*\(\s*PromptFixCommand\s*\)/);
    expect(
      registers.length,
      `packages/cli/src/index.ts must register PromptFixCommand via cli.register(PromptFixCommand) exactly once (M E command exposure). Found ${registers.length}.`,
    ).toBe(1);

    const reportIdx = source.indexOf("cli.register(ReportCommand);");
    const promptFixIdx = source.indexOf("cli.register(PromptFixCommand);");
    const rollbackIdx = source.indexOf("cli.register(RollbackCommand);");

    expect(
      reportIdx,
      "ReportCommand registration missing from index.ts (order check needs it as neighbor anchor)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      promptFixIdx,
      "PromptFixCommand registration missing from index.ts",
    ).toBeGreaterThanOrEqual(0);
    expect(
      rollbackIdx,
      "RollbackCommand registration missing from index.ts (order check needs it as neighbor anchor)",
    ).toBeGreaterThanOrEqual(0);

    expect(
      reportIdx,
      "ReportCommand must be registered BEFORE PromptFixCommand in index.ts (workflow order: check -> report -> prompt-fix -> rollback)",
    ).toBeLessThan(promptFixIdx);
    expect(
      promptFixIdx,
      "PromptFixCommand must be registered BEFORE RollbackCommand in index.ts (workflow order: check -> report -> prompt-fix -> rollback)",
    ).toBeLessThan(rollbackIdx);
  });
});

describe("Architectural invariants -- M F D98.M hook subsystem boundaries", () => {
  // D98.M locks 14 invariants for the hook install/uninstall subsystem.
  // The locked boundaries:
  //
  //   hook-script.ts is a pure constants + pure-function module -- NO
  //   runtime imports (M.5), ASCII-only at byte level (M.4), and
  //   HOOK_SCRIPT_TEMPLATE constructed via [...lines].join("\n") + "\n"
  //   (M.14 -- NOT a raw multi-line template literal which can pick up
  //   CRLF on Windows + autocrlf).
  //
  //   hook-managers.ts is pure detection logic with a bounded fs surface
  //   (M.11 -- 6 path-specific lstats + 1 readFile of package.json = 7
  //   total source call sites) and no child_process / @viberevert/checks
  //   / LLM SDK (M.1/M.2/M.3).
  //
  //   hook-install.ts + hook-uninstall.ts have LOCKED filesystem surfaces
  //   (M.6 install: 10 sites / 9 patterns; M.7 uninstall: 9 sites / 8
  //   patterns) enforced by exact source-call-site grep counts AND
  //   aggregate per-operation totals (catches `lstat(otherPath)` etc.
  //   that bypasses the variable-specific pattern table). The flag-based
  //   single-call-site pattern (D98.A11 for install; the mirrored
  //   shouldRm/restorePlan pattern for uninstall) keeps each fs
  //   operation at exactly one source location even when multiple
  //   semantic branches need it. Import-count locks (M.8) ensure
  //   HOOK_SCRIPT_TEMPLATE / MANAGED_BY_MARKER / detectHookManagers
  //   are referenced via the locked symbol-name paths only.
  //
  //   index.ts exposes both commands via cli.register and preserves
  //   the locked workflow ordering (M.9 + M.10: RollbackCommand <
  //   HookInstallCommand < HookUninstallCommand, with HookUninstall
  //   IMMEDIATELY after HookInstall).
  //
  //   Cross-command import lock (M.12) forbids cross-imports between
  //   hook-install.ts and hook-uninstall.ts in either direction (all four
  //   import forms; both .js and .ts subpath suffixes; both
  //   sibling-relative `./hook-*` and parent-relative
  //   `../commands/hook-*` specifier shapes); shared error classes
  //   are duplicated locally rather than imported across.
  //   M.13 extends M.4's ASCII-only scan to the three M F CLI source
  //   files.
  //
  // 14 tests total -- one per D98.M.X invariant. KNOWN_LLM_SDKS list +
  // helpers (escapeRegExp, buildSdkForbiddenPattern) are DUPLICATED
  // from the D90 block above for self-containment -- each architectural
  // describe block stands alone so changes to one block don't silently
  // de-protect another.
  //
  // **Import-form coverage:** D98.M.1, D98.M.2, D98.M.3, and D98.M.12
  // all scan FOUR import forms -- static ESM (`from "..."`), dynamic
  // ESM (`import("...")`), CommonJS require (`require("...")`), AND
  // TS import-equals (`import x = require("...")`). Consistent with
  // D90 to prevent bypass routes via tsconfig interop or copied
  // snippet code.

  const HOOK_INSTALL_REL = "packages/cli-commands/src/commands/hook-install.ts";
  const HOOK_UNINSTALL_REL = "packages/cli-commands/src/commands/hook-uninstall.ts";
  const HOOK_MANAGERS_REL = "packages/adapters/src/hook-managers.ts";
  const HOOK_SCRIPT_REL = "packages/adapters/src/hook-script.ts";
  const HOOK_SOURCE_RELS: ReadonlyArray<string> = [
    HOOK_INSTALL_REL,
    HOOK_UNINSTALL_REL,
    HOOK_MANAGERS_REL,
  ];
  const CLI_INDEX_REL = "packages/cli/src/index.ts";

  /**
   * Known LLM-SDK package specifiers banned per D98.M.3. DUPLICATED
   * from the D90 block's KNOWN_LLM_SDKS for self-containment -- D98.M
   * is a separate decision lock and the list MUST be authoritative
   * within this block so a future M G1+ change to either list does
   * not silently de-protect the other subsystem.
   */
  const KNOWN_LLM_SDKS: ReadonlyArray<string> = [
    "@anthropic-ai/sdk",
    "@anthropic-ai/bedrock-sdk",
    "openai",
    "cohere-ai",
    "@google/generative-ai",
    "replicate",
    "mistralai",
    "@mistralai/mistralai",
    "ai",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@ai-sdk/mistral",
    "@langchain/openai",
    "@langchain/anthropic",
    "langchain",
    "ollama",
    "groq-sdk",
    "@groq/sdk",
    "@huggingface/inference",
    "llamaindex",
    "@aws-sdk/client-bedrock-runtime",
  ];

  /** Escape a string for use inside a RegExp constructor. */
  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Build a regex that matches all four import forms of a given
   * package name (allowing subpath imports via trailing `/`). Same
   * shape as D90's buildSdkForbiddenPattern.
   */
  function buildSdkForbiddenPattern(sdkName: string): RegExp {
    const escaped = escapeRegExp(sdkName);
    return new RegExp(
      `(?:from\\s+["']${escaped}(?:["'/])` +
        `|import\\s*\\(\\s*["']${escaped}(?:["'/])` +
        `|require\\s*\\(\\s*["']${escaped}(?:["'/])` +
        `|import\\s+\\w+\\s*=\\s*require\\s*\\(\\s*["']${escaped}(?:["'/]))`,
    );
  }

  // ===========================================================================
  // D98.M.1, M.2, M.3 -- forbidden imports across the hook subsystem
  // ===========================================================================

  it("D98.M.1: hook subsystem (install + uninstall + managers) does NOT import child_process in any form", () => {
    // The hook subsystem MUST NOT spawn subprocesses. The on-disk
    // hook script SHELLS OUT via the user's shell when the hook fires;
    // the install/uninstall commands themselves never spawn anything.
    // Pattern covers static ESM + dynamic ESM + CJS require + TS
    // import-equals shapes for `child_process` / `node:child_process`.
    const pattern =
      /(?:from\s+["'](?:node:)?child_process["']|import\s*\(\s*["'](?:node:)?child_process["']\s*\)|require\s*\(\s*["'](?:node:)?child_process["']\s*\)|import\s+\w+\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\))/;
    for (const rel of HOOK_SOURCE_RELS) {
      const offenders = findOffenders(readSource(rel), pattern);
      expect(
        offenders,
        `${rel} must not import child_process / node:child_process in any form (D98.M.1 -- static, dynamic, require, or import-equals). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  it("D98.M.2: hook subsystem does NOT import @viberevert/checks in any form", () => {
    // The hook script SHELLS OUT to `viberevert check --staged` at
    // commit time; install and uninstall commands NEVER link against
    // the checks engine. Decoupling means changes to the checks engine
    // never require re-running install. Scans all three M F CLI
    // source files across all four import forms (static + dynamic +
    // require + import-equals), plus subpath imports.
    const pattern =
      /(?:from\s+["']@viberevert\/checks(?:["'/])|import\s*\(\s*["']@viberevert\/checks(?:["'/])|require\s*\(\s*["']@viberevert\/checks(?:["'/])|import\s+\w+\s*=\s*require\s*\(\s*["']@viberevert\/checks(?:["'/]))/;
    for (const rel of HOOK_SOURCE_RELS) {
      const offenders = findOffenders(readSource(rel), pattern);
      expect(
        offenders,
        `${rel} must not import @viberevert/checks in any form (D98.M.2 -- static, dynamic, require, import-equals, exact or subpath). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  it("D98.M.3: hook subsystem does NOT import any known LLM SDK in any form", () => {
    // The hook subsystem is config-blind and LLM-free in v0.7.0-beta.
    // Any direct import of a known SDK would either signal an
    // in-progress LLM implementation (which belongs to a different
    // milestone) OR an accidental dependency creep through a
    // transitive helper. Scans all three files across the broad
    // KNOWN_LLM_SDKS list using buildSdkForbiddenPattern (all four
    // import forms).
    for (const rel of HOOK_SOURCE_RELS) {
      const source = readSource(rel);
      for (const sdk of KNOWN_LLM_SDKS) {
        const pattern = buildSdkForbiddenPattern(sdk);
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${rel} must not import ${sdk} in any form (D98.M.3 -- known LLM SDK). Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  // ===========================================================================
  // D98.M.4 -- hook-script.ts ASCII-only
  // ===========================================================================

  it("D98.M.4: hook-script.ts is ASCII-only at byte level", () => {
    // hook-script.ts content is what gets written to .git/hooks/pre-
    // commit on disk -- a single non-ASCII byte (em-dash, smart quote,
    // arrow) would corrupt the on-disk hook script. Byte-level scan
    // catches accidental smart-quote / em-dash insertion in any
    // context (output string literals, comments, identifiers, etc.)
    // without needing a fragile string-literal parser.
    const source = readSource(HOOK_SCRIPT_REL);
    const nonAscii: Array<{ index: number; codePoint: number }> = [];
    for (let i = 0; i < source.length; i++) {
      const codePoint = source.charCodeAt(i);
      if (codePoint >= 128) {
        nonAscii.push({ index: i, codePoint });
      }
    }
    expect(
      nonAscii,
      `hook-script.ts must be ASCII-only at byte level (D98.M.4). Non-ASCII chars (first 10): ${JSON.stringify(nonAscii.slice(0, 10))}`,
    ).toEqual([]);
  });

  // ===========================================================================
  // D98.M.5 -- hook-script.ts pure module (no runtime imports)
  // ===========================================================================

  it("D98.M.5: hook-script.ts imports nothing except types (pure constants + pure-function module)", () => {
    // hook-script.ts is a pure module: locked constants
    // (MANAGED_BY_MARKER, HOOK_SCRIPT_TEMPLATE, BACKUP_FILE_PREFIX,
    // BACKUP_FILE_REGEX) + pure formatBackupTimestamp(date). NO
    // runtime imports (no node:fs, no @viberevert/*, no SDKs).
    // Type-only imports (`import type { ... }`) are allowed because
    // they erase at runtime and introduce no runtime dependency or
    // side effect.
    //
    // Pattern catches three antipattern shapes:
    //   - Line beginning with `import ...` that is NOT `import type ...`
    //     (negative lookahead `(?!\s+type\b)` excludes the type-only form)
    //   - Line containing `require("...")` (CJS or TS-import-equals)
    //   - Line containing dynamic `import("...")`
    const source = readSource(HOOK_SCRIPT_REL);
    const runtimeImportPattern =
      /^(?:import(?!\s+type\b)\s|.*\brequire\s*\(\s*["']|.*\bimport\s*\(\s*["'])/;
    const offenders = findOffenders(source, runtimeImportPattern);
    expect(
      offenders,
      `hook-script.ts must NOT have any runtime imports (D98.M.5 -- pure constants module). Runtime-import lines: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  // ===========================================================================
  // D98.M.6 -- hook-install.ts fs source-call-site surface
  // ===========================================================================

  it("D98.M.6: hook-install.ts filesystem surface -- exact source-call-site counts (10 sites / 9 patterns) + aggregate per-op guards + forbidden ops", () => {
    // D98.I install list locks the EXACT source-call-site surface:
    //   lstat(join(repoRoot, ".git")) x1, lstat(hooksDir) x2 (preflight
    //   + post-mkdir per D98.X validate-before-mutate), lstat(hookPath)
    //   x1, readFile(hookPath) x1, lstat(backupPath) x1,
    //   rename(hookPath, backupPath) x1, mkdir(hooksDir) x1,
    //   writeFileAtomic(hookPath) x1, chmod(hookPath) x1.
    // 10 fs source call sites across 9 operation patterns.
    //
    // Plus: aggregate per-op guards (catches an extra `lstat(otherPath)`
    // / `chmod(otherPath)` etc. that bypasses the variable-specific
    // pattern table).
    //
    // Plus: forbid readdir, unlink, copyFile, rm, and bare stat
    // (without `l` prefix) -- all explicitly excluded from the locked
    // install surface.
    const source = readSource(HOOK_INSTALL_REL);
    const expectedCounts: ReadonlyArray<{ name: string; pattern: RegExp; expected: number }> = [
      {
        name: 'lstat(join(repoRoot, ".git")',
        pattern: /lstat\(join\(repoRoot, "\.git"\)/,
        expected: 1,
      },
      { name: "lstat(hooksDir", pattern: /lstat\(hooksDir/, expected: 2 },
      { name: "lstat(hookPath", pattern: /lstat\(hookPath/, expected: 1 },
      { name: "readFile(hookPath", pattern: /readFile\(hookPath/, expected: 1 },
      { name: "lstat(backupPath", pattern: /lstat\(backupPath/, expected: 1 },
      {
        name: "rename(hookPath, backupPath",
        pattern: /rename\(hookPath, backupPath/,
        expected: 1,
      },
      { name: "mkdir(hooksDir", pattern: /mkdir\(hooksDir/, expected: 1 },
      { name: "writeFileAtomic(hookPath", pattern: /writeFileAtomic\(hookPath/, expected: 1 },
      { name: "chmod(hookPath", pattern: /chmod\(hookPath/, expected: 1 },
    ];
    for (const { name, pattern, expected } of expectedCounts) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders.length,
        `hook-install.ts must contain EXACTLY ${expected} \`${name}\` source call site(s) (D98.M.6). Found ${offenders.length}: ${JSON.stringify(offenders)}`,
      ).toBe(expected);
    }

    // Aggregate guards: total counts per fs operation must match the
    // per-variable sum. Catches an extra `lstat(otherPath)` /
    // `chmod(otherPath)` etc. that bypasses the variable-specific
    // pattern table.
    expect(
      findOffenders(source, /\blstat\(/).length,
      "hook-install.ts must contain EXACTLY 5 lstat() source call sites total (1 .git + 2 hooksDir + 1 hookPath + 1 backupPath = 5) (D98.M.6 aggregate guard).",
    ).toBe(5);
    expect(
      findOffenders(source, /\breadFile\(/).length,
      "hook-install.ts must contain EXACTLY 1 readFile() source call site total (D98.M.6 aggregate guard).",
    ).toBe(1);
    expect(
      findOffenders(source, /\brename\(/).length,
      "hook-install.ts must contain EXACTLY 1 rename() source call site total (D98.M.6 aggregate guard).",
    ).toBe(1);
    expect(
      findOffenders(source, /\bmkdir\(/).length,
      "hook-install.ts must contain EXACTLY 1 mkdir() source call site total (D98.M.6 aggregate guard).",
    ).toBe(1);
    expect(
      findOffenders(source, /\bwriteFileAtomic\(/).length,
      "hook-install.ts must contain EXACTLY 1 writeFileAtomic() source call site total (D98.M.6 aggregate guard).",
    ).toBe(1);
    expect(
      findOffenders(source, /\bchmod\(/).length,
      "hook-install.ts must contain EXACTLY 1 chmod() source call site total (D98.M.6 aggregate guard).",
    ).toBe(1);

    const forbiddenOps: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "readdir(", pattern: /\breaddir\(/ },
      { name: "unlink(", pattern: /\bunlink\(/ },
      { name: "copyFile(", pattern: /\bcopyFile\(/ },
      { name: "rm(", pattern: /\brm\(/ },
      // `stat(` standalone -- word boundary excludes `lstat(` since `l`
      // and `s` are both word chars (no boundary between them).
      { name: "stat( (without `l` prefix)", pattern: /\bstat\(/ },
    ];
    for (const { name, pattern } of forbiddenOps) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `hook-install.ts must NOT call \`${name}\` (D98.M.6 forbidden op). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  // ===========================================================================
  // D98.M.7 -- hook-uninstall.ts fs source-call-site surface
  // ===========================================================================

  it("D98.M.7: hook-uninstall.ts filesystem surface -- exact source-call-site counts (9 sites / 8 patterns) + withFileTypes:true EXACTLY once + aggregate per-op guards + forbidden ops", () => {
    // D98.I uninstall list locks the EXACT source-call-site surface:
    //   lstat(join(repoRoot, ".git")) x1, lstat(hooksDir) x1 (uninstall
    //   does NOT mkdir, so no post-mkdir re-check), lstat(hookPath) x2
    //   (first for presence + marker check, second for --restore final
    //   collision guard), readFile(hookPath) x1, rm(hookPath) x1
    //   (default-uninstall AND --restore-rm-managed share via shouldRm
    //   flag), readdir(hooksDir) x1 WITH locked `withFileTypes: true`
    //   option, rename(backupPath, hookPath) x1, chmod(hookPath) x1.
    // 9 fs source call sites across 8 operation patterns.
    //
    // Plus: sub-assertion for the `withFileTypes: true` literal token
    // EXACTLY once (matches the single readdir(hooksDir) call site).
    //
    // Plus: aggregate per-op guards (catches an extra `lstat(otherPath)`
    // / `readdir(otherPath)` that bypasses the variable-specific
    // pattern table).
    //
    // Plus: forbid mkdir, writeFile/writeFileAtomic, unlink, copyFile,
    // bare stat -- explicitly excluded from the locked uninstall surface.
    const source = readSource(HOOK_UNINSTALL_REL);
    const expectedCounts: ReadonlyArray<{ name: string; pattern: RegExp; expected: number }> = [
      {
        name: 'lstat(join(repoRoot, ".git")',
        pattern: /lstat\(join\(repoRoot, "\.git"\)/,
        expected: 1,
      },
      { name: "lstat(hooksDir", pattern: /lstat\(hooksDir/, expected: 1 },
      { name: "lstat(hookPath", pattern: /lstat\(hookPath/, expected: 2 },
      { name: "readFile(hookPath", pattern: /readFile\(hookPath/, expected: 1 },
      { name: "rm(hookPath", pattern: /rm\(hookPath/, expected: 1 },
      { name: "readdir(hooksDir", pattern: /readdir\(hooksDir/, expected: 1 },
      {
        name: "rename(backupPath, hookPath",
        pattern: /rename\(backupPath, hookPath/,
        expected: 1,
      },
      { name: "chmod(hookPath", pattern: /chmod\(hookPath/, expected: 1 },
    ];
    for (const { name, pattern, expected } of expectedCounts) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders.length,
        `hook-uninstall.ts must contain EXACTLY ${expected} \`${name}\` source call site(s) (D98.M.7). Found ${offenders.length}: ${JSON.stringify(offenders)}`,
      ).toBe(expected);
    }

    // `withFileTypes: true` token must appear EXACTLY once (matches
    // the single readdir(hooksDir) call site -- a second occurrence
    // would imply a second readdir call which D98.M.7 forbids).
    const withFileTypesOffenders = findOffenders(source, /withFileTypes:\s*true/);
    expect(
      withFileTypesOffenders.length,
      `hook-uninstall.ts must contain the literal \`withFileTypes: true\` token EXACTLY once (D98.M.7 separate grep enforcement; matches the single readdir(hooksDir) call site). Found ${withFileTypesOffenders.length}.`,
    ).toBe(1);

    // Aggregate guards: total counts per fs operation must match the
    // per-variable sum. Catches an extra `lstat(otherPath)` /
    // `readdir(otherPath)` etc. that bypasses the variable-specific
    // pattern table.
    expect(
      findOffenders(source, /\blstat\(/).length,
      "hook-uninstall.ts must contain EXACTLY 4 lstat() source call sites total (1 .git + 1 hooksDir + 2 hookPath = 4) (D98.M.7 aggregate guard).",
    ).toBe(4);
    expect(
      findOffenders(source, /\breadFile\(/).length,
      "hook-uninstall.ts must contain EXACTLY 1 readFile() source call site total (D98.M.7 aggregate guard).",
    ).toBe(1);
    expect(
      findOffenders(source, /\brm\(/).length,
      "hook-uninstall.ts must contain EXACTLY 1 rm() source call site total (D98.M.7 aggregate guard).",
    ).toBe(1);
    expect(
      findOffenders(source, /\breaddir\(/).length,
      "hook-uninstall.ts must contain EXACTLY 1 readdir() source call site total (D98.M.7 aggregate guard).",
    ).toBe(1);
    expect(
      findOffenders(source, /\brename\(/).length,
      "hook-uninstall.ts must contain EXACTLY 1 rename() source call site total (D98.M.7 aggregate guard).",
    ).toBe(1);
    expect(
      findOffenders(source, /\bchmod\(/).length,
      "hook-uninstall.ts must contain EXACTLY 1 chmod() source call site total (D98.M.7 aggregate guard).",
    ).toBe(1);

    const forbiddenOps: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "mkdir(", pattern: /\bmkdir\(/ },
      { name: "writeFile(", pattern: /\bwriteFile\(/ },
      { name: "writeFileAtomic(", pattern: /\bwriteFileAtomic\(/ },
      { name: "unlink(", pattern: /\bunlink\(/ },
      { name: "copyFile(", pattern: /\bcopyFile\(/ },
      { name: "stat( (without `l` prefix)", pattern: /\bstat\(/ },
    ];
    for (const { name, pattern } of forbiddenOps) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `hook-uninstall.ts must NOT call \`${name}\` (D98.M.7 forbidden op). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  // ===========================================================================
  // D98.M.8 -- import-count locks for cross-file symbols
  // ===========================================================================

  it("D98.M.8: HOOK_SCRIPT_TEMPLATE imported exactly once in hook-install.ts from @viberevert/adapters; MANAGED_BY_MARKER imported exactly once in EACH of install + uninstall from @viberevert/adapters; detectHookManagers imported once from @viberevert/adapters + called once in hook-install.ts", () => {
    // D98.M.8 amendment (M G1b Step 1): hook-managers.ts and hook-script.ts
    // moved from packages/cli-commands/src/ to packages/adapters/src/.
    // hook-install.ts and hook-uninstall.ts now import the surface via
    // the @viberevert/adapters package barrel. The "single call site"
    // part of the original lock is preserved; the "single implementation"
    // part is reinforced AND moves DOWN a package layer to break the
    // dependency cycle. Catches accidental template inlining, marker
    // drift, or duplicate detection invocations (one import does NOT
    // prevent two calls -- both locks are required for detectHookManagers).
    //
    // **Multi-line imports**: biome formats imports with >3 symbols as
    // multi-line blocks where each symbol sits on its own line --
    // findOffenders splits per-line and cannot match
    // `import { ... SYMBOL ... }` when the symbol is on its own line.
    // We use a local stripCommentsToString helper (same comment-filter
    // logic as findOffenders) + multi-line regex matching against the
    // joined non-comment source. Character class `[^}]*` matches
    // across newlines naturally (no /s flag needed).
    //
    // **Source-module anchoring**: each named-import count is tied to
    // the EXACT locked module specifier (@viberevert/adapters). Catches
    // the bypass where a future maintainer might import
    // HOOK_SCRIPT_TEMPLATE from a forked / re-exporting module like
    // `./somewhere-else.js` -- the symbol would appear in an import
    // block but NOT in our locked-source import. The
    // `countNamedImportFrom` helper composes the symbol and specifier
    // into one anchored regex.
    //
    // detectHookManagers's CALL site is still checked via findOffenders
    // since function calls sit on one line.

    function stripCommentsToString(source: string): string {
      let inBlockComment = false;
      return source
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          if (inBlockComment) {
            if (trimmed.includes("*/")) inBlockComment = false;
            return false;
          }
          if (trimmed.startsWith("//")) return false;
          if (trimmed.startsWith("/*")) {
            if (!trimmed.includes("*/")) inBlockComment = true;
            return false;
          }
          if (trimmed.startsWith("*")) return false;
          return true;
        })
        .join("\n");
    }

    function countNamedImportFrom(
      source: string,
      symbol: string,
      specifierPattern: string,
    ): number {
      const pattern = new RegExp(
        `(?:^|\\n)\\s*import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s+["']${specifierPattern}["']`,
        "g",
      );
      return (source.match(pattern) || []).length;
    }

    const installSource = readSource(HOOK_INSTALL_REL);
    const uninstallSource = readSource(HOOK_UNINSTALL_REL);
    const installSourceStripped = stripCommentsToString(installSource);
    const uninstallSourceStripped = stripCommentsToString(uninstallSource);

    const adaptersSpecifier = String.raw`@viberevert\/adapters`;

    // HOOK_SCRIPT_TEMPLATE: exactly 1 import in install (from
    // @viberevert/adapters); absent in uninstall.
    const tmplInInstall = countNamedImportFrom(
      installSourceStripped,
      "HOOK_SCRIPT_TEMPLATE",
      adaptersSpecifier,
    );
    expect(
      tmplInInstall,
      `hook-install.ts must import HOOK_SCRIPT_TEMPLATE exactly once from "@viberevert/adapters" (D98.M.8). Found ${tmplInInstall}.`,
    ).toBe(1);
    const tmplInUninstall = countNamedImportFrom(
      uninstallSourceStripped,
      "HOOK_SCRIPT_TEMPLATE",
      adaptersSpecifier,
    );
    expect(
      tmplInUninstall,
      `hook-uninstall.ts must NOT import HOOK_SCRIPT_TEMPLATE (D98.M.8 -- uninstall does not write the template). Found ${tmplInUninstall}.`,
    ).toBe(0);

    // MANAGED_BY_MARKER: exactly 1 import in EACH of install + uninstall
    // (both from @viberevert/adapters).
    const markerInInstall = countNamedImportFrom(
      installSourceStripped,
      "MANAGED_BY_MARKER",
      adaptersSpecifier,
    );
    expect(
      markerInInstall,
      `hook-install.ts must import MANAGED_BY_MARKER exactly once from "@viberevert/adapters" (D98.M.8). Found ${markerInInstall}.`,
    ).toBe(1);
    const markerInUninstall = countNamedImportFrom(
      uninstallSourceStripped,
      "MANAGED_BY_MARKER",
      adaptersSpecifier,
    );
    expect(
      markerInUninstall,
      `hook-uninstall.ts must import MANAGED_BY_MARKER exactly once from "@viberevert/adapters" (D98.M.8). Found ${markerInUninstall}.`,
    ).toBe(1);

    // detectHookManagers: exactly 1 import (from @viberevert/adapters)
    // + exactly 1 call site in hook-install.ts. One import does NOT
    // prevent two calls -- both locks are required to catch duplicate
    // invocations.
    const detectImports = countNamedImportFrom(
      installSourceStripped,
      "detectHookManagers",
      adaptersSpecifier,
    );
    expect(
      detectImports,
      `hook-install.ts must import detectHookManagers exactly once from "@viberevert/adapters" (D98.M.8). Found ${detectImports}.`,
    ).toBe(1);
    const detectCalls = findOffenders(installSource, /\bdetectHookManagers\s*\(\s*repoRoot\s*\)/);
    expect(
      detectCalls.length,
      `hook-install.ts must call detectHookManagers(repoRoot) exactly once (D98.M.8). Found ${detectCalls.length}: ${JSON.stringify(detectCalls)}`,
    ).toBe(1);
  });

  // ===========================================================================
  // D98.M.9 -- CLI index.ts hook command exposure (import + register counts)
  // ===========================================================================

  it("D98.M.9: index.ts imports HookInstallCommand AND HookUninstallCommand exactly once each AND registers each via cli.register exactly once", () => {
    // D98.M.9 locks command EXPOSURE through the binary -- the
    // integration tests register each command manually via their
    // in-test Cli, so if a future maintainer removes the
    // cli.register(...) line from index.ts EVERY test still passes
    // but the binary `viberevert hook install` / `viberevert hook
    // uninstall` becomes unreachable. This test closes that gap.
    const source = readSource(CLI_INDEX_REL);

    // M G1a Step 1 substep 9: same barrel-import shape change as
    // M E's command-exposure lock. D98.M.9 checks BOTH HookInstall
    // and HookUninstall appear in the @viberevert/cli-commands
    // barrel import exactly once each.
    const barrelImportBody = getCliCommandsBarrelImportBody(source);

    const installMatches = barrelImportBody.match(/\bHookInstallCommand\b/g) ?? [];
    expect(
      installMatches.length,
      `index.ts must import HookInstallCommand exactly once from @viberevert/cli-commands (D98.M.9). Found ${installMatches.length}.`,
    ).toBe(1);

    const uninstallMatches = barrelImportBody.match(/\bHookUninstallCommand\b/g) ?? [];
    expect(
      uninstallMatches.length,
      `index.ts must import HookUninstallCommand exactly once from @viberevert/cli-commands (D98.M.9). Found ${uninstallMatches.length}.`,
    ).toBe(1);

    const installRegisters = findOffenders(
      source,
      /\bcli\.register\s*\(\s*HookInstallCommand\s*\)/,
    );
    expect(
      installRegisters.length,
      `index.ts must register HookInstallCommand via cli.register(HookInstallCommand) exactly once (D98.M.9). Found ${installRegisters.length}.`,
    ).toBe(1);

    const uninstallRegisters = findOffenders(
      source,
      /\bcli\.register\s*\(\s*HookUninstallCommand\s*\)/,
    );
    expect(
      uninstallRegisters.length,
      `index.ts must register HookUninstallCommand via cli.register(HookUninstallCommand) exactly once (D98.M.9). Found ${uninstallRegisters.length}.`,
    ).toBe(1);
  });

  // ===========================================================================
  // D98.M.10 -- index.ts registration ORDER + immediately-after lock
  // ===========================================================================

  it("D98.M.10: index.ts registration ORDER -- RollbackCommand < HookInstallCommand < HookUninstallCommand AND HookUninstallCommand IMMEDIATELY after HookInstallCommand", () => {
    // D98.M.10 locks the workflow-grouping convention from the M F
    // plan: hook commands sit immediately after the rollback command,
    // and the two hook commands are registered as a pair (no other
    // command may be inserted between them). This mirrors D90's
    // ReportCommand < PromptFixCommand < RollbackCommand pattern.
    //
    // Defensive: assert each anchor exists before comparing indices --
    // indexOf returning -1 would silently satisfy `-1 < n` when `n`
    // is also non-negative.
    const source = readSource(CLI_INDEX_REL);

    const rollbackIdx = source.indexOf("cli.register(RollbackCommand);");
    const hookInstallIdx = source.indexOf("cli.register(HookInstallCommand);");
    const hookUninstallIdx = source.indexOf("cli.register(HookUninstallCommand);");

    expect(
      rollbackIdx,
      "RollbackCommand registration missing from index.ts (D98.M.10 anchor)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      hookInstallIdx,
      "HookInstallCommand registration missing from index.ts (D98.M.10)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      hookUninstallIdx,
      "HookUninstallCommand registration missing from index.ts (D98.M.10)",
    ).toBeGreaterThanOrEqual(0);

    expect(
      rollbackIdx,
      "HookInstallCommand must be registered AFTER RollbackCommand in index.ts (D98.M.10)",
    ).toBeLessThan(hookInstallIdx);
    expect(
      hookInstallIdx,
      "HookUninstallCommand must be registered AFTER HookInstallCommand in index.ts (D98.M.10)",
    ).toBeLessThan(hookUninstallIdx);

    // "Immediately after" lock: between the HookInstall register line
    // and the HookUninstall register line, there must be NO other
    // cli.register(...) call. This enforces the "register them as a
    // pair" intent vs. allowing arbitrary commands to be inserted
    // between them.
    const between = source.slice(
      hookInstallIdx + "cli.register(HookInstallCommand);".length,
      hookUninstallIdx,
    );
    const interlopingRegisters = findOffenders(between, /\bcli\.register\s*\(/);
    expect(
      interlopingRegisters,
      `HookUninstallCommand must be registered IMMEDIATELY after HookInstallCommand with no other cli.register() between them (D98.M.10). Interloping registrations: ${JSON.stringify(interlopingRegisters)}`,
    ).toEqual([]);
  });

  // ===========================================================================
  // D98.M.11 -- hook-managers.ts fs source-call-site surface
  // ===========================================================================

  it("D98.M.11: hook-managers.ts filesystem surface -- exact source-call-site counts (6 lstats + 1 readFile = 7 total sites) + aggregate per-op guards + forbidden ops", () => {
    // D98.W locks the hook-managers.ts fs surface to EXACTLY these
    // 7 source call sites:
    //   lstat(huskyDirPath) x1, readFile(packageJsonPath) x1, plus one
    //   lstat per lefthook file signal:
    //     lstat(lefthookYmlPath), lstat(lefthookYamlPath),
    //     lstat(dotLefthookYmlPath), lstat(dotLefthookYamlPath),
    //     lstat(lefthookLocalYmlPath).
    // 6 lstats + 1 readFile = 7 total fs source call sites.
    //
    // Plus: aggregate per-op guards (catches an extra
    // `lstat(otherPath)` / `readFile(otherPath)` that bypasses the
    // variable-specific pattern table).
    //
    // Plus: forbid readdir, stat without `l`, write, rename, chmod,
    // unlink, rm -- hook-managers.ts is pure detection logic and
    // never mutates.
    const source = readSource(HOOK_MANAGERS_REL);
    const expectedSingleSites: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "lstat(huskyDirPath", pattern: /lstat\(huskyDirPath/ },
      { name: "readFile(packageJsonPath", pattern: /readFile\(packageJsonPath/ },
      { name: "lstat(lefthookYmlPath", pattern: /lstat\(lefthookYmlPath/ },
      { name: "lstat(lefthookYamlPath", pattern: /lstat\(lefthookYamlPath/ },
      { name: "lstat(dotLefthookYmlPath", pattern: /lstat\(dotLefthookYmlPath/ },
      { name: "lstat(dotLefthookYamlPath", pattern: /lstat\(dotLefthookYamlPath/ },
      { name: "lstat(lefthookLocalYmlPath", pattern: /lstat\(lefthookLocalYmlPath/ },
    ];
    for (const { name, pattern } of expectedSingleSites) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders.length,
        `hook-managers.ts must contain EXACTLY 1 \`${name}\` source call site (D98.M.11). Found ${offenders.length}: ${JSON.stringify(offenders)}`,
      ).toBe(1);
    }

    // Aggregate guards: total counts per fs operation must match the
    // per-variable sum. Catches an extra `lstat(otherPath)` /
    // `readFile(otherPath)` that bypasses the variable-specific
    // pattern table.
    expect(
      findOffenders(source, /\blstat\(/).length,
      "hook-managers.ts must contain EXACTLY 6 lstat() source call sites total (D98.M.11 aggregate guard).",
    ).toBe(6);
    expect(
      findOffenders(source, /\breadFile\(/).length,
      "hook-managers.ts must contain EXACTLY 1 readFile() source call site total (D98.M.11 aggregate guard).",
    ).toBe(1);

    const forbiddenOps: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "readdir(", pattern: /\breaddir\(/ },
      { name: "mkdir(", pattern: /\bmkdir\(/ },
      { name: "writeFile(", pattern: /\bwriteFile\(/ },
      { name: "rename(", pattern: /\brename\(/ },
      { name: "chmod(", pattern: /\bchmod\(/ },
      { name: "rm(", pattern: /\brm\(/ },
      { name: "unlink(", pattern: /\bunlink\(/ },
      { name: "stat( (without `l` prefix)", pattern: /\bstat\(/ },
    ];
    for (const { name, pattern } of forbiddenOps) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `hook-managers.ts must NOT call \`${name}\` (D98.M.11 forbidden op). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  // ===========================================================================
  // D98.M.12 -- cross-command import lock
  // ===========================================================================

  it("D98.M.12: hook-install.ts and hook-uninstall.ts MUST NOT import from each other in any form (.js or .ts subpath; either `./hook-*` or `../commands/hook-*` specifier)", () => {
    // Cross-command import would create coupling that fragments the
    // single-responsibility boundary and risks circular-import
    // surprises in M G1+. Shared error classes
    // (UnsupportedGitHookLayoutError, UnsupportedGitHooksDirectoryError)
    // are intentionally re-defined locally in each file rather than
    // imported across. Catches all 4 import forms AND both .js / .ts
    // subpath suffixes AND both sibling-relative (`./hook-*`) and
    // parent-relative (`../commands/hook-*`) specifier shapes
    // (future-proofs against a refactor that uses parent-relative
    // paths in type-only or test-shaped imports); type-only imports
    // are also caught by `from "..."` since the suffix is identical.
    const installSource = readSource(HOOK_INSTALL_REL);
    const uninstallSource = readSource(HOOK_UNINSTALL_REL);

    const hookUninstallSpecifier = String.raw`(?:\.\/hook-uninstall|\.\.\/commands\/hook-uninstall)(?:\.(?:js|ts))?`;
    const installToUninstallPattern = new RegExp(
      `(?:from\\s+["']${hookUninstallSpecifier}["']` +
        `|import\\s*\\(\\s*["']${hookUninstallSpecifier}["']\\s*\\)` +
        `|require\\s*\\(\\s*["']${hookUninstallSpecifier}["']\\s*\\)` +
        `|import\\s+\\w+\\s*=\\s*require\\s*\\(\\s*["']${hookUninstallSpecifier}["']\\s*\\))`,
    );
    const installOffenders = findOffenders(installSource, installToUninstallPattern);
    expect(
      installOffenders,
      `hook-install.ts must NOT import from hook-uninstall.ts in any form (D98.M.12). Matches: ${JSON.stringify(installOffenders)}`,
    ).toEqual([]);

    const hookInstallSpecifier = String.raw`(?:\.\/hook-install|\.\.\/commands\/hook-install)(?:\.(?:js|ts))?`;
    const uninstallToInstallPattern = new RegExp(
      `(?:from\\s+["']${hookInstallSpecifier}["']` +
        `|import\\s*\\(\\s*["']${hookInstallSpecifier}["']\\s*\\)` +
        `|require\\s*\\(\\s*["']${hookInstallSpecifier}["']\\s*\\)` +
        `|import\\s+\\w+\\s*=\\s*require\\s*\\(\\s*["']${hookInstallSpecifier}["']\\s*\\))`,
    );
    const uninstallOffenders = findOffenders(uninstallSource, uninstallToInstallPattern);
    expect(
      uninstallOffenders,
      `hook-uninstall.ts must NOT import from hook-install.ts in any form (D98.M.12). Matches: ${JSON.stringify(uninstallOffenders)}`,
    ).toEqual([]);
  });

  // ===========================================================================
  // D98.M.13 -- hook-install + hook-uninstall + hook-managers ASCII-only
  // ===========================================================================

  it("D98.M.13: hook-install.ts + hook-uninstall.ts + hook-managers.ts are ASCII-only at byte level", () => {
    // Mirrors D98.M.4's byte-level scan applied to the three M F CLI
    // source files. Catches em-dashes, smart quotes, arrows, ellipsis,
    // and any other non-ASCII char anywhere in any context (output
    // strings, comments, JSDoc, identifiers, default values) without
    // needing a fragile string-literal parser. Extends D55's "no
    // ANSI color" rule consistently across the M F surface.
    for (const rel of HOOK_SOURCE_RELS) {
      const source = readSource(rel);
      const nonAscii: Array<{ index: number; codePoint: number }> = [];
      for (let i = 0; i < source.length; i++) {
        const codePoint = source.charCodeAt(i);
        if (codePoint >= 128) {
          nonAscii.push({ index: i, codePoint });
        }
      }
      expect(
        nonAscii,
        `${rel} must be ASCII-only at byte level (D98.M.13). Non-ASCII chars (first 10): ${JSON.stringify(nonAscii.slice(0, 10))}`,
      ).toEqual([]);
    }
  });

  // ===========================================================================
  // D98.M.14 -- hook-script.ts: forbid raw multi-line template literal for HOOK_SCRIPT_TEMPLATE
  // ===========================================================================

  it("D98.M.14: hook-script.ts MUST NOT assign HOOK_SCRIPT_TEMPLATE via a raw multi-line template literal", () => {
    // HOOK_SCRIPT_TEMPLATE must be constructed via
    //   [...lines].join("\n") + "\n"
    // (NOT a raw multi-line backtick template literal). The locked
    // construction guarantees LF-only line endings; a raw template
    // literal on Windows + autocrlf=true could pick up CRLF at
    // checkout time, breaking the on-disk hook script.
    //
    // Broadened regex (\bHOOK_SCRIPT_TEMPLATE\b[^=]*=\s*`) catches:
    //   const HOOK_SCRIPT_TEMPLATE = `...`
    //   export const HOOK_SCRIPT_TEMPLATE = `...`
    //   export const HOOK_SCRIPT_TEMPLATE: string = `...`
    // and any future typed-assignment variant. Does NOT match
    // legitimate uses like `HOOK_SCRIPT_TEMPLATE` referenced inside
    // join-array expressions, function returns, or string
    // interpolations elsewhere in the file. The `[^=]*` is greedy
    // but bounded by the requirement of a subsequent `=` followed by
    // optional whitespace then a backtick -- only an actual assignment
    // to a template literal satisfies that shape.
    const source = readSource(HOOK_SCRIPT_REL);
    const antipattern = /\bHOOK_SCRIPT_TEMPLATE\b[^=]*=\s*`/;
    const offenders = findOffenders(source, antipattern);
    expect(
      offenders,
      `hook-script.ts must NOT assign HOOK_SCRIPT_TEMPLATE via a raw multi-line template literal (D98.M.14). Use [...lines].join("\\n") + "\\n" instead. Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

// =============================================================================
// M G1b D101.M -- @viberevert/adapters package boundaries
// =============================================================================
//
// Three invariants lock the new public seam created by M G1b Step 1's
// cycle break (D98.M.8 amendment). The hook surface (hook-managers.ts +
// hook-script.ts) moved from packages/cli-commands/src/ into
// packages/adapters/src/, breaking the dependency cycle that would have
// formed when packages/installers and packages/cli-commands both needed
// the same hook surface:
//
//   - D101.M.1 -- Adapter read-only discipline: packages/adapters/src/
//     MUST NOT contain any filesystem-mutating call symbols (writeFile,
//     mkdir, rename, rm, chmod, unlink) or process-spawn symbols
//     (child_process, exec, spawn). Adapters MAY read fs during
//     detect/plan (lstat, readFile), but MUST NEVER mutate. The mutating
//     engine lives in @viberevert/installers; adapters compute Plans,
//     never apply them.
//
//   - D101.M.1b -- Integrations-store ownership: packages/adapters/src/
//     MUST NOT contain any reference to "integrations.json". That store
//     is owned exclusively by @viberevert/installers; adapters describe
//     desired state and have no concept of "already installed" (that
//     decision happens in the installer engine via InstallOutcome's
//     applied / noop / refused union). If adapters could read
//     integrations.json, the read-only vs. write-only layer split would
//     collapse and NoopPlan-style logic would creep back into adapters.
//
//   - D101.M.2 -- Hook surface re-export: packages/adapters/src/index.ts
//     MUST export the moved hook surface symbols (detectHookManagers +
//     hook-script constants + formatBackupTimestamp + the two
//     hook-managers error classes). cli-commands' hook-install.ts and
//     hook-uninstall.ts depend on this barrel re-export per the D98.M.8
//     amendment; if it disappears, those files break.

describe("Architectural invariants -- M G1b D101.M @viberevert/adapters boundaries", () => {
  const ADAPTERS_SRC_DIR = "packages/adapters/src";
  const ADAPTERS_BARREL_REL = "packages/adapters/src/index.ts";

  // ===========================================================================
  // D101.M.1 -- adapters source MUST NOT call fs-mutation or spawn symbols
  // ===========================================================================

  it("D101.M.1: packages/adapters/src/** MUST NOT call writeFile / mkdir / rename / rm / chmod / unlink / child_process / exec / spawn (adapter read-only discipline)", () => {
    // Per D101.A, adapters are READ-ONLY: they may inspect filesystem
    // state during detect/plan (lstat, readFile) but MUST NEVER mutate.
    // Mutation lives in @viberevert/installers's engine. This invariant
    // catches accidental drift -- a future maintainer reaching for
    // `writeFile` inside an adapter would silently break the layer
    // separation that the D98.M.8 cycle break depends on.
    //
    // Source is pre-stripped via `stripTsComments` so docstrings
    // mentioning forbidden tokens by name don't false-positive
    // (e.g., "// installers, not adapters, calls writeFile here").
    const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "writeFile(", pattern: /\bwriteFile\s*\(/ },
      { name: "writeFileSync(", pattern: /\bwriteFileSync\s*\(/ },
      { name: "mkdir(", pattern: /\bmkdir\s*\(/ },
      { name: "mkdirSync(", pattern: /\bmkdirSync\s*\(/ },
      { name: "rename(", pattern: /\brename\s*\(/ },
      { name: "renameSync(", pattern: /\brenameSync\s*\(/ },
      { name: "rm(", pattern: /\brm\s*\(/ },
      { name: "rmSync(", pattern: /\brmSync\s*\(/ },
      { name: "rmdir(", pattern: /\brmdir\s*\(/ },
      { name: "rmdirSync(", pattern: /\brmdirSync\s*\(/ },
      { name: "chmod(", pattern: /\bchmod\s*\(/ },
      { name: "chmodSync(", pattern: /\bchmodSync\s*\(/ },
      { name: "unlink(", pattern: /\bunlink\s*\(/ },
      { name: "unlinkSync(", pattern: /\bunlinkSync\s*\(/ },
      { name: 'from "node:child_process"', pattern: /from\s*["']node:child_process["']/ },
      { name: 'from "child_process"', pattern: /from\s*["']child_process["']/ },
      { name: "exec(", pattern: /\bexec\s*\(/ },
      { name: "execSync(", pattern: /\bexecSync\s*\(/ },
      { name: "spawn(", pattern: /\bspawn\s*\(/ },
      { name: "spawnSync(", pattern: /\bspawnSync\s*\(/ },
      { name: "execFile(", pattern: /\bexecFile\s*\(/ },
      { name: "execFileSync(", pattern: /\bexecFileSync\s*\(/ },
    ];

    const srcDirAbs = join(REPO_ROOT, ADAPTERS_SRC_DIR);
    const files = findTsFiles(srcDirAbs);
    expect(
      files.length,
      `D101.M.1 self-check: expected at least one .ts file under ${ADAPTERS_SRC_DIR}/.`,
    ).toBeGreaterThan(0);

    for (const absPath of files) {
      const rel = relative(REPO_ROOT, absPath).replace(/\\/g, "/");
      const source = stripTsComments(readFileSync(absPath, "utf8"));
      for (const { name, pattern } of FORBIDDEN) {
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${rel} must NOT call ${name} (D101.M.1 adapter read-only discipline). Mutation lives in @viberevert/installers; adapters compute Plans, never apply them. Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  // ===========================================================================
  // D101.M.1b -- adapters source MUST NOT reference integrations.json
  // ===========================================================================

  it("D101.M.1b: packages/adapters/src/** MUST NOT contain any reference to 'integrations.json' (integrations-store ownership)", () => {
    // The integrations store (.viberevert/integrations.json) is owned
    // exclusively by @viberevert/installers. Adapters describe desired
    // state via Plans and never decide "already installed" -- that
    // decision happens inside the installer engine via InstallOutcome's
    // applied / noop / refused discriminated union. Allowing adapters
    // to read integrations.json would collapse the read-only vs.
    // write-only layer split and let NoopPlan-style logic creep back
    // into adapters.
    //
    // Source is pre-stripped via `stripTsComments` so documentation
    // that mentions the file by name to clarify what adapters DON'T do
    // is allowed; only code references trigger the failure.
    const pattern = /integrations\.json/i;

    const srcDirAbs = join(REPO_ROOT, ADAPTERS_SRC_DIR);
    const files = findTsFiles(srcDirAbs);
    expect(
      files.length,
      `D101.M.1b self-check: expected at least one .ts file under ${ADAPTERS_SRC_DIR}/.`,
    ).toBeGreaterThan(0);

    for (const absPath of files) {
      const rel = relative(REPO_ROOT, absPath).replace(/\\/g, "/");
      const source = stripTsComments(readFileSync(absPath, "utf8"));
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `${rel} must NOT reference "integrations.json" (D101.M.1b -- the integrations store is owned by @viberevert/installers; adapters describe desired state only). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  // ===========================================================================
  // D101.M.2 -- adapters barrel re-exports the moved hook surface
  // ===========================================================================

  it("D101.M.2: packages/adapters/src/index.ts MUST re-export the moved hook surface (D98.M.8 amendment)", () => {
    // M G1b Step 1 moved hook-managers.ts + hook-script.ts from
    // packages/cli-commands/src/ into packages/adapters/src/. The
    // cli-commands hook-install.ts and hook-uninstall.ts files depend
    // on these symbols being re-exported through the @viberevert/adapters
    // barrel (consumers import them as `@viberevert/adapters`, NOT via
    // deep paths). If the barrel stops re-exporting any of these
    // symbols, the import rewires in hook-install.ts + hook-uninstall.ts
    // break at typecheck/build time.
    const exported = collectBarrelExports(readSource(ADAPTERS_BARREL_REL));
    const REQUIRED: ReadonlyArray<string> = [
      // From hook-managers.ts (moved per D98.M.8 amendment).
      "detectHookManagers",
      "HookManagerIoError",
      "MalformedPackageJsonError",
      // From hook-script.ts (moved per D98.M.8 amendment).
      "MANAGED_BY_MARKER",
      "BACKUP_FILE_PREFIX",
      "BACKUP_FILE_REGEX",
      "HOOK_SCRIPT_TEMPLATE",
      "formatBackupTimestamp",
    ];
    for (const symbol of REQUIRED) {
      expect(
        exported.has(symbol),
        `@viberevert/adapters barrel must export ${symbol} (D101.M.2 -- D98.M.8 amendment requires the moved hook surface to be reachable through the barrel; consumed by cli-commands hook-install.ts + hook-uninstall.ts).`,
      ).toBe(true);
    }
  });
});

// =============================================================================
// M G1a D99.M -- @viberevert/cli-commands package boundaries
// =============================================================================
//
// Four invariants lock the new public seam created by M G1a Step 1:
//
//   - D99.M.19 -- Barrel guard: required public symbols (runtime AND
//     TypeScript types) are exported AND known package-internal symbols
//     stay un-exported.
//   - D99.M.20 -- cli-commands process hygiene: no direct writes to
//     process.stdout / process.stderr / process.exit / console.* anywhere
//     under packages/cli-commands/src/**. Commands route output through
//     this.context.stdout / this.context.stderr (BaseContext) so the
//     in-process Clipanion harness (D99.W) can capture into bounded
//     memory sinks instead of corrupting the MCP server's stdio framing
//     (D99.X).
//   - D99.M.21 -- Operation contract: the 4 typed operations exist as
//     standalone files exporting their named function AND obey a STRICTER
//     hygiene rule than Commands do (no process.cwd, no Clipanion
//     context, no Clipanion imports, no stream imports, no streams,
//     no console). Their lock-path constants stay declared in the
//     operation files but are NOT barrel-exported -- defense in depth
//     with D99.M.19b.
//   - D99.M.22 -- Drift detection: each of the 3 refactored Commands
//     (start, checkpoint, prompt-fix) imports AND calls its corresponding
//     operation AND does NOT embed any of the old domain helpers the
//     operation now owns. Prevents a future maintainer from re-embedding
//     domain logic into a Command and silently diverging from the MCP
//     handler that calls the same operation.
//
// Numbering rationale: D99.M.19-22 follows directly after the M G1a
// plan's D99.M.1-18 mcp-package invariants. The mcp-package invariants
// are NOT in this file; they will land in the @viberevert/mcp test suite
// when Step 2+ ships. This file owns only the cli-commands-side
// invariants because cli-commands is the dependency target for both
// the CLI binary and the future mcp package -- invariants on the
// EXPORTED seam live with the EXPORTER.

describe("Architectural invariants -- M G1a D99.M @viberevert/cli-commands boundaries", () => {
  const CLI_COMMANDS_BARREL_REL = "packages/cli-commands/src/index.ts";
  const CLI_COMMANDS_SRC_DIR = "packages/cli-commands/src";
  const CLI_COMMANDS_OPERATIONS_DIR = "packages/cli-commands/src/operations";

  const START_OPERATION_REL = "packages/cli-commands/src/operations/start-session.ts";
  const END_OPERATION_REL = "packages/cli-commands/src/operations/end-session.ts";
  const CREATE_CHECKPOINT_OPERATION_REL =
    "packages/cli-commands/src/operations/create-checkpoint.ts";
  const GENERATE_FIX_PROMPT_OPERATION_REL =
    "packages/cli-commands/src/operations/generate-fix-prompt.ts";

  const START_COMMAND_REL = "packages/cli-commands/src/commands/start.ts";
  const CHECKPOINT_COMMAND_REL = "packages/cli-commands/src/commands/checkpoint.ts";
  const PROMPT_FIX_COMMAND_REL = "packages/cli-commands/src/commands/prompt-fix.ts";

  // ===========================================================================
  // D99.M.19 -- Barrel guard
  // ===========================================================================

  it("D99.M.19a: @viberevert/cli-commands barrel re-exports every required public symbol (runtime + types)", () => {
    // The barrel is the SINGLE public seam through which the CLI binary
    // and @viberevert/mcp (Step 2+) consume cli-commands. M G1a Step 1
    // locks both the runtime AND type surface; this invariant asserts
    // each locked symbol remains reachable. Type re-exports (Opts/Result)
    // are part of the public seam -- losing them would compile-break MCP
    // consumers even when runtime exports stay intact.
    const exported = collectBarrelExports(readSource(CLI_COMMANDS_BARREL_REL));

    const REQUIRED_PRESENT: ReadonlyArray<string> = [
      // ----- 18 Command classes -- consumed by the `viberevert` CLI binary.
      //       Count rule: this list must match the actual public command
      //       exports in packages/cli-commands/src/index.ts. (M G2 Step 4
      //       backfilled InstallCommand + UninstallCommand, which M G1b
      //       added to the barrel without widening this list. M G3 Step 2
      //       added ShellCommand.)
      "CheckCommand",
      "CheckpointCommand",
      "CheckpointsCommand",
      "DoctorCommand",
      "EndCommand",
      "HookInstallCommand",
      "HookUninstallCommand",
      "InitCommand",
      "InstallCommand",
      "PromptFixCommand",
      "ReportCommand",
      "RollbackCommand",
      "RunCommand",
      "SessionsCommand",
      "ShellCommand",
      "StartCommand",
      "UninstallCommand",
      "VersionCommand",
      // ----- 4 typed operation functions + their Opts/Result types
      //       (paired by file). D99.E typed-operation backend.
      "startSessionOperation",
      "StartSessionOperationOpts",
      "StartSessionOperationResult",
      "endSessionOperation",
      "EndSessionOperationOpts",
      "EndSessionOperationResult",
      "createCheckpointOperation",
      "CreateCheckpointOperationOpts",
      "CreateCheckpointOperationResult",
      "generateFixPromptOperation",
      "GenerateFixPromptOperationOpts",
      "GenerateFixPromptOperationResult",
      // ----- 10 operation-public typed errors -- consumed by
      //       MCP_ERROR_CODE_MAP (EndSessionRaceError: reserved for a
      //       future MCP end_session handler; not yet mapped).
      "CheckpointNameCollisionError",
      "EndSessionRaceError",
      "CreateCheckpointListLoadError",
      "PromptFixTargetResolutionError",
      "PromptFixReadFailureError",
      "PromptFixReportParseError",
      "PromptFixDriftDetectedError",
      "PromptFixStaleRemovalFailureError",
      "PromptFixIoFailureError",
      "PromptFixEmptyFindingsError",
      // ----- 5 package-local passthrough errors -- re-exported for MCP
      //       envelope mapping.
      "ConcurrentOperationError",
      "AmbiguousReportSelectionError",
      "InvalidReportSelectionError",
      "ReportNotFoundError",
      "RuntimeEnvInvalidError",
      // ----- In-process Clipanion harness + its Opts/Result types.
      //       D99.E command-harness backend.
      "runCommandInProcess",
      "RunCommandInProcessOpts",
      "RunCommandInProcessResult",
    ];
    for (const symbol of REQUIRED_PRESENT) {
      expect(
        exported.has(symbol),
        `@viberevert/cli-commands barrel must export ${symbol} (D99.M.19a required public surface).`,
      ).toBe(true);
    }
  });

  it("D99.M.19b: @viberevert/cli-commands barrel does NOT export known package-internal symbols", () => {
    // The barrel must not leak helper internals -- other packages would
    // then key on them, freezing the cli-commands internal layout.
    // These symbols are documented at the bottom of index.ts as
    // "intentionally NOT exported"; this test enforces that prose
    // mechanically.
    const exported = collectBarrelExports(readSource(CLI_COMMANDS_BARREL_REL));

    const FORBIDDEN_ABSENT: ReadonlyArray<string> = [
      // Lock-path constants -- internal display plumbing for Commands' stderr templates.
      "START_LOCK_REL",
      "CHECKPOINT_NAME_LOCK_REL",
      // checkpoint-helpers internals -- operation wraps CheckpointListLoadError
      // into CreateCheckpointListLoadError (operation-public) so MCP keys on
      // the wrap, not the helper.
      "safeListCheckpoints",
      "CheckpointListLoadError",
      "CollisionExitSentinel",
      // prompt-fix-targets resolver internals -- operations consume them; MCP does not.
      "resolvePromptFixReportTarget",
      "PromptFixReportTarget",
      // report-paths resolver internals.
      "resolveReportPaths",
      // Atomic-IO helpers -- package-private per D17c.
      "writeFileAtomic",
      "renameDirAtomic",
      // locks.ts internals -- only ConcurrentOperationError is exported;
      // LockInfo + withExclusiveLock stay package-internal.
      "LockInfo",
      "withExclusiveLock",
      // runtime-env CLI-side utilities -- operations consume them
      // internally; barrel-exporting them would invite MCP to grow
      // a parallel timestamp/version surface.
      "resolveProductVersionForReport",
      "resolveNowForCliTimestamp",
      // command-guard matcher internals (M G2 Step 1, D102.C) -- pure
      // policy evaluation consumed only by RunCommand; exporting would
      // freeze the v1 matching semantics as public API.
      "normalizeCommand",
      "matchGuardEntry",
      "evaluateCommandPolicy",
      "CommandsPolicyConfig",
      "CommandPolicyDecision",
      // run.ts exit-mapper test surfaces (M G2 Step 4, D102.E) --
      // deep-imported by unit tests only; barrel-exporting them would
      // freeze run's exit-mapping helper as public API.
      "mapChildExitToCode",
      "ChildExitStatus",
      // shell tokenizer internals (M G3 Step 1, D103.D) -- pure v1 line
      // tokenizer consumed only by ShellCommand; barrel-exporting would
      // freeze the v1 tokenizing semantics as public API.
      "tokenizeShellLine",
      "TokenizeResult",
      // node-pty loader seam internals (M G4 Step 2, D104.D / D104.M.1) --
      // the OPTIONAL native-dep loader consumed only by the PTY engine
      // (shell-pty.ts, Step 3); barrel-exporting any of it would create a
      // public API surface around an optional native dependency.
      "loadPtyModule",
      "PtyModule",
      "PtyProcess",
      "PtySpawnOptions",
      "PtyDisposable",
      "PtyImporter",
      // interactive-shell resolver internals (M G4 Step 3a, D104.N) -- the
      // pure shell-selection contract consumed only by the PTY engine
      // (shell-pty.ts, Step 3); internal until it owns the public path.
      "resolveInteractiveShell",
      "ShellKind",
      "ResolvedShell",
      "ShellResolverEnv",
      "ShellResolverInput",
      // executable path resolver / probe internals (M G4 Step 3b, D104.N) --
      // the fs/PATH host seam consumed only by the PTY engine (shell-pty.ts,
      // Step 3); internal until it owns the public path.
      "createExecutablePathResolver",
      "createExecutableProbe",
      "createHostExecutablePathResolver",
      "createHostExecutableProbe",
      "ExecutableProbeDeps",
      // PTY engine internals (M G4 Step 3c, D104.C/G) -- the engine's host shell
      // resolution + pre-spawn precondition gate + types, consumed only within
      // the engine; internal until the guarded `--pty` path is wired (Step 3d/4).
      "resolveHostInteractiveShell",
      "ResolvedInteractiveShell",
      "HostShellResolutionDeps",
      "evaluatePtyPreconditions",
      "PtyPreconditionResult",
      "PtyPreconditionDeps",
      "PtyPreconditionRefusalReason",
    ];
    for (const symbol of FORBIDDEN_ABSENT) {
      expect(
        exported.has(symbol),
        `@viberevert/cli-commands barrel must NOT export ${symbol} (D99.M.19b -- package-internal symbol; barrel-guard exclusion).`,
      ).toBe(false);
    }
  });

  // ===========================================================================
  // D99.M.20 -- cli-commands process hygiene
  // ===========================================================================

  it("D99.M.20: packages/cli-commands/src/** MUST NOT call process.exit / process.stdout.write / process.stderr.write / console.*", () => {
    // Commands MUST route output through this.context.stdout /
    // this.context.stderr (BaseContext) so the in-process Clipanion
    // harness (D99.W) can capture into bounded memory sinks instead
    // of corrupting the MCP server's stdio framing (D99.X).
    //
    // The forbidden patterns target `process.*` and `console.*`
    // specifically. `this.context.stdout.write` is a DIFFERENT
    // textual pattern (no `process.` prefix) so it passes through
    // unaffected -- no carve-out logic needed.
    //
    // Source is passed through `stripTsComments` before `findOffenders`
    // -- `findOffenders` does line-level comment skip on its own, but
    // pre-stripping closes inline mid-line block-comment gaps.
    const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "process.exit(", pattern: /\bprocess\.exit\s*\(/ },
      { name: "process.stdout.write(", pattern: /\bprocess\.stdout\.write\s*\(/ },
      { name: "process.stderr.write(", pattern: /\bprocess\.stderr\.write\s*\(/ },
      { name: "console.log(", pattern: /\bconsole\.log\s*\(/ },
      { name: "console.error(", pattern: /\bconsole\.error\s*\(/ },
      { name: "console.warn(", pattern: /\bconsole\.warn\s*\(/ },
      { name: "console.info(", pattern: /\bconsole\.info\s*\(/ },
      { name: "console.debug(", pattern: /\bconsole\.debug\s*\(/ },
    ];

    const srcDirAbs = join(REPO_ROOT, CLI_COMMANDS_SRC_DIR);
    const files = findTsFiles(srcDirAbs);
    expect(
      files.length,
      `D99.M.20 self-check: expected at least one .ts file under ${CLI_COMMANDS_SRC_DIR}/.`,
    ).toBeGreaterThan(0);

    for (const absPath of files) {
      const rel = relative(REPO_ROOT, absPath).replace(/\\/g, "/");
      const source = stripTsComments(readFileSync(absPath, "utf8"));
      for (const { name, pattern } of FORBIDDEN) {
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${rel} must NOT call ${name} (D99.M.20 cli-commands process hygiene). Route output through this.context.stdout/stderr.write instead. Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  // ===========================================================================
  // D99.M.21 -- Operation contract
  // ===========================================================================

  it("D99.M.21a: the 4 typed operations exist as standalone files exporting their named operation function", () => {
    // Each operation file MUST export its operation function via a
    // top-level `export ... <name>(` or `export { <name> ... }`
    // form. Covers both `export async function foo(` and
    // `export { foo }` shapes. Source is stripped of comments so
    // a doc mention "// exports startSessionOperation" cannot
    // satisfy the invariant.
    const OPERATIONS: ReadonlyArray<{ rel: string; fnName: string }> = [
      { rel: START_OPERATION_REL, fnName: "startSessionOperation" },
      { rel: END_OPERATION_REL, fnName: "endSessionOperation" },
      { rel: CREATE_CHECKPOINT_OPERATION_REL, fnName: "createCheckpointOperation" },
      { rel: GENERATE_FIX_PROMPT_OPERATION_REL, fnName: "generateFixPromptOperation" },
    ];
    for (const { rel, fnName } of OPERATIONS) {
      const source = stripTsComments(readSource(rel));
      const exportFnPattern = new RegExp(
        String.raw`(?:^|\n)\s*export\s+(?:async\s+)?function\s+${fnName}\s*\(`,
      );
      const exportNamedPattern = new RegExp(
        String.raw`(?:^|\n)\s*export\s*\{[^}]*\b${fnName}\b[^}]*\}`,
      );
      expect(
        exportFnPattern.test(source) || exportNamedPattern.test(source),
        `${rel} must export ${fnName} as a top-level function or named export (D99.M.21a operation contract).`,
      ).toBe(true);
    }
  });

  it("D99.M.21b: operations/* MUST NOT call process.cwd / process.exit / streams / console.* / this.context.* AND MUST NOT import clipanion or node:stream (stricter operation hygiene)", () => {
    // Operations are pure domain functions. They receive `cwd` via
    // their typed Opts; reading `process.cwd()` would silently bind
    // to the wrong directory when called from MCP's boot-time repo
    // binding (D99.P). Operations also write to NOTHING -- output is
    // via the typed return value only.
    //
    // Stricter than D99.M.20: operations are NOT Commands and have
    // no BaseContext, so `this.context.*` is also forbidden here.
    // AND operations must not IMPORT clipanion or node:stream/stream
    // at all -- pulling `Command`/`Option`/`BaseContext` would
    // couple pure domain logic to the CLI framework; pulling stream
    // machinery would invite a parallel non-Command output path
    // that bypasses the typed return value. Forbidding the IMPORT
    // closes the structural gap that runtime-only checks leave open.
    //
    // Source is pre-stripped via `stripTsComments`; `findOffenders`
    // then handles line-level filtering.
    const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "process.cwd(", pattern: /\bprocess\.cwd\s*\(/ },
      { name: "process.exit(", pattern: /\bprocess\.exit\s*\(/ },
      { name: "process.stdout.write(", pattern: /\bprocess\.stdout\.write\s*\(/ },
      { name: "process.stderr.write(", pattern: /\bprocess\.stderr\.write\s*\(/ },
      { name: "console.log(", pattern: /\bconsole\.log\s*\(/ },
      { name: "console.error(", pattern: /\bconsole\.error\s*\(/ },
      { name: "console.warn(", pattern: /\bconsole\.warn\s*\(/ },
      { name: "console.info(", pattern: /\bconsole\.info\s*\(/ },
      { name: "console.debug(", pattern: /\bconsole\.debug\s*\(/ },
      { name: "this.context.", pattern: /\bthis\.context\./ },
      { name: 'from "clipanion"', pattern: /from\s*["']clipanion["']/ },
      { name: 'from "node:stream"', pattern: /from\s*["']node:stream["']/ },
      { name: 'from "stream"', pattern: /from\s*["']stream["']/ },
    ];

    const operationsDirAbs = join(REPO_ROOT, CLI_COMMANDS_OPERATIONS_DIR);
    const files = findTsFiles(operationsDirAbs);
    expect(
      files.length,
      `D99.M.21b self-check: expected at least 4 .ts files under ${CLI_COMMANDS_OPERATIONS_DIR}/.`,
    ).toBeGreaterThanOrEqual(4);

    for (const absPath of files) {
      const rel = relative(REPO_ROOT, absPath).replace(/\\/g, "/");
      const source = stripTsComments(readFileSync(absPath, "utf8"));
      for (const { name, pattern } of FORBIDDEN) {
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${rel} must NOT match ${name} (D99.M.21b operation contract -- stricter than D99.M.20). Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  it("D99.M.21c: lock-path constants are top-level `export const` declarations in operation files AND NOT barrel-exported (defense-in-depth with D99.M.19b)", () => {
    // Belt-and-suspenders with D99.M.19b's absent-list check.
    //
    // Half 1 -- DECLARATION FORM: the operation files DEFINE these
    // constants as top-level `export const`; the line-anchored
    // regex requires the actual declaration form on stripped source,
    // NOT just a textual mention (so a comment saying "//
    // START_LOCK_REL was moved elsewhere" CANNOT satisfy the
    // invariant).
    const startOperationSource = stripTsComments(readSource(START_OPERATION_REL));
    expect(
      /(?:^|\n)\s*export\s+const\s+START_LOCK_REL\b/.test(startOperationSource),
      `${START_OPERATION_REL} must declare \`export const START_LOCK_REL\` at top level (D99.M.21c operation file source-of-truth; comment mentions do not satisfy).`,
    ).toBe(true);

    const checkpointOperationSource = stripTsComments(readSource(CREATE_CHECKPOINT_OPERATION_REL));
    expect(
      /(?:^|\n)\s*export\s+const\s+CHECKPOINT_NAME_LOCK_REL\b/.test(checkpointOperationSource),
      `${CREATE_CHECKPOINT_OPERATION_REL} must declare \`export const CHECKPOINT_NAME_LOCK_REL\` at top level (D99.M.21c operation file source-of-truth; comment mentions do not satisfy).`,
    ).toBe(true);

    // Half 2 -- BARREL ABSENCE: the cli-commands barrel must NOT
    // re-export either constant. Redundant with D99.M.19b but kept
    // here so a single test failure points directly at the
    // lock-constant contract.
    const barrelExports = collectBarrelExports(readSource(CLI_COMMANDS_BARREL_REL));
    expect(
      barrelExports.has("START_LOCK_REL"),
      "@viberevert/cli-commands barrel must NOT export START_LOCK_REL (D99.M.21c -- internal display plumbing).",
    ).toBe(false);
    expect(
      barrelExports.has("CHECKPOINT_NAME_LOCK_REL"),
      "@viberevert/cli-commands barrel must NOT export CHECKPOINT_NAME_LOCK_REL (D99.M.21c -- internal display plumbing).",
    ).toBe(false);
  });

  // ===========================================================================
  // D99.M.22 -- Drift detection
  // ===========================================================================

  it("D99.M.22: each refactored Command imports + calls its operation AND does NOT embed old domain helpers (drift wall)", () => {
    // Three assertions per Command:
    //   (a) the operation import statement is present;
    //   (b) the operation function name appears in a call site
    //       (parenthesis-followed mention anywhere in the file);
    //   (c) none of the old domain helpers -- now owned by the
    //       operation -- appear in the Command file.
    //
    // (a) + (b) alone are necessary but not sufficient: a Command
    // could call the operation AND still keep old domain logic
    // embedded alongside, silently diverging from the MCP handler
    // that calls the same operation. (c) closes that gap.
    //
    // Source is always passed through `stripTsComments` first so
    // a doc comment mentioning a forbidden token (e.g., "// note:
    // renderFixPrompt is now owned by the operation") does not
    // false-positive.
    //
    // Known limitation: substring `.includes()` does not parse
    // TypeScript, so a forbidden token literally inside a string
    // literal would trip. None of the 17 forbidden tokens are
    // realistic stderr-template or error-message substrings.

    // ----- Half 1: import + call presence ------------------------------------
    const PAIRINGS: ReadonlyArray<{
      commandRel: string;
      operationName: string;
      operationImportPath: string;
    }> = [
      {
        commandRel: START_COMMAND_REL,
        operationName: "startSessionOperation",
        operationImportPath: "../operations/start-session.js",
      },
      {
        commandRel: CHECKPOINT_COMMAND_REL,
        operationName: "createCheckpointOperation",
        operationImportPath: "../operations/create-checkpoint.js",
      },
      {
        commandRel: PROMPT_FIX_COMMAND_REL,
        operationName: "generateFixPromptOperation",
        operationImportPath: "../operations/generate-fix-prompt.js",
      },
    ];

    for (const { commandRel, operationName, operationImportPath } of PAIRINGS) {
      const source = stripTsComments(readSource(commandRel));

      const escapedPath = operationImportPath.replace(/[/.]/g, "\\$&");
      const importPattern = new RegExp(
        String.raw`import\s*\{[^}]*\b${operationName}\b[^}]*\}\s*from\s*["']${escapedPath}["']`,
      );
      expect(
        importPattern.test(source),
        `${commandRel} must import ${operationName} from "${operationImportPath}" (D99.M.22 drift wall -- import).`,
      ).toBe(true);

      const callSiteMatches = [
        ...source.matchAll(new RegExp(String.raw`\b${operationName}\s*\(`, "g")),
      ];
      expect(
        callSiteMatches.length,
        `${commandRel} must invoke ${operationName}(...) at least once (D99.M.22 drift wall -- call site).`,
      ).toBeGreaterThanOrEqual(1);
    }

    // ----- Half 2: old helper absence ----------------------------------------
    // Each entry is a substring tested via `.includes()`. The `(`
    // suffix on certain entries enforces call-site shape and
    // disambiguates from longer-name lookalikes (e.g.,
    // `startSession(` will NOT match `startSessionOperation(`,
    // which the Command DOES call legitimately).
    const FORBIDDEN_BY_COMMAND: ReadonlyArray<{
      commandRel: string;
      forbidden: ReadonlyArray<string>;
    }> = [
      {
        commandRel: START_COMMAND_REL,
        forbidden: [
          "generateSessionId",
          "startSession(",
          "getStatusPorcelainText",
          "withExclusiveLock",
        ],
      },
      {
        commandRel: CHECKPOINT_COMMAND_REL,
        forbidden: ["safeListCheckpoints", "renameDirAtomic", "randomBytes", "createCheckpoint("],
      },
      {
        commandRel: PROMPT_FIX_COMMAND_REL,
        forbidden: [
          "renderFixPrompt",
          "ReportFileSchema",
          "resolvePromptFixReportTarget",
          "writeFileAtomic",
          "readReportBytes",
          "parseReportFile",
          "assertSourceReportUnchanged",
          "removeStaleFixPrompt",
          "persistFixPrompt",
        ],
      },
    ];

    for (const { commandRel, forbidden } of FORBIDDEN_BY_COMMAND) {
      const source = stripTsComments(readSource(commandRel));
      for (const needle of forbidden) {
        expect(
          source.includes(needle),
          `${commandRel} must NOT reference \`${needle}\` (D99.M.22 drift wall -- old helper absence; operation now owns this).`,
        ).toBe(false);
      }
    }
  });
});

describe("Architectural invariants -- M G1a Step 2 D99.M @viberevert/mcp boundaries", () => {
  const MCP_SRC_DIR = "packages/mcp/src";
  const MCP_AUDIT_REL = "packages/mcp/src/audit.ts";
  const MCP_PACKAGE_JSON_REL = "packages/mcp/package.json";
  const CLI_COMMANDS_SRC_DIR_M2 = "packages/cli-commands/src";
  const CLI_COMMANDS_PACKAGE_JSON_REL = "packages/cli-commands/package.json";

  /**
   * Known LLM-SDK package specifiers banned per D99.M.1. DUPLICATED
   * from the D90 / D98.M blocks for self-containment -- D99.M is a
   * separate decision lock and the list MUST be authoritative within
   * this block so a future change to one list does not silently
   * de-protect another subsystem.
   */
  const KNOWN_LLM_SDKS: ReadonlyArray<string> = [
    "@anthropic-ai/sdk",
    "@anthropic-ai/bedrock-sdk",
    "openai",
    "cohere-ai",
    "@google/generative-ai",
    "replicate",
    "mistralai",
    "@mistralai/mistralai",
    "ai",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@ai-sdk/mistral",
    "@langchain/openai",
    "@langchain/anthropic",
    "langchain",
    "ollama",
    "groq-sdk",
    "@groq/sdk",
    "@huggingface/inference",
    "llamaindex",
    "@aws-sdk/client-bedrock-runtime",
  ];

  /** Escape a string for use inside a RegExp constructor. */
  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Build a regex that matches all FIVE import forms of a given
   * package name (allowing subpath imports via trailing `/`):
   *
   *   1. `from "<name>"`                           -- static ESM
   *   2. `import("<name>")`                         -- dynamic ESM
   *   3. `require("<name>")`                        -- CJS
   *   4. `import x = require("<name>")`             -- TS import-equals
   *   5. `import "<name>"`                          -- ESM side-effect
   *
   * The 5th form (side-effect import) was previously missing from
   * the D90 / D98.M shape; carried here as a hardened version. A
   * side-effect import triggers module-evaluation side effects
   * (potentially the SDK's auto-registering handlers, clipanion's
   * Command-class side effects, etc.) without giving a typed
   * surface -- exactly the kind of opaque coupling these invariants
   * exist to prevent.
   */
  function buildSdkForbiddenPattern(sdkName: string): RegExp {
    const escaped = escapeRegExp(sdkName);
    return new RegExp(
      `(?:from\\s+["']${escaped}(?:["'/])` +
        `|import\\s*\\(\\s*["']${escaped}(?:["'/])` +
        `|require\\s*\\(\\s*["']${escaped}(?:["'/])` +
        `|import\\s+\\w+\\s*=\\s*require\\s*\\(\\s*["']${escaped}(?:["'/])` +
        `|import\\s+["']${escaped}(?:["'/]))`,
    );
  }

  /**
   * Collect all .ts files under packages/mcp/src and return their
   * repo-relative posix-style paths plus absolute paths. Asserts the
   * directory is non-empty as a self-check -- a typo in MCP_SRC_DIR
   * or an accidental empty src directory must fail loudly, not
   * silently pass every invariant.
   */
  function mcpSrcTsFiles(): ReadonlyArray<{ abs: string; rel: string }> {
    const abs = join(REPO_ROOT, MCP_SRC_DIR);
    const files = findTsFiles(abs);
    expect(
      files.length,
      `Self-check: expected at least one .ts file under ${MCP_SRC_DIR}/. Got 0 -- typo in MCP_SRC_DIR or missing source?`,
    ).toBeGreaterThan(0);
    return files.map((a) => ({
      abs: a,
      rel: relative(REPO_ROOT, a).replace(/\\/g, "/"),
    }));
  }

  // ===========================================================================
  // D99.M.1 -- No LLM SDK
  // ===========================================================================

  it("D99.M.1: packages/mcp/src/** does NOT import any known LLM SDK (5 import forms x KNOWN_LLM_SDKS list)", () => {
    // MCP is a protocol surface, not an LLM runtime. Source is
    // pre-stripped via stripTsComments so a doc comment mentioning
    // an SDK by name (e.g. `// see openai's chat API for parity`)
    // cannot false-positive.
    for (const { abs, rel } of mcpSrcTsFiles()) {
      const source = stripTsComments(readFileSync(abs, "utf8"));
      for (const sdk of KNOWN_LLM_SDKS) {
        const pattern = buildSdkForbiddenPattern(sdk);
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${rel} must not import ${sdk} in any form (D99.M.1 -- 5-form coverage). Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  // ===========================================================================
  // D99.M.2 -- No child_process
  // ===========================================================================

  it("D99.M.2: packages/mcp/src/** does NOT import child_process / node:child_process (5 import forms)", () => {
    // MCP runs in-process via runCommandInProcess (D99.E / D99.F).
    // Spawning a subprocess from mcp would (a) defeat the harness,
    // (b) reintroduce ambient-environment risks the harness
    // eliminates, (c) corrupt stdio framing if the subprocess
    // inherits the parent's stdio. Source pre-stripped.
    //
    // 5-form coverage explicitly includes the side-effect import
    // `import "node:child_process"` which the previous 4-form
    // shape would have missed.
    const pattern =
      /(?:from\s+["'](?:node:)?child_process["']|import\s*\(\s*["'](?:node:)?child_process["']\s*\)|require\s*\(\s*["'](?:node:)?child_process["']\s*\)|import\s+\w+\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)|import\s+["'](?:node:)?child_process["'])/;
    for (const { abs, rel } of mcpSrcTsFiles()) {
      const source = stripTsComments(readFileSync(abs, "utf8"));
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `${rel} must not import child_process / node:child_process in any form (D99.M.2 -- 5-form coverage incl. side-effect). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  // ===========================================================================
  // D99.M.5 -- No M G1b platform-integration imports
  //            (adapter/installer/platform tokens; workspace OR local-path)
  // ===========================================================================

  it("D99.M.5: packages/mcp/src/** does NOT import M G1b adapter/installer/platform-integration code (workspace specifiers OR local-path segment tokens with extension normalization)", () => {
    // Per the M G1a plan, packages/mcp must NOT depend on the husky/
    // lefthook adapter engines, the install orchestration engine, or
    // any platform-specific integration code. Those are M G1b scope
    // (`@viberevert/adapters`, `@viberevert/installers`). Enforced
    // along TWO independent axes via a single capture loop:
    //
    //   Axis 1 (workspace specifiers): forbids `@viberevert/adapters`
    //     and `@viberevert/installers`, both exact match AND subpath
    //     forms (`@viberevert/adapters/foo`). Catches the direct
    //     `import { X } from "@viberevert/adapters"` attempt and the
    //     less-obvious `import "@viberevert/installers/side-effect"`
    //     form.
    //
    //   Axis 2 (local-path segment tokens, EXTENSION-NORMALIZED):
    //     forbids RELATIVE imports where any path segment (after
    //     stripping a trailing `.<ext>`) matches the explicit token
    //     set. Extension normalization is critical because ESM/TS
    //     compiled imports include extensions (`./platform.js`,
    //     `./adapters.ts`, `../installers.mjs`); raw segment matching
    //     would miss those bypasses.
    //
    //     Match semantics (after normalization):
    //       - `./platform.js`        -> "platform"           MATCH
    //       - `./platform-hook.js`   -> "platform-hook"      no match
    //       - `./reporters`          -> "reporters"          no match
    //       - `../installers/foo`    -> ["..","installers","foo"]  MATCH (installers)
    //       - `./adapter.cjs`        -> "adapter"            MATCH (singular)
    //       - `./platform-integration.ts` -> "platform-integration"  MATCH
    //
    //     Defense-in-depth: mcp/src does not currently have any of
    //     these subdirectories; a future contributor adding one and
    //     importing from it would still violate the M G1a boundary
    //     even if no workspace dep was added.
    //
    // Allowlist is EXPLICIT (small named sets) rather than broad
    // pattern allowance -- each new exception requires a deliberate
    // edit to this test, not silent absorption by a permissive regex.
    //
    // Import-form coverage: a single capture-group regex covers
    // import/export-from, dynamic `import()`, `require()`, TS
    // `import = require()`, and side-effect `import "..."`. The
    // `from\s+["']` arm catches BOTH `import X from "Y"` AND
    // `export X from "Y"` (re-export from a forbidden module is
    // also a violation). Type-only imports
    // (`import type {} from "..."` / `export type {} from "..."`)
    // are caught regardless of the leading `type` keyword -- even
    // type-level coupling to platform-integration code is a smell
    // at this boundary.
    //
    // Source pre-stripped via stripTsComments so comment-line
    // mentions of forbidden specifiers do not false-positive.
    const FORBIDDEN_WORKSPACE_PACKAGES = [
      "@viberevert/adapters",
      "@viberevert/installers",
    ] as const;
    // Explicit named token set covering singular + plural forms +
    // platform-integration variants. Singular catches `./adapter.js`
    // (a contributor naming the file in singular); plural catches
    // `./adapters/foo`; -integration variants close the explicit
    // sibling spelling.
    const FORBIDDEN_LOCAL_PATH_TOKENS = [
      "adapter",
      "adapters",
      "installer",
      "installers",
      "platform",
      "platforms",
      "platform-integration",
      "platform-integrations",
    ] as const;

    // Capture group 1 = the unquoted import specifier string. Five
    // alternations cover the import forms; each captures the
    // specifier via the shared trailing `["']([^"']+)["']`.
    const IMPORT_SPECIFIER_RE =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+\w+\s*=\s*require\s*\(\s*|import\s+)["']([^"']+)["']/g;

    // Extension stripper: removes the LAST `.<ext>` from a basename.
    // `platform.js`        -> `platform`
    // `platform-hook.js`   -> `platform-hook`
    // `foo.d.ts`           -> `foo.d`        (intentional; .d.ts not a concern here)
    // `platform`           -> `platform`     (no-op on extensionless)
    // `.platform`          -> ``             (dotfile basename collapses; edge case)
    const stripExt = (segment: string): string => segment.replace(/\.[^.]+$/, "");

    for (const { abs, rel } of mcpSrcTsFiles()) {
      const source = stripTsComments(readFileSync(abs, "utf8"));
      const lines = source.split("\n");
      const offenders: Array<{
        readonly lineNumber: number;
        readonly specifier: string;
        readonly reason: string;
      }> = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const match of line.matchAll(IMPORT_SPECIFIER_RE)) {
          const specifier = match[1] ?? "";

          // Axis 1: workspace-package specifier (exact OR subpath).
          for (const pkg of FORBIDDEN_WORKSPACE_PACKAGES) {
            if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
              offenders.push({
                lineNumber: i + 1,
                specifier,
                reason: `forbidden workspace package "${pkg}" (M G1a boundary; adapter/installer engines are M G1b scope)`,
              });
            }
          }

          // Axis 2: relative import with a forbidden whole-segment
          // token (extension-normalized). Only relative specifiers
          // (`./...` or `../...`) are checked; bare-package
          // specifiers like "adapters-extra" or "@scope/adapters"
          // do not trigger.
          if (specifier.startsWith("./") || specifier.startsWith("../")) {
            const segments = specifier.split("/").map(stripExt);
            for (const token of FORBIDDEN_LOCAL_PATH_TOKENS) {
              if (segments.includes(token)) {
                offenders.push({
                  lineNumber: i + 1,
                  specifier,
                  reason: `forbidden local-path segment "${token}" after extension-stripping (M G1a boundary defense-in-depth; no adapter/installer/platform subdirs or files in packages/mcp/src/**)`,
                });
              }
            }
          }
        }
      }

      expect(
        offenders,
        `${rel} must not import M G1b adapter/installer/platform-integration code in any form (D99.M.5 -- workspace specifiers ${JSON.stringify(FORBIDDEN_WORKSPACE_PACKAGES)} OR relative-path segment tokens ${JSON.stringify(FORBIDDEN_LOCAL_PATH_TOKENS)} after stripping the trailing extension). Offenders: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  // ===========================================================================
  // D99.M.6 -- @viberevert/core import carve-out (allowed core surface, exact equality)
  // ===========================================================================

  it("D99.M.6 (allowed core surface): packages/mcp/src/** core imports EQUAL exactly the allowed set; no default/namespace/side-effect/dynamic/require/import-equals/deep imports", () => {
    // The MCP src tree may import EXACTLY the names listed in
    // ALLOWED below from @viberevert/core. Current breakdown by
    // consumer:
    //   - 5 error classes (in envelope.ts) keyed into
    //     MCP_ERROR_CODE_MAP by constructor identity per D99.I.
    //   - viberevertDir (in audit.ts) for the audit log path
    //     resolution per D99.M.6 carve-out.
    //   - loadConfig + mergeChecksConfig (in tools/get-policy.ts)
    //     added in M G1a Step 3.5 for the get_policy tool.
    //
    // Step 4 will add `resolveRepoRoot` (in server.ts). That name is
    // INTENTIONALLY NOT in ALLOWED yet -- each new name must be
    // added in the SAME commit that introduces its real source
    // usage. Pre-authorization is a contract leak.
    //
    // Enforcement is EQUALITY (not subset). Two-direction loops give
    // per-name failure messages: one direction catches new
    // unauthorized imports; the other catches stale or pre-authorized
    // entries.
    const ALLOWED: ReadonlySet<string> = new Set([
      "ConfigNotFoundError",
      "ConfigParseError",
      "ConfigValidationError",
      "RepoRootNotFoundError",
      "SessionAlreadyActiveError",
      "loadConfig",
      "mergeChecksConfig",
      "resolveRepoRoot",
      "viberevertDir",
    ]);

    const SHAPE_FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      {
        name: 'default import from "@viberevert/core"',
        pattern: /(?:^|\n)\s*import\s+\w+\s+from\s+["']@viberevert\/core["']/,
      },
      {
        name: 'namespace import from "@viberevert/core"',
        pattern: /(?:^|\n)\s*import\s+\*\s+as\s+\w+\s+from\s+["']@viberevert\/core["']/,
      },
      {
        name: 'side-effect import of "@viberevert/core"',
        pattern: /(?:^|\n)\s*import\s+["']@viberevert\/core["']/,
      },
      {
        name: 'dynamic import of "@viberevert/core"',
        pattern: /\bimport\s*\(\s*["']@viberevert\/core["']/,
      },
      {
        name: 'require of "@viberevert/core"',
        pattern: /\brequire\s*\(\s*["']@viberevert\/core["']/,
      },
      {
        name: 'import-equals of "@viberevert/core"',
        pattern: /\bimport\s+\w+\s*=\s*require\s*\(\s*["']@viberevert\/core["']\s*\)/,
      },
      {
        name: 'deep import from "@viberevert/core/..."',
        pattern: /from\s+["']@viberevert\/core\/[^"']+["']/,
      },
    ];

    const aggregate = new Set<string>();
    const namedImportPattern =
      /(?:^|\n)\s*import\s*(?:type\s+)?\{([^}]*?)\}\s*from\s*["']@viberevert\/core["']/g;

    for (const { abs, rel } of mcpSrcTsFiles()) {
      const stripped = stripTsComments(readFileSync(abs, "utf8"));

      for (const { name, pattern } of SHAPE_FORBIDDEN) {
        const offenders = findOffenders(stripped, pattern);
        expect(
          offenders,
          `${rel} must NOT use ${name} (D99.M.6 -- named-barrel-only). Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }

      for (const match of stripped.matchAll(namedImportPattern)) {
        const body = match[1] ?? "";
        for (const raw of body.split(",")) {
          let symbol = raw.trim();
          if (!symbol) continue;
          symbol = symbol.replace(/^type\s+/, "");
          const asMatch = symbol.match(/^(\w+)\s+as\s+(\w+)$/);
          // For `X as Y`, the source-side name X is the public
          // name the carve-out keys on.
          const src = asMatch?.[1] ?? symbol;
          if (/^\w+$/.test(src)) aggregate.add(src);
        }
      }
    }

    // Equality, both directions, with named per-element messages.
    for (const name of aggregate) {
      expect(
        ALLOWED.has(name),
        `@viberevert/core import "${name}" found in packages/mcp/src/** is NOT in the D99.M.6 allowed core surface ${JSON.stringify([...ALLOWED].sort())}. If this is a legitimate new import, add the name to ALLOWED in the SAME commit.`,
      ).toBe(true);
    }
    for (const name of ALLOWED) {
      expect(
        aggregate.has(name),
        `D99.M.6 allowed name "${name}" is NOT actually imported anywhere in packages/mcp/src/** (pre-authorization gap). Remove from ALLOWED or add the real import.`,
      ).toBe(true);
    }
  });

  // ===========================================================================
  // D99.M.7 -- Audit fs surface lock
  // ===========================================================================

  it("D99.M.7: packages/mcp/src/audit.ts fs surface -- exactly mkdir x 1, open x 1, fh.appendFile x 1, fh.close x 1; node:fs/promises imports EXACTLY {FileHandle, mkdir, open} with no aliasing; no alternate fs import shapes", () => {
    // The audit writer's fs surface is exhaustively documented in
    // the plan (D99.M.7) and forms the basis of the failure-policy
    // matrix (D99.J). Drift here -- a second mkdir, a stat call, an
    // unlink, a namespace fs import -- would silently expand the
    // attack surface AND likely break failure-policy assumptions.
    //
    // Three-layer lock:
    //   (a) Exact call-site counts (mkdir / open / appendFile / close).
    //   (b) The fs/promises import line shape MUST be exactly
    //       {FileHandle, mkdir, open}, no aliasing.
    //   (c) Forbidden alternate fs import shapes -- closes the
    //       "one correct import plus one hidden fs namespace
    //       import" loophole. Covers namespace, default,
    //       side-effect, dynamic, require, import-equals, the
    //       bare `fs/promises` (non-node-prefixed) form, AND the
    //       non-promise `fs` callback API. All must be empty.
    //
    // Source is pre-stripped for all checks.
    const raw = readSource(MCP_AUDIT_REL);
    const stripped = stripTsComments(raw);

    // ----- (a) Call-site counts ----------------------------------------------
    // Boundary patterns count call sites only:
    //   - `\bmkdir\(`         -- function call
    //   - `\bopen\(`          -- function call
    //   - `\.appendFile\(`    -- method call (must follow `.`)
    //   - `\.close\(`         -- method call (must follow `.`)
    // The leading dot on appendFile/close excludes the interface
    // method declaration `close(): Promise<void>` AND string
    // literals like `"audit: record() after close()"`, neither of
    // which has a `.` prefix.
    const counts = {
      mkdir: (stripped.match(/\bmkdir\(/g) ?? []).length,
      open: (stripped.match(/\bopen\(/g) ?? []).length,
      appendFile: (stripped.match(/\.appendFile\(/g) ?? []).length,
      close: (stripped.match(/\.close\(/g) ?? []).length,
    };
    expect(
      counts,
      `${MCP_AUDIT_REL} fs surface counts must be {mkdir:1, open:1, appendFile:1, close:1}. Got: ${JSON.stringify(counts)}`,
    ).toEqual({ mkdir: 1, open: 1, appendFile: 1, close: 1 });

    // ----- (b) Allowed import line shape ------------------------------------
    const fsImports = [
      ...stripped.matchAll(/import\s*\{([^}]*?)\}\s*from\s*["']node:fs\/promises["']/g),
    ];
    expect(
      fsImports.length,
      `${MCP_AUDIT_REL} must import from node:fs/promises exactly once. Found ${fsImports.length}.`,
    ).toBe(1);

    const body = fsImports[0]?.[1] ?? "";
    const names = body
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, ""))
      .filter((s) => s.length > 0);

    for (const name of names) {
      expect(
        /\s+as\s+/.test(name),
        `${MCP_AUDIT_REL} fs/promises named import "${name}" uses aliasing (D99.M.7 forbids aliasing in this surface).`,
      ).toBe(false);
    }
    expect(
      new Set(names),
      `${MCP_AUDIT_REL} fs/promises imports must be exactly {FileHandle, mkdir, open}. Got: ${JSON.stringify(names)}`,
    ).toEqual(new Set(["FileHandle", "mkdir", "open"]));

    // ----- (c) Forbidden alternate fs import shapes -------------------------
    const FORBIDDEN_FS_IMPORT_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      {
        name: 'bare "fs/promises" import (non-node-prefixed)',
        pattern: /from\s+["']fs\/promises["']/,
      },
      {
        name: "namespace import from fs/promises",
        pattern: /import\s+\*\s+as\s+\w+\s+from\s+["'](?:node:)?fs\/promises["']/,
      },
      {
        name: "default import from fs/promises",
        pattern: /(?:^|\n)\s*import\s+\w+\s+from\s+["'](?:node:)?fs\/promises["']/,
      },
      {
        name: "side-effect import of fs/promises",
        pattern: /(?:^|\n)\s*import\s+["'](?:node:)?fs\/promises["']/,
      },
      {
        name: "dynamic import of fs/promises",
        pattern: /\bimport\s*\(\s*["'](?:node:)?fs\/promises["']/,
      },
      {
        name: "require of fs/promises",
        pattern: /\brequire\s*\(\s*["'](?:node:)?fs\/promises["']/,
      },
      {
        name: "import-equals require of fs/promises",
        pattern: /\bimport\s+\w+\s*=\s*require\s*\(\s*["'](?:node:)?fs\/promises["']/,
      },
      {
        name: "any import of non-promise fs (callback API forbidden entirely)",
        pattern:
          /(?:from\s+["'](?:node:)?fs["']|import\s*\(\s*["'](?:node:)?fs["']|require\s*\(\s*["'](?:node:)?fs["']|import\s+\w+\s*=\s*require\s*\(\s*["'](?:node:)?fs["']|(?:^|\n)\s*import\s+["'](?:node:)?fs["'])/,
      },
    ];
    for (const { name, pattern } of FORBIDDEN_FS_IMPORT_SHAPES) {
      const offenders = findOffenders(stripped, pattern);
      expect(
        offenders,
        `${MCP_AUDIT_REL} must NOT use ${name} (D99.M.7 -- alternate fs surface). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  // ===========================================================================
  // D99.M.8 -- Single SDK Server + StdioServerTransport construction sites;
  //           high-level McpServer rejected at constructor, identifier, AND
  //           import-path layers; SDK imports scoped to server.ts only
  // ===========================================================================

  it("D99.M.8: packages/mcp/src/** -- single SDK Server + StdioServerTransport construction sites in server.ts only; zero McpServer (constructor, identifier, high-level import path); SDK imports scoped to server.ts", () => {
    // D99.D rationale: McpServer's built-in tools/call handler
    // rejects unknown names BEFORE our dispatcher runs, which
    // breaks audit-on-denial. We must own the dispatcher end-to-
    // end. This invariant locks the SDK surface at five layers:
    //
    //   1. Constructor sites: exactly 1 `new Server(` AND 1
    //      `new StdioServerTransport(`, BOTH in server.ts. Count
    //      alone is insufficient -- pinning the file prevents
    //      drift to a sibling source file.
    //   2. Zero `new McpServer(` (high-level class never
    //      instantiated).
    //   3. Zero bare `McpServer` identifier across mcp/src --
    //      catches future imports, type-only references,
    //      aliases, or static-access patterns BEFORE they
    //      become `new McpServer(`.
    //   4. Zero `@modelcontextprotocol/sdk/server/mcp.js` import
    //      path -- the high-level module is never reached even
    //      indirectly.
    //   5. SDK imports (`@modelcontextprotocol/sdk` root AND
    //      `@modelcontextprotocol/sdk/...` subpaths) are scoped
    //      to packages/mcp/src/server.ts ONLY. Tool files remain
    //      SDK-free (D99.G + slice 3.x contract). This replaces
    //      the deleted Step-2 transient pre-import guard with a
    //      permanent positive narrow allowlist.
    //
    // Constructor patterns tolerate optional generic-parameter
    // syntax (`<...>`) so the invariant does not become brittle
    // if future SDK type definitions require type parameters at
    // the constructor call site.
    const SERVER_PATTERN = /\bnew\s+Server(?:\s*<[^>]+>)?\s*\(/g;
    const STDIO_PATTERN = /\bnew\s+StdioServerTransport(?:\s*<[^>]+>)?\s*\(/g;
    const MCP_SERVER_PATTERN = /\bnew\s+McpServer(?:\s*<[^>]+>)?\s*\(/g;
    const MCP_SERVER_IDENTIFIER_PATTERN = /\bMcpServer\b/g;
    const HIGH_LEVEL_MCP_SERVER_IMPORT_PATTERN = /@modelcontextprotocol\/sdk\/server\/mcp\.js/g;
    // Matches both bare root package (`"@modelcontextprotocol/sdk"`)
    // AND subpath imports (`"@modelcontextprotocol/sdk/..."`). The
    // `(?:\/|["'])` lookahead alternation ensures we don't match
    // similarly-prefixed unrelated packages like
    // `@modelcontextprotocol/sdkjs` (next char would be `j`,
    // neither `/` nor quote).
    const SDK_IMPORT_PATTERN = /@modelcontextprotocol\/sdk(?:\/|["'])/g;

    let mcpServerCount = 0;
    let mcpServerIdentifierCount = 0;
    let highLevelImportCount = 0;
    const serverHits: string[] = [];
    const stdioHits: string[] = [];
    const mcpServerHits: string[] = [];
    const mcpServerIdentifierHits: string[] = [];
    const highLevelImportHits: string[] = [];
    const sdkImportFiles = new Set<string>();

    for (const { abs, rel } of mcpSrcTsFiles()) {
      const source = stripTsComments(readFileSync(abs, "utf8"));

      const sm = source.match(SERVER_PATTERN);
      if (sm !== null) {
        serverHits.push(`${rel} (${sm.length})`);
      }

      const tm = source.match(STDIO_PATTERN);
      if (tm !== null) {
        stdioHits.push(`${rel} (${tm.length})`);
      }

      const mm = source.match(MCP_SERVER_PATTERN);
      if (mm !== null) {
        mcpServerCount += mm.length;
        mcpServerHits.push(`${rel} (${mm.length})`);
      }

      const idMatches = source.match(MCP_SERVER_IDENTIFIER_PATTERN);
      if (idMatches !== null) {
        mcpServerIdentifierCount += idMatches.length;
        mcpServerIdentifierHits.push(`${rel} (${idMatches.length})`);
      }

      const hlMatches = source.match(HIGH_LEVEL_MCP_SERVER_IMPORT_PATTERN);
      if (hlMatches !== null) {
        highLevelImportCount += hlMatches.length;
        highLevelImportHits.push(`${rel} (${hlMatches.length})`);
      }

      const sdkMatches = source.match(SDK_IMPORT_PATTERN);
      if (sdkMatches !== null && sdkMatches.length > 0) {
        sdkImportFiles.add(rel);
      }
    }

    // 1. Constructor sites: exactly 1 of each, BOTH in server.ts.
    expect(
      serverHits,
      `D99.M.8 (1): expected exactly 1 \`new Server(\` site at packages/mcp/src/server.ts. Found: ${JSON.stringify(serverHits)}`,
    ).toEqual(["packages/mcp/src/server.ts (1)"]);
    expect(
      stdioHits,
      `D99.M.8 (1): expected exactly 1 \`new StdioServerTransport(\` site at packages/mcp/src/server.ts. Found: ${JSON.stringify(stdioHits)}`,
    ).toEqual(["packages/mcp/src/server.ts (1)"]);

    // 2. Zero `new McpServer(`.
    expect(
      mcpServerCount,
      `D99.M.8 (2): expected ZERO \`new McpServer(\` sites across packages/mcp/src/** (high-level class explicitly rejected per D99.D). Found ${mcpServerCount}: ${JSON.stringify(mcpServerHits)}`,
    ).toBe(0);

    // 3. Zero bare `McpServer` identifier.
    expect(
      mcpServerIdentifierCount,
      `D99.M.8 (3): expected ZERO bare McpServer identifiers across packages/mcp/src/** (high-level SDK class explicitly rejected per D99.D). Found ${mcpServerIdentifierCount}: ${JSON.stringify(mcpServerIdentifierHits)}`,
    ).toBe(0);

    // 4. Zero high-level SDK import path.
    expect(
      highLevelImportCount,
      `D99.M.8 (4): expected ZERO @modelcontextprotocol/sdk/server/mcp.js import paths across packages/mcp/src/** (high-level module explicitly rejected per D99.D). Found ${highLevelImportCount}: ${JSON.stringify(highLevelImportHits)}`,
    ).toBe(0);

    // 5. SDK source imports (root + subpaths) scoped to server.ts only.
    expect(
      [...sdkImportFiles].sort(),
      `D99.M.8 (5): SDK source imports (@modelcontextprotocol/sdk root and subpaths) must be scoped to packages/mcp/src/server.ts ONLY. Tool files remain SDK-free (D99.G). Found in: ${JSON.stringify([...sdkImportFiles].sort())}`,
    ).toEqual(["packages/mcp/src/server.ts"]);
  });

  // ===========================================================================
  // D99.M.10 -- No network modules
  // ===========================================================================

  it("D99.M.10: packages/mcp/src/** does NOT import node:http / node:https / node:net / node:dgram (5 import forms; with or without node: prefix)", () => {
    // MCP transport in v0.7.0-beta is stdio only (D99.D). Pulling
    // in any network module here would either signal an in-progress
    // HTTP/SSE transport (post-beta scope) or accidental transitive
    // coupling. Source pre-stripped; 5-form coverage incl.
    // side-effect imports.
    const FORBIDDEN = ["http", "https", "net", "dgram"];
    for (const { abs, rel } of mcpSrcTsFiles()) {
      const source = stripTsComments(readFileSync(abs, "utf8"));
      for (const mod of FORBIDDEN) {
        const pattern = new RegExp(
          `(?:from\\s+["'](?:node:)?${mod}["']` +
            `|import\\s*\\(\\s*["'](?:node:)?${mod}["']\\s*\\)` +
            `|require\\s*\\(\\s*["'](?:node:)?${mod}["']\\s*\\)` +
            `|import\\s+\\w+\\s*=\\s*require\\s*\\(\\s*["'](?:node:)?${mod}["']\\s*\\)` +
            `|import\\s+["'](?:node:)?${mod}["'])`,
        );
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${rel} must not import ${mod} / node:${mod} in any of 5 forms (D99.M.10). Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  // ===========================================================================
  // D99.M.11 -- packages/mcp/package.json dependency map (Step 3 surface)
  // ===========================================================================

  it("D99.M.11 (Step 3 surface, post-3.3): packages/mcp/package.json dependencies EXACTLY {@modelcontextprotocol/sdk: 1.29.0, zod: 4.4.3, @viberevert/cli-commands: workspace:*, @viberevert/core: workspace:*, @viberevert/session-format: workspace:*}; forbidden deps absent from all dep sections", () => {
    // Step 3 surface post-3.3: MCP SDK + zod + 3 workspace deps
    // (cli-commands + core + session-format -- the last added in
    // slice 3.3 because check_repo's handler uses ReportFileSchema
    // for stdout validation). Lock the dependencies map EXACTLY so
    // unauthorized additions (clipanion, viberevert binary, LLM
    // SDKs, sibling internal packages) cannot creep in.
    const pkg = JSON.parse(readSource(MCP_PACKAGE_JSON_REL));
    expect(
      pkg.dependencies,
      `${MCP_PACKAGE_JSON_REL} dependencies must EXACTLY match the Step 3 surface (no more, no less).`,
    ).toEqual({
      "@modelcontextprotocol/sdk": "1.29.0",
      "@viberevert/cli-commands": "workspace:*",
      "@viberevert/core": "workspace:*",
      "@viberevert/session-format": "workspace:*",
      zod: "4.4.3",
    });

    const FORBIDDEN: ReadonlyArray<string> = [
      "clipanion",
      "zod-to-json-schema",
      "viberevert",
      "@viberevert/adapters",
      "@viberevert/installers",
      "@viberevert/checks",
      "@viberevert/reporters",
      "@viberevert/git",
      ...KNOWN_LLM_SDKS,
    ];
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      const keys = Object.keys(pkg[section] ?? {});
      for (const banned of FORBIDDEN) {
        expect(
          keys.includes(banned),
          `${MCP_PACKAGE_JSON_REL} ${section} must NOT contain "${banned}" (D99.M.11 forbidden-deps list).`,
        ).toBe(false);
      }
    }
  });

  // ===========================================================================
  // D99.M.13 -- ASCII-only at byte level
  // ===========================================================================

  it("D99.M.13: packages/mcp/src/** is ASCII-only at the byte level (no byte > 0x7F)", () => {
    // The MCP server runs in user terminals and pipes through stdio
    // bytes. Non-ASCII source -- even comments -- risks (a) inducing
    // an editor-encoding regression that corrupts the file, (b)
    // surfacing in error messages we send back over the protocol,
    // (c) leaking through if a string literal accidentally
    // interpolates a non-ASCII byte. Byte-level (not codepoint-
    // level) so a stray UTF-8 sequence fails too. INTENTIONALLY
    // does NOT use stripTsComments -- bytes are bytes regardless
    // of where they land.
    for (const { abs, rel } of mcpSrcTsFiles()) {
      const bytes = readFileSync(abs);
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i] ?? 0;
        if (b > 0x7f) {
          throw new Error(
            `${rel}: non-ASCII byte 0x${b.toString(16).padStart(2, "0")} at offset ${i} (D99.M.13 ASCII-only).`,
          );
        }
      }
    }
  });

  // ===========================================================================
  // D99.M.14 -- No process.stdout.write / process.stderr.write / process.exit
  // ===========================================================================

  it("D99.M.14: packages/mcp/src/** does NOT call process.stdout.write / process.stderr.write / process.exit (library discipline; CLI command owns human stderr + exit codes)", () => {
    // @viberevert/mcp is a library. The MCP SDK owns stdio for
    // protocol traffic; the MCPCommand wrapper in packages/cli owns
    // human-facing stderr and the process exit code. The library
    // throws (boot failure) or returns (graceful shutdown), nothing
    // else. NO carve-outs.
    const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "process.exit(", pattern: /\bprocess\.exit\s*\(/ },
      { name: "process.stdout.write(", pattern: /\bprocess\.stdout\.write\s*\(/ },
      { name: "process.stderr.write(", pattern: /\bprocess\.stderr\.write\s*\(/ },
    ];
    for (const { abs, rel } of mcpSrcTsFiles()) {
      const stripped = stripTsComments(readFileSync(abs, "utf8"));
      for (const { name, pattern } of FORBIDDEN) {
        const offenders = findOffenders(stripped, pattern);
        expect(
          offenders,
          `${rel} must NOT call ${name} (D99.M.14 library discipline). Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });

  // ===========================================================================
  // D99.M.15 -- No-reverse-cycle (cli-commands MUST NOT depend on mcp)
  // ===========================================================================

  it("D99.M.15: packages/cli-commands/src/** does NOT import @viberevert/mcp (5 import forms) AND packages/cli-commands/package.json does NOT depend on @viberevert/mcp", () => {
    // Package graph: cli -> cli-commands AND cli -> mcp AND
    // mcp -> cli-commands. A cli-commands -> mcp edge would close
    // the cycle. Source grep + package.json check together cover
    // the static side; the runtime side is impossible because a
    // cycle would already break the build's `tsc` step.
    const pattern = buildSdkForbiddenPattern("@viberevert/mcp");

    const ccSrcAbs = join(REPO_ROOT, CLI_COMMANDS_SRC_DIR_M2);
    const ccFiles = findTsFiles(ccSrcAbs);
    expect(
      ccFiles.length,
      `Self-check: expected at least one .ts file under ${CLI_COMMANDS_SRC_DIR_M2}/.`,
    ).toBeGreaterThan(0);
    for (const abs of ccFiles) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      const source = stripTsComments(readFileSync(abs, "utf8"));
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `${rel} must NOT import @viberevert/mcp (D99.M.15 no-reverse-cycle). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }

    const ccPkg = JSON.parse(readSource(CLI_COMMANDS_PACKAGE_JSON_REL));
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      const keys = Object.keys(ccPkg[section] ?? {});
      expect(
        keys.includes("@viberevert/mcp"),
        `${CLI_COMMANDS_PACKAGE_JSON_REL} ${section} must NOT contain "@viberevert/mcp" (D99.M.15).`,
      ).toBe(false);
    }
  });

  // ===========================================================================
  // D99.M.16 -- No-forward-cycle (mcp MUST NOT depend on viberevert CLI)
  // ===========================================================================

  it("D99.M.16: packages/mcp/src/** does NOT import `viberevert` (CLI binary, 5 forms) OR deep-import packages/cli/src/* AND packages/mcp/package.json does NOT depend on `viberevert`", () => {
    // The CLI binary depends on mcp (Step 5 adds the dep). An
    // mcp -> cli edge would close the cycle through the binary
    // entry point. Both the binary specifier `viberevert` AND any
    // deep path into packages/cli/src/* must be blocked.
    const cliBinaryPattern = buildSdkForbiddenPattern("viberevert");
    const cliDeepPathPattern =
      /(?:from\s+["'][^"']*packages\/cli\/[^"']+["']|import\s*\(\s*["'][^"']*packages\/cli\/[^"']+["']\s*\)|require\s*\(\s*["'][^"']*packages\/cli\/[^"']+["']\s*\)|import\s+\w+\s*=\s*require\s*\(\s*["'][^"']*packages\/cli\/[^"']+["']\s*\)|(?:^|\n)\s*import\s+["'][^"']*packages\/cli\/[^"']+["'])/;

    for (const { abs, rel } of mcpSrcTsFiles()) {
      const source = stripTsComments(readFileSync(abs, "utf8"));
      const binaryOffenders = findOffenders(source, cliBinaryPattern);
      expect(
        binaryOffenders,
        `${rel} must NOT import "viberevert" (CLI binary) in any of 5 forms (D99.M.16). Matches: ${JSON.stringify(binaryOffenders)}`,
      ).toEqual([]);
      const deepOffenders = findOffenders(source, cliDeepPathPattern);
      expect(
        deepOffenders,
        `${rel} must NOT deep-import from packages/cli/* (D99.M.16). Matches: ${JSON.stringify(deepOffenders)}`,
      ).toEqual([]);
    }

    const mcpPkg = JSON.parse(readSource(MCP_PACKAGE_JSON_REL));
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      const keys = Object.keys(mcpPkg[section] ?? {});
      expect(
        keys.includes("viberevert"),
        `${MCP_PACKAGE_JSON_REL} ${section} must NOT contain "viberevert" (D99.M.16).`,
      ).toBe(false);
    }
  });

  // ===========================================================================
  // D99.M.18 -- No clipanion in mcp/src OR deps (scope: src + package.json only)
  // ===========================================================================

  it("D99.M.18: packages/mcp/src/** does NOT import clipanion (5 forms) AND packages/mcp/package.json deps/devDeps/peerDeps do NOT contain clipanion. SCOPE: vitest.config.ts's `inline: ['clipanion']` is the locked test-runner bundling exception (outside src/** and outside package.json sections) -- both walls hold.", () => {
    // Clipanion hosting is delegated to cli-commands via the
    // runCommandInProcess harness. Pulling clipanion into mcp/src
    // would either (a) duplicate the harness, (b) invite a
    // mcp-owned Command class, or (c) link command argument parsing
    // into the protocol surface.
    //
    // SCOPE: src/** + package.json sections ONLY. vitest.config.ts
    // uses `inline: ["clipanion"]` so Vitest pre-bundles
    // cli-commands' transitive clipanion import via esbuild -- that
    // is a TEST-RUNNER bundling instruction, NOT a runtime import.
    // vitest.config.ts lives OUTSIDE src/**; the deps-side check
    // walks package.json sections (not transitive resolution) so
    // the inline declaration is invisible to both halves of this
    // test.
    const pattern = buildSdkForbiddenPattern("clipanion");
    for (const { abs, rel } of mcpSrcTsFiles()) {
      const source = stripTsComments(readFileSync(abs, "utf8"));
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `${rel} must NOT import clipanion in any of 5 forms (D99.M.18). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }

    const mcpPkg = JSON.parse(readSource(MCP_PACKAGE_JSON_REL));
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      const keys = Object.keys(mcpPkg[section] ?? {});
      expect(
        keys.includes("clipanion"),
        `${MCP_PACKAGE_JSON_REL} ${section} must NOT contain "clipanion" (D99.M.18).`,
      ).toBe(false);
    }
  });

  // ===========================================================================
  // D99.M.19c -- Barrel-only consumer side (mcp does not deep-import
  //              cli-commands OR core)
  // ===========================================================================

  it("D99.M.19c: packages/mcp/src/** does NOT use deep imports from @viberevert/cli-commands, @viberevert/core, OR @viberevert/session-format (5 deep-import forms each: static, side-effect, dynamic, require, import-equals)", () => {
    // Step 1's D99.M.19a/b lock the PROVIDER side -- the
    // cli-commands barrel must export the right surface. This is
    // the CONSUMER side: mcp must use only the barrel, never deep
    // paths. Extends to @viberevert/core + @viberevert/session-format
    // for the same reason -- D99.M.6 also forbids core deep imports
    // as part of its named-barrel-only shape check; this is
    // belt-and-suspenders. session-format added in Slice 3.3
    // when check_repo's handler started importing ReportFileSchema.
    //
    // 5-form coverage per package: static, side-effect, dynamic,
    // require, import-equals. Side-effect deep imports are
    // particularly dangerous -- they trigger module-evaluation
    // side effects from a specific internal file path without
    // exposing any typed surface to the caller.
    const deepImportPatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      // @viberevert/cli-commands (5 forms)
      {
        name: 'deep static import from "@viberevert/cli-commands/..."',
        pattern: /from\s+["']@viberevert\/cli-commands\/[^"']+["']/,
      },
      {
        name: 'deep side-effect import of "@viberevert/cli-commands/..."',
        pattern: /(?:^|\n)\s*import\s+["']@viberevert\/cli-commands\/[^"']+["']/,
      },
      {
        name: 'deep dynamic import of "@viberevert/cli-commands/..."',
        pattern: /\bimport\s*\(\s*["']@viberevert\/cli-commands\/[^"']+["']/,
      },
      {
        name: 'deep require of "@viberevert/cli-commands/..."',
        pattern: /\brequire\s*\(\s*["']@viberevert\/cli-commands\/[^"']+["']/,
      },
      {
        name: 'deep import-equals require of "@viberevert/cli-commands/..."',
        pattern: /\bimport\s+\w+\s*=\s*require\s*\(\s*["']@viberevert\/cli-commands\/[^"']+["']/,
      },
      // @viberevert/core (5 forms)
      {
        name: 'deep static import from "@viberevert/core/..."',
        pattern: /from\s+["']@viberevert\/core\/[^"']+["']/,
      },
      {
        name: 'deep side-effect import of "@viberevert/core/..."',
        pattern: /(?:^|\n)\s*import\s+["']@viberevert\/core\/[^"']+["']/,
      },
      {
        name: 'deep dynamic import of "@viberevert/core/..."',
        pattern: /\bimport\s*\(\s*["']@viberevert\/core\/[^"']+["']/,
      },
      {
        name: 'deep require of "@viberevert/core/..."',
        pattern: /\brequire\s*\(\s*["']@viberevert\/core\/[^"']+["']/,
      },
      {
        name: 'deep import-equals require of "@viberevert/core/..."',
        pattern: /\bimport\s+\w+\s*=\s*require\s*\(\s*["']@viberevert\/core\/[^"']+["']/,
      },
      // @viberevert/session-format (5 forms, added Slice 3.3)
      {
        name: 'deep static import from "@viberevert/session-format/..."',
        pattern: /from\s+["']@viberevert\/session-format\/[^"']+["']/,
      },
      {
        name: 'deep side-effect import of "@viberevert/session-format/..."',
        pattern: /(?:^|\n)\s*import\s+["']@viberevert\/session-format\/[^"']+["']/,
      },
      {
        name: 'deep dynamic import of "@viberevert/session-format/..."',
        pattern: /\bimport\s*\(\s*["']@viberevert\/session-format\/[^"']+["']/,
      },
      {
        name: 'deep require of "@viberevert/session-format/..."',
        pattern: /\brequire\s*\(\s*["']@viberevert\/session-format\/[^"']+["']/,
      },
      {
        name: 'deep import-equals require of "@viberevert/session-format/..."',
        pattern: /\bimport\s+\w+\s*=\s*require\s*\(\s*["']@viberevert\/session-format\/[^"']+["']/,
      },
    ];

    for (const { abs, rel } of mcpSrcTsFiles()) {
      const source = stripTsComments(readFileSync(abs, "utf8"));
      for (const { name, pattern } of deepImportPatterns) {
        const offenders = findOffenders(source, pattern);
        expect(
          offenders,
          `${rel} must NOT use ${name} (D99.M.19c barrel-only consumer). Matches: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
      }
    }
  });
});

describe("Architectural invariants -- M G1a Step 3 D99.M @viberevert/mcp tool catalog", () => {
  const MCP_TOOLS_REL = "packages/mcp/src/tools.ts";

  /**
   * Source-of-truth duplicates of the D99.A + D99.B + D99.V locked
   * declarations. DUPLICATED here per the established M G1a pattern.
   * Any catalog/map change MUST update BOTH this file AND the source
   * in packages/mcp/src/tools.ts in the SAME commit.
   */
  const EXPECTED_TOOL_NAMES_IN_ORDER: ReadonlyArray<string> = [
    "check_repo",
    "explain_diff",
    "classify_risk",
    "list_risky_files",
    "get_policy",
    "start_session",
    "create_checkpoint",
    "generate_fix_prompt",
  ];

  const EXPECTED_RESERVED_TOOL_NAMES: ReadonlyArray<string> = [
    "rollback",
    "request_human_approval",
  ];

  const EXPECTED_TOOL_SIDE_EFFECT_CLASS_BY_NAME: Readonly<Record<string, string>> = {
    check_repo: "B",
    explain_diff: "A",
    classify_risk: "A",
    list_risky_files: "A",
    get_policy: "A",
    start_session: "B",
    create_checkpoint: "B",
    generate_fix_prompt: "B",
  };

  /**
   * Iteratively peel `as const` (AsExpression) and `satisfies T`
   * (SatisfiesExpression) wrappers off an initializer expression so
   * the underlying literal (array, object, etc.) can be inspected.
   *
   * Order is irrelevant: `(... as const) satisfies T`,
   * `(... satisfies T) as const`, and both nested are all unwrapped
   * to the bare literal. Other expression wrappers are left intact
   * (e.g., we don't peel ParenthesizedExpression because that would
   * change visibility semantics for some checks).
   */
  function unwrapLiteralExpression(expr: ts.Expression): ts.Expression {
    let current = expr;
    while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    }
    return current;
  }

  /**
   * Extract the string values of a top-level
   *   `export const NAME = [...] as const;`  (or with `satisfies T`)
   * array literal from a TypeScript source string.
   *
   * Statement-aware (AST-based), immune to false positives from
   * string literals / regexes / comments that happen to contain the
   * same identifier.
   *
   * Hardening rules (any failure returns undefined):
   *   1. Declaration MUST be `const`.
   *   2. Initializer MUST unwrap to an ArrayLiteralExpression.
   *   3. EVERY element MUST be a StringLiteral. A single non-string
   *      element causes the helper to return undefined rather than
   *      silently dropping the bad element.
   */
  function extractStringArrayLiteralExport(
    sourceText: string,
    exportName: string,
  ): string[] | undefined {
    const sf = ts.createSourceFile(
      "tools.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );
    let result: string[] | undefined;
    ts.forEachChild(sf, (node) => {
      if (!ts.isVariableStatement(node)) return;
      const hasExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (hasExport !== true) return;
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst) return;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName) continue;
        if (decl.initializer === undefined) continue;
        const unwrapped = unwrapLiteralExpression(decl.initializer);
        if (!ts.isArrayLiteralExpression(unwrapped)) continue;
        const values: string[] = [];
        let allStrings = true;
        for (const element of unwrapped.elements) {
          if (!ts.isStringLiteral(element)) {
            allStrings = false;
            break;
          }
          values.push(element.text);
        }
        result = allStrings ? values : undefined;
      }
    });
    return result;
  }

  /**
   * Extract the {key:string -> value:string} contents of a top-level
   *   `export const NAME = { ... } as const;`  (or with `satisfies T`)
   * object literal from a TypeScript source string.
   *
   * Statement-aware (AST-based).
   *
   * Hardening rules (any failure returns undefined):
   *   1. Declaration MUST be `const`.
   *   2. Initializer MUST unwrap to an ObjectLiteralExpression.
   *   3. EVERY property MUST be a plain PropertyAssignment. Rejects
   *      spread, shorthand, method, getter/setter, and any other
   *      non-PropertyAssignment shape.
   *   4. EVERY property name MUST be a plain Identifier or
   *      StringLiteral. Rejects computed keys and numeric literal
   *      keys.
   *   5. EVERY property value MUST be a StringLiteral.
   *   6. NO duplicate keys. A duplicate key (which TypeScript
   *      typically catches but the invariant should be
   *      independently strong against) causes the helper to return
   *      undefined.
   *
   * Returns the extracted record on full success, undefined otherwise.
   */
  function extractStringObjectLiteralExport(
    sourceText: string,
    exportName: string,
  ): Record<string, string> | undefined {
    const sf = ts.createSourceFile(
      "tools.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );
    let result: Record<string, string> | undefined;
    ts.forEachChild(sf, (node) => {
      if (!ts.isVariableStatement(node)) return;
      const hasExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (hasExport !== true) return;
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst) return;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName) continue;
        if (decl.initializer === undefined) continue;
        const unwrapped = unwrapLiteralExpression(decl.initializer);
        if (!ts.isObjectLiteralExpression(unwrapped)) continue;
        const entries: Array<[string, string]> = [];
        const seen = new Set<string>();
        let allValid = true;
        for (const prop of unwrapped.properties) {
          if (!ts.isPropertyAssignment(prop)) {
            allValid = false;
            break;
          }
          let key: string;
          if (ts.isIdentifier(prop.name)) {
            key = prop.name.text;
          } else if (ts.isStringLiteral(prop.name)) {
            key = prop.name.text;
          } else {
            allValid = false;
            break;
          }
          if (seen.has(key)) {
            allValid = false;
            break;
          }
          seen.add(key);
          if (!ts.isStringLiteral(prop.initializer)) {
            allValid = false;
            break;
          }
          entries.push([key, prop.initializer.text]);
        }
        result = allValid ? Object.fromEntries(entries) : undefined;
      }
    });
    return result;
  }

  // ===========================================================================
  // D99.M.3 -- TOOL_NAMES_IN_ORDER and RESERVED_TOOL_NAMES are disjoint
  // ===========================================================================

  it("D99.M.3: TOOL_NAMES_IN_ORDER and RESERVED_TOOL_NAMES are disjoint (empty intersection)", () => {
    // A reserved name leaking into the exposed catalog would break
    // D99.B (reserved approval-gated, not exposed). Failure here =
    // a reserved name was accidentally added to TOOL_NAMES_IN_ORDER,
    // OR an exposed name was added to RESERVED_TOOL_NAMES.
    const source = readSource(MCP_TOOLS_REL);
    const exposed = extractStringArrayLiteralExport(source, "TOOL_NAMES_IN_ORDER");
    const reserved = extractStringArrayLiteralExport(source, "RESERVED_TOOL_NAMES");
    expect(
      exposed,
      `${MCP_TOOLS_REL} must export TOOL_NAMES_IN_ORDER as a const string-array literal.`,
    ).not.toBeUndefined();
    expect(
      reserved,
      `${MCP_TOOLS_REL} must export RESERVED_TOOL_NAMES as a const string-array literal.`,
    ).not.toBeUndefined();
    if (exposed === undefined || reserved === undefined) return;
    const exposedSet = new Set<string>(exposed);
    const overlap = reserved.filter((r) => exposedSet.has(r));
    expect(overlap, `D99.M.3 disjointness violated. Overlap: ${JSON.stringify(overlap)}`).toEqual(
      [],
    );
  });

  // ===========================================================================
  // D99.M.4 -- TOOL_NAMES_IN_ORDER exactly equals D99.A 8-tuple (order-sensitive)
  // ===========================================================================

  it("D99.M.4: TOOL_NAMES_IN_ORDER exactly equals the locked D99.A 8-element tuple (order-sensitive) AND RESERVED_TOOL_NAMES exactly equals the locked D99.B 2-tuple", () => {
    // EXPECTED_* duplicate the locked tuples from the plan. If you
    // intentionally change the catalog, change BOTH this file AND
    // the source in packages/mcp/src/tools.ts in the SAME commit.
    // The order-sensitive comparison enforces the locked tools/list
    // emission order (Phase 12f smoke test depends on this).
    const source = readSource(MCP_TOOLS_REL);
    const exposed = extractStringArrayLiteralExport(source, "TOOL_NAMES_IN_ORDER");
    const reserved = extractStringArrayLiteralExport(source, "RESERVED_TOOL_NAMES");
    expect(
      exposed,
      `${MCP_TOOLS_REL} TOOL_NAMES_IN_ORDER must exactly equal the locked D99.A 8-element tuple, in order.`,
    ).toEqual(EXPECTED_TOOL_NAMES_IN_ORDER);
    expect(
      reserved,
      `${MCP_TOOLS_REL} RESERVED_TOOL_NAMES must exactly equal the locked D99.B 2-element tuple.`,
    ).toEqual(EXPECTED_RESERVED_TOOL_NAMES);
  });

  // ===========================================================================
  // D99.V / Step 3 -- TOOL_SIDE_EFFECT_CLASS_BY_NAME exact map check
  // ===========================================================================

  it("D99.V / Step 3: TOOL_SIDE_EFFECT_CLASS_BY_NAME exactly equals the locked side-effect map (catches semantic drift TS cannot)", () => {
    // TypeScript's `satisfies Record<ToolName, ToolSideEffectClass>`
    // catches missing keys and invalid value types, but does NOT
    // catch semantic drift -- e.g., flipping `start_session` from
    // "B" to "A" still satisfies the type but violates D99.V's
    // safety contract (race-free side-effect classification). This
    // AST-asserted exact-equality check closes that gap.
    //
    // If a real Step 0.6 verification proves a tool can move
    // classes, update BOTH the source map AND this expected map in
    // the same commit, and tighten the dispatcher behavior tests in
    // the same slice.
    const source = readSource(MCP_TOOLS_REL);
    const map = extractStringObjectLiteralExport(source, "TOOL_SIDE_EFFECT_CLASS_BY_NAME");
    expect(
      map,
      `${MCP_TOOLS_REL} must export TOOL_SIDE_EFFECT_CLASS_BY_NAME as a plain {key:string}-valued const object literal with unique keys.`,
    ).not.toBeUndefined();
    if (map === undefined) return;
    expect(
      map,
      `${MCP_TOOLS_REL} TOOL_SIDE_EFFECT_CLASS_BY_NAME must exactly equal the locked D99.V map.`,
    ).toEqual(EXPECTED_TOOL_SIDE_EFFECT_CLASS_BY_NAME);
  });
});

describe("Architectural invariants -- M G1a Step 3.3 D99.M @viberevert/mcp per-tool + registry", () => {
  const MCP_TOOLS_DIR = "packages/mcp/src/tools";
  const MCP_TOOL_REGISTRY_REL = "packages/mcp/src/tool-registry.ts";
  const MCP_TOOLS_CATALOG_REL = "packages/mcp/src/tools.ts";

  const FORBIDDEN_CWD_LIKE_NAMES: ReadonlyArray<string> = [
    "cwd",
    "target_repo",
    "repo",
    "directory",
    "repo_path",
    "working_directory",
  ];

  /**
   * Normalize a field name for D99.M.17 forbidden-name comparison:
   * lowercase + strip underscores, hyphens, and whitespace. This
   * catches variants like repoPath / repo_path / repo-path / "repo
   * path" all as the same logical name.
   */
  function normalizeFieldName(name: string): string {
    return name.toLowerCase().replace(/[_\-\s]/g, "");
  }

  const FORBIDDEN_NORMALIZED: ReadonlySet<string> = new Set(
    FORBIDDEN_CWD_LIKE_NAMES.map(normalizeFieldName),
  );

  /**
   * List the .ts files directly under packages/mcp/src/tools/ (no
   * recursion). Each is expected to be a single-tool implementation
   * file per D99.G.
   */
  function listToolFiles(): ReadonlyArray<{ abs: string; rel: string }> {
    const dirAbs = join(REPO_ROOT, MCP_TOOLS_DIR);
    if (!statSync(dirAbs).isDirectory()) return [];
    const out: { abs: string; rel: string }[] = [];
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const abs = join(dirAbs, entry.name);
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      out.push({ abs, rel });
    }
    out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return out;
  }

  /**
   * Collect the set of top-level VALUE-exported identifiers from a
   * TS source file via AST walking. Covers `export const X = ...`,
   * `export function X(...)`, `export class X {...}`, and the
   * brace-form `export { X, Y as Z }`. Skips `export type` /
   * `export interface` at both whole-node and per-spec levels --
   * D99.M.9 governs VALUE exports (definition + handler), not
   * type aliases.
   */
  function collectValueExports(sourceText: string): Set<string> {
    const sf = ts.createSourceFile(
      "tool.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );
    const exported = new Set<string>();
    ts.forEachChild(sf, (node) => {
      if (ts.isVariableStatement(node)) {
        const hasExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (hasExport !== true) return;
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) exported.add(decl.name.text);
        }
      } else if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.add(node.name.text);
      } else if (
        ts.isClassDeclaration(node) &&
        node.name !== undefined &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.add(node.name.text);
      } else if (ts.isExportDeclaration(node) && node.exportClause !== undefined) {
        // Skip `export type { X, Y }` -- whole-node type export.
        if (node.isTypeOnly === true) return;
        if (ts.isNamedExports(node.exportClause)) {
          for (const spec of node.exportClause.elements) {
            // Skip `export { type X, Y }` -- per-spec type marker.
            if (spec.isTypeOnly === true) continue;
            exported.add(spec.name.text);
          }
        }
      }
    });
    return exported;
  }

  /**
   * Walk `z.object({ ... })` call expressions in a TS source and
   * return a scan result. Statement-aware (AST), immune to false
   * positives from string literals / comments / regex literals
   * that happen to contain z.object.
   *
   * Returns:
   *   objectCount    -- how many z.object call expressions were found
   *   keys           -- union of property-name keys across all calls
   *                     (only from plain identifier / string-literal
   *                     names)
   *   invalidShapes  -- list of disallowed sub-shapes found:
   *                       non-literal argument (e.g. z.object(shape))
   *                       spread element (e.g. z.object({...shared}))
   *                       computed key (e.g. z.object({[k]: ...}))
   *                       method/getter/setter (rare in Zod usage)
   *
   * D99.M.17 fails the file if invalidShapes is non-empty -- a tool
   * file that uses any of these shapes is structurally outside the
   * scanner's guarantee and must either inline an object literal
   * or document an exception.
   */
  function scanZodObjectSchemas(sourceText: string): {
    objectCount: number;
    keys: string[];
    invalidShapes: string[];
  } {
    const sf = ts.createSourceFile(
      "tool.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );
    const result = { objectCount: 0, keys: [] as string[], invalidShapes: [] as string[] };
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "z" &&
        node.expression.name.text === "object"
      ) {
        result.objectCount += 1;
        if (node.arguments.length < 1) {
          result.invalidShapes.push("z.object() with no arguments");
        } else {
          const arg = node.arguments[0];
          if (arg === undefined) {
            result.invalidShapes.push("z.object() with undefined argument");
          } else if (!ts.isObjectLiteralExpression(arg)) {
            result.invalidShapes.push(
              "z.object(<non-literal>) -- argument is not an inline object literal",
            );
          } else {
            for (const prop of arg.properties) {
              if (ts.isSpreadAssignment(prop)) {
                result.invalidShapes.push("z.object({...spread}) -- spread element disallowed");
                continue;
              }
              if (!ts.isPropertyAssignment(prop)) {
                result.invalidShapes.push(
                  `z.object property is not a plain PropertyAssignment (kind=${ts.SyntaxKind[prop.kind]})`,
                );
                continue;
              }
              if (ts.isComputedPropertyName(prop.name)) {
                result.invalidShapes.push("z.object({[computed]: ...}) -- computed key disallowed");
                continue;
              }
              if (ts.isIdentifier(prop.name)) {
                result.keys.push(prop.name.text);
              } else if (ts.isStringLiteral(prop.name)) {
                result.keys.push(prop.name.text);
              } else {
                result.invalidShapes.push(
                  `z.object key is unusual (kind=${ts.SyntaxKind[prop.name.kind]})`,
                );
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return result;
  }

  // ===========================================================================
  // D99.M.9 -- per-tool files export exactly definition + handler
  // ===========================================================================

  it("D99.M.9: every packages/mcp/src/tools/*.ts exports EXACTLY {definition, handler} (no more, no less; types are not counted)", () => {
    // Each per-tool file is the public seam between the tool's
    // implementation and the tool-registry / dispatcher. Keeping
    // the value export surface to exactly these two names makes
    // dispatcher wiring trivial AND prevents per-tool files from
    // accidentally exposing internal helpers (input schemas,
    // private mappers) that the registry should not consume.
    //
    // Type exports (export type X = ...) are not counted -- a tool
    // file MAY export types like its data shape (e.g. CheckRepoData)
    // for use by the per-tool test file.
    const REQUIRED_EXPORTS = new Set(["definition", "handler"]);
    const files = listToolFiles();
    expect(
      files.length,
      `Self-check: expected at least one .ts file under ${MCP_TOOLS_DIR}/ once Slice 3.3 lands.`,
    ).toBeGreaterThan(0);

    for (const { abs, rel } of files) {
      const source = readFileSync(abs, "utf8");
      const valueExports = collectValueExports(source);
      expect(
        [...valueExports].sort(),
        `${rel} value exports must EXACTLY equal [definition, handler] (D99.M.9). Got: ${JSON.stringify([...valueExports].sort())}`,
      ).toEqual([...REQUIRED_EXPORTS].sort());
    }
  });

  // ===========================================================================
  // D99.M.17 -- no cwd-like fields in any tool's z.object input schema
  // ===========================================================================

  it("D99.M.17: every tool file has at least one inline z.object schema AND no z.object key normalizes to a forbidden cwd-like name; reject non-literal arguments, spreads, and computed keys", () => {
    // The dispatcher (Step 4) passes repoRoot via ToolHandlerContext
    // per D99.P. Tools MUST NOT accept a cwd-like field from the
    // client -- that would be a confused-deputy vector (a client
    // could re-target the tool at an arbitrary path).
    //
    // The scan walks every z.object({...}) call in the tool source
    // and reports both the collected keys AND any disallowed
    // sub-shape (non-literal argument, spread, computed key).
    // Disallowed shapes fail the file because they are
    // structurally outside the scanner's guarantee -- a tool file
    // using them either inlines an object literal or documents an
    // exception.
    const files = listToolFiles();
    expect(
      files.length,
      `Self-check: expected at least one .ts file under ${MCP_TOOLS_DIR}/.`,
    ).toBeGreaterThan(0);
    for (const { abs, rel } of files) {
      const source = readFileSync(abs, "utf8");
      const scan = scanZodObjectSchemas(source);
      expect(
        scan.objectCount,
        `${rel} must contain at least one z.object({...}) call (D99.M.17 scan target).`,
      ).toBeGreaterThan(0);
      expect(
        scan.invalidShapes,
        `${rel} contains z.object call with disallowed shape (spread, computed key, non-literal argument): ${JSON.stringify(scan.invalidShapes)}`,
      ).toEqual([]);
      for (const key of scan.keys) {
        const normalized = normalizeFieldName(key);
        expect(
          FORBIDDEN_NORMALIZED.has(normalized),
          `${rel} z.object schema contains forbidden cwd-like key "${key}" (normalized: "${normalized}"). D99.M.17 -- use ToolHandlerContext.repoRoot instead.`,
        ).toBe(false);
      }
    }
  });

  // ===========================================================================
  // Registry subset / order invariant (Slice 3.3 -> 3.7 progressive)
  // ===========================================================================

  it("tool-registry: TOOL_REGISTRATIONS_IN_ORDER names are unique AND exactly equal TOOL_NAMES_IN_ORDER (complete catalog registered in catalog order); rejects spreads, non-identifier elements, and unknown identifiers", () => {
    // Slice 3.7 completes the current catalog: all catalog tools are now registered,
    // so this invariant tightens from "registry is a prefix-or-
    // subsequence of TOOL_NAMES_IN_ORDER" to "registry EXACTLY equals
    // TOOL_NAMES_IN_ORDER". A missing tool, an extra tool, or a tool
    // in the wrong slot is a hard failure here -- the dispatcher
    // (Step 4) builds its lookup Map from this array and would
    // silently miss a tool that isn't registered.
    //
    // The extraction resolves through a local var->tool map so a
    // reordering bug like
    //   const a = defineToolRegistration({ name: "check_repo", ... });
    //   const b = defineToolRegistration({ name: "get_policy", ... });
    //   export const TOOL_REGISTRATIONS_IN_ORDER = [b, a] as const;
    // is caught (registered names land in the order of the
    // exported array, not the order of the defineToolRegistration
    // call sites).
    const registrySource = readSource(MCP_TOOL_REGISTRY_REL);
    const catalogSource = readSource(MCP_TOOLS_CATALOG_REL);

    // (a) Extract catalog (TOOL_NAMES_IN_ORDER) from tools.ts.
    const sfCatalog = ts.createSourceFile(
      "tools.ts",
      catalogSource,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );
    let catalog: string[] = [];
    ts.forEachChild(sfCatalog, (node) => {
      if (!ts.isVariableStatement(node)) return;
      if (!(node.declarationList.flags & ts.NodeFlags.Const)) return;
      if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== "TOOL_NAMES_IN_ORDER") continue;
        if (decl.initializer === undefined) continue;
        let init: ts.Expression = decl.initializer;
        if (ts.isAsExpression(init)) init = init.expression;
        if (!ts.isArrayLiteralExpression(init)) continue;
        catalog = init.elements.filter(ts.isStringLiteral).map((e) => e.text);
      }
    });
    expect(catalog.length, "self-check: failed to extract TOOL_NAMES_IN_ORDER").toBeGreaterThan(0);

    // (b) Build local var -> tool name map from tool-registry.ts.
    // Walks every `const X = defineToolRegistration({name: "tool", ...})`
    // statement (any depth, recursively) and records the local
    // binding name -> declared tool name.
    const sfReg = ts.createSourceFile(
      "tool-registry.ts",
      registrySource,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );
    const varToTool = new Map<string, string>();
    const collectVar = (node: ts.Node): void => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
          const init = decl.initializer;
          if (
            ts.isCallExpression(init) &&
            ts.isIdentifier(init.expression) &&
            init.expression.text === "defineToolRegistration" &&
            init.arguments.length >= 1
          ) {
            const arg = init.arguments[0];
            if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
              for (const prop of arg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === "name" &&
                  ts.isStringLiteral(prop.initializer)
                ) {
                  varToTool.set(decl.name.text, prop.initializer.text);
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, collectVar);
    };
    collectVar(sfReg);

    // (c) Extract the exported array, resolve identifiers through
    // varToTool, and accumulate extraction errors.
    const registered: string[] = [];
    const errors: string[] = [];
    ts.forEachChild(sfReg, (node) => {
      if (!ts.isVariableStatement(node)) return;
      if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
      if (!(node.declarationList.flags & ts.NodeFlags.Const)) return;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== "TOOL_REGISTRATIONS_IN_ORDER") {
          continue;
        }
        if (decl.initializer === undefined) {
          errors.push("TOOL_REGISTRATIONS_IN_ORDER has no initializer");
          continue;
        }
        let init: ts.Expression = decl.initializer;
        if (ts.isAsExpression(init)) init = init.expression;
        if (!ts.isArrayLiteralExpression(init)) {
          errors.push("TOOL_REGISTRATIONS_IN_ORDER initializer is not an array literal");
          continue;
        }
        for (const element of init.elements) {
          if (ts.isSpreadElement(element)) {
            errors.push("TOOL_REGISTRATIONS_IN_ORDER contains a spread element");
            continue;
          }
          if (!ts.isIdentifier(element)) {
            errors.push(
              `TOOL_REGISTRATIONS_IN_ORDER contains non-identifier element (kind=${ts.SyntaxKind[element.kind]})`,
            );
            continue;
          }
          const toolName = varToTool.get(element.text);
          if (toolName === undefined) {
            errors.push(
              `TOOL_REGISTRATIONS_IN_ORDER references unknown identifier "${element.text}" (no local defineToolRegistration binding)`,
            );
            continue;
          }
          registered.push(toolName);
        }
      }
    });
    expect(
      errors,
      `${MCP_TOOL_REGISTRY_REL} registry extraction errors: ${JSON.stringify(errors)}`,
    ).toEqual([]);
    expect(
      registered.length,
      `${MCP_TOOL_REGISTRY_REL} must contain at least one tool registration in TOOL_REGISTRATIONS_IN_ORDER.`,
    ).toBeGreaterThan(0);

    // (d) Uniqueness: no tool name appears twice in the registry.
    const seen = new Set<string>();
    for (const name of registered) {
      expect(
        seen.has(name),
        `${MCP_TOOL_REGISTRY_REL} registers tool "${name}" more than once.`,
      ).toBe(false);
      seen.add(name);
    }

    // (e) Subset: every registered name is in the catalog.
    for (const name of registered) {
      expect(
        catalog.includes(name),
        `${MCP_TOOL_REGISTRY_REL} registers unknown tool "${name}" (not in TOOL_NAMES_IN_ORDER).`,
      ).toBe(true);
    }

    // (f) Catalog order: registered tools are a subsequence of
    // TOOL_NAMES_IN_ORDER. Cursor-based search ensures monotonic
    // catalog position. Per-tool error messages make a reorder bug
    // self-localizing; the exhaustive equality in (g) below catches
    // missing tools.
    let cursor = 0;
    for (const name of registered) {
      const idx = catalog.indexOf(name, cursor);
      expect(
        idx,
        `${MCP_TOOL_REGISTRY_REL} registrations are out of catalog order. "${name}" appears before its catalog position (search started at index ${cursor}).`,
      ).toBeGreaterThanOrEqual(0);
      cursor = idx + 1;
    }

    // (g) Exhaustive equality (Slice 3.7): now that the catalog is
    // complete, the registry MUST cover EVERY tool. A missing tool
    // here means the dispatcher (Step 4) will silently fail to look
    // it up at tools/call time. Asserts length first for a clear
    // diagnostic, then full ordered equality for a precise diff.
    expect(
      registered.length,
      `${MCP_TOOL_REGISTRY_REL} must register all ${catalog.length} catalog tools in TOOL_REGISTRATIONS_IN_ORDER (Slice 3.7 catalog complete); found ${registered.length}.`,
    ).toBe(catalog.length);
    expect(
      registered,
      `${MCP_TOOL_REGISTRY_REL} TOOL_REGISTRATIONS_IN_ORDER must exactly equal TOOL_NAMES_IN_ORDER (order-sensitive).`,
    ).toEqual(catalog);
  });
});

describe("Architectural invariants -- M G1a Step 3.5 D57 policy resolver defaults ownership", () => {
  it("D57 ownership: DEFAULT_RISK_*/DEFAULT_CHECKS_*/DEFAULT_FRAMEWORKS_* live ONLY and EXACTLY in packages/core/src/policy-resolve.ts", () => {
    // Per D57 + the M G1a Step 3.5a promotion, mergeChecksConfig and
    // the four DEFAULT_* constants are the SOLE owner of "defaults
    // applied at the engine boundary, not in loadConfig". Other
    // package src files MUST NOT declare additional DEFAULT_RISK_*,
    // DEFAULT_CHECKS_*, or DEFAULT_FRAMEWORKS_* symbols -- duplicated
    // defaults would silently diverge from the resolver's contract.
    //
    // Enforcement is BIDIRECTIONAL (mirrors the D99.M.6 equality
    // pattern):
    //   1. NO other package-src file may declare a matching DEFAULT_*
    //      symbol (otherwise: offender failure).
    //   2. policy-resolve.ts must declare EXACTLY the expected
    //      DEFAULT_* set (otherwise: unauthorized-new-default failure
    //      or removed-default failure).
    //
    // The second direction catches a future stray default declared
    // INSIDE the allowed file (e.g., `export const DEFAULT_RISK_OVERRIDE
    // = "high";`) that would pass the offender check by virtue of
    // living in the right file. Adding a legitimate new DEFAULT_*
    // requires updating EXPECTED_ALLOWED_SYMBOLS in this test in the
    // SAME commit -- pre-authorization is a contract leak.
    //
    // AST-based to avoid false positives on:
    //   - comments mentioning the symbol names (e.g., the breadcrumb
    //     in check-orchestration.ts after the 3.5a promotion)
    //   - string literals
    //   - import specifiers (consumers ARE allowed to import the
    //     resolved values; the rule is about declaration ownership)
    //   - export specifiers / re-exports (packages/core/src/index.ts
    //     re-exports the DEFAULT_* values from policy-resolve.js;
    //     that is intentional and must not trip the invariant)
    //
    // Detection: recursively scan VariableDeclaration nodes. Both
    // `export const X = ...` and nested `const X = ...` surface there.
    // ImportDeclaration and ExportDeclaration nodes are separate node
    // kinds, so re-export and import specifiers do NOT match.

    const PATTERN = /^DEFAULT_(RISK|CHECKS|FRAMEWORKS)_/;
    const ALLOWED_REL = "packages/core/src/policy-resolve.ts";
    const PACKAGES_DIR = join(REPO_ROOT, "packages");
    const EXPECTED_ALLOWED_SYMBOLS = new Set([
      "DEFAULT_CHECKS_CONFIG",
      "DEFAULT_FRAMEWORKS_POLICY",
      "DEFAULT_RISK_BLOCK_ON",
      "DEFAULT_RISK_WARN_ON",
    ]);

    const offenders: Array<{ file: string; symbol: string }> = [];
    const allowedSymbols = new Set<string>();

    for (const pkg of readdirSync(PACKAGES_DIR)) {
      const pkgSrc = join(PACKAGES_DIR, pkg, "src");
      let srcFiles: string[];
      try {
        srcFiles = findTsFiles(pkgSrc);
      } catch {
        // Package has no src/ dir (yet); skip.
        continue;
      }
      for (const abs of srcFiles) {
        const source = readFileSync(abs, "utf8");
        const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.ES2023, false);
        const visit = (node: ts.Node): void => {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            if (PATTERN.test(node.name.text)) {
              const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
              if (rel === ALLOWED_REL) {
                allowedSymbols.add(node.name.text);
              } else {
                offenders.push({ file: rel, symbol: node.name.text });
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }

    expect(
      offenders,
      `D57 ownership violated (direction 1 -- duplicate owners): DEFAULT_RISK_/DEFAULT_CHECKS_/DEFAULT_FRAMEWORKS_ symbols may only be declared in ${ALLOWED_REL}. Offenders found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);

    expect(
      [...allowedSymbols].sort(),
      `D57 ownership violated (direction 2 -- contract drift): ${ALLOWED_REL} must declare EXACTLY the expected DEFAULT_* set. Adding a legitimate new DEFAULT_* requires updating EXPECTED_ALLOWED_SYMBOLS in this test in the SAME commit.`,
    ).toEqual([...EXPECTED_ALLOWED_SYMBOLS].sort());
  });
});

// =============================================================================
// M G1a Step 5 D99.M -- packages/cli MCPCommand exposure + cold-start lock
// (D99.M.12)
//
// TypeScript AST-based assertion: parses packages/cli/src/index.ts AND
// packages/cli/src/commands/mcp.ts with the TypeScript compiler API
// (already imported at the top of this file) and walks ImportDeclaration
// + CallExpression nodes to assert structural contracts. NOT regex/
// string-position-based: comments cannot satisfy or break it, type-only
// and aliased imports are correctly distinguished from value-binding
// imports, default-import and namespace-import bypasses are structurally
// rejected (not relying on downstream TS compile errors), the cold-start
// lock follows the static-import graph (covers BOTH files, since index.ts
// statically imports commands/mcp.js), and a computed-access bypass
// `cli["register"](...)` cannot evade detection.
//
// Seven structural sub-checks (single it() block, shared parse state,
// mirrors D99.M.8's multi-sub-check pattern):
//
//   1. EXACTLY ONE MCPCommand binding from "./commands/mcp.js" in
//      index.ts. Binding-match predicate: importedName === "MCPCommand"
//      OR localName === "MCPCommand" (symmetric -- catches both
//      `MCPCommand as X` and `X as MCPCommand` shadows, AND default/
//      namespace imports). The matched binding must be:
//        - bindingKind === "named"  (NOT default, NOT namespace)
//        - hasAlias === false       (specifier.propertyName undefined)
//        - isTypeOnly === false     (neither clause-level nor specifier-
//                                    level type-only modifier)
//
//   2. ZERO MCPCommand bindings from "@viberevert/cli-commands" in
//      index.ts using the same symmetric predicate. Catches default
//      imports, namespace imports, and both alias directions
//      structurally -- not via TS compile-error fallthrough.
//      (D99.M.15 cross-check.)
//
//   3. COLD-START LOCK -- ZERO static "@viberevert/mcp" ImportDeclaration
//      nodes across BOTH index.ts AND commands/mcp.ts. The scan covers
//      both files because index.ts statically imports
//      "./commands/mcp.js" -- any static `from "@viberevert/mcp"` in
//      mcp.ts therefore enters the cold path on every CLI startup just
//      as much as a direct static import in index.ts would. The
//      contract is enforced via `ts.isImportDeclaration` (top-level
//      static-import-statement only), which:
//        - REJECTS: `import { startServer } from "@viberevert/mcp"`,
//                   `import * as M from "@viberevert/mcp"`,
//                   `import MCP from "@viberevert/mcp"`,
//                   `import "@viberevert/mcp"` (bare side-effect)
//        - ALLOWS:  `typeof import("@viberevert/mcp")`  (ImportTypeNode,
//                   type position, no runtime emission)
//        - ALLOWS:  `import("@viberevert/mcp")`         (dynamic-import
//                   CallExpression, the D99.N loader seam)
//
//      Rationale: the mcp package is dynamically imported ONLY via the
//      loader seam in commands/mcp.ts (D99.N). A static import in
//      EITHER file would pull the SDK + audit writer + Zod schemas +
//      tool registry into every `viberevert` cold start (`--version`,
//      `doctor`, `init`, etc.), bloating non-mcp startup time and
//      memory.
//
//   4. EXACTLY ONE direct PropertyAccessExpression register call
//      `cli.register(MCPCommand)` in index.ts -- AND that call must
//      have argumentCount === 1. The unary-call shape lock catches
//      `cli.register(MCPCommand, extraArg)` shapes that a count-only
//      check would miss.
//
//   5. EXACTLY ONE direct PropertyAccessExpression register call
//      `cli.register(HookUninstallCommand)` in index.ts -- AND that
//      call must have argumentCount === 1. Same unary-shape lock as
//      sub-check 4. D98.M.10 also asserts the count; a failure here
//      likely co-occurs with D98.M.10 failures.
//
//   6. Source-order: `cli.register(MCPCommand)` appears STRICTLY AFTER
//      `cli.register(HookUninstallCommand)` in index.ts using AST node
//      getStart(sf) positions. STRICT-AFTER, not "immediately after"
//      and NOT "last" -- future work may legitimately insert other
//      commands between HookUninstallCommand and MCPCommand. The
//      contract: do not regress MCPCommand to a position before
//      HookUninstallCommand.
//
//   7. ZERO computed-access calls `cli["register"](...)` /
//      `cli['register'](...)` in index.ts. Sub-checks 4 and 5 walk
//      PropertyAccessExpression callees only; a future maintainer who
//      switched to ElementAccess form would silently bypass those
//      counters. This sub-check closes that gap. TS AST collapses both
//      quote styles to the same ElementAccessExpression node.
//
// Why AST not regex: import provenance, value-vs-type distinction,
// alias detection, default/namespace binding shapes, dynamic-import vs
// static-import distinction (cold-start lock!), and call-expression
// callee shape are STRUCTURAL contracts the TS AST exposes natively.
// Regex can approximate but cannot distinguish `import type { X }`
// from `import { X }`, cannot detect `import * as MCPCommand from
// "..."` as a binding for the name MCPCommand, cannot distinguish
// static `import { X } from "@viberevert/mcp"` from dynamic
// `import("@viberevert/mcp")`, and cannot reject computed-access
// register calls without an additional string scan. The compiler API
// does all of this for free.
// =============================================================================

describe("Architectural invariants -- M G1a Step 5 D99.M CLI MCPCommand exposure (TypeScript AST)", () => {
  const CLI_INDEX_REL = "packages/cli/src/index.ts";
  const MCP_COMMAND_REL = "packages/cli/src/commands/mcp.ts";

  it('D99.M.12: AST -- (1) one named-no-alias-value MCPCommand binding from "./commands/mcp.js" in index.ts; (2) zero MCPCommand bindings from @viberevert/cli-commands in index.ts; (3) cold-start lock: zero static @viberevert/mcp ImportDeclaration nodes across index.ts AND commands/mcp.ts (typeof import + dynamic import allowed); (4) one cli.register(MCPCommand) PropertyAccess call with argumentCount === 1; (5) one cli.register(HookUninstallCommand) anchor with argumentCount === 1; (6) MCPCommand register strictly after HookUninstall register; (7) zero computed cli["register"](...) calls', () => {
    type BindingKind = "default" | "namespace" | "named";
    type ImportBindingInfo = {
      readonly importedName: string;
      readonly localName: string;
      readonly bindingKind: BindingKind;
      readonly hasAlias: boolean;
      readonly isTypeOnly: boolean;
      readonly pos: string;
    };
    type ImportDeclInfo = {
      readonly file: string;
      readonly moduleSpec: string;
      readonly bindings: readonly ImportBindingInfo[];
      readonly pos: string;
    };
    type RegisterCallInfo = {
      readonly argName: string | null;
      readonly argumentCount: number;
      readonly pos: number;
      readonly posLabel: string;
    };

    // requireFirst -- narrows arr[0] from `T | undefined` to `T` after
    // the prior length===1 assertion. Throws on unreachable [0]-undefined
    // states (would only fire if the prior count expect erroneously
    // passed with length === 0, which is structurally impossible).
    // Replaces the arr[0]! non-null-assertion pattern that biome's
    // noNonNullAssertion rule forbids.
    //
    // Uses `=== undefined` explicit check (not `!first` truthiness) so
    // a future reuse with a falsy-but-valid element type (0, "", false,
    // null) does not misfire the throw branch on a legitimately-present
    // falsy element. The contract is "array is non-empty", NOT "first
    // element is truthy".
    const requireFirst = <T>(arr: readonly T[], subCheckLabel: string): T => {
      const first = arr[0];
      if (first === undefined) {
        throw new Error(
          `${subCheckLabel}: unreachable -- the prior length===1 expect would have failed first.`,
        );
      }
      return first;
    };

    // ----- Parse + import walker (one helper, reused for both files) -----
    //
    // Returns ALL ImportDeclarations with EVERY binding each introduces
    // (default, namespace, named -- all three forms). Bare side-effect
    // imports (`import "./x.js";`) are recorded with bindings: [] so the
    // cold-start lock (sub-check 3) catches them even without a binding.
    // Dynamic-import CallExpressions and ImportTypeNodes are NOT
    // ImportDeclaration nodes and are therefore ignored by design.
    const walkImports = (
      relPath: string,
    ): { sf: ts.SourceFile; declarations: ImportDeclInfo[] } => {
      const absPath = join(REPO_ROOT, relPath);
      const source = readSource(relPath);
      const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.ES2023, false);
      const fmtPos = (node: ts.Node): string => {
        const start = node.getStart(sf);
        const { line, character } = sf.getLineAndCharacterOfPosition(start);
        return `${relPath}:L${line + 1}:${character + 1}`;
      };

      const declarations: ImportDeclInfo[] = [];
      for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const moduleSpec = stmt.moduleSpecifier.text;

        const bindings: ImportBindingInfo[] = [];
        const importClause = stmt.importClause;
        if (importClause) {
          const isTypeOnlyClause = importClause.isTypeOnly === true;
          // Default-import binding: `import <Name> from "..."`
          if (importClause.name) {
            bindings.push({
              importedName: "default",
              localName: importClause.name.text,
              bindingKind: "default",
              hasAlias: false,
              isTypeOnly: isTypeOnlyClause,
              pos: fmtPos(importClause.name),
            });
          }
          const namedBindings = importClause.namedBindings;
          if (namedBindings) {
            if (ts.isNamespaceImport(namedBindings)) {
              // Namespace-import binding: `import * as <Name> from "..."`
              bindings.push({
                importedName: "*",
                localName: namedBindings.name.text,
                bindingKind: "namespace",
                hasAlias: false,
                isTypeOnly: isTypeOnlyClause,
                pos: fmtPos(namedBindings.name),
              });
            } else if (ts.isNamedImports(namedBindings)) {
              // Named-imports bindings: `import { <X>, <Y as Z>, ... } from "..."`
              for (const elem of namedBindings.elements) {
                const importedName = elem.propertyName?.text ?? elem.name.text;
                const localName = elem.name.text;
                bindings.push({
                  importedName,
                  localName,
                  bindingKind: "named",
                  hasAlias: elem.propertyName !== undefined,
                  isTypeOnly: isTypeOnlyClause || elem.isTypeOnly === true,
                  pos: fmtPos(elem),
                });
              }
            }
          }
        }

        declarations.push({
          file: relPath,
          moduleSpec,
          bindings,
          pos: fmtPos(stmt),
        });
      }
      return { sf, declarations };
    };

    const indexParsed = walkImports(CLI_INDEX_REL);
    const mcpFileParsed = walkImports(MCP_COMMAND_REL);

    // ----- CallExpression walker for index.ts (recursive -- catches
    //       conditional / wrapped invocations a top-level-only walk
    //       would miss). Scoped to index.ts only because sub-checks
    //       4-7 are about registration in the CLI entry, not about
    //       calls inside the command file. -----
    const propertyAccessRegisterCalls: RegisterCallInfo[] = [];
    const computedAccessRegisterCalls: Array<{ readonly posLabel: string }> = [];
    const indexFmtPos = (node: ts.Node): string => {
      const start = node.getStart(indexParsed.sf);
      const { line, character } = indexParsed.sf.getLineAndCharacterOfPosition(start);
      return `${CLI_INDEX_REL}:L${line + 1}:${character + 1}`;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "cli" &&
          callee.name.text === "register"
        ) {
          // PropertyAccess form: cli.register(<arg>, ...)
          const firstArg = node.arguments[0];
          const argName = firstArg && ts.isIdentifier(firstArg) ? firstArg.text : null;
          propertyAccessRegisterCalls.push({
            argName,
            argumentCount: node.arguments.length,
            pos: node.getStart(indexParsed.sf),
            posLabel: indexFmtPos(node),
          });
        } else if (
          ts.isElementAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "cli"
        ) {
          // ElementAccess form: cli["register"](<arg>) OR cli['register'](<arg>)
          // -- TS AST collapses both quote styles to the same node.
          const accessArg = callee.argumentExpression;
          if (ts.isStringLiteral(accessArg) && accessArg.text === "register") {
            computedAccessRegisterCalls.push({ posLabel: indexFmtPos(node) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(indexParsed.sf);

    // Symmetric MCPCommand-binding predicate -- catches both alias
    // directions AND default/namespace shadows:
    //   `import { MCPCommand } from "..."`        -> importedName="MCPCommand", localName="MCPCommand" -> match
    //   `import { MCPCommand as X } from "..."`   -> importedName="MCPCommand", localName="X"          -> match (importedName)
    //   `import { X as MCPCommand } from "..."`   -> importedName="X",          localName="MCPCommand" -> match (localName)
    //   `import MCPCommand from "..."`            -> importedName="default",    localName="MCPCommand" -> match (localName)
    //   `import * as MCPCommand from "..."`       -> importedName="*",          localName="MCPCommand" -> match (localName)
    const isMcpBinding = (b: ImportBindingInfo): boolean =>
      b.importedName === "MCPCommand" || b.localName === "MCPCommand";

    // ===== Sub-check 1 -- exactly one MCPCommand binding from local
    //       module in index.ts, in the required shape =====
    const localMcpBindings = indexParsed.declarations
      .filter((d) => d.moduleSpec === "./commands/mcp.js")
      .flatMap((d) => d.bindings.filter(isMcpBinding));
    expect(
      localMcpBindings.length,
      `D99.M.12 sub-check 1 (count): index.ts must contain EXACTLY ONE MCPCommand binding from "./commands/mcp.js" (TS AST; predicate: importedName === "MCPCommand" OR localName === "MCPCommand" -- catches default, namespace, and both alias directions). Found ${localMcpBindings.length}: ${JSON.stringify(localMcpBindings)}.`,
    ).toBe(1);
    const local = requireFirst(localMcpBindings, "D99.M.12 sub-check 1");
    expect(
      local.bindingKind,
      `D99.M.12 sub-check 1 (named binding): the MCPCommand binding from "./commands/mcp.js" must be a NAMED import (\`import { MCPCommand } from "..."\`), NOT a default import (\`import MCPCommand from "..."\`) and NOT a namespace import (\`import * as MCPCommand from "..."\`). Found bindingKind="${local.bindingKind}" at ${local.pos}.`,
    ).toBe("named");
    expect(
      local.hasAlias,
      `D99.M.12 sub-check 1 (no alias): the MCPCommand named-import binding from "./commands/mcp.js" must use the identifier MCPCommand directly. \`MCPCommand as <alias>\` and \`<other> as MCPCommand\` forms are both forbidden (specifier.propertyName must be undefined; localName must equal importedName). Found at ${local.pos} with importedName="${local.importedName}", localName="${local.localName}".`,
    ).toBe(false);
    expect(
      local.isTypeOnly,
      `D99.M.12 sub-check 1 (value import): the MCPCommand named-import binding from "./commands/mcp.js" must be a VALUE import. \`import type { MCPCommand }\` (importClause.isTypeOnly) and per-specifier type-only forms (specifier.isTypeOnly) are both forbidden -- MCPCommand needs a runtime binding for cli.register(MCPCommand). Found at ${local.pos}.`,
    ).toBe(false);

    // ===== Sub-check 2 -- zero MCPCommand bindings from
    //       @viberevert/cli-commands in index.ts =====
    const cliCommandsMcpBindings = indexParsed.declarations
      .filter((d) => d.moduleSpec === "@viberevert/cli-commands")
      .flatMap((d) => d.bindings.filter(isMcpBinding));
    expect(
      cliCommandsMcpBindings.length,
      `D99.M.12 sub-check 2 (cli-commands MCPCommand-binding negative): index.ts must NOT import any binding for MCPCommand from "@viberevert/cli-commands" -- ANY shape (default, namespace, named, aliased in either direction). D99.M.15 cross-check; MCPCommand lives in the CLI binary per D99.N -- relocating it into cli-commands would create the forbidden cli-commands -> mcp dependency edge. cli-commands is otherwise a legitimate import source for OTHER Command classes (just not MCPCommand). Found ${cliCommandsMcpBindings.length}: ${JSON.stringify(cliCommandsMcpBindings)}.`,
    ).toBe(0);

    // ===== Sub-check 3 -- cold-start lock: zero static
    //       "@viberevert/mcp" ImportDeclarations across BOTH index.ts
    //       AND commands/mcp.ts =====
    //
    // Scans BOTH files because index.ts statically imports
    // "./commands/mcp.js" -- any static `from "@viberevert/mcp"` in
    // mcp.ts therefore enters the cold path on every CLI startup just
    // as much as a static import in index.ts would. ts.isImportDeclaration
    // is the static-import-statement filter; it correctly excludes:
    //   - ImportTypeNode  (`typeof import("@viberevert/mcp")` -- type
    //                      position, no runtime emission, used by
    //                      mcp.ts's StartServerLoader type)
    //   - dynamic-import CallExpression (`import("@viberevert/mcp")` --
    //                      the D99.N loader seam, used by mcp.ts's
    //                      defaultLoader)
    const staticMcpPackageImports = [
      ...indexParsed.declarations,
      ...mcpFileParsed.declarations,
    ].filter((d) => d.moduleSpec === "@viberevert/mcp");
    expect(
      staticMcpPackageImports.length,
      `D99.M.12 sub-check 3 (cold-start lock): static "@viberevert/mcp" ImportDeclaration nodes must be ZERO across BOTH ${CLI_INDEX_REL} AND ${MCP_COMMAND_REL} (any form -- named, default, namespace, side-effect). The mcp package is dynamically imported ONLY via the loader seam in ${MCP_COMMAND_REL} (D99.N). \`typeof import("@viberevert/mcp")\` (type position) and \`import("@viberevert/mcp")\` (dynamic-import CallExpression) are ALLOWED -- both are excluded by the ts.isImportDeclaration filter. A static import in EITHER file would pull the SDK + audit writer + Zod schemas into every viberevert cold start, slowing non-mcp invocations. Found ${staticMcpPackageImports.length}: ${JSON.stringify(staticMcpPackageImports.map((d) => ({ pos: d.pos, bindings: d.bindings })))}.`,
    ).toBe(0);

    // ===== Sub-check 4 -- exactly one cli.register(MCPCommand)
    //       PropertyAccess call AND argumentCount === 1 =====
    const mcpRegisterCalls = propertyAccessRegisterCalls.filter((c) => c.argName === "MCPCommand");
    expect(
      mcpRegisterCalls.length,
      `D99.M.12 sub-check 4 (MCPCommand register count): index.ts must contain EXACTLY ONE \`cli.register(MCPCommand)\` PropertyAccessExpression CallExpression with a bare Identifier first argument (TS AST). Wrapped forms (loops, spread, namespace-property access like \`m.MCPCommand\`) and renamed cli bindings (\`myCli.register(MCPCommand)\`) are intentionally NOT counted -- the contract is explicit, direct registration. Found ${mcpRegisterCalls.length}: ${JSON.stringify(mcpRegisterCalls.map((c) => ({ pos: c.posLabel, argumentCount: c.argumentCount })))}.`,
    ).toBe(1);
    const firstMcpRegister = requireFirst(mcpRegisterCalls, "D99.M.12 sub-check 4");
    expect(
      firstMcpRegister.argumentCount,
      `D99.M.12 sub-check 4 (MCPCommand register shape): the \`cli.register(MCPCommand)\` call must be unary (argumentCount === 1). \`cli.register(MCPCommand, extra)\` and similar non-unary shapes are forbidden -- the registration contract is single-argument. Found argumentCount=${firstMcpRegister.argumentCount} at ${firstMcpRegister.posLabel}.`,
    ).toBe(1);

    // ===== Sub-check 5 -- exactly one cli.register(HookUninstallCommand)
    //       anchor AND argumentCount === 1 =====
    const hookUninstallRegisterCalls = propertyAccessRegisterCalls.filter(
      (c) => c.argName === "HookUninstallCommand",
    );
    expect(
      hookUninstallRegisterCalls.length,
      `D99.M.12 sub-check 5 (HookUninstallCommand anchor): index.ts must contain EXACTLY ONE \`cli.register(HookUninstallCommand)\` PropertyAccessExpression call. D98.M.10 also asserts this -- a failure here likely co-occurs with D98.M.10 failures. Found ${hookUninstallRegisterCalls.length}: ${JSON.stringify(hookUninstallRegisterCalls.map((c) => ({ pos: c.posLabel, argumentCount: c.argumentCount })))}.`,
    ).toBe(1);
    const firstHookUninstallRegister = requireFirst(
      hookUninstallRegisterCalls,
      "D99.M.12 sub-check 5",
    );
    expect(
      firstHookUninstallRegister.argumentCount,
      `D99.M.12 sub-check 5 (HookUninstallCommand register shape): the \`cli.register(HookUninstallCommand)\` call must be unary (argumentCount === 1). Found argumentCount=${firstHookUninstallRegister.argumentCount} at ${firstHookUninstallRegister.posLabel}.`,
    ).toBe(1);

    // ===== Sub-check 6 -- MCPCommand registered STRICTLY AFTER
    //       HookUninstallCommand (source order via AST positions) =====
    //
    // STRICT-AFTER, not "immediately after" and NOT "last" -- future
    // work may insert other commands between HookUninstallCommand and
    // MCPCommand without breaking this invariant. The contract is just
    // "do not regress MCPCommand to a position before HookUninstallCommand".
    //
    // Reuses the firstHookUninstallRegister + firstMcpRegister consts
    // captured by sub-checks 4 + 5 via requireFirst (type-safe narrowing
    // from `T | undefined` to `T` after the prior count assertions).
    const hookUninstallPos = firstHookUninstallRegister.pos;
    const mcpPos = firstMcpRegister.pos;
    expect(
      hookUninstallPos,
      `D99.M.12 sub-check 6 (ordering, strict-after): \`cli.register(MCPCommand)\` must appear STRICTLY AFTER \`cli.register(HookUninstallCommand)\` in source order (AST node getStart(sf) positions). HookUninstallCommand at ${firstHookUninstallRegister.posLabel} (pos ${hookUninstallPos}); MCPCommand at ${firstMcpRegister.posLabel} (pos ${mcpPos}). Strict-after, NOT immediately-after -- future commands may be inserted between the two without breaking the invariant.`,
    ).toBeLessThan(mcpPos);

    // ===== Sub-check 7 -- zero computed cli["register"](...) calls =====
    //
    // PropertyAccessExpression-only collectors (sub-checks 4 and 5)
    // would silently miss a future maintainer who switched to
    // ElementAccess form. This sub-check is the wall against that
    // bypass. TS AST collapses both quote styles (`cli["register"]`
    // and `cli['register']`) to the same ElementAccessExpression
    // node, so one check covers both.
    expect(
      computedAccessRegisterCalls.length,
      `D99.M.12 sub-check 7 (no computed-access bypass): index.ts must NOT call \`cli["register"](...)\` or \`cli['register'](...)\` (ElementAccessExpression with a string-literal "register" argument). Sub-checks 4 and 5 walk PropertyAccessExpression callees only; a future maintainer who switched to ElementAccess form would silently bypass those counters. This sub-check closes that gap. Found ${computedAccessRegisterCalls.length}: ${JSON.stringify(computedAccessRegisterCalls.map((c) => c.posLabel))}.`,
    ).toBe(0);
  });
});

describe("Architectural invariants -- M G1b D101.M installers boundaries", () => {
  // D101.M.3 / .4: import discipline for @viberevert/installers.
  // D101.M.7 / .8 / .9: I/O ownership for the lock dir, journal dir,
  //   integrations.json, and __store__/ backup namespace.
  // D101.M.10: the installers barrel must not re-export internal
  //   modules or the low-level writeIntegrationsFile mutator.
  // D101.M.11: other workspace packages may only import the
  //   installers barrel (no static or dynamic deep subpath imports).
  //
  // All checks strip comments BEFORE pattern matching via
  // stripTsComments(). This is critical for two reasons:
  //   1. The OWNED_PATHS tests use raw String.includes() to look for
  //      the owned path literal -- findOffenders' built-in comment
  //      filter does not apply to that check. JSDoc / //-comment
  //      mentions of owned paths in source files (e.g., engine-
  //      apply.ts BOUNDARY section lists "integrations.lock") would
  //      otherwise falsely trigger the invariant.
  //   2. The fs-import detection in fileImportsFsOperations runs
  //      regexes against the source. Comment mentions of fs imports
  //      would false-positive without stripping.
  //
  // For findOffenders-based tests (M.3 / M.4 / M.10 module-export
  // patterns / M.11), stripping is defense-in-depth -- findOffenders
  // already filters line-comments and JSDoc blocks, but stripping
  // first also covers inline comments.
  //
  // Diagnostic exceptions for engine-apply.ts and engine-uninstall.ts:
  // both files reference owned path literals in RUNTIME STRINGS (not
  // comments) -- error messages, stderr warnings, PendingIntegration-
  // RecoveryError.journalDir construction, InstallReceipt.integrations
  // JsonPath construction, UninstallOutcome.not-installed reason text.
  // These survive comment-stripping. Since both files import fs APIs
  // (for target mutation), they would naively trigger the I/O
  // ownership invariants. The explicit exceptions allow these
  // diagnostic mentions; both files go through the typed function
  // APIs (writeIntegrationsFile, scanForPendingJournals, acquireLock,
  // releaseLock, etc.) and do not perform fs operations directly
  // against the owned paths.

  const INSTALLERS_SRC_DIR = join(REPO_ROOT, "packages/installers/src");

  it("D101.M.3: @viberevert/installers does not deep-import from @viberevert/cli-commands/dist/commands/", () => {
    const files = findTsFiles(INSTALLERS_SRC_DIR);
    const pattern = /from\s+["']@viberevert\/cli-commands\/dist\/commands\//;
    for (const file of files) {
      const source = stripTsComments(readFileSync(file, "utf8"));
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `${relative(REPO_ROOT, file).replace(/\\/g, "/")} must not deep-import from @viberevert/cli-commands/dist/commands/ (D101.M.3 -- installers sits below cli-commands in the layer order). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  it("D101.M.4: @viberevert/installers imports @viberevert/adapters only via the bare specifier (no static or dynamic subpath imports)", () => {
    const files = findTsFiles(INSTALLERS_SRC_DIR);
    // Forbidden: ANY subpath after the package name, in static
    // `from "..."` OR dynamic `import("...")` form. Bare
    // `from "@viberevert/adapters"` and `import("@viberevert/adapters")`
    // remain allowed (the package barrel is the public surface).
    const pattern = /(?:from\s+|import\s*\(\s*)["']@viberevert\/adapters\/[^"']+["']/;
    for (const file of files) {
      const source = stripTsComments(readFileSync(file, "utf8"));
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `${relative(REPO_ROOT, file).replace(/\\/g, "/")} must import @viberevert/adapters via bare specifier only (D101.M.4 -- barrel-only consumption; static and dynamic forms; no subpaths of any kind). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  // I/O ownership invariants (M.7 / M.8 / M.9). Pattern: for each
  // owned path literal, only the owner module (and explicit
  // diagnostic exceptions) may both mention the literal AND import
  // fs API symbols. Comment stripping happens BEFORE the
  // literal-includes check so JSDoc mentions don't false-positive.

  /**
   * Detect whether the file imports fs operations that could
   * read / write / mutate filesystem paths. Returns true when
   * BOTH:
   *   (a) the file imports from node:fs/promises OR from
   *       ./atomic.js (the local writeFileAtomic primitive), AND
   *   (b) the file actually uses at least one fs API name
   *       (writeFile/writeFileAtomic/mkdir/unlink/rmdir/rm/
   *       rename/chmod/readFile/readdir/lstat/stat).
   *
   * Input MUST be comment-stripped source -- the import regex
   * would otherwise false-positive on JSDoc mentions of fs
   * imports. Reads (readFile / readdir / lstat / stat) are
   * included alongside mutating APIs because I/O ownership is
   * about TOTAL ownership of the path, not just write
   * ownership (e.g., scanForPendingJournals reads the journal
   * dir, and that read also belongs to journal.ts).
   */
  function fileImportsFsOperations(strippedSource: string): boolean {
    const fsPromisesImport = /from\s+["']node:fs\/promises["']/.test(strippedSource);
    const atomicImport = /from\s+["']\.\/atomic\.js["']/.test(strippedSource);
    if (!fsPromisesImport && !atomicImport) return false;
    const apiUsage =
      /\b(writeFile|writeFileAtomic|mkdir|unlink|rmdir|rm|rename|chmod|readFile|readdir|lstat|stat)\b/;
    return apiUsage.test(strippedSource);
  }

  interface OwnedPathInvariant {
    readonly id: string;
    readonly literal: string;
    readonly owner: string;
    readonly diagnosticExceptions: ReadonlyArray<string>;
    readonly description: string;
  }

  const OWNED_PATHS: ReadonlyArray<OwnedPathInvariant> = [
    {
      // engine-apply + engine-uninstall both reference the literal
      // "integrations.lock" in their finally-block stderr warning
      // ("remove .viberevert/integrations.lock/ manually"). They go
      // through acquireLock/releaseLock for actual lock I/O.
      id: "D101.M.7",
      literal: "integrations.lock",
      owner: "lock.ts",
      diagnosticExceptions: ["engine-apply.ts", "engine-uninstall.ts"],
      description: "lock dir I/O ownership",
    },
    {
      // engine-apply + engine-uninstall both reference the literal
      // "integration-journal" via the local JOURNAL_DIR_NAME constant
      // for PendingIntegrationRecoveryError.journalDir construction.
      // They go through writeJournal/updateJournal/scanForPending-
      // Journals/deleteJournal for actual journal I/O.
      id: "D101.M.8",
      literal: "integration-journal",
      owner: "journal.ts",
      diagnosticExceptions: ["engine-apply.ts", "engine-uninstall.ts"],
      description: "journal dir I/O ownership",
    },
    {
      // engine-apply references "integrations.json" via the local
      // INTEGRATIONS_FILENAME constant for InstallReceipt.integrations
      // JsonPath construction. engine-uninstall references it in the
      // UninstallOutcome.not-installed reason string ("no record for
      // ${recordKey} in .viberevert/integrations.json"). gitignore-
      // check.ts references it in the printGitignoreWarning stderr
      // text ("VibeRevert stores local artifacts (integrations.json,
      // backups, journal, audit logs) under .viberevert/"). All three
      // go through readIntegrationsFile/writeIntegrationsFile (or
      // never touch integrations.json at all, for gitignore-check)
      // for actual store I/O.
      id: "D101.M.9 (integrations.json)",
      literal: "integrations.json",
      owner: "integrations-store.ts",
      diagnosticExceptions: ["engine-apply.ts", "engine-uninstall.ts", "gitignore-check.ts"],
      description: "store-file I/O ownership",
    },
    {
      // __store__ namespace is internal to integrations-store.ts. No
      // diagnostic mentions in other files (engine-apply / uninstall
      // pass backupGroupId through writeIntegrationsFile; the
      // __store__ subdir name is hidden inside the store module).
      id: "D101.M.9 (__store__ namespace)",
      literal: "__store__",
      owner: "integrations-store.ts",
      diagnosticExceptions: [],
      description: "store-backup namespace ownership",
    },
  ];

  for (const { id, literal, owner, diagnosticExceptions, description } of OWNED_PATHS) {
    it(`${id}: only ${owner} may perform fs I/O against "${literal}" (${description})`, () => {
      const files = findTsFiles(INSTALLERS_SRC_DIR);
      const violations: string[] = [];
      for (const file of files) {
        const source = stripTsComments(readFileSync(file, "utf8"));
        const filename = file.split(/[\\/]/).pop() ?? "";
        if (!source.includes(literal)) continue;
        if (filename === owner) continue;
        if (diagnosticExceptions.includes(filename)) continue;
        if (fileImportsFsOperations(source)) {
          violations.push(
            `${relative(REPO_ROOT, file).replace(/\\/g, "/")}: contains literal "${literal}" AND imports fs API symbols`,
          );
        }
      }
      expect(
        violations,
        `${id}: only ${owner} may perform fs I/O against "${literal}". Diagnostic exceptions (allowed even with fs imports): ${JSON.stringify(diagnosticExceptions)}. Violations: ${JSON.stringify(violations)}`,
      ).toEqual([]);
    });
  }

  it("D101.M.10: the installers barrel must not re-export internal modules or writeIntegrationsFile", () => {
    const source = stripTsComments(readSource("packages/installers/src/index.ts"));
    const forbiddenModuleSpecifiers: ReadonlyArray<string> = [
      "./engine-classify.js",
      "./engine-classify",
      "./journal.js",
      "./journal",
      "./lock.js",
      "./lock",
      "./atomic.js",
      "./atomic",
      "./preflight-target.js",
      "./preflight-target",
      "./canonical-json.js",
      "./canonical-json",
      "./line-endings.js",
      "./line-endings",
      "./path-resolve.js",
      "./path-resolve",
      "./path-encode.js",
      "./path-encode",
    ];
    for (const spec of forbiddenModuleSpecifiers) {
      const escaped = spec.replace(/\./g, "\\.");
      const pattern = new RegExp(
        `export\\s+(?:\\*|\\{[^}]*\\}|type\\s+\\{[^}]*\\})\\s+from\\s+["']${escaped}["']`,
      );
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `packages/installers/src/index.ts must not re-export from "${spec}" (D101.M.10 -- internal module, not part of public surface). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
    // writeIntegrationsFile must NEVER leak through the barrel.
    // Two bypass paths are checked here:
    //   1. Named re-export: `export { writeIntegrationsFile } from
    //      "./integrations-store.js"` (multi-line tolerant via
    //      `[^}]*` which spans newlines by default).
    //   2. Wildcard re-export: `export * from "./integrations-store.js"`
    //      -- bypasses the named-export check by exposing the
    //      ENTIRE store module surface, including writeIntegrationsFile.
    const namedExportPattern =
      /export\s+\{[^}]*\bwriteIntegrationsFile\b[^}]*\}\s+from\s+["']\.\/integrations-store\.js["']/;
    expect(
      namedExportPattern.test(source),
      `packages/installers/src/index.ts must not export writeIntegrationsFile from "./integrations-store.js" via named re-export (D101.M.10 -- low-level mutator; bypasses lock + journal + outcome semantics; callers must use apply / uninstall).`,
    ).toBe(false);
    const wildcardExportPattern = /export\s+\*\s+from\s+["']\.\/integrations-store\.js["']/;
    expect(
      wildcardExportPattern.test(source),
      `packages/installers/src/index.ts must not export * from "./integrations-store.js" (D101.M.10 -- would expose writeIntegrationsFile bypassing the named-export check). Use selective named exports only.`,
    ).toBe(false);
  });

  it("D101.M.11: other workspace packages import @viberevert/installers only via the bare specifier (no static or dynamic subpath imports)", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const otherPackages = readdirSync(packagesDir)
      .filter((name) => name !== "installers")
      .map((name) => join(packagesDir, name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    // Match BOTH static `from "@viberevert/installers/..."` AND
    // dynamic `import("@viberevert/installers/...")` subpath
    // imports. Bare specifiers in either form remain allowed.
    const pattern = /(?:from\s+|import\s*\(\s*)["']@viberevert\/installers\/[^"']+["']/;
    const offenders: string[] = [];
    for (const pkgDir of otherPackages) {
      for (const subdir of ["src", "test"]) {
        const fullSubdir = join(pkgDir, subdir);
        try {
          if (!statSync(fullSubdir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const file of findTsFiles(fullSubdir)) {
          const source = stripTsComments(readFileSync(file, "utf8"));
          const fileOffenders = findOffenders(source, pattern);
          for (const o of fileOffenders) {
            offenders.push(
              `${relative(REPO_ROOT, file).replace(/\\/g, "/")}:${o.lineNumber}: ${o.content}`,
            );
          }
        }
      }
    }
    expect(
      offenders,
      `Other workspace packages must import @viberevert/installers via the bare specifier only (D101.M.11 -- static or dynamic; barrel is public surface). Deep-import offenders: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

describe("Architectural invariants -- D101.M.5 hook-install-integrations-guard import surface", () => {
  // D101.M.5 (M G1b Step 4D lock): the compatibility guard between
  // `viberevert hook install` (M F) and `viberevert install --direct`
  // (M G1b) MUST import EXACTLY one symbol from @viberevert/installers
  // -- `hasRepoIntegrationRecord`. No deep imports, no
  // readIntegrationsFile, no engine internals, no schema/types.
  //
  // Comment handling: the guard's own JSDoc mentions
  // `@viberevert/installers`, `import`, `readIntegrationsFile`, etc. as
  // part of its D101.M.5 documentation. Test 1 pre-strips block +
  // line comments before scanning to avoid false positives; tests 2
  // and 3 use findOffenders (which strips comments itself).

  const GUARD_REL = "packages/cli-commands/src/commands/hook-install-integrations-guard.ts";

  it("has EXACTLY one static `from '@viberevert/installers'` import statement, importing EXACTLY `hasRepoIntegrationRecord` (D101.M.5)", () => {
    const source = readSource(GUARD_REL);
    // Strip comments before scanning -- the guard's own JSDoc contains
    // literal `import` / `@viberevert/installers` / `hasRepoIntegrationRecord`
    // / `readIntegrationsFile` tokens that would false-positive a raw
    // regex scan. Uses the same block-comment + line-comment strip
    // pattern as the D90 invariants' stripTsComments helper (kept
    // inline here so the D101.M.5 block is self-contained).
    const uncommentedSource = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // General count: `from "@viberevert/installers"` matches every
    // static import shape (named, default, namespace, type). One `from`
    // clause per static import statement, so this count is regression-
    // proof against any second static import under any form -- and
    // avoids the cross-import spanning risk of a lazy
    // `import[\s\S]*?from` pattern (which could greedily expand past a
    // first import's own `from` to match a second import's
    // `from "@viberevert/installers"`).
    const fromMatches = uncommentedSource.match(/from\s*["']@viberevert\/installers["']/g);
    expect(
      fromMatches?.length ?? 0,
      "guard must have EXACTLY one static `from '@viberevert/installers'` import (D101.M.5)",
    ).toBe(1);

    // Named-import body check: must be the `import { ... } from "..."`
    // form and the body must be exactly `hasRepoIntegrationRecord`. The
    // `{[\s\S]*?}` capture is bounded by braces on a single import so
    // it cannot cross imports.
    const namedImports = [
      ...uncommentedSource.matchAll(
        /import\s*\{([\s\S]*?)\}\s*from\s*["']@viberevert\/installers["']/g,
      ),
    ];
    expect(namedImports.length, "guard must use the named-import form { X } (D101.M.5)").toBe(1);
    const body = namedImports[0]?.[1] ?? "";
    const names = body
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    expect(
      names,
      "guard must import EXACTLY hasRepoIntegrationRecord from @viberevert/installers (D101.M.5)",
    ).toEqual(["hasRepoIntegrationRecord"]);
    // No `X as Y` aliasing.
    expect(body).not.toMatch(/\bas\b/);
  });

  it("does NOT deep-import from @viberevert/installers in any form (D101.M.5)", () => {
    const source = readSource(GUARD_REL);
    const antipatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "static ESM deep import", pattern: /from\s+["']@viberevert\/installers\// },
      { name: "dynamic import deep", pattern: /import\s*\(\s*["']@viberevert\/installers\// },
      {
        name: "CJS require (bare or deep)",
        pattern: /require\s*\(\s*["']@viberevert\/installers/,
      },
      {
        name: "TS import-equals require",
        pattern: /import\s+\w+\s*=\s*require\s*\(\s*["']@viberevert\/installers/,
      },
    ];
    for (const { name, pattern } of antipatterns) {
      const offenders = findOffenders(source, pattern);
      expect(
        offenders,
        `guard must not use ${name} (D101.M.5). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });

  it("does NOT use dynamic import of @viberevert/installers (bare) (D101.M.5)", () => {
    const source = readSource(GUARD_REL);
    const pattern = /import\s*\(\s*["']@viberevert\/installers["']/;
    const offenders = findOffenders(source, pattern);
    expect(
      offenders,
      `guard must not use bare dynamic import of @viberevert/installers (D101.M.5). Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

describe("Architectural invariants -- D101.M.6 InstallCommand + UninstallCommand registration order", () => {
  // D101.M.6 (M G1b Step 6C lock): extends D98.M.10's registration
  // order convention. The install/uninstall commands sit as a pair
  // between the hook commands and MCPCommand, matching the D101.I
  // locked order:
  //
  //   RollbackCommand → HookInstallCommand → HookUninstallCommand
  //     → InstallCommand → UninstallCommand → MCPCommand
  //
  // The "IMMEDIATELY after" lock applies within the pair: nothing may
  // be registered between InstallCommand and UninstallCommand. Mirror
  // of D98.M.10's HookInstall/HookUninstall pair lock -- the two
  // integrations commands are registered as a pair (no other command
  // may be inserted between them).

  const INDEX_REL = "packages/cli/src/index.ts";

  it("D101.M.6: index.ts registration ORDER -- HookUninstall < Install < Uninstall < MCP AND Uninstall IMMEDIATELY after Install", () => {
    const source = readSource(INDEX_REL);

    const hookUninstallIdx = source.indexOf("cli.register(HookUninstallCommand);");
    const installIdx = source.indexOf("cli.register(InstallCommand);");
    const uninstallIdx = source.indexOf("cli.register(UninstallCommand);");
    const mcpIdx = source.indexOf("cli.register(MCPCommand);");

    expect(
      hookUninstallIdx,
      "HookUninstallCommand registration missing from index.ts (D101.M.6 anchor)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      installIdx,
      "InstallCommand registration missing from index.ts (D101.M.6)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      uninstallIdx,
      "UninstallCommand registration missing from index.ts (D101.M.6)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      mcpIdx,
      "MCPCommand registration missing from index.ts (D101.M.6)",
    ).toBeGreaterThanOrEqual(0);

    expect(
      hookUninstallIdx,
      "InstallCommand must be registered AFTER HookUninstallCommand in index.ts (D101.M.6 / D101.I)",
    ).toBeLessThan(installIdx);
    expect(
      installIdx,
      "UninstallCommand must be registered AFTER InstallCommand in index.ts (D101.M.6 / D101.I)",
    ).toBeLessThan(uninstallIdx);
    expect(
      uninstallIdx,
      "MCPCommand must be registered AFTER UninstallCommand in index.ts (D101.M.6 / D101.I)",
    ).toBeLessThan(mcpIdx);

    // "Immediately after" lock: between the InstallCommand register
    // line and the UninstallCommand register line, there must be NO
    // other cli.register(...) call. Mirrors D98.M.10's HookInstall/
    // HookUninstall pair convention.
    const installEnd = installIdx + "cli.register(InstallCommand);".length;
    const between = source.slice(installEnd, uninstallIdx);
    const interlopingRegisters = findOffenders(between, /\bcli\.register\s*\(/);
    expect(
      interlopingRegisters,
      `UninstallCommand must be registered IMMEDIATELY after InstallCommand with no other cli.register() between them (D101.M.6). Interloping registrations: ${JSON.stringify(interlopingRegisters)}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M RH -- release-targets inventory drift invariants
// ---------------------------------------------------------------------------
//
// scripts/release-targets.json is the single source of truth for the npm
// publish set (locked topo order) and the private-package set. Release-
// critical copies of that list exist in executable or copy-paste-executable
// surfaces that cannot read the JSON at run time (.github/workflows/
// release.yml is static YAML; docs/release-process.md's emergency-publish
// loops are copy-paste shell). These invariants fail the build when any of
// those copies drifts from the inventory.
//
// Calibration lock (M RH): strict, order-sensitive assertions ONLY for
// surfaces someone might execute (workflow arrays, smoke-test pack list,
// emergency-publish loops). Ordinary prose, sentence counts, and historical
// retrospective text are intentionally NOT tested.

describe("Architectural invariants -- M RH release-targets inventory drift", () => {
  interface ReleaseTargets {
    readonly schemaVersion: number;
    readonly publishTargets: readonly string[];
    readonly privatePackages: readonly string[];
  }

  const inventory = JSON.parse(readSource("scripts/release-targets.json")) as ReleaseTargets;

  // The unscoped CLI package lives in packages/cli; every scoped package
  // lives in packages/<name-without-scope>. This is the ONE irregular
  // name-to-directory mapping, kept here so the JSON stays derivation-free.
  function dirFor(name: string): string {
    if (name === "viberevert") return "packages/cli";
    return `packages/${name.replace("@viberevert/", "")}`;
  }

  // Packed tarball filename stem (no version): scoped packages become
  // viberevert-<suffix>; the unscoped CLI is bare viberevert.
  function tgzStemFor(name: string): string {
    if (name === "viberevert") return "viberevert";
    return `viberevert-${name.replace("@viberevert/", "")}`;
  }

  // The workspace root manifest lives at the repo root, not under packages/.
  function packageJsonPathFor(name: string): string {
    if (name === "viberevert-monorepo") return "package.json";
    return `${dirFor(name)}/package.json`;
  }

  // Assert a regex matched AND its first capture group exists, then return
  // the group. Keeps the executable-surface extractions honest under
  // noUncheckedIndexedAccess without non-null assertions.
  function requireGroup(m: RegExpMatchArray | null, label: string): string {
    expect(m, `${label} not found`).not.toBeNull();
    const group = (m as RegExpMatchArray)[1];
    expect(group, `${label}: capture group empty`).toBeDefined();
    return group as string;
  }

  it("inventory shape: exactly schemaVersion=1 + publishTargets + privatePackages, no dups, no overlap", () => {
    expect(Object.keys(inventory).sort()).toEqual([
      "privatePackages",
      "publishTargets",
      "schemaVersion",
    ]);
    expect(inventory.schemaVersion).toBe(1);
    expect(new Set(inventory.publishTargets).size).toBe(inventory.publishTargets.length);
    expect(new Set(inventory.privatePackages).size).toBe(inventory.privatePackages.length);
    const overlap = inventory.publishTargets.filter((p) => inventory.privatePackages.includes(p));
    expect(overlap).toEqual([]);
  });

  it("every publish target maps to an existing, correctly named, non-private package.json", () => {
    for (const name of inventory.publishTargets) {
      const pkg = JSON.parse(readSource(join(dirFor(name), "package.json")));
      expect(pkg.name, `${dirFor(name)}/package.json name`).toBe(name);
      expect(pkg.private, `${name} must not be private`).not.toBe(true);
    }
  });

  it("all publish-target versions are equal", () => {
    const versions = inventory.publishTargets.map(
      (name) => JSON.parse(readSource(join(dirFor(name), "package.json"))).version as string,
    );
    expect(
      new Set(versions).size,
      `distinct publish-target versions: ${[...new Set(versions)].join(", ")}`,
    ).toBe(1);
  });

  it("publishTargets order is dependency-safe for internal runtime dependencies", () => {
    const index = new Map(inventory.publishTargets.map((name, i) => [name, i]));

    for (const name of inventory.publishTargets) {
      const pkg = JSON.parse(readSource(join(dirFor(name), "package.json")));
      const deps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.optionalDependencies ?? {}),
      };

      for (const depName of Object.keys(deps)) {
        if (!index.has(depName)) continue;

        expect(
          index.get(depName),
          `${name} depends on ${depName}, so ${depName} must appear earlier in scripts/release-targets.json`,
        ).toBeLessThan(index.get(name) as number);
      }
    }
  });

  it("private set is exactly policies-basic + the workspace root, both private at 0.0.0", () => {
    expect([...inventory.privatePackages].sort()).toEqual([
      "@viberevert/policies-basic",
      "viberevert-monorepo",
    ]);
    const pb = JSON.parse(readSource("packages/policies-basic/package.json"));
    expect(pb.name).toBe("@viberevert/policies-basic");
    expect(pb.private).toBe(true);
    expect(pb.version).toBe("0.0.0");
    const root = JSON.parse(readSource("package.json"));
    expect(root.name).toBe("viberevert-monorepo");
    expect(root.private).toBe(true);
    expect(root.version).toBe("0.0.0");
  });

  it("every directory under packages/ is accounted for as publish target or private", () => {
    const accounted = new Set<string>([
      ...inventory.publishTargets.map(dirFor),
      ...inventory.privatePackages.filter((n) => n !== "viberevert-monorepo").map(dirFor),
    ]);
    for (const entry of readdirSync(join(REPO_ROOT, "packages"))) {
      let hasPkg = true;
      try {
        statSync(join(REPO_ROOT, "packages", entry, "package.json"));
      } catch {
        hasPkg = false;
      }
      if (!hasPkg) continue;
      expect(
        accounted.has(`packages/${entry}`),
        `packages/${entry} is neither a publish target nor a known private package -- add it to scripts/release-targets.json`,
      ).toBe(true);
    }
  });

  // -- executable surface: .github/workflows/release.yml --------------------

  const releaseYml = readSource(".github/workflows/release.yml");

  function extractArray(re: RegExp, label: string): string[] {
    const body = requireGroup(releaseYml.match(re), `release.yml: ${label} array`);
    return (body.match(/["'][^"']+["']/g) ?? []).map((s) => s.slice(1, -1));
  }

  it("release.yml publishTargets (validate step) matches inventory package.json paths in topo order", () => {
    expect(extractArray(/const publishTargets = \[([\s\S]*?)\];/, "publishTargets")).toEqual(
      inventory.publishTargets.map((n) => `${dirFor(n)}/package.json`),
    );
  });

  it("release.yml privateStubs matches inventory-derived private manifest paths", () => {
    expect(extractArray(/const privateStubs = \[([\s\S]*?)\];/, "privateStubs")).toEqual(
      inventory.privatePackages.map(packageJsonPathFor),
    );
  });

  it("release.yml PUBLISH_DIRS + EXPECTED_NAMES + PUBLISH_TARGETS match inventory in topo order", () => {
    expect(extractArray(/PUBLISH_DIRS=\(([\s\S]*?)\)/, "PUBLISH_DIRS")).toEqual(
      inventory.publishTargets.map(dirFor),
    );
    expect(extractArray(/EXPECTED_NAMES=\(([\s\S]*?)\)/, "EXPECTED_NAMES")).toEqual([
      ...inventory.publishTargets,
    ]);
    expect(extractArray(/PUBLISH_TARGETS=\(([\s\S]*?)\)/, "PUBLISH_TARGETS")).toEqual([
      ...inventory.publishTargets,
    ]);
  });

  it("release.yml PUBLISH_TGZ matches inventory tarball names in topo order", () => {
    expect(extractArray(/PUBLISH_TGZ=\(([\s\S]*?)\)/, "PUBLISH_TGZ")).toEqual(
      inventory.publishTargets.map((n) => `${tgzStemFor(n)}-\${VERSION}.tgz`),
    );
  });

  // -- executable surface: scripts/smoke-test.ps1 ---------------------------

  it("smoke-test.ps1 pack --filter list matches inventory names in topo order", () => {
    const ps1 = readSource("scripts/smoke-test.ps1");
    const body = requireGroup(
      ps1.match(/& pnpm ((?:--filter '[^']+' `\r?\n\s*)+)pack --pack-destination/),
      "smoke-test.ps1: pack --filter block",
    );
    const filters = [...body.matchAll(/--filter '([^']+)'/g)].map((x) => x[1] ?? "");
    expect(filters).toEqual([...inventory.publishTargets]);
    expect(new Set(filters).size).toBe(filters.length);
  });

  // -- copy-paste-executable surface: release-process.md emergency loops ----

  // The Manual emergency publish section is an h2; slice from its heading to
  // the next h2 so the loop regexes cannot match unrelated future loops
  // elsewhere in the document.
  function manualEmergencySection(): string {
    const doc = readSource("docs/release-process.md");
    const start = doc.indexOf("## Manual emergency publish");
    expect(
      start,
      "docs/release-process.md: Manual emergency publish section not found",
    ).toBeGreaterThanOrEqual(0);
    const rest = doc.slice(start);
    const next = rest.slice(1).search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  it("release-process.md emergency dir loop matches inventory dirs in topo order", () => {
    const body = requireGroup(
      manualEmergencySection().match(/for dir in ((?:packages\/[a-z-]+ ?)+); do/),
      "release-process.md: emergency dir loop",
    );
    expect(body.trim().split(/\s+/)).toEqual(inventory.publishTargets.map(dirFor));
  });

  it("release-process.md emergency tgz loop matches inventory tarball stems in topo order", () => {
    const body = requireGroup(
      manualEmergencySection().match(/for tgz in ((?:viberevert[a-z-]* ?)+); do/),
      "release-process.md: emergency tgz loop",
    );
    expect(body.trim().split(/\s+/)).toEqual(inventory.publishTargets.map(tgzStemFor));
  });

  // -- package surface: build info must never enter dist/ -------------------

  it("package build info files stay outside dist so they cannot enter published tarballs", () => {
    for (const entry of readdirSync(join(REPO_ROOT, "packages"))) {
      const tsconfigPath = join("packages", entry, "tsconfig.build.json");

      let raw: string;
      try {
        raw = readSource(tsconfigPath);
      } catch {
        continue;
      }

      const config = JSON.parse(raw) as {
        compilerOptions?: {
          tsBuildInfoFile?: string;
        };
      };

      const value = config.compilerOptions?.tsBuildInfoFile;
      if (!value) continue;

      const normalized = value.replaceAll("\\", "/");
      expect(
        normalized.startsWith("./dist/") || normalized.startsWith("dist/"),
        `${tsconfigPath} must not write tsBuildInfoFile under dist/`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// M G2 (D102) -- `viberevert run` wrapper invariants
// =============================================================================
//
// D102.M.1 lives above as an amendment to the cli-commands child_process
// ban (doctor.ts + run.ts carve-outs). This block owns the run-specific
// source + registration locks:
//
//   - D102.M.2 -- index.ts registration ORDER: RunCommand registers
//     STRICTLY AFTER StartCommand and STRICTLY BEFORE CheckCommand,
//     with RunCommand IMMEDIATELY after StartCommand (no other
//     cli.register() between them). Workflow grouping: start -> run ->
//     check. Mirrors D98.M.10 / D101.M.6's pair-lock style.
//   - D102.M.3 -- run.ts spawn shape: stdio "inherit" + shell false,
//     and no PTY implementation references (PTY bridging is G3 scope).
//   - D102.M.4 -- core's appendCommandsLogEntry is the SINGLE
//     commands.log writer: no other src file across ALL packages may
//     import appendFile from node:fs/promises, and session.ts has
//     exactly ONE appendFile call site (the JSONL append; startSession
//     creates the empty file through the atomic-write path, not append).
//   - D102.M.5 -- run.ts never imports check/report machinery,
//     permanently enforcing the no-auto-check contract (D102.G)
//     against scope creep.

describe("Architectural invariants -- M G2 viberevert run wrapper (D102.M)", () => {
  const RUN_COMMAND_REL = "packages/cli-commands/src/commands/run.ts";
  const CLI_INDEX_REL = "packages/cli/src/index.ts";

  it("D102.M.2: index.ts registration ORDER -- StartCommand < RunCommand < CheckCommand AND RunCommand IMMEDIATELY after StartCommand", () => {
    // D102.I workflow grouping: run sits between start and check
    // (start a session -> run a guarded command inside it -> check the
    // result). The "immediately after" lock pins RunCommand directly
    // behind StartCommand so a future maintainer cannot slip an
    // unrelated command into the start/run pairing. Mirrors D98.M.10's
    // HookInstall/HookUninstall pair convention.
    //
    // Defensive: assert each anchor exists before comparing indices --
    // indexOf returning -1 would silently satisfy `-1 < n` when `n`
    // is also non-negative.
    const source = readSource(CLI_INDEX_REL);

    const startIdx = source.indexOf("cli.register(StartCommand);");
    const runIdx = source.indexOf("cli.register(RunCommand);");
    const checkIdx = source.indexOf("cli.register(CheckCommand);");

    expect(
      startIdx,
      "StartCommand registration missing from index.ts (D102.M.2 anchor)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      runIdx,
      "RunCommand registration missing from index.ts (D102.M.2)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      checkIdx,
      "CheckCommand registration missing from index.ts (D102.M.2 anchor)",
    ).toBeGreaterThanOrEqual(0);

    expect(
      startIdx,
      "RunCommand must be registered AFTER StartCommand in index.ts (D102.M.2 -- start -> run -> check workflow order)",
    ).toBeLessThan(runIdx);
    expect(
      runIdx,
      "RunCommand must be registered BEFORE CheckCommand in index.ts (D102.M.2 -- start -> run -> check workflow order)",
    ).toBeLessThan(checkIdx);

    // "Immediately after" lock: between the StartCommand register line
    // and the RunCommand register line, there must be NO other
    // cli.register(...) call.
    const startEnd = startIdx + "cli.register(StartCommand);".length;
    const between = source.slice(startEnd, runIdx);
    const interlopingRegisters = findOffenders(between, /\bcli\.register\s*\(/);
    expect(
      interlopingRegisters,
      `RunCommand must be registered IMMEDIATELY after StartCommand with no other cli.register() between them (D102.M.2). Interloping registrations: ${JSON.stringify(interlopingRegisters)}`,
    ).toEqual([]);
  });

  it("D102.M.3: run.ts spawns pipe-less and shell-less (stdio inherit + shell false) and never references a PTY implementation", () => {
    const stripped = stripTsComments(readSource(RUN_COMMAND_REL));
    expect(
      stripped.includes('stdio: "inherit"'),
      `${RUN_COMMAND_REL} must spawn with stdio: "inherit" (D102.A pipe-less contract).`,
    ).toBe(true);
    expect(
      stripped.includes("shell: false"),
      `${RUN_COMMAND_REL} must spawn with shell: false (D102.A no-shell-interpretation lock).`,
    ).toBe(true);
    for (const banned of ["node-pty", "openpty", "conpty"]) {
      expect(
        stripped.includes(banned),
        `${RUN_COMMAND_REL} must not reference "${banned}" -- PTY bridging is G3 scope (D102.M.3).`,
      ).toBe(false);
    }
  });

  it("D102.M.4: appendFile from node:fs/promises is imported ONLY by core/src/session.ts (single commands.log writer), which has exactly ONE appendFile call site", () => {
    // The bare `appendFile` import is the append-mode write primitive;
    // commands.log is the only append-mode file in the system. MCP's
    // audit writer uses the FileHandle .appendFile METHOD on its own
    // audit log -- a different primitive, separately locked by D99.M.7
    // -- and deliberately does not trip this import-form check.
    const allowedRel = "packages/core/src/session.ts";
    const namedAppendFileImport =
      /import\s*(?:type\s*)?\{[^}]*\bappendFile\b[^}]*\}\s*from\s*["']node:fs\/promises["']/;
    for (const pkg of readdirSync(join(REPO_ROOT, "packages"))) {
      let files: string[];
      try {
        files = findTsFiles(join(REPO_ROOT, "packages", pkg, "src"));
      } catch {
        continue; // package without a src/ directory
      }
      for (const file of files) {
        const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
        if (rel === allowedRel) continue;
        const stripped = stripTsComments(readFileSync(file, "utf8"));
        expect(
          namedAppendFileImport.test(stripped),
          `${rel} must not import appendFile from node:fs/promises -- core's appendCommandsLogEntry is the single commands.log writer (D102.M.4).`,
        ).toBe(false);
      }
    }
    const sessionStripped = stripTsComments(readSource(allowedRel));
    const callSites = (sessionStripped.match(/\bappendFile\s*\(/g) ?? []).length;
    expect(
      callSites,
      `${allowedRel} must contain exactly ONE appendFile call site (the appendCommandsLogEntry JSONL append). Found ${callSites}.`,
    ).toBe(1);
  });

  it("D102.M.5: run.ts imports no check/report machinery (no-auto-check contract, D102.G)", () => {
    // run's summary HINTS at `viberevert check` in a string literal
    // (which survives comment-stripping) -- none of the banned tokens
    // below can appear in that legitimate copy. Tokens cover the
    // command classes, the orchestration/resolution modules, and the
    // checks/reporters workspace packages.
    const stripped = stripTsComments(readSource(RUN_COMMAND_REL));
    const banned = [
      "CheckCommand",
      "ReportCommand",
      "runCheck",
      "check-session",
      "check-orchestration",
      "check-since-resolution",
      "report-paths",
      "@viberevert/checks",
      "@viberevert/reporters",
    ];
    for (const token of banned) {
      expect(
        stripped.includes(token),
        `${RUN_COMMAND_REL} must not reference "${token}" -- run never auto-checks (D102.G / D102.M.5).`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// Architectural invariants -- M G3 viberevert shell guarded REPL (D103.M)
// =============================================================================
//
// D103.M.1 lives above as an amendment to the cli-commands child_process
// ban (doctor.ts + run.ts + shell.ts carve-outs). This block owns the
// shell-specific source locks:
//
//   - D103.M.2 -- index.ts registration ORDER: ShellCommand registers
//     STRICTLY AFTER RunCommand and STRICTLY BEFORE CheckCommand, with
//     ShellCommand IMMEDIATELY after RunCommand (no other cli.register()
//     between them). Workflow grouping: run -> shell -> check. Mirrors
//     D102.M.2's Start/Run pair-lock style. D102.M.2 is unaffected -- it
//     locks Start -> Run adjacency and Run < Check (non-adjacent), so
//     inserting Shell between Run and Check keeps it green.
//   - D103.M.3 -- shell.ts spawn shape: stdio "inherit" + shell false,
//     and no terminal-bridge implementation references (case-insensitive
//     node-pty/openpty/conpty; the transparent terminal bridge is
//     deferred to G4).
//   - D103.M.4 -- shell.ts never imports check/report machinery,
//     permanently enforcing the no-auto-check contract against scope
//     creep (mirrors D102.M.5 for run).
//   - D103.M.5 -- shell.ts does not import appendFile from
//     node:fs/promises: core's appendCommandsLogEntry stays the single
//     commands.log writer (defense-in-depth with D102.M.4, which already
//     bans that import workspace-wide).
//   - D103.M.6 -- node-pty scoped to cli-commands optionalDependencies only
//     (AMENDED for M G4 / D104.D): node-pty may appear ONLY as an
//     optionalDependencies entry of packages/cli-commands/package.json and
//     in the resulting pnpm-lock.yaml -- never in the root manifest, any
//     other package manifest, or a regular dependency section.
//   - D103.M.7 -- shell.ts uses exactly one readline interface and the
//     async iterator line source; no rl.question, AbortController,
//     readline/promises, line-event queue, or raw process stdin/stdout.
//     Locks the Node-24 buffered-line fix so it cannot be silently undone.
//   - D103.M.8 -- shell.ts writes commands.log through core's
//     appendCommandsLogEntry (positive pair to D103.M.5's appendFile ban).

describe("Architectural invariants -- M G3 viberevert shell guarded REPL (D103.M)", () => {
  const SHELL_COMMAND_REL = "packages/cli-commands/src/commands/shell.ts";
  const CLI_INDEX_REL = "packages/cli/src/index.ts";

  it("D103.M.2: index.ts registration ORDER -- RunCommand < ShellCommand < CheckCommand AND ShellCommand IMMEDIATELY after RunCommand", () => {
    // Workflow grouping: shell sits between run and check (run a guarded
    // command, or open a guarded shell of them, then check the result).
    // The "immediately after" lock pins ShellCommand directly behind
    // RunCommand so a future maintainer cannot slip an unrelated command
    // into the run/shell pairing. Mirrors D102.M.2's Start/Run pair
    // convention. D102.M.2 is unaffected: it locks Start -> Run adjacency
    // and Run < Check (non-adjacent), both still true with Shell inserted.
    //
    // Defensive: assert each anchor exists before comparing indices --
    // indexOf returning -1 would silently satisfy `-1 < n`.
    const source = readSource(CLI_INDEX_REL);

    const runIdx = source.indexOf("cli.register(RunCommand);");
    const shellIdx = source.indexOf("cli.register(ShellCommand);");
    const checkIdx = source.indexOf("cli.register(CheckCommand);");

    expect(
      runIdx,
      "RunCommand registration missing from index.ts (D103.M.2 anchor)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      shellIdx,
      "ShellCommand registration missing from index.ts (D103.M.2)",
    ).toBeGreaterThanOrEqual(0);
    expect(
      checkIdx,
      "CheckCommand registration missing from index.ts (D103.M.2 anchor)",
    ).toBeGreaterThanOrEqual(0);

    expect(
      runIdx,
      "ShellCommand must be registered AFTER RunCommand in index.ts (D103.M.2 -- run -> shell -> check workflow order)",
    ).toBeLessThan(shellIdx);
    expect(
      shellIdx,
      "ShellCommand must be registered BEFORE CheckCommand in index.ts (D103.M.2 -- run -> shell -> check workflow order)",
    ).toBeLessThan(checkIdx);

    // "Immediately after" lock: between the RunCommand register line and
    // the ShellCommand register line, there must be NO other
    // cli.register(...) call.
    const runEnd = runIdx + "cli.register(RunCommand);".length;
    const between = source.slice(runEnd, shellIdx);
    const interlopingRegisters = findOffenders(between, /\bcli\.register\s*\(/);
    expect(
      interlopingRegisters,
      `ShellCommand must be registered IMMEDIATELY after RunCommand with no other cli.register() between them (D103.M.2). Interloping registrations: ${JSON.stringify(interlopingRegisters)}`,
    ).toEqual([]);
  });

  it("D103.M.3: shell.ts spawns pipe-less and shell-less (stdio inherit + shell false) and never references a terminal-bridge implementation", () => {
    const stripped = stripTsComments(readSource(SHELL_COMMAND_REL));
    expect(
      stripped.includes('stdio: "inherit"'),
      `${SHELL_COMMAND_REL} must spawn with stdio: "inherit" (D103.A pipe-less contract).`,
    ).toBe(true);
    expect(
      stripped.includes("shell: false"),
      `${SHELL_COMMAND_REL} must spawn with shell: false (D103.A no-shell-interpretation lock).`,
    ).toBe(true);
    // Case-insensitive so `ConPTY` / `OpenPTY` cannot slip through.
    const lowered = stripped.toLowerCase();
    for (const banned of ["node-pty", "openpty", "conpty"]) {
      expect(
        lowered.includes(banned),
        `${SHELL_COMMAND_REL} must not reference "${banned}" -- the transparent terminal bridge is deferred to G4 (D103.M.3).`,
      ).toBe(false);
    }
  });

  it("D103.M.4: shell.ts imports no check/report machinery (no-auto-check contract)", () => {
    // shell's summary HINTS at `viberevert check` in a string literal
    // (which survives comment-stripping) -- none of the banned tokens
    // below can appear in that legitimate copy. Same token set as
    // D102.M.5 for run.
    const stripped = stripTsComments(readSource(SHELL_COMMAND_REL));
    const banned = [
      "CheckCommand",
      "ReportCommand",
      "runCheck",
      "check-session",
      "check-orchestration",
      "check-since-resolution",
      "report-paths",
      "@viberevert/checks",
      "@viberevert/reporters",
    ];
    for (const token of banned) {
      expect(
        stripped.includes(token),
        `${SHELL_COMMAND_REL} must not reference "${token}" -- shell never auto-checks (D103.M.4).`,
      ).toBe(false);
    }
  });

  it("D103.M.5: shell.ts does not import appendFile from node:fs/promises (core's appendCommandsLogEntry is the single commands.log writer)", () => {
    // Defense-in-depth with D102.M.4 (which bans the import across ALL
    // packages): shell appends commands.log entries ONLY through core's
    // appendCommandsLogEntry, never the raw append primitive.
    const stripped = stripTsComments(readSource(SHELL_COMMAND_REL));
    const namedAppendFileImport =
      /import\s*(?:type\s*)?\{[^}]*\bappendFile\b[^}]*\}\s*from\s*["']node:fs\/promises["']/;
    expect(
      namedAppendFileImport.test(stripped),
      `${SHELL_COMMAND_REL} must not import appendFile from node:fs/promises (D103.M.5).`,
    ).toBe(false);
  });

  it("D103.M.6: node-pty is scoped to cli-commands optionalDependencies -- absent from every other manifest (AMENDED for G4)", () => {
    // AMENDED for M G4 (D104.D): the transparent PTY bridge (`shell --pty`)
    // introduces node-pty as an OPTIONAL dependency of @viberevert/cli-commands.
    // node-pty may appear ONLY there (under optionalDependencies) and in the
    // resulting pnpm-lock.yaml -- NOT in the root manifest, any other package
    // manifest, or a regular dependency section of cli-commands.
    const OWNER_REL = "packages/cli-commands/package.json";

    // 1. The owner lists node-pty under optionalDependencies, and nowhere else.
    const ownerPkg = JSON.parse(readSource(OWNER_REL));
    expect(
      ownerPkg.optionalDependencies?.["node-pty"],
      `${OWNER_REL} must list node-pty under optionalDependencies (D103.M.6 scoped allow / D104.D).`,
    ).toBeDefined();
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      expect(
        ownerPkg[section]?.["node-pty"],
        `${OWNER_REL} must NOT list node-pty under ${section} -- it is optional-only (D103.M.6 / D104.D).`,
      ).toBeUndefined();
    }

    // 2. No OTHER manifest (root or any workspace package) mentions node-pty.
    //    pnpm-lock.yaml is intentionally excluded -- it MUST carry the resolved
    //    optional entry.
    const otherManifestRels = ["package.json"];
    for (const pkg of readdirSync(join(REPO_ROOT, "packages"))) {
      const rel = `packages/${pkg}/package.json`;
      if (rel !== OWNER_REL) otherManifestRels.push(rel);
    }
    for (const rel of otherManifestRels) {
      let raw: string;
      try {
        raw = readFileSync(join(REPO_ROOT, rel), "utf8");
      } catch {
        continue; // file absent (e.g. a directory entry without package.json)
      }
      expect(
        raw.includes("node-pty"),
        `${rel} must not contain "node-pty" -- it is scoped to ${OWNER_REL} optionalDependencies only (D103.M.6 / D104.D).`,
      ).toBe(false);
    }
  });

  it("D103.M.7: shell.ts uses one readline interface plus async iterator, never rl.question/AbortController/nested readline/line-event queue/raw process stdio", () => {
    const stripped = stripTsComments(readSource(SHELL_COMMAND_REL));

    const createInterfaceCalls = stripped.match(/\bcreateInterface\s*\(/g) ?? [];
    expect(
      createInterfaceCalls,
      `${SHELL_COMMAND_REL} must create exactly one readline interface (D103.C one-interface lock).`,
    ).toHaveLength(1);

    expect(
      stripped.includes("[Symbol.asyncIterator]()"),
      `${SHELL_COMMAND_REL} must consume command/control input through readline's async iterator (D103.C Node-24 buffered-line fix).`,
    ).toBe(true);

    // No line-event queue (a second line source) via on/once("line") in
    // either quote style -- the async iterator is the single line source.
    const lineEvent = /\.(?:on|once)\s*\(\s*["']line["']/;
    expect(
      lineEvent.test(stripped),
      `${SHELL_COMMAND_REL} must not consume readline "line" events -- the async iterator is the single line source (D103.C).`,
    ).toBe(false);

    const banned = [
      "question(",
      "AbortController",
      "readline/promises",
      "process.stdin",
      "process.stdout",
      "rl.pause(",
      "rl.resume(",
    ];
    for (const token of banned) {
      expect(
        stripped.includes(token),
        `${SHELL_COMMAND_REL} must not reference "${token}" -- shell input/control must use one readline async iterator; do not pause/resume the interface around children because that closes the iterator on Node 24 (D103.C).`,
      ).toBe(false);
    }
  });

  it("D103.M.8: shell.ts writes commands.log only through appendCommandsLogEntry", () => {
    // Positive pair to D103.M.5's appendFile ban: the intended writer
    // must be present, so the ban can't be satisfied by simply dropping
    // the commands.log append entirely.
    const stripped = stripTsComments(readSource(SHELL_COMMAND_REL));
    expect(
      stripped.includes("appendCommandsLogEntry"),
      `${SHELL_COMMAND_REL} must append commands.log through core's appendCommandsLogEntry (D103.M.8).`,
    ).toBe(true);
  });
});

// =============================================================================
// Architectural invariants -- M G4 viberevert shell --pty PTY bridge (D104.M)
// =============================================================================
//
// Step 2 subset (the native-dependency seam). Steps 3+ add D104.M.3/M.4/M.5.
//
//   - D104.M.1 -- node-pty is referenced ONLY by pty-loader.ts within
//     cli-commands/src; no other src file (shell.ts, the future
//     shell-pty.ts, ...) imports or mentions it -- the native-dep seam is
//     one tiny file.
//   - D104.M.2 -- pty-loader.ts imports node-pty DYNAMICALLY
//     (`import("node-pty")`) only; never a static `import ... from
//     "node-pty"` / re-export, a side-effect `import "node-pty"`, nor
//     `require("node-pty")`, so a missing optional dep can never crash
//     module load / the whole CLI.
//   - D104.M.6 -- node-pty build scripts are never APPROVED: no
//     `pnpm.onlyBuiltDependencies` (root package.json) and no
//     `onlyBuiltDependencies` in pnpm-workspace.yaml. node-pty loads from
//     bundled prebuilds with build scripts ignored; the "Ignored build
//     scripts" install warning is expected, not a failure.

describe("Architectural invariants -- M G4 viberevert shell --pty PTY bridge (D104.M)", () => {
  const PTY_LOADER_REL = "packages/cli-commands/src/commands/pty-loader.ts";
  const CLI_COMMANDS_SRC = "packages/cli-commands/src";

  it("D104.M.1: node-pty is referenced ONLY by pty-loader.ts within cli-commands/src", () => {
    const srcAbs = join(REPO_ROOT, CLI_COMMANDS_SRC);
    const files = findTsFiles(srcAbs);
    expect(
      files.length,
      `Self-check: expected at least one .ts file under ${CLI_COMMANDS_SRC}.`,
    ).toBeGreaterThan(0);

    let ownerSeen = false;
    for (const abs of files) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      const stripped = stripTsComments(readFileSync(abs, "utf8")).toLowerCase();
      const mentionsNodePty = stripped.includes("node-pty");
      if (rel === PTY_LOADER_REL) {
        ownerSeen = true;
        expect(
          mentionsNodePty,
          `${PTY_LOADER_REL} is the sole node-pty seam and must reference it (D104.M.1).`,
        ).toBe(true);
        continue;
      }
      expect(
        mentionsNodePty,
        `${rel} must NOT reference node-pty -- the loader (${PTY_LOADER_REL}) is the only seam (D104.M.1).`,
      ).toBe(false);
    }
    expect(ownerSeen, `Self-check: ${PTY_LOADER_REL} must exist and be scanned (D104.M.1).`).toBe(
      true,
    );
  });

  it("D104.M.2: pty-loader.ts imports node-pty DYNAMICALLY only -- no static import/require", () => {
    const stripped = stripTsComments(readSource(PTY_LOADER_REL));

    expect(
      /\bimport\s*\(\s*["']node-pty["']\s*\)/.test(stripped),
      `${PTY_LOADER_REL} must dynamic-import("node-pty") (D104.M.2).`,
    ).toBe(true);

    const staticFromNodePty = /\bfrom\s*["']node-pty["']/;
    expect(
      staticFromNodePty.test(stripped),
      `${PTY_LOADER_REL} must NOT statically import/re-export from "node-pty" -- a missing optional dep would crash module load (D104.M.2).`,
    ).toBe(false);

    const sideEffectImport = /\bimport\s+["']node-pty["']/;
    expect(
      sideEffectImport.test(stripped),
      `${PTY_LOADER_REL} must NOT side-effect import "node-pty" -- a missing optional dep would crash module load (D104.M.2).`,
    ).toBe(false);

    const requireForm = /\brequire\s*\(\s*["']node-pty["']\s*\)/;
    expect(
      requireForm.test(stripped),
      `${PTY_LOADER_REL} must NOT require("node-pty") (D104.M.2).`,
    ).toBe(false);
  });

  it("D104.M.6: node-pty build scripts are never approved -- no onlyBuiltDependencies / approve-builds", () => {
    // Decided B (2026-07-08): node-pty ships bundled prebuilds and its build
    // scripts stay IGNORED. The repo must not approve them via pnpm's
    // onlyBuiltDependencies (package.json `pnpm` field OR pnpm-workspace.yaml)
    // or `pnpm approve-builds`. The "Ignored build scripts" install warning is
    // expected and acceptable; approving a build script is the regression.
    const rootPkg = JSON.parse(readSource("package.json"));
    expect(
      rootPkg.pnpm?.onlyBuiltDependencies,
      "Root package.json must NOT set pnpm.onlyBuiltDependencies -- node-pty build scripts stay unapproved (D104.M.6).",
    ).toBeUndefined();

    // pnpm 10 also reads build-script policy from pnpm-workspace.yaml; guard
    // that location too (raw substring is enough -- no YAML parser needed).
    let workspaceYaml = "";
    try {
      workspaceYaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    } catch {
      workspaceYaml = "";
    }
    expect(
      workspaceYaml.includes("onlyBuiltDependencies"),
      "pnpm-workspace.yaml must NOT set onlyBuiltDependencies -- node-pty build scripts stay unapproved (D104.M.6).",
    ).toBe(false);
  });
});

describe("Architectural invariant -- M G4 shell resolver purity (D104.N)", () => {
  const RESOLVER_REL = "packages/cli-commands/src/commands/shell-resolver.ts";

  it("D104.N: shell-resolver.ts is pure -- no node-pty, child_process, fs, process.*, or spawning", () => {
    const stripped = stripTsComments(readSource(RESOLVER_REL));

    // No native-dep import (also covered globally by D104.M.1; reasserted here).
    expect(
      stripped.includes("node-pty"),
      `${RESOLVER_REL} must not reference node-pty -- the resolver is pure (D104.N).`,
    ).toBe(false);

    // No process-spawning or filesystem imports.
    const childProcessImport = /["'](?:node:)?child_process["']/;
    expect(
      childProcessImport.test(stripped),
      `${RESOLVER_REL} must not import child_process -- the resolver never spawns (D104.N).`,
    ).toBe(false);
    const fsImport = /["'](?:node:)?fs(?:\/promises)?["']/;
    expect(
      fsImport.test(stripped),
      `${RESOLVER_REL} must not import fs -- the resolver does no filesystem access (D104.N).`,
    ).toBe(false);

    // No ambient host reads of ANY process.* -- platform/env arrive injected.
    const ambientProcessRead = /\bprocess\./;
    expect(
      ambientProcessRead.test(stripped),
      `${RESOLVER_REL} must not read process.* -- host facts are injected (D104.N).`,
    ).toBe(false);

    // No process spawning of any form.
    const spawnLike = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/;
    expect(
      spawnLike.test(stripped),
      `${RESOLVER_REL} must not spawn a process -- resolution is pure decision logic (D104.N).`,
    ).toBe(false);
  });
});

describe("Architectural invariant -- M G4 executable probe never spawns", () => {
  const PROBE_REL = "packages/cli-commands/src/commands/executable-probe.ts";

  it("executable-probe.ts resolves via PATH only -- no child_process / spawn / which / where", () => {
    const stripped = stripTsComments(readSource(PROBE_REL));

    const childProcessImport = /["'](?:node:)?child_process["']/;
    expect(
      childProcessImport.test(stripped),
      `${PROBE_REL} must not import child_process -- the probe never spawns (M G4 Step 3b).`,
    ).toBe(false);

    const spawnLike = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/;
    expect(
      spawnLike.test(stripped),
      `${PROBE_REL} must not spawn a process -- availability is a PATH scan, not a child process (M G4 Step 3b).`,
    ).toBe(false);
  });
});

describe("Architectural invariants -- M G4 PTY engine boundaries (shell-pty.ts)", () => {
  const SHELL_PTY_REL = "packages/cli-commands/src/commands/shell-pty.ts";
  const SHELL_REL = "packages/cli-commands/src/commands/shell.ts";

  it("shell.ts does not import or reference shell-pty.ts (engine unwired in 3c)", () => {
    const stripped = stripTsComments(readSource(SHELL_REL));
    expect(
      stripped.includes("shell-pty"),
      `${SHELL_REL} must not reference shell-pty.ts -- the PTY engine stays unwired until interception lands (M G4 Step 3c).`,
    ).toBe(false);
  });

  it("shell.ts has no --pty flag yet (no public PTY path before interception)", () => {
    const stripped = stripTsComments(readSource(SHELL_REL));
    expect(
      stripped.includes("--pty"),
      `${SHELL_REL} must not declare a --pty flag yet -- public --pty (refusing) lands in Step 3d/4, not 3c (M G4 Step 3c).`,
    ).toBe(false);
  });

  it("shell-pty.ts references node-pty only via pty-loader, never directly", () => {
    const stripped = stripTsComments(readSource(SHELL_PTY_REL));
    expect(
      stripped.includes("node-pty"),
      `${SHELL_PTY_REL} must not reference node-pty directly -- it may reach node-pty ONLY via pty-loader's loadPtyModule (D104.M.1 / M G4 Step 3c).`,
    ).toBe(false);
  });

  it("shell-pty.ts writes no process std stream / exit / console (routes via this.context, D104.M.4)", () => {
    const stripped = stripTsComments(readSource(SHELL_PTY_REL));
    for (const token of [
      "process.stdout",
      "process.stderr",
      "process.stdin",
      "process.exit",
      "console.",
    ]) {
      expect(
        stripped.includes(token),
        `${SHELL_PTY_REL} must not use "${token}" -- the engine routes all I/O through this.context (D104.M.4 / M G4 Step 3c). process.platform/process.env reads are allowed.`,
      ).toBe(false);
    }
  });

  it("shell-pty.ts has no env-flag escape hatch to enable the engine", () => {
    const stripped = stripTsComments(readSource(SHELL_PTY_REL));
    // No env var that would toggle/bypass the engine's gating (e.g. an
    // ENABLE_PTY / ALLOW_UNGUARDED_PTY style flag). The engine is reachable only
    // via a real code dispatch, never a runtime env toggle. (Belt-and-suspenders
    // with the two shell.ts invariants above, which already make it unreachable.)
    const enablePtyFlag =
      /(?:ENABLE|ALLOW|FORCE|BYPASS)[A-Z0-9_]*PTY|PTY[A-Z0-9_]*(?:ENABLE|ALLOW)/i;
    expect(
      enablePtyFlag.test(stripped),
      `${SHELL_PTY_REL} must have no env-flag escape hatch to enable the PTY engine (M G4 Step 3c).`,
    ).toBe(false);
  });
});
