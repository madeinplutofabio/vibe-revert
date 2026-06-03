// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/cli/src/rollback-orchestration.ts (M D
// Step 6 file 6.2 — orchestration coverage).
//
// Seven sections, 57 tests covering the orchestration contract:
//
//   1. ARTIFACT CONSISTENCY via collectRollbackRefusals entry —
//      session_id mismatch (3 paths: session, manifest, existing
//      apply receipt) throws plain Error before any rule evaluation.
//
//   2. collectRollbackRefusals RULE DETECTION (pure) — D63 / D70 /
//      D64 / D61b / D61 detection with the D76-ordered refusals[]
//      list. Includes N5 R/C BOTH-paths rule applied to currentStatus,
//      and the empty-unrelated-dirt case when all current dirt is
//      already in the expected target.
//
//   3. checkRefusals MODE/FORCE ENFORCEMENT — D75 force-policy table:
//      D63 / D70 never bypassed; D64 / D61b / D61 bypassable.
//      Dry-run never throws policy refusals; artifact-integrity throws
//      still fire in both modes.
//
//   4. resolveSessionAndCheckpoint (I/O) — uses REAL loadSession +
//      loadCheckpoint with on-disk fixtures. SessionNotFoundError
//      re-thrown verbatim; checkpoint missing/corrupt/manifest-id-
//      mismatch all wrap as CheckpointArtifactsMissingError (with
//      the manifest-mismatch case also asserting the cause chain
//      contents per the wrapping-semantic lock).
//
//   5. classifyRestoreError — 5 known restore error classes → distinct
//      error_codes with verified field accesses; unknown → internal +
//      mayHaveMutated: true (CONSERVATIVE); ExtractionConflict
//      surfaces BOTH manifestPath + conflictingPath via flatMap;
//      affected_paths sorted-unique uniformly.
//
//   6. buildReceiptForDryRun — plan → results synthesis;
//      skipped_unrelated_dirt entries appended when
//      dirty_tree_check === "performed"; mode/forced/CP fields locked.
//      Includes the rule #12 preflight_failures propagation
//      (empty stays empty; head_mismatch propagates;
//      exclude_drift propagates sorted-unique on unsorted/dup fixture).
//
//   7. buildReceiptForApply — MOCKED restoreCheckpoint
//      (vi.mock with importOriginal partial mock to preserve real
//      error classes for classifier instanceof checks). Three
//      assertions per path: call-args correctness; success →
//      synthesized results + empty failures; rejection → empty
//      results + classified failures.
//
// Fixture-validity discipline: every receipt fixture flows through
// ReceiptFileSchema.parse (when applicable). makeApplyReceipt
// additionally enforces the N4 ExistingApplyReceipt narrowing via
// BOTH a type-level override restriction AND a runtime post-parse
// guard so test code cannot accidentally produce a fixture that
// satisfies ReceiptFileSchema but violates the apply-mode +
// non-null pre_rollback_checkpoint_id contract that production
// code relies on. Checkpoint fixtures satisfy ManifestSchema via
// materialized artifact files.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionNotFoundError } from "@viberevert/core";
import {
  RestoreExcludeDriftError,
  RestoreExtractionConflictError,
  RestoreHeadMismatchError,
  type RestorePlan,
  type RestorePreflightFailure,
  RestoreTrackedDirtyParityError,
  RestoreVerificationError,
  restoreCheckpoint,
  type StatusEntry,
} from "@viberevert/git";
import {
  type ActiveSessionLock,
  type Manifest,
  RECEIPT_FILE_SCHEMA_VERSION,
  type ReceiptFile,
  ReceiptFileSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
} from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @viberevert/git. Only restoreCheckpoint is stubbed
// — the mutation boundary. Real error classes (RestoreHeadMismatchError
// etc.) are preserved so classifyRestoreError's instanceof checks
// keep working. loadCheckpoint is also real so resolveSessionAndCheckpoint
// tests can use on-disk fixtures.
vi.mock("@viberevert/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@viberevert/git")>();
  return {
    ...actual,
    restoreCheckpoint: vi.fn(),
  };
});

import {
  buildReceiptForApply,
  buildReceiptForDryRun,
  CheckpointArtifactsMissingError,
  checkRefusals,
  classifyRestoreError,
  collectRollbackRefusals,
  type ExistingApplyReceipt,
  RollbackActiveSessionRefusalError,
  RollbackAlreadyAppliedError,
  RollbackDirtyTreeRefusalError,
  RollbackHeadMismatchError,
  RollbackUnEndedSessionRefusalError,
  resolveSessionAndCheckpoint,
} from "../src/rollback-orchestration.js";

// =============================================================================
// Fixture constants + builders
// =============================================================================

