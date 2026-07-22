// scripts/refresh-license-metadata-core.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Pure orchestration mechanics for the M H5 license-metadata refresh (see
// docs/adr/0001-deterministic-license-audit.md and scripts/refresh-license-metadata.ts),
// extracted from the network executable so the deterministic scheduling logic is
// unit-testable in isolation. This module performs NO filesystem, network, console, or
// process access and runs nothing on import. It provides: the response-body Budget
// (validated reserve + multiset-tracked, overage-aware settle); the
// retry-within-a-reservation loop (fetchWithinBudget, with the attempt injected and the
// retry policy passed in, so no network or wall-clock is baked in); the cache-identity
// work-item builder (dedup by [name,version,integrity]; git/directory -> unsupported;
// retrieval-field disagreement -> conflict); the per-item reservation eligibility
// (reserveFor, mirroring collectRegistry's pre-network checks so a doomed item never
// reserves); the metadata-entry builders (unsupported / failed-registry / collected,
// the last verifying the packaged name/version against the lockfile identity); and the
// deterministic entry sort key. The executable owns fs, CLI, progress, the network
// collection glue, and main.

import type {
  CollectedRegistryMetadata,
  FailedRegistryMetadata,
  FailedUnsupportedMetadata,
  JsonValue,
  LockfilePackageIdentity,
  MetadataEntry,
} from "./license-audit-core.js";
import { normalizeSpdx } from "./license-schemas.js";
import type { ValidatedPolicy } from "./refresh-registry.js";
import { parseIntegrity } from "./refresh-sri.js";
import { parseStrictJson } from "./strict-json.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function validateReceivedBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid receivedBytes from budgeted fetch");
  }
}

function isJsonObject(v: JsonValue): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readMember(obj: Record<string, JsonValue>, key: string): JsonValue | undefined {
  return obj[key];
}

function ownStringProp(obj: Record<string, JsonValue>, key: string): string | null {
  if (!Object.hasOwn(obj, key)) {
    return null;
  }
  const v = readMember(obj, key);
  return typeof v === "string" ? v : null;
}

// -- retry within a response-body reservation -------------------------------

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly delayMs: number;
}

export async function fetchWithinBudget<T extends { ok: boolean; receivedBytes: number }>(
  attempt: (cap: number) => Promise<T>,
  isRetryable: (result: T) => boolean,
  grant: number,
  retry: RetryConfig,
): Promise<{ result: T; consumed: number }> {
  if (!Number.isSafeInteger(grant) || grant <= 0) {
    throw new Error("invalid fetch budget grant");
  }
  if (
    !Number.isSafeInteger(retry.maxAttempts) ||
    retry.maxAttempts <= 0 ||
    !Number.isSafeInteger(retry.delayMs) ||
    retry.delayMs < 0
  ) {
    throw new Error("invalid retry configuration");
  }

  let consumed = 0;
  let result = await attempt(grant);
  validateReceivedBytes(result.receivedBytes);
  consumed += result.receivedBytes;

  let attempts = 1;
  while (isRetryable(result) && attempts < retry.maxAttempts) {
    const cap = grant - consumed;
    if (cap <= 0) {
      break;
    }
    if (retry.delayMs > 0) {
      await sleep(retry.delayMs);
    }
    result = await attempt(cap);
    validateReceivedBytes(result.receivedBytes);
    consumed += result.receivedBytes;
    attempts += 1;
  }
  return { result, consumed };
}

// -- response-body budget ---------------------------------------------------

export class Budget {
  private spent = 0;
  private readonly outstanding = new Map<number, number>();
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("invalid response-body budget limit");
    }
  }
  reserve(want: number): number {
    if (!Number.isSafeInteger(want) || want < 0) {
      throw new Error("invalid response-body budget reservation");
    }
    if (want === 0) {
      return 0;
    }
    const remaining = this.limit - this.spent;
    if (remaining <= 0) {
      return 0;
    }
    const grant = Math.min(want, remaining);
    this.spent += grant;
    this.outstanding.set(grant, (this.outstanding.get(grant) ?? 0) + 1);
    return grant;
  }
  // Settle a reservation against actual usage: releases the unused portion, or charges
  // the overage when a final stream chunk crossed a per-request cap. Requires an exact
  // outstanding grant of `reserved` (rejects settlement without a matching reservation,
  // double/over-settlement, and zero-reservation settlement), so budget cannot be
  // accidentally created; a genuine overage (used > reserved) may leave spent above the
  // limit, after which no further reservation is granted.
  settle(reserved: number, used: number): void {
    if (
      !Number.isSafeInteger(reserved) ||
      reserved <= 0 ||
      !Number.isSafeInteger(used) ||
      used < 0
    ) {
      throw new Error("invalid response-body budget settlement");
    }
    const count = this.outstanding.get(reserved) ?? 0;
    if (count === 0) {
      throw new Error("response-body budget settlement has no matching reservation");
    }
    if (count === 1) {
      this.outstanding.delete(reserved);
    } else {
      this.outstanding.set(reserved, count - 1);
    }
    this.spent += used - reserved;
  }
}

// -- entry builders ---------------------------------------------------------

export function unsupportedEntry(
  id: LockfilePackageIdentity,
  reason: string,
): FailedUnsupportedMetadata {
  return {
    collectionStatus: "failed",
    packageKey: id.packageKey,
    collectionReason: reason,
    retrievalSource: null,
  };
}

