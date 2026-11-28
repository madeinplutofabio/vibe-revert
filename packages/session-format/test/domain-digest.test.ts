// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.9.0 step 0A: fixed vectors for the domain-separated digest construction.
//
// These vectors exist because 0.9.0 authority digests are read by 1.0.0, which
// freezes the compatibility contract. A construction that drifts between those
// two releases means 1.0.0 must reinterpret historical 0.9.0 records. The
// vectors below make any drift a test failure instead.
//
// The strongest evidence that the extraction preserved behaviour is NOT in this
// file: `contribution.test.ts` and `finding-identity.test.ts` already pin real
// `cg_` and `fnd_` values from 0.8.0, and those passed unchanged when both
// derivations were routed through this primitive. This file pins the primitive's
// own properties.

import { describe, expect, it } from "vitest";
import { deriveChangeGroupId } from "../src/contribution.js";
import {
  CHANGE_GROUP_DOMAIN,
  digestDomainTag,
  domainSeparatedDigest,
  FINDING_DOMAIN,
} from "../src/domain-digest.js";
import { deriveFindingId } from "../src/finding-identity.js";

const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPORT = "rpt_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("digestDomainTag", () => {
  it("reproduces the two shipped 0.8.0 literals exactly", () => {
    // These two strings were hashed by name in 0.8.0. If the tag format ever
    // changed, every change-group id and every finding id in every existing
    // session would change with it.
    expect(digestDomainTag(CHANGE_GROUP_DOMAIN)).toBe("viberevert-change-group-v1");
    expect(digestDomainTag(FINDING_DOMAIN)).toBe("viberevert-finding-v1");
  });
});

describe("domainSeparatedDigest: fixed vectors", () => {
  // Written down rather than computed in the assertion. A test that recomputes
  // the value it checks proves only that the function is deterministic.
  it("V1: one part under the change-group domain", () => {
    expect(domainSeparatedDigest(CHANGE_GROUP_DOMAIN, ["a"])).toBe(
      "58435a30e0a5c4d92590a9973d61ef52c79062a8fd35717398471eaff360a04c",
    );
  });

  it("V2: the empty part list still digests the domain tag alone", () => {
    expect(domainSeparatedDigest(CHANGE_GROUP_DOMAIN, [])).toBe(
      "076abac87cdd471c4e750706a586014e95c83e9eb8483b1338f4ce11ae53be6a",
    );
  });
});

describe("domain separation", () => {
  it("the same parts under different domains give different digests", () => {
    // The property the domain exists for: a digest computed for one role must
    // not be replayable in another.
    const asGroup = domainSeparatedDigest(CHANGE_GROUP_DOMAIN, ["x", "y"]);
    const asFinding = domainSeparatedDigest(FINDING_DOMAIN, ["x", "y"]);
    expect(asGroup).not.toBe(asFinding);
  });

  it("the same parts under different VERSIONS give different digests", () => {
    // Bumping a construction version must not produce values that look like the
    // old ones, or a migration could not tell them apart.
    const v1 = domainSeparatedDigest({ domain: "scope", version: 1 }, ["x"]);
    const v2 = domainSeparatedDigest({ domain: "scope", version: 2 }, ["x"]);
    expect(v1).not.toBe(v2);
  });

  it("a domain name is not a prefix a consumer can strip", () => {
    // The tag is hashed input, so the output carries no recoverable trace of it.
    const digest = domainSeparatedDigest(CHANGE_GROUP_DOMAIN, ["x"]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("change-group");
  });
});

describe("part boundaries are unambiguous", () => {
  it("re-splitting the same characters changes the digest", () => {
    // Plain concatenation would make these identical, which is the collision the
    // NUL separator exists to prevent. This is the one property most likely to
    // be lost by a well-meaning refactor toward string joining.
    expect(domainSeparatedDigest(FINDING_DOMAIN, ["ab", "c"])).not.toBe(
      domainSeparatedDigest(FINDING_DOMAIN, ["a", "bc"]),
    );
  });

  it("part order is significant", () => {
    expect(domainSeparatedDigest(FINDING_DOMAIN, ["a", "b"])).not.toBe(
      domainSeparatedDigest(FINDING_DOMAIN, ["b", "a"]),
    );
  });

  it("an empty part is distinct from an absent one", () => {
    expect(domainSeparatedDigest(FINDING_DOMAIN, ["a", ""])).not.toBe(
      domainSeparatedDigest(FINDING_DOMAIN, ["a"]),
    );
  });

  it("does not canonicalize for the caller", () => {
    // Documented refusal, not an oversight. Sorting silently would make an
    // ORDERED input unhashable, so a caller whose input is a set canonicalizes
    // first, exactly as both shipped derivations do via normalizePathArray.
    expect(domainSeparatedDigest(FINDING_DOMAIN, ["b", "a"])).not.toBe(
      domainSeparatedDigest(FINDING_DOMAIN, ["a", "b"]),
    );
  });
});

describe("the shipped derivations are built on this primitive", () => {
  it("deriveChangeGroupId is the primitive plus its id prefix", () => {
    // Stated as an equation so the extraction cannot quietly diverge: if either
    // side changes, this fails even when both are internally consistent.
    const expected = domainSeparatedDigest(CHANGE_GROUP_DOMAIN, [
      SESSION,
      JSON.stringify(["src/foo.ts"]),
    ]);
    expect(deriveChangeGroupId(SESSION, ["src/foo.ts"])).toBe(`cg_${expected}`);
  });

  it("deriveFindingId is the primitive plus its id prefix", () => {
    const expected = domainSeparatedDigest(FINDING_DOMAIN, [
      REPORT,
      "secrets.hardcoded",
      JSON.stringify(["src/foo.ts"]),
    ]);
    expect(deriveFindingId(REPORT, "secrets.hardcoded", ["src/foo.ts"])).toBe(`fnd_${expected}`);
  });
});
