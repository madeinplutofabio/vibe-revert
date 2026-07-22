// scripts/license-collector.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Filesystem collector for the M H5 license audit (see
// docs/adr/0001-deterministic-license-audit.md). The only I/O module: it reads,
// hashes, and parses the committed inputs, discovers workspace manifests through
// the hardened paths-only discovery, and hands parsed data to the pure adapter and
// schema validators.
//
// Every authoritative file is read through a race-safe descriptor contract:
// resolveAndStat (logical containment -> lstat symlink policy -> realpathSync ->
// PHYSICAL containment -> statSync the canonical path), then open the CANONICAL
// path, fstat, bind the descriptor identity to both the just-taken physical stat
// AND (for manifests) the identity recorded during preflight, read exactly the
// descriptor's size under the byte bound, and fstat again to reject any change.
// realpath is performed for EVERY path so a symlinked parent directory cannot
// redirect a read whose final component is an ordinary file. Manifest reads are
// bound to the preflight identity so a file cannot be swapped between the sizing
// pass and the authoritative read.
//
// Inputs are decoded as fatal UTF-8 and parsed strictly: duplicate-key- and
// limit-bounded JSON (scripts/strict-json.ts) for the JSON inputs; a hardened
// single-document YAML for the lockfile that rejects duplicate keys, aliases,
// anchors, explicit tags, merge keys, warnings, multiple documents, and structures
// exceeding explicit depth/node bounds before toJS() materializes them. No
// downstream validator runs on an input that failed to read, decode, or parse.
//
// manifestsSha256 reproducibility contract: entries { repository-relative POSIX
// path, hex SHA-256 of the raw bytes } are sorted by path, serialized as the exact
// UTF-8 string `${JSON.stringify(path)}:${sha256}\n` per entry (concatenated), and
// SHA-256'd.

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isCollection, isScalar, parseAllDocuments, visit } from "yaml";

import type {
  GenerationError,
  InputHashes,
  LockfileGraph,
  MetadataCache,
  Policy,
} from "./license-audit-core.js";
import {
  type AdapterLimits,
  type DirectDeclaration,
  type NormalizedManifestDecl,
  parsePnpmLockfileV9,
} from "./license-lockfile-v9.js";
import { parseMetadataCache, parsePolicy, type SchemaLimits } from "./license-schemas.js";
import { parseStrictJson, type StrictJsonLimits } from "./strict-json.js";
import { collectWorkspaceManifestPaths } from "./workspace-collector.js";

export interface CollectorLimits {
  readonly maxLockfileBytes: number;
  readonly maxPolicyBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxManifestBytes: number;
  readonly maxTotalManifestBytes: number;
  readonly maxManifestCount: number;
  readonly maxYamlDepth: number;
  readonly maxYamlNodes: number;
}

export const DEFAULT_COLLECTOR_LIMITS: CollectorLimits = {
  maxLockfileBytes: 32 * 1024 * 1024,
  maxPolicyBytes: 4 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxTotalManifestBytes: 64 * 1024 * 1024,
  maxManifestCount: 100_000,
  maxYamlDepth: 64,
  maxYamlNodes: 10_000_000,
};

export interface CollectOptions {
  readonly collectorLimits?: Partial<CollectorLimits>;
  readonly schemaLimits?: Partial<SchemaLimits>;
  readonly adapterLimits?: Partial<AdapterLimits>;
  readonly jsonLimits?: Partial<StrictJsonLimits>;
}

export interface CollectedInputs {
  readonly graph: LockfileGraph;
  readonly policy: Policy;
  readonly cache: MetadataCache;
  readonly hashes: InputHashes;
}

export type CollectResult =
  | { readonly ok: true; readonly inputs: CollectedInputs }
  | { readonly ok: false; readonly errors: readonly GenerationError[] };

// -- helpers ----------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function readProp(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

