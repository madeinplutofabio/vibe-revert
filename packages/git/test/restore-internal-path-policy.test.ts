// packages/git/test/restore-internal-path-policy.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Direct unit tests for the centralized `.viberevert/**` path-policy module
// (`packages/git/src/restore-internal-path-policy.ts`). The module is a pure
// (no-I/O, no-async) source of truth for `.viberevert/**` semantics across
// the restore subsystem:
//
//   - restore-preflight.ts (evidence side: manifest + archive + patch rejects)
//   - restore.ts (mutation side: deletion skip + cleanup tripwire + tar
//     filter)
//
// The integration coverage (preflight throws, cleanup tripwire fires,
// deletion skips) lives in restore.test.ts. THIS file pins the predicate
// behavior directly so a regression in the policy module surfaces at the
// closest possible source — no need to triage through preflight/cleanup
// noise to figure out the predicate is wrong.
//
// Test obligations locked at File 1a approval; see the source module's
// JSDoc blocks for the contract each predicate is asserting.

import { describe, expect, it } from "vitest";

import {
  decodeGitQuotedEscapesForPolicyScan,
  isVibeRevertInternalPath,
  patchHeaderTargetsVibeRevertInternalPath,
  VIBEREVERT_INTERNAL_STORAGE_ROOT,
} from "../src/restore-internal-path-policy.js";

// =============================================================================
// Constant
// =============================================================================

describe("VIBEREVERT_INTERNAL_STORAGE_ROOT", () => {
  it("is the literal `.viberevert` (locked storage-root name)", () => {
    expect(VIBEREVERT_INTERNAL_STORAGE_ROOT).toBe(".viberevert");
  });
});

// =============================================================================
// isVibeRevertInternalPath
//
// Locked normalization sequence per the source module's JSDoc:
//   1. backslash → forward slash
//   2. collapse sequential slashes
//   3. lowercase
//   4. strip leading `./` segments (^-anchored only)
//   5. equal-or-startsWith against `.viberevert` / `.viberevert/`
//
// Positive list: 9 cases hitting every normalization step + combinations.
// Negative list: 6 cases proving nested forms, suffix-named dirs, and
// non-VibeRevert paths are NOT matched.
// =============================================================================

describe("isVibeRevertInternalPath — positive cases (must return true)", () => {
  it.each([
    // [label, input]
    ["bare root, no children", ".viberevert"],
    ["root with child", ".viberevert/foo"],
    ["case-variant root (Windows/macOS case-insensitive FS)", ".VIBEREVERT/foo"],
    ["backslash separator (Windows form)", ".viberevert\\foo"],
    ["double slash (path-collapse normalization)", ".viberevert//foo"],
    ["leading dot-segment", "./.viberevert/foo"],
    ["leading dot-segment + double slash", ".//.viberevert/foo"],
    ["multiple leading dot-segments", "././.viberevert/foo"],
    ["case + backslash combined", ".VIBEREVERT\\foo"],
  ])("matches %s: %j", (_label, input) => {
    expect(isVibeRevertInternalPath(input)).toBe(true);
  });
});

describe("isVibeRevertInternalPath — negative cases (must return false)", () => {
  it.each([
    ["nested under another dir", "foo/.viberevert/bar"],
    [
      "nested with intermediate dot-segment (mid-path ./ NOT stripped, ^-anchored only)",
      "foo/./.viberevert/bar",
    ],
    ["suffix-named directory", "foo.viberevert/bar"],
    ["longer name starting with .viberevert", ".viberevertish/foo"],
    ["missing leading dot", "viberevert/foo"],
    ["empty string", ""],
  ])("does NOT match %s: %j", (_label, input) => {
    expect(isVibeRevertInternalPath(input)).toBe(false);
  });
});

// =============================================================================
// decodeGitQuotedEscapesForPolicyScan
//
// Smoke coverage on the C-escape decoder. Production callers are the
// patch-header scanner; this block just pins the decoder semantics
// directly so a regression there surfaces independently of the regex.
// =============================================================================

describe("decodeGitQuotedEscapesForPolicyScan", () => {
  it("decodes 3-octal `\\056` to `.` (the `.viberevert` obfuscation vector)", () => {
    expect(decodeGitQuotedEscapesForPolicyScan("\\056viberevert")).toBe(".viberevert");
  });

  it("decodes 3-octal `\\166` to `v`", () => {
    expect(decodeGitQuotedEscapesForPolicyScan(".\\166iberevert")).toBe(".viberevert");
  });

  it("decodes mixed-octal prefix `\\056\\166iberevert` to `.viberevert`", () => {
    expect(decodeGitQuotedEscapesForPolicyScan("\\056\\166iberevert")).toBe(".viberevert");
  });

  it("decodes fully-octal `.viberevert` (all 11 chars octal-encoded) to `.viberevert`", () => {
    // Every character of `.viberevert` written as a 3-octal escape:
    //   . = 056   v = 166   i = 151   b = 142   e = 145   r = 162
    //   e = 145   v = 166   e = 145   r = 162   t = 164
    // This is the worst-case obfuscation form — proves no character in
    // the target string `.viberevert` has a decoder-bypass crack.
    expect(
      decodeGitQuotedEscapesForPolicyScan(
        "\\056\\166\\151\\142\\145\\162\\145\\166\\145\\162\\164",
      ),
    ).toBe(".viberevert");
  });

  it('decodes named C escapes `\\n` `\\t` `\\\\` `\\"`', () => {
    expect(decodeGitQuotedEscapesForPolicyScan("a\\nb")).toBe("a\nb");
    expect(decodeGitQuotedEscapesForPolicyScan("a\\tb")).toBe("a\tb");
    expect(decodeGitQuotedEscapesForPolicyScan("a\\\\b")).toBe("a\\b");
    expect(decodeGitQuotedEscapesForPolicyScan('a\\"b')).toBe('a"b');
  });

  it("passes unknown escape sequences through unchanged (defensive)", () => {
    // `\Z` is not a recognized C escape; the regex `[abfnrtv\\"']` doesn't
    // match `Z`, so the full `\Z` is preserved verbatim.
    expect(decodeGitQuotedEscapesForPolicyScan("a\\Zb")).toBe("a\\Zb");
  });
});

