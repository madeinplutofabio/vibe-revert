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
 *     containing "*​/" (inclusive on both ends)
 *   - JSDoc continuation lines inside a block comment: trimmed start
 *     === "*" or "*​/" (handled by the in-block-comment branch above,
 *     but also defensively filtered for safety against non-standard
 *     comment shapes that don't start with /*)
 *
 * The block-comment tracking is stateful across the .filter() callback
 * — `inBlockComment` persists between iterations because the filter
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
      // JSDoc continuation line (* or */ at trimmed start) — should
      // already be covered by the inBlockComment branch above, but
      // defensive belt-and-suspenders catch for non-standard shapes.
      if (trimmed.startsWith("*")) return false;
      return true;
    })
    .filter(({ line }) => pattern.test(line))
    .map(({ line, lineNumber }) => ({ lineNumber, content: line.trim() }));
}

describe("Architectural invariants — git invocation single-owner (D17c)", () => {
  // The git binary may only be invoked from @viberevert/git. Other
  // packages (including the CLI) reach for git via @viberevert/git's
  // public helpers (probeGitVersion, getStatusPorcelainText, etc.).
  // doctor.ts is a NARROW carve-out: it is allowed to spawn non-git
  // diagnostic binaries (pnpm), but MUST NOT spawn git directly.

  it('doctor.ts does NOT pass the literal "git" to spawn family functions or to its local probeVersion helper', () => {
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

describe("Architectural invariants — D19 config-blind commands", () => {
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
    const source = readSource(`packages/cli/src/commands/${cmd}.ts`);
    const offenders = findOffenders(source, /\bloadConfig\b/);
    expect(
      offenders,
      `${cmd}.ts must not reference loadConfig per D19 config-blind contract. Matches: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

describe("Architectural invariants — M D D77 rollback module boundaries", () => {
  // D77 locks 5 invariants for the rollback subsystem. The locked
  // layering (THIS IS THE CONTRACT — do not move the restoreCheckpoint
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
  //   so the receipt persists even when restoreCheckpoint throws —
  //   keeping that wrapping in one place is what makes the
  //   apply-receipt-ATTEMPT contract enforceable.
  //
  // Invariant 1 (`packages/cli/src/commands/rollback.ts` MUST NOT
  // import `child_process`) is AUTO-COVERED by the workspace-wide
  // "cli/src/**/*.ts (excluding doctor.ts) does NOT import
  // child_process" test in the D17c describe block above — no
  // separate test needed because rollback.ts is under
  // packages/cli/src/commands/ and is NOT the doctor.ts carve-out.
  //
  // Invariant 2 splits into 2a (rollback.ts boundaries — has plan,
  // does NOT have restore) and 2b (rollback-orchestration.ts owns
  // the real restore call). Invariants 3, 4, 5 get one test each.

  it("rollback.ts references planRestoreCheckpoint but NOT restoreCheckpoint directly (D77 invariant 2a)", () => {
    // The rollback command owns the dry-run planning path (via
    // planRestoreCheckpoint) and orchestrates the apply path through
    // rollback-orchestration.ts's buildReceiptForApply. It does NOT
    // call restoreCheckpoint directly — that call lives in the
    // orchestration module so Lock #16 (apply receipt = ATTEMPT)
    // can wrap it in one place.
    //
    // A regression that pulls restoreCheckpoint into rollback.ts
    // would either bypass the receipt-ATTEMPT wrapping (breaking
    // the "receipt persists on restore throw" contract) or duplicate
    // it across layers (drift risk). Either way, the layering is
    // wrong — fail the test loudly.
    const source = readSource("packages/cli/src/commands/rollback.ts");
    expect(
      findOffenders(source, /\bplanRestoreCheckpoint\b/),
      "rollback.ts must reference planRestoreCheckpoint in non-comment code (D77 invariant 2a — dry-run planning path)",
    ).not.toEqual([]);
    expect(
      findOffenders(source, /\brestoreCheckpoint\b/),
      "rollback.ts must NOT reference restoreCheckpoint directly; the apply restore call belongs in rollback-orchestration.ts so Lock #16 (apply receipt = ATTEMPT) can wrap it (D77 invariant 2a)",
    ).toEqual([]);
  });

  it("rollback-orchestration.ts references restoreCheckpoint (D77 invariant 2b)", () => {
    // The orchestration module's buildReceiptForApply wraps
    // restoreCheckpoint per Lock #16 (apply receipt = ATTEMPT — the
    // receipt persists even when the restore throws partway). A
    // regression that loses this reference would mean either the
    // apply path is broken (no real restore happens) OR it moved to
    // the wrong layer (e.g., back into rollback.ts, defeating
    // invariant 2a).
    const source = readSource("packages/cli/src/rollback-orchestration.ts");
    expect(
      findOffenders(source, /\brestoreCheckpoint\b/),
      "rollback-orchestration.ts must reference restoreCheckpoint in non-comment code (D77 invariant 2b — apply path owns the real restore call)",
    ).not.toEqual([]);
  });

  it("rollback-orchestration.ts does NOT import @viberevert/checks or @viberevert/reporters (static, dynamic, or subpath) (D77 invariant 3)", () => {
    // D77 invariant 3: orchestration composes git + core +
    // session-format primitives only. Reporters render the receipt
    // at the CLI layer (rollback.ts owns format dispatch); checks is
    // irrelevant to rollback. A regression that pulls either in here
    // would muddle the layering — orchestration is supposed to be a
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
    // /receipt-render"` would slip through — a clear D29 violation
    // since orchestration is forbidden to depend on reporters at all.
    const source = readSource("packages/cli/src/rollback-orchestration.ts");
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
    // dynamic `import("...")` forms — same dynamic-bypass concern as
    // invariant 3 above. Two paths:
    //   - `from "node:..."` OR `import("node:...")` — any Node
    //     built-in (I/O, child_process, etc.). Biome's
    //     useNodejsImportProtocol="error" already forbids the bare
    //     `from "fs"` legacy form, so we don't need to enumerate
    //     built-in names.
    //   - `from "@viberevert/X"` OR `import("@viberevert/X")` where
    //     X !== "session-format" — any other workspace package
    //     (D29's "session-format only" rule).
    const reportersSrcDir = join(REPO_ROOT, "packages/reporters/src");
    const receiptFiles = readdirSync(reportersSrcDir)
      .filter((name) => /^receipt-.*\.ts$/.test(name))
      .map((name) => join(reportersSrcDir, name));
    // Sanity: Step 5 shipped at least 5 receipt-*.ts files (types,
    // json, render, terminal, markdown). A regression that removed
    // files would silently pass this test — fail loudly instead.
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
    // BOTH pieces in one shot — proximity is intrinsic because both
    // pieces share the same match. findOffenders' comment filter
    // (line + block + JSDoc) ensures we assert on the ACTUAL stderr-
    // bound refusal copy at the implementation site, not on the
    // architectural-lock #6 block at the top of start.ts that
    // documents the same paired sequence for header-level context.
    const source = readSource("packages/cli/src/commands/start.ts");
    expect(
      findOffenders(source, /viberevert end && viberevert rollback/),
      "start.ts must contain the literal 'viberevert end && viberevert rollback' paired sequence in non-comment code (D77 invariant 5 / D74 unlock — locks both the rollback reference AND the D63-required end-before-rollback sequencing in one assertion)",
    ).not.toEqual([]);
  });
});
