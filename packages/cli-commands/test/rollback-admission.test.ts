// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/cli-commands/src/rollback-admission.ts.
//
// Two groups:
//
//   1. THE TWELVE-CELL TABLE. Every operation crossed with every history
//      state, driven with a legacy input that admits, so each cell isolates
//      the selective-history dimension.
//
//   2. COMPOSITION. How the two dimensions combine: the short circuit, the
//      legacy-analysis fault split between dry-run and apply, and D75's
//      structured refusal arriving as a legacy primary.
//
// NO MODULE MOCKS. The short-circuit proof uses a LOADED legacy input whose
// collection genuinely throws (the session's own session_id disagrees with the
// target, which `assertRollbackArtifactConsistency` rejects). Receiving a
// selective-history refusal from that input is positive evidence the collector
// was never reached, and a paired control test proves the fixture really does
// throw when the collector IS reached. A mock could only have shown that a
// stub went uncalled, which is a weaker claim about a different object.

import type { StatusEntry } from "@viberevert/git";
import {
  type Manifest,
  SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import {
  deriveRollbackAdmission,
  type LegacyAnalysisInput,
  type RollbackAdmissionVerdict,
  type SelectiveHistoryRefusal,
} from "../src/rollback-admission.js";
import type {
  BlockingInvocation,
  RollbackHistoryScan,
  ScannedInvocation,
} from "../src/rollback-history.js";
import type { CollectRollbackRefusalsParams } from "../src/rollback-orchestration.js";

// =============================================================================
// Fixtures
// =============================================================================

const VALID_ULID = "01ABCDEFGHJKMNPQRSTVWXYZ23";
const SESSION_ID = `sess_${VALID_ULID}`;
const OTHER_SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID = `cp_${VALID_ULID}`;
const RECOVERY_CHECKPOINT_ID = "cp_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const HEAD_SHA = "0".repeat(40);
const DIFFERENT_HEAD_SHA = "a".repeat(40);
const ROLLBACK_ID_EARLY = "rb_01ABCDEFGHJKMNPQRSTVWXYZ23";
const ROLLBACK_ID_LATE = "rb_01JV8Z0N6E7ABCDEFGHJKMNPQR";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  const sessionId = overrides.session_id ?? SESSION_ID;
  return {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: sessionId,
    checkpoint_id: CHECKPOINT_ID,
    started_at: "2026-01-01T00:00:00Z",
    ended_at: "2026-01-01T01:00:00Z",
    before_status_path: `.viberevert/sessions/${sessionId}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${sessionId}/commands.log`,
    after_status_path: `.viberevert/sessions/${sessionId}/after-status.txt`,
    after_status_z_path: `.viberevert/sessions/${sessionId}/after-status.z`,
    ...overrides,
  } as SessionState;
}

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  const sessionId = overrides.session_id ?? SESSION_ID;
  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    captured_at: "2026-01-01T00:00:00Z",
    git: { head_sha: HEAD_SHA, branch: "main", porcelain_v1: "" },
    diffs: {
      unstaged_patch_path: "diffs/unstaged.patch",
      staged_patch_path: "diffs/staged.patch",
    },
    snapshots: {
      tracked_dirty_archive_path: "snapshots/tracked.tar.gz",
      tracked_dirty_paths: [],
      file_hashes: {},
    },
    untracked: {
      archive_path: "snapshots/untracked.tar.gz",
      exclude_patterns: [],
      file_hashes: {},
    },
    rollback_target_description: "test fixture checkpoint",
    ...overrides,
  } as Manifest;
}

function legacyParams(
  overrides: Partial<{
    session: SessionState;
    currentHeadSha: string;
    currentStatus: readonly StatusEntry[];
  }> = {},
): CollectRollbackRefusalsParams {
  return {
    targetSessionId: SESSION_ID,
    session: makeSession(),
    manifest: makeManifest(),
    currentHeadSha: HEAD_SHA,
    currentStatus: [] as readonly StatusEntry[],
    endOfSessionSnapshot: { kind: "present" as const, paths: [] as readonly string[] },
    activeLock: null,
    existingApplyReceipt: null,
    ...overrides,
  };
}