export function failedRegistry(
  id: LockfilePackageIdentity,
  integrity: string | null,
  retrievalSource: "registry-tarball" | null,
  reason: string,
): FailedRegistryMetadata {
  return {
    collectionStatus: "failed",
    name: id.name,
    version: id.version,
    integrity,
    collectionReason: reason,
    retrievalSource,
    tarballIntegrity: null,
  };
}

export function buildCollected(
  id: LockfilePackageIdentity,
  integrity: string,
  packageJson: Buffer,
  legalFiles: readonly string[],
): { ok: true; entry: CollectedRegistryMetadata } | { ok: false; reason: string } {
  let text: string;
  try {
    text = UTF8_DECODER.decode(packageJson);
  } catch {
    return { ok: false, reason: "packaged package.json is not valid UTF-8" };
  }
  const parsed = parseStrictJson(text);
  if (!parsed.ok) {
    return { ok: false, reason: `packaged package.json JSON error: ${parsed.error.message}` };
  }
  const pkg = parsed.value;
  if (!isJsonObject(pkg)) {
    return { ok: false, reason: "packaged package.json is not a JSON object" };
  }
  // A verified tarball must present the identity it is being recorded under. Diagnostics
  // stay generic — the packaged name/version are untrusted and unbounded.
  if (ownStringProp(pkg, "name") !== id.name) {
    return { ok: false, reason: "packaged package.json name does not match the lockfile identity" };
  }
  if (ownStringProp(pkg, "version") !== id.version) {
    return {
      ok: false,
      reason: "packaged package.json version does not match the lockfile identity",
    };
  }
  const rawLicensePresent = Object.hasOwn(pkg, "license");
  const rawLicense: JsonValue = rawLicensePresent ? (readMember(pkg, "license") ?? null) : null;
  const normalizedSpdx = normalizeSpdx(rawLicense);
  return {
    ok: true,
    entry: {
      collectionStatus: "collected",
      name: id.name,
      version: id.version,
      integrity,
      collectionReason: null,
      retrievalSource: "registry-tarball",
      tarballIntegrity: integrity,
      rawLicensePresent,
      rawLicense,
      normalizedSpdx,
      licenseMetadataSource: "packaged-package-json",
      packagedLegalFiles: legalFiles,
    },
  };
}

// -- work items -------------------------------------------------------------

export type WorkItem =
  | { readonly kind: "unsupported"; readonly id: LockfilePackageIdentity }
  | { readonly kind: "registry"; readonly rep: LockfilePackageIdentity }
  | { readonly kind: "conflict"; readonly rep: LockfilePackageIdentity; readonly reason: string };

export function workItemKey(w: WorkItem): string {
  return w.kind === "unsupported" ? w.id.packageKey : w.rep.packageKey;
}

export function buildWorkItems(graph: {
  packages: ReadonlyMap<string, LockfilePackageIdentity>;
}): WorkItem[] {
  const unsupported: LockfilePackageIdentity[] = [];
  const registryGroups = new Map<string, LockfilePackageIdentity[]>();
  for (const id of graph.packages.values()) {
    if (id.sourceKind === "git" || id.sourceKind === "directory") {
      unsupported.push(id);
    } else {
      const rk = JSON.stringify([id.name, id.version, id.integrity]);
      const group = registryGroups.get(rk);
      if (group === undefined) {
        registryGroups.set(rk, [id]);
      } else {
        group.push(id);
      }
    }
  }
  const items: WorkItem[] = [];
  for (const id of unsupported) {
    items.push({ kind: "unsupported", id });
  }
  for (const group of registryGroups.values()) {
    const sorted = [...group].sort((a, b) => cmp(a.packageKey, b.packageKey));
    const rep = sorted[0] as LockfilePackageIdentity;
    const disagrees = sorted.some(
      (m) => m.sourceKind !== rep.sourceKind || m.tarballUrl !== rep.tarballUrl,
    );
    if (disagrees) {
      items.push({
        kind: "conflict",
        rep,
        reason:
          "equivalent registry identities disagree on a retrieval field (sourceKind or tarballUrl)",
      });
    } else {
      items.push({ kind: "registry", rep });
    }
  }
  items.sort((a, b) => cmp(workItemKey(a), workItemKey(b)));
  return items;
}

// -- reservation ------------------------------------------------------------

export interface Reservation {
  readonly metadataGrant: number;
  readonly tarballGrant: number;
}

// Reservation eligibility mirrors every deterministic pre-network check in
// collectRegistry, so an item that will fail before any download never reserves — and
// so never transiently denies a valid item in the same wave.
export function reserveFor(
  w: WorkItem,
  metadataBudget: Budget,
  tarballBudget: Budget,
  validated: ValidatedPolicy,
): Reservation {
  if (w.kind !== "registry") {
    return { metadataGrant: 0, tarballGrant: 0 };
  }
  const { rep } = w;
  if (rep.integrity === null || !parseIntegrity(rep.integrity).ok) {
    return { metadataGrant: 0, tarballGrant: 0 };
  }
  if (rep.sourceKind === "tarball-url" && rep.tarballUrl === null) {
    return { metadataGrant: 0, tarballGrant: 0 };
  }
  const metadataGrant =
    rep.sourceKind === "registry" ? metadataBudget.reserve(validated.maxMetadataBytes) : 0;
  const tarballGrant = tarballBudget.reserve(validated.maxTarballBytes);
  return { metadataGrant, tarballGrant };
}

// -- output ordering --------------------------------------------------------

export function entrySortKey(e: MetadataEntry): string {
  return "packageKey" in e
    ? JSON.stringify(["pkg", e.packageKey])
    : JSON.stringify(["id", e.name, e.version, e.integrity]);
}
