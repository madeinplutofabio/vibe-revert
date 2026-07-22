// packages/cli/test/license-adapter.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Boundary tests for the pnpm v9 lockfile adapter (scripts/license-lockfile-v9.ts):
// structural rejections and invalid limits; the resolved graph with section→posture
// mapping; resolution source-kind classification (registry/directory/git/tarball-url
// plus contradictory and unknown rejection); the peer-suffix split (suffix-free
// packages keys vs peer-qualified snapshot instances mapping back to the suffix-free
// packageKey, with malformed suffixes failing closed); snapshot edge resolution
// (registry edge accepted, link: rejected); the manifest↔lockfile bijection in both
// directions (missing importer either way, section and spec mismatches, unresolved
// manifest declaration, lockfile-only dependency); unresolved peer surfacing vs a peer
// resolved in a lockfile section; and first-party link: resolution including a target
// that escapes the repository root.

import { describe, expect, it } from "vitest";

import type { LockfileGraph } from "../../../scripts/license-audit-core.js";
import {
  type AdapterLimits,
  type NormalizedManifestDecl,
  parsePnpmLockfileV9,
} from "../../../scripts/license-lockfile-v9.js";

function manifest(overrides: Partial<NormalizedManifestDecl> = {}): NormalizedManifestDecl {
  return {
    importerPath: ".",
    manifestPath: "package.json",
    packageName: null,
    dependencies: [],
    optionalDependencies: [],
    devDependencies: [],
    peerDependencies: [],
    ...overrides,
  };
}

function lockfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lockfileVersion: "9.0",
    importers: { ".": {} },
    packages: {},
    snapshots: {},
    ...overrides,
  };
}

function fooLockfile(
  resolution: Record<string, unknown> = { integrity: "sha512-abc" },
): Record<string, unknown> {
  return lockfile({
    importers: { ".": { dependencies: { foo: { specifier: "^1.0.0", version: "1.0.0" } } } },
    packages: { "foo@1.0.0": { resolution } },
    snapshots: { "foo@1.0.0": {} },
  });
}

const fooManifest = [manifest({ dependencies: [{ name: "foo", declaredSpec: "^1.0.0" }] })];

function errs(
  lf: unknown,
  manifests: readonly NormalizedManifestDecl[],
  limits?: Partial<AdapterLimits>,
): string[] {
  const r = parsePnpmLockfileV9(lf, manifests, limits);
  if (r.ok) {
    throw new Error("expected adapter parse to fail");
  }
  return r.errors.map((e) => e.code);
}

function graphOf(lf: unknown, manifests: readonly NormalizedManifestDecl[]): LockfileGraph {
  const r = parsePnpmLockfileV9(lf, manifests);
  if (!r.ok) {
    throw new Error(`expected success but failed: ${r.errors.map((e) => e.code).join(", ")}`);
  }
  return r.graph;
}

describe("parsePnpmLockfileV9 — structural rejections", () => {
  it("rejects a non-object lockfile", () => {
    expect(errs(null, [])).toContain("LOCKFILE_MALFORMED");
  });

  it("rejects an unsupported lockfile version", () => {
    expect(errs(lockfile({ lockfileVersion: "8.0" }), [])).toContain(
      "LOCKFILE_UNSUPPORTED_VERSION",
    );
  });

  it("rejects a missing importers section", () => {
    expect(errs({ lockfileVersion: "9.0" }, [])).toContain("LOCKFILE_MALFORMED");
  });

  it("rejects invalid adapter limits", () => {
    expect(errs(lockfile(), [], { maxManifestDeclarations: 0 })).toContain(
      "ADAPTER_LIMITS_INVALID",
    );
  });
});

