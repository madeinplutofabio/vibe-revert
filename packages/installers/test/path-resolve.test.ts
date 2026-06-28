// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePath } from "../src/path-resolve.js";

describe("resolvePath", () => {
  it("joins POSIX pathRelative under repoRoot using platform separator", () => {
    expect(resolvePath({ pathRelative: ".cursor/mcp.json" }, { repoRoot: "home/user/repo" })).toBe(
      join("home/user/repo", ".cursor", "mcp.json"),
    );
  });
  it("handles single-segment pathRelative", () => {
    expect(resolvePath({ pathRelative: "README.md" }, { repoRoot: "repo" })).toBe(
      join("repo", "README.md"),
    );
  });
  it("handles multi-segment pathRelative", () => {
    expect(resolvePath({ pathRelative: "a/b/c.txt" }, { repoRoot: "repo" })).toBe(
      join("repo", "a", "b", "c.txt"),
    );
  });
  it("joins dot-containing segments literally (no special-casing; trusts PathSpecSchema validation)", () => {
    // resolvePath does NOT validate or sanitize. PathSpecSchema owns
    // path-safety enforcement (no traversal, etc.). resolvePath
    // simply joins segments; a segment like "foo.bar" is just a name.
    expect(resolvePath({ pathRelative: "foo.bar/baz" }, { repoRoot: "repo" })).toBe(
      join("repo", "foo.bar", "baz"),
    );
  });
  it("accepts structural typing (extra fields on spec are ignored)", () => {
    // The signature uses { readonly pathRelative: string } and
    // { readonly repoRoot: string } so any object with the right
    // shape works (e.g., a full PathSpec with scope + pathTemplate).
    const spec = {
      pathRelative: ".cursor/mcp.json",
      pathTemplate: "{repo}/.cursor/mcp.json",
      scope: "repo" as const,
    };
    const ctx = { repoRoot: "repo" };
    expect(resolvePath(spec, ctx)).toBe(join("repo", ".cursor", "mcp.json"));
  });
});
