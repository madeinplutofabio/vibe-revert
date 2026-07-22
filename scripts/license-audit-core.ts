// scripts/license-audit-core.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Pure, deterministic core for the M H5 license audit (see
// docs/adr/0001-deterministic-license-audit.md). No I/O, no execution on import,
// no sibling imports. Traversal identity is the exact snapshot key; report rows
// aggregate by name@version over the contributing immutable lockfile identities.
// A broken normalized graph, or missing/failed/integrity-unverified/duplicated
// cache metadata, is a GENERATION ERROR (never a silent omission). Disagreement
// among successfully verified facts for one name@version is a review-required
// CONFLICT (evidence retained), not a generation error. Direct workspace
// peerDependencies with no lockfile resolution are surfaced separately as
// consumer-supplied peer obligations, never as missing graph nodes.

// -- JSON values (raw license evidence is preserved exactly) ----------------

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// -- postures ---------------------------------------------------------------

export type Posture = "production" | "optional-production" | "peer" | "development";

export type EdgeKind = "required" | "optional";

const POSTURE_RANK: Record<Posture, number> = {
  production: 4,
  "optional-production": 3,
  peer: 2,
  development: 1,
};

/** Precedence for the primary reported posture: production > optional-production
 *  > peer > development. */
export function maxPosture(a: Posture, b: Posture): Posture {
  return POSTURE_RANK[a] >= POSTURE_RANK[b] ? a : b;
}

/** Child posture from a parent posture and the edge kind. A required edge
 *  preserves the posture; an optional edge demotes production to
 *  optional-production and otherwise preserves it. */
export function transition(parent: Posture, edge: EdgeKind): Posture {
  if (edge === "optional") {
    return parent === "production" ? "optional-production" : parent;
  }
  return parent;
}

// -- normalized lockfile graph (produced by the v9 adapter) -----------------

export interface SnapshotEdge {
  readonly name: string;
  readonly snapshotKey: string;
}

export interface SnapshotNode {
  readonly name: string;
  readonly version: string;
  /** Exact `packages:` key this instance resolves to (peer suffix stripped). */
  readonly packageKey: string;
  readonly dependencies: readonly SnapshotEdge[];
  readonly optionalDependencies: readonly SnapshotEdge[];
}

export interface ResolvedRootEdge {
  readonly kind: "resolved";
  readonly importerPath: string;
  readonly name: string;
  readonly snapshotKey: string;
  readonly posture: Posture;
}

/** A direct workspace peerDependency with no selected lockfile resolution. It
 *  cannot participate in traversal or receive package metadata; it is a
 *  consumer-supplied peer obligation surfaced separately for review, NOT a
 *  missing graph node. */
export interface UnresolvedPeerRoot {
  readonly kind: "unresolved-peer";
  readonly importerPath: string;
  readonly name: string;
  readonly declaredSpec: string;
}

/**
 * Retrieval-shape classification of a `packages:` identity, derived by the v9
 * adapter from the lockfile `resolution`. It models what the lockfile explicitly
 * establishes about RETRIEVAL, not presumed provenance:
 *   - "registry": no committed tarball URL; refresh resolves the location through
 *     registry metadata (committed integrity is the trust anchor).
 *   - "tarball-url": a committed tarball URL exists (see tarballUrl); refresh may
 *     fetch it directly and verify it against the committed integrity. It may still
 *     originate from a registry or mirror — the URL is a location, not provenance.
 *   - "git" / "directory": unsupported by the refresh path.
 * A "registry" or "tarball-url" identity may still carry a null integrity (a
 * malformed lockfile) — that is a FAILED collection, not an unsupported one.
 * URL, HTTPS/SSRF, and integrity validation are refresh responsibilities.
 */
export type PackageSourceKind = "registry" | "tarball-url" | "git" | "directory";

export interface LockfilePackageIdentity {
  readonly packageKey: string;
  readonly name: string;
  readonly version: string;
  /** resolution.integrity, or null for a package with no registry integrity. */
  readonly integrity: string | null;
  /** Retrieval-shape classification derived from the lockfile resolution. */
  readonly sourceKind: PackageSourceKind;
  /**
   * The committed tarball URL when sourceKind is "tarball-url", else null.
   * Invariant: (sourceKind === "tarball-url") === (tarballUrl !== null). The adapter
   * does NOT validate the URL (scheme, host, SSRF); that is a refresh responsibility.
   */
  readonly tarballUrl: string | null;
}

export interface LockfileGraph {
  /** Resolved third-party roots from the manifest sections, matched to lockfile snapshots. */
  readonly roots: readonly ResolvedRootEdge[];
  /** Direct workspace peerDependencies with no lockfile resolution. */
  readonly unresolvedPeers: readonly UnresolvedPeerRoot[];
  readonly snapshots: ReadonlyMap<string, SnapshotNode>;
  /** Full `packages:` identity set, keyed by exact lockfile packageKey. */
  readonly packages: ReadonlyMap<string, LockfilePackageIdentity>;
  readonly firstParty: readonly string[];
}

