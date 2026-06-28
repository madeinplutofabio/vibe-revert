// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IntegrationsLockError,
  IntegrationTargetParentNotDirectoryError,
  SymlinkTargetRefusal,
} from "../src/errors.js";
import { acquireLock, releaseLock } from "../src/lock.js";

import { createDirectorySymlink, createTempRepo, SYMLINKS_SUPPORTED } from "./helpers/temp-repo.js";

let tempRepo: Awaited<ReturnType<typeof createTempRepo>>;

beforeEach(async () => {
  tempRepo = await createTempRepo();
});

afterEach(async () => {
  // Cleanup uses force:true so partial/corrupted lock state from
  // intentional-corruption tests is removed regardless.
  await tempRepo.cleanup();
});

describe("acquireLock -- success path", () => {
  it("creates .viberevert/integrations.lock/pid.json", async () => {
    const handle = await acquireLock(tempRepo.repoRoot, "install");
    try {
      const lockDir = join(tempRepo.repoRoot, ".viberevert", "integrations.lock");
      const pidPath = join(lockDir, "pid.json");
      const dirStat = await stat(lockDir);
      expect(dirStat.isDirectory()).toBe(true);
      const pidContent = await readFile(pidPath, "utf8");
      const pid = JSON.parse(pidContent) as {
        pid: unknown;
        startedAt: unknown;
        command: unknown;
      };
      expect(pid.pid).toBe(process.pid);
      expect(pid.command).toBe("install");
      // startedAt is some valid ISO timestamp (no fake timers; don't
      // assert exact value).
      expect(typeof pid.startedAt).toBe("string");
      expect(Number.isNaN(Date.parse(pid.startedAt as string))).toBe(false);
    } finally {
      await releaseLock(handle);
    }
  });
  it("records 'uninstall' command in pid.json when acquired with that kind", async () => {
    const handle = await acquireLock(tempRepo.repoRoot, "uninstall");
    try {
      const pidPath = join(tempRepo.repoRoot, ".viberevert", "integrations.lock", "pid.json");
      const pid = JSON.parse(await readFile(pidPath, "utf8")) as { command: unknown };
      expect(pid.command).toBe("uninstall");
    } finally {
      await releaseLock(handle);
    }
  });
  it("creates .viberevert/ if it does not exist", async () => {
    const handle = await acquireLock(tempRepo.repoRoot, "install");
    try {
      const st = await stat(join(tempRepo.repoRoot, ".viberevert"));
      expect(st.isDirectory()).toBe(true);
    } finally {
      await releaseLock(handle);
    }
  });
});

describe("acquireLock -- second acquire refuses", () => {
  it("throws IntegrationsLockError when lock is already held by this process", async () => {
    const handle = await acquireLock(tempRepo.repoRoot, "install");
    try {
      try {
        await acquireLock(tempRepo.repoRoot, "install");
        throw new Error("expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(IntegrationsLockError);
        const lockErr = err as IntegrationsLockError;
        expect(lockErr.lockDir).toBe(join(tempRepo.repoRoot, ".viberevert", "integrations.lock"));
        expect(lockErr.existingPid).toBe(process.pid);
      }
    } finally {
      await releaseLock(handle);
    }
  });
  it("throws IntegrationsLockError + reports existingPid for stale lock from prior process", async () => {
    // Simulate stale lock: pre-create lock dir + pid.json manually
    // (as if a prior process crashed without releasing). acquireLock
    // does NOT auto-clean -- it refuses with the diagnostic pid.
    const lockDir = join(tempRepo.repoRoot, ".viberevert", "integrations.lock");
    const pidPath = join(lockDir, "pid.json");
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    await mkdir(lockDir);
    await writeFile(
      pidPath,
      JSON.stringify({
        pid: 99999,
        startedAt: "2026-01-01T00:00:00.000Z",
        command: "install",
      }),
    );
    try {
      await acquireLock(tempRepo.repoRoot, "install");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationsLockError);
      expect((err as IntegrationsLockError).existingPid).toBe(99999);
    }
  });
});

