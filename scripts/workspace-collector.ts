// scripts/workspace-collector.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Shared workspace-manifest discovery (M H5). Discovers manifests from the
// COMMITTED workspace definition (pnpm-workspace.yaml), validates unsafe patterns
// BEFORE touching the filesystem, resolves each pattern's parent physically and
// requires it to stay inside the repo BEFORE enumerating, follows symlinked
// package directories, and resolves each manifest physically (realpath) to keep it
// inside the repo. Any discovery failure returns NO manifests/paths -- a partial
// inventory must never let a consumer report "clean".
//
// Two exports over one shared discovery+path-validation pass:
//   - collectWorkspaceManifests(): reads and JSON-parses each manifest's content
//     (used by the dependency-boundary checker); behavior is unchanged.
//   - collectWorkspaceManifestPaths(): returns validated paths only, without ever
//     reading manifest content, so a caller can own the authoritative read.

import { existsSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { type RawManifest, sortViolations, type Violation } from "./dependency-policy-core.js";

export interface CollectResult {
  readonly manifests: readonly RawManifest[];
  readonly violations: readonly Violation[];
}

export interface ManifestPathsResult {
  readonly paths: readonly string[];
  readonly violations: readonly Violation[];
}

interface ManifestEntry {
  readonly path: string;
  readonly isRoot: boolean;
}

interface DiscoveryResult {
  readonly entries: readonly ManifestEntry[];
  readonly violations: readonly Violation[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readProp(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

/** Component-aware physical containment: is `physicalPath` outside `physicalRoot`?
 *  Uses `relative` + separator-aware `..` detection, so an in-repo path component
 *  such as `..cache` is NOT treated as an escape. */
function isOutsideRoot(physicalRoot: string, physicalPath: string): boolean {
  const rel = relative(physicalRoot, physicalPath);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function extractPackagePatterns(doc: unknown, out: Violation[]): string[] | null {
  if (!isObject(doc)) {
    out.push({
      code: "WORKSPACE_CONFIG_MALFORMED",
      message: "pnpm-workspace.yaml top-level must be a mapping",
    });
    return null;
  }
  const raw = readProp(doc, "packages");
  if (!Array.isArray(raw) || raw.length === 0) {
    out.push({
      code: "WORKSPACE_CONFIG_MALFORMED",
      message: "pnpm-workspace.yaml `packages` must be a non-empty array",
    });
    return null;
  }
  const patterns: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      out.push({
        code: "WORKSPACE_CONFIG_MALFORMED",
        message: "`packages` entries must be non-empty strings",
      });
      return null;
    }
    patterns.push(entry);
  }
  return patterns;
}

/** A workspace pattern must be relative, use `/` separators, and contain no
 *  whitespace, control characters (including NUL and DEL), backslashes, or `.`/`..`
 *  path components -- validated on the COMMITTED syntax before any filesystem access. */
function isSafeWorkspacePattern(pattern: string): boolean {
  if (pattern.length === 0 || /\s/.test(pattern)) {
    return false;
  }
  if (isAbsolute(pattern) || pattern.includes("\\")) {
    return false;
  }
  for (const ch of pattern) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return false; // control characters, including NUL and DEL
    }
  }
  for (const segment of pattern.split("/")) {
    if (segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}

/** Resolve one pattern to matched directory paths (lexical). Supported for
 *  schema v1: a literal directory, or a single terminal `<dir>/*`. The pattern's
 *  parent (wildcard) or literal directory is resolved with realpath and required
 *  to stay inside the repo BEFORE enumeration, so a `packages -> /outside` parent
 *  symlink cannot leak external directories into inventory. */
function resolvePattern(physicalRoot: string, pattern: string, out: Violation[]): string[] | null {
  if (!isSafeWorkspacePattern(pattern)) {
    out.push({
      code: "WORKSPACE_PATTERN_UNSUPPORTED",
      message: `unsafe or unsupported workspace pattern ${JSON.stringify(pattern)}`,
    });
    return null;
  }
  if (pattern.includes("*")) {
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
      out.push({
        code: "WORKSPACE_PATTERN_UNSUPPORTED",
        message: `unsupported workspace glob ${JSON.stringify(pattern)}`,
      });
      return null;
    }
    const parentLexical = join(physicalRoot, pattern.slice(0, -2));
    let parentPhysical: string;
    try {
      parentPhysical = realpathSync(parentLexical);
    } catch {
      out.push({
        code: "WORKSPACE_PATTERN_UNMATCHED",
        message: `workspace pattern ${JSON.stringify(pattern)} matched no directory`,
      });
      return null;
    }
    if (isOutsideRoot(physicalRoot, parentPhysical)) {
      out.push({
        code: "WORKSPACE_PATTERN_OUTSIDE_REPO",
        message: `workspace pattern ${JSON.stringify(pattern)} resolves to a directory outside the repository`,
      });
      return null;
    }
    let names: string[];
    try {
      names = readdirSync(parentLexical).sort();
    } catch {
      out.push({
        code: "WORKSPACE_PATTERN_UNMATCHED",
        message: `workspace pattern ${JSON.stringify(pattern)} matched no directory`,
      });
      return null;
    }
    const dirs: string[] = [];
    for (const name of names) {
      const full = join(parentLexical, name);
      try {
        if (statSync(full).isDirectory()) {
          dirs.push(full);
        }
      } catch {
        // broken symlink / vanished entry: not a package, skip
      }
    }
    if (dirs.length === 0) {
      out.push({
        code: "WORKSPACE_PATTERN_UNMATCHED",
        message: `workspace pattern ${JSON.stringify(pattern)} matched no directory`,
      });
      return null;
    }
    return dirs;
  }
  const literalLexical = join(physicalRoot, pattern);
  let literalPhysical: string;
  try {
    literalPhysical = realpathSync(literalLexical);
  } catch {
    out.push({
      code: "WORKSPACE_PATTERN_UNMATCHED",
      message: `workspace pattern ${JSON.stringify(pattern)} matched no directory`,
    });
    return null;
  }
  if (isOutsideRoot(physicalRoot, literalPhysical)) {
    out.push({
      code: "WORKSPACE_PATTERN_OUTSIDE_REPO",
      message: `workspace pattern ${JSON.stringify(pattern)} resolves outside the repository`,
    });
    return null;
  }
  try {
    if (statSync(literalLexical).isDirectory()) {
      return [literalLexical];
    }
  } catch {
    // fall through
  }
  out.push({
    code: "WORKSPACE_PATTERN_UNMATCHED",
    message: `workspace pattern ${JSON.stringify(pattern)} matched no directory`,
  });
  return null;
}

/** Discover and PATH-validate the workspace manifests without reading their
 *  content. Returns the path-valid entries plus every discovery/path violation
 *  (unsorted; callers sort). Content read + parse is the caller's responsibility. */
function discoverManifestPaths(repoRoot: string): DiscoveryResult {
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(repoRoot);
  } catch (err) {
    return {
      entries: [],
      violations: [
        {
          code: "WORKSPACE_CONFIG_MALFORMED",
          message: `cannot resolve repo root ${repoRoot}: ${(err as Error).message}`,
        },
      ],
    };
  }

  const wsPath = join(physicalRoot, "pnpm-workspace.yaml");
  const rootManifestPath = join(physicalRoot, "package.json");
  if (!existsSync(wsPath)) {
    return {
      entries: [],
      violations: [{ code: "WORKSPACE_CONFIG_MISSING", message: `missing ${wsPath}` }],
    };
  }
  if (!existsSync(rootManifestPath)) {
    return {
      entries: [],
      violations: [
        { code: "WORKSPACE_ROOT_MANIFEST_MISSING", message: `missing ${rootManifestPath}` },
      ],
    };
  }

  const violations: Violation[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(wsPath, "utf8"));
  } catch (err) {
    return {
      entries: [],
      violations: [
        {
          code: "WORKSPACE_CONFIG_MALFORMED",
          message: `malformed YAML in ${wsPath}: ${(err as Error).message}`,
        },
      ],
    };
  }
  const patterns = extractPackagePatterns(doc, violations);
  if (patterns === null) {
    return { entries: [], violations };
  }

  const candidates: { lexicalPath: string; isRoot: boolean; pattern: string }[] = [
    { lexicalPath: rootManifestPath, isRoot: true, pattern: "<root>" },
  ];
  for (const pattern of patterns) {
    const dirs = resolvePattern(physicalRoot, pattern, violations);
    if (dirs === null) {
      continue;
    }
    for (const dir of dirs) {
      candidates.push({ lexicalPath: join(dir, "package.json"), isRoot: false, pattern });
    }
  }

  const lexicalOwner = new Map<string, string>();
  const uniqueCandidates: { lexicalPath: string; isRoot: boolean }[] = [];
  for (const c of candidates) {
    const prior = lexicalOwner.get(c.lexicalPath);
    if (prior !== undefined) {
      violations.push({
        code: "WORKSPACE_MANIFEST_MATCHED_MULTIPLE_PATTERNS",
        message: `manifest ${c.lexicalPath} is matched by patterns ${JSON.stringify(prior)} and ${JSON.stringify(c.pattern)}`,
      });
      continue;
    }
    lexicalOwner.set(c.lexicalPath, c.pattern);
    uniqueCandidates.push({ lexicalPath: c.lexicalPath, isRoot: c.isRoot });
  }

  const seenPhysical = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const { lexicalPath, isRoot } of uniqueCandidates) {
    let stat: Stats;
    try {
      stat = statSync(lexicalPath);
    } catch {
      violations.push({
        code: "WORKSPACE_MANIFEST_MISSING",
        message: `missing manifest ${lexicalPath}`,
      });
      continue;
    }
    if (!stat.isFile()) {
      violations.push({
        code: "WORKSPACE_MANIFEST_MISSING",
        message: `manifest path is not a file: ${lexicalPath}`,
      });
      continue;
    }
    let physical: string;
    try {
      physical = realpathSync(lexicalPath);
    } catch (err) {
      violations.push({
        code: "WORKSPACE_MANIFEST_UNREADABLE",
        message: `cannot resolve ${lexicalPath}: ${(err as Error).message}`,
      });
      continue;
    }
    if (isOutsideRoot(physicalRoot, physical)) {
      violations.push({
        code: "WORKSPACE_MANIFEST_OUTSIDE_REPO",
        message: `manifest ${lexicalPath} resolves outside the repository root`,
      });
      continue;
    }
    if (seenPhysical.has(physical)) {
      violations.push({
        code: "WORKSPACE_MANIFEST_DUPLICATE",
        message: `manifest ${lexicalPath} resolves to an already-collected physical file`,
      });
      continue;
    }
    seenPhysical.add(physical);
    entries.push({ path: lexicalPath, isRoot });
  }
  return { entries, violations };
}

export function collectWorkspaceManifests(repoRoot: string): CollectResult {
  const { entries, violations } = discoverManifestPaths(repoRoot);
  const allViolations: Violation[] = [...violations];
  const manifests: RawManifest[] = [];
  for (const { path, isRoot } of entries) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      allViolations.push({
        code: "WORKSPACE_MANIFEST_UNREADABLE",
        message: `cannot read ${path}: ${(err as Error).message}`,
      });
      continue;
    }
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch (err) {
      allViolations.push({
        code: "WORKSPACE_MANIFEST_INVALID_JSON",
        message: `invalid JSON in ${path}: ${(err as Error).message}`,
      });
      continue;
    }
    manifests.push({ path, isRoot, content });
  }
  if (allViolations.length > 0) {
    return { manifests: [], violations: sortViolations(allViolations) };
  }
  return { manifests, violations: [] };
}

export function collectWorkspaceManifestPaths(repoRoot: string): ManifestPathsResult {
  const { entries, violations } = discoverManifestPaths(repoRoot);
  if (violations.length > 0) {
    return { paths: [], violations: sortViolations(violations) };
  }
  return { paths: entries.map((e) => e.path), violations: [] };
}
