// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration tests for the `viberevert rollback` command (M D Step 7).
//
// 29 tests across 8 suites:
//   A. Pure-validation refusals (no fixture needed)
//   B. Refusal-class tests (session+manifest only, no real patches)
//   C. D75 force-policy + D61b coverage (real M B fixture)
//   D. Real apply happy path (real M B fixture)
//   E. Format flags (Lock #12 — JSON parseable, markdown heading, terminal string)
//   F. D68 path-split discipline (named-helper lock #4)
//   G. Apply receipt = ATTEMPT semantics (Lock #16)
//   H. Lock contention + D5b emergency-CP suffix
//
// =============================================================================
// Architectural locks for this test file
// =============================================================================
//
//  1. **BEHAVIORAL, NOT BYTE-GOLDEN (per Step 7 lock L4).** Tests
//     assert receipt structure, fields, paths, exit codes, and
//     refusal copy. Tests do NOT assert full renderer bytes —
//     Step 8 owns byte-stable golden fixtures.
//
//  2. **NO MOCKING of @viberevert/git or @viberevert/core.** Tests
//     use real `git init`, real createCheckpoint, real
//     restoreCheckpoint, real session lifecycle. The Step 6 unit
//     test (rollback-orchestration.test.ts) covers the mocked
//     paths; this file is integration-end-to-end.
//
//  3. **Hybrid fixture strategy.** Three fixture functions chosen
//     per-test based on what setup the assertion requires:
//       - `writeSessionFixtureForRefusalTest`: session.json +
//         minimal-but-valid manifest. Used for refusal-only suites
//         where restoreCheckpoint never runs. Intentionally omits
//         `after_status_z_path` to keep the legacy pre-M D session
//         shape — these tests fire refusals BEFORE D61b would be
//         reached per D76's ordered walk, so D61b's missing-snapshot
//         branch is irrelevant here.
//       - `setupRealSession`: invokes real `viberevert start` →
//         modify files → `viberevert end` via runCommand. Produces
//         real checkpoint artifacts restore can replay. Slower
//         (~200-400ms per test) but used only where the test
//         actually exercises restore behavior.
//       - `corruptCheckpointPatches`: helper that reads the
//         session's checkpoint manifest, derives the captured
//         unstaged-patch path FROM the manifest (not hardcoded),
//         and overwrites with non-patch bytes to force a real
//         restoreCheckpoint throw for Suite G failure semantics.
//
//  4. **Helper duplication accepted (per Step 7 lock L4 and the
//     established M B / M C convention in checkpoint.test.ts:11).**
//     `runCommand` + `writeMinimalConfig` + `writeCheckpointFixture`
//     are duplicated verbatim from json-output.test.ts /
//     checkpoint.test.ts. Each test file stays self-contained;
//     a post-Step-9 extraction pass tracks the cleanup.
//
//  5. **Single-timestamp determinism via VIBEREVERT_TEST_FIXED_NOW.**
//     Tests that need to assert exact persisted timestamps set
//     `process.env.VIBEREVERT_TEST_FIXED_NOW = FIXED_NOW` per-test
//     with restore-over-delete in `finally`. Same D49 sentinel
//     used by checkpoint.test.ts / start-end.test.ts / M C
//     goldens.
//
//  6. **D68 path-split assertions use the canonical filenames
//     verbatim, NOT computed via path helpers.** This file is the
//     contract surface for those filenames; if rollback.ts ever
//     drifted from the `rollback-receipt.json` /
//     `rollback-dry-run-receipt.json` convention, these tests
//     would FAIL loudly. Importing the named helpers from the
//     source would defeat the lock.
//
//  7. **Schema-constant imports for manually-built fixture
//     receipts.** Tests 9 (D70 prior-apply receipt) and 24
//     (D70-reads-apply-path-only fake dry-run receipt) construct
//     ReceiptFile objects in-test. They use the imported
//     `RECEIPT_FILE_SCHEMA_VERSION` and `ROLLBACK_OUT_OF_SCOPE_NOTICE`
//     constants from @viberevert/session-format rather than
//     duplicating literal strings. This keeps the fixtures stable
//     across future schema version bumps.
//
//  8. **Platform-safe path constants.** `ROLLBACK_LOCK_REL` and
//     other path constants use `join(...)` rather than hardcoded
//     forward-slash strings so the values match what
//     `ConcurrentOperationError.lockDir` carries on the actual
//     platform (backslashes on Windows, slashes on POSIX).

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  type ActiveSessionLock,
  type Manifest,
  ManifestSchema,
  RECEIPT_FILE_SCHEMA_VERSION,
  type ReceiptFile,
  ReceiptFileSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EndCommand } from "../src/commands/end.js";
import { RollbackCommand } from "../src/commands/rollback.js";
import { StartCommand } from "../src/commands/start.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Fixture constants
// =============================================================================

// Crockford-base32 ULIDs — same pattern as start-end.test.ts.
const FIXED_NOW = "2026-01-01T00:00:00Z";
const FIXTURE_SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const FIXTURE_CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const FIXTURE_OTHER_CHECKPOINT_ID = "cp_01JV8XQ4H27ABCDEFGHJKMNPQR";
const FIXTURE_ROLLBACK_ID = "rb_01JV8Z0N6E7ABCDEFGHJKMNPQR";

const FIXTURE_HEAD_SHA = "a1b2c3d4e5f6789012345678901234567890abcd";
const FIXTURE_STARTED_AT = "2026-05-04T10:30:11Z";
const FIXTURE_ENDED_AT = "2026-05-04T10:35:11Z";