describe("acquireLock -- no stale-lock auto-cleanup", () => {
  it("leaves stale lock dir in place after refusal (does NOT auto-clean)", async () => {
    const lockDir = join(tempRepo.repoRoot, ".viberevert", "integrations.lock");
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    await mkdir(lockDir);
    await writeFile(
      join(lockDir, "pid.json"),
      JSON.stringify({
        pid: 99999,
        startedAt: "2026-01-01T00:00:00.000Z",
        command: "install",
      }),
    );
    await expect(acquireLock(tempRepo.repoRoot, "install")).rejects.toThrow(IntegrationsLockError);
    // Lock dir still exists after refused acquire.
    const st = await stat(lockDir);
    expect(st.isDirectory()).toBe(true);
  });
});

describe("releaseLock -- success path", () => {
  it("removes integrations.lock/ dir but leaves .viberevert/ intact", async () => {
    const handle = await acquireLock(tempRepo.repoRoot, "install");
    await releaseLock(handle);
    const lockDir = join(tempRepo.repoRoot, ".viberevert", "integrations.lock");
    await expect(stat(lockDir)).rejects.toThrow();
    // .viberevert/ itself remains; release only removes the lock
    // subdirectory.
    const viberevertDir = join(tempRepo.repoRoot, ".viberevert");
    const st = await stat(viberevertDir);
    expect(st.isDirectory()).toBe(true);
  });
});

describe("releaseLock -- corruption refusal", () => {
  it("throws when pid.json is missing under the lock dir (corruption)", async () => {
    // Acquire normally, then corrupt the real lock state by
    // unlinking pid.json out from under it. releaseLock walks
    // lstat-guard -> unlink(pidPath) -> rmdir(lockDir); the unlink
    // fails with ENOENT and the error propagates (NOT silently
    // swallowed).
    const handle = await acquireLock(tempRepo.repoRoot, "install");
    const pidPath = join(tempRepo.repoRoot, ".viberevert", "integrations.lock", "pid.json");
    await unlink(pidPath);
    await expect(releaseLock(handle)).rejects.toThrow();
  });
});

describe("acquireLock -- non-directory .viberevert/ refusal", () => {
  it("refuses when .viberevert/ exists as a regular file", async () => {
    await writeFile(join(tempRepo.repoRoot, ".viberevert"), "not a directory");
    await expect(acquireLock(tempRepo.repoRoot, "install")).rejects.toThrow(
      IntegrationTargetParentNotDirectoryError,
    );
  });
});

describe.skipIf(!SYMLINKS_SUPPORTED)("acquireLock -- symlink refusals", () => {
  it("refuses symlinked .viberevert/ dir", async () => {
    const externalDir = join(tempRepo.repoRoot, "elsewhere");
    await mkdir(externalDir);
    await createDirectorySymlink(externalDir, join(tempRepo.repoRoot, ".viberevert"));
    try {
      await acquireLock(tempRepo.repoRoot, "install");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SymlinkTargetRefusal);
      expect((err as SymlinkTargetRefusal).symlinkedComponentPath).toBe(
        join(tempRepo.repoRoot, ".viberevert"),
      );
    }
  });
  it("refuses symlinked lock dir on stale-lock encounter", async () => {
    // Real .viberevert/ but the lock dir itself is a symlink.
    // acquireLock's EEXIST branch triggers assertExistingLockDirIsSafe
    // which lstats the lock dir and refuses on symlink.
    await mkdir(join(tempRepo.repoRoot, ".viberevert"));
    const externalDir = join(tempRepo.repoRoot, "elsewhere-lock");
    await mkdir(externalDir);
    const lockDir = join(tempRepo.repoRoot, ".viberevert", "integrations.lock");
    await createDirectorySymlink(externalDir, lockDir);
    try {
      await acquireLock(tempRepo.repoRoot, "install");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SymlinkTargetRefusal);
      expect((err as SymlinkTargetRefusal).symlinkedComponentPath).toBe(lockDir);
    }
  });
});
