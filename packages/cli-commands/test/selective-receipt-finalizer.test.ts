// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/cli-commands/src/selective-receipt-finalizer.ts.
//
// NO MOCKS. Every reconciliation branch is reachable with real filesystem
// states, and each one is set up by putting the destination into that state
// rather than by intercepting a call:
//
//   not_written    the invocation directory does not exist, so the temp write
//                  fails and the destination is genuinely absent
//   indeterminate  a DIRECTORY sits at the receipt path, so the link fails and
//                  reading it fails with EISDIR rather than ENOENT
//   conflicting    a different receipt, or unparseable bytes, are already there
//   already_identical  the same finalization runs twice
//
// That matters here more than usual: the branch under test is chosen by which
// errno the filesystem produced, so a stubbed error would be testing the stub's
// idea of the errno rather than the platform's.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollbackInvocationDir, rollbackInvocationPaths } from "@viberevert/core";
import { ROLLBACK_ATTEMPT_SCHEMA_VERSION, RollbackAttemptSchema } from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FinalizationOutcome,
  type FinalizeSelectiveReceiptArgs,
  finalizeSelectiveReceipt,
} from "../src/selective-receipt-finalizer.js";

/** THE ONLY CAST: git's deep types are not constructible from this package. */
function shape<T>(value: unknown): T {
  return value as T;
}

const SESSION_ID = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ROLLBACK_ID = "rb_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const CHECKPOINT_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RECOVERY_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const DIGEST = "a".repeat(64);
const GROUP_A = `cg_${"0".repeat(63)}1`;
const GROUP_B = `cg_${"0".repeat(63)}2`;
const WRITTEN_AT = "2026-03-04T05:06:07Z";

const ATTEMPT = RollbackAttemptSchema.parse({
  schema_version: ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  rollback_id: ROLLBACK_ID,
  session_id: SESSION_ID,
  contribution_sha256: DIGEST,
  pre_rollback_checkpoint_id: RECOVERY_ID,
  selection: {
    selectors: { only: ["src/**"] },
    resolved_change_group_ids: [GROUP_A],
  },
  state: "mutation_may_have_started",
  written_at: "2026-01-01T00:00:00Z",
});

const RECOVERY = {
  status: "created",
  checkpointId: RECOVERY_ID,
  checkpointDir: `.viberevert/checkpoints/${RECOVERY_ID}`,
} as const;

type Args = FinalizeSelectiveReceiptArgs;

const planOf = (...classifications: readonly { path: string; changeGroupId: string }[]) =>
  shape<Args["plan"]>({ classifications });

const PLAN = planOf({ path: "src/a.ts", changeGroupId: GROUP_A });

const SOURCE = shape<Args["source"]>({
  kind: "gate_result",
  transaction: {
    outcome: "settled",
    gate: {
      outcome: "mutation_completed",
      attempt: ATTEMPT,
      rollbackDir: "unused",
      progress: {},
    },
    verification: {
      candidates: [{ path: "src/a.ts", changeGroupId: GROUP_A, outcome: "restored" }],
      violations: [],
      observedHeadSha: "0".repeat(40),
      unselectedCheckedCount: 7,
    },
    commandPhase: {
      execution: { outcome: "not_configured" },
      integrity: { outcome: "not_run" },
    },
    cleanupWarnings: [],
  },
});

let repoRoot: string;
let receiptPath: string;
let invocationDir: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-finalizer-"));
  invocationDir = rollbackInvocationDir(repoRoot, SESSION_ID, ROLLBACK_ID);
  receiptPath = rollbackInvocationPaths(invocationDir).receiptPath;
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function args(overrides: Partial<Args> = {}): Args {
  return {
    repoRoot,
    sessionId: SESSION_ID,
    rollbackId: ROLLBACK_ID,
    source: SOURCE,
    plan: PLAN,
    recovery: RECOVERY,
    checkpointId: CHECKPOINT_ID,
    writtenAt: WRITTEN_AT,
    commandsConfigured: false,
    ...overrides,
  };
}

const finalize = (overrides: Partial<Args> = {}): Promise<FinalizationOutcome> =>
  finalizeSelectiveReceipt(args(overrides));

function expectFinalized(outcome: FinalizationOutcome) {
  if (outcome.kind !== "finalized") {
    throw new Error(`expected finalized, got ${outcome.kind}`);
  }
  return outcome;
}

