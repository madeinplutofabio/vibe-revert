// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// packages/git/test/architectural-invariants.test.ts
//
// Test-time architectural invariants for `@viberevert/git`.
// These tests assert package-level structural rules that the TypeScript
// type system cannot enforce on its own. They run as part of
// `pnpm --filter @viberevert/git test` and are gated by the standard
// CI pipeline. Same pattern as the CLI's `workspace-invariants.test.ts`.
//
// ---------------------------------------------------------------------------
// Single-source commit-peel suffix invariant
// ---------------------------------------------------------------------------
//
// `resolveCommitRef` in `packages/git/src/git-cli.ts` is the package's
// single source of truth for resolving a user-supplied ref/SHA to a
// canonical 40-char lowercase commit SHA. The `COMMIT_REF_PEEL_SUFFIX`
// constant in that file is the ONLY place in `packages/git/src` that is
// allowed to contain the literal commit-peel suffix string `^{commit}`.
//
// Every other module that needs commit resolution MUST call
// `resolveCommitRef`. This test enforces that rule at CI time by
// performing a raw byte-occurrence scan of every `.ts` file under
// `packages/git/src/**` and asserting:
//   - exactly ONE byte-occurrence of the literal `^{commit}` is present;
//   - the occurrence lives in `packages/git/src/git-cli.ts`;
//   - the line carrying the occurrence matches the canonical constant
//     declaration EXACTLY (after trim):
//       const COMMIT_REF_PEEL_SUFFIX = "^{commit}" as const;
//
// The third check is intentionally strict — a `.toContain` on the
// identifier name would let a stray doc comment like
// `// COMMIT_REF_PEEL_SUFFIX uses "^{commit}"` pass spuriously if the
// const declaration itself had been removed or renamed and the comment
// was the only remaining occurrence. The exact-line regex closes that
// hole: the invariant requires the actual constant declaration, not
// merely a line that mentions the identifier.
//
// The scan deliberately does NOT strip comments. Doc comments that
// contain the literal would create a second source of confusion for
// future contributors (e.g., a copy-pasted example block) and are
// treated as violations. Prose-only references ("commit-peel suffix"
// without the literal characters) are fine — and are the encouraged
// shape for any future doc comment that needs to discuss the topic.
//
// This test file lives under `packages/git/test/`, which is OUTSIDE
// the scan scope. It is therefore free to contain the literal
// `^{commit}` as part of its assertion logic (specifically: the
// `PEEL_LITERAL` constant below, the `ALLOWED_DECLARATION_RE` regex,
// the `ALLOWED_DECLARATION_DISPLAY` string, and this header comment).
//
// Runnable equivalent (for manual verification at the shell):
//   git -C <repo-root> grep -n -F '^{commit}' -- packages/git/src
// Expected output: exactly one line —
//   packages/git/src/git-cli.ts:<line>:const COMMIT_REF_PEEL_SUFFIX = "^{commit}" as const;
// Fixed-string (`-F`) grep is used so the check does not depend on
// git grep's regex dialect (which can be reconfigured via the
// `grep.patternType` git config).
//
// Note on grep vs test strictness: the runnable grep above counts
// LINES containing the literal; the test below counts BYTE
// OCCURRENCES of the literal. These agree in the normal case (one
// occurrence on one line). They diverge if anyone packs two or more
// occurrences onto a single line (e.g., `"^{commit}" + "^{commit}"`):
// the grep reports 1 line, the test reports 2 occurrences and fails.
// The test is the canonical CI gate; the grep is a quick spot-check
// only.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Absolute path to `packages/git/src`. Computed from this file's own
 * location so the test is robust to where the package is checked out.
 *
 * `import.meta.url` points at this file (`packages/git/test/architectural-invariants.test.ts`);
 * `new URL(".", ...)` resolves to its containing directory; the join then
 * walks one level up (out of `test/`) and into `src/`.
 */
const GIT_SRC_ROOT = (() => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "..", "src");
})();

/**
 * Recursive `.ts` file walker, symlink-strict.
 *
 * Uses `lstatSync` (not `statSync`) so symlinks are inspected as
 * symlinks, not followed. Only entries whose `lstat` result reports
 * `isDirectory()` are recursed into, and only entries whose result
 * reports `isFile()` AND whose name ends in `.ts` are collected.
 *
 * Symlinks, sockets, FIFOs, devices, etc. are silently skipped — a
 * stray symlink inside `src/` is a different kind of architectural
 * violation and out of scope for this single-source check.
 *
 * Directory entries are sorted lexicographically at each level, so the
 * returned file list (and therefore the failure-message hit ordering)
 * is deterministic across platforms.
 */
function walkTsFilesSync(root: string): readonly string[] {
  const out: string[] = [];
  function visit(dir: string): void {
    const entries = readdirSync(dir).sort();
    for (const name of entries) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        visit(abs);
      } else if (st.isFile() && name.endsWith(".ts")) {
        out.push(abs);
      }
    }
  }
  visit(root);
  return out;
}

interface Hit {
  /** POSIX-style relative path from GIT_SRC_ROOT. */
  readonly relPath: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number (start of the matched literal within the line). */
  readonly column: number;
  /** Trimmed line content (for the failure-message excerpt). */
  readonly content: string;
}

