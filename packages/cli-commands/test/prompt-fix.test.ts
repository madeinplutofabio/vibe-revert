// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Integration tests for `viberevert prompt-fix` (M E Step 3 file 5).
//
// 30 tests across 12 sections covering the acceptance criteria from
// the M E plan and every locked defense from file 3's review:
//
//   1.  --llm precedence (D84 / A5)                                4
//   2.  Resolver refusals (A4 / A7 / A8 + global no-mutation lock) 6
//   3.  Unknown options --json / --markdown (A18)                  2
//   4.  Happy path (A1) + registration smoke + sibling path lock   4
//   5.  Default-resolution wiring (resolver↔command smoke)         1
//   6.  Re-run determinism (A14)                                   1
//   7.  Empty-findings refusal (A6 / A17 / lock-#12 deferral)      3
//   8.  Drift guard (A16) on both success + empty-findings paths   2
//   9.  Write-order failure (A22 — sinks + call-order + target)    1
//   10. Stale-removal failure (D93 — copy + target + options)      1
//   11. Defensive parse/read/BOM/schema failures                   4
//   12. Determinism under fixed env vars (A9)                      1
//
// =============================================================================
// Test infrastructure locks
// =============================================================================
//
//  1. **Mock setup: node:fs/promises + ../src/atomic.js with
//     `importOriginal` delegating defaults; per-test reset via
//     `resetDelegatingMocks()` helper.** Each mocked function wraps
//     `vi.fn(actual.X)` so the initial default behavior IS the real
//     fs / atomic helper. Per-test overrides use
//     `mockImplementationOnce` / `mockResolvedValueOnce` /
//     `mockRejectedValueOnce`. Both `beforeEach` AND `afterEach`
//     call `resetDelegatingMocks()`, which does TWO things per mock:
//        (a) `mockReset()` — clears BOTH call history AND any
//            queued one-shot behaviors that a failed test might
//            have left behind. Plain `vi.clearAllMocks()` is NOT
//            strong enough here because it preserves the
//            `mockResolvedValueOnce` / `mockRejectedValueOnce` queue
//            — a test that fails before consuming a queued override
//            would poison the next test (rm/readFile/writeFileAtomic
//            would fire the leftover override on the next call,
//            producing a confusing failure in a downstream test
//            instead of the actual bug in the upstream one).
//        (b) `mockImplementation(real)` — re-installs the delegating
//            default so the bare mock returns real-fs / real-
//            writeFileAtomic behavior again. Without this,
//            `mockReset` alone would leave the mock returning
//            `undefined` from every call, which would silently mask
//            bugs (the command's `await rm(...)` would resolve to
//            `undefined` and look like success).
//     The belt-and-suspenders (reset in BOTH hooks) ensures clean
//     state regardless of which hook ran last or whether a prior
//     test crashed mid-flow.
//
//  2. **Real `rm` for cleanup AND real `readFile` for fixture-byte
//     captures.** The afterEach temp-repo cleanup uses
//     `vi.importActual("node:fs/promises")` to grab the real `rm` —
//     even with the reset-and-redelegate discipline in lock #1,
//     using the real surface for cleanup keeps that step
//     unconditionally isolated from any test-side mock state. Same
//     applies to drift-test fixture captures: tests that need to
//     read source-report bytes for comparison MUST use the
//     `realReadFile` helper so the fixture-side read does NOT
//     pollute the command-side `readFile.mock.calls` history that
//     the test asserts on.
//
//  3. **Every test goes through the Clipanion Cli.register +
//     Cli.run dispatch** — the same code path `packages/cli/src/
//     index.ts` uses to invoke the command in production. There
//     is NO direct `new PromptFixCommand().execute()` anywhere in
//     this file. Section 1's first test serves as the explicit
//     registration smoke (proves the command is reachable through
//     the binary surface).
//
//  4. **Determinism via VIBEREVERT_TEST_FIXED_VERSION.** Tests
//     that need byte-stable fix-prompt.txt output set this env var
//     per-test with restore-in-finally semantics (mirrors the M B /
//     M C precedent for VIBEREVERT_TEST_FIXED_NOW).
//
//  5. **Global no-mutation refusal lock.** Every non-success test
//     asserts `fix-prompt.txt` was NOT created OR (for tests with
//     a pre-existing stale sibling) was NOT modified. The only
//     refusal that mutates is the D86 empty-findings stale-removal
//     — every other refusal preserves whatever sibling state existed
//     before the run.
//
//  6. **Two temp-dir helpers — `makeTempDir` (bare) vs.
//     `makeTempRepoRoot` (with a `.git/` marker).** `resolveRepoRoot`
//     walks up looking for `.git` OR `.viberevert.yml`; tests that
//     need the command to reach past STEP 2 of execute() must use
//     `makeTempRepoRoot`. The only test that legitimately needs
//     "outside any project" state is Section 1.1's --llm pre-resolve
//     smoke — it uses `makeTempDir` to verify the D84 deferral fires
//     BEFORE repo-root resolution. `.git/` is preferred over
//     `.viberevert.yml` for the repo marker because it preserves the
//     D19 config-blind invariant: a future regression that
//     accidentally loads config would surface as a clean
//     ConfigNotFoundError rather than being masked by an
//     accidentally-present yml file.
//
//  7. **D93-verbatim copies tested via `toBe(exact)`, NOT broad
//     regex.** The D93-locked resolver-related stderr copies — the
//     M C classes reused verbatim (AmbiguousReportSelectionError
//     and ReportNotFoundError × session/report/default) plus the
//     CLI-seam D93 OVERRIDE rewrites (InvalidReportSelectionError ×
//     session/report — different wording from the M C class
//     message per D93) — and the D86 empty-findings copy are all
//     locked at the D93 contract surface. The tests assert exact
//     equality on stderr so any wording drift surfaces immediately.
//     Tests for copies that embed a non-deterministic cause string
//     (I/O failures, stale-removal failures, parse failures) stay
//     on partial regex — the prefix/suffix is contract-locked but
//     the embedded cause text isn't.

