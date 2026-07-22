// scripts/license-lockfile-v9.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Pure pnpm lockfile v9 adapter for the M H5 license audit (see
// docs/adr/0001-deterministic-license-audit.md). Given the parsed lockfile YAML
// and the normalized committed workspace-manifest declarations, it produces the
// normalized LockfileGraph the pure core consumes, or every generation error.
// Manifests are authoritative for direct declaration kinds; the lockfile resolves
// each declaration to an immutable snapshot, and the two are cross-validated in
// both directions (kind, specifier, resolution). Every key and reference passes
// through one strict parser: a validated npm package name plus a safe version (no
// parentheses, protocol, whitespace, control, backslash, or `=`) and, at most, the
// validated peer-resolution suffix grammar. `packages:` keys must be suffix-free;
// snapshot keys may carry a validated peer suffix. `link:` is the only non-registry
// form accepted; every other shape (npm: alias, patch context, protocol, malformed
// parens, malformed name) is a hard error, never a guess.

import type {
  GenerationError,
  LockfileGraph,
  LockfilePackageIdentity,
  PackageSourceKind,
  Posture,
  ResolvedRootEdge,
  SnapshotEdge,
  SnapshotNode,
  UnresolvedPeerRoot,
} from "./license-audit-core.js";

// -- adapter input contract -------------------------------------------------

export interface DirectDeclaration {
  readonly name: string;
  readonly declaredSpec: string;
}

export interface NormalizedManifestDecl {
  readonly importerPath: string; // repo-relative: "." | "packages/<name>"
  readonly manifestPath: string; // for diagnostics
  readonly packageName: string | null;
  readonly dependencies: readonly DirectDeclaration[];
  readonly optionalDependencies: readonly DirectDeclaration[];
  readonly devDependencies: readonly DirectDeclaration[];
  readonly peerDependencies: readonly DirectDeclaration[];
}

export interface AdapterLimits {
  readonly maxManifestDeclarations: number;
}

export const DEFAULT_ADAPTER_LIMITS: AdapterLimits = {
  maxManifestDeclarations: 200_000,
};

export type ParseResult =
  | { readonly ok: true; readonly graph: LockfileGraph }
  | { readonly ok: false; readonly errors: readonly GenerationError[] };

type SectionName = "dependencies" | "optionalDependencies" | "devDependencies" | "peerDependencies";

interface ImporterResolution {
  readonly specifier: string;
  readonly version: string;
}

interface ImporterSections {
  readonly dependencies: ReadonlyMap<string, ImporterResolution>;
  readonly optionalDependencies: ReadonlyMap<string, ImporterResolution>;
  readonly devDependencies: ReadonlyMap<string, ImporterResolution>;
}

type ReferenceResolution =
  | { readonly kind: "registry"; readonly snapshotKey: string; readonly resolvedName: string }
  | { readonly kind: "first-party"; readonly linkTarget: string }
  | { readonly kind: "error"; readonly reason: string };

// -- helpers ----------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readProp(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  return [...dedupeErrors(errors)].sort(
    (a, b) =>
      cmp(a.package ?? "", b.package ?? "") || cmp(a.code, b.code) || cmp(a.message, b.message),
  );
}

/** A workspace importer path: "." or a relative, `/`-separated path with no
 *  empty/`.`/`..` segment, no backslash, whitespace, or control character. */
function isValidImporterPath(p: string): boolean {
  if (p === ".") {
    return true;
  }
  if (p.length === 0 || /\s/.test(p) || p.includes("\\")) {
    return false;
  }
  for (const ch of p) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return false; // control characters, including NUL and DEL
    }
  }
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    return false; // absolute
  }
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      return false;
    }
  }
  return true;
}

/** The suffix-free base of a key or reference: no parentheses, whitespace,
 *  control characters, backslashes, `=`, or protocol prefix, and non-empty. */
function isSafeRegistryBase(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("(") ||
    value.includes(")") ||
    value.includes("\\") ||
    value.includes("=") ||
    /\s/.test(value)
  ) {
    return false;
  }
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return false; // control characters, including DEL
    }
  }
  return !/^[a-z][a-z0-9+.-]*:/.test(value); // reject protocol-like forms
}

