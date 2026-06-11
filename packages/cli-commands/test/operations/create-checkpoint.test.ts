// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Operation-layer tests for createCheckpointOperation. Focused on
// contract specifics that distinguish the operation boundary from the
// Command boundary:
//
//   1. Typed result shape (CreateCheckpointOperationResult).
//   2. D99.M.21 cwd-binding — operation uses opts.cwd, never
//      process.cwd().
//   3. Typed errors thrown (caller-observable without stderr scraping),
//      including the operation-public wrap of the helper-internal
//      CheckpointListLoadError → CreateCheckpointListLoadError.
//      Collision refusals MUST be side-effect-free (MCP safety
//      contract: a failed `create_checkpoint` tool call cannot
//      secretly create artifacts).
//   4. Nameless-skip invariant — nameless checkpoints do not scan
//      and do not lock (behavioral invariant per D5b lock #4, not
//      just an optimization).
//   5. D22 lock-metadata command label — nameless skips the lock
//      entirely; named uses the CLI default or the MCP override. All
//      observed at the lock boundary via a mocked withExclusiveLock.
//
// CLI-level coverage (stderr copy, exit codes, harness wiring) stays
// in checkpoint.test.ts as drift-detection layer 1 — that file MUST
// continue to pass against the refactored CheckpointCommand.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RepoRootNotFoundError } from "@viberevert/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LockInfo } from "../../src/locks.js";
import {
  CheckpointNameCollisionError,
  type CreateCheckpointOperationResult,
  createCheckpointOperation,
} from "../../src/operations/create-checkpoint.js";

const execFileAsync = promisify(execFile);

let tmpRoot: string;
let originalCwd: string;

/**
 * Create a real git repo + minimal `.viberevert.yml` + `.gitignore`.
 * Operations are config-required (D19) so .viberevert.yml is mandatory.
 * NO `process.chdir` here — operations use opts.cwd, not process.cwd().
 */
async function setupRepo(): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: tmpRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.test",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
    { cwd: tmpRoot },
  );
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\nchecks:\n  secrets: true\n");
}

/**
 * Count actual `cp_<ULID>` checkpoint directories under
 * `.viberevert/checkpoints/`. Strict: directory-only + full ULID
 * regex match. Skips stray files, partial temp dirs, and any
 * non-matching entries. Returns 0 when the checkpoints dir doesn't
 * exist yet.
 */
async function countCheckpointDirs(repoRoot: string): Promise<number> {
  const dir = join(repoRoot, ".viberevert", "checkpoints");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(
      (entry) => entry.isDirectory() && /^cp_[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.name),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Count leftover `.tmp-checkpoint-<hex>/` temp directories under
 * `.viberevert/checkpoints/`. Used by the collision side-effect-free
 * assertion: the collision throw happens BEFORE any temp dir
 * creation, so this MUST be 0 after a refused collision call.
 */
async function countLeftoverTmpDirs(repoRoot: string): Promise<number> {
  const dir = join(repoRoot, ".viberevert", "checkpoints");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(".tmp-checkpoint-"),
    ).length;
  } catch {
    return 0;
  }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cpop-"));
  originalCwd = process.cwd();
  await setupRepo();
});

