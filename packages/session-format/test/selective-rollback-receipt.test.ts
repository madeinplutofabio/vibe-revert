// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.8.0 step 0 -- the selective rollback receipt.
//
// This is the widest refine surface in the substrate: a large file-level refine
// surface on top of a mode-discriminated union. The rules encode a pipeline
//
//     mutation -> first integrity -> verification commands -> second integrity
//
// so most of the value here is in the NEGATIVE cases. A schema that accepts a
// receipt claiming "everything was clean and my configured commands were never
// reached" is worse than no schema, because the artifact is what a human reads
// after a recovery went wrong.
//
// Discipline, same as evaluation-snapshot.test.ts: every rejection fixture is
// otherwise-valid, so only the named rule can be the cause. Several tests below
// deliberately set `outcome: "failed"` for no reason other than to keep the
// succeeded-conjunction rule from confounding the rule under test.

import { describe, expect, it } from "vitest";

import {
  ApplyPathOutcomeSchema,
  DryRunPathOutcomeSchema,
  deriveChangeGroupId,
  deriveFindingId,
  firstVerificationCompletedCleanly,
  type IntegrityAssessment,
  IntegrityAssessmentSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
  SelectiveRollbackReceiptSchema,
} from "../src/index.js";

// =============================================================================
// Fixtures
// =============================================================================

const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ROLLBACK = "rb_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHECKPOINT = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EMERGENCY = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DIGEST = "a".repeat(64);
const WHEN = "2026-01-01T00:00:00Z";

const GROUP_A = deriveChangeGroupId(SESSION, ["src/a.ts"]);
const GROUP_B = deriveChangeGroupId(SESSION, ["src/b.ts"]);
const GROUP_C = deriveChangeGroupId(SESSION, ["src/c.ts"]);
const FINDING = deriveFindingId(SESSION, "payments.webhook", ["src/a.ts"]);

/** Canonical order, whatever the digests happen to sort to. */
const GROUPS_AB = [GROUP_A, GROUP_B].sort();

const CLEAN = {
  selected_verified: true,
  unselected_checked_count: 12,
  unselected_violations: [],
  head_unchanged: true,
};

/** Clean except that the selected paths did not verify. */
const SELECTED_UNVERIFIED = { ...CLEAN, selected_verified: false };

/** Clean except that an unselected managed path moved. */
const COLLATERAL = {
  selected_verified: true,
  unselected_checked_count: 12,
  unselected_violations: ["src/untouched.ts"],
  head_unchanged: true,
};

/** Clean except that HEAD moved: the `git commit` in a verify command case. */
const HEAD_MOVED = { ...CLEAN, head_unchanged: false };

/** The first verification ran and reported `assessment`. */
const completed = (assessment: IntegrityAssessment) =>
  ({ state: "completed", assessment }) as const;

function dryRun(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
    mode: "dry_run",
    rollback_id: ROLLBACK,
    session_id: SESSION,
    checkpoint_id: CHECKPOINT,
    contribution_sha256: DIGEST,
    selectors: { only: ["src/**"] },
    resolved_change_group_ids: [GROUP_A],
    results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "restored" }],
    eligibility: "eligible",
    written_at: WHEN,
    out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
    ...overrides,
  };
}

// ---- project verification / post-command integrity fixtures ----------------
//
// The two are ORTHOGONAL but coupled by state: commands that never started
// pair with `not_run` carrying the same reason, while commands that were
// reached pair with a real observation, including when the runner faulted.

const NOT_CONFIGURED_VERIFICATION = { state: "not_configured" } as const;
const NOT_CONFIGURED_POST = { state: "not_run", reason: "commands_not_configured" } as const;

const PASSING_COMMAND = {
  command: "npm",
  args: ["test"],
  result: { outcome: "exited", exit_code: 0 },
} as const;
const FAILING_COMMAND = {
  command: "npm",
  args: ["test"],
  result: { outcome: "exited", exit_code: 1 },
} as const;
const NOT_RUN_COMMAND = {
  command: "npm",
  args: ["lint"],
  result: { outcome: "not_run", reason: "earlier_command_did_not_pass" },
} as const;

const COMPLETED_PASSED = { state: "completed", commands: [PASSING_COMMAND] } as const;
const CLEAN_POST = { state: "clean" } as const;

const SKIPPED_TRANSPLANT_FAILED = { state: "skipped", reason: "transplant_failed" } as const;
const NOT_RUN_TRANSPLANT_FAILED = { state: "not_run", reason: "transplant_failed" } as const;

