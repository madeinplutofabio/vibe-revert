// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Presentation contracts for `viberevert end` (M 0.8.0 step 4c, Slice C).
//
// MOCK-FOCUSED BY DESIGN, per the convention stated in
// check-since-resolution.test.ts: a behavioral test file should not grow a
// `vi.mock`, because module mocking is file-scoped and would replace the
// operation for that file's genuinely-behavioral tests too. Error-injection
// coverage ships as its own file instead.
//
// Only `endSessionOperation` is mocked. Every error CLASS stays real
// (`importOriginal` spread), so the `instanceof` dispatch under test is the
// genuine one rather than a stand-in — a mocked class would make these tests
// pass even if end.ts matched on the wrong type.
//
// Why mocks rather than real fixtures: several mapped failures can be induced
// through filesystem state, but mixing those fixtures with module mocking would
// make this presentation-focused file needlessly brittle. The fence refusal,
// non-empty cleanup warnings, and the race are not reliably inducible without
// timing or failure injection. The one integration path that actually
// regressed — operation throws CheckpointNotFoundError, command catches it —
// is pinned for real in start-end.test.ts.
//
// Clipanion 3.2.1 writes UNCAUGHT command errors to STDOUT, so every mapped
// refusal asserts `stdout === ""`. That assertion is about OUR branch writing
// nothing to stdout, which holds however clipanion routes errors it never
// sees — and it is the assertion that would have caught the raw-stack
// regression these mappings exist to prevent.

import { PassThrough, Writable } from "node:stream";
import {
  CheckpointCorruptError,
  CheckpointNotFoundError,
  EndStateChangedDuringCaptureError,
  SessionCheckpointBindingError,
} from "@viberevert/git";
import { Cli } from "clipanion";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EndCommand } from "../src/commands/end.js";
import { ConcurrentOperationError, formatConcurrentOperationRefusal } from "../src/locks.js";
import {
  type EndSessionOperationResult,
  EndSessionRaceError,
  endSessionOperation,
} from "../src/operations/end-session.js";
import { START_LOCK_REL } from "../src/operations/start-session.js";

vi.mock("../src/operations/end-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/end-session.js")>();
  return { ...actual, endSessionOperation: vi.fn() };
});

const SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const OTHER_SESSION_ID = "sess_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const STARTED_AT = "2026-05-04T10:30:11Z";
const ENDED_AT = "2026-05-04T11:00:00Z";

// Forward slashes so assertions are platform-neutral; these paths are only
// ever echoed back through error messages, never touched.
const CHECKPOINT_DIR = `/repo/.viberevert/sessions/${SESSION_ID}/checkpoint`;
const LOCK_DIR = "/repo/.viberevert/.locks/start.lock";

/** A successful end with nothing to warn about. */
const CLEAN_RESULT: EndSessionOperationResult = {
  sessionId: SESSION_ID,
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  cleanupWarnings: [],
};

/** The exact stdout a clean, task-less end produces. */
const CLEAN_STDOUT = `Session ended.\nID: ${SESSION_ID}\nStarted: ${STARTED_AT}\nEnded: ${ENDED_AT}\n`;

beforeEach(() => {
  vi.mocked(endSessionOperation).mockReset();
});

function mockResolve(result: EndSessionOperationResult): void {
  vi.mocked(endSessionOperation).mockResolvedValue(result);
}

function mockReject(err: Error): void {
  vi.mocked(endSessionOperation).mockRejectedValue(err);
}

/**
 * Drive the real EndCommand through a clipanion Cli with captured streams.
 * No filesystem: the operation is mocked, so nothing here touches a repo.
 */
async function runEnd(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(EndCommand);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = false;

  const stdoutStub = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      callback();
    },
  });

  const stderrStub = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      callback();
    },
  });

  const exitCode = await cli.run(["end"], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

// =============================================================================
// The three persisted-state refusals
//
// Each asserts its OWN lead and the ABSENCE of the other two. A single shared
// message would satisfy any one of these tests individually; only the mutual
// exclusions prove the diagnoses stayed distinct.
// =============================================================================

describe("end: checkpoint cannot be used", () => {
  it("missing checkpoint refuses with its own lead and no raw stack", async () => {
    const err = new CheckpointNotFoundError(CHECKPOINT_DIR, "manifest.json not found");
    mockReject(err);

    const result = await runEnd();

    expect(result.exitCode).toBe(1);
    // Clipanion routes uncaught errors here; empty proves the branch matched.
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot end this session: its checkpoint is missing.");
    // The error's own message carries path + reason and is surfaced verbatim.
    expect(result.stderr).toContain(err.message);
    expect(result.stderr).toContain("The session is left active and unchanged.");
    expect(result.stderr).not.toContain("is corrupt");
    expect(result.stderr).not.toContain("belongs to a different session");
  });

  it("corrupt checkpoint refuses with a lead distinct from missing", async () => {
    const err = new CheckpointCorruptError(CHECKPOINT_DIR, "manifest failed schema validation");
    mockReject(err);

    const result = await runEnd();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot end this session: its checkpoint is corrupt.");
    expect(result.stderr).toContain(err.message);
    expect(result.stderr).toContain("The session is left active and unchanged.");
    // "present but untrustworthy" must NOT read as "gone".
    expect(result.stderr).not.toContain("is missing");
    expect(result.stderr).not.toContain("belongs to a different session");
  });

  it("cross-session checkpoint binding refuses with its own lead and names both sessions", async () => {
    const err = new SessionCheckpointBindingError(SESSION_ID, OTHER_SESSION_ID);
    mockReject(err);

    const result = await runEnd();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Cannot end this session: its checkpoint belongs to a different session.",
    );
    // Both ids appear, so the user can find the mis-filed checkpoint.
    expect(result.stderr).toContain(SESSION_ID);
    expect(result.stderr).toContain(OTHER_SESSION_ID);
    expect(result.stderr).toContain("The session is left active and unchanged.");
    expect(result.stderr).not.toContain("is missing");
    expect(result.stderr).not.toContain("is corrupt");
  });
});

