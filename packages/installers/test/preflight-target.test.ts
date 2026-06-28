// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IntegrationTargetNotFileError,
  IntegrationTargetParentNotDirectoryError,
  IntegrationTargetTooLargeError,
  SymlinkTargetRefusal,
  TargetOutsideRepoRootError,
} from "../src/errors.js";
import { assertSafeTarget, MAX_MERGE_BYTES } from "../src/preflight-target.js";

import { createDirectorySymlink, createTempRepo, SYMLINKS_SUPPORTED } from "./helpers/temp-repo.js";

let tempRepo: Awaited<ReturnType<typeof createTempRepo>>;

beforeEach(async () => {
  tempRepo = await createTempRepo();
});

afterEach(async () => {
  await tempRepo.cleanup();
});

describe("assertSafeTarget -- outside-repo refusals", () => {
  it("refuses target equal to repoRoot", async () => {
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath: tempRepo.repoRoot,
        op: "write",
      }),
    ).rejects.toThrow(TargetOutsideRepoRootError);
  });
  it("refuses target above repoRoot (parent traversal)", async () => {
    const outsidePath = resolve(tempRepo.repoRoot, "..", "escape.txt");
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath: outsidePath,
        op: "write",
      }),
    ).rejects.toThrow(TargetOutsideRepoRootError);
  });
  it("allows ..evil/file.txt (legitimate segment that starts with .. but isn't traversal)", async () => {
    // The outside-repo check uses startsWith(`..${sep}`), NOT bare
    // startsWith(".."), so segments like "..evil/" are allowed --
    // they're a real (if oddly named) directory inside repoRoot.
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath: join(tempRepo.repoRoot, "..evil", "file.txt"),
        op: "write",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertSafeTarget -- existing target file kind", () => {
  it("allows existing regular file at target (write op)", async () => {
    const targetPath = join(tempRepo.repoRoot, "config.json");
    await writeFile(targetPath, "{}");
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath,
        op: "write",
      }),
    ).resolves.toBeUndefined();
  });
  it("refuses directory at target path", async () => {
    const targetPath = join(tempRepo.repoRoot, "wrongkind");
    await mkdir(targetPath);
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath,
        op: "write",
      }),
    ).rejects.toThrow(IntegrationTargetNotFileError);
  });
});

describe("assertSafeTarget -- intermediate component kind", () => {
  it("refuses when intermediate path component is a file (not a directory)", async () => {
    const filePath = join(tempRepo.repoRoot, "intermediate");
    await writeFile(filePath, "x");
    const targetPath = join(filePath, "child.txt");
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath,
        op: "write",
      }),
    ).rejects.toThrow(IntegrationTargetParentNotDirectoryError);
  });
});

describe("assertSafeTarget -- missing components allowed", () => {
  it("allows missing target in existing parent", async () => {
    const parentDir = join(tempRepo.repoRoot, "subdir");
    await mkdir(parentDir);
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath: join(parentDir, "absent.txt"),
        op: "write",
      }),
    ).resolves.toBeUndefined();
  });
  it("allows missing target with missing intermediate dirs", async () => {
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath: join(tempRepo.repoRoot, "a", "b", "c", "absent.txt"),
        op: "write",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertSafeTarget -- size limit (merge only)", () => {
  it("refuses merge target over MAX_MERGE_BYTES", async () => {
    const targetPath = join(tempRepo.repoRoot, "big.json");
    await writeFile(targetPath, Buffer.alloc(MAX_MERGE_BYTES + 1, "x"));
    try {
      await assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath,
        op: "merge",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationTargetTooLargeError);
      const sized = err as IntegrationTargetTooLargeError;
      expect(sized.sizeBytes).toBe(MAX_MERGE_BYTES + 1);
      expect(sized.limitBytes).toBe(MAX_MERGE_BYTES);
    }
  });
  it("allows write target over MAX_MERGE_BYTES (write op skips size check)", async () => {
    const targetPath = join(tempRepo.repoRoot, "big.json");
    await writeFile(targetPath, Buffer.alloc(MAX_MERGE_BYTES + 1, "x"));
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath,
        op: "write",
      }),
    ).resolves.toBeUndefined();
  });
  it("allows merge target at exactly MAX_MERGE_BYTES (inclusive boundary)", async () => {
    // Spec is `> MAX_MERGE_BYTES` refuses; exactly == is allowed.
    const targetPath = join(tempRepo.repoRoot, "exact.json");
    await writeFile(targetPath, Buffer.alloc(MAX_MERGE_BYTES, "x"));
    await expect(
      assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath,
        op: "merge",
      }),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!SYMLINKS_SUPPORTED)("assertSafeTarget -- symlink refusals", () => {
  it("refuses existing target that is a symlink", async () => {
    const realTarget = join(tempRepo.repoRoot, "real");
    await mkdir(realTarget);
    const linkPath = join(tempRepo.repoRoot, "linked.json");
    await createDirectorySymlink(realTarget, linkPath);
    try {
      await assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath: linkPath,
        op: "write",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SymlinkTargetRefusal);
      expect((err as SymlinkTargetRefusal).symlinkedComponentPath).toBe(linkPath);
    }
  });
  it("refuses target with intermediate symlink in path", async () => {
    const realDir = join(tempRepo.repoRoot, "real-config");
    await mkdir(realDir);
    const linkedDir = join(tempRepo.repoRoot, "linked-config");
    await createDirectorySymlink(realDir, linkedDir);
    const targetPath = join(linkedDir, "mcp.json");
    try {
      await assertSafeTarget({
        repoRoot: tempRepo.repoRoot,
        targetPath,
        op: "write",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SymlinkTargetRefusal);
      expect((err as SymlinkTargetRefusal).symlinkedComponentPath).toBe(linkedDir);
    }
  });
});
