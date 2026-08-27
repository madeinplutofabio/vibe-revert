// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Operation-layer tests for startSessionOperation. Focused on contract
// specifics that distinguish the operation boundary from the Command
// boundary:
//
//   1. Typed result shape (StartSessionOperationResult).
//   2. D99.M.21 cwd-binding — operation uses opts.cwd, never
//      process.cwd().
//   3. Typed errors thrown (caller-observable without stderr scraping).
//   4. D22 lock-metadata command label — both the CLI default and the
//      MCP override are observed at the lock boundary via a mocked
//      withExclusiveLock, proving the resolved command is actually
//      passed through (not silently dropped).
//   5. M 0.8.0 step 5 — the session-start evaluation snapshot resolved from
//      `.viberevert.yml` and persisted into session.json. Asserted end to
//      end (real config file, real checkpoint, real core.startSession)
//      rather than at a mock boundary, so the whole producer chain is
//      covered: mergeChecksConfig defaults, auto-detection actually being
//      wired in, the explicit/auto framework predicate, normalizeStringArray
//      canonicalization, and the deliberately un-normalized verify_commands
//      sequence.
//
// CLI-level coverage (stderr copy, exit codes, harness wiring) stays in
// start-end.test.ts as drift-detection layer 1 — that file MUST continue
// to pass against the refactored StartCommand.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RepoRootNotFoundError, SessionAlreadyActiveError } from "@viberevert/core";
import {
  type ActiveSessionLock,
  type EvaluationSnapshot,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionState,
  SessionStateSchema,
} from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LockInfo } from "../../src/locks.js";
import {
  type StartSessionOperationResult,
  startSessionOperation,
} from "../../src/operations/start-session.js";

const execFileAsync = promisify(execFile);

const PRE_EXISTING_SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const PRE_EXISTING_CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const PRE_EXISTING_STARTED_AT = "2026-05-04T10:30:11Z";

let tmpRoot: string;
let originalCwd: string;

/**
 * Create a real git repo + minimal `.viberevert.yml` + `.gitignore`.
 * Operations are config-required (D19) so .viberevert.yml is mandatory.
 * NO `process.chdir` here — operations use opts.cwd, not process.cwd().
 * (The afterEach DOES restore the original cwd, which is set by the
 * cwd-binding test to confirm the operation isolates correctly.)
 */
async function setupRepo(): Promise<void> {
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
  // Minimal valid .viberevert.yml — empty body is rejected by
  // ConfigSchema, so we provide the smallest passing shape.
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\nchecks:\n  secrets: true\n");
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-startop-"));
  originalCwd = process.cwd();
  await setupRepo();
});

