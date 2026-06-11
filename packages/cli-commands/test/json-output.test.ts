// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration tests for the CLI's listing commands in --json mode,
// locking the D20 machine-output contract:
//   - Full prefixed IDs (NOT truncated)
//   - Full SHAs (NOT truncated)
//   - `null` (NOT omitted, NOT "-") for missing fields
//   - Repo-relative POSIX paths (forward slashes only)
//   - `[]` for empty state (NOT the human-mode "No X found." line)
//   - Stdout-only JSON; warnings still flow to stderr per D13
//
// The human-format contract is covered in listing.test.ts; the
// truncation helpers are unit-tested in format.test.ts. This file
// asserts the JSON-mode contract that downstream tools (MCP server,
// scripts, future M C/D consumers) will depend on.
//
// Setup (mkdtemp + git init + .gitignore) and fixture helpers
// (writeCheckpointFixture, writeSessionFixture, writeActiveLock) are
// intentionally duplicated from listing.test.ts. Each test file
// stays self-contained — matches the M A pattern (init.test.ts is
// also self-contained). If 5e/5f's tests grow the same scaffolding
// further, extracting to `packages/cli/test/_helpers.ts` would be
// justified.

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

// Crockford-base32 ULIDs (no I, L, O, U). 26-char body each.
const CHECKPOINT_ID_NEW = "cp_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID_OLD = "cp_01JV8XQ4H27ABCDEFGHJKMNPQR";
const SESSION_ID_NEW = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const SESSION_ID_OLD = "sess_01JV8WQ4J97ABCDEFGHJKMNPQR";
const SHA_FULL = "a1b2c3d4e5f6789012345678901234567890abcd";
const STARTED_AT_NEW = "2026-05-04T10:30:11Z";
const STARTED_AT_OLD = "2026-05-04T09:02:44Z";
const ENDED_AT_OLD = "2026-05-04T09:18:03Z";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cli-json-"));
  originalCwd = process.cwd();
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: tmpRoot });
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

// =============================================================================
// Fixture helpers (duplicated from listing.test.ts; see file header)
// =============================================================================

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
    session_id: opts.checkpointId,
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
// checkpoints --json
// =============================================================================