// -- validated policy + metadata cache --------------------------------------

export type Disposition = "allowed" | "allowed-with-obligations" | "review-required" | "disallowed";

export interface PolicyEntry {
  readonly disposition: Disposition;
  readonly obligations: readonly string[];
}

export interface Policy {
  readonly schemaVersion: number;
  readonly dispositions: ReadonlyMap<string, PolicyEntry>;
}

export interface MetadataIdentity {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}

export interface CollectedRegistryMetadata extends MetadataIdentity {
  readonly collectionStatus: "collected";
  readonly collectionReason: null;
  readonly retrievalSource: "pnpm-store" | "registry-tarball";
  readonly tarballIntegrity: string;
  /** Whether the packaged package.json declared a `license` field at all.
   *  Distinguishes an absent field from an explicit `license: null`. */
  readonly rawLicensePresent: boolean;
  /** The declared value when present; a null placeholder when absent (interpret
   *  only alongside rawLicensePresent). */
  readonly rawLicense: JsonValue;
  readonly normalizedSpdx: string | null;
  readonly licenseMetadataSource: "packaged-package-json";
  readonly packagedLegalFiles: readonly string[];
}

export interface FailedRegistryMetadata {
  readonly collectionStatus: "failed";
  readonly name: string;
  readonly version: string;
  /** null when the lockfile identity itself has no integrity (a supported registry
   *  mechanism whose downloaded bytes therefore cannot be verified). */
  readonly integrity: string | null;
  readonly collectionReason: string;
  readonly retrievalSource: "pnpm-store" | "registry-tarball" | null;
  readonly tarballIntegrity: string | null;
}

export interface FailedUnsupportedMetadata {
  readonly collectionStatus: "failed";
  readonly packageKey: string;
  readonly collectionReason: string;
  readonly retrievalSource: null;
}

export type MetadataEntry =
  | CollectedRegistryMetadata
  | FailedRegistryMetadata
  | FailedUnsupportedMetadata;

export interface MetadataCache {
  readonly schemaVersion: number;
  readonly entries: readonly MetadataEntry[];
}

// -- resource bounds --------------------------------------------------------

export interface GraphLimits {
  readonly maxPackages: number;
  readonly maxSnapshots: number;
  readonly maxEdges: number;
  readonly maxImporters: number;
  readonly maxRoots: number;
  readonly maxUnresolvedPeers: number;
  /** Maximum EDGE depth of a retained shortest path (a direct root is 0). */
  readonly maxPathDepth: number;
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = {
  maxPackages: 100_000,
  maxSnapshots: 200_000,
  maxEdges: 1_000_000,
  maxImporters: 10_000,
  maxRoots: 50_000,
  maxUnresolvedPeers: 10_000,
  maxPathDepth: 1_000,
};

// -- audit model ------------------------------------------------------------

export interface InputHashes {
  readonly lockfileSha256: string;
  readonly manifestsSha256: string;
  readonly policySha256: string;
  readonly metadataSha256: string;
}

export interface ReachabilityPath {
  readonly importerPath: string;
  readonly rootDependency: string;
  readonly snapshotKeys: readonly string[];
}

export interface PosturePath {
  readonly posture: Posture;
  readonly path: ReachabilityPath;
}

export interface RowProvenance {
  readonly shortestPaths: readonly PosturePath[];
  readonly directParents: readonly string[];
  readonly originatingImporters: readonly string[];
}

/** Verified facts for one contributing immutable identity of a name@version row. */
export interface IdentityMetadata {
  readonly packageKey: string;
  readonly integrity: string;
  readonly rawLicensePresent: boolean;
  readonly rawLicense: JsonValue;
  readonly normalizedSpdx: string | null;
  readonly licenseMetadataSource: "packaged-package-json";
  readonly packagedLegalFiles: readonly string[];
  readonly policyDisposition: Disposition;
  readonly obligations: readonly string[];
}

/** Present only when every contributing identity agrees; null on conflict. */
export interface AggregateFacts {
  readonly rawLicensePresent: boolean;
  readonly rawLicense: JsonValue;
  readonly normalizedSpdx: string | null;
  readonly licenseMetadataSource: "packaged-package-json";
  readonly packagedLegalFiles: readonly string[];
  readonly obligations: readonly string[];
}

export interface ReportRow {
  readonly name: string;
  readonly version: string;
  readonly primaryPosture: Posture;
  readonly reachingPostures: readonly Posture[];
  readonly packageKeys: readonly string[];
  readonly snapshotKeys: readonly string[];
  readonly integrities: readonly string[];
  readonly policyDisposition: Disposition;
  readonly metadataConflict: boolean;
  readonly metadataConflictReasons: readonly string[];
  readonly aggregate: AggregateFacts | null;
  readonly variants: readonly IdentityMetadata[];
  readonly provenance: RowProvenance;
}

export interface AuditModel {
  readonly generatorSchemaVersion: number;
  readonly hashes: InputHashes;
  readonly reachableSnapshotInstanceCount: number;
  readonly aggregatedPackageRowCount: number;
  readonly rows: readonly ReportRow[];
  readonly firstParty: readonly string[];
  /** Consumer-supplied peer obligations requiring review (no resolution). */
  readonly unresolvedPeers: readonly UnresolvedPeerRoot[];
}

export interface GenerationError {
  readonly code: string;
  readonly message: string;
  readonly package?: string;
}

export interface BuildInput {
  readonly graph: LockfileGraph;
  readonly cache: MetadataCache;
  readonly policy: Policy;
  readonly hashes: InputHashes;
  readonly generatorSchemaVersion: number;
  readonly limits?: Partial<GraphLimits>;
}

export type BuildResult =
  | { readonly ok: true; readonly model: AuditModel }
  | { readonly ok: false; readonly errors: readonly GenerationError[] };

// -- helpers ----------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(arr: readonly string[]): string[] {
  return [...new Set(arr)].sort(cmp);
}

