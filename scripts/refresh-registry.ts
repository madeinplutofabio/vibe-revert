// scripts/refresh-registry.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Network layer for the M H5 license-metadata refresh (see
// docs/adr/0001-deterministic-license-audit.md). It fetches, from a configured
// registry, the version metadata (dist.tarball location + optional dist.integrity)
// and the tarball bytes. The committed lockfile integrity is the trust anchor; this
// module chooses only WHERE to fetch and never trusts the transferred content.
//
// Hardening (mechanism = node:https for the necessary control):
//   - validateNetworkPolicy() checks the whole policy once and SNAPSHOTS it into an
//     immutable value (copied scalars, canonical registry string, frozen allowlist
//     arrays), so post-validation mutation of the caller's objects cannot change
//     behavior;
//   - https only; embedded URL credentials refused;
//   - an IP-literal host is classified BEFORE the request (Node bypasses the lookup
//     hook for literals), and the DNS lookup hook validates every resolved address
//     (single result, or an array under autoSelectFamily) and rejects any that is
//     not globally reachable — an SSRF rejection is non-retryable;
//   - authority allowlist compares canonical (hostname, effective-port) pairs;
//   - only 301/302/303/307/308 are redirects, each target re-validated;
//   - per-socket idle timeout AND an overall MONOTONIC per-operation deadline (both
//     bounded to the timer range; idle ≤ deadline); bounded hops;
//   - strict Content-Length parse (fail-closed) + authoritative streamed byte cap +
//     length-mismatch detection; truncated bodies (aborted/early close) are caught;
//   - transfer Content-Encoding must be identity/absent (case-insensitive; multiple
//     encodings rejected);
//   - version metadata: bounded bytes, strict UTF-8, strict duplicate-key/limit
//     JSON, MIME-essence content-type, required object with bounded dist.tarball
//     (+ optional bounded dist.integrity); scoped names percent-encoded;
//   - distinct Accept headers; error text truncated; request setup guarded so
//     requestOnce never rejects outside its result union;
//   - failures classified retryable (transient transport / 408 / 429 / 5xx).

import { lookup as dnsLookup } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";

import type { JsonValue } from "./license-audit-core.js";
import {
  authorityKey,
  authorityOfUrl,
  classifyUrlHost,
  isGloballyReachable,
  parseAuthority,
} from "./refresh-net.js";
import { parseStrictJson, type StrictJsonLimits } from "./strict-json.js";

const USER_AGENT = "viberevert-license-refresh";
const MAX_URL_LENGTH = 8192;
const MAX_INTEGRITY_LENGTH = 16_384;
const MAX_TIMER_MS = 2_147_483_647;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
// Defensive URL-safety guards on identity strings (already validated upstream by
// the lockfile adapter; re-checked so this module cannot emit an injected URL).
const SAFE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const SAFE_VERSION = /^[a-z0-9][a-z0-9._+-]*$/i;

export interface NetworkPolicy {
  readonly registryUrl: string;
  readonly extraTarballHosts: readonly string[];
  readonly allowPrivateAddresses: boolean;
  readonly maxRedirects: number;
  readonly requestTimeoutMs: number;
  readonly overallDeadlineMs: number;
  readonly maxMetadataBytes: number;
  readonly maxTarballBytes: number;
  readonly jsonLimits?: Partial<StrictJsonLimits>;
}

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  registryUrl: "https://registry.npmjs.org",
  extraTarballHosts: [],
  allowPrivateAddresses: false,
  maxRedirects: 5,
  requestTimeoutMs: 30_000,
  overallDeadlineMs: 120_000,
  maxMetadataBytes: 16 * 1024 * 1024,
  maxTarballBytes: 64 * 1024 * 1024,
};

// Immutable snapshot produced by validateNetworkPolicy; the fetch functions consume
// only this, never the caller's mutable policy/URL/set objects.
export interface ValidatedPolicy {
  readonly registryUrl: string;
  readonly allowPrivateAddresses: boolean;
  readonly maxRedirects: number;
  readonly requestTimeoutMs: number;
  readonly overallDeadlineMs: number;
  readonly maxMetadataBytes: number;
  readonly maxTarballBytes: number;
  readonly jsonLimits?: Readonly<Partial<StrictJsonLimits>>;
  readonly metadataAllowKeys: readonly string[];
  readonly tarballAllowKeys: readonly string[];
}

export interface FetchFailure {
  readonly ok: false;
  readonly reason: string;
  readonly retryable: boolean;
}

