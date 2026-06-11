// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for the package-private exclusive-lock helper in
// packages/cli/src/locks.ts. NOT exported from any public CLI surface,
// so we import it directly via the source path.
//
// What's load-bearing here, by section:
//
//   acquisition + cleanup (real fs):
//     - Happy path: acquire, run fn, release lock dir, return value.
//     - fn() throws under normal cleanup: the original fn error
//       surfaces AND the lock dir is cleaned up (catch-then-rm path).
//     - Concurrent Promise.all acquire: exactly one resolves, the
//       other rejects with ConcurrentOperationError. Lock atomicity
//       comes from `mkdir(lockDir, {recursive: false})` at the OS
//       level — same-process Promise.all exercises the same atomicity
//       path as cross-process contention (per design lean A in the
//       5b/5c plan: subprocess tests would add noise without
//       strengthening the assertion).
//
//   ConcurrentOperationError.info population (real fs):
//     - Populated when lock.json has the expected shape.
//     - Null when lock.json is missing (the brief race window between
//       another holder's mkdir and its lock.json write, OR a
//       crashed-mid-write previous run).
//     - Null when lock.json is unreadable as JSON (corrupt).
//     - Null when lock.json parses as JSON but has the wrong shape
//       (missing keys, wrong types).
//
//   cleanup-failure handling (vi.mock on node:fs/promises):
//     - When fn() throws AND rm() throws: the original fn error
//       surfaces; the rm error is silently swallowed. This locks the
//       deliberate two-path cleanup contract from src/locks.ts —
//       JavaScript's `finally` semantics would otherwise let the rm
//       error mask the fn error, which is the wrong tradeoff.
//     - When fn() succeeds AND rm() throws: the rm error surfaces.
//       The protected operation completed but a stale lock would
//       block the next invocation, so the user needs to know now.
//
// These last two tests use vitest's vi.mock infrastructure to inject
// rm() failures (real OS-level rm failures are platform-specific and
// hard to trigger reliably). The mocking is confined to the cleanup-
// failure tests; all other tests use real fs operations.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ConcurrentOperationError, type LockInfo, withExclusiveLock } from "../src/locks.js";

// Mock node:fs/promises so the cleanup-failure tests can override `rm`.
// The factory delegates to the real implementations by default — only
// the cleanup-failure tests override `rm` per-call via
// `vi.mocked(rm).mockRejectedValueOnce(...)`. All other tests use
// real fs operations as if no mocking were in place.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

// =============================================================================
// Fixtures + setup
// =============================================================================

const TEST_LOCK_INFO: LockInfo = {
  pid: 12345,
  command: "viberevert test-cmd",
  started_at: "2026-05-04T10:30:11Z",
  host: "test-host",
};

let workDir: string;
// Captured once so we can re-establish rm's default delegation after
// any test that mocks it. Using vi.importActual avoids a circular
// reference to the mocked import.
let actualRm: typeof rm;

beforeAll(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  actualRm = actual.rm;
});

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "viberevert-cli-locks-"));
});

afterEach(async () => {
  // Defensive reset of any unconsumed mock state from cleanup-failure
  // tests. mockReset clears history AND implementation; we re-apply
  // the default delegation so afterEach's own rm() call below uses
  // the real rm, and so subsequent tests start with clean defaults.
  vi.mocked(rm).mockReset();
  vi.mocked(rm).mockImplementation(actualRm);
  await rm(workDir, { recursive: true, force: true });
});

// =============================================================================
// withExclusiveLock — acquisition + cleanup (real fs)
// =============================================================================

describe("withExclusiveLock — acquisition + cleanup", () => {
  it("happy path: acquires lock, runs fn, returns value, cleans up the lock dir", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    let fnRan = false;

    const result = await withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => {
      fnRan = true;
      // Inside fn(): the lock dir AND the lock.json metadata exist.
      const stat = await readFile(join(lockDir, "lock.json"), "utf8");
      expect(JSON.parse(stat)).toEqual(TEST_LOCK_INFO);
      return "ok";
    });

    expect(fnRan).toBe(true);
    expect(result).toBe("ok");

    // After return: the lock dir is gone.
    await expect(readFile(join(lockDir, "lock.json"), "utf8")).rejects.toThrow();
  });

  it("fn() throws under normal cleanup: original fn error surfaces AND lock dir is cleaned up", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    const fnError = new Error("fn failure under normal cleanup");

    await expect(
      withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => {
        throw fnError;
      }),
    ).rejects.toBe(fnError);

    // Lock dir gone — the catch-then-rm path ran successfully.
    await expect(readFile(join(lockDir, "lock.json"), "utf8")).rejects.toThrow();
  });

  it("concurrent Promise.all acquire: exactly one wins, the other rejects with ConcurrentOperationError", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    // Both fn()s sleep briefly — long enough that the loser's mkdir
    // attempt happens WHILE the winner still holds the lock. Without
    // the sleep, the winner could acquire-fn-release before the loser
    // even attempts mkdir, removing the contention this test is
    // exercising.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const callA = withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => {
      await sleep(50);
      return "A";
    });
    const callB = withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => {
      await sleep(50);
      return "B";
    });

    const results = await Promise.allSettled([callA, callB]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = fulfilled[0];
    const loser = rejected[0];
    if (winner === undefined || loser === undefined) {
      throw new Error("test bug: missing winner/loser");
    }

    // The winner returned its callback's value.
    expect(["A", "B"]).toContain(winner.value);
    // The loser threw ConcurrentOperationError.
    expect(loser.reason).toBeInstanceOf(ConcurrentOperationError);
  });
});

