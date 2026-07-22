// scripts/license-schemas.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Pure strict validators for the two committed schemas of the M H5 license audit
// (see docs/adr/0001-deterministic-license-audit.md), plus the single SPDX
// normalizer used by the refresh command. No I/O, no execution on import, no
// unbounded recursion or allocation. Each validator consumes already-parsed JSON
// (`unknown`) and returns the typed value the core consumes or every schema error,
// subject to per-entry AND whole-document resource bounds that cover every
// schema-controlled string. Only plain JSON objects are accepted; schema identity,
// diagnostic, SPDX, obligation, and path strings must be control-free (including
// DEL), while rawLicense remains bounded JSON source data retained verbatim.
// `normalizeSpdx` and policy keys accept only a single canonical SPDX identifier
// (never a bare operator).

import type {
  CollectedRegistryMetadata,
  Disposition,
  FailedRegistryMetadata,
  FailedUnsupportedMetadata,
  GenerationError,
  JsonValue,
  MetadataCache,
  MetadataEntry,
  Policy,
  PolicyEntry,
} from "./license-audit-core.js";

export interface SchemaLimits {
  readonly maxPolicyEntries: number;
  readonly maxObligationsPerPolicyEntry: number;
  readonly maxTotalPolicyObligations: number;
  readonly maxMetadataEntries: number;
  readonly maxLegalFilesPerEntry: number;
  readonly maxTotalLegalFiles: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxTotalJsonNodes: number;
  readonly maxStringLength: number;
}

export const DEFAULT_SCHEMA_LIMITS: SchemaLimits = {
  maxPolicyEntries: 100_000,
  maxObligationsPerPolicyEntry: 1_000,
  maxTotalPolicyObligations: 1_000_000,
  maxMetadataEntries: 1_000_000,
  maxLegalFilesPerEntry: 10_000,
  maxTotalLegalFiles: 10_000_000,
  maxJsonDepth: 100,
  maxJsonNodes: 100_000,
  maxTotalJsonNodes: 10_000_000,
  maxStringLength: 1_000_000,
};

export type PolicyParseResult =
  | { readonly ok: true; readonly policy: Policy }
  | { readonly ok: false; readonly errors: readonly GenerationError[] };

export type MetadataParseResult =
  | { readonly ok: true; readonly cache: MetadataCache }
  | { readonly ok: false; readonly errors: readonly GenerationError[] };

interface PolicyBudget {
  obligations: number;
}

interface MetadataBudget {
  jsonNodes: number;
  legalFiles: number;
}

// -- helpers ----------------------------------------------------------------

/** A plain JSON object: not null, array, Date, Map, or a class/exotic instance. */
function isObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function readProp(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

/** Any C0 control, or DEL (0x7f). "Control-free" has this one meaning everywhere. */
function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isBoundedNonEmptyString(value: unknown, limits: SchemaLimits): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limits.maxStringLength &&
    !hasControlCharacter(value)
  );
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

function fail(errors: readonly GenerationError[]): {
  ok: false;
  errors: readonly GenerationError[];
} {
  return { ok: false, errors: sortErrors(errors) };
}

function checkSchemaLimits(limits: SchemaLimits): GenerationError[] {
  const errors: GenerationError[] = [];
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push({
        code: "SCHEMA_LIMITS_INVALID",
        message: `limit ${name} must be a positive safe integer (got ${String(value)})`,
      });
    }
  }
  return errors;
}

/** Reject unknown fields and length-bound the field names themselves, without
 *  interpolating an oversized name into the diagnostic. */
function checkFields(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  unknownCode: string,
  where: string,
  limits: SchemaLimits,
  errors: GenerationError[],
): boolean {
  let ok = true;
  for (const key of Object.keys(obj)) {
    if (key.length > limits.maxStringLength) {
      errors.push({
        code: unknownCode,
        message: `${where} has an unknown field name exceeding ${limits.maxStringLength} characters`,
      });
      ok = false;
      continue;
    }
    if (!allowed.has(key)) {
      errors.push({
        code: unknownCode,
        message: `${where} has unknown field ${JSON.stringify(key)}`,
      });
      ok = false;
    }
  }
  return ok;
}

type JsonCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Can `childCount` more nodes be enqueued without exceeding `limit`, given the
 *  already-visited and still-pending counts? Prevents a huge container from being
 *  expanded in one step before the running counter would catch it. */
function canEnqueue(
  childCount: number,
  nodesVisited: number,
  pendingCount: number,
  limit: number,
): boolean {
  return childCount <= limit - nodesVisited - pendingCount;
}

/** Iterative depth/node/string-bounded JSON validation (no recursion, no unbounded
 *  single-step allocation). Enforces the per-entry node bound and consumes from the
 *  shared whole-document node budget. Only plain objects, arrays, finite numbers,
 *  strings, booleans, and null are valid. String CONTENT is bounded but retained
 *  verbatim (rawLicense is source evidence, not a control-free schema field). */
function checkJsonValue(root: unknown, limits: SchemaLimits, budget: MetadataBudget): JsonCheck {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      break;
    }
    const { value, depth } = item;
    nodes++;
    budget.jsonNodes++;
    if (nodes > limits.maxJsonNodes) {
      return {
        ok: false,
        code: "METADATA_LIMIT_JSON_NODES_EXCEEDED",
        message: `rawLicense exceeds ${limits.maxJsonNodes} JSON nodes`,
      };
    }
    if (budget.jsonNodes > limits.maxTotalJsonNodes) {
      return {
        ok: false,
        code: "METADATA_LIMIT_TOTAL_JSON_NODES_EXCEEDED",
        message: `metadata rawLicense values exceed ${limits.maxTotalJsonNodes} total JSON nodes`,
      };
    }
    if (depth > limits.maxJsonDepth) {
      return {
        ok: false,
        code: "METADATA_LIMIT_JSON_DEPTH_EXCEEDED",
        message: `rawLicense exceeds JSON depth ${limits.maxJsonDepth}`,
      };
    }
    if (value === null || typeof value === "boolean") {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return {
          ok: false,
          code: "METADATA_ENTRY_MALFORMED",
          message: "rawLicense contains a non-finite number",
        };
      }
      continue;
    }
    if (typeof value === "string") {
      if (value.length > limits.maxStringLength) {
        return {
          ok: false,
          code: "METADATA_LIMIT_STRING_LENGTH_EXCEEDED",
          message: `rawLicense string exceeds ${limits.maxStringLength} characters`,
        };
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (!canEnqueue(value.length, nodes, stack.length, limits.maxJsonNodes)) {
        return {
          ok: false,
          code: "METADATA_LIMIT_JSON_NODES_EXCEEDED",
          message: `rawLicense exceeds ${limits.maxJsonNodes} JSON nodes`,
        };
      }
      if (!canEnqueue(value.length, budget.jsonNodes, stack.length, limits.maxTotalJsonNodes)) {
        return {
          ok: false,
          code: "METADATA_LIMIT_TOTAL_JSON_NODES_EXCEEDED",
          message: `metadata rawLicense values exceed ${limits.maxTotalJsonNodes} total JSON nodes`,
        };
      }
      for (const el of value) {
        stack.push({ value: el, depth: depth + 1 });
      }
      continue;
    }
    if (typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        return {
          ok: false,
          code: "METADATA_ENTRY_MALFORMED",
          message: "rawLicense contains a non-plain object",
        };
      }
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [key] of entries) {
        if (key.length > limits.maxStringLength) {
          return {
            ok: false,
            code: "METADATA_LIMIT_STRING_LENGTH_EXCEEDED",
            message: `rawLicense object key exceeds ${limits.maxStringLength} characters`,
          };
        }
      }
      if (!canEnqueue(entries.length, nodes, stack.length, limits.maxJsonNodes)) {
        return {
          ok: false,
          code: "METADATA_LIMIT_JSON_NODES_EXCEEDED",
          message: `rawLicense exceeds ${limits.maxJsonNodes} JSON nodes`,
        };
      }
      if (!canEnqueue(entries.length, budget.jsonNodes, stack.length, limits.maxTotalJsonNodes)) {
        return {
          ok: false,
          code: "METADATA_LIMIT_TOTAL_JSON_NODES_EXCEEDED",
          message: `metadata rawLicense values exceed ${limits.maxTotalJsonNodes} total JSON nodes`,
        };
      }
      for (const [, val] of entries) {
        stack.push({ value: val, depth: depth + 1 });
      }
      continue;
    }
    return {
      ok: false,
      code: "METADATA_ENTRY_MALFORMED",
      message: "rawLicense is not a JSON value",
    };
  }
  return { ok: true };
}