describe("checkpoints --json", () => {
  it("empty state: stdout is exactly `[]`, stderr empty, exit 0", async () => {
    const result = await runCheckpoints(["--json"]);
    expect(result.exitCode).toBe(0);
    // D20 + D12: empty state in --json mode emits `[]`, NOT the human
    // "No checkpoints found." copy. Strip trailing newline before
    // exact match.
    expect(result.stdout.replace(/\n$/, "")).toBe("[]");
    expect(result.stderr).toBe("");
  });

  it("emits D20-shaped JSON: full IDs, full SHA, null name for unnamed, repo-relative POSIX paths, newest first", async () => {
    await writeCheckpointFixture({
      checkpointId: CHECKPOINT_ID_OLD,
      name: "before-migrate",
      capturedAt: "2026-05-04T08:00:00Z",
      headSha: SHA_FULL,
    });
    await writeCheckpointFixture({
      checkpointId: CHECKPOINT_ID_NEW,
      // unnamed → JSON `name` MUST be null (NOT omitted, NOT "-")
      capturedAt: "2026-05-04T10:00:00Z",
      headSha: SHA_FULL,
    });

    const result = await runCheckpoints(["--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    // Stdout must parse as valid JSON.
    const parsed = JSON.parse(result.stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as Array<{
      id: string;
      name: string | null;
      created_at: string;
      head_sha: string;
      path: string;
    }>;
    expect(arr).toHaveLength(2);

    // Newest first per D20 (preserved from git.listCheckpoints's
    // ULID-descending sort).
    const first = arr[0];
    const second = arr[1];
    if (first === undefined || second === undefined) {
      throw new Error("test bug: parsed array missing entries");
    }
    expect(first.id).toBe(CHECKPOINT_ID_NEW);
    expect(second.id).toBe(CHECKPOINT_ID_OLD);

    // Full IDs (NOT truncated). The truncated form `cp_01JV8Z0N6E7ABC`
    // is 17 chars; full ID is 29 chars (3 prefix + 26 body).
    expect(first.id.length).toBe(29);
    expect(second.id.length).toBe(29);

    // Full SHA (NOT truncated). 40 hex chars.
    expect(first.head_sha).toBe(SHA_FULL);
    expect(first.head_sha.length).toBe(40);
    expect(second.head_sha).toBe(SHA_FULL);

    // name: null (NOT "-", NOT omitted) for the unnamed checkpoint.
    expect(first.name).toBeNull();
    expect(second.name).toBe("before-migrate");

    // path: repo-relative POSIX (forward slashes, no leading slash,
    // no trailing slash). Per D20.
    expect(first.path).toBe(`.viberevert/checkpoints/${CHECKPOINT_ID_NEW}`);
    expect(second.path).toBe(`.viberevert/checkpoints/${CHECKPOINT_ID_OLD}`);
    // Defensive: no backslashes ever, even on Windows.
    expect(first.path).not.toContain("\\");
    expect(second.path).not.toContain("\\");
  });
});

// =============================================================================
// sessions --json
// =============================================================================

describe("sessions --json", () => {
  it("empty state: stdout is exactly `[]`, stderr empty, exit 0", async () => {
    const result = await runSessions(["--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.replace(/\n$/, "")).toBe("[]");
    expect(result.stderr).toBe("");
  });

  it("emits D20-shaped JSON: full IDs, status, null for active ended_at, null for absent task, full untruncated task", async () => {
    // Older ended session — has task, has ended_at
    await writeSessionFixture({
      sessionId: SESSION_ID_OLD,
      checkpointId: CHECKPOINT_ID_OLD,
      startedAt: STARTED_AT_OLD,
      endedAt: ENDED_AT_OLD,
      task: "Fix webhook tests",
    });
    // Newer active session — long task (would be truncated in human
    // mode; --json must emit full untruncated string) and is the
    // active one (no ended_at)
    const longTask = `Add yearly billing for enterprise plan ${"x".repeat(50)}`;
    expect(longTask.length).toBeGreaterThan(48); // sanity: would truncate in human mode
    await writeSessionFixture({
      sessionId: SESSION_ID_NEW,
      checkpointId: CHECKPOINT_ID_NEW,
      startedAt: STARTED_AT_NEW,
      task: longTask,
    });
    await writeActiveLock({
      sessionId: SESSION_ID_NEW,
      checkpointId: CHECKPOINT_ID_NEW,
      startedAt: STARTED_AT_NEW,
      task: longTask,
    });

    const result = await runSessions(["--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as Array<{
      id: string;
      checkpoint_id: string;
      status: "active" | "ended";
      started_at: string;
      ended_at: string | null;
      task: string | null;
      path: string;
    }>;
    expect(arr).toHaveLength(2);

    // Newest first (active session NEW comes before ended OLD).
    const first = arr[0];
    const second = arr[1];
    if (first === undefined || second === undefined) {
      throw new Error("test bug: parsed array missing entries");
    }

    // Active session: full ID, status="active", ended_at=null,
    // FULL UNTRUNCATED task (D20: never truncate JSON values).
    expect(first.id).toBe(SESSION_ID_NEW);
    expect(first.id.length).toBe(31); // 5 prefix + 26 body
    expect(first.checkpoint_id).toBe(CHECKPOINT_ID_NEW);
    expect(first.checkpoint_id.length).toBe(29); // 3 prefix + 26 body
    expect(first.status).toBe("active");
    expect(first.ended_at).toBeNull(); // D20: null, NOT "-", NOT omitted
    expect(first.task).toBe(longTask);
    expect(first.task?.length).toBeGreaterThan(48); // FULL string, not truncated to 48
    expect(first.path).toBe(`.viberevert/sessions/${SESSION_ID_NEW}`);
    expect(first.path).not.toContain("\\");

    // Ended session: status="ended", ended_at=ISO string.
    expect(second.id).toBe(SESSION_ID_OLD);
    expect(second.status).toBe("ended");
    expect(second.ended_at).toBe(ENDED_AT_OLD);
    expect(second.task).toBe("Fix webhook tests");
    expect(second.path).toBe(`.viberevert/sessions/${SESSION_ID_OLD}`);
  });

  it("emits null for task when session has no task (D20: null, NOT omitted, NOT '-')", async () => {
    await writeSessionFixture({
      sessionId: SESSION_ID_NEW,
      checkpointId: CHECKPOINT_ID_NEW,
      startedAt: STARTED_AT_NEW,
      endedAt: ENDED_AT_OLD,
      // task: omitted from fixture → SessionState has no task field
    });

    const result = await runSessions(["--json"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as Array<{ task: string | null }>;
    expect(parsed).toHaveLength(1);
    const session = parsed[0];
    if (session === undefined) {
      throw new Error("test bug: parsed array missing entry");
    }
    // D20: task field MUST be present and MUST be null when absent.
    // NOT omitted from the JSON object; NOT "-".
    expect(session.task).toBeNull();
    expect(Object.hasOwn(session, "task")).toBe(true);
  });

  it("forwards warnings to stderr in --json mode without breaking stdout JSON parsability (D13 + D20)", async () => {
    // Orphan session: triggers crash_interrupted warning. Stdout
    // should still emit valid JSON `[]` (orphan filtered out of
    // sessions array); stderr gets the warning.
    await writeSessionFixture({
      sessionId: SESSION_ID_NEW,
      checkpointId: CHECKPOINT_ID_NEW,
      startedAt: STARTED_AT_NEW,
    });

    const result = await runSessions(["--json"]);
    expect(result.exitCode).toBe(0);

    // Stderr has the warning per D13.
    expect(result.stderr).toContain("warning: crash_interrupted:");
    expect(result.stderr).toContain(SESSION_ID_NEW);

    // Stdout is still valid JSON `[]` per D20 — warnings on stderr
    // don't pollute the stdout JSON contract that downstream tools
    // parse.
    expect(result.stdout.replace(/\n$/, "")).toBe("[]");
    // Defensive: ensure stdout parses cleanly with no surprises.
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
});
