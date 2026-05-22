// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration tests for the `viberevert checkpoint` command.
//
// Tests use a REAL git repo (git init + initial empty commit) and
// REAL createCheckpoint (no mocking of git internals) — exercising
// the full integration path. Each test takes ~50-100ms; total suite
// stays under a second.
//
// Helpers (writeCheckpointFixture, runCommand, RegisteredCommand)
// are intentionally duplicated from listing.test.ts and
// json-output.test.ts. Each test file stays self-contained — matches
// the M A pattern (init.test.ts is also self-contained). A future
// post-M B cleanup pass could extract to packages/cli/test/_helpers.ts;
// for M B, the duplication tax is accepted to keep substep scope tight.
//
// What this file deliberately does NOT cover:
//   - No-repo-root refusal (RepoRootNotFoundError) — fragile across
//     dev machines, same reasoning as start-end.test.ts.
//   - ConcurrentOperationError refusal — already covered by
//     locks.test.ts at the helper level; reproducing here would
//     add noise without strengthening the contract.
//   - Corrupt-checkpoint surfacing during the collision scan —
//     similar mechanism to listing.test.ts test 3; marginal extra
//     coverage.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { type Manifest, ManifestSchema, SCHEMA_VERSION } from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointCommand } from "../src/commands/checkpoint.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

const execFileAsync = promisify(execFile);

// Crockford-base32 ULID for a fixture checkpoint used in the
// collision test. 26-char body. Matches the patterns from
// listing.test.ts and json-output.test.ts.
const FIXTURE_CHECKPOINT_ID = "cp_01JV8XQ4H27ABCDEFGHJKMNPQR";
const FIXTURE_SHA = "a1b2c3d4e5f6789012345678901234567890abcd";

/**
 * D49 fixture-determinism sentinel. Same shape and same value as
 * start-end.test.ts's FIXED_NOW (and the M C golden-fixture
 * harness's locked sentinel from Step 10). Tests that need to prove
 * `VIBEREVERT_TEST_FIXED_NOW` affects persisted timestamps set
 * `process.env.VIBEREVERT_TEST_FIXED_NOW = FIXED_NOW` per-test
 * (with restore-over-delete in `finally`) and assert exact equality
 * on the resulting persisted manifests.
 */
const FIXED_NOW = "2026-01-01T00:00:00Z";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-cli-checkpoint-"));
  originalCwd = process.cwd();
  // Real git repo with at least one commit (createCheckpoint's
  // getHeadSha requires HEAD to point somewhere).
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
  // These tests bypass `viberevert init`, so we manually set up the
  // `.gitignore` state init would have created. Keeps `git status` clean
  // when checkpoint writes land under `.viberevert/`.
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
 * Write a minimal valid `.viberevert.yml` to tmpRoot. Only `version: 1`
 * is required by ConfigSchema; all other fields are optional. This
 * minimal config produces an empty `rollback.exclude` list.
 */
async function writeMinimalConfig(): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
}

/**
 * Write a `.viberevert.yml` with deliberately invalid YAML syntax —
 * triggers `ConfigParseError` from `loadConfig`.
 */
async function writeInvalidYamlConfig(): Promise<void> {
  // Stream of mappings starting at the same line is parser-illegal in
  // strict YAML 1.2 (block-mapping rules).
  await writeFile(
    join(tmpRoot, ".viberevert.yml"),
    "version: 1\n  - this is not\n  - valid yaml structure\nbroken:\n",
  );
}

/**
 * Write a complete fixture checkpoint dir at the given id. Used to
 * pre-populate the checkpoint collision test. Same shape as the
 * fixtures in listing.test.ts.
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
 * After running the checkpoint command, find the single created
 * checkpoint dir under `.viberevert/checkpoints/` (excluding fixtures
 * if present), parse its manifest, and return both. Throws if the
 * count is not exactly what's expected.
 */