// D68 canonical filenames — locked here verbatim. See lock #6.
const DRY_RUN_RECEIPT_FILENAME = "rollback-dry-run-receipt.json";
const APPLY_RECEIPT_FILENAME = "rollback-receipt.json";

// Platform-safe lock path. Per lock #8, must use join() so the
// constant matches what err.lockDir carries on the actual platform
// (Windows: backslashes; POSIX: forward slashes).
const ROLLBACK_LOCK_REL = join(".viberevert", ".locks", "rollback.lock");

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cli-rollback-"));
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
  await rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
});

// =============================================================================
// Helpers (duplicated per lock #4 — see file header)
// =============================================================================

type RegisteredCommand = Parameters<Cli["register"]>[0];

/**
 * Duplicated verbatim from json-output.test.ts:207-246. Runs a
 * clipanion Command via an in-memory Cli, capturing stdout +
 * stderr to strings and returning the exit code.
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

const runRollback = (args: string[]) => runCommand(RollbackCommand, "rollback", args);
const runStart = (args: string[]) => runCommand(StartCommand, "start", args);
const runEnd = (args: string[]) => runCommand(EndCommand, "end", args);

/**
 * Write a minimal valid `.viberevert.yml`. Duplicated from
 * checkpoint.test.ts:105.
 */
async function writeMinimalConfig(): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
}

/**
 * Write a complete standalone checkpoint fixture. Duplicated
 * from json-output.test.ts:81-128. Patches/tarballs are empty
 * (suitable only for refusal-flow tests where restoreCheckpoint
 * never runs).
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

/**
 * Write a session+manifest fixture suitable for REFUSAL tests
 * (where restoreCheckpoint never runs). Inner checkpoint dir
 * `.viberevert/sessions/<id>/checkpoint/` gets a minimal valid
 * manifest.json + empty patch/tarball files. Session.json is
 * written with the legacy pre-M D session shape (no
 * `after_status_z_path` field, no `after-status.z` file). All
 * REFUSAL-suite tests fire a refusal BEFORE D76 would walk to
 * D61b, so the missing-snapshot branch is irrelevant here. For
 * tests that need real restore behavior, use `setupRealSession`
 * instead.
 */
async function writeSessionFixtureForRefusalTest(opts: {
  sessionId: string;
  checkpointId: string;
  startedAt: string;
  endedAt?: string;
  headSha?: string;
}): Promise<void> {
  const sessionDir = join(tmpRoot, ".viberevert", "sessions", opts.sessionId);
  const checkpointDir = join(sessionDir, "checkpoint");
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

  const headSha = opts.headSha ?? FIXTURE_HEAD_SHA;
  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    session_id: opts.sessionId,
    captured_at: opts.startedAt,
    git: { head_sha: headSha, branch: "main", porcelain_v1: "" },
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
    rollback_target_description: "Refusal-test fixture",
  };
  await writeFile(join(checkpointDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: opts.sessionId,
    checkpoint_id: opts.checkpointId,
    started_at: opts.startedAt,
    before_status_path: `.viberevert/sessions/${opts.sessionId}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${opts.sessionId}/commands.log`,
    ...(opts.endedAt !== undefined
      ? {
          ended_at: opts.endedAt,
          after_status_path: `.viberevert/sessions/${opts.sessionId}/after-status.txt`,
        }
      : {}),
  } as SessionState;
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState, null, 2));
  // Minimal audit files so loadSession sees a consistent shape.
  // Intentionally NO after-status.z — see writeSessionFixtureForRefusalTest
  // docstring + lock #3.
  await writeFile(join(sessionDir, "before-status.txt"), "");
  await writeFile(join(sessionDir, "commands.log"), "");
  if (opts.endedAt !== undefined) {
    await writeFile(join(sessionDir, "after-status.txt"), "");
  }
}

/**
 * Write an active-session lock at `.viberevert/active-session.json`.
 */
async function writeActiveLock(opts: {
  sessionId: string;
  checkpointId: string;
  startedAt: string;
  task?: string;
}): Promise<void> {
  await mkdir(join(tmpRoot, ".viberevert"), { recursive: true });
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

/**
 * Write a stale rollback lock dir + lock.json with valid LockInfo
 * shape. Triggers `ConcurrentOperationError` on the next
 * `viberevert rollback` invocation per D22's mkdir-atomicity model.
 */
async function writeStaleRollbackLock(opts: { command: string; startedAt: string }): Promise<void> {
  const lockDir = join(tmpRoot, ROLLBACK_LOCK_REL);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "lock.json"),
    JSON.stringify(
      {
        pid: 99999, // unlikely-to-collide PID; we never actually verify it's alive
        command: opts.command,
        started_at: opts.startedAt,
        host: "test-host",
      },
      null,
      2,
    ),
  );
}

/**
 * Set up a real ended session using the actual M B start+end flow.
 * Produces real checkpoint artifacts that restoreCheckpoint can replay.
 *
 * Returns the session id parsed from the start command's stdout via
 * a forgiving regex (first `sess_<ULID>` anywhere in output). The
 * regex won't false-positive on checkpoint IDs (those start with
 * `cp_`) or on rollback IDs (`rb_`).
 */