afterEach(async () => {
  // Restore cwd (the cwd-binding test changes it; restoring before rm
  // avoids Windows file-lock issues per the existing CLI test pattern).
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("startSessionOperation — typed result shape", () => {
  it("returns {sessionId, checkpointId, startedAt} with valid ULID prefixes and writes matching active-session.json", async () => {
    const result: StartSessionOperationResult = await startSessionOperation({
      cwd: tmpRoot,
    });

    // Typed shape assertions.
    expect(result.sessionId).toMatch(/^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.checkpointId).toMatch(/^cp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // On-disk: active-session.json reflects the same ids/timestamp.
    const lockJson = JSON.parse(
      await readFile(join(tmpRoot, ".viberevert", "active-session.json"), "utf8"),
    ) as ActiveSessionLock;
    expect(lockJson.session_id).toBe(result.sessionId);
    expect(lockJson.checkpoint_id).toBe(result.checkpointId);
    expect(lockJson.started_at).toBe(result.startedAt);

    // session.json on disk parses cleanly via the canonical schema.
    const sessionStateJson = JSON.parse(
      await readFile(
        join(tmpRoot, ".viberevert", "sessions", result.sessionId, "session.json"),
        "utf8",
      ),
    ) as unknown;
    const parsed: SessionState = SessionStateSchema.parse(sessionStateJson);
    expect(parsed.schema_version).toBe(SESSION_STATE_SCHEMA_VERSION);
    expect(parsed.session_id).toBe(result.sessionId);
  });
});

describe("startSessionOperation — D99.M.21 cwd binding (critical operation-contract boundary)", () => {
  it("uses opts.cwd, NOT process.cwd(): session is created at opts.cwd even when process.cwd() points elsewhere", async () => {
    // Chdir to a totally unrelated directory. If the operation reads
    // process.cwd() (bug), it would try to resolve a repo from there
    // and either fail or create the session in the wrong place.
    const unrelatedDir = await mkdtemp(join(tmpdir(), "viberevert-startop-unrelated-"));
    try {
      process.chdir(unrelatedDir);

      const result = await startSessionOperation({ cwd: tmpRoot });

      // Session artifact MUST exist under tmpRoot (the opts.cwd repo).
      const sessionDir = join(tmpRoot, ".viberevert", "sessions", result.sessionId);
      await expect(readFile(join(sessionDir, "session.json"), "utf8")).resolves.toContain(
        result.sessionId,
      );

      // And MUST NOT exist under unrelatedDir.
      await expect(
        readFile(join(unrelatedDir, ".viberevert", "active-session.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      // Restore before tmpRoot cleanup so afterEach's rm doesn't fail
      // (Windows file locks). The afterEach also restores originalCwd
      // to be doubly sure.
      process.chdir(originalCwd);
      await rm(unrelatedDir, { recursive: true, force: true });
    }
  });
});

describe("startSessionOperation — typed errors", () => {
  it("throws RepoRootNotFoundError when opts.cwd is not a git/viberevert project", async () => {
    const nonRepoDir = await mkdtemp(join(tmpdir(), "viberevert-startop-norepo-"));
    try {
      await expect(startSessionOperation({ cwd: nonRepoDir })).rejects.toBeInstanceOf(
        RepoRootNotFoundError,
      );
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true });
    }
  });

  it("throws SessionAlreadyActiveError carrying the active lock data when a session already exists", async () => {
    // Manually plant an active session.
    const sessionDir = join(tmpRoot, ".viberevert", "sessions", PRE_EXISTING_SESSION_ID);
    await mkdir(join(sessionDir, "checkpoint"), { recursive: true });
    const sessionState: SessionState = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: PRE_EXISTING_SESSION_ID,
      checkpoint_id: PRE_EXISTING_CHECKPOINT_ID,
      started_at: PRE_EXISTING_STARTED_AT,
      before_status_path: `.viberevert/sessions/${PRE_EXISTING_SESSION_ID}/before-status.txt`,
      commands_log_path: `.viberevert/sessions/${PRE_EXISTING_SESSION_ID}/commands.log`,
    };
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState));
    await writeFile(join(sessionDir, "before-status.txt"), "");
    await writeFile(join(sessionDir, "commands.log"), "");
    const activeLock: ActiveSessionLock = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: PRE_EXISTING_SESSION_ID,
      checkpoint_id: PRE_EXISTING_CHECKPOINT_ID,
      started_at: PRE_EXISTING_STARTED_AT,
    };
    await writeFile(
      join(tmpRoot, ".viberevert", "active-session.json"),
      JSON.stringify(activeLock),
    );

    try {
      await startSessionOperation({ cwd: tmpRoot });
      expect.fail("expected SessionAlreadyActiveError");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionAlreadyActiveError);
      // Critical for D11 refusal copy: the error carries the active
      // lock so the Command (and the MCP handler) can render the
      // pre-existing session's id/started_at/etc.
      expect((err as SessionAlreadyActiveError).active.session_id).toBe(PRE_EXISTING_SESSION_ID);
      expect((err as SessionAlreadyActiveError).active.checkpoint_id).toBe(
        PRE_EXISTING_CHECKPOINT_ID,
      );
      expect((err as SessionAlreadyActiveError).active.started_at).toBe(PRE_EXISTING_STARTED_AT);
    }
  });
});

