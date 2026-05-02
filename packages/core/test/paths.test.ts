// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureViberevertDirs,
  RepoRootNotFoundError,
  resolveRepoRoot,
  viberevertDir,
} from "../src/index.js";

// Each test gets a fresh temp directory and cleans up after itself.
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-paths-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("viberevertDir", () => {
  it("joins '.viberevert' onto the repo root", () => {
    expect(viberevertDir("/some/repo")).toBe(join("/some/repo", ".viberevert"));
  });

  it("does not check existence", () => {
    // Pure path join; works on a path that doesn't exist.
    expect(viberevertDir("/no/such/path")).toBe(join("/no/such/path", ".viberevert"));
  });
});

describe("resolveRepoRoot", () => {
  it("finds the directory containing a .git directory", async () => {
    await mkdir(join(tmpRoot, ".git"));
    expect(resolveRepoRoot(tmpRoot)).toBe(tmpRoot);
  });

  it("finds the directory containing a .git file (worktree gitlink)", async () => {
    await writeFile(join(tmpRoot, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    expect(resolveRepoRoot(tmpRoot)).toBe(tmpRoot);
  });

  it("finds the directory containing a .viberevert.yml file", async () => {
    await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
    expect(resolveRepoRoot(tmpRoot)).toBe(tmpRoot);
  });

  it("rejects a .viberevert.yml directory (must be a regular file)", async () => {
    await mkdir(join(tmpRoot, ".viberevert.yml"));
    expect(() => resolveRepoRoot(tmpRoot)).toThrow(RepoRootNotFoundError);
  });

  it("walks upward to find the nearest marker", async () => {
    await mkdir(join(tmpRoot, ".git"));
    const deep = join(tmpRoot, "a", "b", "c");
    await mkdir(deep, { recursive: true });
    expect(resolveRepoRoot(deep)).toBe(tmpRoot);
  });

  it("nearest marker wins: nested .viberevert.yml resolves to nested project root", async () => {
    await mkdir(join(tmpRoot, ".git"));

    const sub = join(tmpRoot, "sub");
    const deep = join(sub, "a", "b");
    await mkdir(deep, { recursive: true });
    await writeFile(join(sub, ".viberevert.yml"), "version: 1\n");

    expect(resolveRepoRoot(deep)).toBe(sub);
    expect(resolveRepoRoot(tmpRoot)).toBe(tmpRoot);
  });

  it("throws RepoRootNotFoundError when no marker is found", () => {
    // tmpRoot has no .git and no .viberevert.yml; walking up will reach
    // the filesystem root without a match.
    expect(() => resolveRepoRoot(tmpRoot)).toThrow(RepoRootNotFoundError);
  });

  it("error message includes the start dir for debuggability", () => {
    let err: unknown;
    try {
      resolveRepoRoot(tmpRoot);
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(RepoRootNotFoundError);
    expect((err as Error).message).toContain(tmpRoot);
  });

  it("default startDir is process.cwd()", () => {
    // Process CWD when running tests is the package root, which is inside
    // the workspace and therefore inside our own .git. resolveRepoRoot()
    // with no argument should succeed and return *some* absolute path.
    const result = resolveRepoRoot();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("ensureViberevertDirs", () => {
  it("creates .viberevert/{sessions,checkpoints,reports}", async () => {
    await ensureViberevertDirs(tmpRoot);
    const root = viberevertDir(tmpRoot);
    for (const sub of ["sessions", "checkpoints", "reports"]) {
      const stats = await stat(join(root, sub));
      expect(stats.isDirectory()).toBe(true);
    }
  });

  it("is idempotent (no error on re-run)", async () => {
    await ensureViberevertDirs(tmpRoot);
    await expect(ensureViberevertDirs(tmpRoot)).resolves.toBeUndefined();
  });

  it("does not touch unrelated files in .viberevert", async () => {
    await ensureViberevertDirs(tmpRoot);
    const root = viberevertDir(tmpRoot);
    await writeFile(join(root, "user-file.txt"), "hello");
    await ensureViberevertDirs(tmpRoot);
    const stats = await stat(join(root, "user-file.txt"));
    expect(stats.isFile()).toBe(true);
  });
});

describe("RepoRootNotFoundError", () => {
  it("has a stable name property", () => {
    const err = new RepoRootNotFoundError("/some/path");
    expect(err.name).toBe("RepoRootNotFoundError");
  });

  it("is an instance of Error", () => {
    const err = new RepoRootNotFoundError("/some/path");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RepoRootNotFoundError);
  });
});