/** A deliberately narrow npm package-name grammar: unscoped `name` (no `@`, `/`)
 *  or a single-level scope `@scope/name`, with no whitespace, control characters,
 *  parentheses, or backslashes. */
function isValidPackageName(name: string): boolean {
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.includes("(") ||
    name.includes(")") ||
    /\s/.test(name)
  ) {
    return false;
  }
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    return (
      slash > 1 &&
      slash === name.lastIndexOf("/") &&
      slash < name.length - 1 &&
      !name.slice(1, slash).includes("@") &&
      !name.slice(slash + 1).includes("@")
    );
  }
  return !name.includes("@") && !name.includes("/");
}

function parseNameVersion(base: string): { name: string; version: string } | null {
  const at = base.lastIndexOf("@");
  if (at <= 0) {
    return null;
  }
  const name = base.slice(0, at);
  const version = base.slice(at + 1);
  if (
    version.length === 0 ||
    version.includes("@") ||
    version.includes("=") ||
    !isValidPackageName(name)
  ) {
    return null;
  }
  return { name, version };
}

/** A single peer-resolution context `<name>@<version>` with an optional nested
 *  peer suffix; never a patch (`=`) or other unknown context. */
function isValidPeerContext(inner: string): boolean {
  if (inner.includes("=")) {
    return false; // patch/unknown context (e.g. patch_hash=...)
  }
  const paren = inner.indexOf("(");
  const base = paren === -1 ? inner : inner.slice(0, paren);
  if (!isSafeRegistryBase(base) || parseNameVersion(base) === null) {
    return false;
  }
  return paren === -1 ? true : isValidPeerSuffix(inner.slice(paren));
}

/** A trailing resolution suffix: zero or more balanced `(<peer-context>)` groups. */
function isValidPeerSuffix(suffix: string): boolean {
  if (suffix.length === 0) {
    return true;
  }
  let i = 0;
  while (i < suffix.length) {
    if (suffix.charAt(i) !== "(") {
      return false;
    }
    let depth = 0;
    let j = i;
    for (; j < suffix.length; j++) {
      const c = suffix.charAt(j);
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
    }
    if (depth !== 0 || j >= suffix.length) {
      return false;
    }
    if (!isValidPeerContext(suffix.slice(i + 1, j))) {
      return false;
    }
    i = j + 1;
  }
  return true;
}

/** The single strict parser for `packages:` and `snapshots:` keys. Returns the
 *  base name@version, the suffix-free baseKey, and the (possibly empty) validated
 *  suffix, or null on any unsupported shape. */
function parseLockfileKey(
  key: string,
): { name: string; version: string; baseKey: string; suffix: string } | null {
  const paren = key.indexOf("(");
  const base = paren === -1 ? key : key.slice(0, paren);
  const suffix = paren === -1 ? "" : key.slice(paren);
  if (!isSafeRegistryBase(base)) {
    return null;
  }
  const nv = parseNameVersion(base);
  if (nv === null || !isValidPeerSuffix(suffix)) {
    return null;
  }
  return { name: nv.name, version: nv.version, baseKey: base, suffix };
}

/** Lexically resolve a `link:` target relative to the declaring importer, or null
 *  for an empty/absolute/drive/backslash/whitespace/control/protocol target or one
 *  that escapes above the repository root. No filesystem access. */
function resolveImporterRelative(base: string, rel: string): string | null {
  if (
    rel.length === 0 ||
    rel.startsWith("/") ||
    /^[A-Za-z]:/.test(rel) ||
    rel.includes("\\") ||
    /\s/.test(rel) ||
    /^[a-z][a-z0-9+.-]*:/.test(rel)
  ) {
    return null;
  }
  for (const ch of rel) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return null; // control characters, including DEL
    }
  }
  const out: string[] = base === "." ? [] : base.split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length === 0) {
        return null;
      }
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length === 0 ? "." : out.join("/");
}

/** The single strict v9 reference resolver, used by snapshot edges and importer
 *  roots. Registry (safe bare/peer-suffixed version) and `link:` are recognized;
 *  every other shape is an error. */
