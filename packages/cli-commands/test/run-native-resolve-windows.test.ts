// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// H11.2 GREEN regression — `viberevert run <name>` resolves an extensionless
// PATH name to its native `.exe` and direct-spawns the exact resolved path,
// forwarding arguments and propagating the child's exit status. Pins the `run`
// improvement (resolve-then-launch for native targets) delivered in H11.2.
//
// Windows-only: this specifically exercises Windows PATH/PATHEXT resolution and
// `.exe` classification; skipped elsewhere by design (resolve-then-direct-spawn
// is platform-independent, but the resolution semantics under test are Windows).
//
// The fixture `.exe` is a hard link (copy fallback) of the running Node binary,
// so it is a real, deterministic Node that records how it was launched and its
// forwarded arguments, without depending on any system utility.

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunCommand } from "../src/commands/run.js";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === "win32";
const suite = IS_WINDOWS ? describe.sequential : describe.skip;

interface Marker {
  execPath: string;
  argv: string[];
}

/** A discarding stream sink for the command's captured output. */
function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

suite("run — PATH-resolved native .exe (win32-only: pins H11.2 resolve-then-direct-spawn)", () => {
  let tmpRoot: string | undefined;
  let repoRoot: string;
  let binDir: string;
  let fixtureExe: string;
  let markerPath: string;
  let originalCwd: string;
  let originalPath: string | undefined;
  let originalPathExt: string | undefined;

  beforeEach(async () => {
    // 1. Capture restorable process state BEFORE any fallible setup.
    originalCwd = process.cwd();
    originalPath = process.env["PATH"];
    originalPathExt = process.env["PATHEXT"];
    tmpRoot = undefined;

    // 2. Fallible filesystem setup.
    tmpRoot = await mkdtemp(join(tmpdir(), "vr-run-native-"));
    repoRoot = join(tmpRoot, "repo");
    binDir = join(tmpRoot, "bin");
    fixtureExe = join(binDir, "vr-native-agent.exe");
    markerPath = join(binDir, "marker.json");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });

    // Real git repo + minimal config (run REQUIRES both).
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

    // Native fixture: a hard link (copy fallback) of the running Node binary,
    // named with `.exe`, plus a runner that records how it was launched.
    try {
      await link(process.execPath, fixtureExe);
    } catch {
      await copyFile(process.execPath, fixtureExe);
    }
    await writeFile(
      join(binDir, "runner.cjs"),
      [
        "const fs=require('fs');const path=require('path');",
        "fs.writeFileSync(path.join(__dirname,'marker.json'),JSON.stringify({execPath:process.execPath,argv:process.argv.slice(2)}));",
        "process.exit(42);",
        "",
      ].join("\n"),
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

  /** Drive the real RunCommand via a clipanion Cli. */
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

  it("baseline: the fixture .exe is a valid Node launched by absolute path", () => {
    const token = `probe-${randomUUID()}`;
    const spacedArg = "argument with spaces";
    const runnerPath = join(binDir, "runner.cjs");
    const res = spawnSync(fixtureExe, [runnerPath, `--probe-token=${token}`, spacedArg], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(42);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Marker;
    expect(marker.execPath.toLowerCase()).toBe(fixtureExe.toLowerCase());
    expect(marker.argv).toEqual([`--probe-token=${token}`, spacedArg]);
  });

  it("resolves an extensionless PATH name to its .exe, direct-spawns it, forwards args, propagates exit", async () => {
    const token = `probe-${randomUUID()}`;
    const spacedArg = "argument with spaces";
    const runnerPath = join(binDir, "runner.cjs");
    const { exitCode } = await runRun([
      "vr-native-agent",
      runnerPath,
      `--probe-token=${token}`,
      spacedArg,
    ]);
    // Child exit status propagates verbatim.
    expect(exitCode).toBe(42);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Marker;
    // The EXACT resolved fixture .exe was executed (the extensionless name
    // resolved through PATH/PATHEXT to binDir\vr-native-agent.exe — not a system
    // Node). Case-insensitive: the resolver reconstructs the PATHEXT extension
    // casing, which is not part of the contract.
    expect(marker.execPath.toLowerCase()).toBe(fixtureExe.toLowerCase());
    // Ordered multi-argument fidelity, including spaces (native direct spawn, no
    // shell quoting or mediation).
    expect(marker.argv).toEqual([`--probe-token=${token}`, spacedArg]);
  });
});