import { mkdirSync, mkdtempSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { REPORT_FILE_SCHEMA_VERSION, ReportFileSchema } from "@viberevert/session-format";
import { Builtins, Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeFileAtomic } from "../src/atomic.js";
import { PromptFixCommand } from "../src/commands/prompt-fix.js";
import { VIBEREVERT_TEST_FIXED_VERSION } from "../src/runtime-env.js";

// =============================================================================
// vi.mock setup — hoisted above test execution.
// =============================================================================

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rm: vi.fn(actual.rm),
  };
});

vi.mock("../src/atomic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/atomic.js")>();
  return {
    ...actual,
    writeFileAtomic: vi.fn(actual.writeFileAtomic),
  };
});

// =============================================================================
// Fixture constants
// =============================================================================

const SESS_ID_A = "sess_01ABCDEFGHJKMNPQRSTVWXYZ23";
const RPT_ID_A = "rpt_01ABCDEFGHJKMNPQRSTVWXYZ23";
const RPT_ID_B = "rpt_01ZZZZZZZZZZZZZZZZZZZZZZZZ";
const FIXED_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const FIXED_TIME = "2026-01-01T00:00:00Z";
const FIXED_VERSION = "0.7.0-test";
const STALE_FIX_PROMPT_MARKER = "STALE_FIX_PROMPT_FROM_PRIOR_RUN\n";

// =============================================================================
// Fixture helpers
// =============================================================================

function makeReportFileJson(opts: {
  kind: "session_bound" | "ad_hoc";
  id: string;
  withFindings?: boolean;
  writtenAt?: string;
}): string {
  const sinceKind = opts.kind === "session_bound" ? "session_id" : "checkpoint_name";
  const sinceRef = opts.kind === "session_bound" ? opts.id : "baseline";
  const results = opts.withFindings
    ? [
        {
          id: "ck.test.a",
          category: "test",
          level: "high" as const,
          confidence: "medium" as const,
          title: "Test finding",
          message: "Test message",
          evidence: [{ detail: "test detail" }],
          recommendation: "Test recommendation.",
        },
      ]
    : [];
  const file = ReportFileSchema.parse({
    schema_version: REPORT_FILE_SCHEMA_VERSION,
    kind: opts.kind,
    report_id: opts.id,
    since_kind: sinceKind,
    since_ref: sinceRef,
    since_resolved_sha: FIXED_SHA,
    written_at: opts.writtenAt ?? FIXED_TIME,
    report: {
      schema_version: "1.0",
      session_id: opts.id,
      started_at: FIXED_TIME,
      detected_frameworks: [],
      risk_level: opts.withFindings ? "high" : "low",
      results,
      changed_files: [],
      rollback_available: opts.kind === "session_bound",
    },
  });
  return JSON.stringify(file);
}

async function writeReport(
  repoRoot: string,
  opts: {
    kind: "session_bound" | "ad_hoc";
    id: string;
    withFindings?: boolean;
    writtenAt?: string;
    bytes?: Buffer | string;
  },
): Promise<string> {
  const subdir = opts.kind === "session_bound" ? "sessions" : "reports";
  const dir = join(repoRoot, ".viberevert", subdir, opts.id);
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, "report.json");
  const content = opts.bytes ?? makeReportFileJson(opts);
  await writeFile(reportPath, content);
  return reportPath;
}