function getField(v: unknown, key: string): unknown {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortErrors(errors: readonly GenerationError[]): GenerationError[] {
  const seen = new Set<string>();
  const out: GenerationError[] = [];
  for (const e of errors) {
    const k = JSON.stringify([e.code, e.package ?? null, e.message]);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out.sort(
    (a, b) =>
      cmp(a.package ?? "", b.package ?? "") || cmp(a.code, b.code) || cmp(a.message, b.message),
  );
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function posixDirname(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "." : relPath.slice(0, idx);
}

function isOutsideRoot(physicalRoot: string, path: string): boolean {
  const rel = relative(physicalRoot, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function checkCollectorLimits(limits: CollectorLimits): GenerationError[] {
  const errors: GenerationError[] = [];
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push({
        code: "COLLECTOR_LIMITS_INVALID",
        message: `limit ${name} must be a positive safe integer (got ${String(value)})`,
      });
    }
  }
  return errors;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(
  buf: Buffer,
  code: string,
  label: string,
  errors: GenerationError[],
): string | null {
  try {
    return UTF8_DECODER.decode(buf);
  } catch {
    errors.push({ code, message: `${label} is not valid UTF-8` });
    return null;
  }
}

// -- race-safe reads --------------------------------------------------------

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

function identityEq(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

interface ReadCodes {
  readonly outside: string;
  readonly symlink: string;
  readonly read: string;
  readonly tooLarge: string;
  readonly changed: string;
}

function codesFor(prefix: string): ReadCodes {
  return {
    outside: `${prefix}_PATH_OUTSIDE_REPOSITORY`,
    symlink: `${prefix}_INPUT_SYMLINK`,
    read: `${prefix}_READ_ERROR`,
    tooLarge: `${prefix}_FILE_TOO_LARGE`,
    changed: `${prefix}_CHANGED_DURING_READ`,
  };
}

/**
 * Resolve a logical path to its canonical physical path and current identity.
 * Validates logical containment, applies the symlink policy to the final
 * component, resolves the whole path with realpath (catching a symlinked parent
 * directory), enforces physical containment, and requires the canonical target to
 * be a regular file. Returns the canonical path plus its {dev,ino,size,mtimeMs}.
 */
function resolveAndStat(
  logicalPath: string,
  physicalRoot: string,
  allowSymlink: boolean,
  codes: ReadCodes,
  errors: GenerationError[],
): { physicalPath: string; id: FileIdentity } | null {
  if (isOutsideRoot(physicalRoot, logicalPath)) {
    errors.push({ code: codes.outside, message: `${logicalPath} is outside the repository` });
    return null;
  }
  let lst: Stats;
  try {
    lst = lstatSync(logicalPath);
  } catch (err) {
    errors.push({
      code: codes.read,
      message: `cannot lstat ${logicalPath}: ${(err as Error).message}`,
    });
    return null;
  }
  if (lst.isSymbolicLink()) {
    if (!allowSymlink) {
      errors.push({
        code: codes.symlink,
        message: `${logicalPath} is a symlink; authoritative inputs must be regular files`,
      });
      return null;
    }
  } else if (!lst.isFile()) {
    errors.push({ code: codes.read, message: `${logicalPath} is not a regular file` });
    return null;
  }
  let physicalPath: string;
  try {
    physicalPath = realpathSync(logicalPath);
  } catch (err) {
    errors.push({
      code: codes.read,
      message: `cannot resolve ${logicalPath}: ${(err as Error).message}`,
    });
    return null;
  }
  if (isOutsideRoot(physicalRoot, physicalPath)) {
    errors.push({ code: codes.outside, message: `${logicalPath} resolves outside the repository` });
    return null;
  }
  let st: Stats;
  try {
    st = statSync(physicalPath);
  } catch (err) {
    errors.push({
      code: codes.read,
      message: `cannot stat ${logicalPath}: ${(err as Error).message}`,
    });
    return null;
  }
  if (!st.isFile()) {
    errors.push({ code: codes.read, message: `${logicalPath} is not a regular file` });
    return null;
  }
  return { physicalPath, id: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } };
}

/**
 * Race-safe read of a resolved, contained regular file. Opens the CANONICAL path,
 * binds the descriptor to the just-taken physical stat and (when supplied) the
 * expected preflight identity, reads exactly the descriptor's size under the byte
 * bound, and rejects any identity/size/mtime change across the read.
 */
function readSecure(
  logicalPath: string,
  physicalRoot: string,
  maxBytes: number,
  allowSymlink: boolean,
  expected: FileIdentity | null,
  codes: ReadCodes,
  errors: GenerationError[],
): Buffer | null {
  const resolved = resolveAndStat(logicalPath, physicalRoot, allowSymlink, codes, errors);
  if (resolved === null) {
    return null;
  }
  const { physicalPath, id: current } = resolved;
  if (current.size > maxBytes) {
    errors.push({
      code: codes.tooLarge,
      message: `${logicalPath} is ${current.size} bytes (limit ${maxBytes})`,
    });
    return null;
  }
  if (expected !== null && !identityEq(current, expected)) {
    errors.push({
      code: codes.changed,
      message: `${logicalPath} changed between preflight and read`,
    });
    return null;
  }

  let fd: number | null = null;
  try {
    fd = openSync(physicalPath, "r");
    const before = fstatSync(fd);
    if (!before.isFile()) {
      errors.push({ code: codes.read, message: `${logicalPath} is not a regular file` });
      return null;
    }
    const beforeId: FileIdentity = {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
    };
    if (!identityEq(beforeId, current)) {
      errors.push({
        code: codes.changed,
        message: `${logicalPath} identity changed between check and open`,
      });
      return null;
    }
    if (expected !== null && !identityEq(beforeId, expected)) {
      errors.push({
        code: codes.changed,
        message: `${logicalPath} changed between preflight and open`,
      });
      return null;
    }
    if (before.size > maxBytes) {
      errors.push({
        code: codes.tooLarge,
        message: `${logicalPath} is ${before.size} bytes (limit ${maxBytes})`,
      });
      return null;
    }
    const size = before.size;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) {
        break;
      }
      read += n;
    }
    if (read !== size) {
      errors.push({ code: codes.changed, message: `${logicalPath} shortened during read` });
      return null;
    }
    const after = fstatSync(fd);
    const afterId: FileIdentity = {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
    };
    if (!identityEq(afterId, beforeId)) {
      errors.push({ code: codes.changed, message: `${logicalPath} changed during read` });
      return null;
    }
    return buf;
  } catch (err) {
    errors.push({
      code: codes.read,
      message: `cannot read ${logicalPath}: ${(err as Error).message}`,
    });
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

// -- strict parsing ---------------------------------------------------------

function parseJsonFile(
  text: string,
  prefix: string,
  jsonLimits: Partial<StrictJsonLimits> | undefined,
  errors: GenerationError[],
): unknown {
  const r = parseStrictJson(text, jsonLimits);
  if (r.ok) {
    return r.value;
  }
  let code: string;
  switch (r.error.kind) {
    case "duplicate-key":
      code = `${prefix}_JSON_DUPLICATE_KEY`;
      break;
    case "limit":
      code = `${prefix}_JSON_LIMIT_EXCEEDED`;
      break;
    case "invalid-limit":
      // Pre-validated before any read; defensive only, never a "document too large".
      code = "STRICT_JSON_LIMITS_INVALID";
      break;
    default:
      code = `${prefix}_JSON_INVALID`;
      break;
  }
  errors.push({
    code,
    message: `${prefix} JSON error at position ${r.error.position}: ${r.error.message}`,
  });
  return undefined;
}

/**
 * Hardened single-document YAML parse for the lockfile. Node-counting contract:
 * each Scalar, YAMLMap, and YAMLSeq counts as one node (scalar mapping keys are
 * counted as the scalar nodes they are); Pair containers are not counted; Alias
 * nodes are not counted because any alias is rejected outright. Depth is the number
 * of YAMLMap/YAMLSeq ancestors of a node. Structural bounds are enforced before
 * toJS() materializes a second representation.
 */
function parseLockfileYaml(
  text: string,
  limits: CollectorLimits,
  errors: GenerationError[],
): unknown {
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text, { uniqueKeys: true, merge: false, customTags: [] });
  } catch (err) {
    errors.push({
      code: "LOCKFILE_YAML_INVALID",
      message: `cannot parse pnpm-lock.yaml: ${(err as Error).message}`,
    });
    return undefined;
  }
  if (docs.length !== 1) {
    errors.push(
      docs.length === 0
        ? { code: "LOCKFILE_YAML_INVALID", message: "pnpm-lock.yaml contains no document" }
        : {
            code: "LOCKFILE_YAML_UNSUPPORTED_FEATURE",
            message: `pnpm-lock.yaml contains ${docs.length} documents; exactly one is required`,
          },
    );
    return undefined;
  }
  const doc = docs[0];
  if (doc === undefined) {
    errors.push({ code: "LOCKFILE_YAML_INVALID", message: "pnpm-lock.yaml contains no document" });
    return undefined;
  }
  let ok = true;
  for (const e of doc.errors) {
    errors.push(
      e.code === "DUPLICATE_KEY"
        ? {
            code: "LOCKFILE_YAML_DUPLICATE_KEY",
            message: "pnpm-lock.yaml has a duplicate mapping key",
          }
        : { code: "LOCKFILE_YAML_INVALID", message: `pnpm-lock.yaml YAML error ${e.code}` },
    );
    ok = false;
  }
  for (const w of doc.warnings) {
    errors.push({
      code: "LOCKFILE_YAML_UNSUPPORTED_FEATURE",
      message: `pnpm-lock.yaml has an unsupported or ambiguous construct (${w.code})`,
    });
    ok = false;
  }
  if (!ok) {
    return undefined;
  }

  const features = new Set<string>();
  let nodeCount = 0;
  let overflow: string | null = null;
  visit(doc, {
    Node(_key, node, path) {
      nodeCount += 1;
      if (nodeCount > limits.maxYamlNodes) {
        overflow = `node count exceeds ${limits.maxYamlNodes}`;
        return visit.BREAK;
      }
      let depth = 0;
      for (const ancestor of path) {
        if (isCollection(ancestor)) {
          depth += 1;
        }
      }
      if (depth > limits.maxYamlDepth) {
        overflow = `nesting depth exceeds ${limits.maxYamlDepth}`;
        return visit.BREAK;
      }
      if (getField(node, "anchor") !== undefined) {
        features.add("anchor");
      }
      if (getField(node, "tag") !== undefined) {
        features.add("explicit tag");
      }
      return undefined;
    },
    Alias() {
      features.add("alias");
    },
    Pair(_key, pair) {
      const key = getField(pair, "key");
      if (isScalar(key) && getField(key, "value") === "<<") {
        features.add("merge key");
      }
    },
  });
  if (overflow !== null) {
    errors.push({ code: "LOCKFILE_YAML_LIMIT_EXCEEDED", message: `pnpm-lock.yaml ${overflow}` });
    return undefined;
  }
  if (features.size > 0) {
    for (const feature of [...features].sort()) {
      errors.push({
        code: "LOCKFILE_YAML_UNSUPPORTED_FEATURE",
        message: `pnpm-lock.yaml uses an unsupported YAML feature: ${feature}`,
      });
    }
    return undefined;
  }
  try {
    return doc.toJS({ maxAliasCount: 100 });
  } catch (err) {
    errors.push({
      code: "LOCKFILE_YAML_LIMIT_EXCEEDED",
      message: `pnpm-lock.yaml expansion failed: ${(err as Error).message}`,
    });
    return undefined;
  }
}

// -- manifest declaration extraction (pure, syntactic only) -----------------

function extractSection(
  content: Record<string, unknown>,
  section: string,
  relPath: string,
  errors: GenerationError[],
): DirectDeclaration[] {
  const raw = readProp(content, section);
  if (raw === undefined) {
    return [];
  }
  if (!isPlainObject(raw)) {
    errors.push({
      code: "MANIFEST_SECTION_MALFORMED",
      message: `${relPath} ${section} is not an object`,
      package: relPath,
    });
    return [];
  }
  const decls: DirectDeclaration[] = [];
  for (const [name, spec] of Object.entries(raw)) {
    if (typeof spec !== "string") {
      errors.push({
        code: "MANIFEST_SPEC_INVALID",
        message: `${relPath} ${section} dependency ${JSON.stringify(name)} has a non-string specifier`,
        package: relPath,
      });
      continue;
    }
    decls.push({ name, declaredSpec: spec });
  }
  return decls;
}

export function extractManifestDeclaration(
  relPath: string,
  content: unknown,
): { ok: true; decl: NormalizedManifestDecl } | { ok: false; errors: readonly GenerationError[] } {
  const errors: GenerationError[] = [];
  if (!isPlainObject(content)) {
    return {
      ok: false,
      errors: [
        {
          code: "MANIFEST_NOT_OBJECT",
          message: `${relPath} is not a JSON object`,
          package: relPath,
        },
      ],
    };
  }
  const nameRaw = readProp(content, "name");
  let packageName: string | null = null;
  if (nameRaw !== undefined) {
    if (typeof nameRaw === "string") {
      packageName = nameRaw;
    } else {
      errors.push({
        code: "MANIFEST_NAME_INVALID",
        message: `${relPath} has a non-string "name"`,
        package: relPath,
      });
    }
  }
  const dependencies = extractSection(content, "dependencies", relPath, errors);
  const optionalDependencies = extractSection(content, "optionalDependencies", relPath, errors);
  const devDependencies = extractSection(content, "devDependencies", relPath, errors);
  const peerDependencies = extractSection(content, "peerDependencies", relPath, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    decl: {
      importerPath: posixDirname(relPath),
      manifestPath: relPath,
      packageName,
      dependencies,
      optionalDependencies,
      devDependencies,
      peerDependencies,
    },
  };
}

// -- manifest collection ----------------------------------------------------

interface ManifestPreflight {
  readonly logicalPath: string;
  readonly physicalPath: string;
  readonly relPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface ManifestCollection {
  readonly manifests: readonly NormalizedManifestDecl[];
  readonly manifestsSha256: string;
}

function collectManifests(
  repoRoot: string,
  physicalRoot: string,
  limits: CollectorLimits,
  options: CollectOptions | undefined,
  errors: GenerationError[],
): ManifestCollection | null {
  const discovery = collectWorkspaceManifestPaths(repoRoot);
  if (discovery.violations.length > 0) {
    for (const v of discovery.violations) {
      errors.push(
        v.declaredBy !== undefined
          ? { code: v.code, message: v.message, package: v.declaredBy }
          : { code: v.code, message: v.message },
      );
    }
    return null;
  }
  const logicalPaths = discovery.paths.map((p) => resolve(physicalRoot, p));

  if (logicalPaths.length > limits.maxManifestCount) {
    errors.push({
      code: "MANIFEST_COUNT_EXCEEDED",
      message: `${logicalPaths.length} manifests exceed the limit ${limits.maxManifestCount}`,
    });
    return null;
  }

  const codes = codesFor("MANIFEST");

  // Preflight: resolve + record identity, bound per-file size, and bound the total
  // with overflow-safe arithmetic (compare before adding). No file is read yet.
  const preflights: ManifestPreflight[] = [];
  let totalBytes = 0;
  let preflightOk = true;
  for (const logicalPath of logicalPaths) {
    const relPath = toPosix(relative(physicalRoot, logicalPath));
    const resolved = resolveAndStat(logicalPath, physicalRoot, true, codes, errors);
    if (resolved === null) {
      preflightOk = false;
      continue;
    }
    const { physicalPath, id } = resolved;
    if (id.size > limits.maxManifestBytes) {
      errors.push({
        code: "MANIFEST_FILE_TOO_LARGE",
        message: `${logicalPath} is ${id.size} bytes (limit ${limits.maxManifestBytes})`,
        package: relPath,
      });
      preflightOk = false;
      continue;
    }
    if (id.size > limits.maxTotalManifestBytes - totalBytes) {
      errors.push({
        code: "MANIFEST_TOTAL_BYTES_EXCEEDED",
        message: `total manifest bytes exceed the limit ${limits.maxTotalManifestBytes}`,
      });
      return null; // stop immediately once the aggregate bound is exceeded
    }
    totalBytes += id.size;
    preflights.push({
      logicalPath,
      physicalPath,
      relPath,
      dev: id.dev,
      ino: id.ino,
      size: id.size,
      mtimeMs: id.mtimeMs,
    });
  }
  if (!preflightOk) {
    return null;
  }

  // Read pass: each read is bound to the identity recorded in preflight.
  const entries: { path: string; sha256: string }[] = [];
  const decls: NormalizedManifestDecl[] = [];
  let ok = true;
  for (const pf of preflights) {
    const expected: FileIdentity = { dev: pf.dev, ino: pf.ino, size: pf.size, mtimeMs: pf.mtimeMs };
    const buf = readSecure(
      pf.logicalPath,
      physicalRoot,
      limits.maxManifestBytes,
      true,
      expected,
      codes,
      errors,
    );
    if (buf === null) {
      ok = false;
      continue;
    }
    entries.push({ path: pf.relPath, sha256: sha256(buf) });
    const text = decodeUtf8(buf, "MANIFEST_UTF8_INVALID", pf.relPath, errors);
    if (text === null) {
      ok = false;
      continue;
    }
    const content = parseJsonFile(text, "MANIFEST", options?.jsonLimits, errors);
    if (content === undefined) {
      ok = false;
      continue;
    }
    const extracted = extractManifestDeclaration(pf.relPath, content);
    if (!extracted.ok) {
      errors.push(...extracted.errors);
      ok = false;
      continue;
    }
    decls.push(extracted.decl);
  }
  if (!ok) {
    return null;
  }
  const canonical = [...entries]
    .sort((a, b) => cmp(a.path, b.path))
    .map(({ path, sha256: hash }) => `${JSON.stringify(path)}:${hash}\n`)
    .join("");
  return {
    manifests: decls,
    manifestsSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

// -- shared collection internals --------------------------------------------

interface PreparedRoot {
  readonly physicalRoot: string;
  readonly collectorLimits: CollectorLimits;
}

/**
 * Shared prelude for both entry points: merge + validate collector limits,
 * validate the strict-JSON limits once (before any read, so a caller
 * misconfiguration is one stable error rather than several per-file "too large"
 * errors), and resolve + verify the repository root. Returns the canonical root and
 * effective limits, or the fatal configuration/root errors.
 */
function prepareRoot(
  repoRoot: string,
  options: CollectOptions | undefined,
): { ok: true; prepared: PreparedRoot } | { ok: false; errors: readonly GenerationError[] } {
  const collectorLimits: CollectorLimits = {
    ...DEFAULT_COLLECTOR_LIMITS,
    ...(options?.collectorLimits ?? {}),
  };
  const limitErrors = checkCollectorLimits(collectorLimits);
  if (limitErrors.length > 0) {
    return { ok: false, errors: sortErrors(limitErrors) };
  }
  if (options?.jsonLimits !== undefined) {
    const probe = parseStrictJson("null", options.jsonLimits);
    if (!probe.ok && probe.error.kind === "invalid-limit") {
      return {
        ok: false,
        errors: [{ code: "STRICT_JSON_LIMITS_INVALID", message: probe.error.message }],
      };
    }
  }
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(repoRoot);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          code: "REPO_ROOT_UNRESOLVED",
          message: `cannot resolve repo root ${repoRoot}: ${(err as Error).message}`,
        },
      ],
    };
  }
  try {
    if (!statSync(physicalRoot).isDirectory()) {
      return {
        ok: false,
        errors: [{ code: "REPO_ROOT_NOT_DIRECTORY", message: `${repoRoot} is not a directory` }],
      };
    }
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          code: "REPO_ROOT_UNRESOLVED",
          message: `cannot stat repo root ${repoRoot}: ${(err as Error).message}`,
        },
      ],
    };
  }
  return { ok: true, prepared: { physicalRoot, collectorLimits } };
}

