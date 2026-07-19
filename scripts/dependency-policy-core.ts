// scripts/dependency-policy-core.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Pure, deterministic core for the dependency-boundary policy checker (M H5). No
// file I/O, no top-level execution. The boundary governs DIRECT dependency
// DECLARATIONS by the workspace manifests. `forbiddenByDefault` is absolute in
// every scope and cannot be overridden; `requiresReview` requires a valid,
// expiring allowlist override bound to declaredBy + dependency + scope. Any
// manifest-extraction violation short-circuits policy evaluation -- a partial or
// untrusted inventory must never report clean.

export type Scope = "production" | "optional-production" | "development" | "peer";

/** Stable identity for the repository root manifest (its package name is not
 *  relied on; cannot collide with a real package name). */
export const ROOT_DECLARED_BY = "//";

export interface DirectDep {
  readonly name: string;
  readonly scope: Scope;
  readonly declaredBy: string;
  readonly declaredSpec: string;
}

/** Allowlist override. v1 identity is declaredBy + dependency + scope; there is
 *  no versionRange in v1 (any extra field is rejected as unknown). */
export interface Override {
  readonly dependency: string;
  readonly declaredBy: string;
  readonly scope: Scope;
  readonly justification: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly reviewAfter: string;
}

export interface Policy {
  readonly schemaVersion: number;
  readonly forbiddenByDefault: readonly string[];
  readonly requiresReview: readonly string[];
  readonly allowlistOverrides: readonly Override[];
}

/** One raw manifest handed to the core: path (for messages), whether it is the
 *  repo root, and already-parsed JSON content. */
export interface RawManifest {
  readonly path: string;
  readonly isRoot: boolean;
  readonly content: unknown;
}

/** Machine-readable finding. `code` is stable; `message` is human prose. */
export interface Violation {
  readonly code: string;
  readonly message: string;
  readonly declaredBy?: string;
  readonly dependency?: string;
  readonly scope?: Scope;
}

const SCOPES: readonly Scope[] = ["production", "optional-production", "development", "peer"];

const MANIFEST_SECTIONS: readonly (readonly [string, Scope])[] = [
  ["dependencies", "production"],
  ["optionalDependencies", "optional-production"],
  ["devDependencies", "development"],
  ["peerDependencies", "peer"],
];

const POLICY_FIELDS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "forbiddenByDefault",
  "requiresReview",
  "allowlistOverrides",
]);

const OVERRIDE_FIELDS: ReadonlySet<string> = new Set([
  "dependency",
  "declaredBy",
  "scope",
  "justification",
  "approvedBy",
  "approvedAt",
  "reviewAfter",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readProp(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}

function depKey(declaredBy: string, name: string, scope: Scope): string {
  return `${declaredBy}\u0000${name}\u0000${scope}`;
}

// -- pattern matching -------------------------------------------------------

/** Scoped-family wildcard: `@scope/*` only. Not `foo/*`, not `@scope/sub/*`. */
const SCOPED_WILDCARD_RE = /^@[^/\s*]+\/\*$/;

/** A policy pattern is EITHER an exact package name (no `*`, no whitespace, no
 *  leading/trailing/doubled `/`) OR a single scoped-family wildcard `@scope/*`. */
export function isValidPattern(pattern: string): boolean {
  if (pattern.length === 0 || /\s/.test(pattern)) {
    return false;
  }
  if (pattern.includes("*")) {
    return SCOPED_WILDCARD_RE.test(pattern);
  }
  return !pattern.startsWith("/") && !pattern.endsWith("/") && !pattern.includes("//");
}

export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith("/*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

// -- date validation --------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Strict `YYYY-MM-DD` calendar date. Same-format zero-padded strings compare
 *  lexicographically in chronological order, so callers order by string compare. */
export function isValidCalendarDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (m === null) {
    return false;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) {
    return false;
  }
  const monthLengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = monthLengths[month - 1] ?? 0;
  return day >= 1 && day <= maxDay;
}

// -- sorting ----------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortViolations(violations: readonly Violation[]): Violation[] {
  return [...violations].sort(
    (a, b) =>
      cmp(a.declaredBy ?? "", b.declaredBy ?? "") ||
      cmp(a.dependency ?? "", b.dependency ?? "") ||
      cmp(a.scope ?? "", b.scope ?? "") ||
      cmp(a.code, b.code) ||
      cmp(a.message, b.message),
  );
}

// -- policy parsing (structural, static) ------------------------------------

interface ParsedPolicy {
  readonly policy: Policy | null;
  readonly violations: readonly Violation[];
}

function parseStringArray(raw: unknown, field: string, out: Violation[]): string[] | null {
  if (!Array.isArray(raw)) {
    out.push({ code: "POLICY_MALFORMED", message: `${field} must be an array` });
    return null;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  let ok = true;
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      out.push({ code: "POLICY_MALFORMED", message: `${field} entries must be non-empty strings` });
      ok = false;
      continue;
    }
    if (!isValidPattern(entry)) {
      out.push({
        code: "POLICY_INVALID_PATTERN",
        message: `${field} pattern ${JSON.stringify(entry)} must be an exact name or a single '@scope/*' wildcard`,
      });
      ok = false;
    }
    if (seen.has(entry)) {
      out.push({
        code: "POLICY_DUPLICATE_PATTERN",
        message: `${field} duplicate pattern ${JSON.stringify(entry)}`,
      });
      ok = false;
    }
    seen.add(entry);
    result.push(entry);
  }
  return ok ? result : null;
}