function fixPromptPathFor(repoRoot: string, kind: "session_bound" | "ad_hoc", id: string): string {
  const subdir = kind === "session_bound" ? "sessions" : "reports";
  return join(repoRoot, ".viberevert", subdir, id, "fix-prompt.txt");
}

async function writeStaleFixPrompt(
  repoRoot: string,
  opts: { kind: "session_bound" | "ad_hoc"; id: string },
): Promise<string> {
  const path = fixPromptPathFor(repoRoot, opts.kind, opts.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, STALE_FIX_PROMPT_MARKER);
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bare temp directory — no repo marker. Used by tests that need to
 * verify behavior OUTSIDE any project (e.g., the D84 --llm pre-
 * resolve smoke that must fire BEFORE `resolveRepoRoot`). Walking
 * up from this dir under `tmpdir()` will not find a `.git` or
 * `.viberevert.yml` ancestor on any sane CI/local box, so
 * `resolveRepoRoot()` would correctly throw RepoRootNotFoundError
 * if it ever ran — but the --llm path returns first, which is what
 * Section 1.1 locks.
 */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "viberevert-prompt-fix-cli-"));
}

/**
 * Temp directory with a `.git/` marker so `resolveRepoRoot` finds
 * the dir as the repo root. `.git/` is preferred over
 * `.viberevert.yml` per lock #6 — prompt-fix is D19 config-blind,
 * and the absence of yml here means a future config-load regression
 * surfaces as a clean failure rather than being masked.
 */