// =============================================================================
// patchHeaderTargetsVibeRevertInternalPath
//
// The trust-critical predicate. Five-phase check per source JSDoc:
//   1. line classification (skip hunk content / hunk headers / no-newline markers)
//   2. decode C-style escapes (closes `\056viberevert` bypass)
//   3. normalize backslash separators (closes Windows-form bypass)
//   4. collapse sequential slashes (closes combined-escape vector)
//   5. apply token-anchored regex (with optional `./` dot-segment group)
//
// Positive list (must reject): 10 cases covering every locked vector.
// Negative list (must NOT reject): 9 cases including nested paths,
// hunk content, and hunk headers.
// Documented over-reject: 1 case where the line-regex's token-start gate
// triggers on an embedded space inside a quoted path. This is a deliberate
// trade-off (conservative over-reject vs catastrophic false-negative); the
// test asserts the rejection so future "test failure" pressure forces a
// real design conversation rather than silent JSDoc rot.
// =============================================================================

describe("patchHeaderTargetsVibeRevertInternalPath — positive cases (must return true)", () => {
  it.each([
    // [label, input]
    ["--- direct root", "--- a/.viberevert/foo"],
    ["+++ case-variant root", "+++ b/.VIBEREVERT/foo"],
    ["diff --git both sides", "diff --git a/.viberevert/x b/.viberevert/x"],
    ["--- backslash separator (Windows form)", "--- a/.viberevert\\foo"],
    ["--- C-escaped quoted path: `\\056viberevert`", '--- "a/\\056viberevert/foo"'],
    [
      "--- combined escape + backslash: `\\134.viberevert` decodes to `\\.viberevert` then normalizes to `/.viberevert` then slash-collapses to `.viberevert`",
      '--- "a/\\134.viberevert/foo"',
    ],
    ["--- dot-segment root", "--- a/./.viberevert/foo"],
    ["+++ dot-segment + case", "+++ b/./.VIBEREVERT/foo"],
    ["rename from with dot-segment, no prefix", "rename from ./.viberevert/foo"],
    ["rename from bare (no a/ or b/ prefix)", "rename from .viberevert/foo"],
  ])("rejects %s: %j", (_label, input) => {
    expect(patchHeaderTargetsVibeRevertInternalPath(input)).toBe(true);
  });
});

describe("patchHeaderTargetsVibeRevertInternalPath — negative cases (must return false)", () => {
  it.each([
    // [label, input]
    ["--- nested .viberevert under foo/", "--- a/foo/.viberevert/bar"],
    [
      "--- deeply nested with inner `a/` (the original regex's bypass case)",
      "--- a/foo/a/.viberevert/bar",
    ],
    [
      "--- nested with intermediate dot-segment (mid-path ./ doesn't anchor a match)",
      "--- a/foo/./.viberevert/bar",
    ],
    ["--- suffix-named directory (foo.viberevert/)", "--- a/foo.viberevert/bar"],
    ["--- longer name starting with .viberevert", "--- a/.viberevertish/bar"],
    ["--- filename not directory (.viberevert.txt)", "--- a/.viberevert.txt"],
    [
      "hunk content with `+` prefix mentioning .viberevert/ (user code; not a header)",
      "+if (path === '.viberevert/config') { writeReceipt(); }",
    ],
    ["hunk header `@@ ...`", "@@ -1,3 +1,3 @@"],
    ["empty string", ""],
  ])("does NOT reject %s: %j", (_label, input) => {
    expect(patchHeaderTargetsVibeRevertInternalPath(input)).toBe(false);
  });
});

describe("patchHeaderTargetsVibeRevertInternalPath — documented over-reject (locked behavior)", () => {
  // The line-regex's token-start gate (`(?:^|[\s"])`) matches the space
  // inside the quoted path "a/foo .viberevert/bar" — so this case IS
  // rejected, even though the EFFECTIVE path is `foo .viberevert/bar`
  // (a nested directory `foo ` containing a `.viberevert/` child).
  //
  // Locked trade-off per the source JSDoc: line-level regex is bypass-
  // resistant and auditable; full path-token extraction would require a
  // Git path parser. False positives are recoverable (rename the
  // offending file); false negatives would be silent storage corruption.
  // This test pins the behavior so future "this rejects a legit path"
  // pressure routes through a real design conversation, not a silent
  // JSDoc update.
  it('rejects `--- "a/foo .viberevert/bar"` (line-regex limitation; conservative over-reject)', () => {
    expect(patchHeaderTargetsVibeRevertInternalPath('--- "a/foo .viberevert/bar"')).toBe(true);
  });
});