// -- SPDX identifier + normalization ----------------------------------------

/** A single canonical SPDX identifier shape: no whitespace, parentheses, `+`
 *  shorthand, or expression operators. Syntax only, not proof of registration. */
const SPDX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function isSingleSpdxId(value: string): boolean {
  if (!SPDX_ID_RE.test(value)) {
    return false;
  }
  const upper = value.toUpperCase();
  return upper !== "AND" && upper !== "OR" && upper !== "WITH";
}

/**
 * Return the raw license value only when it is a single canonical SPDX identifier;
 * otherwise null. Arrays, objects, empty/malformed strings, compound expressions
 * (which always contain whitespace or parentheses), deprecated `+` shorthand, and
 * the bare operators are all null. Never splits, rewrites, or canonicalizes.
 */
export function normalizeSpdx(raw: JsonValue): string | null {
  return typeof raw === "string" && isSingleSpdxId(raw) ? raw : null;
}

// -- policy schema ----------------------------------------------------------

const POLICY_FIELDS: ReadonlySet<string> = new Set(["schemaVersion", "dispositions"]);
const POLICY_ENTRY_FIELDS: ReadonlySet<string> = new Set(["disposition", "obligations"]);
const DISPOSITIONS: readonly Disposition[] = [
  "allowed",
  "allowed-with-obligations",
  "review-required",
  "disallowed",
];

/** A trimmed, control-free, non-empty obligation label. */
function isValidObligation(s: string): boolean {
  return s.length > 0 && s === s.trim() && !hasControlCharacter(s);
}

function parsePolicyEntry(
  spdxId: string,
  entry: unknown,
  limits: SchemaLimits,
  budget: PolicyBudget,
  errors: GenerationError[],
): PolicyEntry | null {
  if (!isObject(entry)) {
    errors.push({
      code: "POLICY_ENTRY_MALFORMED",
      message: `disposition entry ${spdxId} must be a plain object`,
      package: spdxId,
    });
    return null;
  }
  let ok = checkFields(
    entry,
    POLICY_ENTRY_FIELDS,
    "POLICY_ENTRY_UNKNOWN_FIELD",
    `disposition entry ${spdxId}`,
    limits,
    errors,
  );
  const disposition = readProp(entry, "disposition");
  if (
    typeof disposition !== "string" ||
    !(DISPOSITIONS as readonly string[]).includes(disposition)
  ) {
    errors.push({
      code: "POLICY_INVALID_DISPOSITION",
      message: `disposition entry ${spdxId} has an invalid disposition`,
      package: spdxId,
    });
    ok = false;
  }
  const rawObligations = readProp(entry, "obligations");
  const obligations: string[] = [];
  if (!Array.isArray(rawObligations)) {
    errors.push({
      code: "POLICY_INVALID_OBLIGATION",
      message: `disposition entry ${spdxId} obligations must be an array`,
      package: spdxId,
    });
    ok = false;
  } else if (rawObligations.length > limits.maxObligationsPerPolicyEntry) {
    errors.push({
      code: "POLICY_LIMIT_OBLIGATIONS_EXCEEDED",
      message: `disposition entry ${spdxId} has ${rawObligations.length} obligations (limit ${limits.maxObligationsPerPolicyEntry})`,
      package: spdxId,
    });
    ok = false;
  } else {
    budget.obligations += rawObligations.length;
    if (budget.obligations > limits.maxTotalPolicyObligations) {
      errors.push({
        code: "POLICY_LIMIT_TOTAL_OBLIGATIONS_EXCEEDED",
        message: `policy exceeds ${limits.maxTotalPolicyObligations} total obligations`,
      });
      ok = false;
    }
    const seen = new Set<string>();
    for (const o of rawObligations) {
      if (typeof o !== "string" || o.length > limits.maxStringLength || !isValidObligation(o)) {
        errors.push({
          code: "POLICY_INVALID_OBLIGATION",
          message: `disposition entry ${spdxId} has an invalid or oversized obligation`,
          package: spdxId,
        });
        ok = false;
        continue;
      }
      if (seen.has(o)) {
        errors.push({
          code: "POLICY_INVALID_OBLIGATION",
          message: `disposition entry ${spdxId} has a duplicate obligation ${JSON.stringify(o)}`,
          package: spdxId,
        });
        ok = false;
        continue;
      }
      seen.add(o);
      obligations.push(o);
    }
  }
  if (!ok) {
    return null;
  }
  return { disposition: disposition as Disposition, obligations: [...obligations].sort(cmp) };
}

