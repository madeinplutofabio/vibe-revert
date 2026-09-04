// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// rollback-history.ts targeted tests.
//
// The scan decides whether another apply may begin and, when it may not, which
// emergency checkpoint the user recovers from. Both answers are unsafe to
// guess, so the discipline here is the same as the schema's: most of the value
// is in the NEGATIVE cases, and every rejection fixture is otherwise valid so
// only the named rule can be the cause.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { primaryBlocker, scanSelectiveRollbackHistory } from "../src/rollback-history.js";

const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CHECKPOINT = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EMERGENCY_A = "cp_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const EMERGENCY_B = "cp_01ARZ3NDEKTSV4RRFFQ69G5FB2";
const DIGEST = "a".repeat(64);
const GROUP = `cg_${"0".repeat(63)}1`;

/** Lower id, LATER timestamp. Pairs with RB_LATE to separate the two orders. */
const RB_EARLY_ID = "rb_01ARZ3NDEKTSV4RRFFQ69G5FA1";
/** Higher id, EARLIER timestamp. */
const RB_LATE_ID = "rb_01ARZ3NDEKTSV4RRFFQ69G5FA9";

const SELECTORS = { only: ["src/**"] };
const SELECTION = { selectors: SELECTORS, resolved_change_group_ids: [GROUP] };

interface AttemptOverrides {
  readonly rollback_id?: string;
  readonly session_id?: string;
  readonly contribution_sha256?: string;
  readonly pre_rollback_checkpoint_id?: string;
  readonly written_at?: string;
  readonly selection?: unknown;
}

function attempt(overrides: AttemptOverrides = {}): Record<string, unknown> {
  return {
    schema_version: ROLLBACK_ATTEMPT_SCHEMA_VERSION,
    rollback_id: RB_EARLY_ID,
    session_id: SESSION,
    contribution_sha256: DIGEST,
    pre_rollback_checkpoint_id: EMERGENCY_A,
    selection: SELECTION,
    state: "mutation_may_have_started",
    written_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

interface ReceiptOverrides {
  readonly rollback_id?: string;
  readonly session_id?: string;
  readonly contribution_sha256?: string;
  readonly pre_rollback_checkpoint_id?: string;
  readonly outcome?: "succeeded" | "failed";
  readonly selectors?: unknown;
  readonly resolved_change_group_ids?: readonly string[];
  readonly results?: readonly unknown[];
}

function receipt(overrides: ReceiptOverrides = {}): Record<string, unknown> {
  return {
    schema_version: SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
    mode: "apply",
    rollback_id: RB_EARLY_ID,
    session_id: SESSION,
    checkpoint_id: CHECKPOINT,
    contribution_sha256: DIGEST,
    pre_rollback_checkpoint_id: EMERGENCY_A,
    selectors: SELECTORS,
    resolved_change_group_ids: [GROUP],
    results: [{ path: "src/a.ts", change_group_id: GROUP, outcome: "restored" }],
    outcome: "succeeded",
    first_verification: {
      state: "completed",
      assessment: {
        selected_verified: true,
        unselected_checked_count: 4,
        unselected_violations: [],
        head_unchanged: true,
      },
    },
    project_verification: { state: "not_configured" },
    post_command_integrity: { state: "not_run", reason: "commands_not_configured" },
    written_at: "2026-01-01T00:00:00Z",
    out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
    ...overrides,
  };
}

interface Fixture {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
  invocation: (rollbackId: string) => Promise<string>;
}

async function setupFixture(sessionId: string = SESSION): Promise<Fixture> {
  const repoRoot = await mkdtemp(join(tmpdir(), "viberevert-history-"));
  const rollbacksDir = join(repoRoot, ".viberevert", "sessions", sessionId, "rollbacks");
  return {
    repoRoot,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
    },
    invocation: async (rollbackId) => {
      const dir = join(rollbacksDir, rollbackId);
      await mkdir(dir, { recursive: true });
      return dir;
    },
  };
}

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, JSON.stringify(value, null, 2), "utf8");

// =============================================================================
// Absence versus unreadability
// =============================================================================

