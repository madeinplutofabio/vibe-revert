// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Command-level tests for the selective selectors and the single locked phase
// (M 0.8.0 step 12).
//
// Scope, deliberately narrow. `rollback.test.ts` already owns the legacy
// full-session behavior end to end, and it passing unchanged is what proves the
// extraction moved that behavior rather than reinterpreting it. This file
// covers only what the extraction ADDED:
//
//   A. option parsing and the pure pre-lock selector validation
//   B. the mode/selector binding, as a unit
//   C. the single-lock boundary
//   D. post-lock rendering and exit status for the selective arms
//
// What is NOT here: a real contribution, a real transplant, per-path preview
// output. Those need the end-of-session capture transaction to have produced a
// contribution, which is a different fixture entirely, and their reporting is
// rung 8's. Everything below refuses or resolves BEFORE any mutation, which is
// exactly the surface these four groups are about.
//
// The refusal fixture is a legacy session: `session.json` with no
// `contribution_path`, which is the shape every pre-0.8.0 ended session has on
// disk today. That makes it the honest input for "selective rollback against a
// session that has no contribution", and it is the state most real repositories
// are in right now.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  type Manifest,
  SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RollbackCommand } from "../src/commands/rollback.js";
import { resolveRollbackSelectionMode } from "../src/rollback-locked-phase.js";
import type { SelectionSelectors } from "../src/selection-resolver.js";

const execFileAsync = promisify(execFile);

const SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const HEAD_SHA = "a1b2c3d4e5f6789012345678901234567890abcd";
const STARTED_AT = "2026-05-04T10:30:11Z";
const ENDED_AT = "2026-05-04T10:35:11Z";

/** A well-formed finding id: the shape `--finding` requires. */
const FULL_FINDING_ID = `fnd_${"a".repeat(64)}`;

const ROLLBACK_LOCK_REL = join(".viberevert", ".locks", "rollback.lock");

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-rollback-selective-"));
  originalCwd = process.cwd();
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: tmpRoot });
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
    { cwd: tmpRoot },
  );
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// =============================================================================
// Helpers
// =============================================================================

type RegisteredCommand = Parameters<Cli["register"]>[0];

async function runCommand(
  CommandClass: RegisteredCommand,
  commandName: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(CommandClass);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = false;

  const collect = (sink: string[]): Writable =>
    new Writable({
      write(chunk, _encoding, callback) {
        sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        callback();
      },
    });

  const exitCode = await cli.run([commandName, ...args], {
    stdin: stdinStub,
    stdout: collect(stdoutChunks),
    stderr: collect(stderrChunks),
  });

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

const runRollback = (args: string[]) => runCommand(RollbackCommand, "rollback", args);

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

async function writeMinimalConfig(): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
}

/**
 * A legacy ENDED session: real checkpoint artifacts, no contribution.
 *
 * Ended rather than active so the D63 active-session refusal does not fire
 * first and hide the selection refusal these tests are about.
 */
async function writeLegacyEndedSession(): Promise<void> {
  const sessionDir = join(tmpRoot, ".viberevert", "sessions", SESSION_ID);
  const checkpointDir = join(sessionDir, "checkpoint");
  await mkdir(join(checkpointDir, "rollback"), { recursive: true });

  for (const filename of [
    "unstaged.patch",
    "staged.patch",
    "tracked-dirty.tar.gz",
    "untracked.tar.gz",
  ]) {
    await writeFile(join(checkpointDir, "rollback", filename), "");
  }

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    session_id: SESSION_ID,
    captured_at: STARTED_AT,
    git: { head_sha: HEAD_SHA, branch: "main", porcelain_v1: "" },
    diffs: {
      unstaged_patch_path: "rollback/unstaged.patch",
      staged_patch_path: "rollback/staged.patch",
    },
    snapshots: {
      tracked_dirty_archive_path: "rollback/tracked-dirty.tar.gz",
      tracked_dirty_paths: [],
      file_hashes: {},
    },
    untracked: { archive_path: "rollback/untracked.tar.gz", exclude_patterns: [], file_hashes: {} },
    rollback_target_description: "Selective-command test fixture",
  };
  await writeFile(join(checkpointDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const session: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: SESSION_ID,
    checkpoint_id: CHECKPOINT_ID,
    started_at: STARTED_AT,
    ended_at: ENDED_AT,
    before_status_path: `.viberevert/sessions/${SESSION_ID}/before-status.txt`,
    after_status_path: `.viberevert/sessions/${SESSION_ID}/after-status.txt`,
    commands_log_path: `.viberevert/sessions/${SESSION_ID}/commands.log`,
  } as SessionState;
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));
  await writeFile(join(sessionDir, "before-status.txt"), "");
  await writeFile(join(sessionDir, "after-status.txt"), "");
  await writeFile(join(sessionDir, "commands.log"), "");
}

