// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Architectural-invariants tests.
//
// Grep-based tests that enforce locked architectural invariants — they
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
// M B plan's literal specification — and pragmatic, since cli is the
// orchestration layer that depends on all the others, so making cli's
// test suite responsible for verifying workspace-wide invariants is
// the right place for this kind of cross-cutting check.
//
// Comment-line filtering: each invariant uses the `findOffenders`
// helper to skip line-comments before regex matching. Reason: file-
// header docs in our sources LITERALLY mention the antipatterns to
// document them (e.g., restore.ts says `// NOT Readable.from(buf)`),
// and a naive grep would flag those as violations. Block comments
// without a leading `*` per line are not used in our source files, so
// the simple filter is sufficient.
//
// Adding a new invariant: add a new `it()` block, read the relevant
// file(s), grep for the antipattern via `findOffenders`, assert empty.
// Always cite the plan/decision lock that motivates the invariant.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
 * 1-indexed line numbers. Skips lines whose trimmed start is `//` (a
 * line-comment) so file-header docs that mention an antipattern by
 * literal text don't trigger false positives.
 */
function findOffenders(source: string, pattern: RegExp): Offender[] {
  return source
    .split("\n")
    .map((line, idx) => ({ line, lineNumber: idx + 1 }))
    .filter(({ line }) => !line.trim().startsWith("//") && pattern.test(line))
    .map(({ line, lineNumber }) => ({ lineNumber, content: line.trim() }));
}

describe("Architectural invariants — git invocation single-owner (D17c)", () => {
  // The git binary may only be invoked from @viberevert/git. Other
  // packages (including the CLI) reach for git via @viberevert/git's
  // public helpers (probeGitVersion, getStatusPorcelainText, etc.).
  // doctor.ts is a NARROW carve-out: it is allowed to spawn non-git
  // diagnostic binaries (pnpm), but MUST NOT spawn git directly.

  it("doctor.ts does NOT pass the literal \"git\" to spawn family functions or to its local probeVersion helper", () => {
    // The git probe in doctor.ts must go through @viberevert/git's
    // probeGitVersion() helper. This grep catches accidental regressions
    // where someone reintroduces a direct spawn of "git" from doctor —
    // OR re-routes it through the local `probeVersion` helper (which
    // was the actual historical regression path we fixed in M B Step 3f
    // when we swapped `probeVersion("git")` for `await probeGitVersion()`).
    //
    // Maintenance note: the `probeVersion` regex is specific to
    // doctor.ts's CURRENT helper name. If a future change renames that
    // helper, this regex stops protecting against the historical
    // regression. That's acceptable because any such rename is a
    // structural change inviting fresh review — but the maintainer
    // should update this regex (or remove it if `probeVersion` is
    // also removed) at the same time as the rename.
    const source = readSource("packages/cli/src/commands/doctor.ts");
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

  it("packages/cli/src/**/*.ts (excluding doctor.ts) does NOT import child_process", () => {
    // doctor.ts is the locked carve-out for diagnostic binary probing.
    // No other CLI source file may import child_process — the rest of
    // the CLI is forbidden to spawn subprocesses, and any subprocess
    // need (git or otherwise) goes through the appropriate package's
    // public API. Regex matches both the modern `node:child_process`
    // form and the legacy bare `child_process` form (the project's
    // verbatimModuleSyntax setting nudges toward `node:` but doesn't
    // enforce it, so both are valid Node import specifiers).
    const cliSrcDir = join(REPO_ROOT, "packages/cli/src");
    const allTs = findTsFiles(cliSrcDir);
    const targets = allTs.filter(
      (p) => relative(cliSrcDir, p).replace(/\\/g, "/") !== "commands/doctor.ts",
    );
    const childProcessImport = /from\s+["'](?:node:)?child_process["']/;
    for (const file of targets) {
      const source = readFileSync(file, "utf8");
      const offenders = findOffenders(source, childProcessImport);
      expect(
        offenders,
        `${relative(REPO_ROOT, file).replace(/\\/g, "/")} must not import child_process — only doctor.ts is allowed (D17c carve-out). Matches: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    }
  });
});

describe("Architectural invariants — restore.ts stream handling", () => {
  // file-header invariant #2 of restore.ts locks two stream-handling
  // rules that aren't enforced by TypeScript:
  //   1. `Readable.from([buf])` (single-chunk) — NOT `Readable.from(buf)`
  //      (which iterates the Buffer as bytes and fragments archives).
  //   2. `tar.list({ onentry })` / `tar.extract({ cwd, filter })` — NOT
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

  it("restore.ts does NOT use new tar.Parser() (must use tar.list named export — auto-detects gzip)", () => {
    const source = readSource("packages/git/src/restore.ts");
    const antipattern = /new\s+tar\.Parser\b/;
    const offenders = findOffenders(source, antipattern);
    expect(
      offenders,
      `restore.ts must use tar.list({ onentry }) (auto-decompresses gzip), NOT new tar.Parser() (treats input as raw tar headers, would silently consume gzip bytes). Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("restore.ts does NOT use new tar.Unpack() (must use tar.extract named export — auto-detects gzip)", () => {
    const source = readSource("packages/git/src/restore.ts");
    const antipattern = /new\s+tar\.Unpack\b/;
    const offenders = findOffenders(source, antipattern);
    expect(
      offenders,
      `restore.ts must use tar.extract({ cwd, filter }) (auto-decompresses gzip), NOT new tar.Unpack() (treats input as raw tar headers, would silently consume gzip bytes). Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
