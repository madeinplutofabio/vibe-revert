// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// H11.1 RED regression fixture — `viberevert run <agent>` cannot launch a
// PATH-resolved `.cmd` shim on Windows (finding `run-agent-windows-shim`; see
// docs/security/regressions.md and docs/adr/0005-windows-command-resolution-and-launch.md).
//
// Windows-only: this reproduces a Windows shim-launch defect. It is skipped on
// other platforms by design, not as a portability omission.
//
// Mechanism:
//   - A normal GREEN test proves the fixture `.cmd` shim is itself valid and
//     resolvable through PATH + PATHEXT: launched by extensionless name through
//     the absolute cmd.exe from the repo cwd, it writes its marker, receives its
//     argument, and exits 42.
//   - An `it.fails()` test drives the REAL RunCommand against the same shim,
//     resolved through PATH, and asserts ONLY the desired post-fix contract. It
//     fails today (bare `spawn(shell:false)` cannot launch a `.cmd`), which
//     keeps CI green; when H11.2 wires in resolve-then-launch it will pass
//     unexpectedly, turning the suite red and forcing removal of `.fails`.

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { Cli } from "clipanion";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RunCommand } from "../src/commands/run.js";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === "win32";
const suite = IS_WINDOWS ? describe.sequential : describe.skip;

interface Marker {
  argv: string[];
}

/** Absolute cmd.exe from ComSpec; asserts the expected identity. */
function requireComSpec(): string {
  const value = process.env["ComSpec"] ?? process.env["COMSPEC"];
  if (value === undefined || value.length === 0)
    throw new Error("run RED fixture requires ComSpec");
  expect(win32.isAbsolute(value)).toBe(true);
  expect(win32.basename(value).toLowerCase()).toBe("cmd.exe");
  return value;
}

/** %-escape an absolute path for safe literal use inside a .cmd body. */
function batchLiteral(value: string): string {
  if (value.includes('"') || value.includes("\r") || value.includes("\n") || value.includes("\0"))
    throw new Error("node path cannot be represented in this batch fixture");
  return value.replaceAll("%", "%%");
}

/** A discarding stream sink for the command's captured output. */
function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

suite(
  "run — PATH-resolved .cmd agent (win32-only: reproduces run-agent-windows-shim; RED until H11.2)",
  () => {
    let comSpec: string;
    let tmpRoot: string | undefined;
    let repoRoot: string;
    let binDir: string;
    let markerPath: string;
    let originalCwd: string;
    let originalPath: string | undefined;
    let originalPathExt: string | undefined;

    beforeAll(() => {
      comSpec = requireComSpec();
    });

    beforeEach(async () => {
      // 1. Capture restorable process state BEFORE any fallible setup.
      originalCwd = process.cwd();
      originalPath = process.env["PATH"];
      originalPathExt = process.env["PATHEXT"];
      tmpRoot = undefined;

      // 2. Fallible filesystem setup.
      tmpRoot = await mkdtemp(join(tmpdir(), "vr-run-shim-red-"));
      repoRoot = join(tmpRoot, "repo");
      binDir = join(tmpRoot, "bin");
      markerPath = join(binDir, "marker.json");
      await mkdir(repoRoot, { recursive: true });
      await mkdir(binDir, { recursive: true });

      // Real git repo + minimal config (run REQUIRES both; same shape as
      // run-command.test.ts).
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
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
        { cwd: repoRoot },
      );
      await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
      await writeFile(join(repoRoot, ".viberevert.yml"), "version: 1\n");

      // Fixture shim OUTSIDE the repo (no git noise): agent.cmd forwards to a
      // Node runner that records its argv and exits 42.
      await writeFile(
        join(binDir, "agent-runner.cjs"),
        [
          "const fs=require('fs');const path=require('path');",
          "fs.writeFileSync(path.join(__dirname,'marker.json'),JSON.stringify({argv:process.argv.slice(2)}));",
          "process.exit(42);",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(binDir, "agent.cmd"),
        `@echo off\r\n"${batchLiteral(process.execPath)}" "%~dp0agent-runner.cjs" %*\r\n`,
      );

      // 3. Mutate process state LAST (so a failure above leaves it unmutated).
      process.chdir(repoRoot);
      process.env["PATH"] =
        originalPath === undefined ? binDir : `${binDir}${delimiter}${originalPath}`;
      process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
    });

    afterEach(async () => {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
      if (originalPathExt === undefined) delete process.env["PATHEXT"];
      else process.env["PATHEXT"] = originalPathExt;
      if (process.cwd() !== originalCwd) process.chdir(originalCwd);
      if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });
    });

    /** Drive the real RunCommand via a clipanion Cli (mirrors run-command.test.ts). */
    async function runRun(args: string[]): Promise<{ exitCode: number }> {
      const cli = new Cli({ binaryName: "viberevert" });
      cli.register(RunCommand);
      const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
      stdin.isTTY = false;
      stdin.end();
      const exitCode = await cli.run(["run", ...args], {
        stdin,
        stdout: sink(),
        stderr: sink(),
      });
      return { exitCode };
    }

    it("baseline: agent.cmd resolves and launches through PATH + PATHEXT via cmd.exe", () => {
      const token = `probe-${randomUUID()}`;
      const commandLine = `agent --probe-token=${token}`;
      const res = spawnSync(comSpec, ["/d", "/v:off", "/s", "/c", commandLine], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(42);
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Marker;
      expect(marker.argv).toEqual([`--probe-token=${token}`]);
    });

    // RED H11.2 tripwire: remove `.fails` when the production launcher uses the
    // approved resolve-then-launch path. An unexpected pass is intentional.
    it.fails("launches a PATH-resolved .cmd agent and propagates its exit status", async () => {
      const token = `probe-${randomUUID()}`;
      const { exitCode } = await runRun(["agent", `--probe-token=${token}`]);
      // Desired post-fix contract ONLY (currently unmet on Windows):
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as Marker;
      expect(marker.argv).toEqual([`--probe-token=${token}`]);
      expect(exitCode).toBe(42);
    });
  },
);