function resolveReference(label: string, ref: string): ReferenceResolution {
  if (ref.startsWith("link:")) {
    return { kind: "first-party", linkTarget: ref.slice(5) };
  }
  const paren = ref.indexOf("(");
  const base = paren === -1 ? ref : ref.slice(0, paren);
  const suffix = paren === -1 ? "" : ref.slice(paren);
  if (!isSafeRegistryBase(base)) {
    return { kind: "error", reason: `unsafe or malformed reference base ${JSON.stringify(ref)}` };
  }
  if (base.includes("@")) {
    return {
      kind: "error",
      reason: `unrecognized aliased or name reference ${JSON.stringify(ref)}`,
    };
  }
  if (!isValidPeerSuffix(suffix)) {
    return { kind: "error", reason: `unsupported resolution context ${JSON.stringify(ref)}` };
  }
  return { kind: "registry", snapshotKey: `${label}@${ref}`, resolvedName: label };
}

function sectionsOf(
  m: NormalizedManifestDecl,
): readonly { name: SectionName; posture: Posture; decls: readonly DirectDeclaration[] }[] {
  return [
    { name: "dependencies", posture: "production", decls: m.dependencies },
    { name: "optionalDependencies", posture: "optional-production", decls: m.optionalDependencies },
    { name: "devDependencies", posture: "development", decls: m.devDependencies },
    { name: "peerDependencies", posture: "peer", decls: m.peerDependencies },
  ];
}

function importerSectionEntries(
  importer: ImporterSections,
): readonly [SectionName, ReadonlyMap<string, ImporterResolution>][] {
  return [
    ["dependencies", importer.dependencies],
    ["optionalDependencies", importer.optionalDependencies],
    ["devDependencies", importer.devDependencies],
  ];
}

// -- manifest validation ----------------------------------------------------

function validateManifests(
  manifests: readonly NormalizedManifestDecl[],
  limits: AdapterLimits,
  errors: GenerationError[],
): void {
  let total = 0;
  for (const m of manifests) {
    for (const s of sectionsOf(m)) {
      total += s.decls.length;
    }
  }
  if (total > limits.maxManifestDeclarations) {
    errors.push({
      code: "GRAPH_LIMIT_MANIFEST_DECLARATIONS_EXCEEDED",
      message: `manifest declarations (${total}) exceed the limit ${limits.maxManifestDeclarations}`,
    });
  }

  const seenImporters = new Set<string>();
  const seenPackageNames = new Set<string>();
  for (const m of manifests) {
    if (!isValidImporterPath(m.importerPath)) {
      errors.push({
        code: "IMPORTER_PATH_INVALID",
        message: `invalid importer path ${JSON.stringify(m.importerPath)} (${m.manifestPath})`,
        package: m.importerPath,
      });
    }
    if (seenImporters.has(m.importerPath)) {
      errors.push({
        code: "MANIFEST_IMPORTER_DUPLICATE",
        message: `duplicate manifest importer ${m.importerPath}`,
        package: m.importerPath,
      });
    } else {
      seenImporters.add(m.importerPath);
    }
    if (m.packageName !== null) {
      if (seenPackageNames.has(m.packageName)) {
        errors.push({
          code: "WORKSPACE_PACKAGE_NAME_DUPLICATE",
          message: `duplicate workspace package name ${m.packageName}`,
          package: m.packageName,
        });
      } else {
        seenPackageNames.add(m.packageName);
      }
    }
    const nameSection = new Map<string, SectionName>();
    for (const s of sectionsOf(m)) {
      const seenInSection = new Set<string>();
      for (const d of s.decls) {
        if (!isValidPackageName(d.name) || d.declaredSpec.length === 0) {
          errors.push({
            code: "MANIFEST_DECLARATION_INVALID",
            message: `invalid declaration name or empty spec in ${m.importerPath} ${s.name}: ${JSON.stringify(d.name)}`,
            package: m.importerPath,
          });
          continue;
        }
        if (seenInSection.has(d.name)) {
          errors.push({
            code: "MANIFEST_DECLARATION_DUPLICATE",
            message: `duplicate ${d.name} in ${m.importerPath} ${s.name}`,
            package: d.name,
          });
        } else {
          seenInSection.add(d.name);
        }
        const prior = nameSection.get(d.name);
        if (prior !== undefined && prior !== s.name) {
          errors.push({
            code: "MANIFEST_DECLARATION_IN_MULTIPLE_SECTIONS",
            message: `${d.name} in ${m.importerPath} appears in both ${prior} and ${s.name}`,
            package: d.name,
          });
        } else if (prior === undefined) {
          nameSection.set(d.name, s.name);
        }
      }
    }
  }
}

