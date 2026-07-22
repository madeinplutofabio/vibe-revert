// packages/cli/test/license-refresh-core.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Tests for the extracted refresh orchestration mechanics
// (scripts/refresh-license-metadata-core.ts): the response-body Budget (validated
// construction/reservation, multiset exact-match settlement, unused-capacity release,
// overage accounting), the retry-within-a-reservation loop (grant/retry/receivedBytes
// validation, shrinking-cap retries, cap-exhaustion stop), the cache-identity work-item
// builder (dedup by [name,version,integrity], git/directory -> unsupported,
// retrieval-field disagreement -> conflict, deterministic order), the reservation
// eligibility (reserveFor), the collected-entry builder (packaged name/version match,
// license extraction, malformed rejections), and the entry builders + deterministic
// sort key. Pure, no I/O or network.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { LockfilePackageIdentity } from "../../../scripts/license-audit-core.js";
import {
  Budget,
  buildCollected,
  buildWorkItems,
  entrySortKey,
  failedRegistry,
  fetchWithinBudget,
  reserveFor,
  unsupportedEntry,
  workItemKey,
} from "../../../scripts/refresh-license-metadata-core.js";
import {
  DEFAULT_NETWORK_POLICY,
  validateNetworkPolicy,
} from "../../../scripts/refresh-registry.js";

const VALID_SRI = `sha512-${createHash("sha512").update("x").digest("base64")}`;

const VALIDATED = (() => {
  const r = validateNetworkPolicy(DEFAULT_NETWORK_POLICY);
  if (!r.ok) {
    throw new Error("default network policy should validate");
  }
  return r.validated;
})();

function id(overrides: Partial<LockfilePackageIdentity> = {}): LockfilePackageIdentity {
  return {
    packageKey: "foo@1.0.0",
    name: "foo",
    version: "1.0.0",
    integrity: "sha512-abc",
    sourceKind: "registry",
    tarballUrl: null,
    ...overrides,
  };
}

function pkgMap(ids: LockfilePackageIdentity[]): ReadonlyMap<string, LockfilePackageIdentity> {
  return new Map(ids.map((x) => [x.packageKey, x]));
}

describe("Budget", () => {
  it("rejects an invalid limit", () => {
    expect(() => new Budget(0)).toThrow();
    expect(() => new Budget(-1)).toThrow();
    expect(() => new Budget(1.5)).toThrow();
  });

  it("rejects an invalid reservation and treats zero as no reservation", () => {
    const b = new Budget(100);
    expect(() => b.reserve(-1)).toThrow();
    expect(() => b.reserve(1.5)).toThrow();
    expect(b.reserve(0)).toBe(0);
  });

  it("grants up to the remaining budget and denies once exhausted", () => {
    const b = new Budget(100);
    expect(b.reserve(60)).toBe(60);
    expect(b.reserve(60)).toBe(40);
    expect(b.reserve(10)).toBe(0);
  });

  it("requires an exact matching reservation to settle", () => {
    const b = new Budget(100);
    b.reserve(60);
    b.reserve(40);
    expect(() => b.settle(100, 0)).toThrow(/no matching reservation/);
    expect(() => b.settle(0, 0)).toThrow();
    b.settle(60, 0);
    b.settle(40, 0);
  });

  it("settles duplicate equal reservations independently and rejects the third", () => {
    const b = new Budget(200);
    b.reserve(50);
    b.reserve(50);
    b.settle(50, 10);
    b.settle(50, 20);
    expect(() => b.settle(50, 0)).toThrow(/no matching reservation/);
  });

  it("releases unused reservation capacity after settlement", () => {
    const b = new Budget(100);
    expect(b.reserve(80)).toBe(80);
    b.settle(80, 30);
    expect(b.reserve(70)).toBe(70);
    expect(b.reserve(1)).toBe(0);
  });

  it("charges a genuine overage and then denies further reservation", () => {
    const b = new Budget(100);
    expect(b.reserve(100)).toBe(100);
    b.settle(100, 150);
    expect(b.reserve(1)).toBe(0);
  });

  it("rejects an invalid settlement used value", () => {
    const b = new Budget(100);
    b.reserve(50);
    expect(() => b.settle(50, -1)).toThrow();
    expect(() => b.settle(50, 1.5)).toThrow();
  });
});

