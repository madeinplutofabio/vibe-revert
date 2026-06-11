// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration tests for the `viberevert report` Clipanion command in
// `packages/cli/src/commands/report.ts`. Spawns ReportCommand through
// Clipanion's Cli with captured stdout/stderr streams (same harness
// pattern as check.test.ts / start-end.test.ts).
//
// report.ts is a READ-ONLY viewer per D47 — it never mutates state,
// never loads .viberevert.yml, never re-runs checks. So D.4 tests
// the persisted ReportFile as the *input contract* via hand-
// constructed fixtures rather than running CheckCommand to produce
// real reports. Producer→viewer round-trip coverage already lives in
// check.test.ts Section 3 (the JSON-deep-equals-persisted check) and
// will be exercised end-to-end by the M C golden-fixture suite at
// Step 10 of the plan.
//
// Fixtures are built via `makeReportFile(overrides)` which assembles
// a minimal schema-valid ReportFile and runs `ReportFileSchema.parse`
// before returning — schema drift surfaces as a clear "fixture helper
// broke" message instead of mysterious downstream test behavior.
//
// Six sections, 16 tests total:
//   1. Exit codes (D24/D47)                                   2 tests
//   2. Resolution dispatch (D26/D47)                           3 tests
//   3. Output modes (--json / --markdown / default terminal)   3 tests
//   4. --threshold semantics (D38)                             2 tests
//   5. Input flag validation (--json/--markdown mutex, etc.)   3 tests
//   6. Load + config failures (config-blind, 3-tier load)      3 tests
//
// Threshold tests prefer JSON mode for assertions: the terminal
// renderer's Changed Files inventory is UNFILTERED per D38, so a
// `.not.toContain(<path>)` assertion in terminal mode would false-
// fail on a path that survives in the diff inventory even though its
// finding was filtered out. JSON mode's `report.results` reflects
// the filter contract directly.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";

import { ensureViberevertDirs, generateReportId, generateSessionId } from "@viberevert/core";
import { generateCheckpointId } from "@viberevert/git";
import {
  type ActiveSessionLock,
  type ChangedFile,
  type CheckResult,
  REPORT_FILE_SCHEMA_VERSION,
  type ReportFile,
  ReportFileSchema,
  type RiskLevel,
  SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  type SessionReport,
  type SinceKind,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReportCommand } from "../../src/commands/report.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Module-level state (beforeEach/afterEach pattern, mirrors check.test.ts)
// =============================================================================

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  const tmpParent = await mkdtemp(join(tmpdir(), "viberevert-report-cmd-test-"));
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
  // Default valid config — report.ts is config-BLIND per D19 so this
  // file's PRESENCE is never required by the command, but having it
  // around matches the realistic repo state. The config-blind T14
  // test deletes it explicitly to prove the command still works.
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
  process.chdir(tmpRoot);
});

afterEach(async () => {
  // Restore CWD BEFORE cleanup so Windows file-lock semantics don't
  // block the rm (mirrors check.test.ts and start-end.test.ts).
  process.chdir(originalCwd);
  await rm(dirname(tmpRoot), { recursive: true, force: true });
});

// =============================================================================
// Helpers (duplicated inline per the locked "don't extract until 3rd consumer"
// rule)
// =============================================================================

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], {
    cwd,
    windowsHide: true,
  });
  return String(stdout);
}

/**
 * Run `viberevert report ${args}` via a Clipanion `Cli` instance with
 * captured stdout/stderr/stdin streams. Mirrors check.test.ts's
 * `runCheck` byte-for-byte except for the command class registered.
 */
