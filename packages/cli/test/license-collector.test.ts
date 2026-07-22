// packages/cli/test/license-collector.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Tests for the filesystem collector (scripts/license-collector.ts): the pure
// extractManifestDeclaration (importer path, package name, section extraction, and
// its malformed-input rejections), and the two I/O entry points collectLockfileGraph
// / collectLicenseInputs against real os.tmpdir() workspace fixtures — the happy path
// (read + strict parse + SHA-256 of pnpm-lock.yaml, workspace manifests, policy, and
// metadata) and the read/decode/parse/limit failures (missing lockfile, invalid
// UTF-8, duplicate YAML key, duplicate JSON key, invalid limits, non-directory root).
// The symlinked-committed-input rejection is tested on platforms where symlink
// creation is reliable; it is skipped on Windows, which requires elevation to create
// symlinks.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectLicenseInputs,
  collectLockfileGraph,
  extractManifestDeclaration,
} from "../../../scripts/license-collector.js";

const LOCKFILE = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo:
        specifier: '^1.0.0'
        version: 1.0.0
  packages/lib: {}
packages:
  foo@1.0.0:
    resolution:
      integrity: sha512-abc
snapshots:
  foo@1.0.0: {}
`;

function baseFiles(
  overrides: Record<string, string | Buffer> = {},
): Record<string, string | Buffer> {
  return {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": JSON.stringify({ name: "root", dependencies: { foo: "^1.0.0" } }),
    "packages/lib/package.json": JSON.stringify({ name: "@scope/lib" }),
    "pnpm-lock.yaml": LOCKFILE,
    "license-policy.json": JSON.stringify({ schemaVersion: 1, dispositions: {} }),
    "license-metadata.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    ...overrides,
  };
}

const created: string[] = [];

afterEach(() => {
  for (const root of created) {
    rmSync(root, { recursive: true, force: true });
  }
  created.length = 0;
});

function makeRepo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "license-collector-"));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("extractManifestDeclaration", () => {
  it("normalizes a manifest into declarations with importerPath from the path", () => {
    const r = extractManifestDeclaration("packages/lib/package.json", {
      name: "@scope/lib",
      dependencies: { foo: "^1" },
      devDependencies: { bar: "^2" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decl).toMatchObject({
        importerPath: "packages/lib",
        manifestPath: "packages/lib/package.json",
        packageName: "@scope/lib",
        dependencies: [{ name: "foo", declaredSpec: "^1" }],
        devDependencies: [{ name: "bar", declaredSpec: "^2" }],
      });
    }
  });

  it("uses '.' importerPath for the root manifest and null packageName when absent", () => {
    const r = extractManifestDeclaration("package.json", { dependencies: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decl.importerPath).toBe(".");
      expect(r.decl.packageName).toBeNull();
    }
  });

  it("rejects a non-object manifest", () => {
    const r = extractManifestDeclaration("package.json", null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("MANIFEST_NOT_OBJECT");
    }
  });

  it("rejects a non-string name, non-object section, and non-string specifier", () => {
    const codes = (content: unknown): string[] => {
      const r = extractManifestDeclaration("package.json", content);
      return r.ok ? [] : r.errors.map((e) => e.code);
    };
    expect(codes({ name: 42 })).toContain("MANIFEST_NAME_INVALID");
    expect(codes({ dependencies: [] })).toContain("MANIFEST_SECTION_MALFORMED");
    expect(codes({ dependencies: { foo: 1 } })).toContain("MANIFEST_SPEC_INVALID");
  });
});

describe("collectLicenseInputs / collectLockfileGraph — happy path", () => {
  it("reads, parses, and hashes all four committed inputs", () => {
    const r = collectLicenseInputs(makeRepo(baseFiles()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inputs.graph.roots.map((x) => x.name)).toContain("foo");
      expect(r.inputs.graph.packages.has("foo@1.0.0")).toBe(true);
      expect(r.inputs.policy.schemaVersion).toBe(1);
      expect(r.inputs.cache.entries).toEqual([]);
      for (const h of Object.values(r.inputs.hashes)) {
        expect(h).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("collectLockfileGraph collects the graph without needing policy or metadata", () => {
    const files = baseFiles();
    delete files["license-policy.json"];
    delete files["license-metadata.json"];
    const r = collectLockfileGraph(makeRepo(files));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.packages.has("foo@1.0.0")).toBe(true);
    }
  });
});

describe("collectLicenseInputs — read, decode, parse, and limit failures", () => {
  it("fails when the lockfile is missing", () => {
    const files = baseFiles();
    delete files["pnpm-lock.yaml"];
    const r = collectLicenseInputs(makeRepo(files));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("LOCKFILE_READ_ERROR");
    }
  });

  it("rejects invalid UTF-8 in the lockfile", () => {
    const r = collectLicenseInputs(
      makeRepo(baseFiles({ "pnpm-lock.yaml": Buffer.from([0xff, 0xff, 0xff]) })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("LOCKFILE_UTF8_INVALID");
    }
  });

  it("rejects a duplicate mapping key in the lockfile YAML", () => {
    const dup =
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n";
    const r = collectLicenseInputs(makeRepo(baseFiles({ "pnpm-lock.yaml": dup })));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("LOCKFILE_YAML_DUPLICATE_KEY");
    }
  });

  it("rejects a duplicate key in the policy JSON", () => {
    const r = collectLicenseInputs(
      makeRepo(
        baseFiles({
          "license-policy.json": '{"schemaVersion":1,"schemaVersion":1,"dispositions":{}}',
        }),
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("POLICY_JSON_DUPLICATE_KEY");
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked committed input", () => {
    const root = makeRepo(baseFiles());
    rmSync(join(root, "license-policy.json"));
    symlinkSync(join(root, "package.json"), join(root, "license-policy.json"));
    const r = collectLicenseInputs(root);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("POLICY_INPUT_SYMLINK");
    }
  });

  it("rejects invalid collector limits", () => {
    const r = collectLicenseInputs(makeRepo(baseFiles()), {
      collectorLimits: { maxLockfileBytes: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("COLLECTOR_LIMITS_INVALID");
    }
  });

  it("rejects a non-directory repository root", () => {
    const root = makeRepo(baseFiles());
    const r = collectLicenseInputs(join(root, "package.json"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("REPO_ROOT_NOT_DIRECTORY");
    }
  });
});
