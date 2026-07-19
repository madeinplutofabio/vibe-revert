// scripts/workspace-collector.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Shared workspace-manifest collector (M H5). Discovers manifests from the
// COMMITTED workspace definition (pnpm-workspace.yaml), validates unsafe patterns
// BEFORE touching the filesystem, resolves each pattern's parent physically and
// requires it to stay inside the repo BEFORE enumerating, follows symlinked
// package directories, and resolves each manifest physically (realpath) to keep
// it inside the repo. Any collector failure returns NO manifests -- a partial
// inventory must never let policy evaluation report "clean". Shared by the entry
// and the tests.

import { existsSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { type RawManifest, sortViolations, type Violation } from "./dependency-policy-core.js";

export interface CollectResult {
  readonly manifests: readonly RawManifest[];
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
 *  whitespace, control characters (including NUL), backslashes, or `.`/`..` path
 *  components -- validated on the COMMITTED syntax before any filesystem access. */
function isSafeWorkspacePattern(pattern: string): boolean {
  if (pattern.length === 0 || /\s/.test(pattern)) {
    return false;
  }
  if (isAbsolute(pattern) || pattern.includes("\\")) {
    return false;
  }
  for (const ch of pattern) {
    if (ch.charCodeAt(0) < 0x20) {
      return false; // control characters, including NUL
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

export function collectWorkspaceManifests(repoRoot: string): CollectResult {
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(repoRoot);
  } catch (err) {
    return {
      manifests: [],
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
      manifests: [],
      violations: [{ code: "WORKSPACE_CONFIG_MISSING", message: `missing ${wsPath}` }],
    };
  }
  if (!existsSync(rootManifestPath)) {
    return {
      manifests: [],
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
      manifests: [],
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
    return { manifests: [], violations: sortViolations(violations) };
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
  const manifests: RawManifest[] = [];
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
    let text: string;
    try {
      text = readFileSync(lexicalPath, "utf8");
    } catch (err) {
      violations.push({
        code: "WORKSPACE_MANIFEST_UNREADABLE",
        message: `cannot read ${lexicalPath}: ${(err as Error).message}`,
      });
      continue;
    }
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch (err) {
      violations.push({
        code: "WORKSPACE_MANIFEST_INVALID_JSON",
        message: `invalid JSON in ${lexicalPath}: ${(err as Error).message}`,
      });
      continue;
    }
    manifests.push({ path: lexicalPath, isRoot, content });
  }

  if (violations.length > 0) {
    return { manifests: [], violations: sortViolations(violations) };
  }
  return { manifests, violations: [] };
}