/** Collects cleanly and produces no refusals. */
const CLEAN_LEGACY: LegacyAnalysisInput = { state: "loaded", params: legacyParams() };

/** Collects cleanly and produces one BYPASSABLE refusal (D64 head_mismatch). */
const REFUSING_LEGACY: LegacyAnalysisInput = {
  state: "loaded",
  params: legacyParams({ currentHeadSha: DIFFERENT_HEAD_SHA }),
};

/**
 * COLLECTION throws: the session's own session_id disagrees with the target,
 * which the artifact-consistency guard rejects before any rule is evaluated.
 * Used to observe whether the collector ran at all.
 */
const THROWING_LEGACY: LegacyAnalysisInput = {
  state: "loaded",
  params: legacyParams({ session: makeSession({ session_id: OTHER_SESSION_ID }) }),
};

const LOAD_FAULT = new Error("could not read the legacy apply receipt");
const FAULTED_LEGACY: LegacyAnalysisInput = { state: "faulted", cause: LOAD_FAULT };

// History states.

const H0_UNREADABLE: RollbackHistoryScan = {
  outcome: "unreadable",
  path: `.viberevert/sessions/${SESSION_ID}/rollbacks`,
  detail: "EACCES: permission denied",
};

const H0_INCONSISTENT: RollbackHistoryScan = {
  outcome: "inconsistent",
  path: `.viberevert/sessions/${SESSION_ID}/rollbacks/${ROLLBACK_ID_EARLY}/receipt.json`,
  detail: "a receipt exists with no authorizing attempt marker",
};

function readable(
  invocations: readonly ScannedInvocation[],
  blocking: readonly BlockingInvocation[] = [],
): RollbackHistoryScan {
  return { outcome: "readable", report: { invocations, blocking } };
}

const H1_NO_HISTORY: RollbackHistoryScan = readable([]);

const H1_NEVER_AUTHORIZED: RollbackHistoryScan = readable([
  {
    kind: "never_authorized",
    rollbackId: ROLLBACK_ID_EARLY,
    rollbackDir: `rollbacks/${ROLLBACK_ID_EARLY}`,
  },
]);

const H2_SUCCEEDED: RollbackHistoryScan = readable([
  {
    kind: "finalized",
    rollbackId: ROLLBACK_ID_EARLY,
    rollbackDir: `rollbacks/${ROLLBACK_ID_EARLY}`,
    writtenAt: "2026-02-01T00:00:00Z",
    preRollbackCheckpointId: RECOVERY_CHECKPOINT_ID,
    outcome: "succeeded",
  },
]);

const EARLY_BLOCKER: BlockingInvocation = {
  rollbackId: ROLLBACK_ID_EARLY,
  rollbackDir: `rollbacks/${ROLLBACK_ID_EARLY}`,
  writtenAt: "2026-02-01T00:00:00Z",
  preRollbackCheckpointId: RECOVERY_CHECKPOINT_ID,
  reason: "unfinalized",
};

const LATE_BLOCKER: BlockingInvocation = {
  rollbackId: ROLLBACK_ID_LATE,
  rollbackDir: `rollbacks/${ROLLBACK_ID_LATE}`,
  writtenAt: "2026-02-02T00:00:00Z",
  preRollbackCheckpointId: CHECKPOINT_ID,
  reason: "apply_failed",
};

const H3_BLOCKED: RollbackHistoryScan = readable(
  [
    {
      kind: "unfinalized",
      rollbackId: ROLLBACK_ID_EARLY,
      rollbackDir: EARLY_BLOCKER.rollbackDir,
      writtenAt: EARLY_BLOCKER.writtenAt,
      preRollbackCheckpointId: EARLY_BLOCKER.preRollbackCheckpointId,
    },
    {
      kind: "finalized",
      rollbackId: ROLLBACK_ID_LATE,
      rollbackDir: LATE_BLOCKER.rollbackDir,
      writtenAt: LATE_BLOCKER.writtenAt,
      preRollbackCheckpointId: LATE_BLOCKER.preRollbackCheckpointId,
      outcome: "failed",
    },
  ],
  [EARLY_BLOCKER, LATE_BLOCKER],
);

