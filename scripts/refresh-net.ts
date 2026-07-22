// scripts/refresh-net.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Pure network-address utilities for the M H5 license-metadata refresh SSRF guard
// (see docs/adr/0001-deterministic-license-audit.md). Two concerns, both fixture-
// testable and free of I/O:
//
//   1. Reachability classification. IPv4/IPv6 literals are parsed to bytes and
//      classified by an ORDERED longest-prefix-match rule table (most-specific rule
//      wins). This is a deliberately CONSERVATIVE public-address policy, not an
//      exact IANA reachability oracle: it rejects non-global ranges AND some ranges
//      IANA marks globally reachable (e.g. AS112-v6, and the narrow global
//      exceptions inside otherwise-non-global blocks such as 2001:1::1/2/3,
//      192.0.0.9/10, ORCHIDv2). That yields false negatives (a real global address
//      may be rejected) but never a false accept of a non-global address — the only
//      direction that matters for SSRF. IPv4-mapped (::ffff:0:0/96) and well-known
//      NAT64 (64:ff9b::/96) addresses are reduced to their embedded IPv4 and judged
//      by the IPv4 rules, so alternate textual forms (::ffff:127.0.0.1 and
//      ::ffff:7f00:1) cannot bypass it; an IPv6 zone id is rejected outright.
//
//   2. Authority canonicalization. A registry/tarball authority is reduced to a
//      canonical (lowercase ASCII hostname without brackets or trailing dot,
//      explicit effective port) pair, rejecting empty hostnames and empty DNS
//      labels. Allowlisting compares exact pairs — no wildcard/suffix matching,
//      omitted https port normalized to 443 — so registry.example,
//      registry.example:443, and registry.example. do not differ, and an unexpected
//      port on an allowlisted host is not accepted.

import { isIP } from "node:net";

// -- IP literal parsing -----------------------------------------------------

function parseIPv4(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (p === undefined || !/^\d{1,3}$/.test(p) || (p.length > 1 && p.startsWith("0"))) {
      return null; // empty, non-numeric, or leading-zero (octal-ambiguous) octet
    }
    const n = Number(p);
    if (n > 255) {
      return null;
    }
    bytes[i] = n;
  }
  return bytes;
}

