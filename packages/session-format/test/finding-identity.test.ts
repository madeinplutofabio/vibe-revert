// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.8.0 step 0 -- finding identity.
//
// Same treatment as the change-group vectors: the literals below were produced
// by an INDEPENDENT implementation of the documented payload spec, not by
// calling the function under test, and `derivePerSpec` re-implements that spec
// a second time. A round-trip assertion would stay green if the algorithm
// changed, because both sides would change together.
//
// The report-level block matters as much as the vectors. `deriveFindingId`
// exists so `SessionReportSchema` can verify that a persisted `finding_id`
// actually belongs to its rule and path set: without that, the derivation would
// be normative only by convention, and `--finding` acts on the persisted value.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type ChangedFile,
  type CheckResult,
  deriveFindingId,
  FindingIdSchema,
  SCHEMA_VERSION,
  SessionReportSchema,
} from "../src/index.js";

// =============================================================================
// Fixtures
// =============================================================================

const REPORT_SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPORT_AD_HOC = "rpt_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const RULE_A = "dependencies.install-script";
const RULE_B = "secrets.aws-key";
const WHEN = "2026-01-01T00:00:00Z";

/** A single backslash, built without a backslash literal in a regex context. */
const BACKSLASH = String.fromCharCode(92);

/**
 * Non-ASCII vector path, with its code points asserted separately so a
 * re-encoding of this file fails loudly instead of silently drifting the digest.
 */
const NON_ASCII_PATH = "src/café/naïve.ts";

function changedFile(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    status: "modified",
    risk_tags: [],
    risk_level: "low",
    ...overrides,
  } as ChangedFile;
}

function finding(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: RULE_A,
    title: "Install script added",
    level: "medium",
    confidence: "high",
    category: "dependencies",
    message: "a dependency added an install script",
    evidence: [{ detail: "postinstall present" }],
    ...overrides,
  } as CheckResult;
}

function report(results: CheckResult[], changedFiles: ChangedFile[]) {
  return {
    schema_version: SCHEMA_VERSION,
    session_id: REPORT_SESSION,
    started_at: WHEN,
    detected_frameworks: [],
    risk_level: "low" as const,
    changed_files: changedFiles,
    results,
    rollback_available: true,
  };
}

// =============================================================================
// Golden vectors
// =============================================================================

describe("deriveFindingId golden vectors", () => {
  it("F1: single path", () => {
    expect(deriveFindingId(REPORT_SESSION, RULE_A, ["src/foo.ts"])).toBe(
      "fnd_71e9bb6a1e2929a815dfbfe3639b3faf137051f694cb038f4a6aafed216d4655",
    );
  });

  it("F2: path order does not affect the id", () => {
    const expected = "fnd_147072385070c886bbb424d9ef7710d5ee3036ce78d0e302cb20f54134271e81";
    expect(deriveFindingId(REPORT_SESSION, RULE_A, ["b/second.ts", "a/first.ts"])).toBe(expected);
    expect(deriveFindingId(REPORT_SESSION, RULE_A, ["a/first.ts", "b/second.ts"])).toBe(expected);
  });

  it("F3: duplicates and Windows separators canonicalize to the F1 id", () => {
    expect(
      deriveFindingId(REPORT_SESSION, RULE_A, [
        `src${BACKSLASH}foo.ts`,
        "src/foo.ts",
        "./src/foo.ts",
      ]),
    ).toBe("fnd_71e9bb6a1e2929a815dfbfe3639b3faf137051f694cb038f4a6aafed216d4655");
  });

  it("F4: a different report yields a different id", () => {
    expect(deriveFindingId(REPORT_AD_HOC, RULE_A, ["src/foo.ts"])).toBe(
      "fnd_ce456c5c34d830c3269a5bc91f0fd5855218bc94cdd2bb1171a70c0be61cffab",
    );
    expect(deriveFindingId(REPORT_AD_HOC, RULE_A, ["src/foo.ts"])).not.toBe(
      deriveFindingId(REPORT_SESSION, RULE_A, ["src/foo.ts"]),
    );
  });

  it("F5: a different rule yields a different id", () => {
    expect(deriveFindingId(REPORT_SESSION, RULE_B, ["src/foo.ts"])).toBe(
      "fnd_09357e620cb0c000eb9d5fe50cb211c9249a4ae5d8a6b19d3f7b986046d00409",
    );
    expect(deriveFindingId(REPORT_SESSION, RULE_B, ["src/foo.ts"])).not.toBe(
      deriveFindingId(REPORT_SESSION, RULE_A, ["src/foo.ts"]),
    );
  });

  it("F6: non-ASCII path", () => {
    expect([...NON_ASCII_PATH].map((c) => c.codePointAt(0))).toEqual([
      115, 114, 99, 47, 99, 97, 102, 0xe9, 47, 110, 97, 0xef, 118, 101, 46, 116, 115,
    ]);
    expect(deriveFindingId(REPORT_SESSION, RULE_A, [NON_ASCII_PATH])).toBe(
      "fnd_344b39d59a4f45793c2819dbf96de39878f25f72442f80f230f86fa6bc535c2c",
    );
  });

  it("F7: an empty path set still has an identity", () => {
    // Unlike a change group, an advisory finding legitimately affects no
    // changed path. It gets an id, and is simply non-selectable.
    expect(deriveFindingId(REPORT_SESSION, RULE_A, [])).toBe(
      "fnd_03a43724f0811fbfdf156e393723cd4585e2fd8928b28d226c94f7615340f69e",
    );
  });

  it("refuses a blank report id", () => {
    expect(() => deriveFindingId("   ", RULE_A, ["src/foo.ts"])).toThrow(/reportId/);
  });

  it("refuses a blank rule id", () => {
    expect(() => deriveFindingId(REPORT_SESSION, "  ", ["src/foo.ts"])).toThrow(/ruleId/);
  });

  it("throws on an un-canonicalizable path rather than hashing it", () => {
    expect(() => deriveFindingId(REPORT_SESSION, RULE_A, ["../escape.ts"])).toThrow();
  });
});

