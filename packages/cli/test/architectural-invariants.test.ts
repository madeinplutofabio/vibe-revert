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

describe("Architectural invariants — M E D90 prompt-fix module boundaries", () => {
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
  //   resolveReportPaths — the resolver's no-fs invariant is locked
  //   by its own test file (prompt-fix-targets.test.ts Section 5).
  //
  //   packages/reporters/src/fix-prompt-*.ts are D29-pure renderers
  //   covered by D90.5 (mirrors D77 invariant 4 for receipt renderers).
  //
  // 14 tests total — 13 D90.X invariant tests plus one M E command
  // exposure test (locks the CLI registration in packages/cli/src/
  // index.ts so a future maintainer that removes the
  // cli.register(PromptFixCommand) line cannot ship a CLI binary
  // where the command is unreachable while the integration tests
  // continue to pass via their in-test Cli registration; also locks
  // the registration ORDER between ReportCommand and RollbackCommand
  // to preserve the locked check → report → prompt-fix → rollback
  // workflow grouping).
  //
  // **Import-form coverage:** D90.1, D90.2, D90.3, and D90.6f all
  // scan for FOUR import forms — static ESM (`from "..."`), dynamic
  // ESM (`import("...")`), CommonJS require (`require("...")`), AND
  // TS import-equals (`import x = require("...")`). The project is
  // ESM, but an invariant block should not have CJS-shaped escape
  // hatches: a future maintainer using tsconfig interop or copying
  // snippet code could land either CJS form. The patterns cover all
  // realistic bypass routes.
  //
  // All 8 D90 invariants get explicit tests inside this describe
  // block — including D90.1 (no child_process imports). Although the
  // workspace-wide D17c "cli/src/**/*.ts (excluding doctor.ts)" check
  // also covers prompt-fix.ts, that defense is indirect (different
  // describe block, different decision lock). Making D90 self-
  // contained means a future refactor that loosens the D17c carve-out
  // or moves prompt-fix.ts out from under packages/cli/src/commands/
  // would not silently de-protect the prompt-fix subsystem. The
  // D90.1/D90.2/D90.3 tests scan BOTH prompt-fix.ts AND
  // prompt-fix-targets.ts — the resolver is part of the subsystem
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
  // D90.6 and D90.7 stay scoped to prompt-fix.ts only — the
  // fs-surface lock and single-renderer-call contract are command-
  // specific (the resolver has its own no-fs purity test in
  // prompt-fix-targets.test.ts Section 5, and only the command
  // invokes the renderer).
  //
  // The KNOWN_LLM_SDKS list is deliberately broad — it covers not
  // just the direct provider SDKs but also the high-level framework
  // SDKs (Vercel's `ai`, `@ai-sdk/*`, LangChain, llamaindex, etc.)
  // and the runtime adapters (`ollama`, `@aws-sdk/client-bedrock-
  // runtime`, etc.). D90.8's "dependency added but not yet imported"
  // drift class is exactly the case where a maintainer adds one of
  // these packages to package.json BEFORE wiring the hidden --llm
  // path, signaling intent to land an LLM feature outside the M G1
  // MCP `generate_fix_prompt` milestone.

  const PROMPT_FIX_REL = "packages/cli/src/commands/prompt-fix.ts";
  const PROMPT_FIX_TARGETS_REL = "packages/cli/src/prompt-fix-targets.ts";
  const PROMPT_FIX_SOURCE_RELS: ReadonlyArray<string> = [PROMPT_FIX_REL, PROMPT_FIX_TARGETS_REL];
  const CLI_INDEX_REL = "packages/cli/src/index.ts";

  /**
   * Known LLM-SDK package specifiers banned per D90.3 (imports) and
   * D90.8 (package.json dependency maps). Deliberately broad — covers
   * direct provider SDKs (@anthropic-ai/sdk, openai, cohere-ai,
   * @google/generative-ai, replicate, mistralai, @mistralai/mistralai),
   * AWS Bedrock runtime adapters (@anthropic-ai/bedrock-sdk,
   * @aws-sdk/client-bedrock-runtime), high-level framework SDKs
   * (Vercel's `ai`, `@ai-sdk/*`, LangChain ecosystem, llamaindex),
   * and other realistic adapters (ollama, groq-sdk, @groq/sdk,
   * @huggingface/inference). NOT exhaustive — but the list covers
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
   * shapes — `(?:node:)?` for child_process, exact `@viberevert/checks`
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
    // moves files out from under packages/cli/src/commands/. The
    // regex covers static ESM + dynamic ESM + CJS require + TS
    // import-equals shapes for `child_process` / `node:child_process`.
    const pattern =
      /(?:from\s+["'](?:node:)?child_process["']|import\s*\(\s*["'](?:node:)?child_process["']\s*\)|require\s*\(\s*["'](?:node:)?child_process["']\s*\)|import\s+\w+\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\))/;
    for (const rel of PROMPT_FIX_SOURCE_RELS) {
      const offenders = findOffenders(readSource(rel), pattern);
      expect(
        offenders,
        `${rel} must not import child_process / node:child_process in any form (D90.1 — static, dynamic, require, or import-equals). Matches: ${JSON.stringify(offenders)}`,
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
        `${rel} must not import @viberevert/checks in any form (D90.2 — static, dynamic, require, import-equals, exact or subpath). Matches: ${JSON.stringify(offenders)}`,
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
          `${rel} must not import ${sdk} in any form (D90.3 — known LLM SDK). Matches: ${JSON.stringify(offenders)}`,
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
    // Defensive comment-strip BEFORE the multi-line regex test —
    // even though prompt-fix.ts's comments are already prose-safe
    // per Step 3's hygiene discipline, stripping survives future
    // comment-style changes that might accidentally form the
    // `Option.Boolean("--llm"... hidden: true` shape in a docstring.
    const source = readSource(PROMPT_FIX_REL);
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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
    // would silently pass this test — fail loudly instead.
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

  it("prompt-fix.ts has exactly two readFile calls AND every readFile call targets target.reportPath (D90.6a — D88 drift-guard reads A + B)", () => {
    // D90.6a locks the D88 drift-guard reads — exactly two source
    // occurrences of `readFile(target.reportPath`, one inside
    // `readReportBytes` (read A) and one inside
    // `assertSourceReportUnchanged` (read B). Both helpers take
    // the typed PromptFixReportTarget so the literal expression
    // appears at the call site inside each helper body.
    //
    // Additionally locks: NO readFile call whose first argument
    // is NOT target.reportPath (negative-lookahead pattern). A
    // regression that accidentally read target.fixPromptPath
    // would be caught at code time, not just by the harness's
    // byte-identity assertion.
    const source = readSource(PROMPT_FIX_REL);

    const correctTarget = findOffenders(source, /\breadFile\s*\(\s*target\.reportPath\b/);
    expect(
      correctTarget.length,
      `prompt-fix.ts must call readFile(target.reportPath, ...) EXACTLY twice (D90.6a — D88 reads A + B). Found ${correctTarget.length} occurrences: ${JSON.stringify(correctTarget)}`,
    ).toBe(2);

    const wrongTarget = findOffenders(source, /\breadFile\s*\((?!\s*target\.reportPath\b)/);
    expect(
      wrongTarget,
      `prompt-fix.ts readFile calls must use target.reportPath as the first argument (D90.6a). Wrong-target call sites: ${JSON.stringify(wrongTarget)}`,
    ).toEqual([]);
  });

  it("prompt-fix.ts has exactly one rm call AND every rm / unlink call targets target.fixPromptPath (D90.6b — D86 empty-findings stale removal)", () => {
    // D90.6b locks the D86 empty-findings stale-removal — exactly
    // one source occurrence of `rm(target.fixPromptPath` inside
    // `removeStaleFixPrompt`. NO other rm targets are allowed
    // (catches accidental `rm(target.reportPath)` which would
    // destroy the source report on the deletion path), AND no
    // `unlink(` calls at all (the locked operation is rm with
    // force-removal; unlink would bypass the ENOENT-tolerant
    // discipline).
    const source = readSource(PROMPT_FIX_REL);

    const correctTarget = findOffenders(source, /\brm\s*\(\s*target\.fixPromptPath\b/);
    expect(
      correctTarget.length,
      `prompt-fix.ts must call rm(target.fixPromptPath, ...) EXACTLY once (D90.6b — D86 stale removal). Found ${correctTarget.length} occurrences: ${JSON.stringify(correctTarget)}`,
    ).toBe(1);

    const wrongRmTarget = findOffenders(source, /\brm\s*\((?!\s*target\.fixPromptPath\b)/);
    expect(
      wrongRmTarget,
      `prompt-fix.ts rm calls must use target.fixPromptPath as the first argument (D90.6b). Wrong-target call sites: ${JSON.stringify(wrongRmTarget)}`,
    ).toEqual([]);

    const anyUnlink = findOffenders(source, /\bunlink\s*\(/);
    expect(
      anyUnlink,
      `prompt-fix.ts must not call unlink (D90.6b — locked operation is rm with force-removal). Call sites: ${JSON.stringify(anyUnlink)}`,
    ).toEqual([]);
  });

  it("prompt-fix.ts has exactly one writeFileAtomic call AND it targets target.fixPromptPath (D90.6c — D81 file-before-stdout write order)", () => {
    // D90.6c locks the D81 success-path write — exactly one
    // source occurrence of `writeFileAtomic(target.fixPromptPath`
    // inside `persistFixPrompt`. NO other writeFileAtomic targets
    // are allowed (catches accidental `writeFileAtomic(target.reportPath`
    // which would overwrite the source report).
    const source = readSource(PROMPT_FIX_REL);

    const correctTarget = findOffenders(source, /\bwriteFileAtomic\s*\(\s*target\.fixPromptPath\b/);
    expect(
      correctTarget.length,
      `prompt-fix.ts must call writeFileAtomic(target.fixPromptPath, ...) EXACTLY once (D90.6c — D81 success path). Found ${correctTarget.length} occurrences: ${JSON.stringify(correctTarget)}`,
    ).toBe(1);

    const wrongTarget = findOffenders(
      source,
      /\bwriteFileAtomic\s*\((?!\s*target\.fixPromptPath\b)/,
    );
    expect(
      wrongTarget,
      `prompt-fix.ts writeFileAtomic calls must use target.fixPromptPath as the first argument (D90.6c). Wrong-target call sites: ${JSON.stringify(wrongTarget)}`,
    ).toEqual([]);
  });

  it("prompt-fix.ts contains NO readdir or lstat calls (D90.6d — fs-surface lock)", () => {
    // D90.6d: the locked fs surface is readFile + rm +
    // writeFileAtomic only. Any readdir or lstat call would
    // indicate a broader fs operation creeping in (e.g.,
    // enumerating sibling files, checking symlink status). The
    // resolver's structural checks already cover layout
    // validation; the command should never need to enumerate or
    // stat anything.
    const source = readSource(PROMPT_FIX_REL);

    const readdirCalls = findOffenders(source, /\breaddir\s*\(/);
    expect(
      readdirCalls,
      `prompt-fix.ts must not call readdir (D90.6d). Call sites: ${JSON.stringify(readdirCalls)}`,
    ).toEqual([]);

    const lstatCalls = findOffenders(source, /\blstat\s*\(/);
    expect(
      lstatCalls,
      `prompt-fix.ts must not call lstat (D90.6d). Call sites: ${JSON.stringify(lstatCalls)}`,
    ).toEqual([]);
  });

  it("prompt-fix.ts does NOT alias any filesystem helper via const/let assignment OR import rename (D90.6e — code-review mechanical-check lock)", () => {
    // D90.6e: the D90.6 grep invariants depend on the literal
    // call-site patterns being legible. Aliasing
    // (`const myRead = readFile`) or import renaming
    // (`import { readFile as foo }`) would bypass the grep
    // without changing observable behavior — that drift class
    // is what this lock prevents.
    //
    // Two patterns checked:
    //   - const/let/var assignment of one of the fs helpers
    //     (matched by helper NOT being followed by `(` — i.e.,
    //     it's a value reference, not a call).
    //   - import { X as Y } rename inside an import statement.
    const source = readSource(PROMPT_FIX_REL);

    const fsHelpers = "(?:readFile|rm|writeFileAtomic|lstat|readdir)";

    const aliasAssign = new RegExp(`\\b(?:const|let|var)\\s+\\w+\\s*=\\s*${fsHelpers}(?!\\s*\\()`);
    const assignOffenders = findOffenders(source, aliasAssign);
    expect(
      assignOffenders,
      `prompt-fix.ts must not alias fs helpers via const/let/var assignment (D90.6e). Offenders: ${JSON.stringify(assignOffenders)}`,
    ).toEqual([]);

    const aliasImport = new RegExp(`\\b${fsHelpers}\\s+as\\s+\\w+`);
    const importOffenders = findOffenders(source, aliasImport);
    expect(
      importOffenders,
      `prompt-fix.ts must not rename fs helpers in import statements (D90.6e). Offenders: ${JSON.stringify(importOffenders)}`,
    ).toEqual([]);
  });

  it("prompt-fix.ts imports only readFile/rm from node:fs/promises via a single un-aliased named-import statement and uses no other fs call tokens (D90.6f — broad future-proofing surface lock)", () => {
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
    //      self-contained — locks the canonical shape directly so
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
    //      `import x = require("node:fs[/promises]")` — same
    //      routing-around concern as the dynamic-import case.
    //
    //   8. NO call to any other fs-promises function token —
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
    const source = readSource(PROMPT_FIX_REL);
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // Check 1: exactly one named-import statement.
    const fsPromisesImportMatches = [
      ...stripped.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']node:fs\/promises["']/g),
    ];
    expect(
      fsPromisesImportMatches.length,
      `prompt-fix.ts must have EXACTLY one named-import statement from node:fs/promises (D90.6f). Found ${fsPromisesImportMatches.length}.`,
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
      `prompt-fix.ts node:fs/promises import must not use aliased names (D90.6f — canonical shape). Got: ${JSON.stringify(importedRaw)}`,
    ).toBe(false);

    // Check 3: exactly {readFile, rm} with no duplicates. Since
    // alias check above already passed, importedRaw contains
    // plain identifier names — no need to strip `as X` suffixes.
    expect(
      importedRaw.length,
      `prompt-fix.ts node:fs/promises import must contain exactly 2 names (catches duplicates) (D90.6f). Got ${importedRaw.length}: ${JSON.stringify(importedRaw)}`,
    ).toBe(2);
    expect(
      new Set(importedRaw),
      `prompt-fix.ts must import EXACTLY {readFile, rm} from node:fs/promises (D90.6f). Got: ${JSON.stringify([...new Set(importedRaw)])}`,
    ).toEqual(new Set(["readFile", "rm"]));

    // Check 4: no namespace or default-import forms from node:fs/promises.
    const namespaceOrDefaultFsImports = findOffenders(
      stripped,
      /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+["']node:fs\/promises["']/,
    );
    expect(
      namespaceOrDefaultFsImports,
      `prompt-fix.ts must not use namespace or default-import forms from node:fs/promises (D90.6f). Matches: ${JSON.stringify(namespaceOrDefaultFsImports)}`,
    ).toEqual([]);

    // Check 5: no bare node:fs static import.
    const bareFsStaticImports = findOffenders(stripped, /from\s+["']node:fs["']/);
    expect(
      bareFsStaticImports,
      `prompt-fix.ts must not import from the bare node:fs (sync) API — only node:fs/promises (D90.6f). Matches: ${JSON.stringify(bareFsStaticImports)}`,
    ).toEqual([]);

    // Check 6: no dynamic import of node:fs or node:fs/promises.
    const dynamicFsImports = findOffenders(
      stripped,
      /import\s*\(\s*["']node:fs(?:\/promises)?["']\s*\)/,
    );
    expect(
      dynamicFsImports,
      `prompt-fix.ts must not dynamic-import node:fs or node:fs/promises (D90.6f). Matches: ${JSON.stringify(dynamicFsImports)}`,
    ).toEqual([]);

    // Check 7: no CJS require or TS import-equals of node:fs[/promises].
    const requireFsImports = findOffenders(
      stripped,
      /require\s*\(\s*["']node:fs(?:\/promises)?["']\s*\)/,
    );
    expect(
      requireFsImports,
      `prompt-fix.ts must not CJS-require node:fs or node:fs/promises (D90.6f). Matches: ${JSON.stringify(requireFsImports)}`,
    ).toEqual([]);

    const importEqualsFsImports = findOffenders(
      stripped,
      /import\s+\w+\s*=\s*require\s*\(\s*["']node:fs(?:\/promises)?["']\s*\)/,
    );
    expect(
      importEqualsFsImports,
      `prompt-fix.ts must not TS-import-equals node:fs or node:fs/promises (D90.6f). Matches: ${JSON.stringify(importEqualsFsImports)}`,
    ).toEqual([]);

    // Check 8: no forbidden fs call tokens.
    const forbiddenFsCalls = findOffenders(
      stripped,
      /\b(?:access|appendFile|chmod|chown|copyFile|cp|lstat|mkdir|mkdtemp|open|opendir|readdir|readlink|realpath|rename|rmdir|stat|symlink|truncate|unlink|utimes|watch|writeFile)\s*\(/,
    );
    expect(
      forbiddenFsCalls,
      `prompt-fix.ts must not call any fs operation outside the D90.6 locked surface (D90.6f). Forbidden call sites: ${JSON.stringify(forbiddenFsCalls)}`,
    ).toEqual([]);
  });

  it("prompt-fix.ts contains EXACTLY ONE renderFixPrompt call site (D90.7 — single renderer call lock)", () => {
    // D90.7: the renderer is invoked exactly once per execution
    // and the source MUST reflect that — a second call site
    // would risk drift if any future template helper accidentally
    // sneaks in a clock/random/ulid read (which D90.5 currently
    // prohibits, but defense-in-depth). The single call lives in
    // execute() on the success path.
    //
    // Comments in prompt-fix.ts are written as prose ("the
    // renderer call" / "the render invocation") rather than the
    // literal name-plus-paren form per the file's own lock #6 —
    // findOffenders strips comments anyway, but the prose
    // convention adds a second layer of safety against this grep
    // false-matching.
    const source = readSource(PROMPT_FIX_REL);
    const renderCalls = findOffenders(source, /\brenderFixPrompt\s*\(/);
    expect(
      renderCalls.length,
      `prompt-fix.ts must contain EXACTLY one renderFixPrompt call site (D90.7). Found ${renderCalls.length} occurrences: ${JSON.stringify(renderCalls)}`,
    ).toBe(1);
  });

  it("no known LLM SDK appears in any package.json dependency map (D90.8 — workspace-wide LLM-free contract)", () => {
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
        // not present — skip
      }
    }
    const scriptsPkgJson = join(REPO_ROOT, "scripts", "package.json");
    try {
      if (statSync(scriptsPkgJson).isFile()) {
        pkgJsonPaths.push(scriptsPkgJson);
      }
    } catch {
      // not present — skip (the project's scripts/ may or may not
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
              `${relative(REPO_ROOT, pkgPath).replace(/\\/g, "/")} → ${depField}.${sdk}`,
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

  it("CLI index imports and registers PromptFixCommand exactly once AND preserves the Report → PromptFix → Rollback workflow order (M E command exposure lock)", () => {
    // Locked separately from D90.X because this is about EXPOSURE
    // (the command is reachable through the binary) and ORDER (the
    // intentional check → report → prompt-fix → rollback workflow
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

    const imports = findOffenders(
      source,
      /import\s*\{\s*PromptFixCommand\s*\}\s*from\s*["']\.\/commands\/prompt-fix\.js["']/,
    );
    expect(
      imports.length,
      `packages/cli/src/index.ts must import PromptFixCommand from "./commands/prompt-fix.js" exactly once (M E command exposure). Found ${imports.length}.`,
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
      "ReportCommand must be registered BEFORE PromptFixCommand in index.ts (workflow order: check → report → prompt-fix → rollback)",
    ).toBeLessThan(promptFixIdx);
    expect(
      promptFixIdx,
      "PromptFixCommand must be registered BEFORE RollbackCommand in index.ts (workflow order: check → report → prompt-fix → rollback)",
    ).toBeLessThan(rollbackIdx);
  });
});
