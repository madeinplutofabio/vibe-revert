// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.8.0 step 0 -- the pre-mutation rollback attempt marker.
//
// The marker exists to close a crash window: it is written BEFORE the first
// worktree or index mutation, and it names the emergency checkpoint, so an
// interrupted apply is always discoverable. These tests pin the properties that
// make a stranded marker interpretable without replaying the session that
// produced it.

import { describe, expect, it } from "vitest";

import {
  deriveChangeGroupId,
  deriveFindingId,
  RollbackAttemptSchema,
  RollbackSelectorsSchema,
} from "../src/index.js";

// =============================================================================
// Fixtures
// =============================================================================

const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ROLLBACK = "rb_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHECKPOINT = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DIGEST = "a".repeat(64);
const WHEN = "2026-01-01T00:00:00Z";

const GROUP_A = deriveChangeGroupId(SESSION, ["src/a.ts"]);
const GROUP_B = deriveChangeGroupId(SESSION, ["src/b.ts"]);
const FINDING_A = deriveFindingId(SESSION, "payments.webhook", ["src/a.ts"]);
const FINDING_B = deriveFindingId(SESSION, "secrets.aws-key", ["src/b.ts"]);

/** Two group ids in canonical order, whatever the digests happen to sort to. */
const GROUPS = [GROUP_A, GROUP_B].sort();
const FINDINGS = [FINDING_A, FINDING_B].sort();

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    rollback_id: ROLLBACK,
    session_id: SESSION,
    contribution_sha256: DIGEST,
    pre_rollback_checkpoint_id: CHECKPOINT,
    selection: {
      selectors: { only: ["src/**"] },
      resolved_change_group_ids: [GROUP_A],
    },
    state: "mutation_may_have_started",
    written_at: WHEN,
    ...overrides,
  };
}

function selection(selectors: Record<string, unknown>, groups: string[] = [GROUP_A]) {
  return { selectors, resolved_change_group_ids: groups };
}

// =============================================================================
// Selectors
// =============================================================================

