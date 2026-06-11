// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  detectHookManagers,
  HookManagerIoError,
  MalformedPackageJsonError,
} from "../src/hook-managers.js";

// Mock node:fs/promises with delegating defaults so tests can override
// specific calls (lstat, readFile) with error-injection mocks while keeping
// real fs behavior for setup helpers and other tests.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readFile: vi.fn(actual.readFile),
  };
});

async function makeTempRepoRoot(): Promise<string> {
  const repoRoot = path.join(
    os.tmpdir(),
    `viberevert-hook-managers-test-${crypto.randomBytes(8).toString("hex")}`,
  );
  await fsPromises.mkdir(repoRoot, { recursive: true });
  return repoRoot;
}

async function writeFile(repoRoot: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(repoRoot, relPath);
  await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
  await fsPromises.writeFile(fullPath, content);
}

async function mkdir(repoRoot: string, relPath: string): Promise<void> {
  await fsPromises.mkdir(path.join(repoRoot, relPath), { recursive: true });
}

describe("detectHookManagers (M F D98.W)", () => {
  let tempDirs: string[] = [];

  beforeEach(async () => {
    // Reset-and-redelegate mocks so each test starts with real-fs defaults.
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.lstat).mockReset().mockImplementation(actual.lstat);
    vi.mocked(fsPromises.readFile).mockReset().mockImplementation(actual.readFile);
    tempDirs = [];
  });

  afterEach(async () => {
    // Restore + clean up via REAL rm (bypasses any test-local mock state).
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.lstat).mockReset().mockImplementation(actual.lstat);
    vi.mocked(fsPromises.readFile).mockReset().mockImplementation(actual.readFile);
    for (const dir of tempDirs) {
      await actual.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });

  async function newTempRepo(): Promise<string> {
    const dir = await makeTempRepoRoot();
    tempDirs.push(dir);
    return dir;
  }

  describe("neither detected", () => {
    it("clean repo (no .husky/, no package.json) returns both detected:false", async () => {
      const repoRoot = await newTempRepo();
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({ detected: false });
      expect(result.lefthook).toEqual({ detected: false });
    });

    it("package.json with neither husky nor lefthook returns both detected:false", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "package.json", JSON.stringify({ name: "test" }));
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({ detected: false });
      expect(result.lefthook).toEqual({ detected: false });
    });

    it(".husky exists as a regular file (not directory) -> husky NOT detected via fs signal", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, ".husky", "not a directory");
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({ detected: false });
    });
  });

  describe("husky detection -- fs signal (.husky/)", () => {
    it(".husky/ directory -> signal = '.husky/ directory'", async () => {
      const repoRoot = await newTempRepo();
      await mkdir(repoRoot, ".husky");
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: ".husky/ directory",
      });
    });
  });

  describe("husky detection -- package.json signals (4-signal precedence)", () => {
    it("top-level `husky` key -> signal = 'package.json `husky` key'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({ name: "test", husky: { hooks: {} } }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: "package.json `husky` key",
      });
    });

    it("`husky` in devDependencies -> signal = 'package.json `husky` in devDependencies'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { husky: "^8.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: "package.json `husky` in devDependencies",
      });
    });

    it("`husky` in dependencies -> signal = 'package.json `husky` in dependencies'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { husky: "^8.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: "package.json `husky` in dependencies",
      });
    });

    it("precedence: .husky/ directory wins over package.json signals", async () => {
      const repoRoot = await newTempRepo();
      await mkdir(repoRoot, ".husky");
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          husky: { hooks: {} },
          devDependencies: { husky: "^8.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: ".husky/ directory",
      });
    });

    it("precedence: top-level `husky` key wins over devDependencies", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          husky: { hooks: {} },
          devDependencies: { husky: "^8.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: "package.json `husky` key",
      });
    });

    it("precedence: devDependencies wins over dependencies", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { husky: "^8.0.0" },
          dependencies: { husky: "^8.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: "package.json `husky` in devDependencies",
      });
    });
  });

  describe("lefthook detection -- fs signals (5 paths, first-match wins)", () => {
    it("lefthook.yml -> signal = 'lefthook.yml'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "lefthook.yml", "pre-commit:");
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "lefthook.yml",
      });
    });

    it("lefthook.yaml -> signal = 'lefthook.yaml'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "lefthook.yaml", "pre-commit:");
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "lefthook.yaml",
      });
    });

    it(".lefthook.yml -> signal = '.lefthook.yml'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, ".lefthook.yml", "pre-commit:");
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: ".lefthook.yml",
      });
    });

    it(".lefthook.yaml -> signal = '.lefthook.yaml'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, ".lefthook.yaml", "pre-commit:");
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: ".lefthook.yaml",
      });
    });

    it("lefthook-local.yml -> signal = 'lefthook-local.yml'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "lefthook-local.yml", "pre-commit:");
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "lefthook-local.yml",
      });
    });

    it("precedence: lefthook.yml wins over lefthook.yaml when both exist", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "lefthook.yml", "pre-commit:");
      await writeFile(repoRoot, "lefthook.yaml", "pre-commit:");
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "lefthook.yml",
      });
    });

    it("precedence: lefthook.yaml wins over .lefthook.yml", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "lefthook.yaml", "pre-commit:");
      await writeFile(repoRoot, ".lefthook.yml", "pre-commit:");
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "lefthook.yaml",
      });
    });
  });

  describe("lefthook detection -- existence-based (architectural lock #11)", () => {
    it("lefthook.yml as a DIRECTORY still triggers detection (existence wins)", async () => {
      const repoRoot = await newTempRepo();
      await mkdir(repoRoot, "lefthook.yml");
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "lefthook.yml",
      });
    });

    // Symlink case is Unix-only -- skip on Windows where symlink() requires elevation.
    it.skipIf(process.platform === "win32")(
      "lefthook.yml as a SYMLINK still triggers detection (existence wins)",
      async () => {
        const repoRoot = await newTempRepo();
        const targetPath = path.join(repoRoot, "elsewhere.yml");
        await fsPromises.writeFile(targetPath, "pre-commit:");
        await fsPromises.symlink(targetPath, path.join(repoRoot, "lefthook.yml"));
        const result = await detectHookManagers(repoRoot);
        expect(result.lefthook).toEqual({
          detected: true,
          signal: "lefthook.yml",
        });
      },
    );
  });

  describe("lefthook detection -- package.json signals (2-signal precedence)", () => {
    it("`lefthook` in devDependencies -> signal = 'package.json `lefthook` in devDependencies'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { lefthook: "^1.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "package.json `lefthook` in devDependencies",
      });
    });

    it("`lefthook` in dependencies -> signal = 'package.json `lefthook` in dependencies'", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { lefthook: "^1.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "package.json `lefthook` in dependencies",
      });
    });

    it("precedence: lefthook fs signal wins over package.json deps", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "lefthook.yml", "pre-commit:");
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { lefthook: "^1.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "lefthook.yml",
      });
    });

    it("precedence: lefthook devDependencies wins over dependencies", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { lefthook: "^1.0.0" },
          dependencies: { lefthook: "^1.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "package.json `lefthook` in devDependencies",
      });
    });
  });

  describe("both detected", () => {
    it(".husky/ + lefthook.yml -> both signals returned", async () => {
      const repoRoot = await newTempRepo();
      await mkdir(repoRoot, ".husky");
      await writeFile(repoRoot, "lefthook.yml", "pre-commit:");
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: ".husky/ directory",
      });
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "lefthook.yml",
      });
    });

    it("husky + lefthook both via package.json -> both signals", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { husky: "^8.0.0", lefthook: "^1.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: "package.json `husky` in devDependencies",
      });
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "package.json `lefthook` in devDependencies",
      });
    });

    it("husky via .husky/ + lefthook via package.json devDeps (mixed fs+pkg) -> both signals", async () => {
      const repoRoot = await newTempRepo();
      await mkdir(repoRoot, ".husky");
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { lefthook: "^1.0.0" },
        }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({
        detected: true,
        signal: ".husky/ directory",
      });
      expect(result.lefthook).toEqual({
        detected: true,
        signal: "package.json `lefthook` in devDependencies",
      });
    });
  });

  describe("malformed package.json", () => {
    it("throws MalformedPackageJsonError when JSON is invalid", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "package.json", "{ this is not valid JSON");
      await expect(detectHookManagers(repoRoot)).rejects.toThrow(MalformedPackageJsonError);
    });

    it("MalformedPackageJsonError carries path + parseMessage", async () => {
      const repoRoot = await newTempRepo();
      const pkgPath = path.join(repoRoot, "package.json");
      await fsPromises.writeFile(pkgPath, "{ this is not valid JSON");
      try {
        await detectHookManagers(repoRoot);
        expect.fail("Expected MalformedPackageJsonError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MalformedPackageJsonError);
        const mpje = err as MalformedPackageJsonError;
        expect(mpje.path).toBe(pkgPath);
        expect(typeof mpje.parseMessage).toBe("string");
        expect(mpje.parseMessage.length).toBeGreaterThan(0);
      }
    });

    it("does NOT throw when malformed JSON + BOTH managers detected via fs (early-return path)", async () => {
      const repoRoot = await newTempRepo();
      await mkdir(repoRoot, ".husky");
      await writeFile(repoRoot, "lefthook.yml", "pre-commit:");
      await writeFile(repoRoot, "package.json", "INVALID JSON");
      // Should NOT throw -- early return at step 3 skips package.json parse.
      const result = await detectHookManagers(repoRoot);
      expect(result.husky.detected).toBe(true);
      expect(result.lefthook.detected).toBe(true);
    });
  });

  describe("non-object package.json shapes (fall through to no-signals)", () => {
    it("package.json containing a top-level array returns no detection", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "package.json", JSON.stringify([]));
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({ detected: false });
      expect(result.lefthook).toEqual({ detected: false });
    });

    it("package.json containing null returns no detection", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "package.json", "null");
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({ detected: false });
      expect(result.lefthook).toEqual({ detected: false });
    });

    it("package.json containing a number returns no detection", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(repoRoot, "package.json", "42");
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({ detected: false });
      expect(result.lefthook).toEqual({ detected: false });
    });

    it("package.json with devDependencies as a string returns no detection", async () => {
      const repoRoot = await newTempRepo();
      await writeFile(
        repoRoot,
        "package.json",
        JSON.stringify({ devDependencies: "not-an-object" }),
      );
      const result = await detectHookManagers(repoRoot);
      expect(result.husky).toEqual({ detected: false });
      expect(result.lefthook).toEqual({ detected: false });
    });
  });

  describe("I/O failure injection (D98.W HookManagerIoError)", () => {
    it("non-ENOENT lstat failure on .husky throws HookManagerIoError(op='stat')", async () => {
      const repoRoot = await newTempRepo();
      const eaccesErr = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const huskyPath = path.join(repoRoot, ".husky");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fsPromises.lstat).mockImplementation(async (p) => {
        if (p === huskyPath) {
          throw eaccesErr;
        }
        return actual.lstat(p);
      });

      try {
        await detectHookManagers(repoRoot);
        expect.fail("Expected HookManagerIoError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HookManagerIoError);
        const hmie = err as HookManagerIoError;
        expect(hmie.op).toBe("stat");
        expect(hmie.path).toBe(huskyPath);
        expect(hmie.underlyingMessage).toContain("EACCES");
      }
    });

    it("non-ENOENT readFile failure on package.json throws HookManagerIoError(op='read')", async () => {
      const repoRoot = await newTempRepo();
      const eaccesErr = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const pkgPath = path.join(repoRoot, "package.json");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fsPromises.readFile).mockImplementation(async (p, opts) => {
        if (p === pkgPath) {
          throw eaccesErr;
        }
        return actual.readFile(p, opts);
      });

      try {
        await detectHookManagers(repoRoot);
        expect.fail("Expected HookManagerIoError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HookManagerIoError);
        const hmie = err as HookManagerIoError;
        expect(hmie.op).toBe("read");
        expect(hmie.path).toBe(pkgPath);
        expect(hmie.underlyingMessage).toContain("EACCES");
      }
    });
  });

  describe("HookManagerIoError class shape", () => {
    it("has name 'HookManagerIoError' and exposes op/path/underlyingMessage", () => {
      const err = new HookManagerIoError("stat", "/some/path", "underlying");
      expect(err.name).toBe("HookManagerIoError");
      expect(err.op).toBe("stat");
      expect(err.path).toBe("/some/path");
      expect(err.underlyingMessage).toBe("underlying");
      expect(err.message).toBe("Failed to stat at /some/path: underlying.");
    });
  });

  describe("MalformedPackageJsonError class shape", () => {
    it("has name 'MalformedPackageJsonError' and exposes path/parseMessage", () => {
      const err = new MalformedPackageJsonError("/repo/package.json", "Unexpected token");
      expect(err.name).toBe("MalformedPackageJsonError");
      expect(err.path).toBe("/repo/package.json");
      expect(err.parseMessage).toBe("Unexpected token");
      expect(err.message).toBe(
        "Failed to parse package.json while checking for hook managers at /repo/package.json: Unexpected token.",
      );
    });
  });
});