describe("parsePnpmLockfileV9 — valid graph", () => {
  it("builds roots, snapshots, and packages for a resolved production dependency", () => {
    const g = graphOf(fooLockfile(), fooManifest);
    expect(g.roots).toEqual([
      {
        kind: "resolved",
        importerPath: ".",
        name: "foo",
        snapshotKey: "foo@1.0.0",
        posture: "production",
      },
    ]);
    expect(g.packages.get("foo@1.0.0")).toMatchObject({
      name: "foo",
      version: "1.0.0",
      integrity: "sha512-abc",
      sourceKind: "registry",
      tarballUrl: null,
    });
    expect(g.snapshots.has("foo@1.0.0")).toBe(true);
    expect(g.firstParty).toEqual([]);
    expect(g.unresolvedPeers).toEqual([]);
  });

  it("maps each manifest section to its posture", () => {
    const lf = lockfile({
      importers: {
        ".": {
          dependencies: { p: { specifier: "1", version: "1.0.0" } },
          optionalDependencies: { o: { specifier: "1", version: "1.0.0" } },
          devDependencies: { d: { specifier: "1", version: "1.0.0" } },
        },
      },
      packages: {
        "p@1.0.0": { resolution: { integrity: "sha512-p" } },
        "o@1.0.0": { resolution: { integrity: "sha512-o" } },
        "d@1.0.0": { resolution: { integrity: "sha512-d" } },
      },
      snapshots: { "p@1.0.0": {}, "o@1.0.0": {}, "d@1.0.0": {} },
    });
    const m = [
      manifest({
        dependencies: [{ name: "p", declaredSpec: "1" }],
        optionalDependencies: [{ name: "o", declaredSpec: "1" }],
        devDependencies: [{ name: "d", declaredSpec: "1" }],
      }),
    ];
    const byName = new Map(graphOf(lf, m).roots.map((r) => [r.name, r.posture]));
    expect(byName.get("p")).toBe("production");
    expect(byName.get("o")).toBe("optional-production");
    expect(byName.get("d")).toBe("development");
  });
});

describe("parsePnpmLockfileV9 — package source-kind classification", () => {
  it("classifies directory, git, and tarball-url resolutions", () => {
    expect(
      graphOf(fooLockfile({ type: "directory" }), fooManifest).packages.get("foo@1.0.0")
        ?.sourceKind,
    ).toBe("directory");
    expect(
      graphOf(fooLockfile({ type: "git" }), fooManifest).packages.get("foo@1.0.0")?.sourceKind,
    ).toBe("git");
    const g = graphOf(fooLockfile({ tarball: "https://example.com/foo.tgz" }), fooManifest);
    expect(g.packages.get("foo@1.0.0")).toMatchObject({
      sourceKind: "tarball-url",
      tarballUrl: "https://example.com/foo.tgz",
    });
  });

  it("rejects contradictory and unknown resolutions", () => {
    expect(errs(fooLockfile({ type: "git", tarball: "https://x/y.tgz" }), fooManifest)).toContain(
      "LOCKFILE_PACKAGE_UNSUPPORTED_RESOLUTION",
    );
    expect(errs(fooLockfile({ type: "svn" }), fooManifest)).toContain(
      "LOCKFILE_PACKAGE_UNSUPPORTED_RESOLUTION",
    );
  });
});