// -- lockfile section parsing -----------------------------------------------

function parsePackages(
  packagesObj: Record<string, unknown>,
  errors: GenerationError[],
): Map<string, LockfilePackageIdentity> {
  const packages = new Map<string, LockfilePackageIdentity>();
  for (const [packageKey, val] of Object.entries(packagesObj)) {
    if (!isObject(val)) {
      errors.push({
        code: "LOCKFILE_PACKAGE_MALFORMED",
        message: `package ${packageKey} is not a mapping`,
        package: packageKey,
      });
      continue;
    }
    const parsed = parseLockfileKey(packageKey);
    if (parsed === null || parsed.suffix !== "") {
      errors.push({
        code: "LOCKFILE_PACKAGE_KEY_INVALID",
        message: `package key ${JSON.stringify(packageKey)} must be a suffix-free name@version`,
        package: packageKey,
      });
      continue;
    }
    if (packages.has(packageKey)) {
      errors.push({
        code: "LOCKFILE_PACKAGE_DUPLICATE",
        message: `duplicate package identity ${packageKey}`,
        package: packageKey,
      });
      continue;
    }
    let integrity: string | null = null;
    let sourceKind: PackageSourceKind = "registry";
    let tarballUrl: string | null = null;
    const resolution = readProp(val, "resolution");
    if (resolution !== undefined) {
      if (!isObject(resolution)) {
        errors.push({
          code: "LOCKFILE_PACKAGE_MALFORMED",
          message: `package ${packageKey} resolution is not a mapping`,
          package: packageKey,
        });
        continue;
      }
      const integ = readProp(resolution, "integrity");
      if (integ !== undefined) {
        if (typeof integ !== "string" || integ.length === 0) {
          errors.push({
            code: "LOCKFILE_PACKAGE_MALFORMED",
            message: `package ${packageKey} integrity is not a non-empty string`,
            package: packageKey,
          });
          continue;
        }
        integrity = integ;
      }

      // Validate the shape of each classifying field before use.
      const resType = readProp(resolution, "type");
      if (resType !== undefined && typeof resType !== "string") {
        errors.push({
          code: "LOCKFILE_PACKAGE_MALFORMED",
          message: `package ${packageKey} resolution type is not a string`,
          package: packageKey,
        });
        continue;
      }
      const tarballRaw = readProp(resolution, "tarball");
      let tarballStr: string | undefined;
      if (tarballRaw !== undefined) {
        if (typeof tarballRaw !== "string" || tarballRaw.length === 0) {
          errors.push({
            code: "LOCKFILE_PACKAGE_MALFORMED",
            message: `package ${packageKey} tarball is not a non-empty string`,
            package: packageKey,
          });
          continue;
        }
        tarballStr = tarballRaw;
      }
      // Reject contradictory shapes rather than guessing a precedence: a resolution
      // that names both a type and a tarball location is ambiguous.
      if (resType !== undefined && tarballStr !== undefined) {
        errors.push({
          code: "LOCKFILE_PACKAGE_UNSUPPORTED_RESOLUTION",
          message: `package ${packageKey} resolution has both a type and a tarball`,
          package: packageKey,
        });
        continue;
      }
      // Classify only what the lockfile explicitly establishes.
      if (resType === "directory") {
        sourceKind = "directory";
      } else if (resType === "git") {
        sourceKind = "git";
      } else if (resType !== undefined) {
        errors.push({
          code: "LOCKFILE_PACKAGE_UNSUPPORTED_RESOLUTION",
          message: `package ${packageKey} has an unsupported resolution type ${JSON.stringify(resType)}`,
          package: packageKey,
        });
        continue;
      } else if (tarballStr !== undefined) {
        sourceKind = "tarball-url";
        tarballUrl = tarballStr;
      }
    }
    packages.set(packageKey, {
      packageKey,
      name: parsed.name,
      version: parsed.version,
      integrity,
      sourceKind,
      tarballUrl,
    });
  }
  return packages;
}