describe("startSessionOperation — D22 lock metadata (mocked locks boundary)", () => {
  // Mock only the lock boundary so the operation still runs its real
  // domain flow while the test can observe the D22 lock metadata
  // without a timing race.

  /**
   * Helper that vi-mocks `../../src/locks.js`, dynamically re-imports
   * the operation so it sees the mock, runs it once with the supplied
   * opts, and returns the captured LockInfo. Guarantees mock cleanup
   * via try/finally so a failed assertion can't poison sibling tests.
   */
  async function captureLockInfoOnce(
    opts: Parameters<typeof startSessionOperation>[0],
  ): Promise<LockInfo> {
    vi.resetModules();
    const capturedLockInfos: LockInfo[] = [];
    vi.doMock("../../src/locks.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/locks.js")>();
      return {
        ...actual,
        withExclusiveLock: async <T>(
          _lockDir: string,
          lockInfo: LockInfo,
          protectedFlow: () => Promise<T>,
        ): Promise<T> => {
          capturedLockInfos.push(lockInfo);
          return protectedFlow();
        },
      };
    });
    try {
      const { startSessionOperation: startSessionOperationWithMockedLock } = await import(
        "../../src/operations/start-session.js"
      );
      await startSessionOperationWithMockedLock(opts);
      expect(capturedLockInfos).toHaveLength(1);
      return capturedLockInfos[0] as LockInfo;
    } finally {
      vi.doUnmock("../../src/locks.js");
      vi.resetModules();
    }
  }

  it("uses the default CLI literal when neither lockCommand nor task is supplied", async () => {
    const info = await captureLockInfoOnce({ cwd: tmpRoot });
    expect(info.command).toBe("viberevert start");
  });

  it("uses the JSON-stringified --task literal when task is supplied without lockCommand", async () => {
    const info = await captureLockInfoOnce({ cwd: tmpRoot, task: "fix auth flow" });
    expect(info.command).toBe('viberevert start --task "fix auth flow"');
  });

  it("uses the lockCommand override when supplied (MCP path), ignoring task entirely for label purposes", async () => {
    const info = await captureLockInfoOnce({
      cwd: tmpRoot,
      task: "fix auth flow",
      lockCommand: "viberevert mcp start_session",
    });
    expect(info.command).toBe("viberevert mcp start_session");
  });
});

// =============================================================================
// M 0.8.0 step 5: session-start evaluation snapshot
// =============================================================================

/** Overwrite the repo's `.viberevert.yml` before starting a session. */
async function writeConfigYaml(yaml: string): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), yaml);
}

/**
 * Start a session and return the snapshot actually persisted in session.json.
 *
 * Throws rather than returning undefined: `evaluation_snapshot` is optional on
 * the READ side only so pre-0.8.0 sessions stay parseable, and a session this
 * harness just created must carry one. Failing here names the problem instead
 * of surfacing it as an `undefined` mismatch inside an unrelated assertion.
 */
async function startAndReadSnapshot(): Promise<EvaluationSnapshot> {
  const result = await startSessionOperation({ cwd: tmpRoot });
  const parsed = SessionStateSchema.parse(
    JSON.parse(
      await readFile(
        join(tmpRoot, ".viberevert", "sessions", result.sessionId, "session.json"),
        "utf8",
      ),
    ),
  );
  if (parsed.evaluation_snapshot === undefined) {
    throw new Error("expected the freshly started session.json to carry an evaluation_snapshot");
  }
  return parsed.evaluation_snapshot;
}