function parseIPv6(input: string): Uint8Array | null {
  if (input.length === 0 || input.includes("%")) {
    return null;
  }
  let text = input;
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1) {
      return null;
    }
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === null) {
      return null;
    }
    // Rewrite the trailing dotted IPv4 as two hex groups, keeping the prefix up to
    // AND INCLUDING the last colon so a "::" immediately before the tail (e.g.
    // 64:ff9b::1.2.3.4) is preserved rather than broken by the slice.
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dc = text.indexOf("::");
  let headStr: string;
  let tailStr: string;
  if (dc === -1) {
    headStr = text;
    tailStr = "";
  } else {
    if (text.indexOf("::", dc + 1) !== -1) {
      return null; // more than one "::"
    }
    headStr = text.slice(0, dc);
    tailStr = text.slice(dc + 2);
  }

  const toGroups = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
        return null;
      }
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(headStr);
  const tail = toGroups(tailStr);
  if (head === null || tail === null) {
    return null;
  }
  const total = head.length + tail.length;
  if (dc === -1) {
    if (total !== 8) {
      return null;
    }
  } else if (total > 7) {
    return null; // "::" must stand for at least one zero group
  }

  const groups: number[] = [...head];
  if (dc !== -1) {
    for (let i = 0; i < 8 - total; i++) {
      groups.push(0);
    }
  }
  groups.push(...tail);
  if (groups.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? 0;
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

// -- CIDR classification ----------------------------------------------------

interface Cidr {
  readonly prefix: Uint8Array;
  readonly len: number;
}

function parseCidr(spec: string): Cidr {
  const parts = spec.split("/");
  if (parts.length !== 2) {
    throw new Error(`invalid CIDR literal: ${spec}`);
  }
  const ip = parts[0];
  const rawLength = parts[1];
  if (ip === undefined || rawLength === undefined || !/^(0|[1-9]\d*)$/.test(rawLength)) {
    throw new Error(`invalid CIDR literal: ${spec}`);
  }
  const prefix = parseIPv4(ip) ?? parseIPv6(ip);
  if (prefix === null) {
    throw new Error(`invalid CIDR literal: ${spec}`);
  }
  const len = Number(rawLength);
  const maxBits = prefix.length * 8;
  if (!Number.isSafeInteger(len) || len < 0 || len > maxBits) {
    throw new Error(`invalid CIDR prefix length: ${spec}`);
  }
  for (let bit = len; bit < maxBits; bit++) {
    const byteIdx = Math.floor(bit / 8);
    const bitInByte = 7 - (bit % 8);
    if ((((prefix[byteIdx] ?? 0) >> bitInByte) & 1) !== 0) {
      throw new Error(`non-canonical CIDR (host bits set): ${spec}`);
    }
  }
  return { prefix, len };
}

function matchCidr(addr: Uint8Array, cidr: Cidr): boolean {
  if (addr.length !== cidr.prefix.length) {
    return false;
  }
  const fullBytes = Math.floor(cidr.len / 8);
  for (let i = 0; i < fullBytes; i++) {
    if ((addr[i] ?? 0) !== (cidr.prefix[i] ?? 0)) {
      return false;
    }
  }
  const rem = cidr.len % 8;
  if (rem > 0) {
    const mask = (0xff << (8 - rem)) & 0xff;
    if (((addr[fullBytes] ?? 0) & mask) !== ((cidr.prefix[fullBytes] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
}

interface ReachabilityRule {
  readonly cidr: Cidr;
  readonly globallyReachable: boolean;
}

function rule(spec: string, globallyReachable: boolean): ReachabilityRule {
  return { cidr: parseCidr(spec), globallyReachable };
}

// IPv4: default global, minus the IANA special-purpose non-global ranges (their
// narrow global /32 exceptions are conservatively denied with the enclosing block).
const IPV4_RULES: readonly ReachabilityRule[] = [
  rule("0.0.0.0/0", true),
  rule("0.0.0.0/8", false),
  rule("10.0.0.0/8", false),
  rule("100.64.0.0/10", false),
  rule("127.0.0.0/8", false),
  rule("169.254.0.0/16", false),
  rule("172.16.0.0/12", false),
  rule("192.0.0.0/24", false),
  rule("192.0.2.0/24", false),
  rule("192.88.99.0/24", false),
  rule("192.168.0.0/16", false),
  rule("198.18.0.0/15", false),
  rule("198.51.100.0/24", false),
  rule("203.0.113.0/24", false),
  rule("224.0.0.0/4", false),
  rule("240.0.0.0/4", false),
];

// IPv6: default DENY; 2000::/3 global unicast is allowed, minus non-global
// sub-blocks AND selected special-purpose ranges that IANA marks globally reachable
// but which are denied here conservatively (2620:4f:8000::/48 AS112-v6). Everything
// outside 2000::/3 (::, ::1, fc00::/7, fe80::/10, ff00::/8, 100::/64, 5f00::/16,
// 64:ff9b:1::/48, …) is rejected by the ::/0 default.
const IPV6_RULES: readonly ReachabilityRule[] = [
  rule("::/0", false),
  rule("2000::/3", true),
  rule("2001::/23", false), // IETF protocol block (Teredo, benchmarking, ORCHID/ORCHIDv2 within)
  rule("2001:db8::/32", false), // documentation (outside 2001::/23)
  rule("2002::/16", false), // 6to4
  rule("3fff::/20", false), // documentation
  rule("2620:4f:8000::/48", false), // AS112-v6 direct delegation (globally reachable; denied conservatively)
];

const IPV6_MAPPED_V4 = parseCidr("::ffff:0:0/96");
const IPV6_NAT64 = parseCidr("64:ff9b::/96");

function classifyReachability(bytes: Uint8Array, rules: readonly ReachabilityRule[]): boolean {
  let best: ReachabilityRule | null = null;
  for (const r of rules) {
    if (matchCidr(bytes, r.cidr) && (best === null || r.cidr.len > best.cidr.len)) {
      best = r;
    }
  }
  if (best === null) {
    return false;
  }
  return best.globallyReachable;
}

/** True only if `ip` is a globally reachable address under the conservative policy. */
export function isGloballyReachable(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const bytes = parseIPv4(ip);
    return bytes !== null && classifyReachability(bytes, IPV4_RULES);
  }
  if (fam === 6) {
    if (ip.includes("%")) {
      return false; // zone id -> not a public destination
    }
    const bytes = parseIPv6(ip);
    if (bytes === null) {
      return false;
    }
    if (matchCidr(bytes, IPV6_MAPPED_V4) || matchCidr(bytes, IPV6_NAT64)) {
      const v4 = Uint8Array.from([bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0]);
      return classifyReachability(v4, IPV4_RULES);
    }
    return classifyReachability(bytes, IPV6_RULES);
  }
  return false;
}

/**
 * Classify a URL host (possibly a bracketed IPv6 literal): "not-ip" when it is a
 * DNS name (resolved + checked later via the lookup hook), else "global" /
 * "non-global" for an IP literal that must be judged before any request.
 */
export function classifyUrlHost(hostname: string): "not-ip" | "global" | "non-global" {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(h) === 0) {
    return "not-ip";
  }
  return isGloballyReachable(h) ? "global" : "non-global";
}

// -- authority canonicalization ---------------------------------------------

export interface Authority {
  readonly hostname: string; // lowercase ASCII, no brackets, no trailing dot, no empty label
  readonly port: number; // effective port (443 when omitted for https)
}

export function authorityKey(a: Authority): string {
  return `${a.hostname} ${a.port}`;
}

function normalizeHostname(raw: string): string | null {
  let h = raw.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  // Normalize exactly one conventional absolute-DNS trailing dot.
  if (h.endsWith(".")) {
    h = h.slice(0, -1);
  }
  if (h.length === 0 || h.endsWith(".") || h.split(".").some((label) => label.length === 0)) {
    return null;
  }
  return h;
}

/** Canonical https authority of a parsed URL, or null if the authority is invalid. */
export function authorityOfUrl(url: URL): Authority | null {
  const hostname = normalizeHostname(url.hostname);
  if (hostname === null) {
    return null;
  }
  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { hostname, port };
}

/**
 * Parse a bare authority string (host or host:port) from configuration into a
 * canonical Authority, rejecting anything carrying a scheme, credentials, path,
 * query, or fragment. Returns null on any violation.
 */
export function parseAuthority(input: string): Authority | null {
  if (input.length === 0 || input.length > 260 || /[/\\?#@]/.test(input) || input.includes("://")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(`https://${input}`);
  } catch {
    return null;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === null) {
    return null;
  }
  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { hostname, port };
}