function parseEdges(
  raw: unknown,
  snapshotKey: string,
  section: string,
  errors: GenerationError[],
): SnapshotEdge[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!isObject(raw)) {
    errors.push({
      code: "LOCKFILE_SNAPSHOT_MALFORMED",
      message: `snapshot ${snapshotKey} ${section} is not a mapping`,
      package: snapshotKey,
    });
    return null;
  }
  const edges: SnapshotEdge[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isValidPackageName(name) || typeof value !== "string" || value.length === 0) {
      errors.push({
        code: "LOCKFILE_SNAPSHOT_MALFORMED",
        message: `snapshot ${snapshotKey} ${section} has a malformed edge for ${JSON.stringify(name)}`,
        package: snapshotKey,
      });
      return null;
    }
    const res = resolveReference(name, value);
    if (res.kind !== "registry") {
      const detail =
        res.kind === "error"
          ? res.reason
          : `unexpected first-party reference ${JSON.stringify(value)}`;
      errors.push({
        code: "LOCKFILE_DEPENDENCY_REFERENCE_INVALID",
        message: `snapshot ${snapshotKey} ${section} dependency ${name}: ${detail}`,
        package: snapshotKey,
      });
      return null;
    }
    edges.push({ name: res.resolvedName, snapshotKey: res.snapshotKey });
  }
  return edges;
}

function parseSnapshots(
  snapshotsObj: Record<string, unknown>,
  errors: GenerationError[],
): Map<string, SnapshotNode> {
  const snapshots = new Map<string, SnapshotNode>();
  for (const [snapshotKey, val] of Object.entries(snapshotsObj)) {
    if (!isObject(val)) {
      errors.push({
        code: "LOCKFILE_SNAPSHOT_MALFORMED",
        message: `snapshot ${snapshotKey} is not a mapping`,
        package: snapshotKey,
      });
      continue;
    }
    const parsed = parseLockfileKey(snapshotKey);
    if (parsed === null) {
      errors.push({
        code: "LOCKFILE_SNAPSHOT_KEY_INVALID",
        message: `snapshot key ${JSON.stringify(snapshotKey)} is not a supported name@version (with an optional peer suffix)`,
        package: snapshotKey,
      });
      continue;
    }
    const deps = parseEdges(readProp(val, "dependencies"), snapshotKey, "dependencies", errors);
    const optDeps = parseEdges(
      readProp(val, "optionalDependencies"),
      snapshotKey,
      "optionalDependencies",
      errors,
    );
    if (deps === null || optDeps === null) {
      continue;
    }
    snapshots.set(snapshotKey, {
      name: parsed.name,
      version: parsed.version,
      packageKey: parsed.baseKey,
      dependencies: deps,
      optionalDependencies: optDeps,
    });
  }
  return snapshots;
}

function parseImporterSection(
  raw: unknown,
  importerPath: string,
  section: string,
  errors: GenerationError[],
): Map<string, ImporterResolution> | null {
  if (raw === undefined) {
    return new Map();
  }
  if (!isObject(raw)) {
    errors.push({
      code: "LOCKFILE_IMPORTER_MALFORMED",
      message: `importer ${importerPath} ${section} is not a mapping`,
      package: importerPath,
    });
    return null;
  }
  const map = new Map<string, ImporterResolution>();
  for (const [name, entry] of Object.entries(raw)) {
    if (!isValidPackageName(name)) {
      errors.push({
        code: "LOCKFILE_IMPORTER_MALFORMED",
        message: `importer ${importerPath} ${section} has an invalid dependency name ${JSON.stringify(name)}`,
        package: importerPath,
      });
      return null;
    }
    if (!isObject(entry)) {
      errors.push({
        code: "LOCKFILE_IMPORTER_MALFORMED",
        message: `importer ${importerPath} ${section} entry ${JSON.stringify(name)} is not a mapping`,
        package: importerPath,
      });
      return null;
    }
    const specifier = readProp(entry, "specifier");
    const version = readProp(entry, "version");
    if (
      typeof specifier !== "string" ||
      specifier.length === 0 ||
      typeof version !== "string" ||
      version.length === 0
    ) {
      errors.push({
        code: "LOCKFILE_IMPORTER_MALFORMED",
        message: `importer ${importerPath} ${section} entry ${JSON.stringify(name)} needs string specifier and version`,
        package: importerPath,
      });
      return null;
    }
    map.set(name, { specifier, version });
  }
  return map;
}