export function parsePolicy(raw: unknown, limits?: Partial<SchemaLimits>): PolicyParseResult {
  const lim: SchemaLimits = { ...DEFAULT_SCHEMA_LIMITS, ...(limits ?? {}) };
  const limitErrors = checkSchemaLimits(lim);
  if (limitErrors.length > 0) {
    return fail(limitErrors);
  }
  if (!isObject(raw)) {
    return fail([{ code: "POLICY_MALFORMED", message: "policy must be a plain JSON object" }]);
  }
  const errors: GenerationError[] = [];
  checkFields(raw, POLICY_FIELDS, "POLICY_UNKNOWN_FIELD", "policy", lim, errors);
  if (readProp(raw, "schemaVersion") !== 1) {
    errors.push({
      code: "POLICY_UNSUPPORTED_SCHEMA_VERSION",
      message: "policy schemaVersion must be 1",
    });
  }
  const dispositions = new Map<string, PolicyEntry>();
  const budget: PolicyBudget = { obligations: 0 };
  const rawDispositions = readProp(raw, "dispositions");
  if (!isObject(rawDispositions)) {
    errors.push({
      code: "POLICY_MALFORMED",
      message: "policy dispositions must be a plain object",
    });
  } else if (Object.keys(rawDispositions).length > lim.maxPolicyEntries) {
    errors.push({
      code: "POLICY_LIMIT_ENTRIES_EXCEEDED",
      message: `policy has ${Object.keys(rawDispositions).length} entries (limit ${lim.maxPolicyEntries})`,
    });
  } else {
    for (const [spdxId, entry] of Object.entries(rawDispositions).sort(([a], [b]) => cmp(a, b))) {
      if (spdxId.length > lim.maxStringLength) {
        errors.push({
          code: "POLICY_INVALID_SPDX_ID",
          message: `a policy disposition key exceeds ${lim.maxStringLength} characters`,
        });
        continue;
      }
      if (!isSingleSpdxId(spdxId)) {
        errors.push({
          code: "POLICY_INVALID_SPDX_ID",
          message: `invalid SPDX identifier key ${JSON.stringify(spdxId)}`,
          package: spdxId,
        });
        continue;
      }
      const parsed = parsePolicyEntry(spdxId, entry, lim, budget, errors);
      if (parsed !== null) {
        dispositions.set(spdxId, parsed);
      }
    }
  }
  if (errors.length > 0) {
    return fail(errors);
  }
  return { ok: true, policy: { schemaVersion: 1, dispositions } };
}

// -- metadata cache schema --------------------------------------------------

const METADATA_FIELDS: ReadonlySet<string> = new Set(["schemaVersion", "entries"]);
const CACHE_COLLECTED_FIELDS: ReadonlySet<string> = new Set([
  "collectionStatus",
  "name",
  "version",
  "integrity",
  "collectionReason",
  "retrievalSource",
  "tarballIntegrity",
  "rawLicensePresent",
  "rawLicense",
  "normalizedSpdx",
  "licenseMetadataSource",
  "packagedLegalFiles",
]);
const CACHE_FAILED_REGISTRY_FIELDS: ReadonlySet<string> = new Set([
  "collectionStatus",
  "name",
  "version",
  "integrity",
  "collectionReason",
  "retrievalSource",
  "tarballIntegrity",
]);
const CACHE_FAILED_UNSUPPORTED_FIELDS: ReadonlySet<string> = new Set([
  "collectionStatus",
  "packageKey",
  "collectionReason",
  "retrievalSource",
]);

function isRetrievalSource(v: unknown): v is "pnpm-store" | "registry-tarball" {
  return v === "pnpm-store" || v === "registry-tarball";
}

/** A package-relative POSIX path: not absolute/drive-prefixed, no backslash,
 *  control (incl. DEL), or leading/trailing whitespace, and no empty/`.`/`..` segment. */
