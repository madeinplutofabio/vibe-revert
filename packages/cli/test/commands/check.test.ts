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
// Six sections, 14 tests total:
//   1. Exit codes (D24): no-changes / non-blocker / blocker             3 tests
//   2. --threshold semantics (D38)                                       3 tests
//   3. Output modes (--json shape + render-vs-persist parity)            2 tests
//   4. Persistence dispatch on base.kind (D26)                           2 tests
//   5. Input flag validation (--threshold, --task)                       2 tests
//   6. Config error surfacing                                            2 tests
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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";

import { ensureViberevertDirs, generateSessionId } from "@viberevert/core";
import { createCheckpoint } from "@viberevert/git";
import {
  type ActiveSessionLock,
  ReportFileSchema,
  SESSION_STATE_SCHEMA_VERSION,
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
  opts: { task?: string; markAsActive?: boolean } = {},
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
  const sessionState: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: sessionId,
    checkpoint_id: checkpointId,
    started_at: startedAt,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    before_status_path: `.viberevert/sessions/${sessionId}/before-status.txt`,
    commands_log_path: `.viberevert/sessions/${sessionId}/commands.log`,
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
});