function parseImporters(
  importersObj: Record<string, unknown>,
  errors: GenerationError[],
): Map<string, ImporterSections> {
  const importers = new Map<string, ImporterSections>();
  const canonicalSeen = new Set<string>();
  for (const [importerPath, val] of Object.entries(importersObj)) {
    if (!isValidImporterPath(importerPath)) {
      errors.push({
        code: "LOCKFILE_IMPORTER_PATH_INVALID",
        message: `invalid lockfile importer path ${JSON.stringify(importerPath)}`,
        package: importerPath,
      });
      continue;
    }
    if (canonicalSeen.has(importerPath)) {
      errors.push({
        code: "LOCKFILE_IMPORTER_PATH_DUPLICATE",
        message: `lockfile importer path ${importerPath} collides with another canonical importer`,
        package: importerPath,
      });
      continue;
    }
    canonicalSeen.add(importerPath);
    if (!isObject(val)) {
      errors.push({
        code: "LOCKFILE_IMPORTER_MALFORMED",
        message: `importer ${importerPath} is not a mapping`,
        package: importerPath,
      });
      continue;
    }
    const dependencies = parseImporterSection(
      readProp(val, "dependencies"),
      importerPath,
      "dependencies",
      errors,
    );
    const optionalDependencies = parseImporterSection(
      readProp(val, "optionalDependencies"),
      importerPath,
      "optionalDependencies",
      errors,
    );
    const devDependencies = parseImporterSection(
      readProp(val, "devDependencies"),
      importerPath,
      "devDependencies",
      errors,
    );
    if (dependencies === null || optionalDependencies === null || devDependencies === null) {
      continue;
    }
    importers.set(importerPath, { dependencies, optionalDependencies, devDependencies });
  }
  return importers;
}

// -- entry ------------------------------------------------------------------