async function setupRealSession(opts: {
  task?: string;
  modifyAfterStart?: () => Promise<void>;
  fixedNow?: string;
}): Promise<{ sessionId: string }> {
  const fixedNow = opts.fixedNow ?? FIXED_NOW;
  const previousFixedNow = process.env[VIBEREVERT_TEST_FIXED_NOW];
  process.env[VIBEREVERT_TEST_FIXED_NOW] = fixedNow;
  try {
    await writeMinimalConfig();

    // Invoke real StartCommand. Forgiving regex (first sess_<ULID>
    // anywhere) is robust to small stdout wording changes.
    const startArgs = opts.task !== undefined ? ["--task", opts.task] : [];
    const startResult = await runStart(startArgs);
    if (startResult.exitCode !== 0) {
      throw new Error(
        `setupRealSession: viberevert start failed (exit ${startResult.exitCode}):\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`,
      );
    }
    const match = startResult.stdout.match(/sess_[0-9A-HJKMNP-TV-Z]{26}/);
    if (match === null) {
      throw new Error(
        `setupRealSession: could not parse session id from start stdout:\n${startResult.stdout}`,
      );
    }
    const sessionId = match[0];
    if (sessionId === undefined) {
      throw new Error("setupRealSession: match[0] undefined despite regex match");
    }

    if (opts.modifyAfterStart !== undefined) {
      await opts.modifyAfterStart();
    }

    const endResult = await runEnd([]);
    if (endResult.exitCode !== 0) {
      throw new Error(
        `setupRealSession: viberevert end failed (exit ${endResult.exitCode}):\nstdout: ${endResult.stdout}\nstderr: ${endResult.stderr}`,
      );
    }

    return { sessionId };
  } finally {
    if (previousFixedNow === undefined) {
      delete process.env[VIBEREVERT_TEST_FIXED_NOW];
    } else {
      process.env[VIBEREVERT_TEST_FIXED_NOW] = previousFixedNow;
    }
  }
}

/**
 * Corrupt a session's captured unstaged.patch with non-patch
 * bytes so that the next `git apply` attempt during
 * restoreCheckpoint will fail. Used by Suite G to verify the
 * apply-receipt-attempt semantics (Lock #16): an apply that
 * fails MID-restore must still persist an apply receipt with
 * populated failures[] and empty results[], and D70 must then
 * refuse re-application based on receipt existence.
 *
 * The patch path is derived from the checkpoint manifest's
 * `diffs.unstaged_patch_path` field — NOT hardcoded — so future
 * checkpoint-layout changes don't silently break the test.
 */
async function corruptCheckpointPatches(sessionId: string): Promise<void> {
  const checkpointDir = join(tmpRoot, ".viberevert", "sessions", sessionId, "checkpoint");
  const manifest = ManifestSchema.parse(
    JSON.parse(await readFile(join(checkpointDir, "manifest.json"), "utf8")),
  );
  const patchPath = join(checkpointDir, manifest.diffs.unstaged_patch_path);
  await writeFile(patchPath, "this is not a valid git patch and apply will fail\n");
}

/**
 * Path-helpers mirroring the named accessors in rollback.ts.
 * Defined here independently (per lock #6) to lock the D68
 * filenames as part of the test contract surface.
 */
function dryRunReceiptPathFor(sessionId: string): string {
  return join(tmpRoot, ".viberevert", "sessions", sessionId, DRY_RUN_RECEIPT_FILENAME);
}

function applyReceiptPathFor(sessionId: string): string {
  return join(tmpRoot, ".viberevert", "sessions", sessionId, APPLY_RECEIPT_FILENAME);
}

/**
 * Return true if a file exists at `path`, false on ENOENT,
 * re-throws on other errors.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

/**
 * Read + schema-parse a receipt file from disk.
 */
async function readReceipt(path: string): Promise<ReceiptFile> {
  const raw = await readFile(path, "utf8");
  return ReceiptFileSchema.parse(JSON.parse(raw));
}

// =============================================================================
// SUITE A: Pure-validation refusals (no fixture beyond config)
// =============================================================================