// =============================================================================
// The fence refusal
// =============================================================================

describe("end: the end-state fence refuses", () => {
  it("unstable end state gets retry-oriented copy with no fence-internal vocabulary", async () => {
    const err = new EndStateChangedDuringCaptureError(3, [
      "afterHeadSha",
      "trackedStatus",
      "rawInventory",
    ]);
    mockReject(err);

    const result = await runEnd();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Cannot end this session because the project kept changing during capture.",
    );
    expect(result.stderr).toContain("could not verify as stable");
    // Actionable: the user is told what to do and what to run.
    expect(result.stderr).toContain("Stop other writers or background processes");
    expect(result.stderr).toContain("viberevert end");

    // The whole error message is withheld, which covers attemptCount and every
    // changed fence member in one assertion. Fence membership names are an
    // internal vocabulary; leaking them turns a clean refusal into noise.
    expect(result.stderr).not.toContain(err.message);
    expect(result.stderr).not.toContain("afterHeadSha");
    expect(result.stderr).not.toContain("trackedStatus");
    expect(result.stderr).not.toContain("rawInventory");
  });
});

// =============================================================================
// Concurrency and out-of-protocol mutation
// =============================================================================

describe("end: lock contention and lost active session", () => {
  it("concurrent operation renders EXACTLY the shared D22 formatter output (info present)", async () => {
    const info = {
      pid: 4242,
      command: "end-session",
      started_at: "2026-07-01T00:00:00Z",
      host: "testhost",
    };
    mockReject(new ConcurrentOperationError(LOCK_DIR, info));

    const result = await runEnd();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    // Compared against the formatter itself, never a copied literal, so this
    // test cannot drift away from the canonical D22 copy.
    expect(result.stderr).toBe(formatConcurrentOperationRefusal(info, START_LOCK_REL));
    // The shared lifecycle lock is what end takes -- not a separate end lock.
    expect(result.stderr).toContain(START_LOCK_REL);
  });

  it("concurrent operation renders the metadata-unavailable variant (info null)", async () => {
    mockReject(new ConcurrentOperationError(LOCK_DIR, null));

    const result = await runEnd();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(formatConcurrentOperationRefusal(null, START_LOCK_REL));
    expect(result.stderr).toContain("lock metadata unavailable");
  });

  it("lost active session blames the lifecycle-lock protocol, not a competing end", async () => {
    mockReject(new EndSessionRaceError());

    const result = await runEnd();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Active session was removed while ending it.");
    expect(result.stderr).toContain("outside VibeRevert's lifecycle-lock protocol");
    expect(result.stderr).toContain(".viberevert/active-session.json");
    // The superseded explanation must be GONE: since step 4c a competing
    // `viberevert end` is refused at the lock and cannot reach this state, so
    // naming it would send the user after the one cause that is impossible.
    expect(result.stderr).not.toContain("another `viberevert end`");
  });
});

// =============================================================================
// Cleanup warnings on the success path
// =============================================================================

describe("end: cleanup warnings", () => {
  it("no warnings leaves successful output byte-identical and stderr empty", async () => {
    mockResolve(CLEAN_RESULT);

    const result = await runEnd();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // Byte-for-byte, so "empty warnings change nothing" is a real claim.
    expect(result.stdout).toBe(CLEAN_STDOUT);
  });

  it("warnings go to stderr in order, keep exit 0, and leave the summary intact", async () => {
    mockResolve({
      ...CLEAN_RESULT,
      task: "Add yearly billing",
      cleanupWarnings: [
        "git worktree remove --force failed for /tmp/vr-x/worktree: EBUSY",
        "rm -rf /tmp/vr-x failed: EBUSY",
      ],
    });

    const result = await runEnd();

    // NON-FATAL: a failed temp cleanup must not retroactively turn a
    // successfully published end into a failure.
    expect(result.exitCode).toBe(0);
    // Exact equality pins both the `warning: ` prefix and the ORDER.
    expect(result.stderr).toBe(
      "warning: git worktree remove --force failed for /tmp/vr-x/worktree: EBUSY\n" +
        "warning: rm -rf /tmp/vr-x failed: EBUSY\n",
    );
    // The full success summary still renders, including the optional Task line.
    expect(result.stdout).toBe(
      `Session ended.\nID: ${SESSION_ID}\nTask: Add yearly billing\nStarted: ${STARTED_AT}\nEnded: ${ENDED_AT}\n`,
    );
  });
});
