// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// MCP Registry invariants. The official registry verifies npm package ownership
// by reading `mcpName` from the PUBLISHED package.json and requiring it to equal
// server.json's `name`; it also treats server.json as the launch record clients
// use to start the server. Both failure modes are invisible to typecheck, lint,
// and every runtime test:
//
//   - an identity mismatch surfaces only when `mcp-publisher` rejects the
//     publish, by which point the npm release has already shipped;
//   - a stale launch record is worse, because it publishes cleanly and then
//     starts the wrong process on a user's machine.
//
// These checks make both a build-time invariant instead.
//
// NOT asserted here: that server.json's version equals packages/cli's version.
// Those legitimately diverge between "changesets bumped the package" and
// "server.json was pointed at the newly published version". Aligning them is a
// release-checklist step, not a repository invariant. What IS asserted is that
// the two versions inside server.json never drift from each other.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const REPO_ROOT_URL = new URL("../../../", import.meta.url);

interface PackageArgument {
  type: string;
  value: string;
}
interface ServerPackage {
  registryType: string;
  identifier: string;
  version: string;
  transport?: { type: string };
  packageArguments?: readonly PackageArgument[];
}
interface ServerJson {
  name: string;
  version: string;
  packages: readonly ServerPackage[];
}
interface CliPackageJson {
  name: string;
  mcpName?: string;
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(new URL(rel, REPO_ROOT_URL), "utf8")) as T;
}

const server = readJson<ServerJson>("server.json");
const cliPkg = readJson<CliPackageJson>("packages/cli/package.json");

describe("MCP Registry invariants", () => {
  it("packages/cli/package.json mcpName equals server.json name", () => {
    expect(cliPkg.mcpName).toBe(server.name);
  });

  it("the canonical name stays on the locked reverse-DNS namespace", () => {
    expect(server.name).toBe("com.viberevert/viberevert");
  });

  it("every declared package version matches the server version", () => {
    expect(server.packages.length).toBeGreaterThan(0);
    for (const pkg of server.packages) {
      expect(pkg.version).toBe(server.version);
    }
  });

  it("the npm identifier is the published CLI package name", () => {
    const npm = server.packages.filter((p) => p.registryType === "npm");
    expect(npm.length).toBeGreaterThan(0);
    for (const p of npm) {
      expect(p.identifier).toBe(cliPkg.name);
    }
  });

  it("declares the published CLI's MCP stdio entrypoint", () => {
    const npm = server.packages.filter((p) => p.registryType === "npm");
    expect(npm).toHaveLength(1);
    expect(npm[0]?.transport).toEqual({ type: "stdio" });
    expect(npm[0]?.packageArguments).toEqual([
      { type: "positional", value: "mcp" },
      { type: "positional", value: "serve" },
    ]);
  });

  it("the registry description stays within the schema's 100-character cap", () => {
    const description = readJson<{ description: string }>("server.json").description;
    expect(description.length).toBeLessThanOrEqual(100);
  });
});