describe("rollback — pure-validation refusals (Suite A)", () => {
  it("--force without --apply: exits 1 with locked copy (A18)", async () => {
    await writeMinimalConfig();
    const result = await runRollback([FIXTURE_SESSION_ID, "--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--force has no effect without --apply");
    expect(result.stderr).toContain("--apply --force");
    expect(await fileExists(dryRunReceiptPathFor(FIXTURE_SESSION_ID))).toBe(false);
    expect(await fileExists(applyReceiptPathFor(FIXTURE_SESSION_ID))).toBe(false);
  });

  it("--json + --markdown: exits 1 with mutually-exclusive copy (A11)", async () => {
    await writeMinimalConfig();
    const result = await runRollback([FIXTURE_SESSION_ID, "--json", "--markdown"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--json and --markdown are mutually exclusive");
  });

  it("invalid session-id shape: exits 1 with format error", async () => {
    await writeMinimalConfig();
    const result = await runRollback(["not-a-session-id"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid session id");
    expect(result.stderr).toContain("Crockford ULID");
  });

  it("missing .viberevert.yml: exits 1 with init directive (D19)", async () => {
    // No writeMinimalConfig — let loadConfig throw ConfigNotFoundError.
    // Need to pre-create the session fixture so the failure happens
    // at loadConfig (inside the lock), not at session-load.
    await writeSessionFixtureForRefusalTest({
      sessionId: FIXTURE_SESSION_ID,
      checkpointId: FIXTURE_CHECKPOINT_ID,
      startedAt: FIXTURE_STARTED_AT,
      endedAt: FIXTURE_ENDED_AT,
    });
    const result = await runRollback([FIXTURE_SESSION_ID]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No .viberevert.yml found");
    expect(result.stderr).toContain("viberevert init");
  });
});

// =============================================================================
// SUITE B: Refusal-class tests (session+manifest fixture, no real patches)
// =============================================================================

describe("rollback — refusal-class with minimal fixture (Suite B)", () => {
  it("SessionNotFoundError: exits 1 with clean message", async () => {
    await writeMinimalConfig();
    // No session fixture written.
    const result = await runRollback([FIXTURE_SESSION_ID]);
    expect(result.exitCode).toBe(1);
    // SessionNotFoundError carries its own user-friendly message.
    expect(result.stderr.toLowerCase()).toContain("session");
    expect(result.stderr).toContain(FIXTURE_SESSION_ID);
  });

  it("CheckpointArtifactsMissingError: exits 1 when inner checkpoint dir absent", async () => {
    await writeMinimalConfig();
    // Write session.json + audit files BUT NOT the checkpoint dir.
    const sessionDir = join(tmpRoot, ".viberevert", "sessions", FIXTURE_SESSION_ID);
    await mkdir(sessionDir, { recursive: true });
    const sessionState: SessionState = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: FIXTURE_SESSION_ID,
      checkpoint_id: FIXTURE_CHECKPOINT_ID,
      started_at: FIXTURE_STARTED_AT,
      ended_at: FIXTURE_ENDED_AT,
      before_status_path: `.viberevert/sessions/${FIXTURE_SESSION_ID}/before-status.txt`,
      commands_log_path: `.viberevert/sessions/${FIXTURE_SESSION_ID}/commands.log`,
      after_status_path: `.viberevert/sessions/${FIXTURE_SESSION_ID}/after-status.txt`,
    } as SessionState;
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState));
    await writeFile(join(sessionDir, "before-status.txt"), "");
    await writeFile(join(sessionDir, "commands.log"), "");
    await writeFile(join(sessionDir, "after-status.txt"), "");

    const result = await runRollback([FIXTURE_SESSION_ID]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("checkpoint");
    expect(result.stderr).toContain(FIXTURE_SESSION_ID);
  });

  it("ApplyReceiptCorruptError: exits 1 with corrupt-receipt copy (lock #5 fail-closed)", async () => {
    await writeMinimalConfig();
    await writeSessionFixtureForRefusalTest({
      sessionId: FIXTURE_SESSION_ID,
      checkpointId: FIXTURE_CHECKPOINT_ID,
      startedAt: FIXTURE_STARTED_AT,
      endedAt: FIXTURE_ENDED_AT,
    });
    // Write garbage at the apply receipt path. Per lock #5, the CLI
    // must fail closed rather than treat it as "no existing receipt."
    await writeFile(applyReceiptPathFor(FIXTURE_SESSION_ID), "{this is not a valid receipt");

    const result = await runRollback([FIXTURE_SESSION_ID, "--apply"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Apply receipt at");
    expect(result.stderr).toContain("unusable for D70 idempotency check");
  });

  it("D63 active-session: --apply on active session refused (A5a)", async () => {
    await writeMinimalConfig();
    await writeSessionFixtureForRefusalTest({
      sessionId: FIXTURE_SESSION_ID,
      checkpointId: FIXTURE_CHECKPOINT_ID,
      startedAt: FIXTURE_STARTED_AT,
      // NO endedAt — session is active.
    });
    await writeActiveLock({
      sessionId: FIXTURE_SESSION_ID,
      checkpointId: FIXTURE_CHECKPOINT_ID,
      startedAt: FIXTURE_STARTED_AT,
    });
    const result = await runRollback([FIXTURE_SESSION_ID, "--apply"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(FIXTURE_SESSION_ID);
    expect(result.stderr).toContain("still active");
    expect(result.stderr).toContain("viberevert end");
    // No apply receipt written on refusal.
    expect(await fileExists(applyReceiptPathFor(FIXTURE_SESSION_ID))).toBe(false);
  });

  it("D70 already-applied: --apply with prior apply receipt refused (A7)", async () => {
    await writeMinimalConfig();
    await writeSessionFixtureForRefusalTest({
      sessionId: FIXTURE_SESSION_ID,
      checkpointId: FIXTURE_CHECKPOINT_ID,
      startedAt: FIXTURE_STARTED_AT,
      endedAt: FIXTURE_ENDED_AT,
    });
    // Pre-write a valid apply receipt. Uses imported schema constants
    // per lock #7 so the fixture stays stable across schema bumps.
    const priorReceipt: ReceiptFile = ReceiptFileSchema.parse({
      schema_version: RECEIPT_FILE_SCHEMA_VERSION,
      rollback_id: FIXTURE_ROLLBACK_ID,
      session_id: FIXTURE_SESSION_ID,
      checkpoint_id: FIXTURE_CHECKPOINT_ID,
      mode: "apply",
      forced: false,
      written_at: "2026-01-02T00:00:00Z",
      pre_rollback_checkpoint_id: FIXTURE_OTHER_CHECKPOINT_ID,
      results: [],
      failures: [],
      forced_unrelated_dirty_paths: [],
      dirty_tree_check: "performed",
      out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
    });
    await writeFile(applyReceiptPathFor(FIXTURE_SESSION_ID), JSON.stringify(priorReceipt, null, 2));

    const result = await runRollback([FIXTURE_SESSION_ID, "--apply"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already been rolled back");
    expect(result.stderr).toContain(FIXTURE_OTHER_CHECKPOINT_ID);
  });
});

// =============================================================================
// SUITE C: D75 force-policy + D61b coverage (real M B fixture)
// =============================================================================

describe("rollback — D75 force-policy + D61b (Suite C)", () => {
  it("D61 dirty-tree: --apply refused without --force (A3)", async () => {
    const { sessionId } = await setupRealSession({
      task: "C-test-dirty-refuse",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "session-edit.txt"), "session change\n");
      },
    });
    // Introduce unrelated dirty state AFTER end.
    await writeFile(join(tmpRoot, "unrelated.txt"), "unrelated content\n");

    const result = await runRollback([sessionId, "--apply"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unrelated dirty");
    expect(result.stderr).toContain("unrelated.txt");
    // No apply receipt written on refusal.
    expect(await fileExists(applyReceiptPathFor(sessionId))).toBe(false);
  });

  it("D61 dirty-tree: --apply --force proceeds, receipt records forced_unrelated_dirty_paths (A4)", async () => {
    const { sessionId } = await setupRealSession({
      task: "C-test-dirty-force",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "session-edit.txt"), "session change\n");
      },
    });
    await writeFile(join(tmpRoot, "unrelated.txt"), "unrelated content\n");

    const result = await runRollback([sessionId, "--apply", "--force"]);
    expect(result.exitCode).toBe(0);
    const receipt = await readReceipt(applyReceiptPathFor(sessionId));
    expect(receipt.forced).toBe(true);
    expect(receipt.forced_unrelated_dirty_paths).toContain("unrelated.txt");
  });

  it("D64 HEAD-mismatch: --apply refused without --force (A6a)", async () => {
    const { sessionId } = await setupRealSession({
      task: "C-test-head-mismatch-refuse",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "session-edit.txt"), "session change\n");
      },
    });
    // Advance HEAD between end and rollback (empty commit, tree unchanged).
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
        "advance-head",
      ],
      { cwd: tmpRoot },
    );

    const result = await runRollback([sessionId, "--apply"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HEAD");
    expect(await fileExists(applyReceiptPathFor(sessionId))).toBe(false);
  });

  it("D64 HEAD-mismatch: --apply --force succeeds (tree unchanged across empty commit) (A6b)", async () => {
    const { sessionId } = await setupRealSession({
      task: "C-test-head-mismatch-force",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "session-edit.txt"), "session change\n");
      },
    });
    // Advance HEAD with --allow-empty: HEAD sha differs from manifest's
    // captured sha, but the tree at the new HEAD is IDENTICAL to the
    // tree at the captured HEAD. With --force propagating
    // allowHeadMismatch into restoreCheckpoint, the restore proceeds
    // and all verification passes (the tree comparison is content-based,
    // not sha-based).
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
        "advance-head",
      ],
      { cwd: tmpRoot },
    );

    const result = await runRollback([sessionId, "--apply", "--force"]);
    expect(result.exitCode).toBe(0);
    const receipt = await readReceipt(applyReceiptPathFor(sessionId));
    expect(receipt.forced).toBe(true);
    expect(receipt.mode).toBe("apply");
    expect(receipt.pre_rollback_checkpoint_id).not.toBeNull();
    expect(receipt.failures).toEqual([]);
  });

  it("D61b un-ended-session: --apply --force proceeds, receipt fields coupled (A8)", async () => {
    const { sessionId } = await setupRealSession({
      task: "C-test-un-ended",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "session-edit.txt"), "session change\n");
      },
    });
    // Simulate "un-ended" by deleting the after-status.z snapshot that
    // M D added. The orchestration's loadEndOfSessionChangedPaths
    // returns { kind: "missing" } when the file is absent, which
    // triggers D61b's un-ended-session branch.
    const afterStatusZPath = join(tmpRoot, ".viberevert", "sessions", sessionId, "after-status.z");
    await rm(afterStatusZPath, { force: true });

    const result = await runRollback([sessionId, "--apply", "--force"]);
    expect(result.exitCode).toBe(0);
    const receipt = await readReceipt(applyReceiptPathFor(sessionId));
    expect(receipt.un_ended_session_warning).toBe(true);
    expect(receipt.dirty_tree_check).toBe("skipped_no_after_state");
    expect(receipt.forced).toBe(true);
  });
});