// =============================================================================
// Narrowing helpers
// =============================================================================

type Admitted = Extract<RollbackAdmissionVerdict, { decision: "admitted" }>;
type Refused = Extract<RollbackAdmissionVerdict, { decision: "refused" }>;
type Failed = Extract<RollbackAdmissionVerdict, { decision: "failed" }>;

function expectAdmitted(verdict: RollbackAdmissionVerdict): Admitted {
  if (verdict.decision !== "admitted") {
    throw new Error(`expected admission, got ${verdict.decision}`);
  }
  return verdict;
}

function expectRefused(verdict: RollbackAdmissionVerdict): Refused {
  if (verdict.decision !== "refused") {
    throw new Error(`expected a refusal, got ${verdict.decision}`);
  }
  return verdict;
}

function expectFailed(verdict: RollbackAdmissionVerdict): Failed {
  if (verdict.decision !== "failed") {
    throw new Error(`expected a failure, got ${verdict.decision}`);
  }
  return verdict;
}

function expectSelectiveRefusal(verdict: RollbackAdmissionVerdict): SelectiveHistoryRefusal {
  const refused = expectRefused(verdict);
  if (refused.primary.source !== "selective_history") {
    throw new Error(`expected a selective-history refusal, got ${refused.primary.source}`);
  }
  return refused.primary.refusal;
}

function expectEvaluatedLegacy(verdict: RollbackAdmissionVerdict) {
  const legacy = expectAdmitted(verdict).legacy;
  if (legacy.state !== "evaluated") {
    throw new Error("expected an evaluated legacy analysis");
  }
  return legacy;
}

function expectFaultedLegacy(verdict: RollbackAdmissionVerdict): unknown {
  const legacy = expectAdmitted(verdict).legacy;
  if (legacy.state !== "faulted") {
    throw new Error("expected a faulted legacy analysis");
  }
  return legacy.cause;
}

/** Every cell of the table is driven with a legacy input that admits. */
function admit(operation: "dry_run" | "selective_apply" | "full_apply", scan: RollbackHistoryScan) {
  return deriveRollbackAdmission({ operation, scan, legacy: CLEAN_LEGACY, force: false });
}

// =============================================================================
// GROUP 1: the twelve-cell selective-history table
// =============================================================================

describe("deriveRollbackAdmission: dry_run is admitted from every history state", () => {
  it("H0 unreadable: admitted, carrying the scan fault", () => {
    const admitted = expectAdmitted(admit("dry_run", H0_UNREADABLE));
    expect(admitted.scan).toEqual({ state: "faulted", fault: H0_UNREADABLE });
  });

  it("H0 inconsistent: admitted, and the fault is not flattened into unreadable", () => {
    const admitted = expectAdmitted(admit("dry_run", H0_INCONSISTENT));
    expect(admitted.scan).toEqual({ state: "faulted", fault: H0_INCONSISTENT });
  });

  it("H1: admitted with a readable scan", () => {
    const admitted = expectAdmitted(admit("dry_run", H1_NEVER_AUTHORIZED));
    expect(admitted.scan.state).toBe("readable");
  });

  it("H2: admitted", () => {
    expect(expectAdmitted(admit("dry_run", H2_SUCCEEDED)).scan.state).toBe("readable");
  });

  it("H3: admitted despite blockers, since a dry run mutates nothing", () => {
    expect(expectAdmitted(admit("dry_run", H3_BLOCKED)).scan.state).toBe("readable");
  });
});

