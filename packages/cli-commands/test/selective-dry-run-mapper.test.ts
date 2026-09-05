// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/cli-commands/src/selective-dry-run-mapper.ts.
//
// NO CASTS. Unlike the transaction, both inputs are plain data: a preview
// result and a plan are fully constructible from their public types, so every
// fixture here is a real value the compiler checks.
//
// The cases that matter are the ones where the receipt could claim a resolution
// the planner did not make, or could encode something the schema forbids. The
// last group is the explicit boundary between what a preview may report and
// what a receipt can hold.

import type { SelectiveRestorePlan, SelectiveRestorePreviewResult } from "@viberevert/git";
import type { PathState, SelectiveRollbackReceipt } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import {
  type MapSelectiveDryRunReceiptArgs,
  mapEmptySelectiveDryRunReceipt,
  mapSelectiveDryRunReceipt,
  type SelectiveDryRunReceiptIdentity,
} from "../src/selective-dry-run-mapper.js";
import type { ReceiptMapping } from "../src/selective-receipt-mapper.js";

const SESSION_ID = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ROLLBACK_ID = "rb_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const CHECKPOINT_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DIGEST = "a".repeat(64);
const WRITTEN_AT = "2026-03-04T05:06:07Z";

const GROUP_A = `cg_${"0".repeat(63)}1`;
const GROUP_B = `cg_${"0".repeat(63)}2`;
const GROUP_C = `cg_${"0".repeat(63)}3`;

const ABSENT: PathState = { worktree: { kind: "absent" }, index: { kind: "absent" } };

type PreviewPath = Extract<
  SelectiveRestorePreviewResult,
  { outcome: "previewed" }
>["paths"][number];

const previewPath = (
  path: string,
  outcome: PreviewPath["outcome"],
  changeGroupId: string = GROUP_A,
  detail?: string,
): PreviewPath => ({
  path,
  changeGroupId,
  outcome,
  ...(detail === undefined ? {} : { detail }),
});

const previewOf = (
  paths: readonly PreviewPath[],
): Extract<SelectiveRestorePreviewResult, { outcome: "previewed" }> => ({
  outcome: "previewed",
  paths,
  cleanupWarnings: [],
});

type Classification = SelectiveRestorePlan["classifications"][number];

const classification = (path: string, changeGroupId: string = GROUP_A): Classification => ({
  path,
  changeGroupId,
  expectedBefore: ABSENT,
  expectedAfter: ABSENT,
  observed: ABSENT,
  outcome: { kind: "planned", disposition: "restore_required" },
});

/** Authorized groups are given EXPLICITLY, since one test needs them wrong. */
function planOf(
  classifications: readonly Classification[],
  selectedChangeGroupIds?: readonly string[],
): SelectiveRestorePlan {
  const groups =
    selectedChangeGroupIds ?? [...new Set(classifications.map((c) => c.changeGroupId))].sort();
  const base = {
    capabilities: { symlinkCheckout: true },
    selectedChangeGroupIds: groups,
    classifications,
    topologyDependencyPaths: [],
  } as const;
  return classifications.length === 0
    ? { ...base, outcome: "noop", operations: [], conflicts: [] }
    : { ...base, outcome: "eligible", operations: [], conflicts: [] };
}

function args(
  overrides: Partial<MapSelectiveDryRunReceiptArgs> = {},
): MapSelectiveDryRunReceiptArgs {
  return {
    preview: previewOf([previewPath("src/a.ts", "restored")]),
    plan: planOf([classification("src/a.ts")]),
    sessionId: SESSION_ID,
    checkpointId: CHECKPOINT_ID,
    contributionSha256: DIGEST,
    selectors: { only: ["src/**"] },
    rollbackId: ROLLBACK_ID,
    writtenAt: WRITTEN_AT,
    ...overrides,
  };
}

type DryRunReceipt = Extract<SelectiveRollbackReceipt, { mode: "dry_run" }>;