// =============================================================================
// SUITE D: Real apply happy path (real M B fixture)
// =============================================================================

describe("rollback — real apply happy path (Suite D)", () => {
  it("dry-run on clean ended session: receipt at dry-run path, tree unchanged, no apply receipt, no emergency CP (A1)", async () => {
    const { sessionId } = await setupRealSession({
      task: "D-dry-run-clean",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "session-edit.txt"), "session change\n");
      },
    });
    // Capture working-tree state pre-rollback.
    const preContent = await readFile(join(tmpRoot, "session-edit.txt"), "utf8");

    const result = await runRollback([sessionId]);
    expect(result.exitCode).toBe(0);

    const dryRunReceipt = await readReceipt(dryRunReceiptPathFor(sessionId));
    expect(dryRunReceipt.mode).toBe("dry_run");
    expect(dryRunReceipt.pre_rollback_checkpoint_id).toBeNull();

    // Working tree unchanged.
    const postContent = await readFile(join(tmpRoot, "session-edit.txt"), "utf8");
    expect(postContent).toBe(preContent);

    // NO apply receipt created.
    expect(await fileExists(applyReceiptPathFor(sessionId))).toBe(false);

    // Dry-run must NOT create any emergency checkpoint (lock #3 / L7).
    // The session's INNER checkpoint lives at
    // .viberevert/sessions/<id>/checkpoint/, NOT at
    // .viberevert/checkpoints/, so any cp_<ULID> directory under
    // .viberevert/checkpoints/ would be a leaked D65 emergency
    // checkpoint — must be empty.
    const checkpointsDir = join(tmpRoot, ".viberevert", "checkpoints");
    if (await fileExists(checkpointsDir)) {
      const entries = await readdir(checkpointsDir);
      expect(entries.filter((e) => /^cp_[0-9A-HJKMNP-TV-Z]{26}$/.test(e))).toEqual([]);
    }
  });

  it("apply on clean ended session: apply receipt with non-null pre_rollback_checkpoint_id, tree restored, emergency CP exists (A2)", async () => {
    const { sessionId } = await setupRealSession({
      task: "D-apply-clean",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "session-edit.txt"), "session change\n");
      },
    });

    const result = await runRollback([sessionId, "--apply"]);
    expect(result.exitCode).toBe(0);

    const receipt = await readReceipt(applyReceiptPathFor(sessionId));
    expect(receipt.mode).toBe("apply");
    expect(receipt.pre_rollback_checkpoint_id).not.toBeNull();
    expect(receipt.dirty_tree_check).toBe("performed");

    // Working tree restored: session-edit.txt should be removed
    // (it was untracked-and-added during the session).
    expect(await fileExists(join(tmpRoot, "session-edit.txt"))).toBe(false);

    // Emergency checkpoint dir exists.
    const preCpId = receipt.pre_rollback_checkpoint_id;
    expect(preCpId).not.toBeNull();
    if (preCpId !== null) {
      const emergencyDir = join(tmpRoot, ".viberevert", "checkpoints", preCpId);
      expect(await fileExists(emergencyDir)).toBe(true);
      const emergencyManifest = ManifestSchema.parse(
        JSON.parse(await readFile(join(emergencyDir, "manifest.json"), "utf8")),
      );
      expect(emergencyManifest.name).toMatch(/^pre-rollback-sess_/);
    }
  });

  it("active-session dry-run: exit 0 with active_session_warning in receipt (A5b)", async () => {
    await writeMinimalConfig();
    await writeSessionFixtureForRefusalTest({
      sessionId: FIXTURE_SESSION_ID,
      checkpointId: FIXTURE_CHECKPOINT_ID,
      startedAt: FIXTURE_STARTED_AT,
      // NO endedAt — session is active. Dry-run on un-ended fires
      // BOTH active_session_warning AND un_ended_session_warning
      // (the locked corner case from Step 2 schema tests).
    });
    await writeActiveLock({
      sessionId: FIXTURE_SESSION_ID,
      checkpointId: FIXTURE_CHECKPOINT_ID,
      startedAt: FIXTURE_STARTED_AT,
    });

    const result = await runRollback([FIXTURE_SESSION_ID]);
    expect(result.exitCode).toBe(0);
    const receipt = await readReceipt(dryRunReceiptPathFor(FIXTURE_SESSION_ID));
    expect(receipt.active_session_warning).toBe(true);
    expect(receipt.mode).toBe("dry_run");
  });
});

