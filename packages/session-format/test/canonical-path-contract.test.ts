// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.9.0 step 0A: the canonical repository-relative path form, as a CONTRACT.
//
// =============================================================================
// Why this file exists when the function already has tests
// =============================================================================
//
// `normalizeRelativePath` is shipped and covered. What was missing is the
// statement that scope matching operates on ONE canonical form, and what that
// form is. Plan section 3.12: path normalization belongs in the contract, not
// only in tests of the helper, because the same session must not yield
// different policy decisions on Windows and on Unix.
//
// 0.9.0 does not introduce a second normalizer. The contract below is the
// existing one, written down and pinned, so step 8's evaluator has something to
// be correct against rather than a function to copy behaviour from.
//
// No `path.sep`, no `process.platform`, no filesystem access: a repository-
// relative path is a string in a persisted artifact, and it must canonicalize
// identically regardless of which machine reads it. That is why these tests can
// assert Windows-shaped input on every platform.

import { describe, expect, it } from "vitest";

import { normalizePathArray, normalizeRelativePath } from "../src/atoms.js";

// Built by escape rather than written literally, so the file stays free of
// stray backslashes that a formatter or a careless edit could silently alter.
const BS = "\\";

describe("the canonical form: separators", () => {
  it("backslashes become forward slashes", () => {
    expect(normalizeRelativePath(`src${BS}foo.ts`)).toBe("src/foo.ts");
    expect(normalizeRelativePath(`a${BS}b${BS}c.ts`)).toBe("a/b/c.ts");
  });

  it("a Windows-shaped path and its POSIX twin collapse to ONE value", () => {
    // The property scope matching depends on: the same file cannot be two
    // different scope members depending on who recorded it.
    expect(normalizeRelativePath(`src${BS}foo.ts`)).toBe(normalizeRelativePath("src/foo.ts"));
  });

  it("repeated separators collapse", () => {
    expect(normalizeRelativePath("src//foo.ts")).toBe("src/foo.ts");
    expect(normalizeRelativePath(`src${BS}${BS}foo.ts`)).toBe("src/foo.ts");
  });

  it("leading ./ is stripped, repeatedly", () => {
    expect(normalizeRelativePath("./src/foo.ts")).toBe("src/foo.ts");
    expect(normalizeRelativePath("././src/foo.ts")).toBe("src/foo.ts");
  });
});

describe("the canonical form: case is PRESERVED, not folded", () => {
  it("two casings are two distinct paths", () => {
    // Deliberate, and the reason is worth pinning: git is case-sensitive in the
    // index even on a case-insensitive filesystem. Folding here would let a
    // scope rule for `SRC/**` silently cover `src/**`, which is a widening, and
    // a widening is the one direction a scope contract must never drift.
    //
    // The cost is understood: on a case-insensitive filesystem two casings name
    // one file, so a user who writes the wrong casing in a scope rule gets no
    // match rather than a surprising one. That is the safe failure.
    expect(normalizeRelativePath("SRC/Foo.ts")).toBe("SRC/Foo.ts");
    expect(normalizeRelativePath("SRC/Foo.ts")).not.toBe(normalizeRelativePath("src/foo.ts"));
  });
});

describe("the canonical form: what it refuses", () => {
  it.each([
    ["an absolute POSIX path", "/etc/passwd"],
    ["a Windows drive path", `C:${BS}Windows${BS}x.txt`],
    ["a parent traversal", "../outside.ts"],
    ["an embedded traversal", "src/../../outside.ts"],
    ["a bare parent", ".."],
  ])("refuses %s rather than canonicalizing it", (_label, input) => {
    // A path that cannot be made repository-relative is an error, not a value to
    // be cleaned up. Silently producing something plausible is how a scope rule
    // would come to cover a file outside the repository.
    expect(() => normalizeRelativePath(input)).toThrow();
  });

  it("refuses an empty string", () => {
    expect(() => normalizeRelativePath("")).toThrow();
  });
});

describe("rename aliases canonicalize as a SET", () => {
  it("sorts, dedupes, and canonicalizes every member", () => {
    // A change group owns every path it has ever had. The set is what group
    // identity is derived from, so its canonical form has to be order- and
    // duplicate-independent or two recordings of one rename would produce two
    // different group ids.
    expect(
      normalizePathArray([
        `payments${BS}webhook.ts`,
        "./utils/webhook.ts",
        "payments/webhook.ts",
        "utils//webhook.ts",
      ]),
    ).toEqual(["payments/webhook.ts", "utils/webhook.ts"]);
  });

  it("is insensitive to the order the aliases arrive in", () => {
    const forward = normalizePathArray(["utils/webhook.ts", "payments/webhook.ts"]);
    const reverse = normalizePathArray(["payments/webhook.ts", "utils/webhook.ts"]);
    expect(forward).toEqual(reverse);
  });

  it("a Windows-recorded rename and a POSIX-recorded one give the same set", () => {
    // The cross-platform property, at the level group identity actually uses.
    // `contribution_sha256` is NOT comparable across platforms by design, but
    // the alias set is, and scope matching depends on that.
    expect(normalizePathArray([`payments${BS}webhook.ts`, `utils${BS}webhook.ts`])).toEqual(
      normalizePathArray(["payments/webhook.ts", "utils/webhook.ts"]),
    );
  });

  it("an empty set stays empty rather than becoming a sentinel", () => {
    expect(normalizePathArray([])).toEqual([]);
  });
});