describe("deriveRollbackAdmission: selective_apply", () => {
  it("H0: refused with history_fault", () => {
    const refusal = expectSelectiveRefusal(admit("selective_apply", H0_UNREADABLE));
    expect(refusal.kind).toBe("history_fault");
  });

  it("H1: not refused by the selective-history dimension", () => {
    expect(expectAdmitted(admit("selective_apply", H1_NO_HISTORY)).scan.state).toBe("readable");
  });

  it("H2: selective after selective is not refused by this dimension", () => {
    expect(expectAdmitted(admit("selective_apply", H2_SUCCEEDED)).scan.state).toBe("readable");
  });

  it("H3: refused with prior_apply_incomplete", () => {
    const refusal = expectSelectiveRefusal(admit("selective_apply", H3_BLOCKED));
    expect(refusal.kind).toBe("prior_apply_incomplete");
  });
});

describe("deriveRollbackAdmission: full_apply", () => {
  it("H0: refused with history_fault", () => {
    const refusal = expectSelectiveRefusal(admit("full_apply", H0_INCONSISTENT));
    expect(refusal.kind).toBe("history_fault");
  });

  it("H1: not refused by the selective-history dimension", () => {
    expect(expectAdmitted(admit("full_apply", H1_NEVER_AUTHORIZED)).scan.state).toBe("readable");
  });

  it("H2: refused with selective_apply_already_applied", () => {
    const refusal = expectSelectiveRefusal(admit("full_apply", H2_SUCCEEDED));
    expect(refusal.kind).toBe("selective_apply_already_applied");
  });

  it("H3: refused with prior_apply_incomplete, which outranks the mode refusal", () => {
    const refusal = expectSelectiveRefusal(admit("full_apply", H3_BLOCKED));
    expect(refusal.kind).toBe("prior_apply_incomplete");
  });
});

// =============================================================================
// Selective refusal payloads
// =============================================================================

describe("deriveRollbackAdmission: selective refusal payloads", () => {
  it("history_fault carries the scan member whole", () => {
    const refusal = expectSelectiveRefusal(admit("selective_apply", H0_INCONSISTENT));
    if (refusal.kind !== "history_fault") throw new Error("wrong refusal kind");
    expect(refusal.fault).toEqual(H0_INCONSISTENT);
  });

  it("prior_apply_incomplete names the EARLIEST blocker and carries them all", () => {
    const refusal = expectSelectiveRefusal(admit("selective_apply", H3_BLOCKED));
    if (refusal.kind !== "prior_apply_incomplete") throw new Error("wrong refusal kind");
    expect(refusal.blocker).toEqual(EARLY_BLOCKER);
    expect(refusal.allBlockers).toEqual([EARLY_BLOCKER, LATE_BLOCKER]);
  });

  it("selective_apply_already_applied lists the succeeded rollback ids", () => {
    const refusal = expectSelectiveRefusal(admit("full_apply", H2_SUCCEEDED));
    if (refusal.kind !== "selective_apply_already_applied") throw new Error("wrong refusal kind");
    expect(refusal.appliedInvocations).toEqual([ROLLBACK_ID_EARLY]);
  });

  it("a selective refusal carries only itself, since the legacy list was never computed", () => {
    const refused = expectRefused(admit("selective_apply", H3_BLOCKED));
    expect(refused.refusals).toEqual([refused.primary]);
  });
});

// =============================================================================
// GROUP 2: composition
// =============================================================================

describe("deriveRollbackAdmission: the selective dimension short-circuits the legacy one", () => {
  it("control: the fixture DOES throw when the collector is reached", () => {
    // Without this, the short-circuit test below would pass even if the
    // fixture were harmless.
    const failed = expectFailed(
      deriveRollbackAdmission({
        operation: "selective_apply",
        scan: H1_NO_HISTORY,
        legacy: THROWING_LEGACY,
        force: false,
      }),
    );
    expect(failed.phase).toBe("legacy_analysis");
    expect(String(failed.cause)).toMatch(/session\.session_id/);
  });

  it("a selective refusal is returned even though collecting would have thrown", () => {
    const refusal = expectSelectiveRefusal(
      deriveRollbackAdmission({
        operation: "selective_apply",
        scan: H3_BLOCKED,
        legacy: THROWING_LEGACY,
        force: false,
      }),
    );
    expect(refusal.kind).toBe("prior_apply_incomplete");
  });

  it("the recovery instruction is not preempted by an artifact fault on full_apply", () => {
    const refusal = expectSelectiveRefusal(
      deriveRollbackAdmission({
        operation: "full_apply",
        scan: H0_UNREADABLE,
        legacy: THROWING_LEGACY,
        force: false,
      }),
    );
    expect(refusal.kind).toBe("history_fault");
  });
});