// =============================================================================
// Independent spec cross-check
// =============================================================================

describe("deriveFindingId matches an independent implementation of the spec", () => {
  /**
   * Second implementation of the documented payload, written from the spec text
   * rather than the source: SHA-256 over "viberevert-finding-v1" + NUL +
   * report_id + NUL + rule_id + NUL + JSON.stringify(sorted unique canonical
   * paths), prefixed "fnd_".
   */
  function derivePerSpec(
    reportId: string,
    ruleId: string,
    affectedPaths: readonly string[],
  ): string {
    const canonical = Array.from(
      new Set(
        affectedPaths.map((p) => {
          let s = p.split(BACKSLASH).join("/");
          while (s.startsWith("./")) s = s.slice(2);
          return s.replace(/\/+/g, "/");
        }),
      ),
    ).sort();
    const hash = createHash("sha256");
    hash.update("viberevert-finding-v1", "utf8");
    hash.update(Uint8Array.from([0]));
    hash.update(reportId, "utf8");
    hash.update(Uint8Array.from([0]));
    hash.update(ruleId, "utf8");
    hash.update(Uint8Array.from([0]));
    hash.update(JSON.stringify(canonical), "utf8");
    return `fnd_${hash.digest("hex")}`;
  }

  const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    [REPORT_SESSION, RULE_A, ["src/foo.ts"]],
    [REPORT_SESSION, RULE_A, ["b/second.ts", "a/first.ts"]],
    [REPORT_SESSION, RULE_A, [`src${BACKSLASH}foo.ts`, "./src/foo.ts"]],
    [REPORT_AD_HOC, RULE_A, ["src/foo.ts"]],
    [REPORT_SESSION, RULE_B, ["src/foo.ts"]],
    [REPORT_SESSION, RULE_A, [NON_ASCII_PATH]],
    [REPORT_SESSION, RULE_A, []],
  ];

  it.each(cases)("report %s, rule %s, paths %j", (reportId, ruleId, paths) => {
    expect(deriveFindingId(reportId, ruleId, paths)).toBe(derivePerSpec(reportId, ruleId, paths));
  });
});

// =============================================================================
// Shape validator
// =============================================================================

describe("FindingIdSchema", () => {
  it("accepts a derived id", () => {
    expect(FindingIdSchema.safeParse(deriveFindingId(REPORT_SESSION, RULE_A, [])).success).toBe(
      true,
    );
  });

  it("rejects a wrong prefix", () => {
    expect(FindingIdSchema.safeParse(`cg_${"a".repeat(64)}`).success).toBe(false);
  });

  it("rejects a wrong width", () => {
    expect(FindingIdSchema.safeParse(`fnd_${"a".repeat(63)}`).success).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(FindingIdSchema.safeParse(`fnd_${"A".repeat(64)}`).success).toBe(false);
  });
});