const VALID_ULID = "01ABCDEFGHJKMNPQRSTVWXYZ23";
const FIXTURE_SESSION_ID = `sess_${VALID_ULID}`;
const FIXTURE_OTHER_SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const FIXTURE_CHECKPOINT_ID = `cp_${VALID_ULID}`;
const FIXTURE_OTHER_CHECKPOINT_ID = "cp_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const FIXTURE_ROLLBACK_ID = `rb_${VALID_ULID}`;
const FIXTURE_HEAD_SHA = "0".repeat(40);
const FIXTURE_DIFFERENT_HEAD_SHA = "a".repeat(40);

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  const sessionId = overrides.session_id ?? FIXTURE_SESSION_ID;
  return {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: sessionId,
    checkpoint_id: FIXTURE_CHECKPOINT_ID,
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
  const sessionId = overrides.session_id ?? FIXTURE_SESSION_ID;
  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    captured_at: "2026-01-01T00:00:00Z",
    git: {
      head_sha: FIXTURE_HEAD_SHA,
      branch: "main",
      porcelain_v1: "",
    },
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

/**
 * Narrowed override surface for makeApplyReceipt fixtures: callers
 * CANNOT set `mode` (locked to "apply" by the helper) and CANNOT
 * set `pre_rollback_checkpoint_id` to null (the N4
 * ExistingApplyReceipt narrowing forbids null). They can still
 * set every other field, including a non-null
 * pre_rollback_checkpoint_id override.
 *
 * This type-level restriction is paired with a runtime post-parse
 * guard inside the helper. The runtime guard catches escapes —
 * future refactors that accidentally loosen this type, or test
 * code that uses `as any` to bypass it, would still fail loudly
 * at fixture-construction time.
 */
type ApplyReceiptOverrides = Partial<Omit<ReceiptFile, "mode" | "pre_rollback_checkpoint_id">> & {
  readonly pre_rollback_checkpoint_id?: string;
};

function makeApplyReceipt(overrides: ApplyReceiptOverrides = {}): ExistingApplyReceipt {
  const base = {
    schema_version: RECEIPT_FILE_SCHEMA_VERSION,
    rollback_id: FIXTURE_ROLLBACK_ID,
    session_id: FIXTURE_SESSION_ID,
    checkpoint_id: FIXTURE_CHECKPOINT_ID,
    mode: "apply" as const,
    forced: false,
    written_at: "2026-01-02T00:00:00Z",
    pre_rollback_checkpoint_id: FIXTURE_OTHER_CHECKPOINT_ID,
    results: [],
    failures: [],
    forced_unrelated_dirty_paths: [],
    dirty_tree_check: "performed" as const,
    out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
    ...overrides,
  };
  const parsed = ReceiptFileSchema.parse(base);
  // Runtime defense alongside the type-level narrowing — see
  // ApplyReceiptOverrides JSDoc for why both are necessary.
  if (parsed.mode !== "apply" || parsed.pre_rollback_checkpoint_id === null) {
    throw new Error("makeApplyReceipt produced a non-apply receipt fixture");
  }
  return parsed as ExistingApplyReceipt;
}

function makeActiveLock(sessionId: string): ActiveSessionLock {
  return {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: sessionId,
    checkpoint_id: FIXTURE_CHECKPOINT_ID,
    started_at: "2026-01-01T00:00:00Z",
  };
}

function makeStatusEntry(statusXY: string, path: string, previousPath?: string): StatusEntry {
  return previousPath === undefined ? { statusXY, path } : { statusXY, path, previousPath };
}

function makeRestorePlan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    head_match: true,
    tracked_restored: [],
    untracked_restored: [],
    untracked_deleted: [],
    skipped_excluded: [],
    skipped_unchanged: [],
    preflight_failures: [],
    ...overrides,
  };
}

function makeBasicCollectorParams(
  overrides: Partial<{
    targetSessionId: string;
    session: SessionState;
    manifest: Manifest;
    currentHeadSha: string;
    currentStatus: readonly StatusEntry[];
    endOfSessionSnapshot:
      | { readonly kind: "present"; readonly paths: readonly string[] }
      | { readonly kind: "missing" };
    activeLock: ActiveSessionLock | null;
    existingApplyReceipt: ExistingApplyReceipt | null;
  }> = {},
) {
  return {
    targetSessionId: FIXTURE_SESSION_ID,
    session: makeSession(),
    manifest: makeManifest(),
    currentHeadSha: FIXTURE_HEAD_SHA,
    currentStatus: [] as readonly StatusEntry[],
    endOfSessionSnapshot: { kind: "present" as const, paths: [] as readonly string[] },
    activeLock: null,
    existingApplyReceipt: null,
    ...overrides,
  };
}

// On-disk fixture helpers (resolveSessionAndCheckpoint section only).

interface TestRepoRoot {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
}

async function setupRepoRoot(): Promise<TestRepoRoot> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-rollback-orch-"));
  return {
    repoRoot: tmp,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

async function writeSessionFixture(
  repoRoot: string,
  sessionId: string,
  state?: Partial<SessionState>,
): Promise<void> {
  const sessionDir = join(repoRoot, ".viberevert", "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const session = makeSession({ session_id: sessionId, ...state });
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));
}

async function writeMinimalCheckpointFixture(
  repoRoot: string,
  sessionId: string,
  manifestOverrides?: Partial<Manifest>,
): Promise<void> {
  const checkpointDir = join(repoRoot, ".viberevert", "sessions", sessionId, "checkpoint");
  await mkdir(checkpointDir, { recursive: true });
  const manifest = makeManifest({ session_id: sessionId, ...manifestOverrides });
  await writeFile(join(checkpointDir, "manifest.json"), JSON.stringify(manifest));
  await mkdir(join(checkpointDir, "diffs"), { recursive: true });
  await mkdir(join(checkpointDir, "snapshots"), { recursive: true });
  await writeFile(join(checkpointDir, "diffs/unstaged.patch"), "");
  await writeFile(join(checkpointDir, "diffs/staged.patch"), "");
  await writeFile(join(checkpointDir, "snapshots/tracked.tar.gz"), "");
  await writeFile(join(checkpointDir, "snapshots/untracked.tar.gz"), "");
}

// =============================================================================
// SECTION 1: artifact consistency (via collectRollbackRefusals entry)
// =============================================================================

