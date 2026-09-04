// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for `withRollbackLockCapturingRelease` in
// packages/cli-commands/src/rollback-lock.ts.
//
// The load-bearing case is the last one: a callback that COMPLETED, followed by
// a release that failed. `withExclusiveLock` releases with an unguarded `rm`,
// so the naive wrapper throws and loses a result that is already durably
// recorded on disk. Everything else here exists to prove that case is
// distinguished from the two that legitimately throw.
//
// Forcing a release failure needs `rm` to fail on the lock directory, and no
// portable filesystem state produces that reliably: an open handle blocks
// removal on Windows and not on Linux, and a read-only parent behaves the
// reverse way. So this file mocks `node:fs/promises`, passthrough by default,
// intercepting `rm` only while a test opts in and only for the lock path. Every
// other operation, including the assertions about whether the directory
// survived, is real IO.

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ failLockRm: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: unknown) => {
      if (hooks.failLockRm && typeof path === "string" && path.endsWith("rollback.lock")) {
        throw Object.assign(new Error("EBUSY: lock directory is in use"), { code: "EBUSY" });
      }
      return await actual.rm(path, options as Parameters<typeof actual.rm>[1]);
    },
  };
});

import { ConcurrentOperationError, type LockInfo } from "../src/locks.js";
import { withRollbackLockCapturingRelease } from "../src/rollback-lock.js";

const LOCK_REL = join(".viberevert", ".locks", "rollback.lock");

const INFO: LockInfo = {
  pid: 1234,
  command: "viberevert rollback",
  started_at: "2026-01-01T00:00:00Z",
  host: "test-host",
};

let repoRoot: string;
let lockDir: string;

beforeEach(async () => {
  hooks.failLockRm = false;
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-rollback-lock-"));
  lockDir = join(repoRoot, LOCK_REL);
});

afterEach(async () => {
  hooks.failLockRm = false;
  await rm(repoRoot, { recursive: true, force: true });
});

const lockExists = async (): Promise<boolean> => {
  try {
    await readdir(lockDir);
    return true;
  } catch {
    return false;
  }
};

describe("withRollbackLockCapturingRelease: the ordinary path", () => {
  it("returns the result and reports the lock released", async () => {
    const run = await withRollbackLockCapturingRelease(repoRoot, INFO, async () => "restored");

    expect(run.result).toBe("restored");
    expect(run.lockRelease).toEqual({ state: "released" });
    expect(await lockExists()).toBe(false);
  });

  it("actually holds the lock while the callback runs", async () => {
    await withRollbackLockCapturingRelease(repoRoot, INFO, async () => {
      expect(await lockExists()).toBe(true);
    });
  });
});

describe("withRollbackLockCapturingRelease: failures that must still throw", () => {
  it("a callback failure propagates, because there is no result to preserve", async () => {
    const boom = new Error("the transaction threw");

    await expect(
      withRollbackLockCapturingRelease(repoRoot, INFO, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // `withExclusiveLock` cleans up on its failure path, so nothing is stranded.
    expect(await lockExists()).toBe(false);
  });

  it("an acquisition failure propagates as ConcurrentOperationError", async () => {
    // Another holder already owns the lock.
    await mkdir(lockDir, { recursive: true });

    await expect(
      withRollbackLockCapturingRelease(repoRoot, INFO, async () => "never runs"),
    ).rejects.toBeInstanceOf(ConcurrentOperationError);
  });

  it("does not run the callback when acquisition fails", async () => {
    await mkdir(lockDir, { recursive: true });
    let ran = false;

    await expect(
      withRollbackLockCapturingRelease(repoRoot, INFO, async () => {
        ran = true;
        return "x";
      }),
    ).rejects.toBeInstanceOf(ConcurrentOperationError);
    expect(ran).toBe(false);
  });
});

describe("withRollbackLockCapturingRelease: a release failure keeps the result", () => {
  it("returns the produced result alongside release_failed", async () => {
    hooks.failLockRm = true;

    const run = await withRollbackLockCapturingRelease(repoRoot, INFO, async () => "restored");

    // The whole point: the callback completed, so its outcome survives.
    expect(run.result).toBe("restored");
    expect(run.lockRelease.state).toBe("release_failed");
  });

  it("names the lock directory explicitly for the manual-removal remedy", async () => {
    hooks.failLockRm = true;

    const run = await withRollbackLockCapturingRelease(repoRoot, INFO, async () => "restored");

    if (run.lockRelease.state !== "release_failed") throw new Error("expected release_failed");
    // Carried explicitly rather than recovered from the error, which is not
    // required to name the directory it failed on.
    expect(run.lockRelease.path).toBe(lockDir);
    expect(run.lockRelease.cause).toBeInstanceOf(Error);
  });

  it("leaves the lock directory in place, which is what the remedy addresses", async () => {
    hooks.failLockRm = true;

    await withRollbackLockCapturingRelease(repoRoot, INFO, async () => "restored");

    expect(await lockExists()).toBe(true);
  });

  it("still throws when the CALLBACK failed, even though release also fails", async () => {
    // Both go wrong at once. With no result to preserve, the callback's failure
    // is the one that matters and must not be masked by the lock's.
    hooks.failLockRm = true;
    const boom = new Error("the transaction threw");

    await expect(
      withRollbackLockCapturingRelease(repoRoot, INFO, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
