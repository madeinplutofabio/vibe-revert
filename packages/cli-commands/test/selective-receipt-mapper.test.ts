// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/cli-commands/src/selective-receipt-mapper.ts.
//
// The mapper turns transaction evidence into the durable artifact an operator
// reads after a recovery went wrong, so the cases that matter are the ones
// where it could claim MORE than the evidence supports: per-path outcomes with
// no verification behind them, bindings taken from anywhere but the attempt,
// and violations that vanish between the verifier and the receipt.
//
// ONE CAST, in `shape`. The git transaction, the verification result and the
// plan are deep types the git barrel does not export, and a test must not reach
// for them through internal module paths. Attempt markers are REAL, parsed
// through their own schema, because every authorization binding is copied from
// one and a fake would make those assertions meaningless.

import {
  ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  RollbackAttemptSchema,
  type SelectiveRollbackReceipt,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import {
  type MapSelectiveReceiptArgs,
  mapSelectiveRollbackReceipt,
  type ReceiptMapping,
} from "../src/selective-receipt-mapper.js";

/**
 * THE ONLY CAST IN THIS FILE.
 *
 * Each fixture supplies the fields the mapper actually reads. The real shapes
 * carry much more (`observedState`, `oracleState`, scheduler progress), none of
 * which the mapper touches, and none of which a test can construct without
 * importing git internals.
 *
 * It is also what lets the last group construct values the types forbid, which
 * is exactly what the fail-closed paths must be tested with.
 */
function shape<T>(value: unknown): T {
  return value as T;
}

// ---- Identities -------------------------------------------------------------

const SESSION_ID = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ROLLBACK_ID = "rb_01ARZ3NDEKTSV4RRFFQ69G5FA1";
/** The session checkpoint restored FROM. */
const CHECKPOINT_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** E, the emergency checkpoint. */
const RECOVERY_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const OTHER_CHECKPOINT_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FB2";
const DIGEST = "a".repeat(64);
const GROUP_A = `cg_${"0".repeat(63)}1`;
const GROUP_B = `cg_${"0".repeat(63)}2`;
const ROLLBACK_DIR = `.viberevert/sessions/${SESSION_ID}/rollbacks/${ROLLBACK_ID}`;

/** Deliberately different from the attempt's, so reuse is detectable. */
const WRITTEN_AT = "2026-03-04T05:06:07Z";
const ATTEMPT_WRITTEN_AT = "2026-01-01T00:00:00Z";

const SELECTORS = { only: ["src/**"] } as const;

const ATTEMPT = RollbackAttemptSchema.parse({
  schema_version: ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  rollback_id: ROLLBACK_ID,
  session_id: SESSION_ID,
  contribution_sha256: DIGEST,
  pre_rollback_checkpoint_id: RECOVERY_ID,
  selection: { selectors: SELECTORS, resolved_change_group_ids: [GROUP_A] },
  state: "mutation_may_have_started",
  written_at: ATTEMPT_WRITTEN_AT,
});

/** Authorizes BOTH groups, for the multi-group projection cases. */
const ATTEMPT_AB = RollbackAttemptSchema.parse({
  schema_version: ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  rollback_id: ROLLBACK_ID,
  session_id: SESSION_ID,
  contribution_sha256: DIGEST,
  pre_rollback_checkpoint_id: RECOVERY_ID,
  selection: { selectors: SELECTORS, resolved_change_group_ids: [GROUP_A, GROUP_B] },
  state: "mutation_may_have_started",
  written_at: ATTEMPT_WRITTEN_AT,
});

const RECOVERY = {
  status: "created",
  checkpointId: RECOVERY_ID,
  checkpointDir: `.viberevert/checkpoints/${RECOVERY_ID}`,
} as const;

// ---- Plan, verification, transaction ----------------------------------------

const classification = (path: string, changeGroupId: string = GROUP_A) => ({
  path,
  changeGroupId,
});

const planOf = (...classifications: readonly ReturnType<typeof classification>[]) =>
  shape<MapSelectiveReceiptArgs["plan"]>({ classifications });

const PLAN = planOf(classification("src/a.ts"));

const candidate = (path: string, outcome: string, changeGroupId: string = GROUP_A) => ({
  path,
  changeGroupId,
  outcome,
});

const violation = (kind: string, path: string) => ({ kind, path, detail: `${kind} at ${path}` });

function verificationOf(parts: {
  readonly candidates?: readonly unknown[];
  readonly violations?: readonly unknown[];
  readonly unselectedCheckedCount?: number;
}) {
  return {
    candidates: parts.candidates ?? [candidate("src/a.ts", "restored")],
    violations: parts.violations ?? [],
    observedHeadSha: "0".repeat(40),
    unselectedCheckedCount: parts.unselectedCheckedCount ?? 7,
  };
}

const CLEAN_VERIFICATION = verificationOf({});

const GATE = {
  outcome: "mutation_completed",
  attempt: ATTEMPT,
  rollbackDir: ROLLBACK_DIR,
  progress: {},
};

const NOT_CONFIGURED_PHASE = {
  execution: { outcome: "not_configured" },
  integrity: { outcome: "not_run" },
};

const settled = (
  commandPhase: unknown = NOT_CONFIGURED_PHASE,
  verification: unknown = CLEAN_VERIFICATION,
  gate: unknown = GATE,
) => ({ outcome: "settled", gate, verification, commandPhase, cleanupWarnings: [] });

type Source = MapSelectiveReceiptArgs["source"];

const gateSource = (transaction: unknown): Source =>
  shape<Source>({ kind: "gate_result", transaction });

const inspectedSource = (): Source =>
  shape<Source>({
    kind: "inspected_publication",
    transaction: {
      outcome: "failed",
      phase: "oracle_callback",
      marker: { status: "possibly_published" },
      cause: "boom",
      cleanupWarnings: [],
    },
    inspection: { outcome: "published", rollbackDir: ROLLBACK_DIR, attempt: ATTEMPT },
  });

function args(overrides: Partial<MapSelectiveReceiptArgs> = {}): MapSelectiveReceiptArgs {
  return {
    source: gateSource(settled()),
    plan: PLAN,
    recovery: RECOVERY,
    checkpointId: CHECKPOINT_ID,
    writtenAt: WRITTEN_AT,
    commandsConfigured: false,
    ...overrides,
  };
}

// ---- Assertions -------------------------------------------------------------

type ApplyReceipt = Extract<SelectiveRollbackReceipt, { mode: "apply" }>;

function expectFailed(result: ReceiptMapping): unknown {
  if (result.outcome !== "failed") {
    throw new Error("expected the mapping to fail, but it produced a receipt");
  }
  return result.cause;
}

function mapped(overrides: Partial<MapSelectiveReceiptArgs> = {}): ApplyReceipt {
  const result = mapSelectiveRollbackReceipt(args(overrides));
  if (result.outcome !== "mapped") {
    throw new Error(`expected a receipt, got a failure: ${String(result.cause)}`);
  }
  if (result.receipt.mode !== "apply") {
    throw new Error("expected an apply receipt");
  }
  return result.receipt;
}

const failedWith = (overrides: Partial<MapSelectiveReceiptArgs> = {}): unknown =>
  expectFailed(mapSelectiveRollbackReceipt(args(overrides)));

// =============================================================================
// Authorization bindings
// =============================================================================

describe("every authorization binding is copied from the attempt", () => {
  it("takes the five bindings and the selection from the marker", () => {
    const receipt = mapped();
    expect(receipt.rollback_id).toBe(ROLLBACK_ID);
    expect(receipt.session_id).toBe(SESSION_ID);
    expect(receipt.contribution_sha256).toBe(DIGEST);
    expect(receipt.pre_rollback_checkpoint_id).toBe(RECOVERY_ID);
    expect(receipt.selectors).toEqual(SELECTORS);
    expect(receipt.resolved_change_group_ids).toEqual([GROUP_A]);
  });

  it("takes checkpoint_id from the caller, since the attempt names E instead", () => {
    const receipt = mapped();
    expect(receipt.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(receipt.checkpoint_id).not.toBe(receipt.pre_rollback_checkpoint_id);
  });

  it("takes written_at from the caller and never reuses the attempt's", () => {
    // The attempt's `written_at` means "when the attempt began". Reusing it
    // would date the receipt to the wrong moment.
    const receipt = mapped();
    expect(receipt.written_at).toBe(WRITTEN_AT);
    expect(receipt.written_at).not.toBe(ATTEMPT_WRITTEN_AT);
  });
});

// =============================================================================
// No verification means no per-path claims
// =============================================================================

const allIndeterminate = (receipt: ApplyReceipt): boolean =>
  receipt.results.length > 0 && receipt.results.every((r) => r.outcome === "indeterminate");

describe("sources and outcomes with no completed verification", () => {
  it("inspected_publication: indeterminate results and three gate_result_unavailable records", () => {
    const receipt = mapped({ source: inspectedSource(), commandsConfigured: true });

    expect(allIndeterminate(receipt)).toBe(true);
    expect(receipt.first_verification).toEqual({
      state: "not_run",
      reason: "gate_result_unavailable",
    });
    expect(receipt.project_verification).toEqual({
      state: "skipped",
      reason: "gate_result_unavailable",
    });
    expect(receipt.post_command_integrity).toEqual({
      state: "not_run",
      reason: "gate_result_unavailable",
    });
    expect(receipt.outcome).toBe("failed");
  });

  it("inspected_publication with no commands configured says so instead", () => {
    const receipt = mapped({ source: inspectedSource(), commandsConfigured: false });
    expect(receipt.project_verification).toEqual({ state: "not_configured" });
    expect(receipt.post_command_integrity).toEqual({
      state: "not_run",
      reason: "commands_not_configured",
    });
  });

  it("verification_failed: indeterminate results and a failed first verification", () => {
    const receipt = mapped({
      source: gateSource({
        outcome: "verification_failed",
        gate: GATE,
        cause: new Error("the verifier threw"),
        cleanupWarnings: [],
      }),
    });
    expect(allIndeterminate(receipt)).toBe(true);
    expect(receipt.first_verification.state).toBe("failed");
    expect(receipt.outcome).toBe("failed");
  });

  it("post_marker_failed: indeterminate results despite carrying a verification", () => {
    const receipt = mapped({
      source: gateSource({
        outcome: "post_marker_failed",
        gate: GATE,
        verification: CLEAN_VERIFICATION,
        cause: new Error("evaluating the verification threw"),
        cleanupWarnings: [],
      }),
    });
    // The candidates exist, but the predicates that would interpret them are
    // what faulted, so the receipt reports no per-path facts.
    expect(allIndeterminate(receipt)).toBe(true);
    expect(receipt.first_verification.state).toBe("failed");
  });

  it("post_marker_failed never touches its verification again", () => {
    // Every field the mapper could read throws. Mapping must still succeed,
    // which proves the success calculation short-circuits on the failed first
    // verification BEFORE re-entering the predicates that already faulted.
    const hostile = Object.defineProperties(
      {},
      {
        candidates: {
          get() {
            throw new Error("read candidates");
          },
        },
        violations: {
          get() {
            throw new Error("read violations");
          },
        },
        unselectedCheckedCount: {
          get() {
            throw new Error("read unselectedCheckedCount");
          },
        },
      },
    );

    const receipt = mapped({
      source: gateSource({
        outcome: "post_marker_failed",
        gate: GATE,
        verification: hostile,
        cause: new Error("evaluating the verification threw"),
        cleanupWarnings: [],
      }),
    });
    expect(allIndeterminate(receipt)).toBe(true);
  });

  it("the runtime-dead published-marker failure fails as a value", () => {
    expect(
      failedWith({
        source: gateSource({
          outcome: "failed",
          phase: "oracle_callback",
          marker: { status: "published", gate: GATE },
          cause: "boom",
          cleanupWarnings: [],
        }),
      }),
    ).toBeInstanceOf(Error);
  });
});

// =============================================================================
// A completed verification projects candidates exactly
// =============================================================================

describe("completed verification", () => {
  it("projects candidates 1:1 and sorts by path then change group", () => {
    const plan = planOf(
      classification("src/b.ts", GROUP_A),
      classification("src/a.ts", GROUP_B),
      classification("src/c.ts", GROUP_A),
    );
    const verification = verificationOf({
      candidates: [
        candidate("src/c.ts", "failed", GROUP_A),
        candidate("src/a.ts", "already_at_before", GROUP_B),
        candidate("src/b.ts", "restored", GROUP_A),
      ],
    });

    // The attempt must authorize BOTH groups: the mapper refuses a plan whose
    // groups differ from the authorized selection, which the first draft of
    // this test tripped over.
    const receipt = mapped({
      plan,
      source: gateSource(
        settled(NOT_CONFIGURED_PHASE, verification, { ...GATE, attempt: ATTEMPT_AB }),
      ),
    });

    expect(receipt.results.map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(receipt.results.map((r) => r.outcome)).toEqual([
      "already_at_before",
      "restored",
      "failed",
    ]);
  });

  it("carries the verification's own unselected count into the assessment", () => {
    const receipt = mapped({
      source: gateSource(
        settled(NOT_CONFIGURED_PHASE, verificationOf({ unselectedCheckedCount: 41 })),
      ),
    });
    if (receipt.first_verification.state !== "completed") throw new Error("expected completed");
    expect(receipt.first_verification.assessment.unselected_checked_count).toBe(41);
  });

  it("reports success only when every dimension is clean", () => {
    expect(mapped().outcome).toBe("succeeded");
  });
});

// =============================================================================
// Violation scoping
// =============================================================================

describe("path-scoped violations are filed on the correct side", () => {
  const withViolations = (violations: readonly unknown[], candidates?: readonly unknown[]) =>
    mapped({
      source: gateSource(
        settled(
          NOT_CONFIGURED_PHASE,
          // Conditional spread rather than `candidates: undefined`, which
          // `exactOptionalPropertyTypes` rejects.
          verificationOf({ violations, ...(candidates === undefined ? {} : { candidates }) }),
        ),
      ),
    });

  const assessmentOf = (receipt: ApplyReceipt) => {
    if (receipt.first_verification.state !== "completed") throw new Error("expected completed");
    return receipt.first_verification.assessment;
  };

  it("files an UNSELECTED unattributed_change under unselected_violations", () => {
    const receipt = withViolations([violation("unattributed_change", "src/other.ts")]);
    expect(assessmentOf(receipt).unselected_violations).toEqual(["src/other.ts"]);
  });

  it("does NOT file a SELECTED unattributed_change there", () => {
    // Pass 1 raises this kind for a selected already_at_before candidate that
    // drifted. It reaches the receipt through that candidate's outcome.
    const receipt = withViolations(
      [violation("unattributed_change", "src/a.ts")],
      [candidate("src/a.ts", "failed")],
    );
    expect(assessmentOf(receipt).unselected_violations).toEqual([]);
  });

  it("files an unselected inconsistent_evidence, and keeps a selected one out", () => {
    expect(
      assessmentOf(withViolations([violation("inconsistent_evidence", "src/other.ts")]))
        .unselected_violations,
    ).toEqual(["src/other.ts"]);
    expect(
      assessmentOf(
        withViolations(
          [violation("inconsistent_evidence", "src/a.ts")],
          [candidate("src/a.ts", "failed")],
        ),
      ).unselected_violations,
    ).toEqual([]);
  });

  it("files planned_effect_not_verified as unselected: it concerns a non-candidate", () => {
    const receipt = withViolations([violation("planned_effect_not_verified", "src")]);
    expect(assessmentOf(receipt).unselected_violations).toEqual(["src"]);
  });

  it("files unauthorized_topology_change by path, like the other damage kinds", () => {
    const receipt = withViolations([violation("unauthorized_topology_change", "src/other.ts")]);
    expect(assessmentOf(receipt).unselected_violations).toEqual(["src/other.ts"]);
  });

  it("turns head_moved into head_unchanged rather than a path entry", () => {
    const receipt = withViolations([violation("head_moved", "")]);
    const assessment = assessmentOf(receipt);
    expect(assessment.head_unchanged).toBe(false);
    expect(assessment.unselected_violations).toEqual([]);
  });

  it("keeps candidate_not_restored off the unselected list", () => {
    const receipt = withViolations(
      [violation("candidate_not_restored", "src/a.ts")],
      [candidate("src/a.ts", "failed")],
    );
    expect(assessmentOf(receipt).unselected_violations).toEqual([]);
  });
});

// =============================================================================
// Command results, integrity states, torn observations
// =============================================================================

const run = (result: unknown) => ({ command: { command: "npm", args: ["test"] }, result });
const PASSED = run({ outcome: "exited", exitCode: 0 });
const SKIPPED = run({ outcome: "not_run", reason: "earlier_command_did_not_pass" });

const completedPhase = (runs: readonly unknown[], integrity: unknown = { outcome: "clean" }) => ({
  execution: { outcome: "completed", result: { runs, allPassed: false } },
  integrity,
});

describe("command-result translation preserves fields and casing", () => {
  const commandsOf = (middle: unknown) => {
    const receipt = mapped({
      commandsConfigured: true,
      source: gateSource(settled(completedPhase([PASSED, run(middle), SKIPPED]))),
    });
    if (receipt.project_verification.state !== "completed") throw new Error("expected completed");
    return receipt.project_verification.commands;
  };

  it("exited carries exit_code", () => {
    const commands = commandsOf({ outcome: "exited", exitCode: 3 });
    expect(commands[0]?.result).toEqual({ outcome: "exited", exit_code: 0 });
    expect(commands[1]?.result).toEqual({ outcome: "exited", exit_code: 3 });
    expect(commands[2]?.result).toEqual({
      outcome: "not_run",
      reason: "earlier_command_did_not_pass",
    });
  });

  it("signalled carries the signal", () => {
    expect(commandsOf({ outcome: "signalled", signal: "SIGKILL" })[1]?.result).toEqual({
      outcome: "signalled",
      signal: "SIGKILL",
    });
  });

  it("unresolved carries nothing else", () => {
    expect(commandsOf({ outcome: "unresolved" })[1]?.result).toEqual({ outcome: "unresolved" });
  });

  it("unsupported_target renames resolvedTarget to resolved_target", () => {
    expect(
      commandsOf({
        outcome: "unsupported_target",
        resolvedTarget: "C:/npm.cmd",
        kind: "cmd-shim",
      })[1]?.result,
    ).toEqual({
      outcome: "unsupported_target",
      resolved_target: "C:/npm.cmd",
      kind: "cmd-shim",
    });
  });

  it("echoes the configured argv beside the result", () => {
    const commands = commandsOf({ outcome: "exited", exitCode: 1 });
    expect(commands[0]?.command).toBe("npm");
    expect(commands[0]?.args).toEqual(["test"]);
  });
});

describe("evaluated integrity outcomes map distinctly", () => {
  const postOf = (integrity: unknown) =>
    mapped({
      commandsConfigured: true,
      source: gateSource(settled(completedPhase([PASSED], integrity))),
    }).post_command_integrity;

  it("clean", () => {
    expect(postOf({ outcome: "clean" })).toEqual({ state: "clean" });
  });

  it("basis_changed carries no domain claim", () => {
    expect(postOf({ outcome: "basis_changed", before: {}, after: {} })).toEqual({
      state: "basis_changed",
    });
  });

  it("project_mutated flattens the difference into normalized path arrays", () => {
    expect(
      postOf({
        outcome: "project_mutated",
        headMoved: true,
        differences: {
          addedPaths: ["b.txt", "a.txt"],
          removedPaths: [],
          changedPaths: ["c.txt", "c.txt"],
          topologyWatchDifferences: [{ path: "dir" }, { path: "dir" }],
        },
      }),
    ).toEqual({
      state: "project_mutated",
      added_paths: ["a.txt", "b.txt"],
      removed_paths: [],
      changed_paths: ["c.txt"],
      topology_changed_roots: ["dir"],
      head_moved: true,
    });
  });

  it("observation_failed inside the command phase is the after-commands side", () => {
    expect(postOf({ outcome: "observation_failed", cause: new Error("io") })).toEqual({
      state: "observation_failed",
      side: "after_commands",
      failure: { error_code: "internal", message: "io" },
    });
  });

  it("classification_failed is recorded rather than refused", () => {
    expect(postOf({ outcome: "classification_failed", cause: new Error("comparator") })).toEqual({
      state: "classification_failed",
      failure: { error_code: "internal", message: "comparator" },
    });
  });
});

describe("both observation-torn sides map distinctly", () => {
  const torn = { basisMoved: true, headMoved: false, domainStatus: "not_comparable" };

  it("before_commands: commands skipped for an unusable pre-command observation", () => {
    const receipt = mapped({
      commandsConfigured: true,
      source: gateSource({
        outcome: "observation_torn",
        side: "before_commands",
        gate: GATE,
        verification: CLEAN_VERIFICATION,
        torn,
        cleanupWarnings: [],
      }),
    });
    expect(receipt.project_verification).toEqual({
      state: "skipped",
      reason: "pre_command_observation_unusable",
    });
    expect(receipt.post_command_integrity).toEqual({
      state: "observation_torn",
      side: "before_commands",
      basis_moved: true,
      head_moved: false,
      domain_status: "not_comparable",
    });
  });

  it("after_commands: the commands ran and are recorded", () => {
    const receipt = mapped({
      commandsConfigured: true,
      source: gateSource({
        outcome: "observation_torn",
        side: "after_commands",
        gate: GATE,
        verification: CLEAN_VERIFICATION,
        execution: { outcome: "completed", result: { runs: [PASSED], allPassed: true } },
        torn,
        cleanupWarnings: [],
      }),
    });
    expect(receipt.project_verification.state).toBe("completed");
    if (receipt.post_command_integrity.state !== "observation_torn") {
      throw new Error("expected observation_torn");
    }
    expect(receipt.post_command_integrity.side).toBe("after_commands");
  });
});

// =============================================================================
// Everything that must fail as a value
// =============================================================================

describe("disagreements and defects fail as values, never as throws", () => {
  it("a recovery handle the attempt does not name", () => {
    expect(
      failedWith({
        recovery: { status: "created", checkpointId: OTHER_CHECKPOINT_ID, checkpointDir: "x" },
      }),
    ).toBeInstanceOf(Error);
  });

  it("a plan whose change groups differ from the authorized selection", () => {
    expect(failedWith({ plan: planOf(classification("src/a.ts", GROUP_B)) })).toBeInstanceOf(Error);
  });

  it("a duplicated classification path", () => {
    expect(
      failedWith({ plan: planOf(classification("src/a.ts"), classification("src/a.ts")) }),
    ).toBeInstanceOf(Error);
  });

  it("a substituted path inside the same change group", () => {
    // The schema checks group coverage and duplicate paths; neither notices
    // that `src/z.ts` replaced `src/a.ts` within GROUP_A.
    expect(
      failedWith({
        source: gateSource(
          settled(
            NOT_CONFIGURED_PHASE,
            verificationOf({ candidates: [candidate("src/z.ts", "restored")] }),
          ),
        ),
      }),
    ).toBeInstanceOf(Error);
  });

  it("a duplicated candidate path", () => {
    expect(
      failedWith({
        source: gateSource(
          settled(
            NOT_CONFIGURED_PHASE,
            verificationOf({
              candidates: [candidate("src/a.ts", "restored"), candidate("src/a.ts", "failed")],
            }),
          ),
        ),
      }),
    ).toBeInstanceOf(Error);
  });

  it("an execution record that contradicts commandsConfigured", () => {
    expect(failedWith({ commandsConfigured: true })).toBeInstanceOf(Error);
    expect(
      failedWith({
        commandsConfigured: false,
        source: gateSource(settled(completedPhase([PASSED]))),
      }),
    ).toBeInstanceOf(Error);
  });

  it("a schema-invalid result, here an unknown candidate outcome", () => {
    expect(
      failedWith({
        source: gateSource(
          settled(
            NOT_CONFIGURED_PHASE,
            verificationOf({ candidates: [candidate("src/a.ts", "teleported")] }),
          ),
        ),
      }),
    ).toBeDefined();
  });

  it("a hostile getter on the plan", () => {
    // The wrapper is what makes NEVER THROWS true: `safeParse` never sees this.
    const hostilePlan = shape<MapSelectiveReceiptArgs["plan"]>(
      Object.defineProperties(
        {},
        {
          classifications: {
            get() {
              throw new Error("read classifications");
            },
          },
        },
      ),
    );
    const result = mapSelectiveRollbackReceipt(args({ plan: hostilePlan }));
    expect(result.outcome).toBe("failed");
  });

  it("never throws for any of the above", () => {
    expect(() => mapSelectiveRollbackReceipt(args({ commandsConfigured: true }))).not.toThrow();
  });
});