interface GraphCollection {
  readonly graph: LockfileGraph;
  readonly lockfileSha256: string;
  readonly manifestsSha256: string;
}

/**
 * Shared lockfile-graph collection: secure pnpm-lock.yaml read -> strict UTF-8 ->
 * hardened YAML -> secure workspace-manifest discovery/read -> v9 adapter.
 * Accumulates every read/parse/adapter error into `errors`; returns the graph
 * collection only when all of it succeeded, else undefined. Reads neither
 * license-policy.json nor license-metadata.json.
 */
function collectGraph(
  repoRoot: string,
  prepared: PreparedRoot,
  options: CollectOptions | undefined,
  errors: GenerationError[],
): GraphCollection | undefined {
  const { physicalRoot, collectorLimits } = prepared;

  const lockfileBuf = readSecure(
    join(physicalRoot, "pnpm-lock.yaml"),
    physicalRoot,
    collectorLimits.maxLockfileBytes,
    false,
    null,
    codesFor("LOCKFILE"),
    errors,
  );
  let lockfileParsed: unknown;
  let lockfileSha256: string | undefined;
  if (lockfileBuf !== null) {
    lockfileSha256 = sha256(lockfileBuf);
    const text = decodeUtf8(lockfileBuf, "LOCKFILE_UTF8_INVALID", "pnpm-lock.yaml", errors);
    if (text !== null) {
      lockfileParsed = parseLockfileYaml(text, collectorLimits, errors);
    }
  }

  const manifestCollection = collectManifests(
    repoRoot,
    physicalRoot,
    collectorLimits,
    options,
    errors,
  );

  let graph: LockfileGraph | undefined;
  if (lockfileParsed !== undefined && manifestCollection !== null) {
    const r = parsePnpmLockfileV9(
      lockfileParsed,
      manifestCollection.manifests,
      options?.adapterLimits,
    );
    if (r.ok) {
      graph = r.graph;
    } else {
      errors.push(...r.errors);
    }
  }

  if (graph === undefined || manifestCollection === null || lockfileSha256 === undefined) {
    return undefined;
  }
  return { graph, lockfileSha256, manifestsSha256: manifestCollection.manifestsSha256 };
}

