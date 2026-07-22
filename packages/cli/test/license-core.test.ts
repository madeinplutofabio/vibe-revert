// packages/cli/test/license-core.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Boundary tests for the pure audit core (scripts/license-audit-core.ts): the posture
// lattice (maxPosture) and the fixed edge-transition table; computeReachability's
// transitive propagation and strongest-posture merge across multiple paths; and
// buildAuditModel's fail-closed contracts — invalid limits, referential integrity,
// duplicate cache identities (registry + unsupported), malformed unresolved peers,
// cache entries unreferenced by the lockfile, reachable packages with
// missing/integrity-mismatched metadata, unmapped SPDX defaulting to review-required,
// well-formed unresolved peers surfaced (not failed), and contradictory instance
// metadata aggregating to a single review-required row (ADR decision 6).

import { describe, expect, it } from "vitest";

import {
  type BuildInput,
  type BuildResult,
  buildAuditModel,
  type CollectedRegistryMetadata,
  computeReachability,
  DEFAULT_GRAPH_LIMITS,
  type FailedUnsupportedMetadata,
  type InputHashes,
  type LockfileGraph,
  type LockfilePackageIdentity,
  maxPosture,
  type Policy,
  type PolicyEntry,
  type Posture,
  type ResolvedRootEdge,
  type SnapshotNode,
  transition,
  type UnresolvedPeerRoot,
} from "../../../scripts/license-audit-core.js";

const HASHES: InputHashes = {
  lockfileSha256: "a".repeat(64),
  manifestsSha256: "b".repeat(64),
  policySha256: "c".repeat(64),
  metadataSha256: "d".repeat(64),
};

function emptyGraph(overrides: Partial<LockfileGraph> = {}): LockfileGraph {
  return {
    roots: [],
    unresolvedPeers: [],
    snapshots: new Map(),
    packages: new Map(),
    firstParty: [],
    ...overrides,
  };
}

function registryIdentity(
  overrides: Partial<LockfilePackageIdentity> = {},
): LockfilePackageIdentity {
  return {
    packageKey: "foo@1.0.0",
    name: "foo",
    version: "1.0.0",
    integrity: "sha512-abc",
    sourceKind: "registry",
    tarballUrl: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    name: "foo",
    version: "1.0.0",
    packageKey: "foo@1.0.0",
    dependencies: [],
    optionalDependencies: [],
    ...overrides,
  };
}

function resolvedRoot(overrides: Partial<ResolvedRootEdge> = {}): ResolvedRootEdge {
  return {
    kind: "resolved",
    importerPath: ".",
    name: "foo",
    snapshotKey: "foo@1.0.0",
    posture: "production",
    ...overrides,
  };
}

function unresolvedPeer(overrides: Partial<UnresolvedPeerRoot> = {}): UnresolvedPeerRoot {
  return {
    kind: "unresolved-peer",
    importerPath: ".",
    name: "react",
    declaredSpec: "^18",
    ...overrides,
  };
}

function graphWithFoo(posture: Posture = "production"): LockfileGraph {
  return {
    roots: [resolvedRoot({ posture })],
    unresolvedPeers: [],
    snapshots: new Map([["foo@1.0.0", snapshot()]]),
    packages: new Map([["foo@1.0.0", registryIdentity()]]),
    firstParty: [],
  };
}

function collected(overrides: Partial<CollectedRegistryMetadata> = {}): CollectedRegistryMetadata {
  return {
    collectionStatus: "collected",
    name: "foo",
    version: "1.0.0",
    integrity: "sha512-abc",
    collectionReason: null,
    retrievalSource: "registry-tarball",
    tarballIntegrity: "sha512-abc",
    rawLicensePresent: true,
    rawLicense: "MIT",
    normalizedSpdx: "MIT",
    licenseMetadataSource: "packaged-package-json",
    packagedLegalFiles: ["LICENSE"],
    ...overrides,
  };
}

function failedUnsupported(
  overrides: Partial<FailedUnsupportedMetadata> = {},
): FailedUnsupportedMetadata {
  return {
    collectionStatus: "failed",
    packageKey: "git-pkg@1.0.0",
    collectionReason: "git source is unsupported",
    retrievalSource: null,
    ...overrides,
  };
}

function policyWith(entries: Record<string, PolicyEntry> = {}): Policy {
  return { schemaVersion: 1, dispositions: new Map(Object.entries(entries)) };
}