function parseOverrides(raw: unknown, out: Violation[]): Override[] | null {
  if (!Array.isArray(raw)) {
    out.push({ code: "POLICY_MALFORMED", message: "allowlistOverrides must be an array" });
    return null;
  }
  const result: Override[] = [];
  let ok = true;
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const where = `allowlistOverrides[${i}]`;
    if (!isObject(entry)) {
      out.push({ code: "OVERRIDE_MALFORMED", message: `${where} must be an object` });
      ok = false;
      continue;
    }
    let entryOk = true;
    for (const key of Object.keys(entry)) {
      if (!OVERRIDE_FIELDS.has(key)) {
        out.push({
          code: "OVERRIDE_UNKNOWN_FIELD",
          message: `${where} unknown field ${JSON.stringify(key)}`,
        });
        entryOk = false;
      }
    }
    const dependency = readProp(entry, "dependency");
    const declaredBy = readProp(entry, "declaredBy");
    const scope = readProp(entry, "scope");
    const justification = readProp(entry, "justification");
    const approvedBy = readProp(entry, "approvedBy");
    const approvedAt = readProp(entry, "approvedAt");
    const reviewAfter = readProp(entry, "reviewAfter");

    for (const [name, value] of [
      ["dependency", dependency],
      ["declaredBy", declaredBy],
      ["justification", justification],
      ["approvedBy", approvedBy],
    ] as const) {
      if (typeof value !== "string" || value.length === 0) {
        out.push({
          code: "OVERRIDE_MALFORMED",
          message: `${where}.${name} must be a non-empty string`,
        });
        entryOk = false;
      }
    }
    if (!isScope(scope)) {
      out.push({
        code: "OVERRIDE_INVALID_SCOPE",
        message: `${where}.scope must be one of ${SCOPES.join(", ")}`,
      });
      entryOk = false;
    }
    for (const [name, value] of [
      ["approvedAt", approvedAt],
      ["reviewAfter", reviewAfter],
    ] as const) {
      if (typeof value !== "string" || !isValidCalendarDate(value)) {
        out.push({
          code: "OVERRIDE_INVALID_DATE",
          message: `${where}.${name} must be a strict YYYY-MM-DD date`,
        });
        entryOk = false;
      }
    }
    if (
      typeof approvedAt === "string" &&
      typeof reviewAfter === "string" &&
      isValidCalendarDate(approvedAt) &&
      isValidCalendarDate(reviewAfter) &&
      !(reviewAfter > approvedAt)
    ) {
      out.push({
        code: "OVERRIDE_REVIEW_NOT_AFTER_APPROVED",
        message: `${where}.reviewAfter (${reviewAfter}) must be strictly after approvedAt (${approvedAt})`,
      });
      entryOk = false;
    }

    if (entryOk && isScope(scope)) {
      result.push({
        dependency: dependency as string,
        declaredBy: declaredBy as string,
        scope,
        justification: justification as string,
        approvedBy: approvedBy as string,
        approvedAt: approvedAt as string,
        reviewAfter: reviewAfter as string,
      });
    } else {
      ok = false;
    }
  }
  return ok ? result : null;
}

function parsePolicy(raw: unknown): ParsedPolicy {
  if (!isObject(raw)) {
    return {
      policy: null,
      violations: [{ code: "POLICY_MALFORMED", message: "policy must be an object" }],
    };
  }
  const violations: Violation[] = [];
  for (const key of Object.keys(raw)) {
    if (!POLICY_FIELDS.has(key)) {
      violations.push({
        code: "POLICY_UNKNOWN_FIELD",
        message: `unknown top-level policy field ${JSON.stringify(key)}`,
      });
    }
  }
  if (readProp(raw, "schemaVersion") !== 1) {
    violations.push({
      code: "POLICY_UNSUPPORTED_SCHEMA_VERSION",
      message: "policy schemaVersion must be 1",
    });
    return { policy: null, violations };
  }
  const forbidden = parseStringArray(
    readProp(raw, "forbiddenByDefault"),
    "forbiddenByDefault",
    violations,
  );
  const review = parseStringArray(readProp(raw, "requiresReview"), "requiresReview", violations);
  const overrides = parseOverrides(readProp(raw, "allowlistOverrides"), violations);

  if (forbidden !== null && review !== null) {
    const reviewSet = new Set(review);
    for (const pattern of forbidden) {
      if (reviewSet.has(pattern)) {
        violations.push({
          code: "POLICY_PATTERN_IN_BOTH_LISTS",
          message: `pattern ${JSON.stringify(pattern)} appears in both forbiddenByDefault and requiresReview`,
        });
      }
    }
  }
  if (violations.length > 0 || forbidden === null || review === null || overrides === null) {
    return { policy: null, violations };
  }
  return {
    policy: {
      schemaVersion: 1,
      forbiddenByDefault: forbidden,
      requiresReview: review,
      allowlistOverrides: overrides,
    },
    violations: [],
  };
}

