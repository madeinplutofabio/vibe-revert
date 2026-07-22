// packages/cli/test/license-schemas.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Boundary tests for the committed-schema validators (scripts/license-schemas.ts):
// SPDX single-identifier recognition and normalization; policy structure, disposition
// and obligation rules (array-only, control-free, trimmed, de-duplicated, sorted),
// and limits; metadata-cache structure across the three entry shapes (collected,
// failed-registry incl. null integrity, failed-unsupported keyed by packageKey), the
// collected cross-field invariants (tarballIntegrity===integrity,
// normalizedSpdx===normalizeSpdx(rawLicense), rawLicense null when absent, fixed
// licenseMetadataSource), package-relative legal-file path safety, entry routing, and
// resource limits. Cross-entry duplicate-identity rejection lives in the core
// (buildAuditModel), tested in license-core.test.ts, not here. Backslashes/control
// chars are built from code points to avoid tooling-transport escape decoding.

import { describe, expect, it } from "vitest";

import {
  isSingleSpdxId,
  normalizeSpdx,
  parseMetadataCache,
  parsePolicy,
  type SchemaLimits,
} from "../../../scripts/license-schemas.js";

const BS = String.fromCharCode(0x5c); // one backslash, transport-safe
const CTRL = String.fromCharCode(1); // a C0 control character

function policyErrors(raw: unknown, limits?: Partial<SchemaLimits>): string[] {
  const r = parsePolicy(raw, limits);
  if (r.ok) {
    throw new Error("expected policy parse to fail");
  }
  return r.errors.map((e) => e.code);
}

function metadataErrors(raw: unknown, limits?: Partial<SchemaLimits>): string[] {
  const r = parseMetadataCache(raw, limits);
  if (r.ok) {
    throw new Error("expected metadata parse to fail");
  }
  return r.errors.map((e) => e.code);
}

function policyDoc(dispositions: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, dispositions };
}

function collected(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collectionStatus: "collected",
    name: "foo",
    version: "1.0.0",
    integrity: "sha512-abc",
    collectionReason: null,
    retrievalSource: "registry-tarball",
    tarballIntegrity: "sha512-abc",
    rawLicensePresent: true,
    rawLicense: "MIT",
    normalizedSpdx: "MIT",
    licenseMetadataSource: "packaged-package-json",
    packagedLegalFiles: ["LICENSE"],
    ...overrides,
  };
}

function failedRegistry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collectionStatus: "failed",
    name: "foo",
    version: "1.0.0",
    integrity: null,
    collectionReason: "registry fetch failed",
    retrievalSource: "registry-tarball",
    tarballIntegrity: null,
    ...overrides,
  };
}

function failedUnsupported(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collectionStatus: "failed",
    packageKey: "foo@1.0.0",
    collectionReason: "git source is unsupported",
    retrievalSource: null,
    ...overrides,
  };
}

function metadataDoc(entries: unknown[]): Record<string, unknown> {
  return { schemaVersion: 1, entries };
}

describe("isSingleSpdxId", () => {
  it("accepts single canonical identifiers", () => {
    for (const id of [
      "MIT",
      "Apache-2.0",
      "BSD-3-Clause",
      "0BSD",
      "CC0-1.0",
      "MIT-0",
      "BlueOak-1.0.0",
      "GPL-3.0-only",
    ]) {
      expect(isSingleSpdxId(id)).toBe(true);
    }
  });

  it("rejects operators, expressions, plus-shorthand, and malformed ids", () => {
    for (const id of [
      "AND",
      "OR",
      "WITH",
      "and",
      "Or",
      "wITh",
      "MIT OR Apache-2.0",
      "(MIT)",
      "Apache-2.0+",
      "",
      "-MIT",
      ".MIT",
      "MIT ",
      "SEE LICENSE IN LICENSE",
    ]) {
      expect(isSingleSpdxId(id)).toBe(false);
    }
  });
});