interface ParsedInput<T> {
  readonly value: T;
  readonly digest: string;
}

/** Secure read + strict parse + schema validation of license-policy.json. */
function collectPolicy(
  prepared: PreparedRoot,
  options: CollectOptions | undefined,
  errors: GenerationError[],
): ParsedInput<Policy> | undefined {
  const { physicalRoot, collectorLimits } = prepared;
  const buf = readSecure(
    join(physicalRoot, "license-policy.json"),
    physicalRoot,
    collectorLimits.maxPolicyBytes,
    false,
    null,
    codesFor("POLICY"),
    errors,
  );
  if (buf === null) {
    return undefined;
  }
  const digest = sha256(buf);
  const text = decodeUtf8(buf, "POLICY_UTF8_INVALID", "license-policy.json", errors);
  if (text === null) {
    return undefined;
  }
  const parsed = parseJsonFile(text, "POLICY", options?.jsonLimits, errors);
  if (parsed === undefined) {
    return undefined;
  }
  const r = parsePolicy(parsed, options?.schemaLimits);
  if (!r.ok) {
    errors.push(...r.errors);
    return undefined;
  }
  return { value: r.policy, digest };
}

/** Secure read + strict parse + schema validation of license-metadata.json. */
function collectCache(
  prepared: PreparedRoot,
  options: CollectOptions | undefined,
  errors: GenerationError[],
): ParsedInput<MetadataCache> | undefined {
  const { physicalRoot, collectorLimits } = prepared;
  const buf = readSecure(
    join(physicalRoot, "license-metadata.json"),
    physicalRoot,
    collectorLimits.maxMetadataBytes,
    false,
    null,
    codesFor("METADATA"),
    errors,
  );
  if (buf === null) {
    return undefined;
  }
  const digest = sha256(buf);
  const text = decodeUtf8(buf, "METADATA_UTF8_INVALID", "license-metadata.json", errors);
  if (text === null) {
    return undefined;
  }
  const parsed = parseJsonFile(text, "METADATA", options?.jsonLimits, errors);
  if (parsed === undefined) {
    return undefined;
  }
  const r = parseMetadataCache(parsed, options?.schemaLimits);
  if (!r.ok) {
    errors.push(...r.errors);
    return undefined;
  }
  return { value: r.cache, digest };
}