export type VersionMetadataResult =
  | {
      readonly ok: true;
      readonly tarballUrl: string;
      readonly distIntegrity: string | null;
      readonly receivedBytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly retryable: boolean;
      readonly receivedBytes: number;
    };

export type TarballFetchResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly receivedBytes: number }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly retryable: boolean;
      readonly receivedBytes: number;
    };

// -- helpers ----------------------------------------------------------------

function truncate(s: string): string {
  return s.length <= 200 ? s : `${s.slice(0, 200)}… (${s.length} chars)`;
}

function errText(err: unknown): string {
  return err instanceof Error ? truncate(err.message) : truncate(String(err));
}

function isJsonObject(v: JsonValue): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readProp(obj: Record<string, JsonValue>, key: string): JsonValue | undefined {
  return obj[key];
}

function isJsonContentType(ct: string): boolean {
  const essence = (ct.split(";")[0] ?? "").trim().toLowerCase();
  return essence === "application/json" || /^application\/[a-z0-9!#$&^_.+-]*\+json$/.test(essence);
}

function validateNameVersion(name: string, version: string): { ok: true } | FetchFailure {
  if (typeof name !== "string" || name.length === 0 || name.length > 214 || !SAFE_NAME.test(name)) {
    return { ok: false, reason: "invalid package name for a registry request", retryable: false };
  }
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > 256 ||
    !SAFE_VERSION.test(version)
  ) {
    return {
      ok: false,
      reason: "invalid package version for a registry request",
      retryable: false,
    };
  }
  return { ok: true };
}