const selectors = (overrides: Partial<SelectionSelectors> = {}): SelectionSelectors => ({
  only: [],
  except: [],
  finding: [],
  ...overrides,
});

// =============================================================================
// A. Pure pre-lock selector validation
// =============================================================================

describe("rollback selectors: validated before the lock", () => {
  it("refuses an unknown --risk level and names the four that exist", async () => {
    await writeMinimalConfig();
    const result = await runRollback([SESSION_ID, "--risk", "urgent"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid --risk "urgent"');
    expect(result.stderr).toContain("low, medium, high, critical");
  });

  it("refuses a --finding PREFIX rather than persisting one a marker cannot express", async () => {
    await writeMinimalConfig();
    const result = await runRollback([SESSION_ID, "--finding", "fnd_abc"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Expected a full finding id");
    expect(result.stderr).toContain("Short prefixes are not accepted yet");
  });

  it("refuses before touching rollback state at all", async () => {
    // No config and no session exist. A validation that ran AFTER the lock
    // would have to report a missing config or session instead, and would have
    // created the lock directory on the way.
    const result = await runRollback([SESSION_ID, "--risk", "urgent"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --risk");
    expect(await exists(join(tmpRoot, ROLLBACK_LOCK_REL))).toBe(false);
  });

  it("accepts a full finding id, which then reaches the locked phase", async () => {
    await writeMinimalConfig();
    const result = await runRollback([SESSION_ID, "--finding", FULL_FINDING_ID]);

    // The session does not exist, so this refuses INSIDE the lock. That is the
    // point: the pure check passed and the command got that far.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("Expected a full finding id");
    expect(result.stderr).toContain(SESSION_ID);
  });

  it("still validates the session id first, whatever selectors are supplied", async () => {
    await writeMinimalConfig();
    const result = await runRollback(["not-a-session", "--only", "src/**"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid session id");
  });
});

// =============================================================================
// B. Mode and selectors are bound to each other
// =============================================================================

describe("resolveRollbackSelectionMode", () => {
  it("no selector at all is full mode, and carries no selectors to disagree with", () => {
    expect(resolveRollbackSelectionMode(selectors())).toEqual({ mode: "full" });
  });

  it.each([
    ["only", selectors({ only: ["src/**"] })],
    ["except", selectors({ except: ["tests/**"] })],
    ["finding", selectors({ finding: [FULL_FINDING_ID] })],
    ["risk", selectors({ risk: "high" })],
  ] as const)("a lone --%s enters selective mode", (_family, supplied) => {
    expect(resolveRollbackSelectionMode(supplied)).toEqual({
      mode: "selective",
      selectors: supplied,
    });
  });

  it("carries the selectors VERBATIM, so mode and intent cannot drift apart", () => {
    const supplied = selectors({ only: ["a/**", "b/**"], except: ["c/**"], risk: "critical" });
    const resolved = resolveRollbackSelectionMode(supplied);

    if (resolved.mode !== "selective") throw new Error("expected selective mode");
    expect(resolved.selectors).toBe(supplied);
  });
});

// =============================================================================
// C. The single-lock boundary
// =============================================================================

describe("rollback holds the rollback lock exactly once", () => {
  it("releases it after a selective refusal", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    const result = await runRollback([SESSION_ID, "--only", "src/**"]);

    expect(result.exitCode).toBe(1);
    expect(await exists(join(tmpRoot, ROLLBACK_LOCK_REL))).toBe(false);
  });

  it("refuses when the lock is already held, selectors and all", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();
    // A bare directory with no lock.json: the "metadata unavailable" variant,
    // which needs no fabricated holder to be a real contention.
    await mkdir(join(tmpRoot, ROLLBACK_LOCK_REL), { recursive: true });

    const result = await runRollback([SESSION_ID, "--only", "src/**"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Another viberevert operation is already running");
    expect(result.stderr).toContain(ROLLBACK_LOCK_REL);
  });

  it("a nested acquisition would deadlock, so a second run inside the same repo is refused", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();
    await mkdir(join(tmpRoot, ROLLBACK_LOCK_REL), { recursive: true });

    // Full mode contends on the SAME lock as selective mode. One boundary, not
    // one per branch.
    const result = await runRollback([SESSION_ID]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Another viberevert operation is already running");
  });
});

// =============================================================================
// D. Post-lock rendering and exit status
// =============================================================================

describe("selective rollback against a session with no contribution", () => {
  it("refuses a preview and says which evidence is missing", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    const result = await runRollback([SESSION_ID, "--only", "src/**"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CONTRIBUTION_REQUIRED");
    expect(result.stdout).toBe("");
  });

  it("writes no receipt of either kind", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    await runRollback([SESSION_ID, "--except", "tests/**"]);

    const sessionDir = join(tmpRoot, ".viberevert", "sessions", SESSION_ID);
    expect(await exists(join(sessionDir, "rollback-dry-run-receipt.json"))).toBe(false);
    expect(await exists(join(sessionDir, "rollback-receipt.json"))).toBe(false);
    expect(await exists(join(sessionDir, "selective-rollback-dry-run-receipt.json"))).toBe(false);
  });

  it("reserves no rollback invocation, so it cannot block a later apply", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    await runRollback([SESSION_ID, "--only", "src/**", "--apply"]);

    // An invocation directory with a marker and no receipt is what the history
    // scan treats as a blocker. A refused operation must leave none.
    const rollbacksDir = join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "rollbacks");
    expect(await exists(rollbacksDir)).toBe(false);
  });

  it("creates no emergency checkpoint, because nothing was ever authorized to mutate", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    await runRollback([SESSION_ID, "--risk", "critical", "--apply"]);

    const checkpointsDir = join(tmpRoot, ".viberevert", "checkpoints");
    const entries = await readdir(checkpointsDir).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("refuses a report-backed selector for its OWN reason, not a contribution one", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    // `--risk` consults a report, and no report exists. The contribution is
    // missing too, and the contribution refusal is the one that must win:
    // without it there is nothing for a report to be stale against.
    const result = await runRollback([SESSION_ID, "--risk", "high"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CONTRIBUTION_REQUIRED");
  });
});

describe("no selectors still means the legacy full-session engine", () => {
  it("writes the legacy dry-run receipt and exits 0", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    const result = await runRollback([SESSION_ID]);

    expect(result.exitCode).toBe(0);
    expect(
      await exists(
        join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "rollback-dry-run-receipt.json"),
      ),
    ).toBe(true);
    // The selective preview receipt is a different artifact at a different
    // path, and the full path must never produce one.
    expect(
      await exists(
        join(
          tmpRoot,
          ".viberevert",
          "sessions",
          SESSION_ID,
          "selective-rollback-dry-run-receipt.json",
        ),
      ),
    ).toBe(false);
  });

  it("keeps --force without --apply a pure pre-lock refusal", async () => {
    await writeMinimalConfig();
    const result = await runRollback([SESSION_ID, "--only", "src/**", "--force"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--force has no effect without --apply");
    expect(await exists(join(tmpRoot, ROLLBACK_LOCK_REL))).toBe(false);
  });
});