// -- entry ------------------------------------------------------------------

export type GraphResult =
  | { readonly ok: true; readonly graph: LockfileGraph }
  | { readonly ok: false; readonly errors: readonly GenerationError[] };

/**
 * Collect ONLY the lockfile graph (pnpm-lock.yaml + workspace manifests), for
 * consumers that do not need license-policy.json or license-metadata.json — e.g.
 * the metadata refresh, which GENERATES the cache and so cannot depend on it.
 */
export function collectLockfileGraph(repoRoot: string, options?: CollectOptions): GraphResult {
  const prep = prepareRoot(repoRoot, options);
  if (!prep.ok) {
    return { ok: false, errors: prep.errors };
  }
  const errors: GenerationError[] = [];
  const gc = collectGraph(repoRoot, prep.prepared, options, errors);
  if (errors.length > 0) {
    return { ok: false, errors: sortErrors(errors) };
  }
  if (gc === undefined) {
    return {
      ok: false,
      errors: [
        {
          code: "COLLECTOR_INTERNAL",
          message: "lockfile graph incomplete after successful read, decode, and parse",
        },
      ],
    };
  }
  return { ok: true, graph: gc.graph };
}

export function collectLicenseInputs(repoRoot: string, options?: CollectOptions): CollectResult {
  const prep = prepareRoot(repoRoot, options);
  if (!prep.ok) {
    return { ok: false, errors: prep.errors };
  }
  const errors: GenerationError[] = [];
  const gc = collectGraph(repoRoot, prep.prepared, options, errors);
  const policy = collectPolicy(prep.prepared, options, errors);
  const cache = collectCache(prep.prepared, options, errors);

  if (errors.length > 0) {
    return { ok: false, errors: sortErrors(errors) };
  }
  if (gc === undefined || policy === undefined || cache === undefined) {
    return {
      ok: false,
      errors: [
        {
          code: "COLLECTOR_INTERNAL",
          message: "inputs incomplete after successful read, decode, parse, and validation",
        },
      ],
    };
  }
  return {
    ok: true,
    inputs: {
      graph: gc.graph,
      policy: policy.value,
      cache: cache.value,
      hashes: {
        lockfileSha256: gc.lockfileSha256,
        manifestsSha256: gc.manifestsSha256,
        policySha256: policy.digest,
        metadataSha256: cache.digest,
      },
    },
  };
}