describe("fetchWithinBudget", () => {
  const RETRY = { maxAttempts: 3, delayMs: 0 };

  it("rejects a non-positive grant", async () => {
    await expect(
      fetchWithinBudget(
        async () => ({ ok: true, receivedBytes: 0 }),
        () => false,
        0,
        RETRY,
      ),
    ).rejects.toThrow(/grant/);
    await expect(
      fetchWithinBudget(
        async () => ({ ok: true, receivedBytes: 0 }),
        () => false,
        -1,
        RETRY,
      ),
    ).rejects.toThrow(/grant/);
  });

  it("rejects an invalid retry configuration", async () => {
    await expect(
      fetchWithinBudget(
        async () => ({ ok: true, receivedBytes: 0 }),
        () => false,
        100,
        { maxAttempts: 0, delayMs: 0 },
      ),
    ).rejects.toThrow(/retry/);
  });

  it("returns a single non-retryable result and charges its bytes", async () => {
    let calls = 0;
    const r = await fetchWithinBudget(
      async () => {
        calls += 1;
        return { ok: true, receivedBytes: 30 };
      },
      () => false,
      100,
      RETRY,
    );
    expect(calls).toBe(1);
    expect(r.consumed).toBe(30);
    expect(r.result.ok).toBe(true);
  });

  it("retries up to maxAttempts with a shrinking cap, charging every attempt", async () => {
    const caps: number[] = [];
    const r = await fetchWithinBudget(
      async (cap) => {
        caps.push(cap);
        return { ok: false, retryable: true, receivedBytes: 20 };
      },
      (x) => !x.ok && x.retryable,
      100,
      RETRY,
    );
    expect(caps).toEqual([100, 80, 60]);
    expect(r.consumed).toBe(60);
  });

  it("stops retrying once the cap is exhausted", async () => {
    let calls = 0;
    const r = await fetchWithinBudget(
      async () => {
        calls += 1;
        return { ok: false, retryable: true, receivedBytes: 100 };
      },
      (x) => !x.ok && x.retryable,
      100,
      RETRY,
    );
    expect(calls).toBe(1);
    expect(r.consumed).toBe(100);
  });

  it("rejects an invalid receivedBytes from the attempt", async () => {
    await expect(
      fetchWithinBudget(
        async () => ({ ok: true, receivedBytes: -5 }),
        () => false,
        100,
        RETRY,
      ),
    ).rejects.toThrow(/receivedBytes/);
  });
});