export function parsePnpmLockfileV9(
  lockfile: unknown,
  manifests: readonly NormalizedManifestDecl[],
  limits?: Partial<AdapterLimits>,
): ParseResult {
  const adapterLimits: AdapterLimits = { ...DEFAULT_ADAPTER_LIMITS, ...(limits ?? {}) };
  if (
    !Number.isSafeInteger(adapterLimits.maxManifestDeclarations) ||
    adapterLimits.maxManifestDeclarations <= 0
  ) {
    return {
      ok: false,
      errors: [
        {
          code: "ADAPTER_LIMITS_INVALID",
          message: `maxManifestDeclarations must be a positive safe integer (got ${String(adapterLimits.maxManifestDeclarations)})`,
        },
      ],
    };
  }

  // Phase A: structural (short-circuit; cannot proceed on a malformed shell).
  if (!isObject(lockfile)) {
    return {
      ok: false,
      errors: [{ code: "LOCKFILE_MALFORMED", message: "lockfile is not a mapping" }],
    };
  }
  if (readProp(lockfile, "lockfileVersion") !== "9.0") {
    return {
      ok: false,
      errors: [
        {
          code: "LOCKFILE_UNSUPPORTED_VERSION",
          message: `unsupported lockfileVersion (expected "9.0", got ${JSON.stringify(readProp(lockfile, "lockfileVersion"))})`,
        },
      ],
    };
  }
  const rawImporters = readProp(lockfile, "importers");
  const rawPackages = readProp(lockfile, "packages");
  const rawSnapshots = readProp(lockfile, "snapshots");
  if (!isObject(rawImporters)) {
    return {
      ok: false,
      errors: [
        {
          code: "LOCKFILE_MALFORMED",
          message: "lockfile importers section is missing or not a mapping",
        },
      ],
    };
  }
  if (rawPackages !== undefined && !isObject(rawPackages)) {
    return {
      ok: false,
      errors: [
        { code: "LOCKFILE_MALFORMED", message: "lockfile packages section is not a mapping" },
      ],
    };
  }
  if (rawSnapshots !== undefined && !isObject(rawSnapshots)) {
    return {
      ok: false,
      errors: [
        { code: "LOCKFILE_MALFORMED", message: "lockfile snapshots section is not a mapping" },
      ],
    };
  }
  const packagesObj = isObject(rawPackages) ? rawPackages : {};
  const snapshotsObj = isObject(rawSnapshots) ? rawSnapshots : {};

  // Stage 1: validate manifests + parse lockfile sections (accumulate).
  const parseErrors: GenerationError[] = [];
  validateManifests(manifests, adapterLimits, parseErrors);
  const packages = parsePackages(packagesObj, parseErrors);
  const snapshots = parseSnapshots(snapshotsObj, parseErrors);
  const importers = parseImporters(rawImporters, parseErrors);
  if (parseErrors.length > 0) {
    return { ok: false, errors: sortErrors(parseErrors) };
  }

  // Stage 2: bijection + resolution + reverse validation (accumulate).
  const errors: GenerationError[] = [];
  const sortedManifests = [...manifests].sort((a, b) => cmp(a.importerPath, b.importerPath));

  const manifestByImporter = new Map<string, NormalizedManifestDecl>();
  for (const m of sortedManifests) {
    manifestByImporter.set(m.importerPath, m);
  }
  for (const m of sortedManifests) {
    if (!importers.has(m.importerPath)) {
      errors.push({
        code: "LOCKFILE_IMPORTER_MISSING_FOR_MANIFEST",
        message: `manifest importer ${m.importerPath} has no lockfile importer`,
        package: m.importerPath,
      });
    }
  }
  for (const importerPath of importers.keys()) {
    if (!manifestByImporter.has(importerPath)) {
      errors.push({
        code: "MANIFEST_MISSING_FOR_LOCKFILE_IMPORTER",
        message: `lockfile importer ${importerPath} has no committed manifest`,
        package: importerPath,
      });
    }
  }

  // Per-importer index of the lockfile section each dependency name is in; a name
  // in more than one section is malformed and is de-indexed to avoid cascades.
  const lockfileSectionIndex = new Map<
    string,
    Map<string, { section: SectionName; resolution: ImporterResolution }>
  >();
  const conflictedByImporter = new Map<string, Set<string>>();
  for (const [importerPath, importer] of importers) {
    const idx = new Map<string, { section: SectionName; resolution: ImporterResolution }>();
    const conflicted = new Set<string>();
    const firstSection = new Map<string, SectionName>();
    for (const [sectionName, secMap] of importerSectionEntries(importer)) {
      for (const [name, resolution] of secMap) {
        const prior = firstSection.get(name);
        if (prior === undefined) {
          firstSection.set(name, sectionName);
          idx.set(name, { section: sectionName, resolution });
        } else if (!conflicted.has(name)) {
          errors.push({
            code: "LOCKFILE_IMPORTER_DECLARATION_IN_MULTIPLE_SECTIONS",
            message: `${name} in lockfile importer ${importerPath} appears in both ${prior} and ${sectionName}`,
            package: name,
          });
          conflicted.add(name);
          idx.delete(name);
        }
      }
    }
    lockfileSectionIndex.set(importerPath, idx);
    conflictedByImporter.set(importerPath, conflicted);
  }

  // Forward: classify each manifest declaration exactly once.
  const roots: ResolvedRootEdge[] = [];
  const unresolvedPeers: UnresolvedPeerRoot[] = [];
  const firstParty = new Set<string>();
  for (const m of sortedManifests) {
    const lockIndex = lockfileSectionIndex.get(m.importerPath);
    const conflicted = conflictedByImporter.get(m.importerPath);
    if (lockIndex === undefined || conflicted === undefined) {
      continue; // bijection error already recorded
    }
    for (const s of sectionsOf(m)) {
      if (s.name === "peerDependencies") {
        for (const d of s.decls) {
          if (conflicted.has(d.name)) {
            continue;
          }
          const lockEntry = lockIndex.get(d.name);
          if (lockEntry === undefined) {
            unresolvedPeers.push({
              kind: "unresolved-peer",
              importerPath: m.importerPath,
              name: d.name,
              declaredSpec: d.declaredSpec,
            });
          } else {
            errors.push({
              code: "LOCKFILE_IMPORTER_SECTION_MISMATCH",
              message: `${d.name} in ${m.importerPath} is a manifest peerDependency but appears in lockfile ${lockEntry.section}`,
              package: d.name,
            });
          }
        }
        continue;
      }
      for (const d of s.decls) {
        if (conflicted.has(d.name)) {
          continue;
        }
        const lockEntry = lockIndex.get(d.name);
        if (lockEntry === undefined) {
          errors.push({
            code: "MANIFEST_DECLARATION_UNRESOLVED",
            message: `${d.name} declared in ${m.importerPath} ${s.name} is not present in any lockfile importer section`,
            package: d.name,
          });
          continue;
        }
        if (lockEntry.section !== s.name) {
          errors.push({
            code: "LOCKFILE_IMPORTER_SECTION_MISMATCH",
            message: `${d.name} in ${m.importerPath} is declared in manifest ${s.name} but lockfile ${lockEntry.section}`,
            package: d.name,
          });
          continue;
        }
        if (lockEntry.resolution.specifier !== d.declaredSpec) {
          errors.push({
            code: "LOCKFILE_IMPORTER_SPEC_MISMATCH",
            message: `${d.name} in ${m.importerPath} ${s.name}: manifest spec ${JSON.stringify(d.declaredSpec)} differs from lockfile specifier ${JSON.stringify(lockEntry.resolution.specifier)}`,
            package: d.name,
          });
          continue;
        }
        const res = resolveReference(d.name, lockEntry.resolution.version);
        if (res.kind === "error") {
          errors.push({
            code: "LOCKFILE_IMPORTER_REFERENCE_INVALID",
            message: `${d.name} in ${m.importerPath}: ${res.reason}`,
            package: d.name,
          });
          continue;
        }
        if (res.kind === "first-party") {
          const target = resolveImporterRelative(m.importerPath, res.linkTarget);
          if (target === null) {
            errors.push({
              code: "FIRST_PARTY_TARGET_UNRESOLVED",
              message: `${d.name} in ${m.importerPath} links to ${JSON.stringify(res.linkTarget)}, which is not a valid in-repository target`,
              package: d.name,
            });
            continue;
          }
          const targetManifest = manifestByImporter.get(target);
          if (targetManifest === undefined) {
            errors.push({
              code: "FIRST_PARTY_TARGET_UNRESOLVED",
              message: `${d.name} in ${m.importerPath} links to ${target}, which is not a committed workspace importer`,
              package: d.name,
            });
            continue;
          }
          if (targetManifest.packageName !== d.name) {
            errors.push({
              code: "FIRST_PARTY_TARGET_NAME_MISMATCH",
              message: `${d.name} in ${m.importerPath} links to ${target}, whose package name is ${JSON.stringify(targetManifest.packageName)}`,
              package: d.name,
            });
            continue;
          }
          firstParty.add(d.name);
          continue;
        }
        roots.push({
          kind: "resolved",
          importerPath: m.importerPath,
          name: res.resolvedName,
          snapshotKey: res.snapshotKey,
          posture: s.posture,
        });
      }
    }
  }

  // Reverse: only genuinely lockfile-only importer dependencies (section
  // mismatches and multi-section names are already classified above).
  const manifestNames = new Map<string, Set<string>>();
  for (const m of sortedManifests) {
    const set = new Set<string>();
    for (const s of sectionsOf(m)) {
      for (const d of s.decls) {
        set.add(d.name);
      }
    }
    manifestNames.set(m.importerPath, set);
  }
  for (const [importerPath, importer] of importers) {
    const declSet = manifestNames.get(importerPath);
    const conflicted = conflictedByImporter.get(importerPath) ?? new Set<string>();
    if (declSet === undefined) {
      continue; // MANIFEST_MISSING_FOR_LOCKFILE_IMPORTER already recorded
    }
    for (const [, secMap] of importerSectionEntries(importer)) {
      for (const name of secMap.keys()) {
        if (conflicted.has(name)) {
          continue;
        }
        if (!declSet.has(name)) {
          errors.push({
            code: "LOCKFILE_IMPORTER_DECLARATION_MISSING",
            message: `lockfile importer ${importerPath} lists ${name}, not declared in the manifest`,
            package: name,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors: sortErrors(errors) };
  }

  return {
    ok: true,
    graph: {
      roots,
      unresolvedPeers,
      snapshots,
      packages,
      firstParty: [...firstParty],
    },
  };
}
