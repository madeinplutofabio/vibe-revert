// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration tests for the CLI's listing commands in human format:
//   - viberevert checkpoints (D12 column format, newest-first, ID/SHA
//     truncation, "-" for unnamed, "No checkpoints found." empty state)
//   - viberevert sessions (D12 column format, status active/ended,
//     ENDED_AT="-" for active, D18 TASK truncation with `…` ellipsis,
//     "No sessions found." empty state, D13 warnings forwarded to
//     stderr)
//
// The --json shape contract (D20) for both commands is covered in
// json-output.test.ts. format.test.ts unit-tests the truncation
// helpers in isolation — this file verifies their integration through
// the command's stdout.
//
// Setup mirrors start-end.test.ts (real git repo via `git init`, plus
// .gitignore for .viberevert/ to keep `git status` clean). Fixtures
// for checkpoints + sessions are written directly to disk via writeFile
// — bypassing git.createCheckpoint and core.startSession — so test IDs
// are deterministic and the tests don't depend on ULID-generation
// timing.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  type ActiveSessionLock,
  type Manifest,
  SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointsCommand } from "../src/commands/checkpoints.js";
import { SessionsCommand } from "../src/commands/sessions.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Fixture constants
// =============================================================================

// Crockford-base32 ULIDs (no I, L, O, U). Three IDs to verify
// newest-first ordering: `_NEW > _MID > _OLD` in lex order.
const CHECKPOINT_ID_NEW = "cp_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID_MID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID_OLD = "cp_01JV8XQ4H27ABCDEFGHJKMNPQR";
const SESSION_ID_NEW = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const SESSION_ID_OLD = "sess_01JV8WQ4J97ABCDEFGHJKMNPQR";
const SHA_FULL = "a1b2c3d4e5f6789012345678901234567890abcd";
const STARTED_AT_NEW = "2026-05-04T10:30:11Z";
const STARTED_AT_OLD = "2026-05-04T09:02:44Z";
const ENDED_AT = "2026-05-04T10:45:00Z";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cli-listing-"));
  originalCwd = process.cwd();
  // Real git repo for resolveRepoRoot via .git/ marker.
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: tmpRoot });
  // Mirror M A's init: gitignore .viberevert/.
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

// =============================================================================
// Fixture helpers
// =============================================================================

/**
 * Write a complete checkpoint fixture: manifest + 4 empty placeholder
 * artifact files (unstaged.patch, staged.patch, tracked-dirty.tar.gz,
 * untracked.tar.gz). listCheckpoints → loadCheckpoint lstats each
 * artifact and checks isFile(); empty regular files satisfy that.
 */
async function writeCheckpointFixture(opts: {
  checkpointId: string;
  name?: string;
  capturedAt: string;
  headSha: string;
}): Promise<void> {
  const checkpointDir = join(tmpRoot, ".viberevert", "checkpoints", opts.checkpointId);
  const rollbackDir = join(checkpointDir, "rollback");
  await mkdir(rollbackDir, { recursive: true });

  for (const filename of [
    "unstaged.patch",
    "staged.patch",
    "tracked-dirty.tar.gz",
    "untracked.tar.gz",
  ]) {
    await writeFile(join(rollbackDir, filename), "");
  }

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    session_id: opts.checkpointId, // D6 standalone invariant
    captured_at: opts.capturedAt,
    git: {
      head_sha: opts.headSha,
      branch: "main",
      porcelain_v1: "",
    },
    diffs: {
      unstaged_patch_path: "rollback/unstaged.patch",
      staged_patch_path: "rollback/staged.patch",
    },
    snapshots: {
      tracked_dirty_archive_path: "rollback/tracked-dirty.tar.gz",
      tracked_dirty_paths: [],
      file_hashes: {},
    },
    untracked: {
      archive_path: "rollback/untracked.tar.gz",
      exclude_patterns: [],
      file_hashes: {},
    },
    rollback_target_description: "Test fixture",
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  };

  await writeFile(join(checkpointDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/**
 * Write a session fixture (session.json + before-status.txt +
 * commands.log; after-status.txt only if endedAt provided).
 */
async function writeSessionFixture(opts: {
  sessionId: string;
  checkpointId: string;
  startedAt: string;
  endedAt?: string;
  task?: string;
}): Promise<void> {
  const sessionDir = join(tmpRoot, ".viberevert", "sessions", opts.sessionId);
  await mkdir(join(sessionDir, "checkpoint"), { recursive: true });

  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: opts.sessionId,
    checkpoint_id: opts.checkpointId,
    started_at: opts.startedAt,
    ...(opts.endedAt !== undefined
      ? {
          ended_at: opts.endedAt,
          after_status_path: `.viberevert/sessions/${opts.sessionId}/after-status.txt`,
        }
      : {}),
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    before_status_path: `.viberevert/sessions/${opts.sessionId}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${opts.sessionId}/commands.log`,
  };

  await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState, null, 2));
  await writeFile(join(sessionDir, "before-status.txt"), "");
  await writeFile(join(sessionDir, "commands.log"), "");
  if (opts.endedAt !== undefined) {
    await writeFile(join(sessionDir, "after-status.txt"), "");
  }
}