function mapped(overrides: Partial<MapSelectiveDryRunReceiptArgs> = {}): DryRunReceipt {
  const result = mapSelectiveDryRunReceipt(args(overrides));
  if (result.outcome !== "mapped") {
    throw new Error(`expected a receipt, got a failure: ${String(result.cause)}`);
  }
  if (result.receipt.mode !== "dry_run") throw new Error("expected a dry-run receipt");
  return result.receipt;
}

function failure(
  overrides: Partial<MapSelectiveDryRunReceiptArgs> = {},
): Extract<ReceiptMapping, { outcome: "failed" }> {
  const result = mapSelectiveDryRunReceipt(args(overrides));
  if (result.outcome !== "failed") throw new Error("expected the mapping to fail");
  return result;
}

describe("mapSelectiveDryRunReceipt: the receipt it builds", () => {
  it("carries the caller's identities, since no attempt marker exists", () => {
    const receipt = mapped();
    expect(receipt.session_id).toBe(SESSION_ID);
    expect(receipt.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(receipt.contribution_sha256).toBe(DIGEST);
    expect(receipt.rollback_id).toBe(ROLLBACK_ID);
    expect(receipt.written_at).toBe(WRITTEN_AT);
  });

  it("projects every preview path, sorted by path then change group", () => {
    const receipt = mapped({
      preview: previewOf([
        previewPath("src/c.ts", "modified_since", GROUP_B),
        previewPath("src/a.ts", "restored", GROUP_A),
        previewPath("src/b.ts", "already_at_before", GROUP_B),
      ]),
      plan: planOf([
        classification("src/c.ts", GROUP_B),
        classification("src/a.ts", GROUP_A),
        classification("src/b.ts", GROUP_B),
      ]),
    });

    expect(receipt.results.map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(receipt.results.map((r) => r.outcome)).toEqual([
      "restored",
      "already_at_before",
      "modified_since",
    ]);
  });

  it("carries a preview detail through as the result's reason", () => {
    const receipt = mapped({
      preview: previewOf([
        previewPath("src/a.ts", "missing_evidence", GROUP_A, "the contribution asserts more"),
      ]),
    });
    expect(receipt.results[0]?.reason).toBe("the contribution asserts more");
  });

  it("writes the PLANNER's resolved groups, not a set derived from the preview", () => {
    const receipt = mapped({
      preview: previewOf([
        previewPath("src/a.ts", "restored", GROUP_A),
        previewPath("src/b.ts", "restored", GROUP_B),
      ]),
      plan: planOf([classification("src/a.ts", GROUP_A), classification("src/b.ts", GROUP_B)]),
    });
    expect(receipt.resolved_change_group_ids).toEqual([GROUP_A, GROUP_B]);
  });

  it("is deterministic: the same inputs produce the same receipt", () => {
    // `rollbackId` and `writtenAt` are inputs precisely so this holds.
    expect(mapped()).toEqual(mapped());
  });
});

describe("mapSelectiveDryRunReceipt: eligibility is three-way", () => {
  it("eligible when every path would be restored or is already at before", () => {
    expect(
      mapped({
        preview: previewOf([
          previewPath("src/a.ts", "restored", GROUP_A),
          previewPath("src/b.ts", "already_at_before", GROUP_B),
        ]),
        plan: planOf([classification("src/a.ts", GROUP_A), classification("src/b.ts", GROUP_B)]),
      }).eligibility,
    ).toBe("eligible");
  });

  it.each([
    ["modified_since"],
    ["unsupported_state"],
    ["missing_evidence"],
  ] as const)("ineligible when any path is %s", (outcome) => {
    expect(
      mapped({
        preview: previewOf([
          previewPath("src/a.ts", "restored", GROUP_A),
          previewPath("src/b.ts", outcome, GROUP_B),
        ]),
        plan: planOf([classification("src/a.ts", GROUP_A), classification("src/b.ts", GROUP_B)]),
      }).eligibility,
    ).toBe("ineligible");
  });

  it("empty_selection for an empty preview, which `every` alone would call eligible", () => {
    const receipt = mapped({ preview: previewOf([]), plan: planOf([]) });
    expect(receipt.eligibility).toBe("empty_selection");
    expect(receipt.results).toEqual([]);
    expect(receipt.resolved_change_group_ids).toEqual([]);
  });
});

describe("mapEmptySelectiveDryRunReceipt: a selection that resolved to nothing", () => {
  const identity: SelectiveDryRunReceiptIdentity = {
    sessionId: SESSION_ID,
    checkpointId: CHECKPOINT_ID,
    contributionSha256: DIGEST,
    selectors: { only: ["nothing/matches/**"] },
    rollbackId: ROLLBACK_ID,
    writtenAt: WRITTEN_AT,
  };

  function emptyReceipt(): DryRunReceipt {
    const result = mapEmptySelectiveDryRunReceipt(identity);
    if (result.outcome !== "mapped") {
      throw new Error(`expected a receipt, got a failure: ${String(result.cause)}`);
    }
    if (result.receipt.mode !== "dry_run") throw new Error("expected a dry-run receipt");
    return result.receipt;
  }

  it("is a real receipt: empty_selection, no results, no resolved groups", () => {
    const receipt = emptyReceipt();
    expect(receipt.eligibility).toBe("empty_selection");
    expect(receipt.results).toEqual([]);
    expect(receipt.resolved_change_group_ids).toEqual([]);
  });

  it("records the selectors that matched nothing, which is the whole point", () => {
    // A receipt saying "nothing matched" is only meaningful beside what was
    // asked for and what it was asked of.
    const receipt = emptyReceipt();
    expect(receipt.selectors).toEqual({ only: ["nothing/matches/**"] });
    expect(receipt.session_id).toBe(SESSION_ID);
    expect(receipt.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(receipt.contribution_sha256).toBe(DIGEST);
    expect(receipt.rollback_id).toBe(ROLLBACK_ID);
    expect(receipt.written_at).toBe(WRITTEN_AT);
  });

  it("is byte-for-byte what the preview path produces for an empty preview", () => {
    // The two entry points assemble through one function, and this is what
    // proves it. A second assembler could satisfy the schema's
    // `empty_selection` coupling today and drift from it later.
    const viaPreview = mapped({
      ...identity,
      preview: previewOf([]),
      plan: planOf([]),
    });
    expect(emptyReceipt()).toEqual(viaPreview);
  });
});

describe("mapSelectiveDryRunReceipt: disagreements fail as values", () => {
  it("a path the preview reports under two groups is unrepresentable", () => {
    // The explicit boundary: a preview may report this, a receipt may not,
    // because results must have unique paths.
    const result = failure({
      preview: previewOf([
        previewPath("src/a.ts", "restored", GROUP_A),
        previewPath("src/a.ts", "missing_evidence", GROUP_B),
      ]),
      plan: planOf([classification("src/a.ts", GROUP_A), classification("src/a.ts", GROUP_B)]),
    });
    expect(String(result.cause)).toContain("unique paths");
  });

  it("a duplicated classification path in the plan", () => {
    expect(
      String(
        failure({
          preview: previewOf([previewPath("src/a.ts", "restored")]),
          plan: planOf([classification("src/a.ts"), classification("src/a.ts", GROUP_B)]),
        }).cause,
      ),
    ).toBeDefined();
  });

  it("a path substituted within the same group, which a group check cannot see", () => {
    const result = failure({
      preview: previewOf([previewPath("src/z.ts", "restored", GROUP_A)]),
      plan: planOf([classification("src/a.ts", GROUP_A)]),
    });
    expect(String(result.cause)).toContain("pairs differ");
  });

  it("a plan authorizing a group it never classified", () => {
    // Proves the resolved list is the PLANNER's and is checked: a
    // preview-derived list would have quietly dropped GROUP_C.
    const result = failure({
      plan: planOf([classification("src/a.ts", GROUP_A)], [GROUP_A, GROUP_C]),
    });
    expect(String(result.cause)).toContain("did not classify");
  });

  it("a schema-invalid identity", () => {
    expect(failure({ sessionId: "not-a-session-id" }).cause).toBeDefined();
  });
});