function build(overrides: Partial<BuildInput>): BuildResult {
  return buildAuditModel({
    graph: emptyGraph(),
    cache: { schemaVersion: 1, entries: [] },
    policy: policyWith(),
    hashes: HASHES,
    generatorSchemaVersion: 1,
    ...overrides,
  });
}

function errorCodes(r: BuildResult): string[] {
  if (r.ok) {
    throw new Error("expected build to fail");
  }
  return r.errors.map((e) => e.code);
}

describe("maxPosture", () => {
  it("orders production > optional-production > peer > development and is commutative", () => {
    expect(maxPosture("production", "development")).toBe("production");
    expect(maxPosture("optional-production", "peer")).toBe("optional-production");
    expect(maxPosture("peer", "development")).toBe("peer");
    expect(maxPosture("development", "development")).toBe("development");
    expect(maxPosture("development", "production")).toBe("production");
    expect(maxPosture("peer", "optional-production")).toBe("optional-production");
  });
});

describe("transition", () => {
  it("propagates posture across required and optional edges per the fixed table", () => {
    expect(transition("production", "required")).toBe("production");
    expect(transition("production", "optional")).toBe("optional-production");
    expect(transition("optional-production", "required")).toBe("optional-production");
    expect(transition("optional-production", "optional")).toBe("optional-production");
    expect(transition("peer", "required")).toBe("peer");
    expect(transition("peer", "optional")).toBe("peer");
    expect(transition("development", "required")).toBe("development");
    expect(transition("development", "optional")).toBe("development");
  });
});

describe("computeReachability", () => {
  it("propagates transitively and keeps the strongest posture across multiple paths", () => {
    const graph: LockfileGraph = {
      roots: [
        resolvedRoot({ name: "prod-root", snapshotKey: "prod-root@1.0.0", posture: "production" }),
        resolvedRoot({
          importerPath: "dev-workspace",
          name: "shared",
          snapshotKey: "shared@1.0.0",
          posture: "development",
        }),
      ],
      unresolvedPeers: [],
      snapshots: new Map([
        [
          "prod-root@1.0.0",
          snapshot({
            name: "prod-root",
            packageKey: "prod-root@1.0.0",
            optionalDependencies: [{ name: "shared", snapshotKey: "shared@1.0.0" }],
          }),
        ],
        ["shared@1.0.0", snapshot({ name: "shared", packageKey: "shared@1.0.0" })],
      ]),
      packages: new Map([
        ["prod-root@1.0.0", registryIdentity({ packageKey: "prod-root@1.0.0", name: "prod-root" })],
        ["shared@1.0.0", registryIdentity({ packageKey: "shared@1.0.0", name: "shared" })],
      ]),
      firstParty: [],
    };
    const result = computeReachability(graph, DEFAULT_GRAPH_LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reach.get("prod-root@1.0.0")?.primaryPosture).toBe("production");
      // reached directly as development AND via prod-root's optional edge -> optional-production wins
      expect(result.reach.get("shared@1.0.0")?.primaryPosture).toBe("optional-production");
    }
  });
});

describe("buildAuditModel — fail-closed graph and cache guards", () => {
  it("rejects invalid graph limits", () => {
    expect(errorCodes(build({ limits: { maxPackages: 0 } }))).toContain("GRAPH_LIMITS_INVALID");
  });

  it("rejects a root referencing a missing snapshot", () => {
    const graph = emptyGraph({ roots: [resolvedRoot({ snapshotKey: "missing@1.0.0" })] });
    expect(errorCodes(build({ graph }))).toContain("GRAPH_ROOT_MISSING");
  });

  it("rejects a malformed unresolved peer", () => {
    const graph = emptyGraph({ unresolvedPeers: [unresolvedPeer({ declaredSpec: "" })] });
    expect(errorCodes(build({ graph }))).toContain("GRAPH_UNRESOLVED_PEER_MALFORMED");
  });

  it("rejects duplicate registry identities", () => {
    expect(
      errorCodes(build({ cache: { schemaVersion: 1, entries: [collected(), collected()] } })),
    ).toContain("CACHE_DUPLICATE_REGISTRY_IDENTITY");
  });

  it("rejects duplicate unsupported identities", () => {
    expect(
      errorCodes(
        build({ cache: { schemaVersion: 1, entries: [failedUnsupported(), failedUnsupported()] } }),
      ),
    ).toContain("CACHE_DUPLICATE_UNSUPPORTED_IDENTITY");
  });

  it("rejects a cache entry not referenced by the lockfile", () => {
    expect(errorCodes(build({ cache: { schemaVersion: 1, entries: [collected()] } }))).toContain(
      "CACHE_ENTRY_UNREFERENCED",
    );
  });

  it("rejects a reachable package with no cache entry", () => {
    expect(errorCodes(build({ graph: graphWithFoo() }))).toContain("CACHE_ENTRY_MISSING");
  });

  it("rejects a collected entry whose tarball integrity disagrees with the lockfile", () => {
    const r = build({
      graph: graphWithFoo(),
      cache: { schemaVersion: 1, entries: [collected({ tarballIntegrity: "sha512-other" })] },
      policy: policyWith({ MIT: { disposition: "allowed", obligations: [] } }),
    });
    expect(errorCodes(r)).toContain("CACHE_INTEGRITY_MISMATCH");
  });
});