describe("collectRollbackRefusals — artifact consistency guard", () => {
  it("throws when session.session_id does not match targetSessionId", () => {
    const params = makeBasicCollectorParams({
      session: makeSession({ session_id: FIXTURE_OTHER_SESSION_ID }),
    });
    expect(() => collectRollbackRefusals(params)).toThrow(/session\.session_id/);
  });

  it("throws when manifest.session_id does not match targetSessionId", () => {
    const params = makeBasicCollectorParams({
      manifest: makeManifest({ session_id: FIXTURE_OTHER_SESSION_ID }),
    });
    expect(() => collectRollbackRefusals(params)).toThrow(/checkpoint manifest session_id/);
  });

  it("throws when existing apply receipt session_id does not match targetSessionId", () => {
    const params = makeBasicCollectorParams({
      existingApplyReceipt: makeApplyReceipt({ session_id: FIXTURE_OTHER_SESSION_ID }),
    });
    expect(() => collectRollbackRefusals(params)).toThrow(/existing apply receipt session_id/);
  });
});

// =============================================================================
// SECTION 2: collectRollbackRefusals rule detection
// =============================================================================

describe("collectRollbackRefusals — rule detection", () => {
  it("clean inputs produce empty refusals[] + performed dirty-tree check", () => {
    const analysis = collectRollbackRefusals(makeBasicCollectorParams());
    expect(analysis.refusals).toEqual([]);
    expect(analysis.activeSessionWarning).toBe(false);
    expect(analysis.unEndedSessionWarning).toBe(false);
    expect(analysis.headMismatch).toBe(false);
    expect(analysis.dirtyTreeCheckOutcome).toBe("performed");
    expect(analysis.unrelatedDirtyPaths).toEqual([]);
  });

  it("D63 active_session: active lock matching target → refusal in list", () => {
    const params = makeBasicCollectorParams({
      activeLock: makeActiveLock(FIXTURE_SESSION_ID),
    });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.activeSessionWarning).toBe(true);
    expect(analysis.refusals).toContainEqual({
      kind: "active_session",
      activeSessionId: FIXTURE_SESSION_ID,
    });
  });

  it("D63 not detected when active lock references a DIFFERENT session", () => {
    const params = makeBasicCollectorParams({
      activeLock: makeActiveLock(FIXTURE_OTHER_SESSION_ID),
    });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.activeSessionWarning).toBe(false);
    expect(analysis.refusals.some((r) => r.kind === "active_session")).toBe(false);
  });

  it("D70 already_applied: existing apply receipt → refusal carries writtenAt + preRollbackCheckpointId", () => {
    const receipt = makeApplyReceipt({
      written_at: "2026-01-05T12:00:00Z",
      pre_rollback_checkpoint_id: FIXTURE_OTHER_CHECKPOINT_ID,
    });
    const params = makeBasicCollectorParams({ existingApplyReceipt: receipt });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.refusals).toContainEqual({
      kind: "already_applied",
      writtenAt: "2026-01-05T12:00:00Z",
      preRollbackCheckpointId: FIXTURE_OTHER_CHECKPOINT_ID,
    });
  });

  it("D64 head_mismatch: currentHeadSha differs from manifest.git.head_sha", () => {
    const params = makeBasicCollectorParams({
      currentHeadSha: FIXTURE_DIFFERENT_HEAD_SHA,
    });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.headMismatch).toBe(true);
    expect(analysis.refusals).toContainEqual({
      kind: "head_mismatch",
      expectedHead: FIXTURE_HEAD_SHA,
      currentHead: FIXTURE_DIFFERENT_HEAD_SHA,
    });
  });

  it("D61b un_ended_session: snapshot kind missing → refusal + dirtyTreeCheckOutcome flips to skipped_no_after_state + empty unrelated paths", () => {
    const params = makeBasicCollectorParams({
      endOfSessionSnapshot: { kind: "missing" },
      currentStatus: [makeStatusEntry(" M", "src/foo.ts")],
    });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.unEndedSessionWarning).toBe(true);
    expect(analysis.dirtyTreeCheckOutcome).toBe("skipped_no_after_state");
    expect(analysis.unrelatedDirtyPaths).toEqual([]);
    expect(analysis.refusals).toContainEqual({
      kind: "un_ended_session",
      sessionId: FIXTURE_SESSION_ID,
    });
  });

  it("D61 dirty_tree: current dirt outside expected target → refusal carries the unrelated paths sorted", () => {
    const params = makeBasicCollectorParams({
      currentStatus: [makeStatusEntry(" M", "src/z.ts"), makeStatusEntry("??", "src/a.ts")],
      endOfSessionSnapshot: { kind: "present", paths: [] },
    });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.unrelatedDirtyPaths).toEqual(["src/a.ts", "src/z.ts"]);
    expect(analysis.refusals).toContainEqual({
      kind: "dirty_tree",
      unrelatedPaths: ["src/a.ts", "src/z.ts"],
    });
  });

  it("D61 expected target: manifest.tracked_dirty_paths ∪ untracked.file_hashes keys ∪ endOfSession.paths", () => {
    const params = makeBasicCollectorParams({
      manifest: makeManifest({
        snapshots: {
          tracked_dirty_archive_path: "snapshots/tracked.tar.gz",
          tracked_dirty_paths: ["from-tracked.ts"],
          file_hashes: {},
        },
        untracked: {
          archive_path: "snapshots/untracked.tar.gz",
          exclude_patterns: [],
          file_hashes: {
            "from-untracked.ts": "a".repeat(64),
          },
        },
      }),
      endOfSessionSnapshot: {
        kind: "present",
        paths: ["from-snapshot.ts"],
      },
      currentStatus: [
        makeStatusEntry(" M", "from-tracked.ts"),
        makeStatusEntry("??", "from-untracked.ts"),
        makeStatusEntry(" M", "from-snapshot.ts"),
        makeStatusEntry(" M", "actually-unrelated.ts"),
      ],
    });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.unrelatedDirtyPaths).toEqual(["actually-unrelated.ts"]);
  });

  it("N5 R/C BOTH-paths rule: rename entry contributes BOTH new and previous path to current-dirty set", () => {
    const params = makeBasicCollectorParams({
      currentStatus: [makeStatusEntry("R ", "src/new.ts", "src/old.ts")],
      endOfSessionSnapshot: { kind: "present", paths: ["src/new.ts"] },
    });
    const analysis = collectRollbackRefusals(params);
    // src/new.ts is in expected; src/old.ts is NOT → only src/old.ts is unrelated.
    expect(analysis.unrelatedDirtyPaths).toEqual(["src/old.ts"]);
  });

  it("empty unrelated dirt when all current dirt is in expected target", () => {
    const params = makeBasicCollectorParams({
      currentStatus: [makeStatusEntry(" M", "expected.ts")],
      endOfSessionSnapshot: { kind: "present", paths: ["expected.ts"] },
    });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.unrelatedDirtyPaths).toEqual([]);
    expect(analysis.refusals.some((r) => r.kind === "dirty_tree")).toBe(false);
  });

  it("D76 order in refusals[]: D63 → D70 → D64 → D61b → D61", () => {
    // Construct a fixture that triggers the first four D76 refusals.
    // D61 dirty_tree is intentionally absent because D61b missing
    // after-state skips the dirty-tree comparison entirely
    // (dirtyTreeCheckOutcome flips to "skipped_no_after_state"
    // and unrelatedDirtyPaths is forced empty regardless of what's
    // in currentStatus). This is the locked behavior, not a test
    // limitation.
    const params = makeBasicCollectorParams({
      activeLock: makeActiveLock(FIXTURE_SESSION_ID),
      existingApplyReceipt: makeApplyReceipt(),
      currentHeadSha: FIXTURE_DIFFERENT_HEAD_SHA,
      endOfSessionSnapshot: { kind: "missing" },
      // currentStatus is irrelevant because un_ended flips dirty-check to skipped.
    });
    const analysis = collectRollbackRefusals(params);
    expect(analysis.refusals.map((r) => r.kind)).toEqual([
      "active_session",
      "already_applied",
      "head_mismatch",
      "un_ended_session",
    ]);
  });
});