function makeTempRepoRoot(): string {
  const dir = makeTempDir();
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/**
 * Best-effort recursive cleanup using the REAL `rm` (not the mocked
 * one). Even with the reset-and-redelegate discipline in lock #1,
 * using the real surface for cleanup keeps that step
 * unconditionally isolated from any test-side mock state.
 */
async function cleanupTempRepoRoot(dir: string): Promise<void> {
  const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await realFs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

/**
 * Read bytes using the REAL `readFile` (not the mocked one). Used by
 * the drift tests to capture source-report bytes for the
 * `mockResolvedValueOnce` chain WITHOUT polluting the mocked
 * `readFile.mock.calls` history that the test asserts on. If the
 * fixture read went through the mock, `readCalls[0]` would be the
 * test's own setup call rather than the command's read A, and the
 * call-target assertions would lock the wrong thing.
 */
async function realReadFile(path: string): Promise<Buffer> {
  const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return await realFs.readFile(path);
}

/**
 * Per-lock-#1 reset discipline. Combines `mockReset()` (clears
 * EVERYTHING — call history AND queued one-shot behaviors) with
 * `mockImplementation(real)` (re-installs the delegating default so
 * the bare mock returns real-fs / real-writeFileAtomic behavior).
 * Plain `vi.clearAllMocks()` was NOT strong enough — it would leave
 * `mockResolvedValueOnce` / `mockRejectedValueOnce` queues intact
 * across test boundaries, so a test that failed mid-flow before
 * consuming a queued override would poison the next test.
 *
 * Called from BOTH `beforeEach` AND `afterEach` for belt + suspenders
 * — clean state guaranteed regardless of which hook ran last or
 * whether a prior test crashed unexpectedly.
 */
async function resetDelegatingMocks(): Promise<void> {
  const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const realAtomic = await vi.importActual<typeof import("../src/atomic.js")>("../src/atomic.js");

  vi.mocked(readFile).mockReset();
  vi.mocked(readFile).mockImplementation(realFs.readFile as typeof readFile);

  vi.mocked(rm).mockReset();
  vi.mocked(rm).mockImplementation(realFs.rm as typeof rm);

  vi.mocked(writeFileAtomic).mockReset();
  vi.mocked(writeFileAtomic).mockImplementation(realAtomic.writeFileAtomic);
}

// =============================================================================
// runPromptFix harness — same Cli.register + Cli.run dispatch as
// packages/cli/src/index.ts (per infrastructure lock #3)
// =============================================================================

async function runPromptFix(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(Builtins.HelpCommand);
  cli.register(PromptFixCommand);

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

  const exitCode = await cli.run(["prompt-fix", ...args], {
    stdin: stdinStub,
    stdout: stdoutStub,
    stderr: stderrStub,
  });

  return {
    exitCode: exitCode ?? 0,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// =============================================================================
// Shared per-test setup/teardown
// =============================================================================

let repoRoot: string;
let originalCwd: string;
let savedVersionEnv: string | undefined;

beforeEach(async () => {
  await resetDelegatingMocks();
  repoRoot = makeTempRepoRoot();
  originalCwd = process.cwd();
  process.chdir(repoRoot);
  savedVersionEnv = process.env[VIBEREVERT_TEST_FIXED_VERSION];
  process.env[VIBEREVERT_TEST_FIXED_VERSION] = FIXED_VERSION;
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (savedVersionEnv === undefined) {
    delete process.env[VIBEREVERT_TEST_FIXED_VERSION];
  } else {
    process.env[VIBEREVERT_TEST_FIXED_VERSION] = savedVersionEnv;
  }
  await cleanupTempRepoRoot(repoRoot);
  await resetDelegatingMocks();
});

// =============================================================================
// SECTION 1: --llm precedence (D84 / A5)
// =============================================================================

describe("--llm precedence (D84 / A5)", () => {
  it("--llm outside any .viberevert project surfaces the deferred-feature copy + touches no filesystem (registration smoke through the Cli surface index.ts uses)", async () => {
    // makeTempDir gives a bare dir with NO `.git/` marker so
    // resolveRepoRoot would walk up to / and fail. The --llm path
    // must fire BEFORE that — proves D84 pre-resolve precedence.
    const isolated = makeTempDir();
    process.chdir(isolated);
    try {
      const { exitCode, stdout, stderr } = await runPromptFix(["--llm"]);
      expect(exitCode).toBe(1);
      expect(stderr).toBe(
        "--llm is reserved for a future release. Not available in v0.7.0; see roadmap.\n",
      );
      expect(stdout).toBe("");
      // D84 + D90.6 simultaneous lock — --llm must touch no fs.
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(rm)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
    } finally {
      // Escape `isolated` before cleanup so Windows cwd-lock
      // semantics don't block the rm. `repoRoot` (the beforeEach
      // dir) is safe to chdir into — it will be cleaned up by
      // afterEach.
      process.chdir(repoRoot);
      await cleanupTempRepoRoot(isolated);
    }
  });

  it("--llm with a valid --session and a present report still surfaces the deferred copy (does not load the report)", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const { exitCode, stdout, stderr } = await runPromptFix(["--llm", "--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      "--llm is reserved for a future release. Not available in v0.7.0; see roadmap.\n",
    );
    expect(stdout).toBe("");
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(false);
  });

  it("--llm with an INVALID --session shape surfaces the deferred copy, NOT the invalid-id refusal (--llm wins over flag validation)", async () => {
    const { exitCode, stdout, stderr } = await runPromptFix([
      "--llm",
      "--session",
      "not-a-session",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      "--llm is reserved for a future release. Not available in v0.7.0; see roadmap.\n",
    );
    expect(stdout).toBe("");
    expect(stderr).not.toMatch(/Invalid session id/);
  });

  it("--llm with --json is rejected at Clipanion parse-time (BEFORE execute(), so --llm precedence does not apply — output does NOT carry the deferred copy)", async () => {
    const { exitCode, stdout, stderr } = await runPromptFix(["--llm", "--json"]);
    expect(exitCode).toBe(1);
    // Clipanion writes the Unknown Syntax Error to stdout (impl
    // detail — stream routing varies). Combine streams to lock
    // behavior regardless of which Clipanion picks; negative-
    // space assertions also run against the combined output so a
    // future stream-routing change can't smuggle the --llm
    // deferred copy through.
    const combinedOutput = stdout + stderr;
    expect(combinedOutput.length).toBeGreaterThan(0);
    expect(combinedOutput).toMatch(/--json/);
    expect(combinedOutput).not.toMatch(/Not available in v0.7.0/);
    // Clipanion rejected before execute() — no fs.
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SECTION 2: Resolver refusals (A4 / A7 / A8) — D93-verbatim exact-equality
// =============================================================================

describe("Resolver refusals propagate to D93 stderr + no fix-prompt.txt written (A4 / A7 / A8 + global no-mutation lock)", () => {
  it("--session + --report together → AmbiguousReportSelectionError copy verbatim", async () => {
    const { exitCode, stdout, stderr } = await runPromptFix([
      "--session",
      SESS_ID_A,
      "--report",
      RPT_ID_A,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      `--session and --report are mutually exclusive. ` +
        `Got --session ${JSON.stringify(SESS_ID_A)} and --report ${JSON.stringify(RPT_ID_A)}.\n`,
    );
    expect(stdout).toBe("");
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(false);
    expect(await fileExists(fixPromptPathFor(repoRoot, "ad_hoc", RPT_ID_A))).toBe(false);
  });

  it("invalid --session shape → locked D93 override copy (M C wording overridden at the CLI seam)", async () => {
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", "not-a-session"]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      `Invalid session id "not-a-session". Expected the form sess_<26-character Crockford ULID>.\n`,
    );
    expect(stdout).toBe("");
  });

  it("invalid --report shape → locked D93 override copy", async () => {
    const { exitCode, stdout, stderr } = await runPromptFix(["--report", "not-a-report"]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      `Invalid report id "not-a-report". Expected the form rpt_<26-character Crockford ULID>.\n`,
    );
    expect(stdout).toBe("");
  });

  it("missing explicit --session report → ReportNotFoundError copy (D47-formatted, exact)", async () => {
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      `No report found for session ${SESS_ID_A}. ` +
        `Run \`viberevert check --since ${SESS_ID_A}\` first.\n`,
    );
    expect(stdout).toBe("");
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(false);
  });

  it("missing explicit --report report → ReportNotFoundError copy (exact)", async () => {
    const { exitCode, stdout, stderr } = await runPromptFix(["--report", RPT_ID_A]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(`Report ${RPT_ID_A} not found.\n`);
    expect(stdout).toBe("");
    expect(await fileExists(fixPromptPathFor(repoRoot, "ad_hoc", RPT_ID_A))).toBe(false);
  });

  it("no default-resolution candidate → ReportNotFoundError copy (exact)", async () => {
    await mkdir(join(repoRoot, ".viberevert"), { recursive: true });
    const { exitCode, stdout, stderr } = await runPromptFix([]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe("No reports found. Run `viberevert check` first.\n");
    expect(stdout).toBe("");
  });
});

// =============================================================================
// SECTION 3: Unknown options (A18)
// =============================================================================

describe("--json / --markdown are unknown options for prompt-fix (A18)", () => {
  it("--json → Clipanion unknown-option refusal (output names the flag, NOT a command refusal class) + no fs + no fix-prompt.txt", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A, "--json"]);
    expect(exitCode).toBe(1);
    // Clipanion writes the Unknown Syntax Error to stdout (impl
    // detail — stream routing varies). Combine streams to lock
    // behavior regardless of which Clipanion picks. Negative-
    // space assertions also run against the combined output so a
    // future stream-routing change can't smuggle a command-side
    // refusal copy into stdout undetected.
    const combinedOutput = stdout + stderr;
    expect(combinedOutput.length).toBeGreaterThan(0);
    expect(combinedOutput).toMatch(/--json/);
    expect(combinedOutput).not.toMatch(/contains no findings/);
    expect(combinedOutput).not.toMatch(/Not available in v0.7.0/);
    expect(combinedOutput).not.toMatch(/Invalid (session|report) id/);
    expect(combinedOutput).not.toMatch(/Source report changed/);
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(false);
  });

  it("--markdown → Clipanion unknown-option refusal (output names the flag, NOT a command refusal class) + no fs + no fix-prompt.txt", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A, "--markdown"]);
    expect(exitCode).toBe(1);
    // Clipanion writes the Unknown Syntax Error to stdout (impl
    // detail — stream routing varies). Combine streams to lock
    // behavior regardless of which Clipanion picks. Negative-
    // space assertions also run against the combined output so a
    // future stream-routing change can't smuggle a command-side
    // refusal copy into stdout undetected.
    const combinedOutput = stdout + stderr;
    expect(combinedOutput.length).toBeGreaterThan(0);
    expect(combinedOutput).toMatch(/--markdown/);
    expect(combinedOutput).not.toMatch(/contains no findings/);
    expect(combinedOutput).not.toMatch(/Not available in v0.7.0/);
    expect(combinedOutput).not.toMatch(/Invalid (session|report) id/);
    expect(combinedOutput).not.toMatch(/Source report changed/);
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(false);
  });
});

// =============================================================================
// SECTION 4: Happy path (A1)
// =============================================================================

describe("Happy path — render + persist + stdout (A1)", () => {
  it("explicit --session writes the fix-prompt to the locked sibling path .viberevert/sessions/<sess>/fix-prompt.txt AND the next-steps section names the session rollback command (D82 + D85.6)", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.length).toBeGreaterThan(0);
    const expected = fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A);
    expect(await fileExists(expected)).toBe(true);
    // Session-bound source-kind locks: rollback command named in
    // next-steps (catches a wiring regression where the command
    // mis-routes session_bound to the ad-hoc renderer branch).
    expect(stdout).toContain(`viberevert rollback ${SESS_ID_A}`);
  });

  it("explicit --report writes the fix-prompt to the locked sibling path .viberevert/reports/<rpt>/fix-prompt.txt AND the next-steps section uses the ad-hoc recovery copy (NO rollback command — D82 + D85.6)", async () => {
    await writeReport(repoRoot, { kind: "ad_hoc", id: RPT_ID_A, withFindings: true });
    const { exitCode, stdout, stderr } = await runPromptFix(["--report", RPT_ID_A]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.length).toBeGreaterThan(0);
    const expected = fixPromptPathFor(repoRoot, "ad_hoc", RPT_ID_A);
    expect(await fileExists(expected)).toBe(true);
    // Ad-hoc source-kind locks: NO rollback command in next-steps;
    // the locked git/checkpoint copy is present instead. Catches a
    // wiring regression where the command mis-routes ad_hoc to the
    // session_bound renderer branch.
    expect(stdout).toContain("recover with git or a prior checkpoint; rollback is session-scoped.");
    expect(stdout).not.toContain("viberevert rollback ");
  });

  it("stdout is byte-identical to the persisted fix-prompt.txt (D81 dual-sink contract — A1)", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const { exitCode, stdout } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(0);
    const fileContent = await readFile(
      fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A),
      "utf8",
    );
    expect(stdout).toBe(fileContent);
  });

  it("rendered prompt has the expected structural shape (preamble + source attribution + findings + footer)", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const { stdout } = await runPromptFix(["--session", SESS_ID_A]);
    expect(stdout.startsWith("You are an AI coding assistant.")).toBe(true);
    expect(stdout).toMatch(/Source report: sess_/);
    expect(stdout).toMatch(/## Findings \(1\)/);
    expect(stdout).toMatch(/Generated by VibeRevert v/);
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stdout.endsWith("\n\n")).toBe(false);
  });
});