async function findCreatedCheckpointExcluding(
  excludeIds: readonly string[],
): Promise<{ id: string; manifest: Manifest }> {
  const dir = join(tmpRoot, ".viberevert", "checkpoints");
  const entries = await readdir(dir);
  const matches = entries
    .filter((e) => /^cp_[0-9A-HJKMNP-TV-Z]{26}$/.test(e))
    .filter((e) => !excludeIds.includes(e));
  if (matches.length !== 1) {
    throw new Error(
      `test bug: expected exactly 1 newly-created checkpoint dir, found ${matches.length}: ${matches.join(", ")}`,
    );
  }
  const id = matches[0];
  if (id === undefined) {
    throw new Error("test bug: matches[0] undefined despite length check");
  }
  const manifest = ManifestSchema.parse(
    JSON.parse(await readFile(join(dir, id, "manifest.json"), "utf8")),
  );
  return { id, manifest };
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

const runCheckpoint = (args: string[]) => runCommand(CheckpointCommand, "checkpoint", args);

// =============================================================================
// Tests
// =============================================================================

describe("checkpoint command", () => {
  it("happy path nameless: creates standalone checkpoint, exit 0, no name in manifest", async () => {
    await writeMinimalConfig();

    const result = await runCheckpoint([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Checkpoint created.");
    expect(result.stdout).toMatch(/ID: cp_[0-9A-HJKMNP-TV-Z]{26}/);
    // No "Name:" line for nameless checkpoint
    expect(result.stdout).not.toContain("Name:");

    const { id, manifest } = await findCreatedCheckpointExcluding([]);
    // D6 standalone invariant: dir id == manifest.session_id
    expect(manifest.session_id).toBe(id);
    expect(manifest.name).toBeUndefined();

    // No leftover .tmp-checkpoint-* directory (cleanup-on-success
    // happens via the rename, not via explicit cleanup; this verifies
    // the rename completed).
    const dir = join(tmpRoot, ".viberevert", "checkpoints");
    const entries = await readdir(dir);
    const tmpEntries = entries.filter((e) => e.startsWith(".tmp-"));
    expect(tmpEntries).toEqual([]);
  });

  it("happy path with --name: stores name in manifest, prints name in success summary", async () => {
    await writeMinimalConfig();

    const result = await runCheckpoint(["--name", "release-ready"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Checkpoint created.");
    expect(result.stdout).toContain("Name: release-ready");

    const { id, manifest } = await findCreatedCheckpointExcluding([]);
    expect(manifest.session_id).toBe(id);
    expect(manifest.name).toBe("release-ready");
  });

  it("refuses with exit 1 when .viberevert.yml is missing (D19)", async () => {
    // Don't writeMinimalConfig — let loadConfig throw ConfigNotFoundError.
    const result = await runCheckpoint([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No .viberevert.yml found in this repo.");
    expect(result.stderr).toContain("viberevert init");
    // No checkpoint should have been created
    const dir = join(tmpRoot, ".viberevert", "checkpoints");
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("refuses with exit 1 when .viberevert.yml is invalid YAML (D19)", async () => {
    await writeInvalidYamlConfig();

    const result = await runCheckpoint([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid .viberevert.yml:");
    expect(result.stderr).toContain("viberevert init");
  });

  it("refuses with exit 1 when --name collides with an existing checkpoint name (D5b)", async () => {
    await writeMinimalConfig();
    // Pre-populate with a checkpoint named "release-ready"
    await writeCheckpointFixture({
      checkpointId: FIXTURE_CHECKPOINT_ID,
      name: "release-ready",
      capturedAt: "2026-05-04T08:00:00Z",
      headSha: FIXTURE_SHA,
    });

    const result = await runCheckpoint(["--name", "release-ready"]);
    expect(result.exitCode).toBe(1);
    // D5b locked refusal copy
    expect(result.stderr).toContain("Checkpoint name already exists: release-ready");
    expect(result.stderr).toContain("Use a different name, or list existing checkpoints with:");
    expect(result.stderr).toContain("viberevert checkpoints");

    // No new checkpoint created — the only entry should still be the fixture.
    const dir = join(tmpRoot, ".viberevert", "checkpoints");
    const entries = await readdir(dir);
    const cpEntries = entries.filter((e) => /^cp_[0-9A-HJKMNP-TV-Z]{26}$/.test(e));
    expect(cpEntries).toEqual([FIXTURE_CHECKPOINT_ID]);
  });

  it("refuses with exit 1 when --name is whitespace-only (defensive validation)", async () => {
    // Don't even need a valid config — the --name validation runs
    // BEFORE loadConfig, so this exits cleanly without depending on
    // any other state.
    const result = await runCheckpoint(["--name", "   "]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--name must not be empty or whitespace-only");
  });

  it("VIBEREVERT_TEST_FIXED_NOW overrides manifest.captured_at deterministically (D49 precondition)", async () => {
    await writeMinimalConfig();

    // Per-test scoped env mutation with restore-over-delete in
    // finally — same pattern as start-end.test.ts. Safe even when a
    // parent process already pinned the env var.
    const previous = process.env[VIBEREVERT_TEST_FIXED_NOW];
    process.env[VIBEREVERT_TEST_FIXED_NOW] = FIXED_NOW;
    try {
      // Use --name so the D22 lock path is exercised (checkpoint.ts
      // only acquires the lock when --name is set). The lock dir is
      // created+removed during execution, so this integration test
      // does not inspect its transient lock.json. The persisted
      // manifest assertion below proves the command-scoped `now`
      // value reached createCheckpoint({ capturedAt: now }); source
      // review/typecheck covers the parallel lockInfo.started_at
      // wiring.
      const result = await runCheckpoint(["--name", "fixed-clock"]);
      expect(result.exitCode).toBe(0);

      // The just-created checkpoint is the only one under
      // .viberevert/checkpoints/ (no fixtures in this test). Read
      // back its manifest and assert captured_at equals the fixed
      // sentinel BYTE-FOR-BYTE.
      //
      // Parsed via ManifestSchema (NOT a minimal cast) so the test
      // doubles as a schema-validity check on the just-written
      // manifest — catches regressions where the CLI threading
      // `capturedAt: now` could (in some future bug) produce a
      // manifest broken in OTHER fields entirely. Symmetric with
      // start-end.test.ts's manifest assertion.
      const { id, manifest } = await findCreatedCheckpointExcluding([]);
      expect(manifest.captured_at).toBe(FIXED_NOW);
      expect(manifest.name).toBe("fixed-clock");
      expect(manifest.session_id).toBe(id); // D6 standalone invariant
      // Bonus: rollback_target_description embeds capturedAt per
      // git/src/checkpoint.ts line 291. Asserting it caught the
      // value flowed through both manifest slots — same defense as
      // git/test/checkpoint.test.ts test 1.
      expect(manifest.rollback_target_description).toContain(FIXED_NOW);
    } finally {
      if (previous === undefined) {
        delete process.env[VIBEREVERT_TEST_FIXED_NOW];
      } else {
        process.env[VIBEREVERT_TEST_FIXED_NOW] = previous;
      }
    }
  });
});
