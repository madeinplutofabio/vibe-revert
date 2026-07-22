// packages/cli/test/license-net.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Boundary tests for the SSRF address classifier and authority canonicalizer
// (scripts/refresh-net.ts): global vs non-global IPv4/IPv6 (incl. conservatively
// denied globally-reachable special ranges), IPv4-mapped/NAT64 delegation in dotted
// and hex forms, longest-prefix CIDR boundaries, zone-id rejection, URL-host
// classification, and canonical (hostname, effective-port) authority parsing.

import { describe, expect, it } from "vitest";

import {
  authorityKey,
  authorityOfUrl,
  classifyUrlHost,
  isGloballyReachable,
  parseAuthority,
} from "../../../scripts/refresh-net.js";

describe("isGloballyReachable — IPv4", () => {
  it("accepts public unicast, including boundaries just outside special blocks", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.15.255.255",
      "172.32.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "223.255.255.255",
    ]) {
      expect(isGloballyReachable(ip)).toBe(true);
    }
  });

  it("rejects the IANA special-purpose ranges (incl. boundaries)", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.0",
      "255.255.255.255",
    ]) {
      expect(isGloballyReachable(ip)).toBe(false);
    }
  });
});

describe("isGloballyReachable — IPv6", () => {
  it("accepts global unicast (2000::/3, outside the denied sub-blocks)", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e"]) {
      expect(isGloballyReachable(ip)).toBe(true);
    }
  });

  it("rejects non-global and conservatively-denied ranges", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "2001::1",
      "2002::1",
      "3fff::1",
      "2620:4f:8000::1",
      "64:ff9b:1::1",
      "100::1",
      "5f00::1",
    ]) {
      expect(isGloballyReachable(ip)).toBe(false);
    }
  });

  it("delegates IPv4-mapped and NAT64 to the IPv4 policy (dotted forms)", () => {
    expect(isGloballyReachable("::ffff:8.8.8.8")).toBe(true);
    expect(isGloballyReachable("::ffff:127.0.0.1")).toBe(false);
    expect(isGloballyReachable("64:ff9b::8.8.8.8")).toBe(true);
    expect(isGloballyReachable("64:ff9b::127.0.0.1")).toBe(false);
  });

  it("classifies hexadecimal IPv4-mapped and NAT64 embeddings through the IPv4 policy", () => {
    expect(isGloballyReachable("::ffff:7f00:1")).toBe(false); // hex form of 127.0.0.1
    expect(isGloballyReachable("64:ff9b::808:808")).toBe(true);
    expect(isGloballyReachable("64:ff9b::7f00:1")).toBe(false);
  });

  it("rejects an address carrying a zone identifier", () => {
    expect(isGloballyReachable("fe80::1%eth0")).toBe(false);
    expect(isGloballyReachable("2606:4700::1%eth0")).toBe(false);
  });
});

describe("isGloballyReachable — conservative policy and CIDR boundaries", () => {
  it("conservatively rejects selected globally reachable special-purpose addresses", () => {
    expect(isGloballyReachable("192.0.0.9")).toBe(false);
    expect(isGloballyReachable("192.0.0.10")).toBe(false);
    expect(isGloballyReachable("2001:20::1")).toBe(false); // ORCHIDv2
    expect(isGloballyReachable("2620:4f:8000::1")).toBe(false); // AS112-v6
  });

  it("applies the longest-prefix rules at exact IPv6 boundaries", () => {
    expect(isGloballyReachable("2001:1ff:ffff::1")).toBe(false); // last address in 2001::/23
    expect(isGloballyReachable("2001:200::1")).toBe(true); // immediately outside 2001::/23
    expect(isGloballyReachable("3fff:ffff:ffff::1")).toBe(true); // in 2000::/3, outside 3fff::/20
    expect(isGloballyReachable("4000::1")).toBe(false); // outside 2000::/3
  });
});

describe("isGloballyReachable — non-IP input", () => {
  it("returns false for hostnames and malformed literals", () => {
    for (const s of ["example.com", "registry.npmjs.org", "", "1.2.3.256", "not-an-ip"]) {
      expect(isGloballyReachable(s)).toBe(false);
    }
  });
});

describe("classifyUrlHost", () => {
  it("classifies IP literals and DNS names", () => {
    expect(classifyUrlHost("8.8.8.8")).toBe("global");
    expect(classifyUrlHost("127.0.0.1")).toBe("non-global");
    expect(classifyUrlHost("[::1]")).toBe("non-global");
    expect(classifyUrlHost("[2606:4700:4700::1111]")).toBe("global");
    expect(classifyUrlHost("example.com")).toBe("not-ip");
    expect(classifyUrlHost("registry.npmjs.org")).toBe("not-ip");
  });
});

describe("authority canonicalization", () => {
  it("canonicalizes a URL authority (lowercase, trailing dot, default port, brackets)", () => {
    expect(authorityOfUrl(new URL("https://Registry.NPMJS.org./"))).toEqual({
      hostname: "registry.npmjs.org",
      port: 443,
    });
    expect(authorityOfUrl(new URL("https://registry.npmjs.org:8443/x"))).toEqual({
      hostname: "registry.npmjs.org",
      port: 8443,
    });
    expect(authorityOfUrl(new URL("https://[::1]/"))).toEqual({ hostname: "::1", port: 443 });
  });

  it("authorityKey matches equivalent forms and distinguishes ports", () => {
    const a = authorityOfUrl(new URL("https://a.example/"));
    const b = authorityOfUrl(new URL("https://a.example:443/"));
    const c = authorityOfUrl(new URL("https://a.example:8443/"));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    if (a && b && c) {
      expect(authorityKey(a)).toBe(authorityKey(b));
      expect(authorityKey(a)).not.toBe(authorityKey(c));
    }
  });

  it("parseAuthority accepts host and host:port, normalizing the trailing dot", () => {
    expect(parseAuthority("registry.npmjs.org")).toEqual({
      hostname: "registry.npmjs.org",
      port: 443,
    });
    expect(parseAuthority("registry.npmjs.org:8443")).toEqual({
      hostname: "registry.npmjs.org",
      port: 8443,
    });
    expect(parseAuthority("registry.npmjs.org.")).toEqual({
      hostname: "registry.npmjs.org",
      port: 443,
    });
  });

  it("parseAuthority rejects malformed authorities", () => {
    for (const bad of [
      ".",
      "example..",
      "a..b",
      "host/path",
      "user@host",
      "https://host",
      "host:0",
      "host:99999",
      "",
      "host?x",
      "host#x",
    ]) {
      expect(parseAuthority(bad)).toBeNull();
    }
  });
});