// =============================================================================
// SECTION 5: Default-resolution wiring (resolver ↔ command smoke)
// =============================================================================

describe("Default-resolution wiring at command level", () => {
  it("no flags + two reports with different written_at → command writes prompt beside the latest-resolved report", async () => {
    await writeReport(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
      withFindings: true,
      writtenAt: "2026-01-01T00:00:00Z",
    });
    await writeReport(repoRoot, {
      kind: "ad_hoc",
      id: RPT_ID_B,
      withFindings: true,
      writtenAt: "2026-06-01T00:00:00Z",
    });
    const { exitCode } = await runPromptFix([]);
    expect(exitCode).toBe(0);
    expect(await fileExists(fixPromptPathFor(repoRoot, "ad_hoc", RPT_ID_B))).toBe(true);
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(false);
  });
});

// =============================================================================
// SECTION 6: Re-run determinism (A14)
// =============================================================================

describe("Re-run determinism (A14)", () => {
  it("running prompt-fix twice against the same unchanged report produces byte-identical fix-prompt.txt", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const result1 = await runPromptFix(["--session", SESS_ID_A]);
    expect(result1.exitCode).toBe(0);
    const path = fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A);
    const content1 = await readFile(path);
    const result2 = await runPromptFix(["--session", SESS_ID_A]);
    expect(result2.exitCode).toBe(0);
    const content2 = await readFile(path);
    expect(content1.equals(content2)).toBe(true);
    expect(result1.stdout).toBe(result2.stdout);
  });
});