const COMPLETED_FAILED = { state: "completed", commands: [FAILING_COMMAND] } as const;
const POST_MUTATED = {
  state: "project_mutated",
  added_paths: [],
  removed_paths: [],
  changed_paths: ["src/other.ts"],
  topology_changed_roots: [],
  head_moved: false,
} as const;
const POST_HEAD_MOVED = {
  state: "project_mutated",
  added_paths: [],
  removed_paths: [],
  changed_paths: [],
  topology_changed_roots: [],
  head_moved: true,
} as const;

function apply(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
    mode: "apply",
    rollback_id: ROLLBACK,
    session_id: SESSION,
    checkpoint_id: CHECKPOINT,
    contribution_sha256: DIGEST,
    pre_rollback_checkpoint_id: EMERGENCY,
    selectors: { only: ["src/**"] },
    resolved_change_group_ids: [GROUP_A],
    results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "restored" }],
    outcome: "succeeded",
    first_verification: completed(CLEAN),
    project_verification: NOT_CONFIGURED_VERIFICATION,
    post_command_integrity: NOT_CONFIGURED_POST,
    written_at: WHEN,
    out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
    ...overrides,
  };
}

const ok = (value: unknown) => SelectiveRollbackReceiptSchema.safeParse(value).success;

// =============================================================================
// Mode as a real discriminator
// =============================================================================

describe("mode discrimination", () => {
  it("accepts a complete dry-run receipt", () => {
    expect(ok(dryRun())).toBe(true);
  });

  it("accepts a complete apply receipt", () => {
    expect(ok(apply())).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(ok(dryRun({ mode: "preview" }))).toBe(false);
  });

  it("rejects an apply-only field on a dry-run", () => {
    // A dry-run mutates nothing, so an outcome, an integrity assessment, or an
    // emergency checkpoint would each describe work that did not happen.
    expect(ok(dryRun({ outcome: "succeeded" }))).toBe(false);
    expect(ok(dryRun({ first_verification: completed(CLEAN) }))).toBe(false);
    expect(ok(dryRun({ pre_rollback_checkpoint_id: EMERGENCY }))).toBe(false);
    expect(ok(dryRun({ project_verification: NOT_CONFIGURED_VERIFICATION }))).toBe(false);
  });

  it("rejects eligibility on an apply", () => {
    // Eligibility is settled BEFORE an apply is allowed to begin: an ineligible
    // selection refuses and writes no receipt at all.
    expect(ok(apply({ eligibility: "eligible" }))).toBe(false);
  });

  it("keeps the two per-path vocabularies disjoint", () => {
    // Asserted against the enums THEMSELVES, not through a receipt. Routed
    // through a receipt, adding "failed" to the dry-run vocabulary would still be
    // rejected -- by the `ineligible` refine, which recognizes only the three
    // ineligible members -- so the test would stay green while the enum
    // regressed. These assertions can fail only if the vocabulary changes.
    expect(DryRunPathOutcomeSchema.safeParse("failed").success).toBe(false);
    expect(DryRunPathOutcomeSchema.safeParse("not_attempted").success).toBe(false);

    expect(ApplyPathOutcomeSchema.safeParse("modified_since").success).toBe(false);
    expect(ApplyPathOutcomeSchema.safeParse("unsupported_state").success).toBe(false);
    expect(ApplyPathOutcomeSchema.safeParse("missing_evidence").success).toBe(false);
  });
});

// =============================================================================
// Required fields
// =============================================================================

describe("required fields", () => {
  it.each([
    "schema_version",
    "mode",
    "rollback_id",
    "session_id",
    "checkpoint_id",
    "contribution_sha256",
    "selectors",
    "resolved_change_group_ids",
    "results",
    "eligibility",
    "written_at",
    "out_of_scope_notice",
  ])("dry-run requires %s", (field) => {
    const partial: Record<string, unknown> = dryRun();
    delete partial[field];
    expect(ok(partial)).toBe(false);
  });

  it.each([
    "schema_version",
    "mode",
    "rollback_id",
    "session_id",
    "checkpoint_id",
    "contribution_sha256",
    "pre_rollback_checkpoint_id",
    "selectors",
    "resolved_change_group_ids",
    "results",
    "outcome",
    "first_verification",
    "project_verification",
    "post_command_integrity",
    "written_at",
    "out_of_scope_notice",
  ])("apply requires %s", (field) => {
    const partial: Record<string, unknown> = apply();
    delete partial[field];
    expect(ok(partial)).toBe(false);
  });

  it("pins the schema version literal", () => {
    expect(ok(dryRun({ schema_version: "1.1" }))).toBe(false);
  });

  it("requires the out-of-scope notice verbatim", () => {
    expect(ok(dryRun({ out_of_scope_notice: "some other wording" }))).toBe(false);
  });

  it("rejects a millisecond-precision timestamp", () => {
    expect(ok(dryRun({ written_at: "2026-01-01T00:00:00.000Z" }))).toBe(false);
  });

  it("rejects a non-sha256 contribution digest", () => {
    expect(ok(dryRun({ contribution_sha256: "not-a-digest" }))).toBe(false);
  });
});

