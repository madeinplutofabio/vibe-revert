// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InitCommand } from "../src/commands/init.js";

// Resolve the workspace fixtures directory from this test file's location.
// Test file lives at: packages/cli/test/init.test.ts
// Fixtures live at:   tests/fixtures/<name>-init-target/
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(TEST_DIR, "..", "..", "..", "tests", "fixtures");

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-init-test-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  // Restore CWD before cleanup so the rm doesn't fail on Windows.
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Copies the named fixture from `tests/fixtures/<name>/` into a fresh
 * subdirectory of tmpRoot under the SAME basename, then chdir into it.
 *
 * Preserving the basename matters: init derives projectName from the
 * basename of the working directory, and the golden YAML hardcodes that
 * basename.
 *
 * Returns the absolute path of the temp working directory.
 */
async function setupFixture(name: string): Promise<string> {
  const src = join(FIXTURES_DIR, name);
  const dest = join(tmpRoot, name);
  await cp(src, dest, { recursive: true });
  process.chdir(dest);
  return dest;
}

/**
 * Runs `viberevert init` with the given args via a clipanion Cli instance.
 * Returns the exit code and captured stdout/stderr.
 *
 * Uses real node:stream instances (PassThrough + Writable) so the test
 * harness satisfies clipanion's BaseContext naturally without structural
 * `as unknown as` casts. The PassThrough stdin has isTTY=false set on it,
 * guaranteeing the non-interactive path even when tests run from a real
 * TTY locally.
 */
async function runInit(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(InitCommand);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = false;

  const stdoutStub = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      callback();
    },
  });

  const stderrStub = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      callback();
    },
  });

  const exitCode = await cli.run(["init", ...args], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

/** Normalizes CRLF -> LF so byte-comparison works regardless of checkout setting. */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Reads a file and normalizes its line endings. */
async function readNormalized(path: string): Promise<string> {
  return normalizeLineEndings(await readFile(path, "utf8"));
}

describe("init — golden output per fixture", () => {
  it.each([
    ["laravel-init-target"],
    ["nextjs-init-target"],
    ["generic-init-target"],
  ])(
    "%s produces the expected .viberevert.yml and scaffolds .viberevert/",
    async (fixture) => {
      const workDir = await setupFixture(fixture);

      const result = await runInit([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Wrote");
      expect(result.stdout).toContain("Done.");

      // Golden YAML matches.
      const actual = await readNormalized(join(workDir, ".viberevert.yml"));
      const expected = await readNormalized(
        join(workDir, "expected", ".viberevert.yml"),
      );
      expect(actual).toBe(expected);

      // .viberevert/ subdirs were actually created.
      for (const sub of ["sessions", "checkpoints", "reports"]) {
        const s = await stat(join(workDir, ".viberevert", sub));
        expect(s.isDirectory()).toBe(true);
      }
    },
  );
});

describe("init — overwrite guard", () => {
  it("refuses to overwrite an existing .viberevert.yml without --force", async () => {
    await setupFixture("generic-init-target");
    const first = await runInit([]);
    expect(first.exitCode).toBe(0);

    const second = await runInit([]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("Refusing to overwrite");
    expect(second.stderr).toContain("--force");
  });

  it("overwrites with --force", async () => {
    await setupFixture("generic-init-target");
    await runInit([]);
    const second = await runInit(["--force"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Wrote");
  });
});

describe("init — --profile flag", () => {
  it("--profile overrides detection", async () => {
    const workDir = await setupFixture("generic-init-target");
    const result = await runInit(["--profile", "laravel"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Using profile: laravel");

    const actual = await readNormalized(join(workDir, ".viberevert.yml"));
    expect(actual).toContain("profile: laravel");
    expect(actual).toContain("frameworks:\n  - laravel");
  });

  it("rejects an empty --profile value", async () => {
    await setupFixture("generic-init-target");
    const result = await runInit(["--profile", "   "]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--profile must not be empty");
  });

  it("accepts a custom non-built-in profile name (generic-shaped output)", async () => {
    const workDir = await setupFixture("generic-init-target");
    const result = await runInit(["--profile", "my-custom-profile"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Using profile: my-custom-profile");

    const actual = await readNormalized(join(workDir, ".viberevert.yml"));
    expect(actual).toContain('profile: "my-custom-profile"');
  });
});

describe("init — refuses to overwrite a directory at .viberevert.yml", () => {
  it("returns exit 1 with a clear message even with --force", async () => {
    const workDir = await setupFixture("generic-init-target");
    // Create a DIRECTORY where the config file would go.
    await mkdir(join(workDir, ".viberevert.yml"));

    const result = await runInit(["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a regular file");
  });
});

describe("init — non-interactive ambiguous detection", () => {
  it("errors and demands --profile when stdin is not a TTY", async () => {
    // Build an ambiguous fixture inline: laravel + nextjs signatures both present.
    const workDir = join(tmpRoot, "ambiguous-target");
    await mkdir(workDir);
    await writeFile(join(workDir, "composer.json"), "{}");
    await writeFile(join(workDir, "artisan"), "");
    await writeFile(join(workDir, "next.config.js"), "");
    process.chdir(workDir);

    const result = await runInit([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Multiple framework signatures detected");
    expect(result.stderr).toContain("laravel, nextjs");
    expect(result.stderr).toContain("--profile");
  });
});