describe("parsePnpmLockfileV9 — peer-suffix split (packages vs snapshots)", () => {
  it("rejects a packages key that carries a peer suffix", () => {
    const lf = lockfile({
      packages: { "foo@1.0.0(bar@2.0.0)": { resolution: { integrity: "x" } } },
    });
    expect(errs(lf, [])).toContain("LOCKFILE_PACKAGE_KEY_INVALID");
  });

  it("accepts a peer-suffixed snapshot key while keeping the package key suffix-free", () => {
    const lf = lockfile({
      importers: {
        ".": { dependencies: { foo: { specifier: "1", version: "1.0.0(bar@2.0.0)" } } },
      },
      packages: {
        "foo@1.0.0": { resolution: { integrity: "sha512-foo" } },
        "bar@2.0.0": { resolution: { integrity: "sha512-bar" } },
      },
      snapshots: { "foo@1.0.0(bar@2.0.0)": {}, "bar@2.0.0": {} },
    });
    const g = graphOf(lf, [manifest({ dependencies: [{ name: "foo", declaredSpec: "1" }] })]);
    expect(g.roots).toEqual([
      {
        kind: "resolved",
        importerPath: ".",
        name: "foo",
        snapshotKey: "foo@1.0.0(bar@2.0.0)",
        posture: "production",
      },
    ]);
    expect(g.snapshots.get("foo@1.0.0(bar@2.0.0)")?.packageKey).toBe("foo@1.0.0");
    expect(g.packages.has("foo@1.0.0")).toBe(true);
  });

  it("rejects malformed peer-suffixed snapshot keys", () => {
    for (const snapshotKey of [
      "foo@1.0.0(",
      "foo@1.0.0)",
      "foo@1.0.0()",
      "foo@1.0.0(bar@2.0.0",
      "foo@1.0.0(bar@2.0.0))",
    ]) {
      const lf = lockfile({
        importers: {
          ".": {
            dependencies: { foo: { specifier: "1", version: snapshotKey.slice("foo@".length) } },
          },
        },
        packages: { "foo@1.0.0": { resolution: { integrity: "sha512-foo" } } },
        snapshots: { [snapshotKey]: {} },
      });
      expect(
        errs(lf, [manifest({ dependencies: [{ name: "foo", declaredSpec: "1" }] })]),
      ).toContain("LOCKFILE_SNAPSHOT_KEY_INVALID");
    }
  });
});

describe("parsePnpmLockfileV9 — snapshot edges", () => {
  it("resolves a registry dependency edge to the target snapshot", () => {
    const lf = lockfile({
      importers: { ".": { dependencies: { foo: { specifier: "1", version: "1.0.0" } } } },
      packages: {
        "foo@1.0.0": { resolution: { integrity: "x" } },
        "bar@2.0.0": { resolution: { integrity: "y" } },
      },
      snapshots: { "foo@1.0.0": { dependencies: { bar: "2.0.0" } }, "bar@2.0.0": {} },
    });
    const g = graphOf(lf, [manifest({ dependencies: [{ name: "foo", declaredSpec: "1" }] })]);
    expect(g.snapshots.get("foo@1.0.0")?.dependencies).toEqual([
      { name: "bar", snapshotKey: "bar@2.0.0" },
    ]);
  });

  it("rejects a link: reference inside a snapshot edge", () => {
    const lf = lockfile({
      importers: { ".": { dependencies: { foo: { specifier: "1", version: "1.0.0" } } } },
      packages: { "foo@1.0.0": { resolution: { integrity: "x" } } },
      snapshots: { "foo@1.0.0": { dependencies: { bar: "link:../bar" } } },
    });
    expect(errs(lf, [manifest({ dependencies: [{ name: "foo", declaredSpec: "1" }] })])).toContain(
      "LOCKFILE_DEPENDENCY_REFERENCE_INVALID",
    );
  });
});

describe("parsePnpmLockfileV9 — manifest/lockfile cross-validation", () => {
  it("rejects a manifest importer with no lockfile importer", () => {
    expect(
      errs(lockfile({ importers: {} }), [
        manifest({ dependencies: [{ name: "foo", declaredSpec: "1" }] }),
      ]),
    ).toContain("LOCKFILE_IMPORTER_MISSING_FOR_MANIFEST");
  });

  it("rejects a lockfile importer with no manifest", () => {
    expect(errs(lockfile(), [])).toContain("MANIFEST_MISSING_FOR_LOCKFILE_IMPORTER");
  });

  it("rejects a section mismatch and a spec mismatch", () => {
    const sectionLf = lockfile({
      importers: { ".": { devDependencies: { foo: { specifier: "1", version: "1.0.0" } } } },
      packages: { "foo@1.0.0": { resolution: { integrity: "x" } } },
      snapshots: { "foo@1.0.0": {} },
    });
    expect(
      errs(sectionLf, [manifest({ dependencies: [{ name: "foo", declaredSpec: "1" }] })]),
    ).toContain("LOCKFILE_IMPORTER_SECTION_MISMATCH");
    expect(
      errs(fooLockfile(), [manifest({ dependencies: [{ name: "foo", declaredSpec: "^2.0.0" }] })]),
    ).toContain("LOCKFILE_IMPORTER_SPEC_MISMATCH");
  });

  it("rejects a manifest declaration absent from the lockfile and a lockfile-only dependency", () => {
    expect(
      errs(lockfile({ importers: { ".": {} } }), [
        manifest({ dependencies: [{ name: "bar", declaredSpec: "1" }] }),
      ]),
    ).toContain("MANIFEST_DECLARATION_UNRESOLVED");
    const lockfileOnly = lockfile({
      importers: { ".": { dependencies: { foo: { specifier: "1", version: "1.0.0" } } } },
      packages: { "foo@1.0.0": { resolution: { integrity: "x" } } },
      snapshots: { "foo@1.0.0": {} },
    });
    expect(errs(lockfileOnly, [manifest()])).toContain("LOCKFILE_IMPORTER_DECLARATION_MISSING");
  });
});