/**
 * Locate every byte-occurrence of `literal` across every `.ts` file
 * under `root`. Returns a flat, ordered list of hits — sorted by file
 * (walker order, deterministic), then by line, then by column, by
 * virtue of the inner loops.
 *
 * Counts BYTE OCCURRENCES, not line occurrences: two occurrences on
 * the same line produce two `Hit` records. The inner `indexOf` loop
 * advances `fromIndex` by `literal.length` after each match so
 * adjacent occurrences (`"^{commit}^{commit}"`) are correctly counted
 * as two; advancing by 1 instead would still work for non-overlapping
 * literals but the `length` form is the safer general pattern and
 * matches the locked spec.
 *
 * Plain `String.prototype.indexOf` is used — matches `git grep -F`
 * fixed-string semantics exactly. No regex involved on either side
 * of the verification chain.
 */
function findLiteralOccurrences(root: string, literal: string): readonly Hit[] {
  const files = walkTsFilesSync(root);
  const hits: Hit[] = [];
  for (const abs of files) {
    const text = readFileSync(abs, "utf8");
    if (!text.includes(literal)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;

      let fromIndex = 0;
      while (true) {
        const index = line.indexOf(literal, fromIndex);
        if (index === -1) break;

        hits.push({
          relPath: relative(root, abs).split(sep).join("/"),
          line: i + 1,
          column: index + 1,
          content: line.trim(),
        });

        fromIndex = index + literal.length;
      }
    }
  }
  return hits;
}

describe("@viberevert/git architectural invariants", () => {
  describe("single-source commit-peel suffix", () => {
    // The byte sequence we forbid everywhere except the named constant
    // declaration. Defined as a local constant in this test file (which
    // lives outside the scanned scope) so the assertion can reference
    // it without violating the invariant it polices.
    const PEEL_LITERAL = "^{commit}";
    const ALLOWED_FILE = "git-cli.ts";
    // The single allowed shape of the line carrying the literal,
    // anchored to the entire trimmed line. No `m` flag, so `^` and `$`
    // are string-anchors (not line-anchors). The `\^` `\{` `\}` escapes
    // are necessary because `^`, `{`, `}` are regex meta-characters;
    // the byte sequence inside the quotes is identical to PEEL_LITERAL,
    // just re-encoded for regex consumption.
    const ALLOWED_DECLARATION_RE = /^const COMMIT_REF_PEEL_SUFFIX = "\^\{commit\}" as const;$/;
    // Human-readable form for failure messages — identical character
    // sequence to what ALLOWED_DECLARATION_RE matches.
    const ALLOWED_DECLARATION_DISPLAY = 'const COMMIT_REF_PEEL_SUFFIX = "^{commit}" as const;';

    it("appears exactly once in packages/git/src, at the COMMIT_REF_PEEL_SUFFIX constant", () => {
      const hits = findLiteralOccurrences(GIT_SRC_ROOT, PEEL_LITERAL);

      const hitListing =
        hits.length === 0
          ? "(no hits)"
          : hits.map((h) => `  ${h.relPath}:${h.line}:${h.column}: ${h.content}`).join("\n");
      const directive =
        "Use the COMMIT_REF_PEEL_SUFFIX constant or 'commit-peel suffix' prose instead. " +
        "The single-source guarantee lives in packages/git/src/git-cli.ts; every other " +
        "module that needs commit-ref resolution must call resolveCommitRef().";

      // Count check. Failure modes:
      //   - 0 hits: the constant was removed or renamed → call-site rot
      //     (other files now break because the import target is gone, but
      //     this assertion surfaces the root cause cleanly);
      //   - >1 hits: a doc comment, duplicated implementation, copy-pasted
      //     example, or a same-line multi-occurrence (e.g., string concat)
      //     re-introduced the literal somewhere outside the named constant.
      expect(
        hits,
        `expected exactly 1 byte-occurrence of \`${PEEL_LITERAL}\` under packages/git/src; ` +
          `found ${hits.length}.\nhits:\n${hitListing}\n${directive}`,
      ).toHaveLength(1);

      // Location check. The optional-chain on `sole` is a TS
      // noUncheckedIndexedAccess paranoia guard — `hits[0]` is provably
      // defined after the toHaveLength(1) assertion above, but the type
      // system can't see that.
      const sole = hits[0];
      expect(
        sole?.relPath,
        `single occurrence found, but it is in ${sole?.relPath ?? "<missing>"} ` +
          `instead of ${ALLOWED_FILE}.\nhit:\n${hitListing}\n${directive}`,
      ).toBe(ALLOWED_FILE);

      // Exact-line declaration check. Strictly requires the canonical
      // constant declaration, not merely a line that mentions the
      // identifier. A doc comment like
      //   // COMMIT_REF_PEEL_SUFFIX uses "^{commit}"
      // would pass a substring check on the identifier name but fails
      // this regex — which is the correct behavior, because the
      // invariant exists to ensure the constant declaration ITSELF is
      // present and unique, not just a stray reference to it.
      expect(
        sole?.content ?? "",
        `single occurrence is in ${ALLOWED_FILE} but the line does not match the ` +
          `canonical COMMIT_REF_PEEL_SUFFIX declaration.\n` +
          `expected (exact match after trim):\n  ${ALLOWED_DECLARATION_DISPLAY}\n` +
          `hit:\n${hitListing}\n${directive}`,
      ).toMatch(ALLOWED_DECLARATION_RE);
    });
  });
});