function compareStringArrays(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp(a[i] as string, b[i] as string);
    if (c !== 0) {
      return c;
    }
  }
  return a.length - b.length;
}

/** Deterministic order over reachability paths: fewer edges first, then
 *  importerPath, then rootDependency, then snapshot keys component by component. */
function comparePath(a: ReachabilityPath, b: ReachabilityPath): number {
  return (
    a.snapshotKeys.length - b.snapshotKeys.length ||
    cmp(a.importerPath, b.importerPath) ||
    cmp(a.rootDependency, b.rootDependency) ||
    compareStringArrays(a.snapshotKeys, b.snapshotKeys)
  );
}

function sortedPostures(postures: Iterable<Posture>): Posture[] {
  return [...postures].sort((a, b) => POSTURE_RANK[b] - POSTURE_RANK[a]);
}

/** Encoded tuple (not delimiter concatenation) for an immutable registry identity. */
function registryKey(name: string, version: string, integrity: string | null): string {
  return JSON.stringify(["registry", name, version, integrity]);
}

function isRegistryKind(id: LockfilePackageIdentity): boolean {
  return id.sourceKind === "registry" || id.sourceKind === "tarball-url";
}

/** Deterministic canonical JSON (object keys sorted) for deep value comparison. */
function canonicalJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  // Array.isArray does not narrow a readonly array out of the union; the scalar and
  // array cases are already handled above, so this is a plain object at runtime.
  const obj = value as { readonly [key: string]: JsonValue };
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] as JsonValue)}`);
  return `{${parts.join(",")}}`;
}

function sortUnresolvedPeers(peers: readonly UnresolvedPeerRoot[]): UnresolvedPeerRoot[] {
  return [...peers].sort(
    (a, b) =>
      cmp(a.importerPath, b.importerPath) ||
      cmp(a.name, b.name) ||
      cmp(a.declaredSpec, b.declaredSpec),
  );
}

function dedupeErrors(errors: readonly GenerationError[]): GenerationError[] {
  const seen = new Set<string>();
  const out: GenerationError[] = [];
  for (const e of errors) {
    const k = JSON.stringify([e.code, e.package ?? null, e.message]);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

function sortErrors(errors: readonly GenerationError[]): GenerationError[] {
  return [...errors].sort(
    (a, b) =>
      cmp(a.package ?? "", b.package ?? "") || cmp(a.code, b.code) || cmp(a.message, b.message),
  );
}

function fail(errors: readonly GenerationError[]): {
  ok: false;
  errors: readonly GenerationError[];
} {
  return { ok: false, errors: sortErrors(dedupeErrors(errors)) };
}

// -- graph validation -------------------------------------------------------

function checkLimitValues(limits: GraphLimits): GenerationError[] {
  const errors: GenerationError[] = [];
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push({
        code: "GRAPH_LIMITS_INVALID",
        message: `limit ${name} must be a positive safe integer (got ${String(value)})`,
      });
    }
  }
  return errors;
}

function checkLimits(graph: LockfileGraph, limits: GraphLimits): GenerationError[] {
  const errors: GenerationError[] = [];
  if (graph.packages.size > limits.maxPackages) {
    errors.push({
      code: "GRAPH_LIMIT_PACKAGES_EXCEEDED",
      message: `lockfile package identities (${graph.packages.size}) exceed the limit ${limits.maxPackages}`,
    });
  }
  if (graph.snapshots.size > limits.maxSnapshots) {
    errors.push({
      code: "GRAPH_LIMIT_SNAPSHOTS_EXCEEDED",
      message: `snapshot instances (${graph.snapshots.size}) exceed the limit ${limits.maxSnapshots}`,
    });
  }
  if (graph.roots.length > limits.maxRoots) {
    errors.push({
      code: "GRAPH_LIMIT_ROOTS_EXCEEDED",
      message: `root edges (${graph.roots.length}) exceed the limit ${limits.maxRoots}`,
    });
  }
  if (graph.unresolvedPeers.length > limits.maxUnresolvedPeers) {
    errors.push({
      code: "GRAPH_LIMIT_UNRESOLVED_PEERS_EXCEEDED",
      message: `unresolved peers (${graph.unresolvedPeers.length}) exceed the limit ${limits.maxUnresolvedPeers}`,
    });
  }
  let edgeCount = 0;
  for (const node of graph.snapshots.values()) {
    edgeCount += node.dependencies.length + node.optionalDependencies.length;
  }
  if (edgeCount > limits.maxEdges) {
    errors.push({
      code: "GRAPH_LIMIT_EDGES_EXCEEDED",
      message: `dependency edges (${edgeCount}) exceed the limit ${limits.maxEdges}`,
    });
  }
  const importers = new Set(graph.roots.map((r) => r.importerPath));
  if (importers.size > limits.maxImporters) {
    errors.push({
      code: "GRAPH_LIMIT_IMPORTERS_EXCEEDED",
      message: `importers (${importers.size}) exceed the limit ${limits.maxImporters}`,
    });
  }
  return errors;
}

function validateReferentialIntegrity(graph: LockfileGraph): GenerationError[] {
  const errors: GenerationError[] = [];
  for (const root of graph.roots) {
    const target = graph.snapshots.get(root.snapshotKey);
    if (target === undefined) {
      errors.push({
        code: "GRAPH_ROOT_MISSING",
        message: `root ${root.name} in ${root.importerPath} references missing snapshot ${root.snapshotKey}`,
        package: root.snapshotKey,
      });
    } else if (target.name !== root.name) {
      errors.push({
        code: "GRAPH_ROOT_NAME_MISMATCH",
        message: `root ${root.name} in ${root.importerPath} resolves to snapshot ${root.snapshotKey} named ${target.name}`,
        package: root.snapshotKey,
      });
    }
  }
  for (const [key, node] of graph.snapshots) {
    const id = graph.packages.get(node.packageKey);
    if (id === undefined) {
      errors.push({
        code: "GRAPH_PACKAGE_IDENTITY_MISSING",
        message: `snapshot ${key} references missing package identity ${node.packageKey}`,
        package: key,
      });
    } else if (
      id.name !== node.name ||
      id.version !== node.version ||
      id.packageKey !== node.packageKey
    ) {
      errors.push({
        code: "GRAPH_SNAPSHOT_PACKAGE_MISMATCH",
        message: `snapshot ${key} (${node.name}@${node.version}, packageKey ${node.packageKey}) does not match identity (${id.name}@${id.version}, packageKey ${id.packageKey})`,
        package: key,
      });
    }
    for (const edge of [...node.dependencies, ...node.optionalDependencies]) {
      const target = graph.snapshots.get(edge.snapshotKey);
      if (target === undefined) {
        errors.push({
          code: "GRAPH_EDGE_TARGET_MISSING",
          message: `snapshot ${key} references missing dependency ${edge.snapshotKey}`,
          package: edge.snapshotKey,
        });
      } else if (target.name !== edge.name) {
        errors.push({
          code: "GRAPH_EDGE_NAME_MISMATCH",
          message: `snapshot ${key} edge labeled ${edge.name} resolves to snapshot ${edge.snapshotKey} named ${target.name}`,
          package: edge.snapshotKey,
        });
      }
    }
  }
  return errors;
}

function validateUnresolvedPeers(graph: LockfileGraph): GenerationError[] {
  const errors: GenerationError[] = [];
  const resolvedPeers = new Set<string>();
  for (const root of graph.roots) {
    if (root.posture === "peer") {
      resolvedPeers.add(JSON.stringify([root.importerPath, root.name]));
    }
  }
  const seen = new Set<string>();
  for (const peer of graph.unresolvedPeers) {
    if (
      peer.importerPath.length === 0 ||
      peer.name.length === 0 ||
      peer.declaredSpec.length === 0
    ) {
      errors.push({
        code: "GRAPH_UNRESOLVED_PEER_MALFORMED",
        message: `unresolved peer entry has an empty importerPath, name, or declaredSpec (${JSON.stringify(peer.importerPath)}, ${JSON.stringify(peer.name)})`,
        package: peer.name,
      });
      continue;
    }
    const key = JSON.stringify([peer.importerPath, peer.name]);
    if (seen.has(key)) {
      errors.push({
        code: "GRAPH_DUPLICATE_UNRESOLVED_PEER",
        message: `duplicate unresolved peer ${peer.name} in ${peer.importerPath}`,
        package: peer.name,
      });
    } else {
      seen.add(key);
    }
    if (resolvedPeers.has(key)) {
      errors.push({
        code: "GRAPH_PEER_BOTH_RESOLVED_AND_UNRESOLVED",
        message: `peer ${peer.name} in ${peer.importerPath} is both resolved and unresolved`,
        package: peer.name,
      });
    }
  }
  return errors;
}

// -- reachability -----------------------------------------------------------

export interface Provenance {
  readonly reachingPostures: readonly Posture[];
  readonly primaryPosture: Posture;
  readonly shortestPathByPosture: ReadonlyMap<Posture, ReachabilityPath>;
  readonly directParents: readonly string[];
  readonly originatingImporters: readonly string[];
}

export type ReachabilityResult =
  | { readonly ok: true; readonly reach: ReadonlyMap<string, Provenance> }
  | { readonly ok: false; readonly errors: readonly GenerationError[] };

/**
 * Per-instance reachability over a REFERENTIALLY-VALID graph. A relaxation
 * worklist over (snapshotKey, posture) keeps the deterministic best
 * ReachabilityPath per state (comparePath); a separate importer-set fixpoint
 * yields originating importers (cycle-safe). An edge depth beyond maxPathDepth is
 * a generation error, never a truncation.
 */
export function computeReachability(graph: LockfileGraph, limits: GraphLimits): ReachabilityResult {
  const best = new Map<string, Map<Posture, ReachabilityPath>>();
  const directParents = new Map<string, Set<string>>();
  const queue: { key: string; posture: Posture }[] = [];
  let head = 0;

  const innerOf = (key: string): Map<Posture, ReachabilityPath> => {
    let inner = best.get(key);
    if (inner === undefined) {
      inner = new Map();
      best.set(key, inner);
    }
    return inner;
  };
  const relax = (key: string, posture: Posture, path: ReachabilityPath): void => {
    const inner = innerOf(key);
    const existing = inner.get(posture);
    if (existing === undefined || comparePath(path, existing) < 0) {
      inner.set(posture, path);
      queue.push({ key, posture });
    }
  };
  const addParent = (child: string, parent: string): void => {
    let s = directParents.get(child);
    if (s === undefined) {
      s = new Set();
      directParents.set(child, s);
    }
    s.add(parent);
  };

  const roots = [...graph.roots].sort(
    (a, b) =>
      cmp(a.importerPath, b.importerPath) ||
      cmp(a.name, b.name) ||
      cmp(a.snapshotKey, b.snapshotKey) ||
      POSTURE_RANK[b.posture] - POSTURE_RANK[a.posture],
  );
  for (const root of roots) {
    relax(root.snapshotKey, root.posture, {
      importerPath: root.importerPath,
      rootDependency: root.name,
      snapshotKeys: [root.snapshotKey],
    });
  }

  while (head < queue.length) {
    const { key, posture } = queue[head++] as { key: string; posture: Posture };
    const node = graph.snapshots.get(key);
    if (node === undefined) {
      return {
        ok: false,
        errors: [
          {
            code: "GRAPH_EDGE_TARGET_MISSING",
            message: `snapshot ${key} missing during traversal`,
            package: key,
          },
        ],
      };
    }
    const path = innerOf(key).get(posture) as ReachabilityPath;
    const edgeDepth = path.snapshotKeys.length - 1;
    if (edgeDepth > limits.maxPathDepth) {
      return {
        ok: false,
        errors: [
          {
            code: "GRAPH_LIMIT_PATH_DEPTH_EXCEEDED",
            message: `dependency path edge depth (${edgeDepth}) exceeds the limit ${limits.maxPathDepth}`,
            package: key,
          },
        ],
      };
    }
    const requiredEdges = [...node.dependencies].sort(
      (a, b) => cmp(a.snapshotKey, b.snapshotKey) || cmp(a.name, b.name),
    );
    const optionalEdges = [...node.optionalDependencies].sort(
      (a, b) => cmp(a.snapshotKey, b.snapshotKey) || cmp(a.name, b.name),
    );
    const edgeSets: readonly [readonly SnapshotEdge[], EdgeKind][] = [
      [requiredEdges, "required"],
      [optionalEdges, "optional"],
    ];
    for (const [edges, kind] of edgeSets) {
      const childPosture = transition(posture, kind);
      for (const edge of edges) {
        addParent(edge.snapshotKey, key);
        relax(edge.snapshotKey, childPosture, {
          importerPath: path.importerPath,
          rootDependency: path.rootDependency,
          snapshotKeys: [...path.snapshotKeys, edge.snapshotKey],
        });
      }
    }
  }

  // Originating importers: union-to-fixpoint over the reachable subgraph.
  const importersByNode = new Map<string, Set<string>>();
  const impQueue: string[] = [];
  let impHead = 0;
  const addImporters = (key: string, imps: Iterable<string>): void => {
    let s = importersByNode.get(key);
    if (s === undefined) {
      s = new Set();
      importersByNode.set(key, s);
    }
    let changed = false;
    for (const i of imps) {
      if (!s.has(i)) {
        s.add(i);
        changed = true;
      }
    }
    if (changed) {
      impQueue.push(key);
    }
  };
  for (const root of roots) {
    addImporters(root.snapshotKey, [root.importerPath]);
  }
  while (impHead < impQueue.length) {
    const key = impQueue[impHead++] as string;
    const node = graph.snapshots.get(key) as SnapshotNode;
    const imps = importersByNode.get(key) as Set<string>;
    for (const edge of [...node.dependencies, ...node.optionalDependencies]) {
      addImporters(edge.snapshotKey, imps);
    }
  }

  const reach = new Map<string, Provenance>();
  for (const [key, inner] of best) {
    const reaching = sortedPostures(inner.keys());
    reach.set(key, {
      reachingPostures: reaching,
      primaryPosture: reaching[0] as Posture,
      shortestPathByPosture: inner,
      directParents: [...(directParents.get(key) ?? [])].sort(cmp),
      originatingImporters: [...(importersByNode.get(key) ?? [])].sort(cmp),
    });
  }
  return { ok: true, reach };
}

// -- model assembly ---------------------------------------------------------

interface GroupAccumulator {
  readonly name: string;
  readonly version: string;
  readonly snapshotKeys: string[];
  readonly packageKeys: Set<string>;
}

function detectConflictReasons(variants: readonly IdentityMetadata[]): string[] {
  const reasons: string[] = [];
  const distinct = (values: readonly string[]): boolean => new Set(values).size > 1;
  if (distinct(variants.map((v) => v.integrity))) {
    reasons.push("integrity");
  }
  if (distinct(variants.map((v) => (v.rawLicensePresent ? "1" : "0")))) {
    reasons.push("rawLicensePresence");
  }
  const presentValues = variants
    .filter((v) => v.rawLicensePresent)
    .map((v) => canonicalJson(v.rawLicense));
  if (new Set(presentValues).size > 1) {
    reasons.push("rawLicense");
  }
  if (distinct(variants.map((v) => JSON.stringify(v.normalizedSpdx)))) {
    reasons.push("normalizedSpdx");
  }
  if (distinct(variants.map((v) => v.licenseMetadataSource))) {
    reasons.push("licenseMetadataSource");
  }
  if (distinct(variants.map((v) => JSON.stringify(sortedUnique(v.packagedLegalFiles))))) {
    reasons.push("packagedLegalFiles");
  }
  if (distinct(variants.map((v) => v.policyDisposition))) {
    reasons.push("policyDisposition");
  }
  if (distinct(variants.map((v) => JSON.stringify(sortedUnique(v.obligations))))) {
    reasons.push("obligations");
  }
  return reasons;
}

/**
 * Assemble the audit model or return every generation error. Coverage is strict:
 * every reachable third-party immutable identity must have a matching, verified,
 * successfully-collected cache entry, and every cache entry must be referenced by
 * a current lockfile package identity of the matching kind. Duplicate cache
 * identities, and missing/failed/mismatched metadata, are generation errors;
 * disagreement among verified facts for one name@version is a review-required
 * conflict with evidence retained.
 */
export function buildAuditModel(input: BuildInput): BuildResult {
  const { graph, cache, policy, hashes, generatorSchemaVersion } = input;
  const limits: GraphLimits = { ...DEFAULT_GRAPH_LIMITS, ...(input.limits ?? {}) };

  const limitValueErrors = checkLimitValues(limits);
  if (limitValueErrors.length > 0) {
    return fail(limitValueErrors);
  }
  const limitErrors = checkLimits(graph, limits);
  if (limitErrors.length > 0) {
    return fail(limitErrors);
  }
  const refErrors = validateReferentialIntegrity(graph);
  if (refErrors.length > 0) {
    return fail(refErrors);
  }
  const peerErrors = validateUnresolvedPeers(graph);
  if (peerErrors.length > 0) {
    return fail(peerErrors);
  }
  const reachResult = computeReachability(graph, limits);
  if (!reachResult.ok) {
    return fail(reachResult.errors);
  }
  const reach = reachResult.reach;

  // Index the cache by immutable identity; duplicate identities are fail-closed.
  const registryEntries = new Map<string, CollectedRegistryMetadata | FailedRegistryMetadata>();
  const unsupportedEntries = new Map<string, FailedUnsupportedMetadata>();
  const duplicateErrors: GenerationError[] = [];
  for (const entry of cache.entries) {
    if (entry.collectionStatus === "failed" && "packageKey" in entry) {
      if (unsupportedEntries.has(entry.packageKey)) {
        duplicateErrors.push({
          code: "CACHE_DUPLICATE_UNSUPPORTED_IDENTITY",
          message: `duplicate unsupported metadata entry for ${entry.packageKey}`,
          package: entry.packageKey,
        });
      } else {
        unsupportedEntries.set(entry.packageKey, entry);
      }
    } else {
      const rk = registryKey(entry.name, entry.version, entry.integrity);
      if (registryEntries.has(rk)) {
        duplicateErrors.push({
          code: "CACHE_DUPLICATE_REGISTRY_IDENTITY",
          message: `duplicate metadata entry for ${entry.name}@${entry.version} (same integrity)`,
          package: `${entry.name}@${entry.version}`,
        });
      } else {
        registryEntries.set(rk, entry);
      }
    }
  }
  if (duplicateErrors.length > 0) {
    return fail(duplicateErrors);
  }

  const errors: GenerationError[] = [];

  // Lockfile identity indexes for the reference + kind classification.
  const lockfileRegistry = new Set<string>();
  const nvExists = new Set<string>();
  const nvHasRegistryIdentity = new Set<string>();
  for (const id of graph.packages.values()) {
    const nv = `${id.name}@${id.version}`;
    nvExists.add(nv);
    if (isRegistryKind(id)) {
      lockfileRegistry.add(registryKey(id.name, id.version, id.integrity));
      nvHasRegistryIdentity.add(nv);
    }
  }

  // Reject cache entries not referenced by a lockfile identity of the right kind.
  for (const entry of cache.entries) {
    if (entry.collectionStatus === "failed" && "packageKey" in entry) {
      const id = graph.packages.get(entry.packageKey);
      if (id === undefined) {
        errors.push({
          code: "CACHE_ENTRY_UNREFERENCED",
          message: `metadata entry ${entry.packageKey} is not referenced by the current lockfile`,
          package: entry.packageKey,
        });
      } else if (isRegistryKind(id)) {
        errors.push({
          code: "CACHE_ENTRY_KIND_MISMATCH",
          message: `unsupported metadata entry ${entry.packageKey} references a registry-kind package identity`,
          package: entry.packageKey,
        });
      }
    } else {
      const nv = `${entry.name}@${entry.version}`;
      if (!lockfileRegistry.has(registryKey(entry.name, entry.version, entry.integrity))) {
        if (nvExists.has(nv) && !nvHasRegistryIdentity.has(nv)) {
          errors.push({
            code: "CACHE_ENTRY_KIND_MISMATCH",
            message: `registry metadata entry ${nv} matches a lockfile name@version present only as a no-integrity source`,
            package: nv,
          });
        } else {
          errors.push({
            code: "CACHE_ENTRY_UNREFERENCED",
            message: `metadata entry ${nv} is not referenced by the current lockfile`,
            package: nv,
          });
        }
      }
    }
  }

  // Group reachable instances by name@version; retain the immutable identities.
  const groups = new Map<string, GroupAccumulator>();
  for (const key of reach.keys()) {
    const node = graph.snapshots.get(key) as SnapshotNode;
    const nv = `${node.name}@${node.version}`;
    let g = groups.get(nv);
    if (g === undefined) {
      g = { name: node.name, version: node.version, snapshotKeys: [], packageKeys: new Set() };
      groups.set(nv, g);
    }
    g.snapshotKeys.push(key);
    g.packageKeys.add(node.packageKey);
  }

  const rows: ReportRow[] = [];
  for (const g of groups.values()) {
    const variants: IdentityMetadata[] = [];
    let groupHadError = false;

    for (const packageKey of sortedUnique([...g.packageKeys])) {
      const id = graph.packages.get(packageKey) as LockfilePackageIdentity;
      if (!isRegistryKind(id)) {
        // git / directory: an unsupported collection mechanism.
        const uentry = unsupportedEntries.get(packageKey);
        if (uentry === undefined) {
          errors.push({
            code: "CACHE_ENTRY_MISSING",
            message: `no metadata cache entry for unsupported package ${packageKey}`,
            package: packageKey,
          });
        } else {
          errors.push({
            code: "CACHE_ENTRY_INCOMPLETE",
            message: `metadata for ${packageKey} was not collected (${uentry.collectionReason})`,
            package: packageKey,
          });
        }
        groupHadError = true;
        continue;
      }
      // registry / tarball-url: keyed by (name, version, integrity); integrity may be
      // null (a supported mechanism whose bytes could not be verified).
      const entry = registryEntries.get(registryKey(id.name, id.version, id.integrity));
      if (entry === undefined) {
        errors.push({
          code: "CACHE_ENTRY_MISSING",
          message: `no metadata cache entry for ${packageKey}`,
          package: packageKey,
        });
        groupHadError = true;
        continue;
      }
      if (entry.collectionStatus !== "collected") {
        errors.push({
          code: "CACHE_ENTRY_INCOMPLETE",
          message: `metadata for ${packageKey} was not collected (${entry.collectionReason})`,
          package: packageKey,
        });
        groupHadError = true;
        continue;
      }
      if (id.integrity === null || entry.tarballIntegrity !== id.integrity) {
        // A collected entry must correspond to a verified, integrity-bearing identity.
        errors.push({
          code: "CACHE_INTEGRITY_MISMATCH",
          message: `verified tarball integrity for ${packageKey} does not match the lockfile`,
          package: packageKey,
        });
        groupHadError = true;
        continue;
      }
      const policyEntry =
        entry.normalizedSpdx !== null ? policy.dispositions.get(entry.normalizedSpdx) : undefined;
      variants.push({
        packageKey,
        integrity: id.integrity,
        rawLicensePresent: entry.rawLicensePresent,
        rawLicense: entry.rawLicense,
        normalizedSpdx: entry.normalizedSpdx,
        licenseMetadataSource: entry.licenseMetadataSource,
        packagedLegalFiles: sortedUnique(entry.packagedLegalFiles),
        policyDisposition: policyEntry?.disposition ?? "review-required",
        obligations: sortedUnique(policyEntry?.obligations ?? []),
      });
    }

    if (groupHadError || variants.length === 0) {
      continue;
    }
    variants.sort((a, b) => cmp(a.packageKey, b.packageKey));

    const conflictReasons = detectConflictReasons(variants);
    const metadataConflict = conflictReasons.length > 0;
    const headVariant = variants[0] as IdentityMetadata;

    // Provenance union across the group's snapshot instances.
    const reachingPostures = new Set<Posture>();
    const directParents = new Set<string>();
    const originatingImporters = new Set<string>();
    const bestByPosture = new Map<Posture, ReachabilityPath>();
    for (const key of g.snapshotKeys) {
      const p = reach.get(key) as Provenance;
      for (const posture of p.reachingPostures) {
        reachingPostures.add(posture);
      }
      for (const parent of p.directParents) {
        directParents.add(parent);
      }
      for (const imp of p.originatingImporters) {
        originatingImporters.add(imp);
      }
      for (const [posture, path] of p.shortestPathByPosture) {
        const cur = bestByPosture.get(posture);
        if (cur === undefined || comparePath(path, cur) < 0) {
          bestByPosture.set(posture, path);
        }
      }
    }
    const reachingSorted = sortedPostures(reachingPostures);

    rows.push({
      name: g.name,
      version: g.version,
      primaryPosture: reachingSorted[0] as Posture,
      reachingPostures: reachingSorted,
      packageKeys: sortedUnique([...g.packageKeys]),
      snapshotKeys: sortedUnique(g.snapshotKeys),
      integrities: sortedUnique(variants.map((v) => v.integrity)),
      policyDisposition: metadataConflict ? "review-required" : headVariant.policyDisposition,
      metadataConflict,
      metadataConflictReasons: conflictReasons,
      aggregate: metadataConflict
        ? null
        : {
            rawLicensePresent: headVariant.rawLicensePresent,
            rawLicense: headVariant.rawLicense,
            normalizedSpdx: headVariant.normalizedSpdx,
            licenseMetadataSource: headVariant.licenseMetadataSource,
            packagedLegalFiles: headVariant.packagedLegalFiles,
            obligations: headVariant.obligations,
          },
      variants,
      provenance: {
        shortestPaths: reachingSorted.map((posture) => ({
          posture,
          path: bestByPosture.get(posture) as ReachabilityPath,
        })),
        directParents: [...directParents].sort(cmp),
        originatingImporters: [...originatingImporters].sort(cmp),
      },
    });
  }

  if (errors.length > 0) {
    return fail(errors);
  }

  rows.sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
  return {
    ok: true,
    model: {
      generatorSchemaVersion,
      hashes,
      reachableSnapshotInstanceCount: reach.size,
      aggregatedPackageRowCount: rows.length,
      rows,
      firstParty: sortedUnique(graph.firstParty),
      unresolvedPeers: sortUnresolvedPeers(graph.unresolvedPeers),
    },
  };
}