describe("buildWorkItems", () => {
  it("dedups multiple package keys of one registry identity into a single item", () => {
    const items = buildWorkItems({
      packages: pkgMap([
        id({ packageKey: "foo@1.0.0", integrity: "sha512-a" }),
        id({ packageKey: "foo@1.0.0(bar@2.0.0)", integrity: "sha512-a" }),
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("registry");
  });

  it("emits unsupported items for git and directory sources", () => {
    const items = buildWorkItems({
      packages: pkgMap([
        id({ packageKey: "g@1.0.0", name: "g", sourceKind: "git", integrity: null }),
        id({ packageKey: "d@1.0.0", name: "d", sourceKind: "directory", integrity: null }),
      ]),
    });
    expect(items.map((w) => w.kind)).toEqual(["unsupported", "unsupported"]);
  });

  it("flags a conflict when equivalent identities disagree on a retrieval field", () => {
    const items = buildWorkItems({
      packages: pkgMap([
        id({
          packageKey: "foo@1.0.0",
          integrity: "sha512-a",
          sourceKind: "registry",
          tarballUrl: null,
        }),
        id({
          packageKey: "foo@1.0.0(x)",
          integrity: "sha512-a",
          sourceKind: "tarball-url",
          tarballUrl: "https://x/y.tgz",
        }),
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("conflict");
  });

  it("sorts items deterministically by package key", () => {
    const items = buildWorkItems({
      packages: pkgMap([
        id({ packageKey: "zzz@1.0.0", name: "zzz", integrity: "sha512-z" }),
        id({ packageKey: "aaa@1.0.0", name: "aaa", integrity: "sha512-a" }),
      ]),
    });
    expect(items.map((w) => workItemKey(w))).toEqual(["aaa@1.0.0", "zzz@1.0.0"]);
  });
});

describe("reserveFor", () => {
  it("does not reserve for non-registry, ineligible, or missing-url items", () => {
    const mb = new Budget(1000);
    const tb = new Budget(1000);
    expect(reserveFor({ kind: "unsupported", id: id() }, mb, tb, VALIDATED)).toEqual({
      metadataGrant: 0,
      tarballGrant: 0,
    });
    expect(reserveFor({ kind: "conflict", rep: id(), reason: "x" }, mb, tb, VALIDATED)).toEqual({
      metadataGrant: 0,
      tarballGrant: 0,
    });
    expect(
      reserveFor({ kind: "registry", rep: id({ integrity: "sha512-abc" }) }, mb, tb, VALIDATED),
    ).toEqual({ metadataGrant: 0, tarballGrant: 0 });
    expect(
      reserveFor({ kind: "registry", rep: id({ integrity: null }) }, mb, tb, VALIDATED),
    ).toEqual({ metadataGrant: 0, tarballGrant: 0 });
    expect(
      reserveFor(
        {
          kind: "registry",
          rep: id({ sourceKind: "tarball-url", tarballUrl: null, integrity: VALID_SRI }),
        },
        mb,
        tb,
        VALIDATED,
      ),
    ).toEqual({ metadataGrant: 0, tarballGrant: 0 });
  });

  it("reserves metadata + tarball for an eligible registry item", () => {
    const mb = new Budget(VALIDATED.maxMetadataBytes);
    const tb = new Budget(VALIDATED.maxTarballBytes);
    const r = reserveFor(
      { kind: "registry", rep: id({ integrity: VALID_SRI }) },
      mb,
      tb,
      VALIDATED,
    );
    expect(r.metadataGrant).toBe(VALIDATED.maxMetadataBytes);
    expect(r.tarballGrant).toBe(VALIDATED.maxTarballBytes);
  });

  it("reserves only the tarball for a tarball-url item", () => {
    const mb = new Budget(VALIDATED.maxMetadataBytes);
    const tb = new Budget(VALIDATED.maxTarballBytes);
    const r = reserveFor(
      {
        kind: "registry",
        rep: id({ sourceKind: "tarball-url", tarballUrl: "https://x/y.tgz", integrity: VALID_SRI }),
      },
      mb,
      tb,
      VALIDATED,
    );
    expect(r.metadataGrant).toBe(0);
    expect(r.tarballGrant).toBe(VALIDATED.maxTarballBytes);
  });

  it("grants 0 when the tarball budget is exhausted", () => {
    const mb = new Budget(VALIDATED.maxMetadataBytes);
    const tb = new Budget(VALIDATED.maxTarballBytes);
    tb.reserve(VALIDATED.maxTarballBytes);
    expect(
      reserveFor({ kind: "registry", rep: id({ integrity: VALID_SRI }) }, mb, tb, VALIDATED)
        .tarballGrant,
    ).toBe(0);
  });
});

describe("buildCollected", () => {
  it("builds a collected entry from a matching package.json", () => {
    const pkg = Buffer.from(
      JSON.stringify({ name: "foo", version: "1.0.0", license: "MIT" }),
      "utf8",
    );
    const r = buildCollected(id(), "sha512-abc", pkg, ["LICENSE"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry).toMatchObject({
        collectionStatus: "collected",
        name: "foo",
        version: "1.0.0",
        integrity: "sha512-abc",
        tarballIntegrity: "sha512-abc",
        normalizedSpdx: "MIT",
        rawLicensePresent: true,
        packagedLegalFiles: ["LICENSE"],
      });
    }
  });

  it("rejects a name or version mismatch against the lockfile identity", () => {
    expect(
      buildCollected(
        id(),
        "sha512-abc",
        Buffer.from(JSON.stringify({ name: "evil", version: "1.0.0" }), "utf8"),
        [],
      ).ok,
    ).toBe(false);
    expect(
      buildCollected(
        id(),
        "sha512-abc",
        Buffer.from(JSON.stringify({ name: "foo", version: "9.9.9" }), "utf8"),
        [],
      ).ok,
    ).toBe(false);
  });

  it("rejects invalid UTF-8, invalid JSON, and non-object package.json", () => {
    expect(buildCollected(id(), "sha512-abc", Buffer.from([0xff, 0xff]), []).ok).toBe(false);
    expect(buildCollected(id(), "sha512-abc", Buffer.from("{not json"), []).ok).toBe(false);
    expect(buildCollected(id(), "sha512-abc", Buffer.from("[1,2]"), []).ok).toBe(false);
  });

  it("records an absent license field distinctly", () => {
    const r = buildCollected(
      id(),
      "sha512-abc",
      Buffer.from(JSON.stringify({ name: "foo", version: "1.0.0" }), "utf8"),
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.rawLicensePresent).toBe(false);
      expect(r.entry.rawLicense).toBeNull();
      expect(r.entry.normalizedSpdx).toBeNull();
    }
  });
});

describe("entry builders and sort key", () => {
  it("builds unsupported and failed-registry entries", () => {
    expect(unsupportedEntry(id({ sourceKind: "git", integrity: null }), "git unsupported")).toEqual(
      {
        collectionStatus: "failed",
        packageKey: "foo@1.0.0",
        collectionReason: "git unsupported",
        retrievalSource: null,
      },
    );
    expect(failedRegistry(id(), "sha512-abc", "registry-tarball", "boom")).toEqual({
      collectionStatus: "failed",
      name: "foo",
      version: "1.0.0",
      integrity: "sha512-abc",
      collectionReason: "boom",
      retrievalSource: "registry-tarball",
      tarballIntegrity: null,
    });
  });

  it("produces distinct sort keys for keyed and identity entries", () => {
    expect(entrySortKey(unsupportedEntry(id({ packageKey: "g@1.0.0" }), "x"))).not.toBe(
      entrySortKey(failedRegistry(id(), "sha512-abc", null, "y")),
    );
  });
});
