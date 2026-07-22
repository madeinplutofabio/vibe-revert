// packages/cli/test/license-render.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Boundary tests for the deterministic Markdown renderer (scripts/license-audit-render.ts):
// section structure and trailing newline; empty-model "None." placeholders; clean rows
// appearing in the table but not the detail section; conflict/review-required/disallowed
// rows routed to Details with "(conflict — see detail)" table placeholders; the
// injection-safety contract (C0/DEL/non-ASCII and table `|` escaped to \uXXXX inside a
// variable-length backtick fence, no raw control byte in the output, and no Markdown
// heading injection through dynamic detail identifiers — newline escaped, `#` inert
// inside a code span); the absent-vs-null license distinction; and output independent of
// input array order at both the top level and inside nested row arrays. The single
// backslash and expected \uXXXX text are built from code points to avoid tooling-
// transport escape decoding.

import { describe, expect, it } from "vitest";

import type {
  AuditModel,
  IdentityMetadata,
  ReportRow,
  UnresolvedPeerRoot,
} from "../../../scripts/license-audit-core.js";
import { renderAuditModel } from "../../../scripts/license-audit-render.js";

const BS = String.fromCharCode(0x5c); // one backslash, transport-safe

function variant(overrides: Partial<IdentityMetadata> = {}): IdentityMetadata {
  return {
    packageKey: "foo@1.0.0",
    integrity: "sha512-abc",
    rawLicensePresent: true,
    rawLicense: "MIT",
    normalizedSpdx: "MIT",
    licenseMetadataSource: "packaged-package-json",
    packagedLegalFiles: ["LICENSE"],
    policyDisposition: "allowed",
    obligations: [],
    ...overrides,
  };
}

function row(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    name: "foo",
    version: "1.0.0",
    primaryPosture: "production",
    reachingPostures: ["production"],
    packageKeys: ["foo@1.0.0"],
    snapshotKeys: ["foo@1.0.0"],
    integrities: ["sha512-abc"],
    policyDisposition: "allowed",
    metadataConflict: false,
    metadataConflictReasons: [],
    aggregate: {
      rawLicensePresent: true,
      rawLicense: "MIT",
      normalizedSpdx: "MIT",
      licenseMetadataSource: "packaged-package-json",
      packagedLegalFiles: ["LICENSE"],
      obligations: [],
    },
    variants: [variant()],
    provenance: { shortestPaths: [], directParents: [], originatingImporters: [] },
    ...overrides,
  };
}

function reversedRow(r: ReportRow): ReportRow {
  return {
    ...r,
    reachingPostures: [...r.reachingPostures].reverse(),
    packageKeys: [...r.packageKeys].reverse(),
    snapshotKeys: [...r.snapshotKeys].reverse(),
    integrities: [...r.integrities].reverse(),
    metadataConflictReasons: [...r.metadataConflictReasons].reverse(),
    aggregate:
      r.aggregate === null
        ? null
        : {
            ...r.aggregate,
            packagedLegalFiles: [...r.aggregate.packagedLegalFiles].reverse(),
            obligations: [...r.aggregate.obligations].reverse(),
          },
    variants: [...r.variants].reverse().map((v) => ({
      ...v,
      obligations: [...v.obligations].reverse(),
      packagedLegalFiles: [...v.packagedLegalFiles].reverse(),
    })),
    provenance: {
      directParents: [...r.provenance.directParents].reverse(),
      originatingImporters: [...r.provenance.originatingImporters].reverse(),
      shortestPaths: [...r.provenance.shortestPaths].reverse(),
    },
  };
}

function peer(name: string): UnresolvedPeerRoot {
  return { kind: "unresolved-peer", importerPath: ".", name, declaredSpec: "^1" };
}

function model(overrides: Partial<AuditModel> = {}): AuditModel {
  return {
    generatorSchemaVersion: 1,
    hashes: {
      lockfileSha256: "a".repeat(64),
      manifestsSha256: "b".repeat(64),
      policySha256: "c".repeat(64),
      metadataSha256: "d".repeat(64),
    },
    reachableSnapshotInstanceCount: 0,
    aggregatedPackageRowCount: 0,
    rows: [],
    firstParty: [],
    unresolvedPeers: [],
    ...overrides,
  };
}