describe("parsePnpmLockfileV9 — peers", () => {
  it("surfaces an unresolved peer dependency", () => {
    const g = graphOf(lockfile({ importers: { ".": {} } }), [
      manifest({ peerDependencies: [{ name: "react", declaredSpec: "^18" }] }),
    ]);
    expect(g.unresolvedPeers).toEqual([
      { kind: "unresolved-peer", importerPath: ".", name: "react", declaredSpec: "^18" },
    ]);
  });

  it("rejects a manifest peer that resolves in a lockfile section", () => {
    const lf = lockfile({
      importers: { ".": { dependencies: { react: { specifier: "^18", version: "18.0.0" } } } },
      packages: { "react@18.0.0": { resolution: { integrity: "x" } } },
      snapshots: { "react@18.0.0": {} },
    });
    expect(
      errs(lf, [manifest({ peerDependencies: [{ name: "react", declaredSpec: "^18" }] })]),
    ).toContain("LOCKFILE_IMPORTER_SECTION_MISMATCH");
  });
});

describe("parsePnpmLockfileV9 — first-party links", () => {
  it("resolves a link: dependency to a workspace package", () => {
    const lf = lockfile({
      importers: {
        ".": {
          dependencies: {
            "@scope/lib": { specifier: "workspace:*", version: "link:packages/lib" },
          },
        },
        "packages/lib": {},
      },
    });
    const m = [
      manifest({ dependencies: [{ name: "@scope/lib", declaredSpec: "workspace:*" }] }),
      manifest({
        importerPath: "packages/lib",
        manifestPath: "packages/lib/package.json",
        packageName: "@scope/lib",
      }),
    ];
    const g = graphOf(lf, m);
    expect(g.firstParty).toEqual(["@scope/lib"]);
    expect(g.roots).toEqual([]);
  });

  it("rejects a link whose target package name mismatches", () => {
    const lf = lockfile({
      importers: {
        ".": {
          dependencies: {
            "@scope/lib": { specifier: "workspace:*", version: "link:packages/lib" },
          },
        },
        "packages/lib": {},
      },
    });
    const m = [
      manifest({ dependencies: [{ name: "@scope/lib", declaredSpec: "workspace:*" }] }),
      manifest({
        importerPath: "packages/lib",
        manifestPath: "packages/lib/package.json",
        packageName: "@scope/other",
      }),
    ];
    expect(errs(lf, m)).toContain("FIRST_PARTY_TARGET_NAME_MISMATCH");
  });

  it("rejects a link target that escapes the repository root", () => {
    const lf = lockfile({
      importers: {
        ".": { dependencies: { lib: { specifier: "workspace:*", version: "link:../evil" } } },
      },
    });
    expect(
      errs(lf, [manifest({ dependencies: [{ name: "lib", declaredSpec: "workspace:*" }] })]),
    ).toContain("FIRST_PARTY_TARGET_UNRESOLVED");
  });
});