// =============================================================================
// Identifier refinements
// =============================================================================
//
// These are load-bearing in a way that is easy to lose: inside the branch
// schemas the four id fields are only `nonBlankString`. Every shape rule lives
// in a FILE-LEVEL refine, because a discriminated union cannot carry one. If
// those refines were dropped, the branch schemas alone would happily accept
// "rollback-1", and these tests are the only thing that would notice.

describe("identifier shapes", () => {
  it("rejects a rollback_id that is merely non-blank", () => {
    expect(ok(dryRun({ rollback_id: "rollback-1" }))).toBe(false);
  });

  it("rejects prefix confusion between the three id families", () => {
    expect(ok(dryRun({ rollback_id: CHECKPOINT }))).toBe(false);
    expect(ok(dryRun({ session_id: CHECKPOINT }))).toBe(false);
    expect(ok(dryRun({ checkpoint_id: ROLLBACK }))).toBe(false);
  });

  it("rejects a ULID body using an excluded Crockford letter", () => {
    expect(ok(dryRun({ rollback_id: "rb_01ARZ3NDEKTSV4RRFFQ69G5FAI" }))).toBe(false);
  });

  it("checks pre_rollback_checkpoint_id only on the apply branch", () => {
    // The refine is guarded by `mode !== "apply"`, so the dry-run positive above
    // already proves the guard; this proves the checked side actually fires.
    expect(ok(apply({ pre_rollback_checkpoint_id: "cp_nope" }))).toBe(false);
    expect(ok(apply({ pre_rollback_checkpoint_id: ROLLBACK }))).toBe(false);
  });
});

// =============================================================================
// Selectors, reached through the receipt
// =============================================================================

describe("selectors", () => {
  it("rejects an empty selector object", () => {
    expect(ok(dryRun({ selectors: {} }))).toBe(false);
  });

  it("requires finding selectors to be FULL finding ids", () => {
    // The CLI resolves an unambiguous short prefix before anything is persisted.
    // A receipt recording `fnd_abc` would be re-resolvable only against the
    // report that produced it, which is exactly the coupling the full id removes.
    expect(ok(dryRun({ selectors: { finding: ["fnd_abc"] } }))).toBe(false);
    expect(ok(dryRun({ selectors: { finding: [FINDING] } }))).toBe(true);
  });

  it("accepts --except alone, which is still selective mode", () => {
    expect(ok(dryRun({ selectors: { except: ["tests/**"] } }))).toBe(true);
  });
});

// =============================================================================
// Results address the resolved selection exactly
// =============================================================================