// =============================================================================
// SECTION 3: checkRefusals mode/force enforcement
// =============================================================================

describe("checkRefusals — dry-run mode (never throws policy refusals)", () => {
  it("clean state: returns clean outcome with all warnings false", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams(),
      mode: "dry_run",
      force: false,
    });
    expect(outcome.activeSessionWarning).toBe(false);
    expect(outcome.unEndedSessionWarning).toBe(false);
    expect(outcome.allowHeadMismatch).toBe(false);
    expect(outcome.dirtyTreeCheckOutcome).toBe("performed");
    expect(outcome.unrelatedDirtyPaths).toEqual([]);
  });

  it("active session: returns outcome with activeSessionWarning=true (no throw)", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams({ activeLock: makeActiveLock(FIXTURE_SESSION_ID) }),
      mode: "dry_run",
      force: false,
    });
    expect(outcome.activeSessionWarning).toBe(true);
  });

  it("already-applied: dry-run returns outcome without throw", () => {
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({ existingApplyReceipt: makeApplyReceipt() }),
        mode: "dry_run",
        force: false,
      }),
    ).not.toThrow();
  });

  it("HEAD mismatch: dry-run returns allowHeadMismatch=false regardless of force flag", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams({ currentHeadSha: FIXTURE_DIFFERENT_HEAD_SHA }),
      mode: "dry_run",
      force: true,
    });
    expect(outcome.allowHeadMismatch).toBe(false);
  });

  it("un-ended session: dry-run propagates warning + skipped_no_after_state outcome", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams({
        endOfSessionSnapshot: { kind: "missing" },
      }),
      mode: "dry_run",
      force: false,
    });
    expect(outcome.unEndedSessionWarning).toBe(true);
    expect(outcome.dirtyTreeCheckOutcome).toBe("skipped_no_after_state");
  });

  it("dirty tree: dry-run propagates unrelatedDirtyPaths without throw", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams({
        currentStatus: [makeStatusEntry(" M", "src/unrelated.ts")],
        endOfSessionSnapshot: { kind: "present", paths: [] },
      }),
      mode: "dry_run",
      force: false,
    });
    expect(outcome.unrelatedDirtyPaths).toEqual(["src/unrelated.ts"]);
  });
});

