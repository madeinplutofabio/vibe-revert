// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration tests for the `viberevert check` Clipanion command in
// `packages/cli/src/commands/check.ts`. Spawns CheckCommand through
// Clipanion's Cli with captured stdout/stderr streams (same harness
// pattern as start-end.test.ts).
//
// Tests are user-visible-behavior-only: exit code, persisted file
// paths + parsed shape, stdout/stderr stable substrings, --json
// schema validity. Resolver-internal branches are NOT re-tested here
// (covered exhaustively in check-since-resolution.test.ts).
//
// Eight sections, 27 tests total:
//   1. Exit codes (D24): no-changes / non-blocker / blocker             3 tests
//   2. --threshold semantics (D38)                                       3 tests
//   3. Output modes (--json shape + render-vs-persist parity)            2 tests
//   4. Persistence dispatch on base.kind (D26)                           2 tests
//   5. Input flag validation (--threshold, --task)                       2 tests
//   6. Config error surfacing                                            2 tests
//   7. Config-source authority (M 0.8.0 step 8)                          7 tests
//   8. Contribution-backed ended sessions (M 0.8.0 step 8 B3)            6 tests
//
// Fixtures (locked):
//   - Non-blocker: stage `.github/workflows/test.yml` → triggers
//     path-classifier.generic.gh-actions at `high` (NOT critical),
//     under default risk.block_on=critical → exit 0.
//   - Blocker: stage `notes.txt` containing a runtime-constructed
//     Stripe live-key-shaped secret → triggers secrets.regex at
//     `critical` → exit 2. The token is constructed via template-
//     literal interpolation so the source bytes never contain the
//     contiguous provider live-key prefix that GitHub Push Protection
//     scans for. Same pattern packages/checks/test/detectors/secrets.test.ts
//     uses for its fixtures.
//   - --staged is used for all diff-driven fixtures so each test is
//     isolated to a clean staged-changes-only base (no HEAD~1
//     dependency, no second-commit setup).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";

import { ensureViberevertDirs, generateSessionId, putObject } from "@viberevert/core";
import { createCheckpoint } from "@viberevert/git";
import {
  type ActiveSessionLock,
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  deriveChangeGroupId,
  type EvaluationSnapshot,
  ReportFileSchema,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionContributionEntry,
  type SessionContributionFile,
  type SessionState,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckCommand } from "../../src/commands/check.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Module-level state (beforeEach/afterEach pattern, mirrors start-end.test.ts)
// =============================================================================

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  // mkdtemp creates the parent dir; tmpRoot is the repo subdir so afterEach
  // can cleanly `rm` the whole parent (avoids leaving stray test dirs).
  const tmpParent = await mkdtemp(join(tmpdir(), "viberevert-check-cmd-test-"));
  tmpRoot = join(tmpParent, "repo");
  originalCwd = process.cwd();
  await mkdir(tmpRoot, { recursive: true });
  await runGit(tmpRoot, ["init", "-q", "-b", "main"]);
  await runGit(tmpRoot, ["config", "user.email", "test@test.test"]);
  await runGit(tmpRoot, ["config", "user.name", "Test"]);
  await runGit(tmpRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(tmpRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(tmpRoot, "README.md"), "# test\n");
  await runGit(tmpRoot, ["add", "."]);
  await runGit(tmpRoot, ["commit", "-q", "-m", "initial"]);
  await ensureViberevertDirs(tmpRoot);
  // Default valid config — tests that need the config missing (T13)
  // remove the file; tests that need it broken (T14) overwrite it.
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
  // chdir so CheckCommand's resolveRepoRoot() walks up to find tmpRoot.
  process.chdir(tmpRoot);
});

afterEach(async () => {
  // Restore CWD BEFORE cleanup so Windows file-lock semantics don't
  // block the rm (mirrors start-end.test.ts and init.test.ts).
  process.chdir(originalCwd);
  await rm(dirname(tmpRoot), { recursive: true, force: true });
});

// =============================================================================
// Helpers (duplicated inline per the "don't extract until 3rd consumer" rule)
// =============================================================================

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], {
    cwd,
    windowsHide: true,
  });
  return String(stdout);
}

/**
 * Run `viberevert check ${args}` via a Clipanion `Cli` instance with
 * captured stdout/stderr/stdin streams. Same harness pattern as
 * start-end.test.ts's `runEnd`. Returns the exit code + captured
 * stream content as joined strings.
 */
