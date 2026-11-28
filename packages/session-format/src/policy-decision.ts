// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Project-policy decision vocabulary: the decision, its enforcement effect, and
// the provenance of the rule that produced it.
//
// M 0.9.0 step 0A. Deliberately NOT the rule vocabulary, the reason-code
// registry, the scope contract or the expansion record: those are step 0B, held
// until the bounded discovery finding exists. What is here is the part that
// discovery cannot move, because it is settled by the roadmap rather than by how
// users describe the problem.
//
// Nothing produces a decision yet. Steps 8 and 9 do.
//
// =============================================================================
// This is PROJECT policy, not check policy
// =============================================================================
//
// `@viberevert/core`'s `policy-resolve.ts` resolves check toggles and risk
// thresholds and is exposed to agents as the locked `get_policy` MCP tool. That
// is configuration resolution and has nothing to do with this module. See that
// file's header for the full naming ruling.

import { z } from "zod";
import { nonBlankString } from "./atoms.js";

// =============================================================================
// The decision
// =============================================================================

/**
 * What project policy decided about an evaluated action.
 *
 * Locked by roadmap section 6 and not open to the discovery gate: these four
 * are the decision model, and discovery validates how users want to REACH them,
 * not whether they exist.
 *
 * Order is significant and ascending in strictness, so a reader can compare
 * severity without a second table. It is NOT a risk level: a risk level
 * describes a change, a decision describes a policy outcome.
 */
export const PolicyDecisionSchema = z.enum(["ALLOW", "WARN", "REQUIRE_APPROVAL", "DENY"]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// =============================================================================
// The enforcement effect, which is a SEPARATE fact
// =============================================================================

/**
 * What actually happened as a result, on the surface that evaluated it.
 *
 * ## Why this is a second field and not a nuance of the first
 *
 * Roadmap principle 12 requires that a policy outcome is described in the terms
 * the enforcing surface can actually deliver. Keeping that as guidance would
 * mean every renderer and every adapter re-deriving it, and the first one to get
 * it wrong would print "blocked" about a write that already happened. Making it
 * structural moves the honesty into the data:
 *
 *     decision:           DENY
 *     enforcement_effect: detected_after_write
 *
 * **`DENY` never implies prevented.** A reader that wants to say "blocked" must
 * find an effect value that says so, and in 0.9.0 there is none, because no
 * 0.9.0 surface gates a write before it happens. That is not an omission to be
 * filled in later by guesswork: 0.10.0 owns pre-write enforcement, and the
 * member that describes it arrives with the surface that delivers it.
 *
 * ## Why exactly these two
 *
 * Both are deliverable by a surface that exists today, which is the whole test
 * for admission here:
 *
 *   - `detected_after_write`: the action already happened and the violation was
 *     recorded. `viberevert check` after the fact, the git pre-commit hook, the
 *     GitHub Action.
 *   - `refused_at_next_boundary`: the configured refusal or failure outcome
 *     fired at the next VibeRevert-controlled boundary, for example a non-zero
 *     exit that fails a commit or a CI job. The prior write still happened; what
 *     was refused is progress past the boundary.
 *
 * A third member is added only together with a surface that can produce it. The
 * valid decision-and-effect combinations are deliberately NOT fixed here: which
 * pairings are reachable depends on the surfaces built in steps 7 through 9, and
 * guessing now would lock a matrix nothing has exercised.
 */
export const EnforcementEffectSchema = z.enum(["detected_after_write", "refused_at_next_boundary"]);
export type EnforcementEffect = z.infer<typeof EnforcementEffectSchema>;

/**
 * Words a renderer must never use about an effect, as a machine-checkable list.
 *
 * `support.yml` and `release-claim-invariants.test.ts` are the precedent: a
 * claim of this class is tested, not remembered. The accompanying test asserts
 * that no effect value contains any of these, so a future member cannot smuggle
 * in a prevention claim by name alone.
 */
export const PROHIBITED_EFFECT_TERMS: readonly string[] = [
  "blocked",
  "prevented",
  "stopped",
  "denied_write",
  "before_write",
];

// =============================================================================
// Rule provenance, assigned by the resolver and never by input
// =============================================================================

/**
 * Where a resolved rule came from.
 *
 * 0.9.0 has exactly one source, and the enum has exactly one member. That is
 * not a placeholder: it is the honest shape of a product with no policy
 * inheritance, and widening a resolver-owned enum later is backward compatible
 * precisely because no user input ever populated it.
 *
 * **Input configuration cannot set this.** The rule schema that step 0B defines
 * is strict, so a rule object carrying `origin` is rejected like any unknown
 * key, and the resolver attaches the value on the way out. An earlier draft
 * proposed a reserved user-settable field that 0.9.0 would ignore, which is the
 * worst of both: it accepts input, does nothing with it, and teaches a meaning
 * that later changes.
 */
export const RuleOriginSchema = z.enum(["local_project"]);
export type RuleOrigin = z.infer<typeof RuleOriginSchema>;

/**
 * Which layer a resolved rule was contributed by.
 *
 * Also resolver-owned, also single-valued in 0.9.0, for the same reason. The
 * layer exists as a distinct axis from `origin` because inheritance later varies
 * them independently: an organization layer and a project layer can both have
 * origin `remote`, and one project layer can merge rules from several origins.
 * Collapsing them now would force a format change to separate them.
 */
export const RuleLayerSchema = z.enum(["project"]);
export type RuleLayer = z.infer<typeof RuleLayerSchema>;

/**
 * The provenance a resolved rule carries, and that a decision cites when it
 * explains which rule won.
 *
 * `rule_id` is stable rule identity: it must survive across versions so a
 * decision recorded today can still name its rule tomorrow. Release gate 12
 * requires the winning rule to be explainable, and an unstable id would make
 * that explanation unreproducible.
 */
export const ResolvedRuleProvenanceSchema = z.strictObject({
  rule_id: nonBlankString,
  origin: RuleOriginSchema,
  layer: RuleLayerSchema,
  /**
   * Deterministic precedence. Lower wins, and ties are resolved by `rule_id`
   * ascending so the winner never depends on file order or map iteration.
   */
  priority: z.int().nonnegative(),
});
export type ResolvedRuleProvenance = z.infer<typeof ResolvedRuleProvenanceSchema>;