// =============================================================================
// SECTION 7: Empty-findings refusal (A6 + A17 + lock-#12 deferral)
// — D86 copy locked exact per the D93-verbatim discipline (lock #7)
// =============================================================================

describe("Empty-findings refusal (D86 / A6 / A17 / lock-#12 version deferral)", () => {
  const EMPTY_FINDINGS_COPY = (id: string): string =>
    `Report ${id} contains no findings; nothing to prompt-fix. ` +
    "Run `viberevert check ...` against fresh changes to generate a report with findings.\n";

  it("empty findings + no stale sibling → D93 copy verbatim + exit 1 + no fix-prompt.txt created", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: false });
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(EMPTY_FINDINGS_COPY(SESS_ID_A));
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(false);
  });

  it("empty findings + STALE sibling present → D93 copy verbatim + exit 1 + stale fix-prompt.txt REMOVED (A17 invalidation)", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: false });
    const stalePath = await writeStaleFixPrompt(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
    });
    expect(await fileExists(stalePath)).toBe(true);
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(EMPTY_FINDINGS_COPY(SESS_ID_A));
    expect(await fileExists(stalePath)).toBe(false);
  });

  it("empty findings + stale + INVALID VIBEREVERT_TEST_FIXED_VERSION env var → still cleans up (locks lock-#12 version deferral; stderr exact)", async () => {
    process.env[VIBEREVERT_TEST_FIXED_VERSION] = "";
    try {
      await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: false });
      const stalePath = await writeStaleFixPrompt(repoRoot, {
        kind: "session_bound",
        id: SESS_ID_A,
      });
      const { exitCode, stderr } = await runPromptFix(["--session", SESS_ID_A]);
      expect(exitCode).toBe(1);
      // Exact-match locks both the D86 copy AND the absence of any
      // RuntimeEnvInvalidError text (which would have appeared if
      // version resolution had not been deferred per lock #12).
      expect(stderr).toBe(EMPTY_FINDINGS_COPY(SESS_ID_A));
      expect(await fileExists(stalePath)).toBe(false);
    } finally {
      process.env[VIBEREVERT_TEST_FIXED_VERSION] = FIXED_VERSION;
    }
  });
});