/**
 * Write `.viberevert/active-session.json` with the given lock contents.
 */
async function writeActiveLock(opts: {
  sessionId: string;
  checkpointId: string;
  startedAt: string;
  task?: string;
}): Promise<void> {
  const lock: ActiveSessionLock = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: opts.sessionId,
    checkpoint_id: opts.checkpointId,
    started_at: opts.startedAt,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
  };
  await writeFile(
    join(tmpRoot, ".viberevert", "active-session.json"),
    JSON.stringify(lock, null, 2),
  );
}

// Extracted from clipanion's actual API contract (the type
// `Cli.register` accepts as its first argument). Decouples our test
// scaffolding from clipanion's internal class hierarchy and avoids the
// `typeof Command` + type-only-import fragility.
type RegisteredCommand = Parameters<Cli["register"]>[0];

/**
 * Generic runner: register the given Command class, invoke it via
 * clipanion's Cli, return captured stdout/stderr + exit code.
 *
 * Same harness pattern as init.test.ts and start-end.test.ts —
 * PassThrough stdin (isTTY=false), Writable stdout/stderr capturing
 * chunks.
 */
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

  const exitCode = await cli.run([commandName, ...args], {
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

const runCheckpoints = (args: string[]) => runCommand(CheckpointsCommand, "checkpoints", args);
const runSessions = (args: string[]) => runCommand(SessionsCommand, "sessions", args);

// =============================================================================
// checkpoints command — human format
// =============================================================================

describe("checkpoints command — human format", () => {
  it("empty state: prints exactly `No checkpoints found.` and exits 0", async () => {
    const result = await runCheckpoints([]);
    expect(result.exitCode).toBe(0);
    // D12 locked empty-state copy: exactly one line, no header,
    // no extras. Stripping trailing newline before exact match.
    expect(result.stdout.replace(/\n$/, "")).toBe("No checkpoints found.");
    expect(result.stderr).toBe("");
  });

  it("lists checkpoints newest-first with named/unnamed mix and ID/SHA truncation", async () => {
    await writeCheckpointFixture({
      checkpointId: CHECKPOINT_ID_OLD,
      name: "before-migrate",
      capturedAt: "2026-05-04T08:00:00Z",
      headSha: SHA_FULL,
    });
    await writeCheckpointFixture({
      checkpointId: CHECKPOINT_ID_MID,
      // unnamed → renders as "-"
      capturedAt: "2026-05-04T09:00:00Z",
      headSha: SHA_FULL,
    });
    await writeCheckpointFixture({
      checkpointId: CHECKPOINT_ID_NEW,
      name: "release-ready",
      capturedAt: "2026-05-04T10:00:00Z",
      headSha: SHA_FULL,
    });

    const result = await runCheckpoints([]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    // Header row present
    expect(result.stdout).toContain("NAME");
    expect(result.stdout).toContain("ID");
    expect(result.stdout).toContain("CREATED_AT");
    expect(result.stdout).toContain("HEAD_SHA");

    // Newest first: CHECKPOINT_ID_NEW (truncated) appears before
    // CHECKPOINT_ID_MID (truncated), which appears before
    // CHECKPOINT_ID_OLD (truncated).
    const newIdx = result.stdout.indexOf("cp_01JV8Z0N6E7ABC");
    const midIdx = result.stdout.indexOf("cp_01JV8Y7W2M7ABC");
    const oldIdx = result.stdout.indexOf("cp_01JV8XQ4H27ABC");
    expect(newIdx).toBeGreaterThan(-1);
    expect(midIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldIdx);

    // ID truncation: the FULL ID should NOT appear in stdout.
    expect(result.stdout).not.toContain(CHECKPOINT_ID_NEW);
    // SHA truncation: 7-char prefix, NOT the full SHA.
    expect(result.stdout).toContain("a1b2c3d");
    expect(result.stdout).not.toContain(SHA_FULL);

    // Names rendered correctly: named shows the label, unnamed shows "-".
    expect(result.stdout).toContain("release-ready");
    expect(result.stdout).toContain("before-migrate");
    // The unnamed checkpoint's row should have "-" in the NAME
    // column. Since the table is fixed-width, search for the
    // unnamed checkpoint's truncated ID and verify "-" precedes it.
    expect(result.stdout).toMatch(/-\s+cp_01JV8Y7W2M7ABC/);
  });

  it("surfaces CheckpointCorruptError as clean stderr message and exits 1", async () => {
    // Trigger the D6 standalone-invariant violation: dir name says
    // CHECKPOINT_ID_NEW but the manifest's session_id says
    // CHECKPOINT_ID_OLD. listCheckpoints throws CheckpointCorruptError.
    const checkpointDir = join(tmpRoot, ".viberevert", "checkpoints", CHECKPOINT_ID_NEW);
    const rollbackDir = join(checkpointDir, "rollback");
    await mkdir(rollbackDir, { recursive: true });
    for (const f of [
      "unstaged.patch",
      "staged.patch",
      "tracked-dirty.tar.gz",
      "untracked.tar.gz",
    ]) {
      await writeFile(join(rollbackDir, f), "");
    }
    const corrupt: Manifest = {
      schema_version: SCHEMA_VERSION,
      session_id: CHECKPOINT_ID_OLD, // mismatch with dir name
      captured_at: "2026-05-04T10:00:00Z",
      git: { head_sha: SHA_FULL, branch: "main", porcelain_v1: "" },
      diffs: {
        unstaged_patch_path: "rollback/unstaged.patch",
        staged_patch_path: "rollback/staged.patch",
      },
      snapshots: {
        tracked_dirty_archive_path: "rollback/tracked-dirty.tar.gz",
        tracked_dirty_paths: [],
        file_hashes: {},
      },
      untracked: {
        archive_path: "rollback/untracked.tar.gz",
        exclude_patterns: [],
        file_hashes: {},
      },
      rollback_target_description: "Test fixture",
    };
    await writeFile(join(checkpointDir, "manifest.json"), JSON.stringify(corrupt, null, 2));

    const result = await runCheckpoints([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error reading checkpoints:");
    expect(result.stderr).toContain("standalone checkpoint invariant");
    // Clean error — no JS stack leaked
    expect(result.stderr).not.toContain("at async");
    expect(result.stderr).not.toContain(".js:");
  });
});

// =============================================================================
// sessions command — human format
// =============================================================================

describe("sessions command — human format", () => {
  it("empty state: prints exactly `No sessions found.` and exits 0", async () => {
    const result = await runSessions([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.replace(/\n$/, "")).toBe("No sessions found.");
    expect(result.stderr).toBe("");
  });

  it("lists sessions: active + ended, with status, ENDED_AT='-' for active, ID truncation", async () => {
    // Older ended session
    await writeSessionFixture({
      sessionId: SESSION_ID_OLD,
      checkpointId: CHECKPOINT_ID_OLD,
      startedAt: STARTED_AT_OLD,
      endedAt: "2026-05-04T09:18:03Z",
      task: "Fix webhook tests",
    });
    // Newer active session
    await writeSessionFixture({
      sessionId: SESSION_ID_NEW,
      checkpointId: CHECKPOINT_ID_NEW,
      startedAt: STARTED_AT_NEW,
      task: "Add yearly billing",
    });
    await writeActiveLock({
      sessionId: SESSION_ID_NEW,
      checkpointId: CHECKPOINT_ID_NEW,
      startedAt: STARTED_AT_NEW,
      task: "Add yearly billing",
    });

    const result = await runSessions([]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    // Header row
    expect(result.stdout).toContain("STATUS");
    expect(result.stdout).toContain("ID");
    expect(result.stdout).toContain("STARTED_AT");
    expect(result.stdout).toContain("ENDED_AT");
    expect(result.stdout).toContain("TASK");

    // Newest first: active session should appear before the ended one.
    const activeIdx = result.stdout.indexOf("active");
    const endedIdx = result.stdout.indexOf("ended");
    expect(activeIdx).toBeGreaterThan(-1);
    expect(endedIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeLessThan(endedIdx);

    // ID truncation: full IDs should NOT appear; truncated forms should.
    expect(result.stdout).not.toContain(SESSION_ID_NEW);
    expect(result.stdout).not.toContain(SESSION_ID_OLD);
    expect(result.stdout).toContain("sess_01JV8Z0N6E7ABC");
    expect(result.stdout).toContain("sess_01JV8WQ4J97ABC");

    // Active session's ENDED_AT shows "-"; ended session's shows the ISO.
    // Anchor the literal STARTED_AT timestamp before the dash to force
    // the dash into the ENDED_AT column (the dashes within the
    // STARTED_AT date itself can't satisfy this pattern).
    expect(result.stdout).toMatch(
      /sess_01JV8Z0N6E7ABC\s+2026-05-04T10:30:11Z\s+-\s+Add yearly billing/,
    );
    // Ended session row contains both timestamps
    expect(result.stdout).toMatch(
      /sess_01JV8WQ4J97ABC.*2026-05-04T09:02:44Z.*2026-05-04T09:18:03Z/,
    );

    // Tasks rendered in full (under 48 chars, no truncation).
    expect(result.stdout).toContain("Add yearly billing");
    expect(result.stdout).toContain("Fix webhook tests");
  });

  it("truncates a long task to 48 chars + `…` ellipsis (D18 boundary)", async () => {
    // 60-char task — definitely longer than the 48-char limit.
    const longTask = "x".repeat(60);
    await writeSessionFixture({
      sessionId: SESSION_ID_NEW,
      checkpointId: CHECKPOINT_ID_NEW,
      startedAt: STARTED_AT_NEW,
      endedAt: ENDED_AT,
      task: longTask,
    });

    const result = await runSessions([]);
    expect(result.exitCode).toBe(0);
    // Truncated: 47 x's + ellipsis = 48 display chars
    const expected = `${"x".repeat(47)}…`;
    expect(result.stdout).toContain(expected);
    // Full 60-char string should NOT appear
    expect(result.stdout).not.toContain(longTask);
  });

  it("forwards crash_interrupted warning to stderr and omits the orphan from sessions list", async () => {
    // Orphan: in-flight session (no ended_at) but no active-session.json
    // referencing it. core.listSessions classifies as crash_interrupted.
    await writeSessionFixture({
      sessionId: SESSION_ID_NEW,
      checkpointId: CHECKPOINT_ID_NEW,
      startedAt: STARTED_AT_NEW,
    });

    const result = await runSessions([]);
    expect(result.exitCode).toBe(0);

    // Warning to stderr
    expect(result.stderr).toContain("warning: crash_interrupted:");
    expect(result.stderr).toContain(SESSION_ID_NEW);
    expect(result.stderr).toContain(`.viberevert/sessions/${SESSION_ID_NEW}`);

    // Stdout shows empty state — orphan filtered out, no other sessions
    expect(result.stdout.replace(/\n$/, "")).toBe("No sessions found.");
  });

  it("forwards schema_invalid warning to stderr and omits the invalid record from sessions list", async () => {
    // Invalid: session.json has session_id mismatching dir name.
    // core.listSessions classifies as schema_invalid (per session.ts).
    const sessionDir = join(tmpRoot, ".viberevert", "sessions", SESSION_ID_NEW);
    await mkdir(sessionDir, { recursive: true });
    const mismatchState: SessionState = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: SESSION_ID_OLD, // mismatch with dir name
      checkpoint_id: CHECKPOINT_ID_NEW,
      started_at: STARTED_AT_NEW,
      ended_at: ENDED_AT,
      after_status_path: `.viberevert/sessions/${SESSION_ID_NEW}/after-status.txt`,
      before_status_path: `.viberevert/sessions/${SESSION_ID_NEW}/before-status.txt`,
      commands_log_path: `.viberevert/sessions/${SESSION_ID_NEW}/commands.log`,
    };
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(mismatchState, null, 2));

    const result = await runSessions([]);
    expect(result.exitCode).toBe(0);

    // Warning to stderr with the reason
    expect(result.stderr).toContain("warning: schema_invalid:");
    expect(result.stderr).toContain(SESSION_ID_NEW);
    expect(result.stderr).toContain("does not match dir name");

    // Stdout shows empty state — invalid record filtered out
    expect(result.stdout.replace(/\n$/, "")).toBe("No sessions found.");
  });
});