async function runReport(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(ReportCommand);

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

  const exitCode = await cli.run(["report", ...args], {
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
 * Per-`SinceKind` canonical default for `ReportFile.since_ref`.
 * EXHAUSTIVELY switches over the SinceKind discriminated union so a
 * future enum value added in @viberevert/session-format triggers a
 * compile error here (the function would no longer cover every case
 * and TS would flag "not all code paths return a value"), NOT a
 * silently-wrong fixture rooted at "HEAD~1".
 *
 * Defaults are chosen to be truthful per the resolution semantics
 * each since_kind implies:
 *   - session_id / active_session → the session id (= report_id for
 *                                   session_bound reports per the
 *                                   D31 identity invariant)
 *   - checkpoint_id              → a generated `cp_<ULID>`
 *   - checkpoint_name            → "baseline" (stable fixture name
 *                                   used throughout the codebase,
 *                                   e.g. `viberevert checkpoint
 *                                   --name baseline`)
 *   - git_ref                    → "HEAD~1"
 *
 * Callers can always override via `overrides.since_ref` in
 * `makeReportFile`; this helper only fills the unspecified case.
 */
function defaultSinceRef(sinceKind: SinceKind, reportId: string): string {
  switch (sinceKind) {
    case "session_id":
    case "active_session":
      return reportId;
    case "checkpoint_id":
      return generateCheckpointId();
    case "checkpoint_name":
      return "baseline";
    case "git_ref":
      return "HEAD~1";
  }
}

/**
 * Shape of every override `makeReportFile` accepts. Each field is
 * optional; omitted fields fall back to schema-valid defaults that
 * satisfy every ReportFileSchema refine (kind ↔ since_kind, kind ↔
 * report_id prefix regex, identity-invariant on report.session_id).
 */
interface MakeReportFileOverrides {
  readonly report_id?: string;
  readonly kind?: "ad_hoc" | "session_bound";
  readonly since_kind?: SinceKind;
  readonly since_ref?: string;
  readonly since_resolved_sha?: string;
  readonly staged_only?: true;
  readonly written_at?: string;
  readonly task?: string;
  readonly summary?: string;
  readonly detected_frameworks?: readonly string[];
  readonly risk_level?: RiskLevel;
  readonly changed_files?: readonly ChangedFile[];
  readonly results?: readonly CheckResult[];
}

/**
 * Build a minimal schema-valid `ReportFile` for fixture use and
 * IMMEDIATELY run `ReportFileSchema.parse(...)` so any drift in the
 * shape (a new required field, a tightened refine, etc.) surfaces as
 * a clear ZodError from the fixture helper itself — not as a
 * mysterious failure deeper in the test.
 *
 * Defaults are chosen to satisfy every refine:
 *   - kind defaults to "ad_hoc"; report_id defaults to a fresh
 *     `generateReportId()` for ad_hoc and `generateSessionId()` for
 *     session_bound (so the prefix regex always matches).
 *   - since_kind defaults to "git_ref" for ad_hoc and "session_id"
 *     for session_bound (so the kind ↔ since_kind refine always
 *     passes without callers having to think about it).
 *   - since_ref mirrors resolution semantics: session_id /
 *     active_session bases use the session id (= report_id for
 *     session_bound reports per the D31 identity invariant);
 *     checkpoint_id uses a generated cp_<ULID>; checkpoint_name uses
 *     a stable fixture name; git_ref uses "HEAD~1".
 *   - report.session_id is ALWAYS set to report_id internally —
 *     callers cannot override it. This locks the D31 identity
 *     invariant at the fixture-helper level.
 *   - risk_level defaults to "low", results default to []; callers
 *     overriding `results` are responsible for choosing an
 *     appropriate `risk_level` (the schema doesn't enforce
 *     `risk_level === max(results.level)` — that's a CLI-builder
 *     concern; fixtures supply the field directly).
 */
function makeReportFile(overrides: MakeReportFileOverrides = {}): ReportFile {
  const kind = overrides.kind ?? "ad_hoc";
  const report_id =
    overrides.report_id ?? (kind === "ad_hoc" ? generateReportId() : generateSessionId());
  const since_kind: SinceKind =
    overrides.since_kind ?? (kind === "ad_hoc" ? "git_ref" : "session_id");
  const since_ref = overrides.since_ref ?? defaultSinceRef(since_kind, report_id);

  const reportObject: SessionReport = {
    schema_version: SCHEMA_VERSION,
    session_id: report_id, // identity-invariant — never overridable
    started_at: "2026-01-01T00:00:00Z",
    // Spread-copy at the assignment boundary: MakeReportFileOverrides
    // declares these as `readonly X[]` (idiomatic for "input I don't
    // mutate") but SessionReport's zod-inferred shape uses mutable
    // `X[]` (z.infer strips readonly). Spread-copy bridges the gap
    // without unsafe casts AND preserves the readonly-input contract
    // (a caller's array is never mutated by later fixture additions).
    detected_frameworks:
      overrides.detected_frameworks !== undefined ? [...overrides.detected_frameworks] : [],
    ...(overrides.task !== undefined ? { task: overrides.task } : {}),
    risk_level: overrides.risk_level ?? "low",
    changed_files: overrides.changed_files !== undefined ? [...overrides.changed_files] : [],
    results: overrides.results !== undefined ? [...overrides.results] : [],
    rollback_available: true,
    ...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
  };

  const fileObject = {
    schema_version: REPORT_FILE_SCHEMA_VERSION,
    kind,
    report_id,
    since_kind,
    since_ref,
    since_resolved_sha: overrides.since_resolved_sha ?? "0".repeat(40),
    ...(overrides.staged_only !== undefined ? { staged_only: overrides.staged_only } : {}),
    written_at: overrides.written_at ?? "2026-01-01T00:00:00Z",
    report: reportObject,
  };

  // Parse-and-return — fixture drift fails LOUDLY here, not later.
  return ReportFileSchema.parse(fileObject);
}

/**
 * Write a `ReportFile` to its kind-appropriate persistence path under
 * `.viberevert/`. `mkdir { recursive: true }` is idempotent so the
 * helper is safe to call multiple times in a single test (e.g., the
 * T5 default-resolution test that writes both an active-session
 * report and an older ad-hoc report).
 *
 * Returns the absolute path written so tests can read-back-and-
 * compare without re-deriving the path.
 */
async function writeReportFile(repoRoot: string, file: ReportFile): Promise<string> {
  const subdir = file.kind === "session_bound" ? "sessions" : "reports";
  const dir = join(repoRoot, ".viberevert", subdir, file.report_id);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "report.json");
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
  return filePath;
}

/**
 * Write a minimal valid `.viberevert/active-session.json` lock
 * pointing at `sessionId`. `checkpoint_id` is required by the schema
 * but report.ts never resolves the checkpoint (only the session_id
 * field is consulted by resolveReportPaths' 4a step) — a fresh
 * `generateCheckpointId()` value is therefore enough; no real
 * checkpoint manifest needs to exist on disk.
 */
async function writeActiveLock(repoRoot: string, sessionId: string): Promise<void> {
  const lock: ActiveSessionLock = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: sessionId,
    checkpoint_id: generateCheckpointId(),
    started_at: "2026-01-01T00:00:00Z",
  };
  await writeFile(
    join(repoRoot, ".viberevert", "active-session.json"),
    JSON.stringify(lock, null, 2),
  );
}

// =============================================================================
// Tests
// =============================================================================

describe("viberevert report", () => {
  // ---------------------------------------------------------------------------
  // Section 1 — Exit codes (D24/D47)
  // ---------------------------------------------------------------------------

  describe("Section 1 — exit codes (D24/D47)", () => {
    it("no reports anywhere → exit 1 with locked 'No reports found' message", async () => {
      const result = await runReport([]);
      expect(result.exitCode).toBe(1);
      // Locked stderr copy from resolveReportPaths' default-resolution
      // 4c branch — verbatim in handleKnownError's surface.
      expect(result.stderr).toContain("No reports found");
      expect(result.stderr).toContain("Run `viberevert check`");
    });

    it("one report present → exit 0 (default-resolution happy path)", async () => {
      const fixture = makeReportFile();
      await writeReportFile(tmpRoot, fixture);
      const result = await runReport([]);
      expect(result.exitCode).toBe(0);
      // Sanity: terminal output rendered (banner present); deeper
      // output-shape assertions live in Section 3.
      expect(result.stdout).toContain("VibeRevert Report");
    });
  });

  // ---------------------------------------------------------------------------
  // Section 2 — Resolution dispatch (D26/D47)
  // ---------------------------------------------------------------------------

  describe("Section 2 — resolution dispatch (D26/D47)", () => {
    it("--report <rpt_ULID> resolves to ad-hoc storage (kind=ad_hoc; report_id matches flag)", async () => {
      const fixture = makeReportFile(); // ad_hoc by default
      await writeReportFile(tmpRoot, fixture);
      const result = await runReport(["--report", fixture.report_id, "--json"]);
      expect(result.exitCode).toBe(0);
      const rendered = ReportFileSchema.parse(JSON.parse(result.stdout));
      expect(rendered.kind).toBe("ad_hoc");
      expect(rendered.report_id).toBe(fixture.report_id);
    });

    it("--session <sess_ULID> resolves to session-bound storage (kind=session_bound; report_id matches flag)", async () => {
      const fixture = makeReportFile({ kind: "session_bound" });
      await writeReportFile(tmpRoot, fixture);
      const result = await runReport(["--session", fixture.report_id, "--json"]);
      expect(result.exitCode).toBe(0);
      const rendered = ReportFileSchema.parse(JSON.parse(result.stdout));
      expect(rendered.kind).toBe("session_bound");
      expect(rendered.report_id).toBe(fixture.report_id);
    });

    it("omitted with active session having a report → active-session report wins over newer ad-hoc", async () => {
      // Write BOTH:
      //   - a session-bound report with an OLDER written_at
      //   - an ad-hoc report with a NEWER written_at
      //   - an active-session lock pointing at the session
      //
      // Per D47 step 4a, the active session's report wins regardless
      // of written_at. If 4a were broken and fell through to 4b
      // (latest sort), the ad-hoc would win because its written_at is
      // newer. Asserting the rendered output's report_id discriminates
      // the two branches cleanly.
      const sessionFixture = makeReportFile({
        kind: "session_bound",
        written_at: "2025-01-01T00:00:00Z", // OLDER
      });
      const adhocFixture = makeReportFile({
        kind: "ad_hoc",
        written_at: "2026-12-31T00:00:00Z", // NEWER
      });
      await writeReportFile(tmpRoot, sessionFixture);
      await writeReportFile(tmpRoot, adhocFixture);
      await writeActiveLock(tmpRoot, sessionFixture.report_id);

      const result = await runReport(["--json"]);
      expect(result.exitCode).toBe(0);
      const rendered = ReportFileSchema.parse(JSON.parse(result.stdout));
      expect(rendered.report_id).toBe(sessionFixture.report_id);
      expect(rendered.kind).toBe("session_bound");
    });
  });

  // ---------------------------------------------------------------------------
  // Section 3 — Output modes
  // ---------------------------------------------------------------------------

  describe("Section 3 — output modes", () => {
    it("default → terminal output with banner + Findings (N) section", async () => {
      const fixture = makeReportFile();
      await writeReportFile(tmpRoot, fixture);
      const result = await runReport([]);
      expect(result.exitCode).toBe(0);
      // Locked terminal-renderer layout from packages/reporters/src/terminal.ts
      // header banner + section divider. Asserting on the locked
      // "Findings (0)" section header (empty results in our default
      // fixture) gives positive evidence the terminal renderer ran.
      expect(result.stdout).toContain("VibeRevert Report");
      expect(result.stdout).toContain("Findings (0)");
    });

    it("--json → parseable JSON validating against ReportFileSchema AND byte-equal to persisted file", async () => {
      const fixture = makeReportFile();
      const reportPath = await writeReportFile(tmpRoot, fixture);
      const result = await runReport(["--report", fixture.report_id, "--json"]);
      expect(result.exitCode).toBe(0);

      // Sanity: stdout is parseable JSON validating against the
      // schema. Catches missing fields and schema-invalid values.
      const stdoutValue = JSON.parse(result.stdout) as unknown;
      const rendered = ReportFileSchema.parse(stdoutValue);
      expect(rendered.report_id).toBe(fixture.report_id);

      // Without --threshold, renderJson returns the ReportFile
      // reference UNCHANGED (verbatim per D45 + applyThreshold's
      // no-op short-circuit). Combined with the fact that
      // writeReportFile AND report.ts both stringify via the SAME
      // `${JSON.stringify(value, null, 2)}\n` format, the rendered
      // stdout MUST be BYTE-IDENTICAL to the persisted file. A weaker
      // deep-equality (.toEqual) would silently pass on key-order
      // drift (e.g. a future renderer that re-keys via Object.assign)
      // OR trailing-newline drift; byte equality catches both.
      const persistedBytes = await readFile(reportPath, "utf8");
      expect(result.stdout).toBe(persistedBytes);
    });

    it("--markdown → CommonMark output with locked '# VibeRevert Report' header AND version footer", async () => {
      const fixture = makeReportFile();
      await writeReportFile(tmpRoot, fixture);
      const result = await runReport(["--markdown"]);
      expect(result.exitCode).toBe(0);
      // Locked markdown layout from packages/reporters/src/markdown.ts.
      expect(result.stdout).toContain("# VibeRevert Report");
      // Locked footer from D45 — exact string `Generated by VibeRevert v`
      // followed by the version. We assert on the prefix so the
      // assertion stays stable across version bumps (the running
      // CLI's real version comes through resolveProductVersionForReport).
      expect(result.stdout).toContain("Generated by VibeRevert v");
    });
  });

  // ---------------------------------------------------------------------------
  // Section 4 — --threshold semantics (D38)
  // ---------------------------------------------------------------------------

  describe("Section 4 — --threshold semantics (D38)", () => {
    it("default (no --threshold) --json → all findings visible (low + critical both rendered)", async () => {
      // Mixed-severity fixture: 1 low + 1 critical.
      // CheckResultSchema requires `recommendation` for critical
      // (and high) levels — included on the critical entry only.
      const lowResult: CheckResult = {
        id: "test.low",
        title: "A low-severity test finding",
        level: "low",
        confidence: "high",
        category: "test",
        message: "low msg",
        evidence: [{ detail: "low evidence detail" }],
      };
      const critResult: CheckResult = {
        id: "test.crit",
        title: "A critical-severity test finding",
        level: "critical",
        confidence: "high",
        category: "test",
        message: "crit msg",
        evidence: [{ detail: "crit evidence detail" }],
        recommendation: "Fix it",
      };
      const fixture = makeReportFile({
        risk_level: "critical",
        results: [lowResult, critResult],
      });
      await writeReportFile(tmpRoot, fixture);

      const result = await runReport(["--report", fixture.report_id, "--json"]);
      expect(result.exitCode).toBe(0);
      const rendered = ReportFileSchema.parse(JSON.parse(result.stdout));
      // Default threshold = undefined per D38 → no filter → both
      // findings present in the rendered JSON.
      expect(rendered.report.results).toHaveLength(2);
      const levels = rendered.report.results.map((r) => r.level);
      expect(levels).toContain("low");
      expect(levels).toContain("critical");
    });

    it("--threshold critical --json → rendered results filtered; persisted file BYTE-UNCHANGED", async () => {
      const lowResult: CheckResult = {
        id: "test.low",
        title: "A low-severity test finding",
        level: "low",
        confidence: "high",
        category: "test",
        message: "low msg",
        evidence: [{ detail: "low evidence detail" }],
      };
      const critResult: CheckResult = {
        id: "test.crit",
        title: "A critical-severity test finding",
        level: "critical",
        confidence: "high",
        category: "test",
        message: "crit msg",
        evidence: [{ detail: "crit evidence detail" }],
        recommendation: "Fix it",
      };
      const fixture = makeReportFile({
        risk_level: "critical",
        results: [lowResult, critResult],
      });
      const reportPath = await writeReportFile(tmpRoot, fixture);

      // Snapshot disk bytes BEFORE the report run.
      const beforeBytes = await readFile(reportPath, "utf8");

      const result = await runReport([
        "--report",
        fixture.report_id,
        "--threshold",
        "critical",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);

      // Rendered results filtered to critical-only per D38.
      const rendered = ReportFileSchema.parse(JSON.parse(result.stdout));
      expect(rendered.report.results).toHaveLength(1);
      expect(rendered.report.results[0]?.level).toBe("critical");

      // Persisted file BYTE-UNCHANGED — D38 lock that --threshold
      // is OUTPUT-ONLY and never mutates the persisted artifact.
      // A future renderer or CLI bug that writes the filtered view
      // back to disk would surface as a byte mismatch here.
      const afterBytes = await readFile(reportPath, "utf8");
      expect(afterBytes).toBe(beforeBytes);
    });
  });

  // ---------------------------------------------------------------------------
  // Section 5 — Input flag validation
  // ---------------------------------------------------------------------------

  describe("Section 5 — input flag validation", () => {
    it("--json and --markdown together → exit 1 with 'mutually exclusive' message", async () => {
      // No fixture needed — validation fails before resolveReportPaths
      // is reached, so disk state is irrelevant.
      const result = await runReport(["--json", "--markdown"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--json and --markdown are mutually exclusive");
    });

    it("--threshold with unknown value → exit 1 with 'Invalid --threshold' message", async () => {
      const result = await runReport(["--threshold", "notathreshold"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --threshold");
    });

    it("--session and --report together → exit 1 (AmbiguousReportSelectionError)", async () => {
      // Use schema-valid id shapes so the inner ULID regex passes —
      // the failure must surface as the mutex error, NOT as
      // InvalidReportSelectionError (which would fire first for
      // malformed ids and would be a different test path).
      const sessId = generateSessionId();
      const rptId = generateReportId();
      const result = await runReport(["--session", sessId, "--report", rptId]);
      expect(result.exitCode).toBe(1);
      // Locked AmbiguousReportSelectionError message starts with the
      // string below.
      expect(result.stderr).toContain("--session and --report are mutually exclusive");
    });
  });

  // ---------------------------------------------------------------------------
  // Section 6 — Load + config failures
  // ---------------------------------------------------------------------------

  describe("Section 6 — load + config failures", () => {
    it("config-blind: works without .viberevert.yml (D19 lock)", async () => {
      // Delete the config file written by beforeEach. resolveRepoRoot
      // still finds the repo via `.git` (verified above against
      // packages/core/src/paths.ts). report.ts must succeed.
      await rm(join(tmpRoot, ".viberevert.yml"), { force: true });

      const fixture = makeReportFile();
      await writeReportFile(tmpRoot, fixture);

      const result = await runReport(["--json"]);
      expect(result.exitCode).toBe(0);
      const rendered = ReportFileSchema.parse(JSON.parse(result.stdout));
      expect(rendered.report_id).toBe(fixture.report_id);
    });

    it("malformed JSON at the resolved report path → exit 1 with 'invalid JSON' message", async () => {
      // Construct the rpt_<ULID> dir + garbage file manually
      // (bypassing writeReportFile because we're writing non-JSON
      // bytes that ReportFileSchema would reject from the helper).
      // We use --report <id> explicitly because default resolution's
      // scan SILENTLY SKIPS unparseable reports (by design — the
      // default path's job is "find the latest VALID report"). Only
      // explicit-id lookup reaches the 3-tier load path that surfaces
      // the malformed-JSON message.
      const reportId = "rpt_01JV8Y7W2M7AABCDEFGHJKMNPQ"; // schema-valid shape
      const dir = join(tmpRoot, ".viberevert", "reports", reportId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "report.json"), "{not valid json");

      const result = await runReport(["--report", reportId]);
      expect(result.exitCode).toBe(1);
      // Locked tier-2 message from report.ts step 4.
      expect(result.stderr).toContain("Persisted report file is malformed: invalid JSON.");
    });

    it("schema-invalid JSON at the resolved report path → exit 1 with malformed + 'Re-run viberevert check' message", async () => {
      // Bare `{}` is parseable JSON but fails ReportFileSchema (which
      // is a strictObject requiring schema_version, kind, report_id,
      // etc.) — exercises tier-3 (zod) of the 3-tier load.
      const reportId = "rpt_01JV8Y7W2M7AABCDEFGHJKMNPQ";
      const dir = join(tmpRoot, ".viberevert", "reports", reportId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "report.json"), "{}");

      const result = await runReport(["--report", reportId]);
      expect(result.exitCode).toBe(1);
      // Locked tier-3 messages from report.ts step 4 — the schema's
      // own err.message is included verbatim, AND the locked second
      // line points the user at regeneration.
      expect(result.stderr).toContain("Persisted report file is malformed:");
      expect(result.stderr).toContain("Re-run `viberevert check` to regenerate it.");
    });
  });
});
