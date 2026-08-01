// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// H11.1 RED regression fixture — `viberevert doctor` reports `pnpm: not found`
// on Windows when pnpm is present only as a `.cmd` shim (finding `doctor-pnpm`;
// see docs/security/regressions.md and
// docs/adr/0005-windows-command-resolution-and-launch.md).
//
// Windows-only: this reproduces a Windows shim-probe defect. It is skipped on
// other platforms by design, not as a portability omission.
//
// Mechanism:
//   - A normal GREEN test proves the fixture `pnpm.cmd` shim is itself valid and
//     resolvable through PATH + PATHEXT: launched by extensionless name through
//     the absolute cmd.exe from a neutral cwd, it prints its sentinel version
//     (only when `--version` reaches it) and exits 0.
//   - An `it.fails()` test drives the REAL DoctorCommand against the same shim,
//     resolved through PATH, and asserts ONLY the desired post-fix contract. It
//     fails today (`spawnSync("pnpm", …, { shell:false })` cannot launch a
//     `.cmd`, so the line reads `not found`), which keeps CI green; when H11.2
//     wires in resolve-then-launch it will pass unexpectedly, turning the suite
//     red and forcing removal of `.fails`.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { Cli } from "clipanion";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DoctorCommand } from "../src/commands/doctor.js";

const IS_WINDOWS = process.platform === "win32";
const suite = IS_WINDOWS ? describe.sequential : describe.skip;

/** Absolute cmd.exe from ComSpec; asserts the expected identity. */
function requireComSpec(): string {
  const value = process.env["ComSpec"] ?? process.env["COMSPEC"];
  if (value === undefined || value.length === 0)
    throw new Error("doctor RED fixture requires ComSpec");
  expect(win32.isAbsolute(value)).toBe(true);
  expect(win32.basename(value).toLowerCase()).toBe("cmd.exe");
  return value;
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
  "doctor — PATH-resolved pnpm.cmd shim (win32-only: reproduces doctor-pnpm; RED until H11.2)",
  () => {
    let comSpec: string;
    let tmpRoot: string | undefined;
    let binDir: string;
    let workDir: string;
    let sentinel: string;
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
      tmpRoot = await mkdtemp(join(tmpdir(), "vr-doctor-pnpm-red-"));
      binDir = join(tmpRoot, "bin");
      workDir = join(tmpRoot, "work");
      await mkdir(binDir, { recursive: true });
      await mkdir(workDir, { recursive: true });

      // Fixture shim: pnpm.cmd prints a per-run sentinel version to stdout, but
      // ONLY when `--version` reaches it (proving the argument contract).
      sentinel = `vr-pnpm-${randomUUID()}`;
      await writeFile(
        join(binDir, "pnpm.cmd"),
        [
          "@echo off",
          'if not "%~1"=="--version" exit /b 43',
          `echo ${sentinel}`,
          "exit /b 0",
          "",
        ].join("\r\n"),
      );

      // 3. Mutate process state LAST (so a failure above leaves it unmutated).
      // Run doctor from a neutral cwd so the probe must resolve pnpm through
      // PATH + PATHEXT, not the current directory.
      process.chdir(workDir);
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

    /** Drive the real DoctorCommand via a clipanion Cli, capturing stdout. */
    async function runDoctor(): Promise<{ exitCode: number; stdout: string }> {
      const cli = new Cli({ binaryName: "viberevert" });
      cli.register(DoctorCommand);
      const chunks: string[] = [];
      const stdout = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
          callback();
        },
      });
      const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
      stdin.isTTY = false;
      stdin.end();
      const exitCode = await cli.run(["doctor"], { stdin, stdout, stderr: sink() });
      return { exitCode, stdout: chunks.join("") };
    }

    it("baseline: pnpm.cmd resolves and reports its version through PATH + PATHEXT via cmd.exe", () => {
      const res = spawnSync(comSpec, ["/d", "/v:off", "/s", "/c", "pnpm --version"], {
        cwd: workDir,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(sentinel);
    });

    // RED H11.2 tripwire: remove `.fails` when the production probe uses the
    // approved resolve-then-launch path. An unexpected pass is intentional.
    it.fails("reports the version from a PATH-resolved pnpm.cmd shim", async () => {
      const { exitCode, stdout } = await runDoctor();
      const pnpmLine = stdout.split(/\r?\n/).find((line) => line.startsWith("pnpm:")) ?? "";
      // Desired post-fix contract ONLY (currently unmet on Windows):
      expect(exitCode).toBe(0);
      expect(pnpmLine).toContain(sentinel);
      expect(pnpmLine).not.toContain("not found");
    });
  },
);
