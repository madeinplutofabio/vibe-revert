// packages/cli/test/license-registry.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Contract tests for the registry network layer (scripts/refresh-registry.ts).
// node:https.request and node:dns.lookup are mocked with controlled doubles (no
// real sockets, TLS, or DNS). Covered:
//   - fetchVersionMetadata / fetchTarball: redirects, partial/aborted/early-closed
//     bodies, malformed/short Content-Length, cap-crossing bodies, content-encoding,
//     status classification, transport/timeout errors, SSRF-blocked propagation,
//     strict metadata parsing, receivedBytes accounting;
//   - safeLookup (the SSRF DNS hook): global single-result accepted, private single
//     blocked, all:true arrays validated element-by-element, callback arity proven by
//     captured argument count, allowPrivate honored, DNS errors passed through;
//   - validateNetworkPolicy: scheme/credentials/bounds/extra-host rejections and
//     default-port authority dedup;
//   - the IP-literal guard: a non-global literal is refused by validateUrl before any
//     request, and only the explicit escape hatch permits it.
// Address classification itself is proven in license-net.test.ts; here we prove the
// request options carry the hook and that policy failures propagate with the right
// retryable classification.

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock, lookupMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  lookupMock: vi.fn(),
}));
vi.mock("node:https", () => ({ request: requestMock }));
vi.mock("node:dns", () => ({ lookup: lookupMock }));

import {
  DEFAULT_NETWORK_POLICY,
  fetchTarball,
  fetchVersionMetadata,
  type NetworkPolicy,
  type ValidatedPolicy,
  validateNetworkPolicy,
} from "../../../scripts/refresh-registry.js";

type Scenario =
  | { kind: "reqError"; error: NodeJS.ErrnoException }
  | { kind: "timeout" }
  | {
      kind: "response";
      status: number;
      headers: Record<string, string>;
      chunks?: Buffer[];
      complete?: "end" | "aborted" | "close";
    };

type LookupCb = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;
type CapturedLookup = (hostname: string, options: unknown, callback: LookupCb) => void;

const queue: Scenario[] = [];
let lastRequestOptions: { lookup?: unknown } | null = null;

function enqueue(s: Scenario): void {
  queue.push(s);
}

function policy(overrides: Partial<NetworkPolicy> = {}): ValidatedPolicy {
  const r = validateNetworkPolicy({ ...DEFAULT_NETWORK_POLICY, ...overrides });
  if (!r.ok) {
    throw new Error(`test policy invalid: ${r.reason}`);
  }
  return r.validated;
}

beforeEach(() => {
  queue.length = 0;
  lastRequestOptions = null;
  lookupMock.mockReset();
  requestMock.mockReset();
  requestMock.mockImplementation(
    (_url: unknown, options: unknown, callback: (res: unknown) => void) => {
      lastRequestOptions = options as { lookup?: unknown };
      const scenario = queue.shift();
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: unknown;
        destroy: unknown;
        end: unknown;
      };
      req.setTimeout = vi.fn((_ms: number, cb: () => void) => {
        if (scenario?.kind === "timeout") {
          queueMicrotask(cb);
        }
      });
      req.destroy = vi.fn((err?: Error) => {
        if (err) {
          queueMicrotask(() => req.emit("error", err));
        }
      });
      req.end = vi.fn(() => {
        queueMicrotask(() => {
          if (scenario === undefined) {
            req.emit("error", new Error("test: no scenario queued"));
            return;
          }
          if (scenario.kind === "reqError") {
            req.emit("error", scenario.error);
            return;
          }
          if (scenario.kind === "timeout") {
            return; // delivered via req.setTimeout -> req.destroy
          }
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
            destroy: unknown;
          };
          res.statusCode = scenario.status;
          res.headers = scenario.headers;
          res.destroy = vi.fn();
          callback(res);
          for (const chunk of scenario.chunks ?? []) {
            res.emit("data", chunk);
          }
          const mode = scenario.complete ?? "end";
          if (mode === "aborted") {
            res.emit("aborted");
          } else if (mode === "close") {
            res.emit("close"); // early close without "end"
          } else {
            res.emit("end");
            res.emit("close");
          }
        });
      });
      return req;
    },
  );
});

const TARBALL_URL = "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz";