// -- manifest extraction (non-cascading) ------------------------------------

export function extractDirectDeps(manifests: readonly RawManifest[]): {
  readonly deps: readonly DirectDep[];
  readonly violations: readonly Violation[];
} {
  const deps: DirectDep[] = [];
  const violations: Violation[] = [];
  const identities = new Set<string>();

  for (const manifest of manifests) {
    if (!isObject(manifest.content)) {
      violations.push({
        code: "MANIFEST_MALFORMED",
        message: `manifest ${manifest.path} is not a JSON object`,
      });
      continue;
    }
    let declaredBy: string;
    if (manifest.isRoot) {
      declaredBy = ROOT_DECLARED_BY;
    } else {
      const name = readProp(manifest.content, "name");
      if (typeof name !== "string" || name.length === 0) {
        violations.push({
          code: "MANIFEST_MISSING_NAME",
          message: `manifest ${manifest.path} is missing a string "name"`,
        });
        continue;
      }
      declaredBy = name;
    }
    if (identities.has(declaredBy)) {
      violations.push({
        code: "MANIFEST_DUPLICATE_IDENTITY",
        message: `duplicate workspace identity ${JSON.stringify(declaredBy)} (${manifest.path})`,
        declaredBy,
      });
      continue;
    }
    identities.add(declaredBy);

    const byName = new Map<string, { scope: Scope; spec: unknown }[]>();
    for (const [section, scope] of MANIFEST_SECTIONS) {
      const raw = readProp(manifest.content, section);
      if (raw === undefined) {
        continue;
      }
      if (!isObject(raw)) {
        violations.push({
          code: "MANIFEST_MALFORMED",
          message: `manifest ${manifest.path} section ${section} is not an object`,
          declaredBy,
        });
        continue;
      }
      for (const name of Object.keys(raw)) {
        const record = { scope, spec: readProp(raw, name) };
        const existing = byName.get(name);
        if (existing === undefined) {
          byName.set(name, [record]);
        } else {
          existing.push(record);
        }
      }
    }
    for (const [name, records] of byName) {
      if (name.length === 0) {
        violations.push({
          code: "MANIFEST_MALFORMED",
          message: `manifest ${manifest.path} declares an empty dependency name`,
          declaredBy,
        });
        continue;
      }
      if (records.length > 1) {
        violations.push({
          code: "MANIFEST_DEP_IN_MULTIPLE_SECTIONS",
          message: `manifest ${manifest.path} declares ${JSON.stringify(name)} in more than one dependency section`,
          declaredBy,
          dependency: name,
        });
        continue;
      }
      const only = records[0];
      if (only === undefined) {
        continue;
      }
      if (typeof only.spec !== "string" || only.spec.length === 0) {
        violations.push({
          code: "MANIFEST_INVALID_SPEC",
          message: `manifest ${manifest.path} dependency ${JSON.stringify(name)} must have a non-empty string specification`,
          declaredBy,
          dependency: name,
          scope: only.scope,
        });
        continue;
      }
      deps.push({ name, scope: only.scope, declaredBy, declaredSpec: only.spec });
    }
  }
  return {
    deps: [...deps].sort(
      (a, b) => cmp(a.declaredBy, b.declaredBy) || cmp(a.name, b.name) || cmp(a.scope, b.scope),
    ),
    violations,
  };
}

// -- override + dependency evaluation ---------------------------------------