// =============================================================================
// SECTION 8: Drift guard (A16)
// =============================================================================

describe("Drift guard (D88 / A16)", () => {
  it("source-report bytes change between read A and read B (success path) → drift refusal + no fix-prompt.txt + stdout empty + readFile call history shows exactly two command calls against target.reportPath", async () => {
    const reportPath = await writeReport(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
      withFindings: true,
    });
    const fixPromptPath = fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A);
    // Fixture-side read via REAL fs so the mocked readFile.mock.calls
    // history contains only the command's two reads (per lock #2).
    const bytesA = await realReadFile(reportPath);
    const bytesB = Buffer.concat([bytesA, Buffer.from(" ")]);

    vi.mocked(readFile).mockResolvedValueOnce(bytesA).mockResolvedValueOnce(bytesB);

    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Source report changed while generating fix-prompt; re-run `viberevert prompt-fix`.\n",
    );
    expect(await fileExists(fixPromptPath)).toBe(false);
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();

    // Both reads MUST target the source report path. resolveReportPaths
    // does NOT call readFile for explicit --session (uses lstat only),
    // so the mock chain is stable: exactly two command-driven calls,
    // both at index [0] and [1].
    const readCalls = vi.mocked(readFile).mock.calls;
    expect(readCalls.length).toBe(2);
    expect(readCalls[0]?.[0]).toBe(reportPath);
    expect(readCalls[1]?.[0]).toBe(reportPath);
  });

  it("source-report bytes change on the empty-findings deletion path → drift refusal + stale fix-prompt.txt UNTOUCHED (D86 drift-guarded deletion + global no-mutation lock)", async () => {
    const reportPath = await writeReport(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
      withFindings: false,
    });
    const stalePath = await writeStaleFixPrompt(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
    });
    // Fixture-side read via REAL fs — same rationale as above.
    const bytesA = await realReadFile(reportPath);
    const bytesB = Buffer.concat([bytesA, Buffer.from(" ")]);

    vi.mocked(readFile).mockResolvedValueOnce(bytesA).mockResolvedValueOnce(bytesB);

    const { exitCode, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      "Source report changed while generating fix-prompt; re-run `viberevert prompt-fix`.\n",
    );
    // Stale sibling MUST still exist — drift blocked the deletion.
    expect(await fileExists(stalePath)).toBe(true);
    expect(await readFile(stalePath, "utf8")).toBe(STALE_FIX_PROMPT_MARKER);
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SECTION 9: Write-order failure (A22)
// =============================================================================

describe("Write-order failure (D81 / A22 — file-before-stdout discipline)", () => {
  it("synthesized writeFileAtomic failure → exit 1 + I/O failure copy + stdout exactly '' + no fix-prompt.txt + writeFileAtomic called exactly once AFTER both source reads AND against the locked sibling path", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const fixPromptPath = fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A);
    const ioError = new Error("synthesized: no space left on device");
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(ioError);

    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/No prompt was emitted\.$/m);
    expect(stderr).toMatch(/Failed to persist fix-prompt\.txt at /);
    expect(stderr).toContain("synthesized: no space left on device");
    expect(await fileExists(fixPromptPath)).toBe(false);

    // Call-count + target-path lock.
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeFileAtomic).mock.calls[0]?.[0]).toBe(fixPromptPath);

    // Call-order lock: writeFileAtomic was called AFTER both source-
    // report reads (D81 + D88 — the drift check must precede the
    // write attempt).
    const readOrders = vi.mocked(readFile).mock.invocationCallOrder;
    const writeOrder = vi.mocked(writeFileAtomic).mock.invocationCallOrder[0];
    expect(readOrders.length).toBeGreaterThanOrEqual(2);
    expect(writeOrder).toBeGreaterThan(readOrders[0] ?? -1);
    expect(writeOrder).toBeGreaterThan(readOrders[1] ?? -1);
  });
});