async function capturedLookup(pol: ValidatedPolicy): Promise<CapturedLookup> {
  enqueue({ kind: "response", status: 200, headers: {}, chunks: [Buffer.from("x")] });
  await fetchTarball(TARBALL_URL, pol);
  const lookup = lastRequestOptions?.lookup;
  if (typeof lookup !== "function") {
    throw new Error("request options did not carry a lookup hook");
  }
  return lookup as CapturedLookup;
}

// Captures the exact number of arguments the hook forwards, so the single-result
// (3-arg) vs all:true-array (2-arg) callback shapes are distinguishable — an
// undefined third parameter alone could not tell callback(e, a) from callback(e, a, undefined).
function invokeLookup(
  lookup: CapturedLookup,
  options: unknown,
): Promise<{
  err: NodeJS.ErrnoException | null;
  address: unknown;
  family: number | undefined;
  argumentCount: number;
}> {
  return new Promise((resolve) => {
    lookup("registry.npmjs.org", options, (...args: unknown[]) => {
      const [err, address, family] = args as [
        NodeJS.ErrnoException | null,
        unknown,
        number | undefined,
      ];
      resolve({ err, address, family, argumentCount: args.length });
    });
  });
}

describe("fetchVersionMetadata", () => {
  it("returns dist.tarball + dist.integrity on a 200 JSON response", async () => {
    const doc = JSON.stringify({ dist: { tarball: TARBALL_URL, integrity: "sha512-abc" } });
    enqueue({
      kind: "response",
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [Buffer.from(doc)],
    });
    const r = await fetchVersionMetadata("foo", "1.0.0", policy());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tarballUrl).toBe(TARBALL_URL);
      expect(r.distIntegrity).toBe("sha512-abc");
      expect(r.receivedBytes).toBe(Buffer.byteLength(doc));
    }
  });

  it("accepts an application/*+json content-type", async () => {
    const doc = JSON.stringify({ dist: { tarball: TARBALL_URL } });
    enqueue({
      kind: "response",
      status: 200,
      headers: { "content-type": "application/vnd.npm.install-v1+json" },
      chunks: [Buffer.from(doc)],
    });
    const r = await fetchVersionMetadata("foo", "1.0.0", policy());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.distIntegrity).toBeNull();
    }
  });

  it("rejects a non-JSON content-type (non-retryable)", async () => {
    enqueue({
      kind: "response",
      status: 200,
      headers: { "content-type": "text/html" },
      chunks: [Buffer.from("<html>")],
    });
    const r = await fetchVersionMetadata("foo", "1.0.0", policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.reason).toContain("content-type");
    }
  });

  it("rejects metadata missing dist.tarball", async () => {
    enqueue({
      kind: "response",
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [Buffer.from('{"dist":{}}')],
    });
    expect((await fetchVersionMetadata("foo", "1.0.0", policy())).ok).toBe(false);
  });

  it("rejects duplicate-key metadata JSON via the strict parser", async () => {
    const dup = '{"dist":{"tarball":"https://registry.npmjs.org/x"},"dist":{}}';
    enqueue({
      kind: "response",
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [Buffer.from(dup)],
    });
    expect((await fetchVersionMetadata("foo", "1.0.0", policy())).ok).toBe(false);
  });

  it("rejects an invalid package name before any request", async () => {
    const r = await fetchVersionMetadata("../evil", "1.0.0", policy());
    expect(r.ok).toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("fetchTarball", () => {
  it("returns bytes + receivedBytes on a 200", async () => {
    const body = Buffer.from("tarball-bytes");
    enqueue({ kind: "response", status: 200, headers: {}, chunks: [body] });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes.equals(body)).toBe(true);
      expect(r.receivedBytes).toBe(body.length);
    }
  });

  it("follows a 302 redirect to an allowlisted host", async () => {
    enqueue({
      kind: "response",
      status: 302,
      headers: { location: "https://registry.npmjs.org/redir.tgz" },
    });
    const body = Buffer.from("after-redirect");
    enqueue({ kind: "response", status: 200, headers: {}, chunks: [body] });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes.equals(body)).toBe(true);
    }
  });

  it("refuses a redirect to a non-allowlisted host (non-retryable)", async () => {
    enqueue({ kind: "response", status: 302, headers: { location: "https://evil.example/x.tgz" } });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.reason).toContain("allowlist");
    }
  });

  it("treats a non-redirect 3xx as an ordinary failure", async () => {
    enqueue({ kind: "response", status: 300, headers: {} });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("300");
    }
  });

  it("rejects an unexpected content-encoding (non-retryable)", async () => {
    enqueue({
      kind: "response",
      status: 200,
      headers: { "content-encoding": "gzip" },
      chunks: [Buffer.from("x")],
    });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.reason).toContain("content-encoding");
    }
  });

  it("rejects an invalid Content-Length (non-retryable)", async () => {
    enqueue({
      kind: "response",
      status: 200,
      headers: { "content-length": "abc" },
      chunks: [Buffer.from("x")],
    });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.reason).toContain("content-length");
    }
  });

  it("rejects a Content-Length mismatch (retryable) and reports received bytes", async () => {
    const body = Buffer.from("short");
    enqueue({
      kind: "response",
      status: 200,
      headers: { "content-length": "999" },
      chunks: [body],
    });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(true);
      expect(r.receivedBytes).toBe(body.length);
    }
  });

  it("rejects a body over the cap (non-retryable)", async () => {
    enqueue({ kind: "response", status: 200, headers: {}, chunks: [Buffer.alloc(2048, 0x61)] });
    const r = await fetchTarball(TARBALL_URL, policy({ maxTarballBytes: 1024 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.reason).toContain("exceeds");
    }
  });

  it("classifies an aborted body as retryable, charging received bytes", async () => {
    const chunk = Buffer.from("partial");
    enqueue({ kind: "response", status: 200, headers: {}, chunks: [chunk], complete: "aborted" });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(true);
      expect(r.receivedBytes).toBe(chunk.length);
    }
  });

  it("classifies an early close without end as retryable", async () => {
    enqueue({
      kind: "response",
      status: 200,
      headers: {},
      chunks: [Buffer.from("x")],
      complete: "close",
    });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(true);
    }
  });

  it("classifies 5xx and 429 as retryable, 404 as not", async () => {
    for (const [status, retryable] of [
      [503, true],
      [429, true],
      [404, false],
    ] as const) {
      enqueue({ kind: "response", status, headers: {} });
      const r = await fetchTarball(TARBALL_URL, policy());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.retryable).toBe(retryable);
      }
    }
  });

  it("propagates a transport error as retryable", async () => {
    const err = new Error("ECONNRESET") as NodeJS.ErrnoException;
    err.code = "ECONNRESET";
    enqueue({ kind: "reqError", error: err });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(true);
    }
  });

  it("propagates an SSRF-blocked lookup error as NON-retryable", async () => {
    const err = new Error("refusing a non-public address") as NodeJS.ErrnoException;
    err.code = "SSRF_BLOCKED";
    enqueue({ kind: "reqError", error: err });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
    }
  });

  it("classifies a socket idle timeout as retryable", async () => {
    enqueue({ kind: "timeout" });
    const r = await fetchTarball(TARBALL_URL, policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(true);
    }
  });

  it("refuses a non-allowlisted tarball URL before any request", async () => {
    const r = await fetchTarball("https://evil.example/x.tgz", policy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
    }
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("safeLookup DNS hook", () => {
  it("passes a globally reachable single result through (3-arg callback)", async () => {
    const lookup = await capturedLookup(policy());
    lookupMock.mockImplementationOnce((_h: string, _o: unknown, cb: LookupCb) =>
      cb(null, "8.8.8.8", 4),
    );
    const r = await invokeLookup(lookup, {});
    expect(r).toEqual({ err: null, address: "8.8.8.8", family: 4, argumentCount: 3 });
  });

  it("blocks a private single result with SSRF_BLOCKED, preserving the 3-arg shape", async () => {
    const lookup = await capturedLookup(policy());
    lookupMock.mockImplementationOnce((_h: string, _o: unknown, cb: LookupCb) =>
      cb(null, "127.0.0.1", 4),
    );
    const r = await invokeLookup(lookup, {});
    expect(r.err?.code).toBe("SSRF_BLOCKED");
    expect(r.address).toBe("127.0.0.1");
    expect(r.argumentCount).toBe(3);
  });

  it("blocks an all:true array if any address is non-global (2-arg callback)", async () => {
    const lookup = await capturedLookup(policy());
    lookupMock.mockImplementationOnce((_h: string, _o: unknown, cb: LookupCb) =>
      cb(null, [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    );
    const r = await invokeLookup(lookup, { all: true });
    expect(r.err?.code).toBe("SSRF_BLOCKED");
    expect(r.argumentCount).toBe(2);
  });

  it("passes an all-public all:true array through (2-arg callback)", async () => {
    const lookup = await capturedLookup(policy());
    const addresses = [
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ];
    lookupMock.mockImplementationOnce((_h: string, _o: unknown, cb: LookupCb) =>
      cb(null, addresses),
    );
    const r = await invokeLookup(lookup, { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual(addresses);
    expect(r.argumentCount).toBe(2);
  });

  it("honors allowPrivateAddresses by passing a private result through (3-arg callback)", async () => {
    const lookup = await capturedLookup(policy({ allowPrivateAddresses: true }));
    lookupMock.mockImplementationOnce((_h: string, _o: unknown, cb: LookupCb) =>
      cb(null, "127.0.0.1", 4),
    );
    const r = await invokeLookup(lookup, {});
    expect(r.err).toBeNull();
    expect(r.address).toBe("127.0.0.1");
    expect(r.argumentCount).toBe(3);
  });

  it("passes a DNS resolution error through unchanged", async () => {
    const lookup = await capturedLookup(policy());
    const dnsErr = new Error("ENOTFOUND") as NodeJS.ErrnoException;
    dnsErr.code = "ENOTFOUND";
    lookupMock.mockImplementationOnce((_h: string, _o: unknown, cb: LookupCb) => cb(dnsErr));
    const r = await invokeLookup(lookup, {});
    expect(r.err).toBe(dnsErr);
    // The non-array error branch re-emits callback(err, address, family): address and
    // family are undefined but still explicitly passed, so the arity is 3, not 1.
    expect(r.argumentCount).toBe(3);
  });
});

describe("validateNetworkPolicy", () => {
  it("rejects an http registry URL", () => {
    expect(
      validateNetworkPolicy({ ...DEFAULT_NETWORK_POLICY, registryUrl: "http://registry.example" })
        .ok,
    ).toBe(false);
  });

  it("rejects a registry URL carrying credentials", () => {
    expect(
      validateNetworkPolicy({
        ...DEFAULT_NETWORK_POLICY,
        registryUrl: "https://user:pass@registry.example",
      }).ok,
    ).toBe(false);
  });

  it("rejects requestTimeoutMs greater than overallDeadlineMs", () => {
    expect(
      validateNetworkPolicy({
        ...DEFAULT_NETWORK_POLICY,
        requestTimeoutMs: 2000,
        overallDeadlineMs: 1000,
      }).ok,
    ).toBe(false);
  });

  it("rejects an extra tarball host given as a URL with a path", () => {
    expect(
      validateNetworkPolicy({
        ...DEFAULT_NETWORK_POLICY,
        extraTarballHosts: ["https://cdn.example/path"],
      }).ok,
    ).toBe(false);
  });

  it("deduplicates equivalent default-port authorities in the tarball allowlist", () => {
    const r = validateNetworkPolicy({
      ...DEFAULT_NETWORK_POLICY,
      registryUrl: "https://registry.npmjs.org",
      extraTarballHosts: ["registry.npmjs.org", "registry.npmjs.org:443", "registry.npmjs.org."],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.validated.tarballAllowKeys).toHaveLength(1);
    }
  });
});

describe("IP-literal SSRF guard", () => {
  it("refuses a non-global IP-literal URL before creating a request", async () => {
    const result = await fetchTarball(
      "https://127.0.0.1/package.tgz",
      policy({ registryUrl: "https://127.0.0.1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain("non-public IP");
      expect(result.receivedBytes).toBe(0);
    }
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("allows a private IP literal only when explicitly enabled", async () => {
    const body = Buffer.from("local-registry");
    enqueue({ kind: "response", status: 200, headers: {}, chunks: [body] });
    const result = await fetchTarball(
      "https://127.0.0.1/package.tgz",
      policy({ registryUrl: "https://127.0.0.1", allowPrivateAddresses: true }),
    );
    expect(result.ok).toBe(true);
    expect(requestMock).toHaveBeenCalledOnce();
  });
});