// =============================================================================
// SUITE E: Format flags (Lock #12)
// =============================================================================

describe("rollback — format flags (Suite E)", () => {
  it("--json outputs JSON.parse-able JSON (catches [object Object] regression)", async () => {
    const { sessionId } = await setupRealSession({
      task: "E-json",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "edit.txt"), "x\n");
      },
    });
    const result = await runRollback([sessionId, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("[object Object]");
    // Must parse cleanly as JSON.
    const parsed = JSON.parse(result.stdout) as { mode?: unknown };
    expect(parsed.mode).toBe("dry_run");
  });

  it("--markdown outputs CommonMark with rollback receipt heading", async () => {
    const { sessionId } = await setupRealSession({
      task: "E-markdown",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "edit.txt"), "x\n");
      },
    });
    const result = await runRollback([sessionId, "--markdown"]);
    expect(result.exitCode).toBe(0);
    // Markdown receipt heading (per Step 5 receipt-markdown.ts).
    expect(result.stdout).toMatch(/^#{1,3} .*Rollback.*Receipt/im);
  });

  it("default (no format flag) outputs terminal string containing rollback id prefix", async () => {
    const { sessionId } = await setupRealSession({
      task: "E-terminal",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "edit.txt"), "x\n");
      },
    });
    const result = await runRollback([sessionId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    // Loose check: rollback id prefix appears. The full ULID-format
    // assertion lives in json-output.test.ts (D20 machine-output
    // contract); this test just locks "terminal renderer emits the
    // rollback id field" without re-asserting the formatting.
    expect(result.stdout).toContain("rb_");
  });
});

// =============================================================================
// SUITE F: D68 path-split discipline (named-helper lock)
// =============================================================================

