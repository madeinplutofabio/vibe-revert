// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M G4 Step 4f: the PUBLIC `viberevert shell --pty` path now DISPATCHES to the
// carved PTY engine (the temporary Step-3d "not enabled yet" refusal is gone).
// In this non-TTY harness (PassThrough stdin, Writable stdout/stderr), the
// engine's own gate refuses with the not-a-TTY copy BEFORE loading node-pty,
// resolving a shell, or opening a session -- proving the public command reaches
// the real engine and fails CLEARLY (never silently degrades to the REPL). The
// tests run in a BARE, non-repo temp dir so a wrong fall-through to
// repo/config/session work would surface the "No git repository" copy and fail
// here. --task validation now runs BEFORE engine selection, so a whitespace
// --task is rejected before the engine is reached.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { Builtins, Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShellCommand } from "../src/commands/shell.js";

let tmpRoot = "";
let originalCwd = "";

beforeEach(async () => {
  originalCwd = process.cwd();
  // A BARE dir: no .git, no .viberevert.yml. If the engine's gate wrongly fell
  // through to repo/config/session work, the repo-root/config/session copy would
  // appear -- which these tests forbid.
  tmpRoot = await mkdtemp(join(tmpdir(), "vr-shell-pty-refusal-"));
  process.chdir(tmpRoot);
});

afterEach(async () => {
  if (originalCwd) {
    process.chdir(originalCwd);
  }
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

/**
 * Run `viberevert shell --pty [...args]` through a real clipanion Cli with
 * captured stdout/stderr and an already-ended, non-TTY stdin. The engine's gate
 * refuses on the non-TTY before any read. Mirrors the shell-command.test.ts harness.
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

describe("viberevert shell --pty -- public dispatch + non-TTY refusal (M G4 Step 4f)", () => {
  it("dispatches to the engine, which refuses with the not-a-TTY copy before any repo/config/session work", async () => {
    const { exitCode, stdout, stderr } = await runShellPty();

    expect(exitCode).toBe(1);
    // The engine's gate refuses on the non-TTY (proves the public path reached
    // the real engine -- not the removed placeholder refusal, and not the REPL).
    expect(stderr).toContain("requires an interactive terminal (a real TTY)");
    // The removed Step-3d placeholder copy must NOT appear on EITHER stream.
    expect(stderr).not.toContain("PTY mode (--pty) is not enabled yet");
    expect(stdout).not.toContain("PTY mode (--pty) is not enabled yet");
    // No silent fallback to the REPL: its prompt never appears.
    expect(stdout).not.toContain("viberevert> ");
    // Never fell through to repo / config / session resolution (the gate is first).
    expect(stderr).not.toContain("No git repository");
    expect(stderr).not.toContain("No .viberevert.yml");
    expect(stderr).not.toContain("A session is already active");
    // The refusal is stderr-only.
    expect(stdout).toBe("");
  });

  it("validates --task BEFORE engine selection: a whitespace --task is rejected, not dispatched", async () => {
    const { exitCode, stdout, stderr } = await runShellPty(["--task", "   "]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--task must not be empty or whitespace-only");
    // The engine gate was never reached, and the REPL never started.
    expect(stderr).not.toContain("requires an interactive terminal (a real TTY)");
    expect(stdout).not.toContain("requires an interactive terminal");
    expect(stdout).not.toContain("viberevert> ");
    expect(stdout).toBe("");
  });
});