// =============================================================================
// SECTION 10: Stale-removal failure (D93)
// =============================================================================

describe("Stale-removal failure (D93)", () => {
  it("synthesized rm failure on the empty-findings path → exit 1 + locked stale-removal copy + stale fix-prompt.txt still on disk + rm called exactly once on the locked sibling path with force:true + writeFileAtomic NOT called", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: false });
    const stalePath = await writeStaleFixPrompt(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
    });
    const rmError = new Error("synthesized: EBUSY");
    vi.mocked(rm).mockRejectedValueOnce(rmError);

    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/Failed to remove stale fix-prompt\.txt at /);
    expect(stderr).toMatch(/Remove it manually and re-run/);
    expect(stderr).toContain("synthesized: EBUSY");
    expect(await fileExists(stalePath)).toBe(true);
    expect(await readFile(stalePath, "utf8")).toBe(STALE_FIX_PROMPT_MARKER);

    // Lock the rm target + options + that writeFileAtomic was not
    // touched. Without these, a regression that called rm() on
    // target.reportPath instead of target.fixPromptPath would also
    // throw (mockRejectedValueOnce fires on the first rm regardless
    // of args), the stale fix-prompt.txt would still be present
    // (because the wrong rm target wouldn't affect it), and the
    // test would still pass.
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rm).mock.calls[0]?.[0]).toBe(stalePath);
    expect(vi.mocked(rm).mock.calls[0]?.[1]).toEqual({ force: true });
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SECTION 11: Defensive parse/read/BOM/schema failures
// =============================================================================

describe("Defensive parse / read / BOM / schema failures", () => {
  it("malformed JSON in report.json → PromptFixReportParseError stderr + stale fix-prompt.txt UNTOUCHED (global no-mutation lock)", async () => {
    await writeReport(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
      bytes: "{ not valid json",
    });
    const stalePath = await writeStaleFixPrompt(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
    });
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/Failed to parse source report at /);
    expect(await fileExists(stalePath)).toBe(true);
    expect(await readFile(stalePath, "utf8")).toBe(STALE_FIX_PROMPT_MARKER);
  });

  it("schema-invalid JSON → PromptFixReportParseError stderr with compact 'report does not match ReportFile schema' (NOT the noisy Zod issue dump)", async () => {
    await writeReport(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
      bytes: JSON.stringify({ wrong: "shape", not_a_report_file: true }),
    });
    const { exitCode, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Failed to parse source report at /);
    expect(stderr).toContain("report does not match ReportFile schema");
    expect(stderr).not.toMatch(/Expected.*received/);
  });

  it("report.json prefixed with a UTF-8 BOM → success (parse helper strips the BOM before JSON.parse)", async () => {
    const json = makeReportFileJson({
      kind: "session_bound",
      id: SESS_ID_A,
      withFindings: true,
    });
    await writeReport(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
      bytes: `﻿${json}`,
    });
    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.length).toBeGreaterThan(0);
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(true);
  });

  it("source report read fails after resolution (file vanishes mid-flow) → PromptFixReadFailureError stderr + no fix-prompt.txt", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    vi.mocked(readFile).mockRejectedValueOnce(enoent);

    const { exitCode, stdout, stderr } = await runPromptFix(["--session", SESS_ID_A]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/Failed to read source report at /);
    expect(stderr).toContain("ENOENT");
    expect(await fileExists(fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A))).toBe(false);
  });
});

// =============================================================================
// SECTION 12: Determinism under fixed env vars (A9)
// =============================================================================

describe("Determinism under fixed env vars (A9)", () => {
  it("VIBEREVERT_TEST_FIXED_VERSION set to a fixed value → two runs produce byte-identical fix-prompt.txt (locks D49 determinism for the version field)", async () => {
    process.env[VIBEREVERT_TEST_FIXED_VERSION] = "9.9.9-deterministic";
    try {
      await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A, withFindings: true });
      const result1 = await runPromptFix(["--session", SESS_ID_A]);
      expect(result1.exitCode).toBe(0);
      const path = fixPromptPathFor(repoRoot, "session_bound", SESS_ID_A);
      const content1 = await readFile(path);
      await rm(path, { force: true });
      const result2 = await runPromptFix(["--session", SESS_ID_A]);
      expect(result2.exitCode).toBe(0);
      const content2 = await readFile(path);
      expect(content1.equals(content2)).toBe(true);
      expect(content1.toString("utf8")).toContain("Generated by VibeRevert v9.9.9-deterministic");
    } finally {
      process.env[VIBEREVERT_TEST_FIXED_VERSION] = FIXED_VERSION;
    }
  });
});