describe("RollbackSelectorsSchema", () => {
  it("accepts a single glob family", () => {
    expect(RollbackSelectorsSchema.safeParse({ only: ["src/**"] }).success).toBe(true);
  });

  it("accepts --except alone as a selective invocation", () => {
    // Locked: ANY selector puts rollback into selective mode. Only a rollback
    // with no selectors at all is the legacy full-session path.
    expect(RollbackSelectorsSchema.safeParse({ except: ["tests/**"] }).success).toBe(true);
  });

  it("accepts a risk threshold alone", () => {
    expect(RollbackSelectorsSchema.safeParse({ risk: "high" }).success).toBe(true);
  });

  it("accepts several families together", () => {
    expect(
      RollbackSelectorsSchema.safeParse({
        only: ["payments/**"],
        except: ["payments/tests/**"],
        risk: "critical",
        finding: [FINDINGS[0] as string],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty selector object", () => {
    expect(RollbackSelectorsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a PRESENT but EMPTY glob family", () => {
    // Without this, `{ only: [] }` would satisfy "at least one selector present"
    // while carrying no selector, giving two on-disk spellings of the same
    // nothing. Absence is the only way to say a family was unused.
    expect(RollbackSelectorsSchema.safeParse({ only: [] }).success).toBe(false);
    expect(RollbackSelectorsSchema.safeParse({ except: [] }).success).toBe(false);
    expect(RollbackSelectorsSchema.safeParse({ finding: [] }).success).toBe(false);
  });

  it("rejects an unsorted glob family", () => {
    expect(RollbackSelectorsSchema.safeParse({ only: ["src/**", "app/**"] }).success).toBe(false);
  });

  it("rejects a duplicated glob", () => {
    expect(RollbackSelectorsSchema.safeParse({ only: ["src/**", "src/**"] }).success).toBe(false);
  });

  it("requires finding selectors to be full finding ids", () => {
    // The CLI may accept an unambiguous short prefix from the user, but what is
    // PERSISTED is always the resolved full id: a marker recording a prefix
    // would be re-resolvable only against the report that produced it.
    expect(RollbackSelectorsSchema.safeParse({ finding: ["fnd_abc123"] }).success).toBe(false);
    expect(RollbackSelectorsSchema.safeParse({ finding: ["payments.webhook"] }).success).toBe(
      false,
    );
    expect(RollbackSelectorsSchema.safeParse({ finding: [FINDINGS[0] as string] }).success).toBe(
      true,
    );
  });

  it("rejects an unsorted finding set", () => {
    const descending = [...FINDINGS].reverse();
    expect(RollbackSelectorsSchema.safeParse({ finding: descending }).success).toBe(false);
  });

  it("treats risk as a single threshold, not a repeatable family", () => {
    expect(RollbackSelectorsSchema.safeParse({ risk: ["high", "critical"] }).success).toBe(false);
  });

  it("rejects an invalid risk level", () => {
    expect(RollbackSelectorsSchema.safeParse({ risk: "severe" }).success).toBe(false);
  });

  it("rejects an unknown selector family", () => {
    expect(RollbackSelectorsSchema.safeParse({ only: ["src/**"], author: ["me"] }).success).toBe(
      false,
    );
  });
});

// =============================================================================
// Resolved selection
// =============================================================================

describe("resolved_change_group_ids", () => {
  it("accepts a canonical group set", () => {
    expect(
      RollbackAttemptSchema.safeParse(
        attempt({ selection: selection({ only: ["src/**"] }, GROUPS) }),
      ).success,
    ).toBe(true);
  });

  it("rejects an EMPTY resolution", () => {
    // An empty resolution refuses before mutation, so no marker is ever written
    // for one. The selective RECEIPT deliberately differs here, because a
    // dry-run matching nothing is a reportable result.
    expect(
      RollbackAttemptSchema.safeParse(attempt({ selection: selection({ only: ["src/**"] }, []) }))
        .success,
    ).toBe(false);
  });

  it("rejects an unsorted group set", () => {
    const descending = [...GROUPS].reverse();
    expect(
      RollbackAttemptSchema.safeParse(
        attempt({ selection: selection({ only: ["src/**"] }, descending) }),
      ).success,
    ).toBe(false);
  });

  it("rejects a duplicated group", () => {
    expect(
      RollbackAttemptSchema.safeParse(
        attempt({ selection: selection({ only: ["src/**"] }, [GROUP_A, GROUP_A]) }),
      ).success,
    ).toBe(false);
  });

  it("rejects a malformed group id", () => {
    expect(
      RollbackAttemptSchema.safeParse(
        attempt({ selection: selection({ only: ["src/**"] }, [`cg_${"z".repeat(64)}`]) }),
      ).success,
    ).toBe(false);
  });
});

// =============================================================================
// The marker
// =============================================================================

describe("RollbackAttemptSchema", () => {
  it("accepts a complete marker", () => {
    expect(RollbackAttemptSchema.safeParse(attempt()).success).toBe(true);
  });

  it.each([
    "schema_version",
    "rollback_id",
    "session_id",
    "contribution_sha256",
    "pre_rollback_checkpoint_id",
    "selection",
    "state",
    "written_at",
  ])("requires %s", (field) => {
    const partial: Record<string, unknown> = attempt();
    delete partial[field];
    expect(RollbackAttemptSchema.safeParse(partial).success).toBe(false);
  });

  it("requires the recovery handle to be a real checkpoint id", () => {
    // A marker that does not name a way back would defeat its own purpose.
    expect(
      RollbackAttemptSchema.safeParse(attempt({ pre_rollback_checkpoint_id: "cp_nope" })).success,
    ).toBe(false);
  });

  it("rejects a rollback id with the wrong prefix", () => {
    expect(RollbackAttemptSchema.safeParse(attempt({ rollback_id: CHECKPOINT })).success).toBe(
      false,
    );
  });

  it("rejects a session id with the wrong prefix", () => {
    expect(RollbackAttemptSchema.safeParse(attempt({ session_id: ROLLBACK })).success).toBe(false);
  });

  it("rejects a ULID body using an excluded Crockford letter", () => {
    // The alphabet excludes I, L, O, U to avoid transcription ambiguity.
    expect(
      RollbackAttemptSchema.safeParse({
        ...attempt(),
        rollback_id: "rb_01ARZ3NDEKTSV4RRFFQ69G5FAI",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-sha256 contribution digest", () => {
    expect(
      RollbackAttemptSchema.safeParse(attempt({ contribution_sha256: "not-a-digest" })).success,
    ).toBe(false);
  });

  it("rejects an unknown state", () => {
    expect(RollbackAttemptSchema.safeParse(attempt({ state: "finalized" })).success).toBe(false);
  });

  it("rejects a millisecond-precision timestamp", () => {
    expect(
      RollbackAttemptSchema.safeParse(attempt({ written_at: "2026-01-01T00:00:00.000Z" })).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    // The marker is immutable and finalization is signaled by a sibling
    // receipt, so an outcome field here would be a contradiction.
    expect(RollbackAttemptSchema.safeParse(attempt({ outcome: "succeeded" })).success).toBe(false);
  });
});