// =============================================================================
// Report-level enforcement
//
// This is the point of the derivation: a persisted finding_id must actually
// belong to its rule and path set, and affected_paths must name real changed
// files. Without these, `--finding` could resolve to change groups the report
// never claimed.
// =============================================================================

describe("SessionReport enforces finding identity", () => {
  const paths = ["src/foo.ts"];
  const good = finding({
    affected_paths: paths,
    finding_id: deriveFindingId(REPORT_SESSION, RULE_A, paths),
  });

  it("accepts a correctly derived finding", () => {
    expect(SessionReportSchema.safeParse(report([good], [changedFile("src/foo.ts")])).success).toBe(
      true,
    );
  });

  it("accepts a legacy finding carrying neither field", () => {
    expect(
      SessionReportSchema.safeParse(report([finding()], [changedFile("src/foo.ts")])).success,
    ).toBe(true);
  });

  it("rejects a half-populated finding", () => {
    const half = finding({ finding_id: deriveFindingId(REPORT_SESSION, RULE_A, paths) });
    expect(SessionReportSchema.safeParse(report([half], [changedFile("src/foo.ts")])).success).toBe(
      false,
    );
  });

  it("rejects a syntactically valid but underived finding_id", () => {
    const wrong = finding({ affected_paths: paths, finding_id: `fnd_${"0".repeat(64)}` });
    expect(
      SessionReportSchema.safeParse(report([wrong], [changedFile("src/foo.ts")])).success,
    ).toBe(false);
  });

  it("rejects an id derived against a different report identity", () => {
    const wrong = finding({
      affected_paths: paths,
      finding_id: deriveFindingId(REPORT_AD_HOC, RULE_A, paths),
    });
    expect(
      SessionReportSchema.safeParse(report([wrong], [changedFile("src/foo.ts")])).success,
    ).toBe(false);
  });

  it("rejects an id derived against a different rule", () => {
    const wrong = finding({
      affected_paths: paths,
      finding_id: deriveFindingId(REPORT_SESSION, RULE_B, paths),
    });
    expect(
      SessionReportSchema.safeParse(report([wrong], [changedFile("src/foo.ts")])).success,
    ).toBe(false);
  });

  it("rejects affected_paths naming a file the report never changed", () => {
    const stray = ["production/database.sql"];
    const wrong = finding({
      affected_paths: stray,
      finding_id: deriveFindingId(REPORT_SESSION, RULE_A, stray),
    });
    expect(
      SessionReportSchema.safeParse(report([wrong], [changedFile("src/foo.ts")])).success,
    ).toBe(false);
  });

  it("rejects affected_paths naming a rename's PREVIOUS path", () => {
    // The locked rule: a classifier may match the old alias, but the machine
    // identity is the NEW path, because that is what a contribution group is
    // addressed by. Only changed_files[].path counts.
    const renamed = changedFile("utils/webhook.ts", {
      status: "renamed",
      previous_path: "payments/webhook.ts",
    });
    const oldAlias = ["payments/webhook.ts"];
    const wrong = finding({
      affected_paths: oldAlias,
      finding_id: deriveFindingId(REPORT_SESSION, RULE_A, oldAlias),
    });
    expect(SessionReportSchema.safeParse(report([wrong], [renamed])).success).toBe(false);
  });

  it("accepts a rename addressed by its new path", () => {
    const renamed = changedFile("utils/webhook.ts", {
      status: "renamed",
      previous_path: "payments/webhook.ts",
    });
    const newPath = ["utils/webhook.ts"];
    const ok = finding({
      affected_paths: newPath,
      finding_id: deriveFindingId(REPORT_SESSION, RULE_A, newPath),
    });
    expect(SessionReportSchema.safeParse(report([ok], [renamed])).success).toBe(true);
  });

  it("rejects two findings sharing one id", () => {
    // Same rule over the same paths derives the same id, so both pass the
    // derivation check and only uniqueness catches it. That is the engine-bug
    // case: these two should have been clustered into one finding.
    const twin = { ...good, title: "A different title for the same finding" };
    expect(
      SessionReportSchema.safeParse(report([good, twin], [changedFile("src/foo.ts")])).success,
    ).toBe(false);
  });

  it("accepts an advisory finding with an empty affected_paths", () => {
    const advisory = finding({
      id: "test-gap.missing",
      category: "test-gap",
      affected_paths: [],
      finding_id: deriveFindingId(REPORT_SESSION, "test-gap.missing", []),
    });
    expect(
      SessionReportSchema.safeParse(report([advisory], [changedFile("src/foo.ts")])).success,
    ).toBe(true);
  });
});