async function runCheck(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(CheckCommand);

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

  const exitCode = await cli.run(["check", ...args], {
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

/**
 * Stage a `notes.txt` containing a runtime-constructed Stripe
 * live-key-shaped token. The secrets.regex detector emits a
 * `critical` finding on the matched pattern → exit 2.
 *
 * The token is built via template-literal interpolation so the
 * source bytes never contain the contiguous provider live-key prefix
 * that GitHub Push Protection scans for. Runtime concatenation
 * defeats the scanner without changing detector semantics — same
 * pattern packages/checks/test/detectors/secrets.test.ts uses for
 * its fixtures.
 */
async function stageBlockerFixture(repoRoot: string): Promise<void> {
  const token = `sk${"_live_"}TESTFIXTUREONLY1234567890ABCDEF`;
  await writeFile(join(repoRoot, "notes.txt"), `${token}\n`);
  await runGit(repoRoot, ["add", "notes.txt"]);
}

/**
 * Stage `.github/workflows/test.yml` with innocuous YAML content.
 * Triggers exactly one finding: path-classifier.generic.gh-actions
 * at `high` in category `deployment`. The rule has NO
 * testSiblingPatterns (so no test-gap finding), the YAML content has
 * no secret-shaped values (so no secrets finding), and the file is
 * neither a lockfile/manifest nor a migration. Result under default
 * risk.block_on=critical: exit 0.
 */
async function stageNonBlockerFixture(repoRoot: string): Promise<void> {
  const workflowsDir = join(repoRoot, ".github", "workflows");
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(join(workflowsDir, "test.yml"), "name: test\non: push\n");
  await runGit(repoRoot, ["add", ".github"]);
}

/**
 * Materialize a session at `.viberevert/sessions/<sess_<ULID>>/` with:
 *   - inner checkpoint at `<sess>/checkpoint/` (real manifest via
 *     createCheckpoint — the resolver loads it via loadCheckpoint)
 *   - session.json + before-status.txt + commands.log via direct
 *     schema-typed writes (same pattern as start-end.test.ts's
 *     setupActiveSession)
 *   - optional active-session.json lock at .viberevert/ root
 *
 * Duplicated from check-since-resolution.test.ts per the locked
 * "don't extract until 3rd consumer" rule.
 */
async function makeSession(
  repoRoot: string,
  opts: {
    task?: string;
    markAsActive?: boolean;
    evaluationSnapshot?: EvaluationSnapshot;
    /**
     * Terminal state (M 0.8.0 step 8 B3). `ended_at` and `after_status_path`
     * are both-or-neither by schema refine, so `after-status.txt` is written
     * whenever this is supplied. `after_status_z_path` stays absent: it is
     * optional and nothing here reads it.
     *
     * `entries` is a FACTORY because `change_group_id` derives from the
     * session id and the contribution header must carry the session's real
     * ids -- only makeSession knows those. The caller supplies the interesting
     * payload; makeSession owns artifact identity and the digest binding.
     */
    ended?: {
      endedAt: string;
      contribution?: {
        entries: (sessionId: string) => Promise<readonly SessionContributionEntry[]>;
        detectedFrameworksAtEnd?: readonly string[];
      };
    };
  } = {},
): Promise<{ sessionId: string; checkpointId: string }> {
  const sessionId = generateSessionId();
  const sessionDir = join(repoRoot, ".viberevert", "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const innerCheckpointDir = join(sessionDir, "checkpoint");
  const ckptResult = await createCheckpoint({
    repoRoot,
    checkpointDir: innerCheckpointDir,
    rollbackExcludePatterns: [],
  });
  const checkpointId = ckptResult.checkpointId;
  const startedAt = "2026-01-01T00:00:00Z";

  // Terminal fields, built BEFORE the session state so the contribution's
  // bytes exist and its digest is known when session.json is written. That
  // mirrors the shipped publication order: the artifact lands before the
  // session.json that names it.
  let endedFields: Partial<SessionState> = {};
  if (opts.ended !== undefined) {
    await writeFile(join(sessionDir, "after-status.txt"), "");
    endedFields = {
      ended_at: opts.ended.endedAt,
      after_status_path: `.viberevert/sessions/${sessionId}/after-status.txt`,
    };
    if (opts.ended.contribution !== undefined) {
      const entries = await opts.ended.contribution.entries(sessionId);
      const contribution: SessionContributionFile = {
        schema_version: CONTRIBUTION_FILE_SCHEMA_VERSION,
        session_id: sessionId,
        checkpoint_id: checkpointId,
        before_head_sha: "0".repeat(40),
        after_head_sha: "1".repeat(40),
        captured_at: startedAt,
        ended_at: opts.ended.endedAt,
        ...(opts.ended.contribution.detectedFrameworksAtEnd !== undefined
          ? {
              detected_frameworks_at_end: [
                ...opts.ended.contribution.detectedFrameworksAtEnd,
              ].sort(),
            }
          : {}),
        entries: [...entries],
      };
      // Serialize ONCE and hash THOSE bytes. The binding is to the exact
      // persisted bytes, never a re-serialization (architectural lock #8), so
      // the digest must come from the very buffer that gets written.
      const bytes = Buffer.from(JSON.stringify(contribution, null, 2), "utf8");
      await writeFile(join(sessionDir, "contribution.json"), bytes);
      endedFields = {
        ...endedFields,
        contribution_path: `.viberevert/sessions/${sessionId}/contribution.json`,
        contribution_sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
  }

  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: sessionId,
    checkpoint_id: checkpointId,
    started_at: startedAt,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    before_status_path: `.viberevert/sessions/${sessionId}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${sessionId}/commands.log`,
    // Conditional spread, not `evaluation_snapshot: opts.evaluationSnapshot`:
    // under exactOptionalPropertyTypes an explicit `undefined` is NOT the
    // same as an absent key, and a pre-0.8.0 session must have the key
    // structurally ABSENT. That absence is exactly what selects the legacy
    // live-config path in resolveChecksConfigForBase.
    ...(opts.evaluationSnapshot !== undefined
      ? { evaluation_snapshot: opts.evaluationSnapshot }
      : {}),
    ...endedFields,
  };
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionState, null, 2));
  await writeFile(join(sessionDir, "before-status.txt"), "");
  await writeFile(join(sessionDir, "commands.log"), "");
  if (opts.markAsActive === true) {
    const lock: ActiveSessionLock = {
      schema_version: SESSION_STATE_SCHEMA_VERSION,
      session_id: sessionId,
      checkpoint_id: checkpointId,
      started_at: startedAt,
      ...(opts.task !== undefined ? { task: opts.task } : {}),
    };
    await writeFile(
      join(repoRoot, ".viberevert", "active-session.json"),
      JSON.stringify(lock, null, 2),
    );
  }
  return { sessionId, checkpointId };
}

/**
 * After an ad-hoc check run, find the (unique) `rpt_<ULID>` dir under
 * `.viberevert/reports/` and return the absolute path to its
 * `report.json`. Asserts that exactly ONE such dir exists — a
 * collision or stale-dir would surface here as a loud test failure
 * rather than a silent wrong-path read.
 */
async function findAdHocReportPath(repoRoot: string): Promise<string> {
  const reportsDir = join(repoRoot, ".viberevert", "reports");
  const entries = await readdir(reportsDir);
  const rptDirs = entries.filter((n) => /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/.test(n));
  const [first] = rptDirs;
  if (rptDirs.length !== 1 || first === undefined) {
    throw new Error(
      `expected exactly 1 rpt_<ULID> dir under .viberevert/reports/, got ${rptDirs.length}: ${rptDirs.join(", ")}`,
    );
  }
  return join(reportsDir, first, "report.json");
}

// =============================================================================
// Tests
// =============================================================================

/**
 * The only path-classifier rule matching `app/Http/Middleware/**`, and it is
 * framework-gated on `laravel`. Shared by sections 7 and 8, which both use its
 * presence or absence to observe which framework set the engine received.
 */
const LARAVEL_MIDDLEWARE_ID = "path-classifier.laravel.middleware";

/**
 * A resolved snapshot with every check ENABLED, parameterized on the one field
 * that is not a straight copy in resolveChecksConfigForBase.
 *
 * Module-scoped rather than per-section: duplicating the complete
 * checks-toggle map would mean a future ChecksToggleKey addition had to be
 * fixed in two places, and one of them would be missed.
 */
function makeSnapshot(frameworks: EvaluationSnapshot["frameworks"]): EvaluationSnapshot {
  return {
    risk_block_on: "critical",
    risk_warn_on: "medium",
    checks: {
      secrets: true,
      dependencies: true,
      migrations: true,
      auth: true,
      payments: true,
      infra: true,
      tests: true,
      scope_expansion: true,
    },
    frameworks,
    rollback_exclude: [],
    verify_commands: [],
  };
}

describe("viberevert check", () => {
  // ---------------------------------------------------------------------------
  // Section 1 — Exit codes (D24)
  // ---------------------------------------------------------------------------

  describe("Section 1 — exit codes (D24)", () => {
    it("no staged changes → exit 0", async () => {
      const result = await runCheck(["--staged"]);
      expect(result.exitCode).toBe(0);
    });

    it("non-blocker fixture (high finding, below default block_on=critical) → exit 0", async () => {
      await stageNonBlockerFixture(tmpRoot);
      const result = await runCheck(["--staged"]);
      expect(result.exitCode).toBe(0);
    });

    it("blocker fixture (critical finding from secrets.regex) → exit 2", async () => {
      await stageBlockerFixture(tmpRoot);
      const result = await runCheck(["--staged"]);
      expect(result.exitCode).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Section 2 — --threshold semantics (D38)
  // ---------------------------------------------------------------------------

  describe("Section 2 — --threshold semantics (D38)", () => {
    it("--threshold low does NOT lower the gate (blocker still exits 2; rule id appears in stdout)", async () => {
      await stageBlockerFixture(tmpRoot);
      const result = await runCheck(["--staged", "--threshold", "low"]);
      // Gate uses resolved.riskBlockOn (default: critical), NOT
      // --threshold. The critical finding from secrets.regex still
      // triggers exit 2 regardless of the --threshold value.
      expect(result.exitCode).toBe(2);
      // Under --threshold low, the renderer shows everything — the
      // critical secret finding's fixture-path must appear in stdout.
      // (The terminal renderer surfaces file paths but NOT rule ids —
      // rule ids appear only in JSON output. The locked fixture path
      // `notes.txt` is just as durable as a rule id for this assertion.)
      expect(result.stdout).toContain("notes.txt");
    });

    it("--threshold critical filters stdout but NOT persistence (non-blocker)", async () => {
      await stageNonBlockerFixture(tmpRoot);
      const result = await runCheck(["--staged", "--threshold", "critical"]);
      // Exit 0: gate sees no findings at-or-above critical
      // (the path-classifier finding is at `high`).
      expect(result.exitCode).toBe(0);
      // stdout filtered: the high-level finding is BELOW the critical
      // threshold so it does NOT appear in the rendered Findings
      // section. We assert on the locked "Findings (N)" count rather
      // than excluding the file path — the renderer's Changed Files
      // section is the diff inventory and shows ALL changed paths
      // regardless of --threshold (D38 lock: changed_files is never
      // filtered). So .not.toContain on the file path would
      // false-fail. "Findings (0)" is positive evidence that no
      // finding made it through the threshold filter.
      expect(result.stdout).toContain("Findings (0)");
      // Persistence is NEVER filtered by --threshold (D38 lock —
      // --threshold is OUTPUT-ONLY). The persisted report.json must
      // contain the full unfiltered findings set.
      const reportPath = await findAdHocReportPath(tmpRoot);
      const persisted = ReportFileSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
      const ruleIds = persisted.report.results.map((r) => r.id);
      expect(ruleIds).toContain("path-classifier.generic.gh-actions");
    });

    it("--json default has NO threshold filter (non-blocker rendered in JSON output)", async () => {
      await stageNonBlockerFixture(tmpRoot);
      const result = await runCheck(["--staged", "--json"]);
      expect(result.exitCode).toBe(0);
      // Per D38: --json default threshold is undefined (no filter), so
      // the high-level non-blocker finding appears in the rendered
      // JSON's results array — even though terminal mode's default
      // threshold (resolved.riskWarnOn=medium) would also have shown
      // it; the lock under test is that --json defaults to NO filter.
      const parsed = JSON.parse(result.stdout) as unknown;
      const file = ReportFileSchema.parse(parsed);
      const ruleIds = file.report.results.map((r) => r.id);
      expect(ruleIds).toContain("path-classifier.generic.gh-actions");
    });
  });

  // ---------------------------------------------------------------------------
  // Section 3 — Output modes
  // ---------------------------------------------------------------------------

  describe("Section 3 — output modes", () => {
    it("--json output is parseable and validates against ReportFileSchema", async () => {
      await stageBlockerFixture(tmpRoot);
      const result = await runCheck(["--staged", "--json"]);
      expect(result.exitCode).toBe(2);
      // The parse + schema-validation round-trip catches any drift in
      // the rendered JSON's shape (missing fields, wrong key order
      // breaking JSON.stringify-determinism, schema-invalid values, etc.).
      const parsed = JSON.parse(result.stdout) as unknown;
      const file = ReportFileSchema.parse(parsed);
      expect(file.kind).toBe("ad_hoc"); // --staged is always ad-hoc per D39
      // Sanity: the critical finding made it into the rendered JSON.
      expect(file.report.results.length).toBeGreaterThan(0);
    });

    it("--json output deep-equals the persisted report.json (no drift)", async () => {
      await stageBlockerFixture(tmpRoot);
      const result = await runCheck(["--staged", "--json"]);
      expect(result.exitCode).toBe(2);
      // Under --json without --threshold, the renderer returns the
      // ReportFile verbatim (D45) — should byte-equal the persisted
      // file after both go through JSON.stringify→parse normalization.
      // Any future renderer transformation (re-keying, field
      // additions, threshold leakage, etc.) would be caught here.
      const stdoutValue = JSON.parse(result.stdout) as unknown;
      const reportPath = await findAdHocReportPath(tmpRoot);
      const persistedValue = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
      expect(stdoutValue).toEqual(persistedValue);
    });
  });

  // ---------------------------------------------------------------------------
  // Section 4 — Persistence dispatch on base.kind (D26)
  // ---------------------------------------------------------------------------

  describe("Section 4 — persistence dispatch (D26)", () => {
    it("session-bound base → report.json at .viberevert/sessions/<sess>/report.json with kind=session_bound", async () => {
      const { sessionId } = await makeSession(tmpRoot, { markAsActive: true });
      // No --since flag → resolver picks up the active session per
      // D26 case (e). No changes since session creation, so the diff
      // is empty and we expect exit 0; the persistence path is what
      // we're testing.
      const result = await runCheck([]);
      expect(result.exitCode).toBe(0);
      const expectedPath = join(tmpRoot, ".viberevert", "sessions", sessionId, "report.json");
      const file = ReportFileSchema.parse(JSON.parse(await readFile(expectedPath, "utf8")));
      expect(file.kind).toBe("session_bound");
      expect(file.report_id).toBe(sessionId); // D31 identity rule
    });

    it("ad-hoc base → report.json at .viberevert/reports/<rpt_<ULID>>/report.json with kind=ad_hoc", async () => {
      // --staged forces ad-hoc per D39 even when an active session
      // would otherwise be picked up. Stage a non-blocker fixture so
      // exit 0 keeps the test focused on the persistence dispatch
      // (the path + kind), not on the gate.
      await stageNonBlockerFixture(tmpRoot);
      const result = await runCheck(["--staged"]);
      expect(result.exitCode).toBe(0);
      // findAdHocReportPath asserts exactly one rpt_<ULID> dir exists
      // (loud failure on collision or stale-dir scenarios).
      const reportPath = await findAdHocReportPath(tmpRoot);
      const file = ReportFileSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(file.kind).toBe("ad_hoc");
      expect(file.report_id).toMatch(/^rpt_[0-9A-HJKMNP-TV-Z]{26}$/);
    });
  });

  // ---------------------------------------------------------------------------
  // Section 5 — Input flag validation
  // ---------------------------------------------------------------------------

  describe("Section 5 — input flag validation", () => {
    it("--threshold with unknown value → exit 1 + clean stderr", async () => {
      const result = await runCheck(["--staged", "--threshold", "notathreshold"]);
      expect(result.exitCode).toBe(1);
      // Substring match on the locked stderr copy from check.ts step 2
      // — exact wording is documented in the command's source.
      expect(result.stderr).toContain("Invalid --threshold");
    });

    it("--task with whitespace-only string → exit 1 + clean stderr", async () => {
      // Whitespace-only (not just empty) — exercises the .trim() check
      // explicitly. Empty-string ("") would also pass the rejection
      // but via the .length === 0 path; whitespace is the more
      // interesting case to lock.
      const result = await runCheck(["--staged", "--task", "   "]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --task");
    });
  });

  // ---------------------------------------------------------------------------
  // Section 6 — Config error surfacing
  // ---------------------------------------------------------------------------

  describe("Section 6 — config error surfacing", () => {
    it("missing .viberevert.yml → exit 1 + clean stderr (ConfigNotFoundError mapping)", async () => {
      // Remove the config that beforeEach wrote.
      await rm(join(tmpRoot, ".viberevert.yml"));
      const result = await runCheck(["--staged"]);
      expect(result.exitCode).toBe(1);
      // Substring of the locked directive copy from check.ts's
      // handleKnownError ConfigNotFoundError arm.
      expect(result.stderr).toContain("No .viberevert.yml");
    });

    it("invalid .viberevert.yml → exit 1 + clean stderr (ConfigParseError mapping)", async () => {
      // Overwrite the valid config with malformed YAML.
      await writeFile(join(tmpRoot, ".viberevert.yml"), ":\n  :\n  : :\n");
      const result = await runCheck(["--staged"]);
      expect(result.exitCode).toBe(1);
      // Locked stderr copy from handleKnownError's
      // ConfigParseError/ConfigValidationError arm.
      expect(result.stderr).toContain("Invalid .viberevert.yml");
    });
  });

  // ---------------------------------------------------------------------------
  // Section 7 -- Config-source authority (M 0.8.0 step 8)
  // ---------------------------------------------------------------------------
  //
  // These pin WHICH config source check.ts treats as authoritative, through
  // observable command behavior only. The live `.viberevert.yml` is made to
  // materially DISAGREE with the snapshot, so each assertion distinguishes
  // the two sources rather than merely confirming that some config applied.
  //
  // Tests 1-4 share one live config that disables `secrets` against the
  // blocker fixture: identical file, three bases, two outcomes. That A/B is
  // what proves "no snapshot" selects live config rather than silently
  // falling through to defaults.

  describe("Section 7 -- config-source authority (M 0.8.0 step 8)", () => {
    /** Live config disabling the secrets check. */
    async function writeSecretsDisabledConfig(): Promise<void> {
      await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\nchecks:\n  secrets: false\n");
    }

    /** Laravel detection is existence-only: composer.json AND artisan. */
    async function writeLaravelSignature(): Promise<void> {
      await writeFile(join(tmpRoot, "composer.json"), '{"name":"test/app"}\n');
      await writeFile(join(tmpRoot, "artisan"), "#!/usr/bin/env php\n");
    }

    /** `laravel.middleware` is the ONLY rule matching app/Http/Middleware/**;
     *  the filename is deliberately neutral so no filename-driven generic
     *  rule (e.g. an *Auth* pattern) can compete for the match. */
    async function changeLaravelMiddleware(): Promise<void> {
      await mkdir(join(tmpRoot, "app", "Http", "Middleware"), { recursive: true });
      await writeFile(join(tmpRoot, "app", "Http", "Middleware", "Foo.php"), "<?php\n");
    }

    async function findingIds(args: readonly string[]): Promise<readonly string[]> {
      const result = await runCheck([...args, "--json"]);
      const file = ReportFileSchema.parse(JSON.parse(result.stdout));
      return file.report.results.map((r) => r.id);
    }

    it("session base: snapshot wins over a mutated but VALID live config", async () => {
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: [] }),
      });
      await stageBlockerFixture(tmpRoot);
      // The agent disables the very check that would flag its own work.
      await writeSecretsDisabledConfig();
      const result = await runCheck(["--since", sessionId]);
      // Snapshot has secrets ENABLED, so the critical finding survives.
      // If live config won this would be exit 0.
      expect(result.exitCode).toBe(2);
    });

    it("session base: snapshot is used even when live YAML is UNPARSABLE", async () => {
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: [] }),
      });
      await stageBlockerFixture(tmpRoot);
      // An unclosed flow sequence is unequivocally malformed -- loadConfig
      // cannot parse it at all. Asserting exit 2 (rather than just "not 1")
      // proves in one assertion BOTH that loadConfig was never called AND
      // that the snapshot supplied the policy.
      await writeFile(join(tmpRoot, ".viberevert.yml"), "version: [\n");
      const result = await runCheck(["--since", sessionId]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).not.toContain("Invalid .viberevert.yml");
    });

    it("session base with NO snapshot falls back to live config (pre-0.8.0)", async () => {
      const { sessionId } = await makeSession(tmpRoot);
      await stageBlockerFixture(tmpRoot);
      await writeSecretsDisabledConfig();
      const result = await runCheck(["--since", sessionId]);
      // Live config wins on the legacy path, suppressing secrets. Absence of
      // a snapshot must select LIVE CONFIG, never defaults -- defaults would
      // re-enable secrets and give exit 2 here.
      expect(result.exitCode).toBe(0);
    });

    it("non-session base (--staged) uses live config", async () => {
      await stageBlockerFixture(tmpRoot);
      await writeSecretsDisabledConfig();
      const result = await runCheck(["--staged"]);
      expect(result.exitCode).toBe(0);
    });

    it("explicit snapshot frameworks are NOT augmented by current detection", async () => {
      // Laravel detectable at start and now. Committed pre-session so the
      // signature sits inside the checkpoint. Explicit mode deliberately
      // overrides detection, so this IS a producible step 5 state.
      await writeLaravelSignature();
      await runGit(tmpRoot, ["add", "."]);
      await runGit(tmpRoot, ["commit", "-q", "-m", "laravel"]);
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "explicit", values: ["nextjs"] }),
      });
      await changeLaravelMiddleware();
      const ids = await findingIds(["--since", sessionId]);
      // Detection sees laravel; the snapshot says nextjs. Explicit wins, so
      // the laravel-gated rule must not fire. A regression that unioned
      // explicit values with detection would surface exactly here.
      expect(ids).not.toContain(LARAVEL_MIDDLEWARE_ID);
    });

    it("auto snapshot RETAINS detected_at_start when the signature is gone now", async () => {
      // Laravel present at session start...
      await writeLaravelSignature();
      await runGit(tmpRoot, ["add", "."]);
      await runGit(tmpRoot, ["commit", "-q", "-m", "laravel"]);
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: ["laravel"] }),
      });
      // ...and deleted during the session, so current detection sees none.
      await rm(join(tmpRoot, "composer.json"));
      await rm(join(tmpRoot, "artisan"));
      await changeLaravelMiddleware();
      const ids = await findingIds(["--since", sessionId]);
      // The union retains the start observation, so deleting a framework
      // signature mid-session cannot make its risk rules disappear.
      expect(ids).toContain(LARAVEL_MIDDLEWARE_ID);
    });

    it("auto snapshot ADDS current detection when start detected nothing", async () => {
      // No Laravel signature at session start, so `detected_at_start: []` is
      // what the step 5 producer would genuinely have written here.
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: [] }),
      });
      // The agent introduces Laravel during the session.
      await writeLaravelSignature();
      await changeLaravelMiddleware();
      const ids = await findingIds(["--since", sessionId]);
      // Current detection joins the union, so a framework introduced
      // mid-session activates its rules. The signature files also show up as
      // changed files here; that is tolerated deliberately, because adding
      // exclusions to hide them would couple this test to rollback-exclude
      // behavior.
      expect(ids).toContain(LARAVEL_MIDDLEWARE_ID);
    });
  });

  // ---------------------------------------------------------------------------
  // Section 8 -- Contribution-backed ended sessions (M 0.8.0 step 8 B3)
  // ---------------------------------------------------------------------------
  //
  // An ended session with BOTH an evaluation snapshot and a contribution stops
  // diffing checkpoint-vs-live and reads its frozen contribution instead. Each
  // test is built so the two branches give OPPOSITE answers, which is what
  // makes "which branch ran" observable rather than inferred.
  //
  // Tests 1, 2, 4 and 6 keep the live tree clean so contribution-sourced
  // evidence is the only possible source. Tests 3 and 5 deliberately do the
  // reverse -- they LOAD the tree -- because they prove the contribution-backed
  // path does NOT consult it, and that the legacy path still does.

  describe("Section 8 -- contribution-backed ended sessions (M 0.8.0 step 8 B3)", () => {
    const ENDED_AT = "2026-02-01T00:00:00Z";
    const SECRET_LINE = `sk${"_live_"}TESTFIXTUREONLY1234567890ABCDEF`;

    /**
     * A contribution entry for a newly added file whose single hunk ADDS
     * `lines`. Those lines become `addedLines` through parseRawDiffToInputs,
     * which is what the content detectors scan.
     *
     * The after-state's bytes are seeded into the object store so the fixture
     * carries a coherent recovery graph: an `added` entry should not claim the
     * file is absent afterwards. B3 never dereferences `content_ref`, so this
     * is fixture hygiene rather than something Section 8 asserts on.
     */
    async function addedFileEntry(
      sessionId: string,
      path: string,
      lines: readonly string[],
    ): Promise<SessionContributionEntry> {
      const contentRef = await putObject(tmpRoot, Buffer.from(`${lines.join("\n")}\n`, "utf8"));
      return {
        path,
        operation: "added",
        facets: ["content_changed"],
        change_group_id: deriveChangeGroupId(sessionId, [path]),
        before: { worktree: { kind: "absent" }, index: { kind: "absent" } },
        after: {
          worktree: { kind: "regular", content_ref: contentRef, executable: false },
          index: { kind: "absent" },
        },
        content_delta: {
          kind: "text",
          hunks: [
            {
              old_start: 0,
              old_lines: 0,
              new_start: 1,
              new_lines: lines.length,
              lines: lines.map((text) => ({ kind: "add" as const, text })),
            },
          ],
        },
      };
    }

    async function reportFor(sessionId: string): Promise<{
      exitCode: number;
      stderr: string;
      ids: readonly string[];
    }> {
      const result = await runCheck(["--since", sessionId, "--json"]);
      if (result.exitCode === 1) {
        return { exitCode: 1, stderr: result.stderr, ids: [] };
      }
      const file = ReportFileSchema.parse(JSON.parse(result.stdout));
      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        ids: file.report.results.map((r) => r.id),
      };
    }

    it("snapshot + contribution: the FROZEN contribution drives the diff", async () => {
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: [] }),
        ended: {
          endedAt: ENDED_AT,
          contribution: {
            entries: async (sid) => [await addedFileEntry(sid, "notes.txt", [SECRET_LINE])],
          },
        },
      });
      // The live tree has NO secret. A checkpoint-vs-live diff would find
      // nothing, so exit 2 can only come from the contribution's own hunk.
      const { exitCode, ids } = await reportFor(sessionId);
      expect(exitCode).toBe(2);
      // Asserting the finding ID, not just the exit code: that proves the
      // blocker is the contribution's secret rather than some unrelated
      // critical finding the fixture happened to introduce.
      expect(ids).toContain("secrets.regex");
    });

    it("snapshot + contribution: detected_frameworks_at_end drives auto frameworks", async () => {
      // No composer.json / artisan anywhere: current-tree detection sees NO
      // Laravel. Only the persisted end observation can activate its rules.
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: [] }),
        ended: {
          endedAt: ENDED_AT,
          contribution: {
            detectedFrameworksAtEnd: ["laravel"],
            entries: async (sid) => [
              await addedFileEntry(sid, "app/Http/Middleware/Foo.php", ["<?php"]),
            ],
          },
        },
      });

      const { ids } = await reportFor(sessionId);
      expect(ids).toContain(LARAVEL_MIDDLEWARE_ID);
    });

    it("snapshot + contribution with NO end observation: start-only, no current-tree fallback", async () => {
      // INVERSE of the previous test: Laravel IS detectable on disk right now.
      // If the contribution-backed branch ever fell back to
      // detectFrameworks(repoRoot), the middleware rule would fire.
      await writeFile(join(tmpRoot, "composer.json"), '{"name":"test/app"}\n');
      await writeFile(join(tmpRoot, "artisan"), "#!/usr/bin/env php\n");
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: [] }),
        ended: {
          endedAt: ENDED_AT,
          contribution: {
            // detectedFrameworksAtEnd omitted: this session ended before the
            // observation was captured. Absent means "never observed", and the
            // union degrades to detected_at_start alone.
            entries: async (sid) => [
              await addedFileEntry(sid, "app/Http/Middleware/Foo.php", ["<?php"]),
            ],
          },
        },
      });

      const { ids } = await reportFor(sessionId);
      expect(ids).not.toContain(LARAVEL_MIDDLEWARE_ID);
    });

    it("NO snapshot + contribution: the contribution is ignored, evaluation stays legacy", async () => {
      // Contribution capture (step 4) shipped BEFORE the evaluation snapshot
      // (step 5), so this state is real history, not a contrivance. Consuming
      // the frozen diff without the frozen policy would pair evidence from two
      // different evaluation universes.
      const { sessionId } = await makeSession(tmpRoot, {
        // No evaluationSnapshot, by omission rather than post-hoc stripping.
        ended: {
          endedAt: ENDED_AT,
          contribution: {
            entries: async (sid) => [await addedFileEntry(sid, "notes.txt", [SECRET_LINE])],
          },
        },
      });

      // Live tree is clean, so the legacy checkpoint-vs-live path finds
      // nothing. Exit 2 here would mean the contribution had been consumed.
      const { exitCode } = await reportFor(sessionId);
      expect(exitCode).toBe(0);
    });

    it("ended snapshot with NO contribution stays on checkpoint-vs-live", async () => {
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: [] }),
        ended: { endedAt: ENDED_AT },
      });
      // Blocker introduced in the LIVE tree after the checkpoint. Only a
      // checkpoint-vs-live diff can see it, so this pins that an ended
      // lifecycle alone does not switch the diff source.
      await stageBlockerFixture(tmpRoot);

      const { exitCode, ids } = await reportFor(sessionId);
      expect(exitCode).toBe(2);
      expect(ids).toContain("secrets.regex");
    });

    it("tampered contribution bytes refuse cleanly with the digest-mismatch error", async () => {
      const { sessionId } = await makeSession(tmpRoot, {
        evaluationSnapshot: makeSnapshot({ mode: "auto", detected_at_start: [] }),
        ended: {
          endedAt: ENDED_AT,
          contribution: {
            entries: async (sid) => [await addedFileEntry(sid, "notes.txt", [SECRET_LINE])],
          },
        },
      });

      // Append harmless whitespace AFTER the digest was recorded. The artifact
      // stays valid JSON and schema-valid, so the ONLY failing layer is the
      // raw-byte SHA binding -- malformed JSON cannot become an alternate
      // reason for the refusal.
      const contributionPath = join(
        tmpRoot,
        ".viberevert",
        "sessions",
        sessionId,
        "contribution.json",
      );
      await writeFile(contributionPath, `${await readFile(contributionPath, "utf8")}\n`);

      const result = await runCheck(["--since", sessionId]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Contribution digest mismatch");
      // Surfaced through handleKnownError's verbatim arm, not as a crash.
      expect(result.stdout).toBe("");
    });
  });
});