describe("rollback — D68 path-split (Suite F)", () => {
  it("dry-run writes ONLY rollback-dry-run-receipt.json (apply path absent)", async () => {
    const { sessionId } = await setupRealSession({
      task: "F-dry-run-only",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "x.txt"), "x\n");
      },
    });
    const result = await runRollback([sessionId]);
    expect(result.exitCode).toBe(0);
    expect(await fileExists(dryRunReceiptPathFor(sessionId))).toBe(true);
    expect(await fileExists(applyReceiptPathFor(sessionId))).toBe(false);
  });

  it("apply writes rollback-receipt.json AND preserves any prior dry-run receipt byte-identically", async () => {
    const { sessionId } = await setupRealSession({
      task: "F-apply-preserves-dryrun",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "x.txt"), "x\n");
      },
    });
    // First, dry-run to create the dry-run receipt.
    const dryResult = await runRollback([sessionId]);
    expect(dryResult.exitCode).toBe(0);
    const dryRunBytesBefore = await readFile(dryRunReceiptPathFor(sessionId), "utf8");

    // Now apply.
    const applyResult = await runRollback([sessionId, "--apply"]);
    expect(applyResult.exitCode).toBe(0);

    // Apply receipt exists.
    expect(await fileExists(applyReceiptPathFor(sessionId))).toBe(true);
    // Dry-run receipt still exists AND is byte-identical to its
    // pre-apply state.
    expect(await fileExists(dryRunReceiptPathFor(sessionId))).toBe(true);
    const dryRunBytesAfter = await readFile(dryRunReceiptPathFor(sessionId), "utf8");
    expect(dryRunBytesAfter).toBe(dryRunBytesBefore);
  });

  it("dry-run after successful apply: apply receipt unchanged, dry-run receipt overwritten freely", async () => {
    const { sessionId } = await setupRealSession({
      task: "F-dryrun-after-apply",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "x.txt"), "x\n");
      },
    });
    const applyResult = await runRollback([sessionId, "--apply"]);
    expect(applyResult.exitCode).toBe(0);
    const applyBytesBefore = await readFile(applyReceiptPathFor(sessionId), "utf8");

    // Run dry-run after apply.
    const dryResult = await runRollback([sessionId]);
    expect(dryResult.exitCode).toBe(0);

    // Apply receipt unchanged byte-for-byte.
    const applyBytesAfter = await readFile(applyReceiptPathFor(sessionId), "utf8");
    expect(applyBytesAfter).toBe(applyBytesBefore);

    // Dry-run receipt was written (overwriting any prior dry-run).
    expect(await fileExists(dryRunReceiptPathFor(sessionId))).toBe(true);
  });

  it("D70 reads apply path ONLY (foreign dry-run receipt at dry-run path doesn't trigger D70)", async () => {
    const { sessionId } = await setupRealSession({
      task: "F-d70-apply-path-only",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "x.txt"), "x\n");
      },
    });
    // Write a syntactically-valid dry-run receipt at the dry-run path.
    // D70 must NOT read this — only the apply path. Uses imported
    // schema constants per lock #7.
    const fakeDryRun: ReceiptFile = ReceiptFileSchema.parse({
      schema_version: RECEIPT_FILE_SCHEMA_VERSION,
      rollback_id: FIXTURE_ROLLBACK_ID,
      session_id: sessionId,
      checkpoint_id: FIXTURE_CHECKPOINT_ID,
      mode: "dry_run",
      forced: false,
      written_at: "2026-01-02T00:00:00Z",
      pre_rollback_checkpoint_id: null,
      results: [],
      failures: [],
      forced_unrelated_dirty_paths: [],
      dirty_tree_check: "performed",
      out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
    });
    await writeFile(dryRunReceiptPathFor(sessionId), JSON.stringify(fakeDryRun, null, 2));

    // Apply should proceed because the apply path is empty.
    const result = await runRollback([sessionId, "--apply"]);
    expect(result.exitCode).toBe(0);
    expect(await fileExists(applyReceiptPathFor(sessionId))).toBe(true);
  });
});

// =============================================================================
// SUITE G: Apply receipt = ATTEMPT semantics (Lock #16)
// =============================================================================
//
// All three tests in this suite follow the same fixture pattern:
//   1. Pre-stage: create + commit tracked.txt at v0 BEFORE setupRealSession.
//      This advances HEAD ONCE; HEAD stays stable during the session.
//   2. Dirty tracked.txt to v1 BEFORE setupRealSession. The session
//      captures this v0->v1 modification as the unstaged patch.
//   3. setupRealSession with modifyAfterStart that changes v1 → v2
//      (further dirty during session; no commits).
//   4. corruptCheckpointPatches: overwrite the captured unstaged.patch
//      so restoreCheckpoint fails when it tries to apply.
//   5. Run rollback --apply: passes D64 (HEAD didn't move), reaches D65
//      emergency CP creation, then fails inside restoreCheckpoint at
//      patch-apply time.

describe("rollback — apply receipt = ATTEMPT semantics (Suite G)", () => {
  /**
   * Suite-G common pre-stage: create + commit tracked.txt v0 (HEAD
   * advances once), dirty to v1, then return so the caller can set
   * up the rest of the session via setupRealSession.
   */
  async function suiteGPreStage(): Promise<void> {
    await writeFile(join(tmpRoot, "tracked.txt"), "v0\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: tmpRoot });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test.test",
        "commit",
        "-q",
        "-m",
        "add tracked v0",
      ],
      { cwd: tmpRoot },
    );
    // Dirty to v1 — captured by setupRealSession's start as the
    // unstaged-patch contents.
    await writeFile(join(tmpRoot, "tracked.txt"), "v1\n");
  }

  it("apply with corrupted unstaged.patch: exit 1, receipt persisted with failures, results empty, emergency CP exists", async () => {
    await suiteGPreStage();
    const { sessionId } = await setupRealSession({
      task: "G-apply-fail",
      modifyAfterStart: async () => {
        // Further session modification: v1 → v2. NO commits — HEAD
        // stays at the pre-session commit so D64 doesn't fire.
        await writeFile(join(tmpRoot, "tracked.txt"), "v2\n");
      },
    });
    // Corrupt the captured patch (manifest-derived path).
    await corruptCheckpointPatches(sessionId);

    const result = await runRollback([sessionId, "--apply"]);
    expect(result.exitCode).toBe(1);

    // PER LOCK #16: receipt MUST exist even on failure.
    expect(await fileExists(applyReceiptPathFor(sessionId))).toBe(true);
    const receipt = await readReceipt(applyReceiptPathFor(sessionId));
    expect(receipt.mode).toBe("apply");
    expect(receipt.failures.length).toBeGreaterThan(0);
    expect(receipt.results).toEqual([]);
    expect(receipt.pre_rollback_checkpoint_id).not.toBeNull();

    // Emergency CP exists (it was created BEFORE the failing restore).
    const preCpId = receipt.pre_rollback_checkpoint_id;
    if (preCpId !== null) {
      expect(await fileExists(join(tmpRoot, ".viberevert", "checkpoints", preCpId))).toBe(true);
    }
  });

  it("after failed apply attempt: --apply rerun fires D70 refusal (lock #16: existence triggers D70)", async () => {
    await suiteGPreStage();
    const { sessionId } = await setupRealSession({
      task: "G-d70-after-failed-apply",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "tracked.txt"), "v2\n");
      },
    });
    await corruptCheckpointPatches(sessionId);

    // First apply: fails but writes receipt.
    const first = await runRollback([sessionId, "--apply"]);
    expect(first.exitCode).toBe(1);
    expect(await fileExists(applyReceiptPathFor(sessionId))).toBe(true);

    // Second apply: D70 refusal (receipt EXISTS regardless of its failure content).
    const second = await runRollback([sessionId, "--apply"]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("already been rolled back");
  });

  it("after failed apply attempt: dry-run rerun proceeds (dry-run not blocked by D70)", async () => {
    await suiteGPreStage();
    const { sessionId } = await setupRealSession({
      task: "G-dryrun-after-failed-apply",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "tracked.txt"), "v2\n");
      },
    });
    await corruptCheckpointPatches(sessionId);

    const first = await runRollback([sessionId, "--apply"]);
    expect(first.exitCode).toBe(1);

    // Dry-run rerun: should succeed (dry-run is informational and
    // not blocked by D70 per Step 6 lock).
    const dryResult = await runRollback([sessionId]);
    expect(dryResult.exitCode).toBe(0);
    expect(await fileExists(dryRunReceiptPathFor(sessionId))).toBe(true);
  });
});