describe("checkRefusals — apply mode (D75 force-policy table)", () => {
  it("clean state: returns clean outcome", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams(),
      mode: "apply",
      force: false,
    });
    expect(outcome.allowHeadMismatch).toBe(false);
  });

  it("D63 active_session NEVER bypassed by --force", () => {
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({ activeLock: makeActiveLock(FIXTURE_SESSION_ID) }),
        mode: "apply",
        force: true,
      }),
    ).toThrow(RollbackActiveSessionRefusalError);
  });

  it("D70 already_applied NEVER bypassed by --force", () => {
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({ existingApplyReceipt: makeApplyReceipt() }),
        mode: "apply",
        force: true,
      }),
    ).toThrow(RollbackAlreadyAppliedError);
  });

  it("D64 head_mismatch throws without --force", () => {
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({ currentHeadSha: FIXTURE_DIFFERENT_HEAD_SHA }),
        mode: "apply",
        force: false,
      }),
    ).toThrow(RollbackHeadMismatchError);
  });

  it("D64 head_mismatch bypassed by --force: returns outcome with allowHeadMismatch=true", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams({ currentHeadSha: FIXTURE_DIFFERENT_HEAD_SHA }),
      mode: "apply",
      force: true,
    });
    expect(outcome.allowHeadMismatch).toBe(true);
  });

  it("D61b un_ended_session throws without --force", () => {
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({ endOfSessionSnapshot: { kind: "missing" } }),
        mode: "apply",
        force: false,
      }),
    ).toThrow(RollbackUnEndedSessionRefusalError);
  });

  it("D61b un_ended_session bypassed by --force: outcome has warning + skipped_no_after_state", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams({ endOfSessionSnapshot: { kind: "missing" } }),
      mode: "apply",
      force: true,
    });
    expect(outcome.unEndedSessionWarning).toBe(true);
    expect(outcome.dirtyTreeCheckOutcome).toBe("skipped_no_after_state");
  });

  it("D61 dirty_tree throws without --force", () => {
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({
          currentStatus: [makeStatusEntry(" M", "src/unrelated.ts")],
          endOfSessionSnapshot: { kind: "present", paths: [] },
        }),
        mode: "apply",
        force: false,
      }),
    ).toThrow(RollbackDirtyTreeRefusalError);
  });

  it("D61 dirty_tree bypassed by --force: outcome carries unrelatedDirtyPaths for receipt to record", () => {
    const outcome = checkRefusals({
      ...makeBasicCollectorParams({
        currentStatus: [makeStatusEntry(" M", "src/unrelated.ts")],
        endOfSessionSnapshot: { kind: "present", paths: [] },
      }),
      mode: "apply",
      force: true,
    });
    expect(outcome.unrelatedDirtyPaths).toEqual(["src/unrelated.ts"]);
  });

  it("apply throws D63 BEFORE other refusals when multiple fire (D76 order)", () => {
    // D63 should fire even though D64 would also apply.
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({
          activeLock: makeActiveLock(FIXTURE_SESSION_ID),
          currentHeadSha: FIXTURE_DIFFERENT_HEAD_SHA,
        }),
        mode: "apply",
        force: true,
      }),
    ).toThrow(RollbackActiveSessionRefusalError);
  });
});

describe("checkRefusals — artifact-integrity throws fire in both modes", () => {
  it("dry-run: session.session_id mismatch still throws (not a policy refusal)", () => {
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({
          session: makeSession({ session_id: FIXTURE_OTHER_SESSION_ID }),
        }),
        mode: "dry_run",
        force: false,
      }),
    ).toThrow(/session\.session_id/);
  });

  it("apply: manifest.session_id mismatch still throws", () => {
    expect(() =>
      checkRefusals({
        ...makeBasicCollectorParams({
          manifest: makeManifest({ session_id: FIXTURE_OTHER_SESSION_ID }),
        }),
        mode: "apply",
        force: true,
      }),
    ).toThrow(/checkpoint manifest session_id/);
  });
});

// =============================================================================
// SECTION 4: resolveSessionAndCheckpoint (real loadSession + loadCheckpoint)
// =============================================================================

