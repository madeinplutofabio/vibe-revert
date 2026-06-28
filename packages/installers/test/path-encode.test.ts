// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { describe, expect, it } from "vitest";

import { encodeBackupPath } from "../src/path-encode.js";

describe("encodeBackupPath", () => {
  it("returns the <sha12>--<basename> shape", () => {
    expect(encodeBackupPath(".cursor/mcp.json")).toMatch(/^[0-9a-f]{12}--mcp\.json$/);
  });
  it("is deterministic (same input -> same output)", () => {
    expect(encodeBackupPath(".cursor/mcp.json")).toBe(encodeBackupPath(".cursor/mcp.json"));
  });
  it("uses POSIX basename (forward slashes only, regardless of platform)", () => {
    // Adapter PathSpec.pathRelative is POSIX-style. encodeBackupPath
    // uses posix.basename so the output is platform-independent.
    expect(encodeBackupPath("a/b/c/file.txt").endsWith("--file.txt")).toBe(true);
  });
  it("uses 12 lowercase hex characters for the SHA prefix", () => {
    expect(encodeBackupPath("foo.txt").slice(0, 12)).toMatch(/^[0-9a-f]{12}$/);
  });
  it("emits literal '--' separator between SHA prefix and basename", () => {
    expect(encodeBackupPath("foo.txt").slice(12, 14)).toBe("--");
  });
  it("different paths with the same basename produce different prefixes (for these samples)", () => {
    // SHA-256 collision over 48 bits is mathematically possible but
    // practically negligible. These two sample inputs (.cursor/mcp.json
    // vs .config/mcp.json) do not collide; the test asserts the
    // property for these specific samples, not a universal
    // collision-impossibility guarantee.
    //
    // Note: ".mcp.json" cannot be used as a contrasting sample
    // because posix.basename(".mcp.json") is ".mcp.json", not
    // "mcp.json" -- the leading dot is part of the basename.
    const a = encodeBackupPath(".cursor/mcp.json");
    const b = encodeBackupPath(".config/mcp.json");
    expect(a.slice(0, 12)).not.toBe(b.slice(0, 12));
    expect(a.endsWith("--mcp.json")).toBe(true);
    expect(b.endsWith("--mcp.json")).toBe(true);
  });
  it("handles a bare filename (no directory component)", () => {
    expect(encodeBackupPath("mcp.json")).toMatch(/^[0-9a-f]{12}--mcp\.json$/);
  });
  it("handles a deeply nested path", () => {
    expect(encodeBackupPath("a/b/c/d/e/f/deep.txt").endsWith("--deep.txt")).toBe(true);
  });
});