describe("normalizeSpdx", () => {
  it("returns a single SPDX identifier verbatim", () => {
    expect(normalizeSpdx("MIT")).toBe("MIT");
    expect(normalizeSpdx("Apache-2.0")).toBe("Apache-2.0");
  });

  it("returns null for non-strings, compounds, operators, and empty", () => {
    expect(normalizeSpdx(["MIT"])).toBeNull();
    expect(normalizeSpdx({ type: "MIT" })).toBeNull();
    expect(normalizeSpdx(null)).toBeNull();
    expect(normalizeSpdx(42)).toBeNull();
    expect(normalizeSpdx(true)).toBeNull();
    expect(normalizeSpdx("MIT OR Apache-2.0")).toBeNull();
    expect(normalizeSpdx("AND")).toBeNull();
    expect(normalizeSpdx("")).toBeNull();
  });
});

describe("parsePolicy — valid", () => {
  it("accepts an empty disposition table", () => {
    const r = parsePolicy(policyDoc());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.schemaVersion).toBe(1);
      expect(r.policy.dispositions.size).toBe(0);
    }
  });

  it("accepts entries and keeps obligations verbatim", () => {
    const r = parsePolicy(
      policyDoc({
        MIT: { disposition: "allowed-with-obligations", obligations: ["include-license-text"] },
        "0BSD": { disposition: "allowed", obligations: [] },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.dispositions.get("MIT")).toEqual({
        disposition: "allowed-with-obligations",
        obligations: ["include-license-text"],
      });
      expect(r.policy.dispositions.get("0BSD")).toEqual({
        disposition: "allowed",
        obligations: [],
      });
    }
  });

  it("sorts multi-obligation lists deterministically", () => {
    const r = parsePolicy(
      policyDoc({
        "Apache-2.0": {
          disposition: "allowed-with-obligations",
          obligations: ["preserve-notice-if-present", "include-license-text"],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.dispositions.get("Apache-2.0")?.obligations).toEqual([
        "include-license-text",
        "preserve-notice-if-present",
      ]);
    }
  });
});

describe("parsePolicy — rejections", () => {
  it("rejects a non-object document", () => {
    expect(policyErrors(null)).toContain("POLICY_MALFORMED");
    expect(policyErrors([])).toContain("POLICY_MALFORMED");
    expect(policyErrors("x")).toContain("POLICY_MALFORMED");
  });

  it("rejects unknown fields and unsupported schema versions", () => {
    expect(policyErrors({ schemaVersion: 1, dispositions: {}, extra: 1 })).toContain(
      "POLICY_UNKNOWN_FIELD",
    );
    expect(policyErrors({ schemaVersion: 2, dispositions: {} })).toContain(
      "POLICY_UNSUPPORTED_SCHEMA_VERSION",
    );
  });

  it("rejects an invalid SPDX key and an invalid disposition", () => {
    expect(
      policyErrors(policyDoc({ "MIT OR Apache-2.0": { disposition: "allowed", obligations: [] } })),
    ).toContain("POLICY_INVALID_SPDX_ID");
    expect(policyErrors(policyDoc({ MIT: { disposition: "banned", obligations: [] } }))).toContain(
      "POLICY_INVALID_DISPOSITION",
    );
  });

  it("rejects a malformed entry and unknown entry fields", () => {
    expect(policyErrors(policyDoc({ MIT: 42 }))).toContain("POLICY_ENTRY_MALFORMED");
    expect(
      policyErrors(policyDoc({ MIT: { disposition: "allowed", obligations: [], extra: 1 } })),
    ).toContain("POLICY_ENTRY_UNKNOWN_FIELD");
  });

  it("rejects invalid, padded, control-bearing, and duplicate obligations", () => {
    expect(
      policyErrors(policyDoc({ MIT: { disposition: "allowed", obligations: "x" } })),
    ).toContain("POLICY_INVALID_OBLIGATION");
    expect(
      policyErrors(policyDoc({ MIT: { disposition: "allowed", obligations: [" padded "] } })),
    ).toContain("POLICY_INVALID_OBLIGATION");
    expect(
      policyErrors(policyDoc({ MIT: { disposition: "allowed", obligations: [""] } })),
    ).toContain("POLICY_INVALID_OBLIGATION");
    expect(
      policyErrors(policyDoc({ MIT: { disposition: "allowed", obligations: [`x${CTRL}`] } })),
    ).toContain("POLICY_INVALID_OBLIGATION");
    expect(
      policyErrors(policyDoc({ MIT: { disposition: "allowed", obligations: ["a", "a"] } })),
    ).toContain("POLICY_INVALID_OBLIGATION");
  });
});

describe("parsePolicy — limits and error hygiene", () => {
  it("rejects invalid schema limits", () => {
    expect(policyErrors(policyDoc(), { maxStringLength: 0 })).toContain("SCHEMA_LIMITS_INVALID");
  });

  it("enforces per-entry obligation and entry-count limits", () => {
    expect(
      policyErrors(policyDoc({ MIT: { disposition: "allowed", obligations: ["a", "b", "c"] } }), {
        maxObligationsPerPolicyEntry: 2,
      }),
    ).toContain("POLICY_LIMIT_OBLIGATIONS_EXCEEDED");
    expect(
      policyErrors(
        policyDoc({
          MIT: { disposition: "allowed", obligations: [] },
          ISC: { disposition: "allowed", obligations: [] },
        }),
        { maxPolicyEntries: 1 },
      ),
    ).toContain("POLICY_LIMIT_ENTRIES_EXCEEDED");
  });

  it("returns sorted, de-duplicated errors", () => {
    const r = parsePolicy({ schemaVersion: 2, dispositions: {}, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain("POLICY_UNKNOWN_FIELD");
      expect(codes).toContain("POLICY_UNSUPPORTED_SCHEMA_VERSION");
      expect(new Set(codes).size).toBe(codes.length);
      expect(codes).toEqual([...codes].sort());
    }
  });
});

describe("parseMetadataCache — valid entries", () => {
  it("accepts an empty cache", () => {
    const r = parseMetadataCache(metadataDoc([]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cache.entries).toHaveLength(0);
    }
  });

  it("accepts a collected entry with a single-SPDX rawLicense", () => {
    const r = parseMetadataCache(metadataDoc([collected()]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cache.entries[0]).toMatchObject({
        collectionStatus: "collected",
        name: "foo",
        normalizedSpdx: "MIT",
      });
    }
  });

  it("accepts a collected entry whose compound rawLicense normalizes to null", () => {
    expect(
      parseMetadataCache(
        metadataDoc([collected({ rawLicense: "MIT OR Apache-2.0", normalizedSpdx: null })]),
      ).ok,
    ).toBe(true);
  });

  it("accepts a collected entry with no rawLicense present", () => {
    expect(
      parseMetadataCache(
        metadataDoc([
          collected({ rawLicensePresent: false, rawLicense: null, normalizedSpdx: null }),
        ]),
      ).ok,
    ).toBe(true);
  });

  it("accepts a collected entry with a present-but-null rawLicense (license field is null)", () => {
    expect(
      parseMetadataCache(
        metadataDoc([
          collected({ rawLicensePresent: true, rawLicense: null, normalizedSpdx: null }),
        ]),
      ).ok,
    ).toBe(true);
  });

  it("accepts a failed-registry entry with null integrity", () => {
    const r = parseMetadataCache(metadataDoc([failedRegistry()]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cache.entries[0]).toMatchObject({
        collectionStatus: "failed",
        name: "foo",
        integrity: null,
      });
    }
  });

  it("accepts a failed-unsupported entry keyed by packageKey", () => {
    const r = parseMetadataCache(metadataDoc([failedUnsupported()]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cache.entries[0]).toMatchObject({
        collectionStatus: "failed",
        packageKey: "foo@1.0.0",
        retrievalSource: null,
      });
    }
  });
});

describe("parseMetadataCache — collected cross-field invariants", () => {
  it("requires tarballIntegrity to equal integrity", () => {
    expect(
      metadataErrors(metadataDoc([collected({ tarballIntegrity: "sha512-different" })])),
    ).toContain("METADATA_ENTRY_MALFORMED");
  });

  it("requires normalizedSpdx to equal normalizeSpdx(rawLicense)", () => {
    expect(
      metadataErrors(metadataDoc([collected({ rawLicense: "MIT", normalizedSpdx: "Apache-2.0" })])),
    ).toContain("METADATA_ENTRY_MALFORMED");
    expect(
      metadataErrors(
        metadataDoc([collected({ rawLicense: "MIT OR Apache-2.0", normalizedSpdx: "MIT" })]),
      ),
    ).toContain("METADATA_ENTRY_MALFORMED");
  });

  it("requires rawLicense to be null when not present", () => {
    expect(
      metadataErrors(metadataDoc([collected({ rawLicensePresent: false, rawLicense: "MIT" })])),
    ).toContain("METADATA_ENTRY_MALFORMED");
  });

  it("requires collectionReason null, fixed licenseMetadataSource, and a valid retrievalSource", () => {
    expect(metadataErrors(metadataDoc([collected({ collectionReason: "x" })]))).toContain(
      "METADATA_ENTRY_MALFORMED",
    );
    expect(
      metadataErrors(metadataDoc([collected({ licenseMetadataSource: "registry" })])),
    ).toContain("METADATA_ENTRY_MALFORMED");
    expect(metadataErrors(metadataDoc([collected({ retrievalSource: "npm" })]))).toContain(
      "METADATA_ENTRY_MALFORMED",
    );
  });
});

describe("parseMetadataCache — packagedLegalFiles validation", () => {
  it("rejects non-array, unsafe, and duplicate legal-file paths", () => {
    expect(metadataErrors(metadataDoc([collected({ packagedLegalFiles: "LICENSE" })]))).toContain(
      "METADATA_ENTRY_MALFORMED",
    );
    for (const bad of ["../evil", "/abs", "a/../b", `a${BS}b`, "C:/x", ".", "sub/"]) {
      expect(metadataErrors(metadataDoc([collected({ packagedLegalFiles: [bad] })]))).toContain(
        "METADATA_ENTRY_MALFORMED",
      );
    }
    expect(
      metadataErrors(metadataDoc([collected({ packagedLegalFiles: ["LICENSE", "LICENSE"] })])),
    ).toContain("METADATA_ENTRY_MALFORMED");
  });

  it("accepts nested POSIX legal-file paths and sorts them", () => {
    const r = parseMetadataCache(
      metadataDoc([collected({ packagedLegalFiles: ["licenses/B.txt", "LICENSE"] })]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cache.entries[0]).toMatchObject({
        packagedLegalFiles: ["LICENSE", "licenses/B.txt"],
      });
    }
  });
});

describe("parseMetadataCache — structure, routing, and limits", () => {
  it("rejects a non-object cache and non-array entries", () => {
    expect(metadataErrors(null)).toContain("METADATA_MALFORMED");
    expect(metadataErrors({ schemaVersion: 1, entries: {} })).toContain("METADATA_MALFORMED");
  });

  it("rejects unknown fields, unsupported schema version, and invalid collectionStatus", () => {
    expect(metadataErrors({ schemaVersion: 1, entries: [], extra: 1 })).toContain(
      "METADATA_UNKNOWN_FIELD",
    );
    expect(metadataErrors({ schemaVersion: 2, entries: [] })).toContain(
      "METADATA_UNSUPPORTED_SCHEMA_VERSION",
    );
    expect(metadataErrors(metadataDoc([{ collectionStatus: "partial" }]))).toContain(
      "METADATA_ENTRY_MALFORMED",
    );
  });

  it("routes a failed entry to the unsupported shape only when packageKey is present", () => {
    expect(metadataErrors(metadataDoc([{ ...failedUnsupported(), name: "foo" }]))).toContain(
      "METADATA_ENTRY_UNKNOWN_FIELD",
    );
    expect(
      metadataErrors(metadataDoc([failedUnsupported({ retrievalSource: "registry-tarball" })])),
    ).toContain("METADATA_ENTRY_MALFORMED");
  });

  it("enforces the metadata entry-count limit", () => {
    expect(
      metadataErrors(metadataDoc([failedRegistry(), failedRegistry({ name: "bar" })]), {
        maxMetadataEntries: 1,
      }),
    ).toContain("METADATA_LIMIT_ENTRIES_EXCEEDED");
  });

  it("enforces schema limits, legal-file bounds, and rawLicense JSON depth", () => {
    expect(metadataErrors(metadataDoc([]), { maxJsonNodes: -1 })).toContain(
      "SCHEMA_LIMITS_INVALID",
    );
    expect(
      metadataErrors(metadataDoc([collected({ packagedLegalFiles: ["a", "b", "c"] })]), {
        maxLegalFilesPerEntry: 2,
      }),
    ).toContain("METADATA_LIMIT_LEGAL_FILES_EXCEEDED");
    expect(
      metadataErrors(
        metadataDoc([collected({ rawLicense: { a: { b: { c: 1 } } }, normalizedSpdx: null })]),
        { maxJsonDepth: 2 },
      ),
    ).toContain("METADATA_LIMIT_JSON_DEPTH_EXCEEDED");
  });
});