describe("resolveSessionAndCheckpoint — real I/O", () => {
  it("happy path: returns {session, manifest, checkpointDir} for a valid fixture", async () => {
    const env = await setupRepoRoot();
    try {
      await writeSessionFixture(env.repoRoot, FIXTURE_SESSION_ID);
      await writeMinimalCheckpointFixture(env.repoRoot, FIXTURE_SESSION_ID);

      const result = await resolveSessionAndCheckpoint(FIXTURE_SESSION_ID, env.repoRoot);
      expect(result.session.session_id).toBe(FIXTURE_SESSION_ID);
      expect(result.manifest.session_id).toBe(FIXTURE_SESSION_ID);
      expect(result.checkpointDir).toContain(FIXTURE_SESSION_ID);
      expect(result.checkpointDir.endsWith("checkpoint")).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it("SessionNotFoundError re-thrown verbatim (no wrap)", async () => {
    const env = await setupRepoRoot();
    try {
      // No session fixture written.
      await expect(
        resolveSessionAndCheckpoint(FIXTURE_SESSION_ID, env.repoRoot),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      await env.cleanup();
    }
  });

  it("CheckpointNotFoundError wrapped as CheckpointArtifactsMissingError", async () => {
    const env = await setupRepoRoot();
    try {
      await writeSessionFixture(env.repoRoot, FIXTURE_SESSION_ID);
      // No checkpoint fixture written.
      await expect(
        resolveSessionAndCheckpoint(FIXTURE_SESSION_ID, env.repoRoot),
      ).rejects.toBeInstanceOf(CheckpointArtifactsMissingError);
    } finally {
      await env.cleanup();
    }
  });

  it("CheckpointCorruptError (malformed manifest JSON) wrapped as CheckpointArtifactsMissingError", async () => {
    const env = await setupRepoRoot();
    try {
      await writeSessionFixture(env.repoRoot, FIXTURE_SESSION_ID);
      const checkpointDir = join(
        env.repoRoot,
        ".viberevert",
        "sessions",
        FIXTURE_SESSION_ID,
        "checkpoint",
      );
      await mkdir(checkpointDir, { recursive: true });
      await writeFile(join(checkpointDir, "manifest.json"), "{not valid json");

      await expect(
        resolveSessionAndCheckpoint(FIXTURE_SESSION_ID, env.repoRoot),
      ).rejects.toBeInstanceOf(CheckpointArtifactsMissingError);
    } finally {
      await env.cleanup();
    }
  });

  it("manifest.session_id mismatch wrapped as CheckpointArtifactsMissingError with cause", async () => {
    const env = await setupRepoRoot();
    try {
      await writeSessionFixture(env.repoRoot, FIXTURE_SESSION_ID);
      // Write manifest with a FOREIGN session_id.
      await writeMinimalCheckpointFixture(env.repoRoot, FIXTURE_SESSION_ID, {
        session_id: FIXTURE_OTHER_SESSION_ID,
      });

      // Manual try/catch (instead of expect(...).rejects.toThrow) so
      // the caught error object is in scope for cause-chain
      // inspection. The title promises "with cause" — this body
      // must lock that wrapping semantic, not just the outer class.
      try {
        await resolveSessionAndCheckpoint(FIXTURE_SESSION_ID, env.repoRoot);
        throw new Error("expected resolveSessionAndCheckpoint to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CheckpointArtifactsMissingError);
        expect((err as Error).cause).toBeInstanceOf(Error);
        expect(String((err as Error).cause)).toContain("manifest.session_id");
      }
    } finally {
      await env.cleanup();
    }
  });
});

// =============================================================================
// SECTION 5: classifyRestoreError
// =============================================================================

describe("classifyRestoreError — known restore error classes", () => {
  it("RestoreHeadMismatchError → head_mismatch, empty affected_paths, mayHaveMutated=false", () => {
    const result = classifyRestoreError(
      new RestoreHeadMismatchError(FIXTURE_HEAD_SHA, FIXTURE_DIFFERENT_HEAD_SHA),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error_code).toBe("head_mismatch");
    expect(result.failures[0]?.affected_paths).toEqual([]);
    expect(result.mayHaveMutated).toBe(false);
  });

  it("RestoreExcludeDriftError → exclude_drift, affected_paths from tighteningPaths sorted-unique, mayHaveMutated=false", () => {
    const result = classifyRestoreError(
      new RestoreExcludeDriftError({
        capturedPatterns: ["*.log"],
        currentPatterns: ["*.log", "secrets/*"],
        tighteningPatterns: ["secrets/*"],
        looseningPatterns: [],
        // Intentional dup + reverse order to prove sorted-unique fires.
        tighteningPaths: ["secrets/b.env", "secrets/a.env", "secrets/b.env"],
      }),
    );
    expect(result.failures[0]?.error_code).toBe("exclude_drift");
    expect(result.failures[0]?.affected_paths).toEqual(["secrets/a.env", "secrets/b.env"]);
    expect(result.mayHaveMutated).toBe(false);
  });

  it("RestoreExtractionConflictError → extraction_conflict, BOTH manifestPath + conflictingPath in affected_paths, mayHaveMutated=true", () => {
    const result = classifyRestoreError(
      new RestoreExtractionConflictError([
        { manifestPath: "src/a/b.txt", conflictingPath: "src/a", reason: "file blocking dir" },
        { manifestPath: "src/c.txt", conflictingPath: "src/c.txt", reason: "non-empty dir" },
      ]),
    );
    expect(result.failures[0]?.error_code).toBe("extraction_conflict");
    // BOTH manifestPath and conflictingPath surface; duplicates (c.txt same on both sides) collapsed.
    expect(result.failures[0]?.affected_paths).toEqual(["src/a", "src/a/b.txt", "src/c.txt"]);
    expect(result.mayHaveMutated).toBe(true);
  });

  it("RestoreTrackedDirtyParityError → tracked_dirty_parity, affected_paths from issues[].path, mayHaveMutated=true", () => {
    const result = classifyRestoreError(
      new RestoreTrackedDirtyParityError([
        { path: "src/z.ts", kind: "unexpected_dirty" },
        { path: "src/a.ts", kind: "missing_dirty" },
      ]),
    );
    expect(result.failures[0]?.error_code).toBe("tracked_dirty_parity");
    expect(result.failures[0]?.affected_paths).toEqual(["src/a.ts", "src/z.ts"]);
    expect(result.mayHaveMutated).toBe(true);
  });

  it("RestoreVerificationError → verification, affected_paths from mismatches[].path, mayHaveMutated=true", () => {
    const result = classifyRestoreError(
      new RestoreVerificationError([
        { path: "src/c.ts", expectedSha256: "a".repeat(64), actualSha256: "b".repeat(64) },
        { path: "src/b.ts", expectedSha256: "a".repeat(64), actualSha256: null },
      ]),
    );
    expect(result.failures[0]?.error_code).toBe("verification");
    expect(result.failures[0]?.affected_paths).toEqual(["src/b.ts", "src/c.ts"]);
    expect(result.mayHaveMutated).toBe(true);
  });

  it("unknown Error → internal, empty affected_paths, mayHaveMutated=true (CONSERVATIVE)", () => {
    const result = classifyRestoreError(new Error("something unexpected"));
    expect(result.failures[0]?.error_code).toBe("internal");
    expect(result.failures[0]?.message).toBe("something unexpected");
    expect(result.failures[0]?.affected_paths).toEqual([]);
    expect(result.mayHaveMutated).toBe(true);
  });

  it("non-Error throw (string, etc.) → internal with String(err) message, mayHaveMutated=true", () => {
    const result = classifyRestoreError("bare string thrown");
    expect(result.failures[0]?.error_code).toBe("internal");
    expect(result.failures[0]?.message).toBe("bare string thrown");
    expect(result.mayHaveMutated).toBe(true);
  });
});

// =============================================================================
// SECTION 6: buildReceiptForDryRun
// =============================================================================

describe("buildReceiptForDryRun", () => {
  it("happy path: plan paths synthesized into results[] sorted by path", () => {
    const receipt = buildReceiptForDryRun({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      plan: makeRestorePlan({
        tracked_restored: ["src/z.ts"],
        untracked_restored: ["src/a.ts"],
        skipped_unchanged: ["src/m.ts"],
      }),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: [],
      },
    });
    expect(receipt.mode).toBe("dry_run");
    expect(receipt.forced).toBe(false);
    expect(receipt.pre_rollback_checkpoint_id).toBeNull();
    expect(receipt.results.map((r) => r.path)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("skipped_unrelated_dirt entries appended when dirty_tree_check === 'performed' and unrelated paths present", () => {
    const receipt = buildReceiptForDryRun({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      plan: makeRestorePlan({ tracked_restored: ["src/restored.ts"] }),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: ["src/unrelated.ts"],
      },
    });
    const unrelatedEntry = receipt.results.find((r) => r.path === "src/unrelated.ts");
    expect(unrelatedEntry?.outcome).toBe("skipped_unrelated_dirt");
    expect(unrelatedEntry?.reason).toContain("--apply would refuse");
  });

  it("no skipped_unrelated_dirt entries when dirty_tree_check === 'skipped_no_after_state' (D61b path)", () => {
    const receipt = buildReceiptForDryRun({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      plan: makeRestorePlan(),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: true,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "skipped_no_after_state",
        unrelatedDirtyPaths: [],
      },
    });
    expect(receipt.results.some((r) => r.outcome === "skipped_unrelated_dirt")).toBe(false);
    expect(receipt.un_ended_session_warning).toBe(true);
  });

  it("warnings propagate from outcome: both active + un_ended set on dry-run receipt", () => {
    const receipt = buildReceiptForDryRun({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      plan: makeRestorePlan(),
      outcome: {
        activeSessionWarning: true,
        unEndedSessionWarning: true,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "skipped_no_after_state",
        unrelatedDirtyPaths: [],
      },
    });
    expect(receipt.active_session_warning).toBe(true);
    expect(receipt.un_ended_session_warning).toBe(true);
  });

  it("preflight_failures from plan propagated as receipt failures[] (head_mismatch case)", () => {
    // Locked rule #12: dry-run propagates plan.preflight_failures[]
    // into receipt.failures[] per the @viberevert/git contract.
    // head_mismatch preflight failure (planRestoreCheckpoint never
    // throws on HEAD mismatch — only restoreCheckpoint does, and
    // only in apply mode) MUST surface in the receipt so the user
    // sees what --apply would refuse.
    const preflightFailure: RestorePreflightFailure = {
      error_code: "head_mismatch",
      message: "current HEAD abc... does not match checkpoint-captured def...",
      affected_paths: [],
    };
    const receipt = buildReceiptForDryRun({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      plan: makeRestorePlan({ head_match: false, preflight_failures: [preflightFailure] }),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: [],
      },
    });
    expect(receipt.failures).toHaveLength(1);
    expect(receipt.failures[0]?.error_code).toBe("head_mismatch");
    expect(receipt.failures[0]?.message).toBe(preflightFailure.message);
    expect(receipt.failures[0]?.affected_paths).toEqual([]);
  });

  it("empty plan.preflight_failures produces empty receipt.failures (no-regression on clean dry-run)", () => {
    // Locks the "no false failures on the clean path" half of the
    // contract: when plan.preflight_failures is empty (the common
    // case), receipt.failures stays empty. Catches the inverse
    // regression where the propagation accidentally synthesizes
    // a spurious entry.
    const receipt = buildReceiptForDryRun({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      plan: makeRestorePlan({ tracked_restored: ["src/foo.ts"] }),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: [],
      },
    });
    expect(receipt.failures).toEqual([]);
  });

  it("preflight exclude_drift failure with unsorted/duplicate affected_paths surfaces sorted-unique", () => {
    // Locks the receipt-builder seam's defensive normalization
    // independently of @viberevert/git's upstream normalization.
    // The fixture intentionally provides unsorted + duplicated
    // affected_paths (which the real planRestoreCheckpoint would
    // never emit because it normalizes via normalizePathArray
    // before constructing RestorePreflightFailure). If the
    // upstream normalization ever regressed or changed shape,
    // the receipt would STILL be byte-stable because the receipt
    // builder re-normalizes via sortedUnique. exclude_drift is
    // the path-carrying preflight case (head_mismatch always
    // emits empty affected_paths) — locks audit-output quality,
    // not just propagation presence.
    const preflightFailure: RestorePreflightFailure = {
      error_code: "exclude_drift",
      message:
        "rollback.exclude patterns differ between capture and current config; restore would refuse",
      affected_paths: ["secrets/b.env", "secrets/a.env", "secrets/b.env"],
    };
    const receipt = buildReceiptForDryRun({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      plan: makeRestorePlan({ preflight_failures: [preflightFailure] }),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: [],
      },
    });
    expect(receipt.failures).toHaveLength(1);
    expect(receipt.failures[0]?.error_code).toBe("exclude_drift");
    expect(receipt.failures[0]?.affected_paths).toEqual(["secrets/a.env", "secrets/b.env"]);
  });
});

// =============================================================================
// SECTION 7: buildReceiptForApply (MOCKED restoreCheckpoint)
// =============================================================================

describe("buildReceiptForApply — mocked restoreCheckpoint", () => {
  beforeEach(() => {
    vi.mocked(restoreCheckpoint).mockReset();
  });

  afterEach(() => {
    vi.mocked(restoreCheckpoint).mockReset();
  });

  it("calls restoreCheckpoint with checkpointDir + repoRoot + rollbackExcludePatterns + allowHeadMismatch", async () => {
    vi.mocked(restoreCheckpoint).mockResolvedValueOnce(undefined);
    await buildReceiptForApply({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      checkpointDir: "/tmp/test-cp",
      repoRoot: "/tmp/test-repo",
      rollbackExcludePatterns: ["*.log"],
      preRollbackCheckpointId: FIXTURE_OTHER_CHECKPOINT_ID,
      preRestorePlan: makeRestorePlan(),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: true,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: [],
      },
      forced: false,
    });
    expect(vi.mocked(restoreCheckpoint)).toHaveBeenCalledWith("/tmp/test-cp", {
      repoRoot: "/tmp/test-repo",
      rollbackExcludePatterns: ["*.log"],
      allowHeadMismatch: true,
    });
  });

  it("success path: synthesizes results[] from preRestorePlan, empty failures[]", async () => {
    vi.mocked(restoreCheckpoint).mockResolvedValueOnce(undefined);
    const receipt = await buildReceiptForApply({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      checkpointDir: "/tmp/cp",
      repoRoot: "/tmp/repo",
      rollbackExcludePatterns: [],
      preRollbackCheckpointId: FIXTURE_OTHER_CHECKPOINT_ID,
      preRestorePlan: makeRestorePlan({
        tracked_restored: ["src/restored.ts"],
        skipped_excluded: ["src/excluded.ts"],
      }),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: [],
      },
      forced: false,
    });
    expect(receipt.mode).toBe("apply");
    expect(receipt.failures).toEqual([]);
    expect(receipt.results.map((r) => r.path)).toEqual(["src/excluded.ts", "src/restored.ts"]);
  });

  it("throw path: empty results[], failures[] populated by classifyRestoreError", async () => {
    vi.mocked(restoreCheckpoint).mockRejectedValueOnce(
      new RestoreVerificationError([
        { path: "src/bad.ts", expectedSha256: "a".repeat(64), actualSha256: "b".repeat(64) },
      ]),
    );
    const receipt = await buildReceiptForApply({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      checkpointDir: "/tmp/cp",
      repoRoot: "/tmp/repo",
      rollbackExcludePatterns: [],
      preRollbackCheckpointId: FIXTURE_OTHER_CHECKPOINT_ID,
      preRestorePlan: makeRestorePlan({ tracked_restored: ["src/would-have-restored.ts"] }),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: [],
      },
      forced: false,
    });
    expect(receipt.results).toEqual([]); // D76 conservative semantics
    expect(receipt.failures).toHaveLength(1);
    expect(receipt.failures[0]?.error_code).toBe("verification");
    expect(receipt.failures[0]?.affected_paths).toEqual(["src/bad.ts"]);
  });

  it("forced_unrelated_dirty_paths populated when forced=true + dirty_tree_check='performed' + unrelated paths present", async () => {
    vi.mocked(restoreCheckpoint).mockResolvedValueOnce(undefined);
    const receipt = await buildReceiptForApply({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      checkpointDir: "/tmp/cp",
      repoRoot: "/tmp/repo",
      rollbackExcludePatterns: [],
      preRollbackCheckpointId: FIXTURE_OTHER_CHECKPOINT_ID,
      preRestorePlan: makeRestorePlan(),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: ["src/forced.ts"],
      },
      forced: true,
    });
    expect(receipt.forced).toBe(true);
    expect(receipt.forced_unrelated_dirty_paths).toEqual(["src/forced.ts"]);
  });

  it("forced_unrelated_dirty_paths EMPTY when forced=true but no unrelated paths (D69 audit refine)", async () => {
    vi.mocked(restoreCheckpoint).mockResolvedValueOnce(undefined);
    const receipt = await buildReceiptForApply({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      checkpointDir: "/tmp/cp",
      repoRoot: "/tmp/repo",
      rollbackExcludePatterns: [],
      preRollbackCheckpointId: FIXTURE_OTHER_CHECKPOINT_ID,
      preRestorePlan: makeRestorePlan(),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: false,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "performed",
        unrelatedDirtyPaths: [],
      },
      forced: true,
    });
    expect(receipt.forced).toBe(true);
    expect(receipt.forced_unrelated_dirty_paths).toEqual([]);
  });

  it("forced_unrelated_dirty_paths EMPTY when dirty_tree_check='skipped_no_after_state' even with --force", async () => {
    // D69 audit refine: forced_unrelated_dirty_paths is non-empty
    // ONLY when dirty_tree_check === "performed". Forced bypass of
    // D61b (skipped state) records un_ended_session_warning but
    // doesn't populate the unrelated-paths field.
    vi.mocked(restoreCheckpoint).mockResolvedValueOnce(undefined);
    const receipt = await buildReceiptForApply({
      rollbackId: FIXTURE_ROLLBACK_ID,
      writtenAt: "2026-01-01T00:00:00Z",
      session: makeSession(),
      checkpointDir: "/tmp/cp",
      repoRoot: "/tmp/repo",
      rollbackExcludePatterns: [],
      preRollbackCheckpointId: FIXTURE_OTHER_CHECKPOINT_ID,
      preRestorePlan: makeRestorePlan(),
      outcome: {
        activeSessionWarning: false,
        unEndedSessionWarning: true,
        allowHeadMismatch: false,
        dirtyTreeCheckOutcome: "skipped_no_after_state",
        unrelatedDirtyPaths: [], // structurally empty in skipped mode
      },
      forced: true,
    });
    expect(receipt.forced).toBe(true);
    expect(receipt.forced_unrelated_dirty_paths).toEqual([]);
    expect(receipt.un_ended_session_warning).toBe(true);
  });
});