function expectWriteFailure(outcome: FinalizationOutcome) {
  if (outcome.kind !== "finalization_failed") {
    throw new Error("expected finalization_failed, got finalized");
  }
  if (outcome.failure.phase !== "write_receipt") {
    throw new Error(`expected a write_receipt failure, got ${outcome.failure.phase}`);
  }
  return outcome.failure;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

describe("finalizeSelectiveReceipt: first publication", () => {
  it("writes the receipt and reports how", async () => {
    await mkdir(invocationDir, { recursive: true });

    const outcome = expectFinalized(await finalize());

    expect(outcome.how).toBe("written");
    expect(outcome.recovery).toBe(RECOVERY);
    expect(outcome.source).toBe(SOURCE);
    expect(outcome.receipt.rollback_id).toBe(ROLLBACK_ID);
  });

  it("publishes exactly the bytes it serialized, with a trailing newline", async () => {
    await mkdir(invocationDir, { recursive: true });
    const outcome = expectFinalized(await finalize());

    const onDisk = await readFile(receiptPath, "utf8");
    expect(onDisk).toBe(`${JSON.stringify(outcome.receipt, null, 2)}\n`);
    expect(onDisk.endsWith("\n")).toBe(true);
  });

  it("leaves no temp sibling behind", async () => {
    await mkdir(invocationDir, { recursive: true });
    await finalize();
    expect(await exists(`${receiptPath}.tmp`)).toBe(false);
  });
});

describe("finalizeSelectiveReceipt: reconciliation after a rejected write", () => {
  it("already_identical when the same finalization ran before", async () => {
    await mkdir(invocationDir, { recursive: true });
    expect(expectFinalized(await finalize()).how).toBe("written");

    // The real retry: identical inputs produce identical bytes, so the second
    // call must recognize its own work rather than report a conflict.
    expect(expectFinalized(await finalize()).how).toBe("already_identical");
  });

  it("conflicting when a DIFFERENT but valid receipt is already there", async () => {
    await mkdir(invocationDir, { recursive: true });
    await finalize();

    const published = JSON.parse(await readFile(receiptPath, "utf8"));
    await rm(receiptPath);
    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...published, written_at: "2020-01-01T00:00:00Z" }, null, 2)}\n`,
    );

    const failure = expectWriteFailure(await finalize());
    expect(failure.reason).toBe("conflicting");
  });

  it("conflicting when the destination holds unparseable bytes", async () => {
    await mkdir(invocationDir, { recursive: true });
    await writeFile(receiptPath, "not json at all\n");

    const failure = expectWriteFailure(await finalize());
    expect(failure.reason).toBe("conflicting");
  });

  it("not_written when the destination is genuinely absent", async () => {
    // The invocation directory was never created, so the temp write fails and
    // nothing reached the destination.
    const failure = expectWriteFailure(await finalize());
    expect(failure.reason).toBe("not_written");
    expect(await exists(receiptPath)).toBe(false);
  });

  it("indeterminate when the destination cannot be read", async () => {
    // A directory at the receipt path: the link fails because something is
    // there, and reading it fails with EISDIR rather than ENOENT.
    await mkdir(receiptPath, { recursive: true });

    const failure = expectWriteFailure(await finalize());
    expect(failure.reason).toBe("indeterminate");
  });

  it("carries the intended receipt and the original write rejection", async () => {
    await mkdir(invocationDir, { recursive: true });
    await writeFile(receiptPath, "not json at all\n");

    const failure = expectWriteFailure(await finalize());
    // The intended receipt survives so an operator can see what WOULD have been
    // recorded, and the cause is the write rejection that stopped it.
    expect(failure.intendedReceipt.rollback_id).toBe(ROLLBACK_ID);
    expect(failure.cause).toBeDefined();
  });
});

describe("finalizeSelectiveReceipt: a mapping failure touches nothing", () => {
  it("returns a map_receipt failure without creating a file", async () => {
    await mkdir(invocationDir, { recursive: true });

    // The plan's change groups disagree with the authorized selection, so no
    // receipt exists to write.
    const outcome = await finalize({ plan: planOf({ path: "src/a.ts", changeGroupId: GROUP_B }) });

    if (outcome.kind !== "finalization_failed") {
      throw new Error("expected finalization_failed");
    }
    expect(outcome.failure.phase).toBe("map_receipt");
    expect(await exists(receiptPath)).toBe(false);
  });

  it("keeps the source and recovery handle on the failure arm", async () => {
    const outcome = await finalize({ plan: planOf({ path: "src/a.ts", changeGroupId: GROUP_B }) });
    if (outcome.kind !== "finalization_failed") {
      throw new Error("expected finalization_failed");
    }
    expect(outcome.recovery).toBe(RECOVERY);
    expect(outcome.source).toBe(SOURCE);
  });
});