describe("results and resolved selection correspond", () => {
  const twoGroups = {
    resolved_change_group_ids: GROUPS_AB,
    results: [
      { path: "src/a.ts", change_group_id: GROUP_A, outcome: "restored" },
      { path: "src/b.ts", change_group_id: GROUP_B, outcome: "restored" },
    ],
  };

  it("accepts a canonical two-group result set", () => {
    expect(ok(dryRun(twoGroups))).toBe(true);
  });

  it("accepts two results sharing one group, as a rename produces", () => {
    // Selection is group-atomic, restoration is per path.
    expect(
      ok(
        dryRun({
          resolved_change_group_ids: [GROUP_A],
          results: [
            { path: "payments/webhook.ts", change_group_id: GROUP_A, outcome: "restored" },
            { path: "utils/webhook.ts", change_group_id: GROUP_A, outcome: "restored" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("rejects results unsorted by path", () => {
    expect(ok(dryRun({ ...twoGroups, results: [...twoGroups.results].reverse() }))).toBe(false);
  });

  it("rejects a duplicated result path", () => {
    expect(
      ok(
        dryRun({
          resolved_change_group_ids: [GROUP_A],
          results: [
            { path: "src/a.ts", change_group_id: GROUP_A, outcome: "restored" },
            { path: "src/a.ts", change_group_id: GROUP_A, outcome: "already_at_before" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a result whose group was never resolved", () => {
    // Both resolved groups ARE covered here, so only the foreign GROUP_C can be
    // the cause. Otherwise this would pass for the wrong reason.
    expect(
      ok(
        dryRun({
          resolved_change_group_ids: GROUPS_AB,
          results: [
            ...twoGroups.results,
            { path: "src/c.ts", change_group_id: GROUP_C, outcome: "restored" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a resolved group with no result at all", () => {
    // Inverse direction, isolated the same way: every result's group IS resolved,
    // so only the uncovered GROUP_B can be the cause. A selected group silently
    // producing no result is the failure mode this catches.
    expect(
      ok(
        dryRun({
          resolved_change_group_ids: GROUPS_AB,
          results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "restored" }],
        }),
      ),
    ).toBe(false);
  });

  it("rejects an unsorted resolved group set", () => {
    expect(ok(dryRun({ ...twoGroups, resolved_change_group_ids: [...GROUPS_AB].reverse() }))).toBe(
      false,
    );
  });
});

// =============================================================================
// Dry-run eligibility
// =============================================================================

describe("dry-run eligibility", () => {
  it("accepts an empty selection as a reportable analysis result", () => {
    // The one place the receipt diverges from the attempt marker: selectors
    // matching nothing is a legitimate answer, not a refusal.
    expect(
      ok(dryRun({ eligibility: "empty_selection", resolved_change_group_ids: [], results: [] })),
    ).toBe(true);
  });

  it("rejects empty_selection with a non-empty selection", () => {
    expect(ok(dryRun({ eligibility: "empty_selection" }))).toBe(false);
  });

  it("rejects a non-empty eligibility with an empty selection", () => {
    // The rule is an IFF, so both directions are pinned: an empty resolution has
    // exactly one legal spelling.
    expect(
      ok(dryRun({ eligibility: "eligible", resolved_change_group_ids: [], results: [] })),
    ).toBe(false);
    expect(
      ok(dryRun({ eligibility: "ineligible", resolved_change_group_ids: [], results: [] })),
    ).toBe(false);
  });

  it("accepts already_at_before as an eligible outcome", () => {
    // A repeated restore is a no-op, not drift.
    expect(
      ok(
        dryRun({
          results: [
            {
              path: "src/a.ts",
              change_group_id: GROUP_A,
              outcome: "already_at_before",
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it.each([
    "modified_since",
    "unsupported_state",
    "missing_evidence",
  ])("rejects 'eligible' when a result is %s", (outcome) => {
    expect(ok(dryRun({ results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome }] }))).toBe(
      false,
    );
  });

  it.each([
    "modified_since",
    "unsupported_state",
    "missing_evidence",
  ])("accepts 'ineligible' when a result is %s", (outcome) => {
    expect(
      ok(
        dryRun({
          eligibility: "ineligible",
          results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome }],
        }),
      ),
    ).toBe(true);
  });

  it("rejects 'ineligible' when every result is fine", () => {
    // Eligibility is all-or-nothing, so an ineligible verdict must name at least
    // one ineligible unit. Otherwise the receipt refuses without evidence.
    expect(ok(dryRun({ eligibility: "ineligible" }))).toBe(false);
  });

  it("accepts a mixed selection as ineligible", () => {
    // One bad unit poisons the whole operation: this is what an apply would
    // refuse on.
    expect(
      ok(
        dryRun({
          eligibility: "ineligible",
          resolved_change_group_ids: GROUPS_AB,
          results: [
            { path: "src/a.ts", change_group_id: GROUP_A, outcome: "restored" },
            {
              path: "src/b.ts",
              change_group_id: GROUP_B,
              outcome: "modified_since",
              reason: "edited after the session ended",
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

// =============================================================================
// Apply: the resolved selection is never empty
// =============================================================================

describe("apply requires a non-empty resolution", () => {
  it("rejects an apply receipt with nothing selected", () => {
    // An empty selection refuses BEFORE mutation, so no apply receipt for one can
    // ever legitimately exist.
    expect(ok(apply({ resolved_change_group_ids: [], results: [] }))).toBe(false);
  });
});

// =============================================================================
// Integrity assessment
// =============================================================================

describe("IntegrityAssessmentSchema", () => {
  it("accepts a clean assessment", () => {
    expect(IntegrityAssessmentSchema.safeParse(CLEAN).success).toBe(true);
  });

  it("rejects a violation count smaller than the violations named", () => {
    // Otherwise the artifact could claim zero paths were compared while naming a
    // path that failed the comparison.
    expect(
      IntegrityAssessmentSchema.safeParse({
        selected_verified: true,
        unselected_checked_count: 0,
        unselected_violations: ["src/untouched.ts"],
        head_unchanged: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a count exactly equal to the violations named", () => {
    expect(
      IntegrityAssessmentSchema.safeParse({
        selected_verified: false,
        unselected_checked_count: 1,
        unselected_violations: ["src/untouched.ts"],
        head_unchanged: true,
      }).success,
    ).toBe(true);
  });

  it("rejects unsorted or duplicated violations", () => {
    expect(
      IntegrityAssessmentSchema.safeParse({ ...COLLATERAL, unselected_violations: ["b", "a"] })
        .success,
    ).toBe(false);
    expect(
      IntegrityAssessmentSchema.safeParse({ ...COLLATERAL, unselected_violations: ["a", "a"] })
        .success,
    ).toBe(false);
  });

  it("rejects a negative or fractional checked count", () => {
    expect(
      IntegrityAssessmentSchema.safeParse({ ...CLEAN, unselected_checked_count: -1 }).success,
    ).toBe(false);
    expect(
      IntegrityAssessmentSchema.safeParse({ ...CLEAN, unselected_checked_count: 1.5 }).success,
    ).toBe(false);
  });
});

// =============================================================================
// The apply pipeline, both directions
// =============================================================================

describe("project verification is coupled to a second integrity pass", () => {
  it("accepts not_configured with no second pass", () => {
    expect(ok(apply())).toBe(true);
  });

  it("rejects not_configured carrying a second pass", () => {
    // No commands ran, so there is nothing for a post-command pass to be about.
    expect(ok(apply({ post_command_integrity: CLEAN_POST }))).toBe(false);
  });

  it("accepts passed with a second pass", () => {
    expect(
      ok(apply({ project_verification: COMPLETED_PASSED, post_command_integrity: CLEAN_POST })),
    ).toBe(true);
  });

  it("rejects passed without a second pass", () => {
    // Commands ran, so the tree must have been re-examined afterwards. This is
    // the rule that makes VERIFICATION_COMMAND_MUTATED_PROJECT detectable at all.
    expect(ok(apply({ project_verification: COMPLETED_PASSED, outcome: "failed" }))).toBe(false);
  });

  it("rejects failed without a second pass", () => {
    expect(ok(apply({ project_verification: COMPLETED_FAILED, outcome: "failed" }))).toBe(false);
  });

  it("rejects not_run carrying a second pass", () => {
    expect(
      ok(
        apply({
          project_verification: SKIPPED_TRANSPLANT_FAILED,
          post_command_integrity: CLEAN_POST,
          first_verification: completed(SELECTED_UNVERIFIED),
          outcome: "failed",
        }),
      ),
    ).toBe(false);
  });
});

describe("pipeline order, forward: commands are reachable only after a clean stage", () => {
  it("rejects commands running after a failed transplant", () => {
    // outcome is already "failed" so the succeeded-conjunction rule cannot be the
    // cause; only the forward pipeline rule can.
    expect(
      ok(
        apply({
          results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "failed" }],
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(false);
  });

  it("rejects commands running after an unverified selected set", () => {
    expect(
      ok(
        apply({
          first_verification: completed(SELECTED_UNVERIFIED),
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(false);
  });

  it("rejects commands running after collateral damage to unselected paths", () => {
    expect(
      ok(
        apply({
          first_verification: completed(COLLATERAL),
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(false);
  });

  it("rejects commands running after HEAD moved", () => {
    expect(
      ok(
        apply({
          first_verification: completed(HEAD_MOVED),
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(false);
  });

  it("rejects a not_attempted path preceding a command run", () => {
    expect(
      ok(
        apply({
          resolved_change_group_ids: GROUPS_AB,
          results: [
            { path: "src/a.ts", change_group_id: GROUP_A, outcome: "failed" },
            { path: "src/b.ts", change_group_id: GROUP_B, outcome: "not_attempted" },
          ],
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(false);
  });
});

describe("pipeline order, inverse: not_run asserts the earlier stage failed", () => {
  it("rejects not_run after a completely clean stage", () => {
    // Without this rule the receipt could report a perfect transplant and clean
    // integrity while still claiming its configured commands were unreachable.
    // Nothing in the artifact would contradict it, and a reader would conclude
    // the project was verified when it never was.
    expect(
      ok(
        apply({
          project_verification: SKIPPED_TRANSPLANT_FAILED,
          post_command_integrity: NOT_RUN_TRANSPLANT_FAILED,
          outcome: "failed",
        }),
      ),
    ).toBe(false);
  });

  it("accepts not_run after a failed transplant", () => {
    expect(
      ok(
        apply({
          results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "failed" }],
          outcome: "failed",
          project_verification: SKIPPED_TRANSPLANT_FAILED,
          post_command_integrity: NOT_RUN_TRANSPLANT_FAILED,
        }),
      ),
    ).toBe(true);
  });

  it("accepts not_run after a failed first integrity pass", () => {
    // One representative is enough: SELECTED_UNVERIFIED, collateral damage, and
    // HEAD movement all feed the same `!isIntegrityClean` predicate, and the
    // other two are pinned independently in the forward and success blocks.
    expect(
      ok(
        apply({
          first_verification: completed(SELECTED_UNVERIFIED),
          outcome: "failed",
          project_verification: SKIPPED_TRANSPLANT_FAILED,
          post_command_integrity: NOT_RUN_TRANSPLANT_FAILED,
        }),
      ),
    ).toBe(true);
  });

  it("leaves not_configured independent of the earlier stage", () => {
    // Commands that do not exist are unreachable no matter what came before, so
    // not_configured must survive a failed transplant.
    expect(
      ok(
        apply({
          results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "failed" }],
          outcome: "failed",
        }),
      ),
    ).toBe(true);
  });
});

// =============================================================================
// Success is the conjunction of every guarantee
// =============================================================================

describe("outcome 'succeeded'", () => {
  it("accepts a fully clean apply with no commands configured", () => {
    expect(ok(apply())).toBe(true);
  });

  it("accepts a fully clean apply whose commands passed", () => {
    expect(
      ok(apply({ project_verification: COMPLETED_PASSED, post_command_integrity: CLEAN_POST })),
    ).toBe(true);
  });

  it("rejects success with a failed path", () => {
    expect(
      ok(apply({ results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "failed" }] })),
    ).toBe(false);
  });

  it("rejects success with a not_attempted path", () => {
    expect(
      ok(
        apply({
          results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "not_attempted" }],
        }),
      ),
    ).toBe(false);
  });

  it("rejects success with an unverified selected set", () => {
    expect(ok(apply({ first_verification: completed(SELECTED_UNVERIFIED) }))).toBe(false);
  });

  it("rejects success with collateral damage to an unselected path", () => {
    // The whole promise of surgical recovery: everything not selected is
    // provably untouched.
    expect(ok(apply({ first_verification: completed(COLLATERAL) }))).toBe(false);
  });

  it("rejects success with HEAD moved", () => {
    expect(ok(apply({ first_verification: completed(HEAD_MOVED) }))).toBe(false);
  });

  it("rejects success when the verification commands failed", () => {
    expect(
      ok(apply({ project_verification: COMPLETED_FAILED, post_command_integrity: CLEAN_POST })),
    ).toBe(false);
  });

  it("rejects success when the post-command pass found damage", () => {
    // A command that mutated the project cannot be reported as a successful
    // recovery even though every earlier stage was clean.
    expect(
      ok(apply({ project_verification: COMPLETED_PASSED, post_command_integrity: POST_MUTATED })),
    ).toBe(false);
  });

  it("rejects success when a command moved HEAD", () => {
    // The `git commit` case: file bytes can look acceptable while history moved.
    expect(
      ok(
        apply({ project_verification: COMPLETED_PASSED, post_command_integrity: POST_HEAD_MOVED }),
      ),
    ).toBe(false);
  });

  it("allows outcome 'failed' even when every modeled dimension looks clean", () => {
    // Deliberately one-directional. A failure can originate outside the
    // dimensions this artifact models -- a receipt-adjacent write error, say --
    // and the engine must be able to report it honestly rather than being forced
    // into "succeeded" by the schema. Tightening this to an IFF would claim the
    // schema already enumerates every operation-level failure source, which it
    // does not. Revisit only if every failure gains a structured top-level reason.
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(true);
  });
});

// =============================================================================
// Per-path result shape
// =============================================================================

describe("per-path results", () => {
  it("accepts an optional reason", () => {
    expect(
      ok(
        dryRun({
          eligibility: "ineligible",
          results: [
            {
              path: "src/a.ts",
              change_group_id: GROUP_A,
              outcome: "modified_since",
              reason: "worktree bytes changed after the session ended",
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("rejects a blank reason", () => {
    expect(
      ok(
        dryRun({
          results: [
            { path: "src/a.ts", change_group_id: GROUP_A, outcome: "restored", reason: "   " },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects an unsafe stored path", () => {
    expect(
      ok(
        dryRun({
          results: [{ path: "../escape.ts", change_group_id: GROUP_A, outcome: "restored" }],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a malformed change group id", () => {
    expect(
      ok(
        dryRun({
          resolved_change_group_ids: [`cg_${"z".repeat(64)}`],
          results: [
            { path: "src/a.ts", change_group_id: `cg_${"z".repeat(64)}`, outcome: "restored" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects unknown fields on a result", () => {
    expect(
      ok(
        dryRun({
          results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "restored", bytes: 42 }],
        }),
      ),
    ).toBe(false);
  });
});

// =============================================================================
// Project verification and post-command integrity, as discriminated records
//
// These arms exist because the transaction produces outcomes the original
// four-state enum could not express without asserting something that was never
// observed: "the runner broke" is not "your tests failed", a moved exclusion
// basis is not a failed verification, and an observation that could not be
// taken is not an observation that was clean.
// =============================================================================

describe("project verification records", () => {
  it("keeps a runner fault distinct from a command failure", () => {
    // Both are non-success, and collapsing them would tell a reader their tests
    // failed when the runner never got to ask.
    const runnerFailed = {
      state: "runner_failed",
      failure: { error_code: "io", message: "spawn ENOENT" },
    };
    // A runner fault is never a success, whatever the observation showed.
    expect(
      ok(apply({ project_verification: runnerFailed, post_command_integrity: CLEAN_POST })),
    ).toBe(false);
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: runnerFailed,
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(true);
  });

  it("still observes the repository after a runner fault", () => {
    // ORTHOGONAL axes: the runner faulting says nothing about what the commands
    // already did to the tree, so the post-command observation still applies.
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: {
            state: "runner_failed",
            failure: { error_code: "internal", message: "unexpected" },
          },
          post_command_integrity: POST_MUTATED,
        }),
      ),
    ).toBe(true);
  });

  it("accepts fail-fast records: not_run only after the first non-passing command", () => {
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: {
            state: "completed",
            commands: [FAILING_COMMAND, NOT_RUN_COMMAND],
          },
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(true);
  });

  it("rejects a not_run record before any command failed", () => {
    // The runner stops at the first non-passing command, so a not_run following
    // a pass describes a sequence it could not have produced.
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: {
            state: "completed",
            commands: [PASSING_COMMAND, NOT_RUN_COMMAND, PASSING_COMMAND],
          },
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(false);
  });

  it("rejects a passing command recorded after a failure", () => {
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: {
            state: "completed",
            commands: [FAILING_COMMAND, PASSING_COMMAND],
          },
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(false);
  });
});

describe("post-command integrity records", () => {
  it("requires the not_run reason to match the skip's own reason", () => {
    expect(
      ok(
        apply({
          results: [{ path: "src/a.ts", change_group_id: GROUP_A, outcome: "failed" }],
          outcome: "failed",
          project_verification: SKIPPED_TRANSPLANT_FAILED,
          post_command_integrity: { state: "not_run", reason: "transplant_not_clean" },
        }),
      ),
    ).toBe(false);
  });

  it("records an unusable pre-command observation as an observation, not as not_run", () => {
    // The transplant WAS clean here; what failed was looking at it. Saying
    // "not_run" would describe a failure to observe as a decision not to.
    const base = {
      outcome: "failed",
      project_verification: { state: "skipped", reason: "pre_command_observation_unusable" },
    };
    expect(
      ok(
        apply({
          ...base,
          post_command_integrity: {
            state: "observation_failed",
            side: "before_commands",
            failure: { error_code: "io", message: "EACCES" },
          },
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        apply({
          ...base,
          post_command_integrity: { state: "not_run", reason: "transplant_failed" },
        }),
      ),
    ).toBe(false);
  });

  it("accepts basis_changed as its own state", () => {
    // The ignore rules moved, so the domain comparison is not interpretable.
    // Recording it as a failed verification would assert a failure never seen.
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: { state: "basis_changed" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects project_mutated that names nothing", () => {
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: { ...POST_MUTATED, changed_paths: [], head_moved: false },
        }),
      ),
    ).toBe(false);
  });

  it("accepts project_mutated naming only HEAD movement", () => {
    // A command that commits leaves every managed path as verified.
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: POST_HEAD_MOVED,
        }),
      ),
    ).toBe(true);
  });

  const torn = (overrides: Record<string, unknown>) => ({
    state: "observation_torn",
    side: "after_commands",
    basis_moved: false,
    head_moved: false,
    domain_status: "moved",
    ...overrides,
  });

  const tornReceipt = (overrides: Record<string, unknown>) =>
    apply({
      outcome: "failed",
      project_verification: COMPLETED_PASSED,
      post_command_integrity: torn(overrides),
    });

  it("accepts a torn sample whose axes agree with the acquisition rule", () => {
    expect(ok(tornReceipt({}))).toBe(true);
    expect(ok(tornReceipt({ basis_moved: true, domain_status: "not_comparable" }))).toBe(true);
    expect(ok(tornReceipt({ head_moved: true, domain_status: "unchanged" }))).toBe(true);
  });

  it("rejects a moved basis that still claims a comparable domain", () => {
    expect(ok(tornReceipt({ basis_moved: true, domain_status: "moved" }))).toBe(false);
    expect(ok(tornReceipt({ basis_moved: true, domain_status: "unchanged" }))).toBe(false);
  });

  it("rejects not_comparable without a moved basis", () => {
    expect(ok(tornReceipt({ basis_moved: false, domain_status: "not_comparable" }))).toBe(false);
  });

  it("rejects a torn sample in which nothing actually moved", () => {
    // A stable basis, a steady HEAD and an unchanged domain describe a COHERENT
    // sample, which would never have been reported as torn.
    expect(ok(tornReceipt({ head_moved: false, domain_status: "unchanged" }))).toBe(false);
  });

  it("accepts classification_failed as distinct from an unusable observation", () => {
    // Both observations were coherent; only comparing them faulted.
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: COMPLETED_PASSED,
          post_command_integrity: {
            state: "classification_failed",
            failure: { error_code: "internal", message: "comparator threw" },
          },
        }),
      ),
    ).toBe(true);
  });
});

// =============================================================================
// The first verification as a three-state record
//
// "It ran and said this", "it started and threw", and "it never ran" are
// different facts. The assessment itself is unchanged: when the verification
// completed, what it found is exactly the IntegrityAssessment it always was.
// =============================================================================

const VERIFICATION_FAILED = {
  state: "failed",
  failure: { error_code: "internal", message: "verifier threw" },
} as const;
const VERIFICATION_NOT_RUN = { state: "not_run", reason: "gate_result_unavailable" } as const;

describe("first verification states", () => {
  it("derives cleanliness only from a completed verification", () => {
    expect(firstVerificationCompletedCleanly(completed(CLEAN))).toBe(true);
    expect(firstVerificationCompletedCleanly(completed(SELECTED_UNVERIFIED))).toBe(false);
    expect(firstVerificationCompletedCleanly(VERIFICATION_FAILED)).toBe(false);
    expect(firstVerificationCompletedCleanly(VERIFICATION_NOT_RUN)).toBe(false);
  });

  it("accepts a failed verification that skipped commands for THAT stage", () => {
    expect(
      ok(
        apply({
          outcome: "failed",
          first_verification: VERIFICATION_FAILED,
          project_verification: { state: "skipped", reason: "first_verification_failed" },
          post_command_integrity: { state: "not_run", reason: "first_verification_failed" },
        }),
      ),
    ).toBe(true);
  });

  it("accepts a failed verification when no commands were configured", () => {
    // Commands that do not exist were never skipped BY this stage, so
    // not_configured stays the truthful record.
    expect(ok(apply({ outcome: "failed", first_verification: VERIFICATION_FAILED }))).toBe(true);
  });

  it("rejects a failed verification whose skip names another stage", () => {
    // Borrowing `transplant_failed` would attribute the stop to a stage that
    // did not stop it, and the receipt is what a human reads afterwards.
    expect(
      ok(
        apply({
          outcome: "failed",
          first_verification: VERIFICATION_FAILED,
          project_verification: SKIPPED_TRANSPLANT_FAILED,
          post_command_integrity: NOT_RUN_TRANSPLANT_FAILED,
        }),
      ),
    ).toBe(false);
  });

  it("rejects commands that ran despite a failed verification", () => {
    expect(
      ok(
        apply({
          outcome: "failed",
          first_verification: VERIFICATION_FAILED,
          project_verification: COMPLETED_PASSED,
          post_command_integrity: CLEAN_POST,
        }),
      ),
    ).toBe(false);
  });

  it("accepts an unavailable gate result recorded as its own stage", () => {
    // A publication that may have persisted before a throw leaves no usable
    // gate result, so the verification never ran at all.
    expect(
      ok(
        apply({
          outcome: "failed",
          first_verification: VERIFICATION_NOT_RUN,
          project_verification: { state: "skipped", reason: "gate_result_unavailable" },
          post_command_integrity: { state: "not_run", reason: "gate_result_unavailable" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a stage skip reason that contradicts a completed verification", () => {
    // The converse direction: these reasons ASSERT a first-verification state,
    // so they cannot appear beside one that completed.
    expect(
      ok(
        apply({
          outcome: "failed",
          project_verification: { state: "skipped", reason: "first_verification_failed" },
          post_command_integrity: { state: "not_run", reason: "first_verification_failed" },
        }),
      ),
    ).toBe(false);
  });

  it("rejects success when the first verification did not complete", () => {
    expect(ok(apply({ first_verification: VERIFICATION_FAILED }))).toBe(false);
    expect(ok(apply({ first_verification: VERIFICATION_NOT_RUN }))).toBe(false);
  });
});