describe("deriveRollbackAdmission: a legacy-analysis fault is not a refusal", () => {
  it("apply with a faulted legacy INPUT fails closed", () => {
    const failed = expectFailed(
      deriveRollbackAdmission({
        operation: "selective_apply",
        scan: H1_NO_HISTORY,
        legacy: FAULTED_LEGACY,
        force: false,
      }),
    );
    expect(failed.phase).toBe("legacy_analysis");
    expect(failed.cause).toBe(LOAD_FAULT);
  });

  it("dry-run with a faulted legacy INPUT is admitted and carries the cause", () => {
    const cause = expectFaultedLegacy(
      deriveRollbackAdmission({
        operation: "dry_run",
        scan: H1_NO_HISTORY,
        legacy: FAULTED_LEGACY,
        force: false,
      }),
    );
    expect(cause).toBe(LOAD_FAULT);
  });

  it("dry-run with a throwing COLLECTION is admitted and carries the cause", () => {
    const cause = expectFaultedLegacy(
      deriveRollbackAdmission({
        operation: "dry_run",
        scan: H1_NO_HISTORY,
        legacy: THROWING_LEGACY,
        force: false,
      }),
    );
    expect(String(cause)).toMatch(/session\.session_id/);
  });

  it("dry-run keeps its scan verdict alongside a faulted legacy analysis", () => {
    const admitted = expectAdmitted(
      deriveRollbackAdmission({
        operation: "dry_run",
        scan: H0_UNREADABLE,
        legacy: FAULTED_LEGACY,
        force: false,
      }),
    );
    expect(admitted.scan).toEqual({ state: "faulted", fault: H0_UNREADABLE });
    expect(admitted.legacy.state).toBe("faulted");
  });
});

describe("deriveRollbackAdmission: D75 refusals arrive as legacy primaries", () => {
  it("an enforced refusal names the legacy member and carries the D76 list", () => {
    const refused = expectRefused(
      deriveRollbackAdmission({
        operation: "selective_apply",
        scan: H1_NO_HISTORY,
        legacy: REFUSING_LEGACY,
        force: false,
      }),
    );
    if (refused.primary.source !== "legacy") throw new Error("expected a legacy primary");
    expect(refused.primary.refusal.kind).toBe("head_mismatch");
    expect(refused.refusals).toEqual([refused.primary]);
  });

  it("--force bypasses it, and the member is still carried for reporting", () => {
    const legacy = expectEvaluatedLegacy(
      deriveRollbackAdmission({
        operation: "selective_apply",
        scan: H1_NO_HISTORY,
        legacy: REFUSING_LEGACY,
        force: true,
      }),
    );
    expect(legacy.refusals.map((r) => r.kind)).toEqual(["head_mismatch"]);
    expect(legacy.outcome.allowHeadMismatch).toBe(true);
  });

  it("dry-run does not enforce it and keeps allowHeadMismatch false", () => {
    const legacy = expectEvaluatedLegacy(
      deriveRollbackAdmission({
        operation: "dry_run",
        scan: H1_NO_HISTORY,
        legacy: REFUSING_LEGACY,
        force: false,
      }),
    );
    expect(legacy.refusals.map((r) => r.kind)).toEqual(["head_mismatch"]);
    expect(legacy.outcome.allowHeadMismatch).toBe(false);
  });

  it("a clean legacy analysis admits with an empty refusal list", () => {
    const legacy = expectEvaluatedLegacy(admit("selective_apply", H1_NO_HISTORY));
    expect(legacy.refusals).toEqual([]);
    expect(legacy.outcome.allowHeadMismatch).toBe(false);
  });
});