describe("scanSelectiveRollbackHistory absence", () => {
  it("treats a missing rollbacks directory as genuine absence", async () => {
    const f = await setupFixture();
    try {
      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      // The ONLY absence the scan accepts: no directory means no apply was ever
      // authorized for this session.
      expect(scan.outcome).toBe("readable");
      if (scan.outcome !== "readable") throw new Error("expected readable");
      expect(scan.report.invocations).toEqual([]);
      expect(scan.report.blocking).toEqual([]);
      expect(primaryBlocker(scan.report)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it("treats a bare invocation directory as never_authorized and NOT a blocker", async () => {
    const f = await setupFixture();
    try {
      await f.invocation(RB_EARLY_ID);

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      // The marker precedes any mutation, so its absence means nothing was ever
      // authorized to mutate. Publication debris lands here too.
      if (scan.outcome !== "readable") throw new Error("expected readable");
      expect(scan.report.invocations).toEqual([
        { kind: "never_authorized", rollbackId: RB_EARLY_ID, rollbackDir: expect.any(String) },
      ]);
      expect(scan.report.blocking).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});

// =============================================================================
// Fail closed
// =============================================================================

describe("scanSelectiveRollbackHistory fails closed", () => {
  it("reports malformed JSON as unreadable, never as absent", async () => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeFile(join(dir, "attempt.json"), "{ not json", "utf8");

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      expect(scan.outcome).toBe("unreadable");
    } finally {
      await f.cleanup();
    }
  });

  it("reports a schema-invalid marker as unreadable", async () => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(dir, "attempt.json"), attempt({ contribution_sha256: "too-short" }));

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      expect(scan.outcome).toBe("unreadable");
    } finally {
      await f.cleanup();
    }
  });

  it("reports a receipt with no authorizing marker as inconsistent", async () => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(dir, "receipt.json"), receipt());

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      // The marker is written first and never removed, so this cannot have been
      // produced by a normal run.
      expect(scan.outcome).toBe("inconsistent");
    } finally {
      await f.cleanup();
    }
  });

  it("rejects a directory name that is not a valid rollback id", async () => {
    const f = await setupFixture();
    try {
      await f.invocation("not-a-rollback-id");

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      expect(scan.outcome).toBe("inconsistent");
    } finally {
      await f.cleanup();
    }
  });
});

// =============================================================================
// Finalization is a binding, not a file count
// =============================================================================

describe("scanSelectiveRollbackHistory cross-artifact binding", () => {
  it("finalizes when the marker and receipt agree on every shared field", async () => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(dir, "attempt.json"), attempt());
      await writeJson(join(dir, "receipt.json"), receipt());

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      if (scan.outcome !== "readable") throw new Error("expected readable");
      expect(scan.report.invocations[0]).toMatchObject({
        kind: "finalized",
        rollbackId: RB_EARLY_ID,
        outcome: "succeeded",
        preRollbackCheckpointId: EMERGENCY_A,
      });
      expect(scan.report.blocking).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    ["rollback_id", { rollback_id: RB_LATE_ID }],
    ["session_id", { session_id: OTHER_SESSION }],
    ["contribution_sha256", { contribution_sha256: "b".repeat(64) }],
    ["pre_rollback_checkpoint_id", { pre_rollback_checkpoint_id: EMERGENCY_B }],
    [
      "the resolved selection",
      {
        // The results move with the group, so the receipt stays SCHEMA-valid
        // and only the cross-artifact binding can be the cause of rejection.
        resolved_change_group_ids: [`cg_${"0".repeat(63)}2`],
        results: [
          { path: "src/a.ts", change_group_id: `cg_${"0".repeat(63)}2`, outcome: "restored" },
        ],
      },
    ],
    ["the selectors", { selectors: { only: ["other/**"] } }],
  ])("refuses to finalize when the receipt disagrees on %s", async (_label, overrides) => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(dir, "attempt.json"), attempt());
      await writeJson(join(dir, "receipt.json"), receipt(overrides as ReceiptOverrides));

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      // A copied receipt must never launder an unfinalized attempt into a
      // finalized one: doing so would silently unblock an apply over a tree
      // that may be partly mutated.
      expect(scan.outcome).toBe("inconsistent");
    } finally {
      await f.cleanup();
    }
  });

  it("rejects a marker whose rollback_id disagrees with its directory", async () => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(dir, "attempt.json"), attempt({ rollback_id: RB_LATE_ID }));

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      expect(scan.outcome).toBe("inconsistent");
    } finally {
      await f.cleanup();
    }
  });

  it("rejects a marker belonging to another session", async () => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(dir, "attempt.json"), attempt({ session_id: OTHER_SESSION }));

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      expect(scan.outcome).toBe("inconsistent");
    } finally {
      await f.cleanup();
    }
  });
});