// =============================================================================
// ConcurrentOperationError.info population (real fs)
// =============================================================================

describe("ConcurrentOperationError.info population", () => {
  it("populated when lock.json has the expected shape", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    // Manually pre-create the lock dir + a valid lock.json (simulating
    // a competing holder).
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "lock.json"), JSON.stringify(TEST_LOCK_INFO));

    let caught: ConcurrentOperationError | undefined;
    try {
      await withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => "never");
    } catch (err) {
      if (err instanceof ConcurrentOperationError) caught = err;
    }
    if (caught === undefined) {
      throw new Error("test bug: expected ConcurrentOperationError");
    }

    expect(caught.lockDir).toBe(lockDir);
    expect(caught.info).toEqual(TEST_LOCK_INFO);
  });

  it("null when lock.json is missing (brief race window or crashed mid-write)", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    // Manually create the lock dir WITHOUT lock.json.
    await mkdir(lockDir, { recursive: true });

    let caught: ConcurrentOperationError | undefined;
    try {
      await withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => "never");
    } catch (err) {
      if (err instanceof ConcurrentOperationError) caught = err;
    }
    if (caught === undefined) {
      throw new Error("test bug: expected ConcurrentOperationError");
    }

    expect(caught.info).toBeNull();
  });

  it("null when lock.json is corrupt JSON", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "lock.json"), "{this is not valid JSON");

    let caught: ConcurrentOperationError | undefined;
    try {
      await withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => "never");
    } catch (err) {
      if (err instanceof ConcurrentOperationError) caught = err;
    }
    if (caught === undefined) {
      throw new Error("test bug: expected ConcurrentOperationError");
    }

    expect(caught.info).toBeNull();
  });

  it("null when lock.json parses as JSON but has the wrong shape (wrong types / missing keys)", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    await mkdir(lockDir, { recursive: true });
    // pid is a string instead of a number; host key entirely missing.
    await writeFile(
      join(lockDir, "lock.json"),
      JSON.stringify({
        pid: "not-a-number",
        command: "viberevert test",
        started_at: "2026-05-04T10:30:11Z",
        // host: missing
      }),
    );

    let caught: ConcurrentOperationError | undefined;
    try {
      await withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => "never");
    } catch (err) {
      if (err instanceof ConcurrentOperationError) caught = err;
    }
    if (caught === undefined) {
      throw new Error("test bug: expected ConcurrentOperationError");
    }

    expect(caught.info).toBeNull();
  });
});

// =============================================================================
// withExclusiveLock — cleanup-failure handling (vi.mock)
// =============================================================================

describe("withExclusiveLock — cleanup-failure handling", () => {
  it("preserves fn() error when BOTH fn() and rm() throw", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    const fnError = new Error("fn failure (the real cause)");
    const rmError = new Error("rm failure (must be silently swallowed)");

    // Override rm() to reject ONCE. The catch-then-rm path inside
    // withExclusiveLock will hit this and swallow it; the outer
    // throw should be fnError, not rmError.
    vi.mocked(rm).mockRejectedValueOnce(rmError);

    await expect(
      withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => {
        throw fnError;
      }),
    ).rejects.toBe(fnError);
  });

  it("surfaces cleanup error when fn() succeeds but rm() throws (success-with-leaked-lock case)", async () => {
    const lockDir = join(workDir, ".locks", "test.lock");
    const rmError = new Error("rm failure on success path");

    // Override rm() to reject ONCE. The post-success rm path inside
    // withExclusiveLock will hit this and propagate it — the user
    // needs to know about the stale lock immediately.
    vi.mocked(rm).mockRejectedValueOnce(rmError);

    await expect(withExclusiveLock(lockDir, TEST_LOCK_INFO, async () => "ok")).rejects.toBe(
      rmError,
    );
  });
});