describe("buildAuditModel — valid build and disposition", () => {
  it("produces one aggregated row for a reachable registry package", () => {
    const r = build({
      graph: graphWithFoo("production"),
      cache: { schemaVersion: 1, entries: [collected()] },
      policy: policyWith({
        MIT: { disposition: "allowed-with-obligations", obligations: ["include-license-text"] },
      }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.reachableSnapshotInstanceCount).toBe(1);
      expect(r.model.aggregatedPackageRowCount).toBe(1);
      expect(r.model.rows).toHaveLength(1);
      expect(r.model.rows[0]).toMatchObject({
        name: "foo",
        version: "1.0.0",
        primaryPosture: "production",
        policyDisposition: "allowed-with-obligations",
        metadataConflict: false,
      });
      expect(r.model.rows[0]?.aggregate?.normalizedSpdx).toBe("MIT");
    }
  });

  it("maps an unmapped SPDX to review-required without failing", () => {
    const r = build({
      graph: graphWithFoo(),
      cache: { schemaVersion: 1, entries: [collected()] },
      policy: policyWith(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.rows[0]?.policyDisposition).toBe("review-required");
    }
  });

  it("surfaces a well-formed unresolved peer without failing", () => {
    const r = build({ graph: emptyGraph({ unresolvedPeers: [unresolvedPeer()] }) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.unresolvedPeers).toEqual([
        { kind: "unresolved-peer", importerPath: ".", name: "react", declaredSpec: "^18" },
      ]);
    }
  });
});

describe("buildAuditModel — contradictory instance metadata (ADR decision 6)", () => {
  it("aggregates conflicting variants into one review-required row instead of picking a winner", () => {
    const graph: LockfileGraph = {
      roots: [
        resolvedRoot({ importerPath: ".", snapshotKey: "foo@1.0.0" }),
        resolvedRoot({ importerPath: "pkg-b", snapshotKey: "foo@1.0.0_peer" }),
      ],
      unresolvedPeers: [],
      snapshots: new Map([
        ["foo@1.0.0", snapshot({ packageKey: "foo@1.0.0" })],
        ["foo@1.0.0_peer", snapshot({ packageKey: "foo@1.0.0_peer" })],
      ]),
      packages: new Map([
        ["foo@1.0.0", registryIdentity({ packageKey: "foo@1.0.0", integrity: "sha512-aaa" })],
        [
          "foo@1.0.0_peer",
          registryIdentity({ packageKey: "foo@1.0.0_peer", integrity: "sha512-bbb" }),
        ],
      ]),
      firstParty: [],
    };
    const r = build({
      graph,
      cache: {
        schemaVersion: 1,
        entries: [
          collected({
            integrity: "sha512-aaa",
            tarballIntegrity: "sha512-aaa",
            rawLicense: "MIT",
            normalizedSpdx: "MIT",
          }),
          collected({
            integrity: "sha512-bbb",
            tarballIntegrity: "sha512-bbb",
            rawLicense: "Apache-2.0",
            normalizedSpdx: "Apache-2.0",
          }),
        ],
      },
      policy: policyWith({
        MIT: { disposition: "allowed", obligations: [] },
        "Apache-2.0": {
          disposition: "allowed-with-obligations",
          obligations: ["include-license-text"],
        },
      }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.reachableSnapshotInstanceCount).toBe(2);
      expect(r.model.aggregatedPackageRowCount).toBe(1);
      const row = r.model.rows[0];
      expect(row?.metadataConflict).toBe(true);
      expect(row?.policyDisposition).toBe("review-required");
      expect(row?.aggregate).toBeNull();
      expect(row?.variants).toHaveLength(2);
    }
  });
});