function buildVersionMetadataUrl(registryUrl: string, name: string, version: string): string {
  const registry = new URL(registryUrl); // fresh URL from the validated string
  const base = registry.pathname.replace(/\/+$/, "");
  const rel = `${base}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  return new URL(rel, registry).toString();
}

// -- policy validation ------------------------------------------------------

export function validateNetworkPolicy(
  policy: NetworkPolicy,
): { ok: true; validated: ValidatedPolicy } | { ok: false; reason: string } {
  let registry: URL;
  try {
    registry = new URL(policy.registryUrl);
  } catch {
    return { ok: false, reason: "registryUrl is not a valid URL" };
  }
  if (registry.protocol !== "https:") {
    return { ok: false, reason: "registryUrl must use https" };
  }
  if (registry.username !== "" || registry.password !== "") {
    return { ok: false, reason: "registryUrl must not contain credentials" };
  }
  if (registry.search !== "" || registry.hash !== "") {
    return { ok: false, reason: "registryUrl must not contain a query or fragment" };
  }
  const regAuthority = authorityOfUrl(registry);
  if (regAuthority === null) {
    return { ok: false, reason: "registryUrl has an invalid authority" };
  }
  if (typeof policy.allowPrivateAddresses !== "boolean") {
    return { ok: false, reason: "allowPrivateAddresses must be a boolean" };
  }
  if (!Number.isSafeInteger(policy.maxRedirects) || policy.maxRedirects < 0) {
    return { ok: false, reason: "maxRedirects must be a non-negative safe integer" };
  }
  for (const [name, value] of [
    ["requestTimeoutMs", policy.requestTimeoutMs],
    ["overallDeadlineMs", policy.overallDeadlineMs],
    ["maxMetadataBytes", policy.maxMetadataBytes],
    ["maxTarballBytes", policy.maxTarballBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return { ok: false, reason: `${name} must be a positive safe integer` };
    }
  }
  if (policy.requestTimeoutMs > MAX_TIMER_MS) {
    return { ok: false, reason: `requestTimeoutMs must not exceed ${MAX_TIMER_MS}` };
  }
  if (policy.overallDeadlineMs > MAX_TIMER_MS) {
    return { ok: false, reason: `overallDeadlineMs must not exceed ${MAX_TIMER_MS}` };
  }
  if (policy.requestTimeoutMs > policy.overallDeadlineMs) {
    return { ok: false, reason: "requestTimeoutMs must not exceed overallDeadlineMs" };
  }
  if (!Array.isArray(policy.extraTarballHosts)) {
    return { ok: false, reason: "extraTarballHosts must be an array" };
  }
  const tarballAllow = new Set<string>([authorityKey(regAuthority)]);
  for (const h of policy.extraTarballHosts) {
    if (typeof h !== "string") {
      return { ok: false, reason: "extraTarballHosts entries must be strings" };
    }
    const a = parseAuthority(h);
    if (a === null) {
      return { ok: false, reason: `invalid extra tarball host: ${truncate(h)}` };
    }
    tarballAllow.add(authorityKey(a));
  }
  if (policy.jsonLimits !== undefined) {
    const probe = parseStrictJson("null", policy.jsonLimits);
    if (!probe.ok && probe.error.kind === "invalid-limit") {
      return { ok: false, reason: `invalid strict-JSON limits: ${truncate(probe.error.message)}` };
    }
  }

  const validated: ValidatedPolicy = {
    registryUrl: registry.toString(),
    allowPrivateAddresses: policy.allowPrivateAddresses,
    maxRedirects: policy.maxRedirects,
    requestTimeoutMs: policy.requestTimeoutMs,
    overallDeadlineMs: policy.overallDeadlineMs,
    maxMetadataBytes: policy.maxMetadataBytes,
    maxTarballBytes: policy.maxTarballBytes,
    ...(policy.jsonLimits === undefined
      ? {}
      : { jsonLimits: Object.freeze({ ...policy.jsonLimits }) }),
    metadataAllowKeys: Object.freeze([authorityKey(regAuthority)]),
    tarballAllowKeys: Object.freeze([...tarballAllow].sort()),
  };
  return { ok: true, validated };
}

// -- SSRF lookup hook -------------------------------------------------------

function ssrfError(hostname: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(
    `refusing to connect to a non-public address for ${truncate(hostname)}`,
  );
  e.code = "SSRF_BLOCKED";
  return e;
}

// The DNS lookup hook validates every resolved address (single result, or an array
// under autoSelectFamily's all:true) and passes the same shape through, so a
// non-global resolution is rejected before connection.
const safeLookup =
  (allowPrivate: boolean): LookupFunction =>
  (hostname, options, callback) => {
    dnsLookup(hostname, options, (err, address, family) => {
      if (err) {
        if (Array.isArray(address)) {
          callback(err, address);
        } else {
          callback(err, address, family);
        }
        return;
      }
      if (!allowPrivate) {
        const addresses = Array.isArray(address) ? address.map((item) => item.address) : [address];
        if (addresses.some((item) => !isGloballyReachable(item))) {
          const blocked = ssrfError(hostname);
          if (Array.isArray(address)) {
            callback(blocked, address);
          } else {
            callback(blocked, address, family);
          }
          return;
        }
      }
      if (Array.isArray(address)) {
        callback(null, address);
      } else {
        callback(null, address, family);
      }
    });
  };

// -- request/redirect engine ------------------------------------------------

function validateUrl(
  raw: string,
  allowedKeys: readonly string[],
  allowPrivate: boolean,
): { ok: true; url: URL } | FetchFailure {
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "URL exceeds the maximum length", retryable: false };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid URL", retryable: false };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: `refusing non-https URL (${truncate(url.protocol)})`,
      retryable: false,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "refusing URL with embedded credentials", retryable: false };
  }
  const authority = authorityOfUrl(url);
  if (authority === null) {
    return { ok: false, reason: "refusing URL with an invalid authority", retryable: false };
  }
  if (!allowedKeys.includes(authorityKey(authority))) {
    return {
      ok: false,
      reason: `${truncate(authority.hostname)}:${authority.port} is not in the allowlist`,
      retryable: false,
    };
  }
  // Node connects directly to an IP literal without calling the lookup hook, so a
  // non-global literal must be rejected here.
  if (!allowPrivate && classifyUrlHost(url.hostname) === "non-global") {
    return { ok: false, reason: "refusing a non-public IP address", retryable: false };
  }
  return { ok: true, url };
}

type OnceCore =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly headers: IncomingHttpHeaders;
      readonly body: Buffer;
    }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "error"; readonly reason: string; readonly retryable: boolean };

type OnceResult = OnceCore & { readonly receivedBytes: number };

function requestOnce(
  url: URL,
  validated: ValidatedPolicy,
  maxBytes: number,
  hardTimeoutMs: number,
  accept: string,
): Promise<OnceResult> {
  return new Promise<OnceResult>((resolve) => {
    let settled = false;
    let hard: ReturnType<typeof setTimeout> | null = null;
    let received = 0;
    const finish = (r: OnceCore): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (hard !== null) {
        clearTimeout(hard);
      }
      resolve({ ...r, receivedBytes: received });
    };

    try {
      const req = httpsRequest(
        url,
        {
          method: "GET",
          lookup: safeLookup(validated.allowPrivateAddresses),
          headers: { "accept-encoding": "identity", "user-agent": USER_AGENT, accept },
        },
        (res) => {
          res.on("error", (err: Error) =>
            finish({
              kind: "error",
              reason: `response body error: ${errText(err)}`,
              retryable: true,
            }),
          );
          const status = res.statusCode ?? 0;
          if (REDIRECT_STATUSES.has(status)) {
            const loc = res.headers.location;
            if (typeof loc !== "string" || loc.length === 0 || loc.length > MAX_URL_LENGTH) {
              finish({
                kind: "error",
                reason: "redirect without a valid Location",
                retryable: false,
              });
            } else {
              finish({ kind: "redirect", location: loc });
            }
            res.destroy();
            return;
          }
          const enc = res.headers["content-encoding"];
          if (enc !== undefined) {
            const normalized = String(enc).trim().toLowerCase();
            if (normalized !== "" && normalized !== "identity") {
              finish({
                kind: "error",
                reason: `unexpected content-encoding ${truncate(normalized)}`,
                retryable: false,
              });
              res.destroy();
              return;
            }
          }
          let declaredLength: number | null = null;
          const rawLength = res.headers["content-length"];
          if (rawLength !== undefined) {
            if (typeof rawLength !== "string" || !/^(0|[1-9]\d*)$/.test(rawLength)) {
              finish({ kind: "error", reason: "invalid content-length header", retryable: false });
              res.destroy();
              return;
            }
            const parsedLength = Number(rawLength);
            if (!Number.isSafeInteger(parsedLength)) {
              finish({ kind: "error", reason: "invalid content-length header", retryable: false });
              res.destroy();
              return;
            }
            if (parsedLength > maxBytes) {
              finish({
                kind: "error",
                reason: `response content-length exceeds ${maxBytes} bytes`,
                retryable: false,
              });
              res.destroy();
              return;
            }
            declaredLength = parsedLength;
          }

          const chunks: Buffer[] = [];
          let bodyEnded = false;
          res.on("data", (c: Buffer) => {
            if (settled) {
              return;
            }
            received += c.length;
            if (received > maxBytes) {
              finish({
                kind: "error",
                reason: `response exceeds ${maxBytes} bytes`,
                retryable: false,
              });
              res.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            bodyEnded = true;
            if (declaredLength !== null && received !== declaredLength) {
              finish({
                kind: "error",
                reason: "response body length does not match content-length",
                retryable: true,
              });
              return;
            }
            finish({
              kind: "response",
              status,
              headers: res.headers,
              body: Buffer.concat(chunks, received),
            });
          });
          res.on("aborted", () =>
            finish({ kind: "error", reason: "response body was aborted", retryable: true }),
          );
          res.on("close", () => {
            if (!bodyEnded) {
              finish({
                kind: "error",
                reason: "response body closed before completion",
                retryable: true,
              });
            }
          });
        },
      );

      req.on("error", (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code;
        finish({
          kind: "error",
          reason: `request error: ${errText(err)}`,
          retryable: code !== "SSRF_BLOCKED",
        });
      });
      req.setTimeout(validated.requestTimeoutMs, () =>
        req.destroy(new Error("socket idle timeout")),
      );
      hard = setTimeout(
        () => req.destroy(new Error("request deadline exceeded")),
        Math.max(1, hardTimeoutMs),
      );
      req.end();
    } catch (err) {
      finish({ kind: "error", reason: `request setup failed: ${errText(err)}`, retryable: false });
    }
  });
}

type RawFetch =
  | { ok: true; status: number; headers: IncomingHttpHeaders; body: Buffer; receivedBytes: number }
  | { ok: false; reason: string; retryable: boolean; receivedBytes: number };

// `receivedBytes` is response-body bytes delivered by Node (not TCP/TLS/header
// framing); `maxBytes` is a per-operation response-body cap spent down across the
// entire redirect chain.
async function fetchUrl(
  startUrl: string,
  validated: ValidatedPolicy,
  allowedKeys: readonly string[],
  maxBytes: number,
  accept: string,
): Promise<RawFetch> {
  const deadline = performance.now() + validated.overallDeadlineMs;
  let current = startUrl;
  let receivedTotal = 0;
  for (let hop = 0; hop <= validated.maxRedirects; hop++) {
    const v = validateUrl(current, allowedKeys, validated.allowPrivateAddresses);
    if (!v.ok) {
      return { ok: false, reason: v.reason, retryable: v.retryable, receivedBytes: receivedTotal };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return {
        ok: false,
        reason: "overall request deadline exceeded",
        retryable: true,
        receivedBytes: receivedTotal,
      };
    }
    const remainingBytes = maxBytes - receivedTotal;
    if (remainingBytes <= 0) {
      return {
        ok: false,
        reason: `response exceeds ${maxBytes} bytes across redirects`,
        retryable: false,
        receivedBytes: receivedTotal,
      };
    }
    const once = await requestOnce(v.url, validated, remainingBytes, remaining, accept);
    receivedTotal += once.receivedBytes;
    if (once.kind === "error") {
      return {
        ok: false,
        reason: once.reason,
        retryable: once.retryable,
        receivedBytes: receivedTotal,
      };
    }
    if (once.kind === "redirect") {
      let next: URL;
      try {
        next = new URL(once.location, v.url);
      } catch {
        return {
          ok: false,
          reason: "invalid redirect Location",
          retryable: false,
          receivedBytes: receivedTotal,
        };
      }
      current = next.toString();
      continue;
    }
    if (once.status >= 200 && once.status < 300) {
      return {
        ok: true,
        status: once.status,
        headers: once.headers,
        body: once.body,
        receivedBytes: receivedTotal,
      };
    }
    const retryable =
      once.status === 408 || once.status === 429 || (once.status >= 500 && once.status <= 599);
    return {
      ok: false,
      reason: `registry responded with HTTP ${once.status}`,
      retryable,
      receivedBytes: receivedTotal,
    };
  }
  return {
    ok: false,
    reason: `exceeded ${validated.maxRedirects} redirects`,
    retryable: false,
    receivedBytes: receivedTotal,
  };
}

// -- public API -------------------------------------------------------------

export async function fetchVersionMetadata(
  name: string,
  version: string,
  validated: ValidatedPolicy,
): Promise<VersionMetadataResult> {
  const guard = validateNameVersion(name, version);
  if (!guard.ok) {
    return { ok: false, reason: guard.reason, retryable: guard.retryable, receivedBytes: 0 };
  }
  const url = buildVersionMetadataUrl(validated.registryUrl, name, version);
  const res = await fetchUrl(
    url,
    validated,
    validated.metadataAllowKeys,
    validated.maxMetadataBytes,
    "application/json",
  );
  if (!res.ok) {
    return res;
  }
  const bytes = res.receivedBytes;
  const ct = res.headers["content-type"];
  if (typeof ct !== "string" || !isJsonContentType(ct)) {
    return {
      ok: false,
      reason: "registry metadata has a non-JSON content-type",
      retryable: false,
      receivedBytes: bytes,
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(res.body);
  } catch {
    return {
      ok: false,
      reason: "registry metadata is not valid UTF-8",
      retryable: false,
      receivedBytes: bytes,
    };
  }
  const parsed = parseStrictJson(text, validated.jsonLimits);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `registry metadata JSON error: ${truncate(parsed.error.message)}`,
      retryable: false,
      receivedBytes: bytes,
    };
  }
  const doc = parsed.value;
  if (!isJsonObject(doc)) {
    return {
      ok: false,
      reason: "registry metadata is not a JSON object",
      retryable: false,
      receivedBytes: bytes,
    };
  }
  const dist = readProp(doc, "dist");
  if (dist === undefined || !isJsonObject(dist)) {
    return {
      ok: false,
      reason: "registry metadata dist is not an object",
      retryable: false,
      receivedBytes: bytes,
    };
  }
  const tarball = readProp(dist, "tarball");
  if (typeof tarball !== "string" || tarball.length === 0 || tarball.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      reason: "registry metadata dist.tarball is not a bounded non-empty string",
      retryable: false,
      receivedBytes: bytes,
    };
  }
  const integ = readProp(dist, "integrity");
  let distIntegrity: string | null = null;
  if (integ !== undefined && integ !== null) {
    if (typeof integ !== "string" || integ.length === 0 || integ.length > MAX_INTEGRITY_LENGTH) {
      return {
        ok: false,
        reason: "registry metadata dist.integrity is not a bounded non-empty string",
        retryable: false,
        receivedBytes: bytes,
      };
    }
    distIntegrity = integ;
  }
  return { ok: true, tarballUrl: tarball, distIntegrity, receivedBytes: bytes };
}

export async function fetchTarball(
  tarballUrl: string,
  validated: ValidatedPolicy,
): Promise<TarballFetchResult> {
  const res = await fetchUrl(
    tarballUrl,
    validated,
    validated.tarballAllowKeys,
    validated.maxTarballBytes,
    "application/octet-stream, */*",
  );
  if (!res.ok) {
    return res;
  }
  return { ok: true, bytes: res.body, receivedBytes: res.receivedBytes };
}
