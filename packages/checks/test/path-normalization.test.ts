// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for normalizePathSeparators.
//
// Locks the LIMITED-SCOPE contract: separator normalization ONLY. The
// helper MUST NOT canonicalize, sanitize, or strip "."/".."/absolute
// segments — those concerns belong to schema validation
// (safeStoredRelativePath in @viberevert/session-format). A "fix" that
// accidentally added "more" normalization would mask schema-validation
// issues and let unsafe paths slip through downstream consumers; the
// negative tests below catch that.

import { describe, expect, it } from "vitest";

import { normalizePathSeparators } from "../src/path-normalization.js";

describe("normalizePathSeparators", () => {
  it("replaces a single backslash with a forward slash", () => {
    expect(normalizePathSeparators("a\\b")).toBe("a/b");
  });

  it("replaces multiple backslashes globally", () => {
    expect(normalizePathSeparators("apps\\web\\.env.example")).toBe("apps/web/.env.example");
  });

  it("returns POSIX input unchanged", () => {
    // Locks value-equality for already-POSIX input. The implementation
    // has a no-allocation fast path (see path-normalization.ts), but
    // `toBe` on a string primitive only proves value-equality, not
    // allocation behavior, so the test name does not claim more than
    // it can verify.
    const input = "apps/web/.env.example";
    expect(normalizePathSeparators(input)).toBe(input);
  });

  it("returns the empty string unchanged", () => {
    expect(normalizePathSeparators("")).toBe("");
  });

  it("handles mixed separators (replaces backslashes only)", () => {
    expect(normalizePathSeparators("apps\\web/sub\\file.ts")).toBe("apps/web/sub/file.ts");
  });

  it("does NOT canonicalize '..' segments (separator-only contract)", () => {
    // The helper translates separators; schema validation
    // (safeStoredRelativePath) is responsible for rejecting traversal.
    // A test asserting `..` was stripped would lock the wrong contract
    // and mask schema-validation failures downstream.
    expect(normalizePathSeparators("..\\foo\\bar")).toBe("../foo/bar");
    expect(normalizePathSeparators("foo\\..\\bar")).toBe("foo/../bar");
  });

  it("does NOT canonicalize '.' segments", () => {
    expect(normalizePathSeparators(".\\foo")).toBe("./foo");
    expect(normalizePathSeparators("foo\\.\\bar")).toBe("foo/./bar");
  });

  it("does NOT strip leading slashes (absolute paths pass through with normalized separators)", () => {
    // Schema validation rejects absolute paths; this helper's job is
    // separator translation only. Stripping the leading character
    // would silently hide an invalid-input bug from downstream
    // schema validation.
    expect(normalizePathSeparators("\\absolute\\path")).toBe("/absolute/path");
    expect(normalizePathSeparators("/already-posix-absolute")).toBe("/already-posix-absolute");
  });

  it("preserves Windows drive-letter shapes (separators only — schema rejects drive letters)", () => {
    // The helper does NOT remove the drive letter or the colon. If a
    // caller passes a Windows absolute path, downstream schema
    // validation rejects it with a clear message. Locking this
    // behavior prevents a future "fix" from silently stripping drive
    // letters and letting otherwise-invalid paths through.
    expect(normalizePathSeparators("C:\\Users\\me\\file.ts")).toBe("C:/Users/me/file.ts");
  });
});