// =============================================================================
// Blockers
// =============================================================================

describe("scanSelectiveRollbackHistory blockers", () => {
  it("treats a marker with no sibling receipt as unfinalized and blocking", async () => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(dir, "attempt.json"), attempt());

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      if (scan.outcome !== "readable") throw new Error("expected readable");
      expect(scan.report.blocking).toHaveLength(1);
      expect(scan.report.blocking[0]).toMatchObject({
        rollbackId: RB_EARLY_ID,
        reason: "unfinalized",
        preRollbackCheckpointId: EMERGENCY_A,
      });
    } finally {
      await f.cleanup();
    }
  });

  it("treats a finalized failure as blocking, and a finalized success as not", async () => {
    const f = await setupFixture();
    try {
      const dir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(dir, "attempt.json"), attempt());
      await writeJson(join(dir, "receipt.json"), receipt({ outcome: "failed" }));

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      if (scan.outcome !== "readable") throw new Error("expected readable");
      expect(scan.report.blocking).toHaveLength(1);
      expect(scan.report.blocking[0]?.reason).toBe("apply_failed");
    } finally {
      await f.cleanup();
    }
  });

  it("carries EVERY blocker, ordered by persisted timestamp then by id", async () => {
    const f = await setupFixture();
    try {
      // RB_LATE_ID sorts AFTER RB_EARLY_ID by id, but its marker was written
      // FIRST. If the scan ordered by id, or by traversal order, it would name
      // the wrong recovery handle.
      const earlyDir = await f.invocation(RB_EARLY_ID);
      await writeJson(
        join(earlyDir, "attempt.json"),
        attempt({ written_at: "2026-02-02T00:00:00Z", pre_rollback_checkpoint_id: EMERGENCY_A }),
      );

      const lateDir = await f.invocation(RB_LATE_ID);
      await writeJson(
        join(lateDir, "attempt.json"),
        attempt({
          rollback_id: RB_LATE_ID,
          written_at: "2026-01-01T00:00:00Z",
          pre_rollback_checkpoint_id: EMERGENCY_B,
        }),
      );

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      if (scan.outcome !== "readable") throw new Error("expected readable");
      expect(scan.report.blocking.map((b) => b.rollbackId)).toEqual([RB_LATE_ID, RB_EARLY_ID]);

      // The EARLIEST blocker's checkpoint is the last state before ANY damage.
      // A later one only restores to a state the earlier failure may already
      // have corrupted.
      expect(primaryBlocker(scan.report)?.preRollbackCheckpointId).toBe(EMERGENCY_B);
    } finally {
      await f.cleanup();
    }
  });

  it("breaks a timestamp tie deterministically by rollback id", async () => {
    const f = await setupFixture();
    try {
      const sameInstant = "2026-03-03T00:00:00Z";
      const lateDir = await f.invocation(RB_LATE_ID);
      await writeJson(
        join(lateDir, "attempt.json"),
        attempt({ rollback_id: RB_LATE_ID, written_at: sameInstant }),
      );
      const earlyDir = await f.invocation(RB_EARLY_ID);
      await writeJson(join(earlyDir, "attempt.json"), attempt({ written_at: sameInstant }));

      const scan = await scanSelectiveRollbackHistory(f.repoRoot, SESSION);

      // ULIDs are ordered only to the millisecond, so two markers can share a
      // second-precision timestamp. The id is the tie-break, and the result must
      // not depend on which directory the filesystem listed first.
      if (scan.outcome !== "readable") throw new Error("expected readable");
      expect(scan.report.blocking.map((b) => b.rollbackId)).toEqual([RB_EARLY_ID, RB_LATE_ID]);
    } finally {
      await f.cleanup();
    }
  });
});