afterEach(async () => {
  // Restore cwd (cwd-binding test changes it; restoring before rm
  // avoids Windows file-lock issues per the existing CLI test pattern).
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("createCheckpointOperation — typed result shape", () => {
  it("returns {checkpointId, createdAt} with valid ULID prefix + ISO timestamp", async () => {
    const result: CreateCheckpointOperationResult = await createCheckpointOperation({
      cwd: tmpRoot,
    });

    expect(result.checkpointId).toMatch(/^cp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // The checkpoint dir exists on disk at the returned id.
    const cpDir = join(tmpRoot, ".viberevert", "checkpoints", result.checkpointId);
    const cpStat = await stat(cpDir);
    expect(cpStat.isDirectory()).toBe(true);
  });
});

describe("createCheckpointOperation — D99.M.21 cwd binding (critical operation-contract boundary)", () => {
  it("uses opts.cwd, NOT process.cwd(): checkpoint is created at opts.cwd even when process.cwd() points elsewhere", async () => {
    const unrelatedDir = await mkdtemp(join(tmpdir(), "viberevert-cpop-unrelated-"));
    try {
      process.chdir(unrelatedDir);

      const result = await createCheckpointOperation({ cwd: tmpRoot });

      // Checkpoint MUST exist under tmpRoot (the opts.cwd repo).
      const cpDir = join(tmpRoot, ".viberevert", "checkpoints", result.checkpointId);
      const cpStat = await stat(cpDir);
      expect(cpStat.isDirectory()).toBe(true);

      // And MUST NOT exist under unrelatedDir.
      await expect(stat(join(unrelatedDir, ".viberevert", "checkpoints"))).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      await rm(unrelatedDir, { recursive: true, force: true });
    }
  });
});

describe("createCheckpointOperation — typed errors", () => {
  it("throws RepoRootNotFoundError when opts.cwd is not a git/viberevert project", async () => {
    const nonRepoDir = await mkdtemp(join(tmpdir(), "viberevert-cpop-norepo-"));
    try {
      await expect(createCheckpointOperation({ cwd: nonRepoDir })).rejects.toBeInstanceOf(
        RepoRootNotFoundError,
      );
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true });
    }
  });

  it("throws CheckpointNameCollisionError on duplicate name; collision refusal is side-effect-free (MCP safety contract: failed create_checkpoint cannot create artifacts) — all assertions verified against the SAME failed call", async () => {
    // Plant a real checkpoint with a known name.
    await createCheckpointOperation({ cwd: tmpRoot, name: "shared-name" });

    const beforeCount = await countCheckpointDirs(tmpRoot);
    expect(beforeCount).toBe(1);

    // Second invocation with the SAME name — capture the thrown error
    // SINGLE-CALL so the typed-field assertion AND the side-effect
    // assertion refer to the EXACT same failed call (no implicit
    // "two failed calls behave identically" assumption).
    let caught: unknown;
    try {
      await createCheckpointOperation({ cwd: tmpRoot, name: "shared-name" });
    } catch (err) {
      caught = err;
    }

    // Typed-error class + carry-typed-field assertion (for D5b
    // refusal copy + MCP envelope.details.name).
    expect(caught).toBeInstanceOf(CheckpointNameCollisionError);
    expect((caught as CheckpointNameCollisionError).checkpointName).toBe("shared-name");

    // Side-effect-free assertion #1: NO second `cp_<ULID>/` final
    // checkpoint dir was created on the collision-refusal path.
    // Critical for MCP: a failed `create_checkpoint` tool call cannot
    // secretly produce a floating final-artifact dir.
    const afterCount = await countCheckpointDirs(tmpRoot);
    expect(afterCount).toBe(beforeCount);

    // Side-effect-free assertion #2: NO leftover
    // `.tmp-checkpoint-<hex>/` temp dir either. The collision throw
    // fires BEFORE any temp-dir creation (Step 4a's check precedes
    // Step 4b's `mkdir(tmpDirAbs)` in the operation), so this MUST
    // be 0. Locks the literal "side-effect-free" property for both
    // final and temp artifacts.
    const leftoverTmps = await countLeftoverTmpDirs(tmpRoot);
    expect(leftoverTmps).toBe(0);
  });

  it("wraps helper-internal CheckpointListLoadError as operation-public CreateCheckpointListLoadError (mocked checkpoint-helpers boundary; object-identity assertion to avoid cross-module-constructor brittleness)", async () => {
    // Mock the helpers module so safeListCheckpoints throws the
    // helper-internal CheckpointListLoadError. The operation MUST
    // wrap it into its operation-public CreateCheckpointListLoadError
    // — never let the helper-internal type cross the operation
    // boundary (D99.M.19 barrier).
    //
    // After vi.resetModules() + dynamic import, the operation gets
    // its OWN module-instance class references. Asserting
    // `instanceof CheckpointListLoadError` against the top-level
    // static import would compare different constructor objects and
    // fail. Capturing the exact thrown error in `syntheticHelperError`
    // lets us assert OBJECT IDENTITY on `wrapped.cause` — proving the
    // operation passed the helper error through unchanged without
    // depending on constructor identity.
    vi.resetModules();
    let syntheticHelperError: unknown;
    vi.doMock("../../src/checkpoint-helpers.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/checkpoint-helpers.js")>();
      return {
        ...actual,
        safeListCheckpoints: async (repoRoot: string) => {
          const syntheticCause = new Error("synthetic corruption for wrap test");
          syntheticHelperError = new actual.CheckpointListLoadError({
            repoRoot,
            cause: syntheticCause,
          });
          throw syntheticHelperError;
        },
      };
    });
    try {
      const { createCheckpointOperation: createCheckpointOperationWithMockedHelpers } =
        await import("../../src/operations/create-checkpoint.js");
      try {
        await createCheckpointOperationWithMockedHelpers({
          cwd: tmpRoot,
          name: "anything",
        });
        expect.fail("expected CreateCheckpointListLoadError");
      } catch (err) {
        // Narrow by `name` + structural fields (NOT by `instanceof
        // CreateCheckpointListLoadError` — the dynamic module
        // instance has its own constructor identity).
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe("CreateCheckpointListLoadError");

        // CLI stderr template `${err.message}` requires the wrapper's
        // message to preserve the cause's message verbatim.
        expect((err as Error).message).toBe("synthetic corruption for wrap test");

        const wrapped = err as Error & { repoRoot: string; cause: unknown };
        expect(wrapped.repoRoot).toBe(tmpRoot);

        // Object-identity assertion on `cause` — proves the operation
        // passed the helper error through unchanged. The public type
        // is `unknown` (D99.M.19 barrier); we narrow with name +
        // identity, NOT instanceof against the top-level static
        // import.
        expect(wrapped.cause).toBe(syntheticHelperError);
        expect(wrapped.cause).toBeInstanceOf(Error);
        expect((wrapped.cause as Error).name).toBe("CheckpointListLoadError");
      }
    } finally {
      vi.doUnmock("../../src/checkpoint-helpers.js");
      vi.resetModules();
    }
  });
});