function isValidLegalFilePath(f: string): boolean {
  if (
    f.length === 0 ||
    f !== f.trim() ||
    f.includes("\\") ||
    f.startsWith("/") ||
    /^[A-Za-z]:/.test(f) ||
    hasControlCharacter(f)
  ) {
    return false;
  }
  for (const seg of f.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      return false;
    }
  }
  return true;
}

function validateLegalFiles(
  raw: unknown,
  where: string,
  limits: SchemaLimits,
  budget: MetadataBudget,
  errors: GenerationError[],
): string[] | null {
  if (!Array.isArray(raw)) {
    errors.push({
      code: "METADATA_ENTRY_MALFORMED",
      message: `${where}: packagedLegalFiles must be an array`,
    });
    return null;
  }
  if (raw.length > limits.maxLegalFilesPerEntry) {
    errors.push({
      code: "METADATA_LIMIT_LEGAL_FILES_EXCEEDED",
      message: `${where}: packagedLegalFiles has ${raw.length} entries (limit ${limits.maxLegalFilesPerEntry})`,
    });
    return null;
  }
  budget.legalFiles += raw.length;
  if (budget.legalFiles > limits.maxTotalLegalFiles) {
    errors.push({
      code: "METADATA_LIMIT_TOTAL_LEGAL_FILES_EXCEEDED",
      message: `metadata exceeds ${limits.maxTotalLegalFiles} total legal files`,
    });
    return null;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let ok = true;
  for (const f of raw) {
    if (typeof f !== "string" || f.length > limits.maxStringLength || !isValidLegalFilePath(f)) {
      errors.push({
        code: "METADATA_ENTRY_MALFORMED",
        message: `${where}: a packagedLegalFiles entry is not a valid, length-bounded package-relative path`,
      });
      ok = false;
      continue;
    }
    if (seen.has(f)) {
      errors.push({
        code: "METADATA_ENTRY_MALFORMED",
        message: `${where}: packagedLegalFiles has a duplicate entry ${JSON.stringify(f)}`,
      });
      ok = false;
      continue;
    }
    seen.add(f);
    out.push(f);
  }
  return ok ? [...out].sort(cmp) : null;
}

function parseCollected(
  entry: Record<string, unknown>,
  where: string,
  limits: SchemaLimits,
  budget: MetadataBudget,
  errors: GenerationError[],
): CollectedRegistryMetadata | null {
  let ok = checkFields(
    entry,
    CACHE_COLLECTED_FIELDS,
    "METADATA_ENTRY_UNKNOWN_FIELD",
    where,
    limits,
    errors,
  );
  const bad = (msg: string): void => {
    errors.push({ code: "METADATA_ENTRY_MALFORMED", message: `${where}: ${msg}` });
    ok = false;
  };
  const name = readProp(entry, "name");
  const version = readProp(entry, "version");
  const integrity = readProp(entry, "integrity");
  const collectionReason = readProp(entry, "collectionReason");
  const retrievalSource = readProp(entry, "retrievalSource");
  const tarballIntegrity = readProp(entry, "tarballIntegrity");
  const rawLicensePresent = readProp(entry, "rawLicensePresent");
  const rawLicense = readProp(entry, "rawLicense");
  const normalizedSpdx = readProp(entry, "normalizedSpdx");
  const licenseMetadataSource = readProp(entry, "licenseMetadataSource");
  const legalFiles = validateLegalFiles(
    readProp(entry, "packagedLegalFiles"),
    where,
    limits,
    budget,
    errors,
  );
  if (legalFiles === null) {
    ok = false;
  }

  if (!isBoundedNonEmptyString(name, limits)) {
    bad("name must be a bounded, control-free non-empty string");
  }
  if (!isBoundedNonEmptyString(version, limits)) {
    bad("version must be a bounded, control-free non-empty string");
  }
  if (!isBoundedNonEmptyString(integrity, limits)) {
    bad("integrity must be a bounded, control-free non-empty string");
  }
  if (collectionReason !== null) {
    bad("collectionReason must be null for a collected entry");
  }
  if (!isRetrievalSource(retrievalSource)) {
    bad("retrievalSource must be pnpm-store or registry-tarball");
  }
  if (!isBoundedNonEmptyString(tarballIntegrity, limits)) {
    bad("tarballIntegrity must be a bounded, control-free non-empty string");
  }
  if (
    isBoundedNonEmptyString(integrity, limits) &&
    isBoundedNonEmptyString(tarballIntegrity, limits) &&
    tarballIntegrity !== integrity
  ) {
    bad("tarballIntegrity must equal integrity for a collected (verified) entry");
  }
  if (typeof rawLicensePresent !== "boolean") {
    bad("rawLicensePresent must be a boolean");
  }
  if (rawLicensePresent === false && rawLicense !== null) {
    bad("rawLicense must be null when rawLicensePresent is false");
  }
  if (!(normalizedSpdx === null || isBoundedNonEmptyString(normalizedSpdx, limits))) {
    bad("normalizedSpdx must be a bounded, control-free non-empty string or null");
  }
  const jsonCheck = checkJsonValue(rawLicense, limits, budget);
  if (!jsonCheck.ok) {
    errors.push({ code: jsonCheck.code, message: `${where}: ${jsonCheck.message}` });
    ok = false;
  } else {
    const expectedSpdx = normalizeSpdx(rawLicense as JsonValue);
    if (normalizedSpdx !== expectedSpdx) {
      bad(
        `normalizedSpdx must equal normalizeSpdx(rawLicense): expected ${JSON.stringify(expectedSpdx)}`,
      );
    }
  }
  if (licenseMetadataSource !== "packaged-package-json") {
    bad("licenseMetadataSource must be packaged-package-json");
  }

  if (!ok || legalFiles === null) {
    return null;
  }
  return {
    collectionStatus: "collected",
    name: name as string,
    version: version as string,
    integrity: integrity as string,
    collectionReason: null,
    retrievalSource: retrievalSource as "pnpm-store" | "registry-tarball",
    tarballIntegrity: tarballIntegrity as string,
    rawLicensePresent: rawLicensePresent as boolean,
    rawLicense: rawLicense as JsonValue,
    normalizedSpdx: normalizedSpdx as string | null,
    licenseMetadataSource: "packaged-package-json",
    packagedLegalFiles: legalFiles,
  };
}

function parseFailedRegistry(
  entry: Record<string, unknown>,
  where: string,
  limits: SchemaLimits,
  errors: GenerationError[],
): FailedRegistryMetadata | null {
  let ok = checkFields(
    entry,
    CACHE_FAILED_REGISTRY_FIELDS,
    "METADATA_ENTRY_UNKNOWN_FIELD",
    where,
    limits,
    errors,
  );
  const bad = (msg: string): void => {
    errors.push({ code: "METADATA_ENTRY_MALFORMED", message: `${where}: ${msg}` });
    ok = false;
  };
  const name = readProp(entry, "name");
  const version = readProp(entry, "version");
  const integrity = readProp(entry, "integrity");
  const collectionReason = readProp(entry, "collectionReason");
  const retrievalSource = readProp(entry, "retrievalSource");
  const tarballIntegrity = readProp(entry, "tarballIntegrity");
  if (!isBoundedNonEmptyString(name, limits)) {
    bad("name must be a bounded, control-free non-empty string");
  }
  if (!isBoundedNonEmptyString(version, limits)) {
    bad("version must be a bounded, control-free non-empty string");
  }
  if (!(integrity === null || isBoundedNonEmptyString(integrity, limits))) {
    bad("integrity must be null or a bounded, control-free non-empty string");
  }
  if (!isBoundedNonEmptyString(collectionReason, limits)) {
    bad("collectionReason must be a bounded, control-free non-empty string");
  }
  if (!(retrievalSource === null || isRetrievalSource(retrievalSource))) {
    bad("retrievalSource must be pnpm-store, registry-tarball, or null");
  }
  if (!(tarballIntegrity === null || isBoundedNonEmptyString(tarballIntegrity, limits))) {
    bad("tarballIntegrity must be a bounded, control-free non-empty string or null");
  }
  if (!ok) {
    return null;
  }
  return {
    collectionStatus: "failed",
    name: name as string,
    version: version as string,
    integrity: integrity as string | null,
    collectionReason: collectionReason as string,
    retrievalSource: retrievalSource as "pnpm-store" | "registry-tarball" | null,
    tarballIntegrity: tarballIntegrity as string | null,
  };
}

function parseFailedUnsupported(
  entry: Record<string, unknown>,
  where: string,
  limits: SchemaLimits,
  errors: GenerationError[],
): FailedUnsupportedMetadata | null {
  let ok = checkFields(
    entry,
    CACHE_FAILED_UNSUPPORTED_FIELDS,
    "METADATA_ENTRY_UNKNOWN_FIELD",
    where,
    limits,
    errors,
  );
  const bad = (msg: string): void => {
    errors.push({ code: "METADATA_ENTRY_MALFORMED", message: `${where}: ${msg}` });
    ok = false;
  };
  const packageKey = readProp(entry, "packageKey");
  const collectionReason = readProp(entry, "collectionReason");
  const retrievalSource = readProp(entry, "retrievalSource");
  if (!isBoundedNonEmptyString(packageKey, limits)) {
    bad("packageKey must be a bounded, control-free non-empty string");
  }
  if (!isBoundedNonEmptyString(collectionReason, limits)) {
    bad("collectionReason must be a bounded, control-free non-empty string");
  }
  if (retrievalSource !== null) {
    bad("retrievalSource must be null for an unsupported entry");
  }
  if (!ok) {
    return null;
  }
  return {
    collectionStatus: "failed",
    packageKey: packageKey as string,
    collectionReason: collectionReason as string,
    retrievalSource: null,
  };
}

function parseMetadataEntry(
  entry: unknown,
  index: number,
  limits: SchemaLimits,
  budget: MetadataBudget,
  errors: GenerationError[],
): MetadataEntry | null {
  const where = `entries[${index}]`;
  if (!isObject(entry)) {
    errors.push({ code: "METADATA_ENTRY_MALFORMED", message: `${where} must be a plain object` });
    return null;
  }
  const status = readProp(entry, "collectionStatus");
  if (status === "collected") {
    return parseCollected(entry, where, limits, budget, errors);
  }
  if (status === "failed") {
    return "packageKey" in entry
      ? parseFailedUnsupported(entry, where, limits, errors)
      : parseFailedRegistry(entry, where, limits, errors);
  }
  errors.push({
    code: "METADATA_ENTRY_MALFORMED",
    message: `${where} has an invalid collectionStatus`,
  });
  return null;
}

export function parseMetadataCache(
  raw: unknown,
  limits?: Partial<SchemaLimits>,
): MetadataParseResult {
  const lim: SchemaLimits = { ...DEFAULT_SCHEMA_LIMITS, ...(limits ?? {}) };
  const limitErrors = checkSchemaLimits(lim);
  if (limitErrors.length > 0) {
    return fail(limitErrors);
  }
  if (!isObject(raw)) {
    return fail([
      { code: "METADATA_MALFORMED", message: "metadata cache must be a plain JSON object" },
    ]);
  }
  const errors: GenerationError[] = [];
  checkFields(raw, METADATA_FIELDS, "METADATA_UNKNOWN_FIELD", "metadata cache", lim, errors);
  if (readProp(raw, "schemaVersion") !== 1) {
    errors.push({
      code: "METADATA_UNSUPPORTED_SCHEMA_VERSION",
      message: "metadata schemaVersion must be 1",
    });
  }
  const entries: MetadataEntry[] = [];
  const budget: MetadataBudget = { jsonNodes: 0, legalFiles: 0 };
  const rawEntries = readProp(raw, "entries");
  if (!Array.isArray(rawEntries)) {
    errors.push({ code: "METADATA_MALFORMED", message: "metadata entries must be an array" });
  } else if (rawEntries.length > lim.maxMetadataEntries) {
    errors.push({
      code: "METADATA_LIMIT_ENTRIES_EXCEEDED",
      message: `metadata has ${rawEntries.length} entries (limit ${lim.maxMetadataEntries})`,
    });
  } else {
    for (let i = 0; i < rawEntries.length; i++) {
      const parsed = parseMetadataEntry(rawEntries[i], i, lim, budget, errors);
      if (parsed !== null) {
        entries.push(parsed);
      }
    }
  }
  if (errors.length > 0) {
    return fail(errors);
  }
  return { ok: true, cache: { schemaVersion: 1, entries } };
}