function validateOverrides(
  policy: Policy,
  deps: readonly DirectDep[],
  asOf: string,
): { readonly violations: readonly Violation[]; readonly validKeys: ReadonlySet<string> } {
  const violations: Violation[] = [];
  const counts = new Map<string, number>();
  for (const o of policy.allowlistOverrides) {
    const k = depKey(o.declaredBy, o.dependency, o.scope);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const depIndex = new Set(deps.map((d) => depKey(d.declaredBy, d.name, d.scope)));
  const validKeys = new Set<string>();

  for (const o of policy.allowlistOverrides) {
    const k = depKey(o.declaredBy, o.dependency, o.scope);
    const meta = { declaredBy: o.declaredBy, dependency: o.dependency, scope: o.scope };
    let valid = true;
    if ((counts.get(k) ?? 0) > 1) {
      violations.push({
        code: "OVERRIDE_DUPLICATE",
        message: `duplicate override for ${o.dependency} (${o.scope}) by ${o.declaredBy}`,
        ...meta,
      });
      valid = false;
    }
    if (o.approvedAt > asOf) {
      violations.push({
        code: "OVERRIDE_APPROVED_AT_IN_FUTURE",
        message: `override approvedAt ${o.approvedAt} is after the evaluation date ${asOf}`,
        ...meta,
      });
      valid = false;
    }
    if (o.reviewAfter < asOf) {
      violations.push({
        code: "OVERRIDE_EXPIRED",
        message: `override for ${o.dependency} expired on ${o.reviewAfter} (evaluation date ${asOf})`,
        ...meta,
      });
      valid = false;
    }
    if (policy.forbiddenByDefault.some((p) => matchesPattern(o.dependency, p))) {
      violations.push({
        code: "OVERRIDE_TARGETS_FORBIDDEN",
        message: `override targets ${o.dependency}, which is forbiddenByDefault and cannot be overridden`,
        ...meta,
      });
      valid = false;
    }
    const matchesDep = depIndex.has(k);
    const isReviewDep = policy.requiresReview.some((p) => matchesPattern(o.dependency, p));
    if (!matchesDep || !isReviewDep) {
      violations.push({
        code: "OVERRIDE_NO_MATCH",
        message: `override for ${o.dependency} (${o.scope}) by ${o.declaredBy} matches no review-required direct declaration`,
        ...meta,
      });
      valid = false;
    }
    if (valid) {
      validKeys.add(k);
    }
  }
  return { violations, validKeys };
}

function evaluateDeps(
  policy: Policy,
  deps: readonly DirectDep[],
  validKeys: ReadonlySet<string>,
): readonly Violation[] {
  const violations: Violation[] = [];
  for (const dep of deps) {
    const meta = { declaredBy: dep.declaredBy, dependency: dep.name, scope: dep.scope };
    const forbiddenMatches = policy.forbiddenByDefault.filter((p) => matchesPattern(dep.name, p));
    const reviewMatches = policy.requiresReview.filter((p) => matchesPattern(dep.name, p));
    if (
      forbiddenMatches.length > 1 ||
      reviewMatches.length > 1 ||
      (forbiddenMatches.length >= 1 && reviewMatches.length >= 1)
    ) {
      violations.push({
        code: "POLICY_AMBIGUOUS_MATCH",
        message: `${dep.name} matches multiple policy rules (forbidden: [${forbiddenMatches.join(", ")}], review: [${reviewMatches.join(", ")}]); tighten the policy`,
        ...meta,
      });
      continue;
    }
    if (forbiddenMatches.length === 1) {
      violations.push({
        code: "FORBIDDEN_DEPENDENCY",
        message: `${dep.name} (${dep.scope}) declared by ${dep.declaredBy} is forbidden by the dependency boundary`,
        ...meta,
      });
      continue;
    }
    if (reviewMatches.length === 1 && !validKeys.has(depKey(dep.declaredBy, dep.name, dep.scope))) {
      violations.push({
        code: "REVIEW_REQUIRED_WITHOUT_OVERRIDE",
        message: `${dep.name} (${dep.scope}) declared by ${dep.declaredBy} requires review; add a valid, expiring allowlist override`,
        ...meta,
      });
    }
  }
  return violations;
}

/**
 * Full deterministic evaluation. Empty result means the policy passes. A
 * malformed/unsupported policy OR any manifest-extraction violation
 * short-circuits -- dependencies are not evaluated against an untrusted policy
 * or a partial inventory.
 */
export function evaluateAll(
  rawPolicy: unknown,
  manifests: readonly RawManifest[],
  asOf: string,
): readonly Violation[] {
  if (!isValidCalendarDate(asOf)) {
    return [
      {
        code: "INVALID_AS_OF",
        message: `evaluation date must be a strict YYYY-MM-DD, got ${JSON.stringify(asOf)}`,
      },
    ];
  }
  const parsed = parsePolicy(rawPolicy);
  if (parsed.policy === null) {
    return sortViolations(parsed.violations);
  }
  const policy = parsed.policy;
  const { deps, violations: manifestViolations } = extractDirectDeps(manifests);
  if (manifestViolations.length > 0) {
    return sortViolations(manifestViolations);
  }
  const { violations: overrideViolations, validKeys } = validateOverrides(policy, deps, asOf);
  const depViolations = evaluateDeps(policy, deps, validKeys);
  return sortViolations([...overrideViolations, ...depViolations]);
}