describe("renderAuditModel — structure", () => {
  it("renders all sections and ends with a trailing newline", () => {
    const md = renderAuditModel(model());
    expect(md.startsWith("# License Audit\n")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
    expect(md).toContain("do not edit by hand");
    for (const heading of [
      "## Inputs",
      "## Summary",
      "## Third-party packages",
      "## Details",
      "## First-party workspace packages",
      "## Unresolved peer obligations",
      "## Disclaimer",
    ]) {
      expect(md).toContain(heading);
    }
  });

  it("renders empty sections as None placeholders", () => {
    const md = renderAuditModel(model());
    expect(md).toContain("| None. | | | | | | |");
    expect(md).toContain("## First-party workspace packages\n\nNone.");
    expect(md).toContain("## Unresolved peer obligations\n\nNone.");
    expect(md).toContain("## Details (conflict, review-required, or disallowed)\n\nNone.");
  });
});

describe("renderAuditModel — rows and details routing", () => {
  it("renders a clean allowed row in the table but not in the detail section", () => {
    const md = renderAuditModel(model({ rows: [row()], aggregatedPackageRowCount: 1 }));
    expect(md).toContain("`foo`");
    expect(md).toContain("`production`");
    expect(md).toContain("`allowed`");
    expect(md).toContain("## Details (conflict, review-required, or disallowed)\n\nNone.");
  });

  it("routes a conflict row to Details with table placeholders", () => {
    const conflict = row({
      name: "bar",
      policyDisposition: "review-required",
      metadataConflict: true,
      metadataConflictReasons: ["normalized-spdx"],
      aggregate: null,
      variants: [
        variant({ packageKey: "bar@1.0.0" }),
        variant({ packageKey: "bar@1.0.0_peer", normalizedSpdx: "Apache-2.0" }),
      ],
    });
    const md = renderAuditModel(model({ rows: [conflict], aggregatedPackageRowCount: 1 }));
    expect(md).toContain("(conflict — see detail)");
    expect(md).toContain("### `bar@1.0.0`");
    expect(md).toContain("Conflict reasons:");
  });

  it("distinguishes an absent license field from a null value in the detail", () => {
    const absent = row({
      name: "nolic",
      policyDisposition: "review-required",
      aggregate: {
        rawLicensePresent: false,
        rawLicense: null,
        normalizedSpdx: null,
        licenseMetadataSource: "packaged-package-json",
        packagedLegalFiles: [],
        obligations: [],
      },
      variants: [
        variant({
          packageKey: "nolic@1.0.0",
          rawLicensePresent: false,
          rawLicense: null,
          normalizedSpdx: null,
          policyDisposition: "review-required",
        }),
      ],
    });
    const md = renderAuditModel(model({ rows: [absent], aggregatedPackageRowCount: 1 }));
    expect(md).toContain("(license field absent)");
  });
});

describe("renderAuditModel — injection safety", () => {
  it("escapes pipes, control characters, DEL, and non-ASCII, leaking no raw control byte", () => {
    const evil = `a|b${String.fromCharCode(0)}c${String.fromCharCode(0x7f)}d${String.fromCharCode(0xe9)}`;
    const md = renderAuditModel(
      model({ rows: [row({ name: evil })], aggregatedPackageRowCount: 1 }),
    );
    expect(md).toContain(`${BS}u007c`); // |
    expect(md).toContain(`${BS}u0000`); // NUL
    expect(md).toContain(`${BS}u007f`); // DEL
    expect(md).toContain(`${BS}u00e9`); // é
    expect(md).not.toContain(String.fromCharCode(0)); // no raw NUL
    expect(md).not.toContain(String.fromCharCode(0x7f)); // no raw DEL
  });

  it("widens the backtick fence past the longest backtick run in a value", () => {
    const md = renderAuditModel(
      model({ rows: [row({ version: "x``y" })], aggregatedPackageRowCount: 1 }),
    );
    expect(md).toContain("```x``y```"); // run of 2 -> fence of 3
  });

  it("prevents Markdown heading injection through dynamic detail identifiers", () => {
    const hostile = `pkg${String.fromCharCode(10)}#x` + "``y"; // newline + '#' + backtick run
    const detailRow = row({
      name: hostile,
      policyDisposition: "review-required",
      variants: [variant({ packageKey: `${hostile}@1.0.0`, policyDisposition: "review-required" })],
    });
    const md = renderAuditModel(model({ rows: [detailRow], aggregatedPackageRowCount: 1 }));
    expect(md).toContain(`${BS}u000a`); // newline escaped
    expect(md).not.toContain(`${String.fromCharCode(10)}#x`); // value cannot start a new heading line
    expect(md).toContain("### ```"); // heading identifier's fence widened past the backtick run
  });
});

describe("renderAuditModel — determinism", () => {
  it("produces identical output regardless of top-level input array order", () => {
    const a = row({ name: "aaa" });
    const b = row({ name: "bbb", version: "2.0.0" });
    const m1 = model({
      rows: [a, b],
      aggregatedPackageRowCount: 2,
      firstParty: ["z-pkg", "a-pkg"],
      unresolvedPeers: [peer("z"), peer("a")],
    });
    const m2 = model({
      rows: [b, a],
      aggregatedPackageRowCount: 2,
      firstParty: ["a-pkg", "z-pkg"],
      unresolvedPeers: [peer("a"), peer("z")],
    });
    expect(renderAuditModel(m1)).toBe(renderAuditModel(m2));
  });

  it("sorts nested row arrays, so output does not depend on their input order", () => {
    const rich = row({
      name: "multi",
      policyDisposition: "review-required",
      reachingPostures: ["production", "development"],
      aggregate: {
        rawLicensePresent: true,
        rawLicense: "MIT",
        normalizedSpdx: "MIT",
        licenseMetadataSource: "packaged-package-json",
        packagedLegalFiles: ["Z.txt", "A.txt"],
        obligations: ["z-ob", "a-ob"],
      },
      variants: [
        variant({
          packageKey: "multi@2.0.0",
          integrity: "sha512-b",
          obligations: ["z-ob", "a-ob"],
          packagedLegalFiles: ["Z.txt", "A.txt"],
          policyDisposition: "review-required",
        }),
        variant({
          packageKey: "multi@1.0.0",
          integrity: "sha512-a",
          policyDisposition: "review-required",
        }),
      ],
      provenance: {
        directParents: ["z-parent", "a-parent"],
        originatingImporters: ["z-imp", "a-imp"],
        shortestPaths: [
          {
            posture: "production",
            path: { importerPath: "app", rootDependency: "multi", snapshotKeys: ["multi@1.0.0"] },
          },
          {
            posture: "development",
            path: { importerPath: "tool", rootDependency: "multi", snapshotKeys: ["multi@2.0.0"] },
          },
        ],
      },
    });
    expect(renderAuditModel(model({ rows: [rich], aggregatedPackageRowCount: 1 }))).toBe(
      renderAuditModel(model({ rows: [reversedRow(rich)], aggregatedPackageRowCount: 1 })),
    );
  });
});