// =============================================================================
// SUITE H: Lock contention + D5b emergency-CP name suffix
// =============================================================================

describe("rollback — lock + D5b (Suite H)", () => {
  it("A10 deterministic rollback-lock contention via stale lock fixture", async () => {
    await writeMinimalConfig();
    await writeSessionFixtureForRefusalTest({
      sessionId: FIXTURE_SESSION_ID,
      checkpointId: FIXTURE_CHECKPOINT_ID,
      startedAt: FIXTURE_STARTED_AT,
      endedAt: FIXTURE_ENDED_AT,
    });
    // Pre-create the rollback lock dir with valid LockInfo. The
    // next rollback invocation's mkdir(lockDir, { recursive: false })
    // will EEXIST and surface as ConcurrentOperationError.
    await writeStaleRollbackLock({
      command: "viberevert rollback (simulated holder)",
      startedAt: "2026-01-01T00:00:00Z",
    });

    const result = await runRollback([FIXTURE_SESSION_ID]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Another viberevert operation is already running");
    expect(result.stderr).toContain(ROLLBACK_LOCK_REL);

    // No mutation: neither receipt path was written, no emergency CP.
    expect(await fileExists(dryRunReceiptPathFor(FIXTURE_SESSION_ID))).toBe(false);
    expect(await fileExists(applyReceiptPathFor(FIXTURE_SESSION_ID))).toBe(false);
    // Checkpoints dir either doesn't exist OR contains zero emergency CPs.
    const checkpointsDir = join(tmpRoot, ".viberevert", "checkpoints");
    if (await fileExists(checkpointsDir)) {
      const entries = await readdir(checkpointsDir);
      expect(entries.filter((e) => /^cp_[0-9A-HJKMNP-TV-Z]{26}$/.test(e))).toEqual([]);
    }
  });

  it("D5b emergency CP name collision: suffix-counter produces pre-rollback-<truncated>-2", async () => {
    const { sessionId } = await setupRealSession({
      task: "H-d5b-suffix",
      modifyAfterStart: async () => {
        await writeFile(join(tmpRoot, "edit.txt"), "x\n");
      },
    });

    // Compute the expected truncated session id from the ACTUAL session
    // id that setupRealSession produced (it's a fresh ULID per-test;
    // we can't use FIXTURE_SESSION_ID here because it's a different id).
    // The truncation rule must match rollback.ts's
    // truncateSessionIdForCheckpointName (locked at 5 + 14 = 19 chars).
    const truncatedSessionId = sessionId.slice(0, "sess_".length + 14);
    const collisionName = `pre-rollback-${truncatedSessionId}`;
    const expectedSuffixedName = `${collisionName}-2`;

    // Pre-create a standalone checkpoint with the collision name. Use
    // a distinct ULID for the pre-seeded checkpoint so it doesn't
    // collide with the session's inner checkpoint dir.
    const SEEDED_COLLISION_CP_ID = "cp_01JV8Z0N6E7CFGHJKMNPQRSTVW";
    await writeCheckpointFixture({
      checkpointId: SEEDED_COLLISION_CP_ID,
      name: collisionName,
      capturedAt: FIXED_NOW,
      headSha: FIXTURE_HEAD_SHA,
    });

    const result = await runRollback([sessionId, "--apply"]);
    expect(result.exitCode).toBe(0);

    const receipt = await readReceipt(applyReceiptPathFor(sessionId));
    const preCpId = receipt.pre_rollback_checkpoint_id;
    expect(preCpId).not.toBeNull();
    if (preCpId === null) return;

    // The emergency CP that rollback just created should have the
    // suffixed name (NOT the bare base name, which the pre-seeded
    // fixture occupies).
    const emergencyManifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(
          join(tmpRoot, ".viberevert", "checkpoints", preCpId, "manifest.json"),
          "utf8",
        ),
      ),
    );
    expect(emergencyManifest.name).toBe(expectedSuffixedName);

    // The pre-seeded collision should still exist with its original name.
    const seededManifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(
          join(tmpRoot, ".viberevert", "checkpoints", SEEDED_COLLISION_CP_ID, "manifest.json"),
          "utf8",
        ),
      ),
    );
    expect(seededManifest.name).toBe(collisionName);
    expect(preCpId).not.toBe(SEEDED_COLLISION_CP_ID);
  });
});