describe("startSessionOperation — evaluation snapshot (M 0.8.0 step 5)", () => {
  it("resolves D57 omission defaults for a minimal config", async () => {
    await writeConfigYaml("version: 1\n");

    const snapshot = await startAndReadSnapshot();

    // Defaults come from mergeChecksConfig, the sole home of DEFAULT_* per D57.
    expect(snapshot.risk_block_on).toBe("critical");
    expect(snapshot.risk_warn_on).toBe("medium");
    expect(snapshot.checks).toEqual({
      secrets: true,
      dependencies: true,
      migrations: true,
      auth: true,
      payments: true,
      infra: true,
      tests: true,
      scope_expansion: true,
    });
    // Mode only. Whether detection is actually WIRED IN is a separate
    // question, owned by the next test: an empty result here is equally
    // consistent with a detector that ran and a producer that never called one.
    expect(snapshot.frameworks.mode).toBe("auto");
    expect(snapshot.rollback_exclude).toEqual([]);
    expect(snapshot.verify_commands).toEqual([]);
  });

  it("wires auto-detection into the persisted snapshot", async () => {
    await writeConfigYaml("version: 1\n");
    // The smallest signature the detector's own suite establishes
    // (packages/core/test/framework-detect.test.ts): `.lovable` as a
    // DIRECTORY, a single-path isDirectory rule.
    await mkdir(join(tmpRoot, ".lovable"));

    const snapshot = await startAndReadSnapshot();

    // Discriminating in the way a bare-repo assertion cannot be: a producer
    // that hardcoded `{ mode: "auto", detected_at_start: [] }` without ever
    // calling the detector passes the previous test and fails this one. This
    // is the only place step 5 proves the detector reaches the persisted
    // snapshot; whether the RULE is correct belongs to framework-detect.
    expect(snapshot.frameworks).toEqual({ mode: "auto", detected_at_start: ["lovable"] });
  });

  it("records explicit config overrides rather than defaults", async () => {
    await writeConfigYaml(
      [
        "version: 1",
        "risk:",
        "  block_on: high",
        "  warn_on: low",
        "checks:",
        "  payments: false",
        "  scope_expansion: false",
        "",
      ].join("\n"),
    );

    const snapshot = await startAndReadSnapshot();

    expect(snapshot.risk_block_on).toBe("high");
    expect(snapshot.risk_warn_on).toBe("low");
    // Overridden keys take the configured value; every omitted key still
    // resolves to its default, so the snapshot stays a COMPLETE resolved view
    // rather than a sparse echo of what the user happened to write.
    expect(snapshot.checks.payments).toBe(false);
    expect(snapshot.checks.scope_expansion).toBe(false);
    expect(snapshot.checks.secrets).toBe(true);
    expect(snapshot.checks.migrations).toBe(true);
  });

  it("a non-empty frameworks list is EXPLICIT, authoritative and normalized", async () => {
    await writeConfigYaml(["version: 1", "frameworks:", "  - node", "  - laravel", ""].join("\n"));

    const snapshot = await startAndReadSnapshot();

    // Discriminating: the fixture repo has no framework signatures, so an
    // implementation that re-detected instead of honouring the configured list
    // would produce an empty list here.
    expect(snapshot.frameworks).toEqual({ mode: "explicit", values: ["laravel", "node"] });
  });

  it("an EMPTY frameworks list means auto-detect, not explicit-empty", async () => {
    await writeConfigYaml("version: 1\nframeworks: []\n");

    const snapshot = await startAndReadSnapshot();

    // The predicate must match mergeChecksConfig's, which treats omitted OR
    // empty as auto. Recording this as `explicit` with an empty list would
    // freeze an empty set and silently disable every framework rule for the
    // session's whole life. Both payloads would contain [] in this fixture, so
    // `mode` is the discriminator that pins the omitted-or-empty => auto
    // contract.
    expect(snapshot.frameworks.mode).toBe("auto");
  });

  it("normalizes rollback_exclude: trimmed, deduped, sorted", async () => {
    await writeConfigYaml(
      [
        "version: 1",
        "rollback:",
        "  exclude:",
        '    - "vendor/**"',
        '    - " node_modules/** "',
        '    - "vendor/**"',
        "",
      ].join("\n"),
    );

    const snapshot = await startAndReadSnapshot();

    // Same producer as manifest.untracked.exclude_patterns, which is what makes
    // the two persisted policies directly comparable later.
    expect(snapshot.rollback_exclude).toEqual(["node_modules/**", "vendor/**"]);
  });

  it("preserves verify_commands order and duplicates, sorting and deduping neither", async () => {
    await writeConfigYaml(
      [
        "version: 1",
        "verify:",
        "  commands:",
        "    - command: pnpm",
        "      args:",
        "        - typecheck",
        "    - command: make",
        "      args: []",
        "    - command: pnpm",
        "      args:",
        "        - typecheck",
        "",
      ].join("\n"),
    );

    const snapshot = await startAndReadSnapshot();

    // A SEQUENCE: sorting would put `make` first and deduping would drop the
    // third entry, so this fixture fails under either normalization.
    expect(snapshot.verify_commands).toEqual([
      { command: "pnpm", args: ["typecheck"] },
      { command: "make", args: [] },
      { command: "pnpm", args: ["typecheck"] },
    ]);
  });
});
