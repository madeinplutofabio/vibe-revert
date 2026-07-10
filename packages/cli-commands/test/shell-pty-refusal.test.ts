// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M G4 Step 3d: the PUBLIC `viberevert shell --pty` path is a standalone
// REFUSAL (D104.M.5). It exits 1 with the not-enabled copy BEFORE any --task
// validation or repo/config/session resolution, and never reaches the PTY
// engine (shell-pty.ts is wired only in Step 4). These tests run in a BARE,
// non-repo temp dir so that a misplaced refusal (falling through to repo
// resolution) would surface the "No git repository" copy and fail here.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { Builtins, Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShellCommand } from "../src/commands/shell.js";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  // A BARE dir: no .git, no .viberevert.yml. resolveRepoRoot would fail here,
  // so a refusal that (wrongly) fell through to repo/config/session work would
  // print the repo-root / config / session copy -- which these tests forbid.
  tmpRoot = await mkdtemp(join(tmpdir(), "vr-shell-pty-refusal-"));
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Run `viberevert shell --pty [...args]` through a real clipanion Cli with
 * captured stdout/stderr and an already-ended stdin (the refusal returns before
 * any read). Mirrors the shell-command.test.ts harness.
 */
async function runShellPty(
  args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(Builtins.HelpCommand);
  cli.register(ShellCommand);

  const stdinStub = new PassThrough();
  stdinStub.end();

  const stdoutStub = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      callback();
    },
  });
  const stderrStub = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      callback();
    },
  });

  const exitCode = await cli.run(["shell", "--pty", ...args], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

describe("viberevert shell --pty -- public refusal (M G4 Step 3d, D104.M.5)", () => {
  it("refuses with the not-enabled copy, before any repo/config/session resolution", async () => {
    const { exitCode, stdout, stderr } = await runShellPty();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("PTY mode (--pty) is not enabled yet");
    expect(stderr).toContain("Use `viberevert shell` for the guarded command loop.");
    // Never fell through to repo / config / session resolution.
    expect(stderr).not.toContain("No git repository");
    expect(stderr).not.toContain("No .viberevert.yml");
    expect(stderr).not.toContain("A session is already active");
    // The refusal is stderr-only.
    expect(stdout).toBe("");
  });

  it("the PTY refusal wins over --task validation", async () => {
    const { exitCode, stdout, stderr } = await runShellPty(["--task", "   "]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("PTY mode (--pty) is not enabled yet");
    expect(stderr).not.toContain("--task must not be empty or whitespace-only");
    expect(stdout).toBe("");
  });
});
