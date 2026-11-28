// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.9.0 step 0A: the decision vocabulary, and the structural guard that keeps
// roadmap principle 12 from being merely advisory.

import { describe, expect, it } from "vitest";

import {
  EnforcementEffectSchema,
  PolicyDecisionSchema,
  PROHIBITED_EFFECT_TERMS,
  ResolvedRuleProvenanceSchema,
  RuleLayerSchema,
  RuleOriginSchema,
} from "../src/policy-decision.js";

describe("the decision enum", () => {
  it("is exactly the four locked members, in ascending strictness", () => {
    // Order is part of the contract, not incidental: a reader compares severity
    // by position rather than keeping a second table in sync.
    expect(PolicyDecisionSchema.options).toEqual(["ALLOW", "WARN", "REQUIRE_APPROVAL", "DENY"]);
  });

  it("rejects anything else, including lowercase", () => {
    expect(PolicyDecisionSchema.safeParse("deny").success).toBe(false);
    expect(PolicyDecisionSchema.safeParse("BLOCK").success).toBe(false);
  });
});

describe("the enforcement effect is a separate axis", () => {
  it("carries only effects a 0.9.0 surface can actually deliver", () => {
    expect(EnforcementEffectSchema.options).toEqual([
      "detected_after_write",
      "refused_at_next_boundary",
    ]);
  });

  it("has NO member asserting the write was prevented", () => {
    // The point of principle 12, made structural. No 0.9.0 surface gates a write
    // before it happens, so there is no value a renderer could pick to say
    // "blocked". 0.10.0 owns pre-write enforcement and brings its own member.
    //
    // This is the guard that catches a future member added by name before a
    // surface exists to produce it. It fails loudly rather than letting a
    // DENY/detected_after_write pair be printed as prevention.
    for (const effect of EnforcementEffectSchema.options) {
      for (const term of PROHIBITED_EFFECT_TERMS) {
        expect(effect).not.toContain(term);
      }
    }
  });

  it("DENY and the effect are independent values, not a derived pair", () => {
    // Both parse on their own. If the effect were derivable from the decision it
    // would not need to exist, and the first consumer to derive it wrongly would
    // claim prevention about a write that already landed.
    expect(PolicyDecisionSchema.parse("DENY")).toBe("DENY");
    expect(EnforcementEffectSchema.parse("detected_after_write")).toBe("detected_after_write");
  });

  it("does not fix which pairings are valid", () => {
    // Deliberately open. Which decision-and-effect combinations are reachable
    // depends on the surfaces built in steps 7 through 9, and a matrix locked
    // now would constrain code nothing has exercised. The exact-coverage test
    // over valid combinations is listed in the plan's test matrix and lands with
    // those steps.
    expect(PolicyDecisionSchema.options.length * EnforcementEffectSchema.options.length).toBe(8);
  });
});

describe("rule provenance is resolver-owned", () => {
  it("origin and layer each have exactly one member in 0.9.0", () => {
    // Single-valued on purpose: 0.9.0 has no policy inheritance. Widening a
    // resolver-owned enum later is backward compatible precisely because no user
    // input ever populated it.
    expect(RuleOriginSchema.options).toEqual(["local_project"]);
    expect(RuleLayerSchema.options).toEqual(["project"]);
  });

  it("origin and layer are separate axes, not one collapsed field", () => {
    // Inheritance later varies them independently: an organization layer and a
    // project layer can share an origin, and one layer can merge several
    // origins. Collapsing them now would force a format change to separate them.
    expect(RuleOriginSchema.options).not.toEqual(RuleLayerSchema.options);
  });

  it("accepts a complete provenance record", () => {
    expect(
      ResolvedRuleProvenanceSchema.safeParse({
        rule_id: "protect-workflows",
        origin: "local_project",
        layer: "project",
        priority: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown key, which is what stops input from spoofing origin", () => {
    // The strict object is the mechanism: a rule object that tries to set its
    // own origin is refused like any unknown key, and the resolver attaches the
    // real value on the way out. An earlier draft proposed a user-settable
    // reserved field that 0.9.0 would ignore, which accepts input, does nothing
    // with it, and teaches a meaning that later changes.
    expect(
      ResolvedRuleProvenanceSchema.safeParse({
        rule_id: "protect-workflows",
        origin: "local_project",
        layer: "project",
        priority: 0,
        inherited_from: "org",
      }).success,
    ).toBe(false);
  });

  it("requires a non-blank rule id and a non-negative priority", () => {
    const base = { origin: "local_project", layer: "project", priority: 0 };
    expect(ResolvedRuleProvenanceSchema.safeParse({ ...base, rule_id: "  " }).success).toBe(false);
    expect(
      ResolvedRuleProvenanceSchema.safeParse({ ...base, rule_id: "r", priority: -1 }).success,
    ).toBe(false);
  });
});