describe("createCheckpointOperation — nameless invariants (no scan, no lock)", () => {
  it("nameless checkpoints DO NOT call safeListCheckpoints (mocked to throw — would fail if the operation called it; behavioral invariant per D5b lock #4, NOT just an optimization)", async () => {
    // Mock the helpers module so safeListCheckpoints throws if
    // called. The nameless code path MUST NOT invoke it — calling
    // it would surface a corruption error from an unrelated
    // pre-existing named checkpoint as a refusal on a fresh nameless
    // checkpoint, which would break the user-expected "checkpoint
    // works at any time" contract.
    vi.resetModules();
    vi.doMock("../../src/checkpoint-helpers.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/checkpoint-helpers.js")>();
      return {
        ...actual,
        safeListCheckpoints: async () => {
          throw new Error("safeListCheckpoints should NOT be called on nameless path");
        },
      };
    });
    try {
      const { createCheckpointOperation: createCheckpointOperationWithMockedHelpers } =
        await import("../../src/operations/create-checkpoint.js");
      // Nameless invocation — must succeed despite the mock that
      // would throw on any safeListCheckpoints call.
      const result = await createCheckpointOperationWithMockedHelpers({ cwd: tmpRoot });
      expect(result.checkpointId).toMatch(/^cp_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    } finally {
      vi.doUnmock("../../src/checkpoint-helpers.js");
      vi.resetModules();
    }
  });
});

describe("createCheckpointOperation — D22 lock metadata (mocked locks boundary)", () => {
  // Mock only the lock boundary so the operation still runs its real
  // domain flow while the test can observe the D22 lock metadata
  // without a timing race.

  /**
   * Helper that vi-mocks `../../src/locks.js`, dynamically re-imports
   * the operation so it sees the mock, runs it once with the supplied
   * opts, and returns ALL captured LockInfos (zero or more — nameless
   * checkpoints skip the lock entirely per D5b lock #4). Guarantees
   * mock cleanup via try/finally so a failed assertion can't poison
   * sibling tests.
   */
  async function captureLockInfos(
    opts: Parameters<typeof createCheckpointOperation>[0],
  ): Promise<LockInfo[]> {
    vi.resetModules();
    const capturedLockInfos: LockInfo[] = [];
    vi.doMock("../../src/locks.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/locks.js")>();
      return {
        ...actual,
        withExclusiveLock: async <T>(
          _lockDir: string,
          lockInfo: LockInfo,
          protectedFlow: () => Promise<T>,
        ): Promise<T> => {
          capturedLockInfos.push(lockInfo);
          return protectedFlow();
        },
      };
    });
    try {
      const { createCheckpointOperation: createCheckpointOperationWithMockedLock } = await import(
        "../../src/operations/create-checkpoint.js"
      );
      await createCheckpointOperationWithMockedLock(opts);
      return capturedLockInfos;
    } finally {
      vi.doUnmock("../../src/locks.js");
      vi.resetModules();
    }
  }

  it("does NOT acquire a lock when name is omitted (nameless checkpoint — no uniqueness invariant to protect per D5b lock #4)", async () => {
    const infos = await captureLockInfos({ cwd: tmpRoot });
    expect(infos).toHaveLength(0);
  });

  it("uses the default CLI literal when name is supplied without lockCommand", async () => {
    const infos = await captureLockInfos({ cwd: tmpRoot, name: "test-cp" });
    expect(infos).toHaveLength(1);
    expect(infos[0]?.command).toBe('viberevert checkpoint --name "test-cp"');
  });

  it("uses the lockCommand override when supplied (MCP path)", async () => {
    const infos = await captureLockInfos({
      cwd: tmpRoot,
      name: "test-cp",
      lockCommand: "viberevert mcp create_checkpoint",
    });
    expect(infos).toHaveLength(1);
    expect(infos[0]?.command).toBe("viberevert mcp create_checkpoint");
  });
});
