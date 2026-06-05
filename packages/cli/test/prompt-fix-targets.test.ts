// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/cli/src/prompt-fix-targets.ts
// (M E Step 3 file 2 — resolver wrapper coverage).
//
// Five sections covering distinct responsibilities:
//
//   1. HAPPY PATHS — explicit --session resolves a session-bound
//      target; explicit --report resolves an ad-hoc target; default
//      resolution prefers the active-session report; default
//      resolution falls back to the latest report by written_at DESC
//      when no active session report exists. All four exercise the
//      REAL `resolveReportPaths` (the vi.mock delegate calls through
//      to the actual implementation by default). The explicit-flag
//      tests additionally assert `toHaveBeenCalledWith(...)` on the
//      delegated mock so a future regression where the wrapper stops
//      calling `resolveReportPaths` (e.g., computes paths locally as
//      a "performance optimization") is caught — temp-dir fixtures
//      alone wouldn't catch that because the spread-preserved error
//      classes and direct path math would still make the other
//      assertions pass.
//
//   2. ERROR PASSTHROUGH — verifies that the M C resolver's refusal
//      classes propagate unchanged through the prompt-fix wrapper.
//      Six cases: --session+--report mutual exclusion (Ambiguous);
//      malformed session id (Invalid); malformed report id (Invalid);
//      missing explicit-session report (NotFound); missing explicit-
//      ad-hoc report (NotFound); no default-resolution candidate
//      (NotFound). instanceof assertions use the classes re-exported
//      from prompt-fix-targets.js so the test exercises the seam the
//      command will use.
//
//   3. DEFENSIVE STRUCTURAL CHECKS — exercises the two locked
//      structural assertions in resolvePromptFixReportTarget that
//      cannot be reached via real fixtures (resolveReportPaths
//      enforces SESSION_ID_RE / REPORT_ID_RE + report.json filename
//      itself). Uses mockResolvedValueOnce to feed arbitrary "bad"
//      paths into the wrapper and asserts the correct defensive
//      Error fires: (a) filename != report.json; (b) parent layout
//      not under sessions/reports; (c) parent id not matching the
//      canonical regex for either storage root. The plain-Error
//      messages name the actual returned path so a real refactor
//      regression surfaces a useful diagnostic, not just "unexpected
//      layout."
//
//   4. RE-EXPORT CLASS IDENTITY — locks the file-1 design call: the
//      error classes re-exported from prompt-fix-targets.js are the
//      EXACT same constructor objects as those exported from
//      report-paths.js. instanceof checks against either import work
//      identically. One assertion per class so each failure names
//      the leaked-or-rewrapped class directly.
//
//   5. RESOLVER PURITY (D95 / D90.6 boundary) — grep-style guard
//      that prompt-fix-targets.ts itself adds zero filesystem
//      surface beyond the delegated `resolveReportPaths` call. The
//      module must not import `node:fs` / `node:fs/promises` and
//      must not call `readFile` / `writeFile` / `rm` / `lstat` /
//      `readdir` / `writeFileAtomic`. Comments + docstrings stripped
//      before the regex pass so the file's own docblock (which
//      legitimately discusses these patterns) does not trip the
//      check. Source of truth for the resolver's no-fs invariant;
//      Step 4's architectural-invariants block addresses the
//      command's D90.6 fs surface separately.
//
// Mocking discipline (per the file-1 design-call approval, hardened
// with the reset-and-redelegate pattern applied uniformly across
// file 5 of M E Step 3):
//
//   - vi.mock with importOriginal so resolveReportPaths defaults to
//     a vi.fn that DELEGATES to the actual implementation. This
//     keeps sections 1 and 2 exercising the real M C resolver
//     end-to-end via temp-dir fixtures.
//   - Both beforeEach AND afterEach in every section call
//     `resetDelegatingResolveReportPathsMock()`. That helper does
//     TWO things — `mockReset()` (clears BOTH call history AND any
//     queued one-shot behaviors that a failed test might have left
//     behind) followed by `mockImplementation(actual)` (re-installs
//     the delegating default). Plain `vi.clearAllMocks()` was NOT
//     strong enough: it would preserve a queued
//     `mockResolvedValueOnce` across test boundaries, so a Section 3
//     test that failed mid-flow before consuming a queued bad-path
//     value would poison the next test. Belt-and-suspenders (reset
//     in BOTH hooks) ensures clean state regardless of which hook
//     ran last or whether a prior test crashed unexpectedly.
//   - Section 3 uses mockResolvedValueOnce — overrides exactly ONE
//     call with the bad path, then reverts to the delegating
//     default. Multiple overrides in one test chain naturally.
//   - The ...actual spread in the mock factory preserves the real
//     error classes, so case 14's identity check passes.

import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REPORT_FILE_SCHEMA_VERSION, ReportFileSchema } from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  type PromptFixReportTarget,
  ReportNotFoundError,
  resolvePromptFixReportTarget,
} from "../src/prompt-fix-targets.js";
import {
  AmbiguousReportSelectionError as RawAmbiguousReportSelectionError,
  InvalidReportSelectionError as RawInvalidReportSelectionError,
  ReportNotFoundError as RawReportNotFoundError,
  resolveReportPaths,
} from "../src/report-paths.js";

// =============================================================================
// vi.mock setup — hoisted above test execution.
//
// The mock spreads `...actual` (all real exports — including the three
// error classes case 14 asserts identity on) and overrides ONLY
// `resolveReportPaths` with a vi.fn that defaults to delegating to
// the actual implementation. Sections 1 and 2 run against the real
// resolver via temp-dir fixtures; section 3 overrides per-call via
// mockResolvedValueOnce; section 4 verifies the spread preserved
// class identity.
// =============================================================================

vi.mock("../src/report-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/report-paths.js")>();
  return {
    ...actual,
    resolveReportPaths: vi.fn(actual.resolveReportPaths),
  };
});

// =============================================================================
// Fixture constants + helpers
// =============================================================================

const SESS_ID_A = "sess_01ABCDEFGHJKMNPQRSTVWXYZ23";
const RPT_ID_A = "rpt_01ABCDEFGHJKMNPQRSTVWXYZ23";
const RPT_ID_B = "rpt_01ZZZZZZZZZZZZZZZZZZZZZZZZ";
const CHECKPOINT_ID = "cp_01ABCDEFGHJKMNPQRSTVWXYZ23";
const FIXED_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const FIXED_TIME = "2026-01-01T00:00:00Z";

/**
 * Produce a JSON-encoded ReportFile fixture for on-disk write. The
 * inner object flows through `ReportFileSchema.parse` so any
 * fixture-validity drift surfaces here rather than as a confusing
 * downstream parse failure inside `resolveReportPaths`'s default-
 * resolution scan.
 */
function makeReportFileJson(opts: {
  kind: "session_bound" | "ad_hoc";
  id: string;
  writtenAt?: string;
}): string {
  const sinceKind = opts.kind === "session_bound" ? "session_id" : "checkpoint_name";
  const sinceRef = opts.kind === "session_bound" ? opts.id : "baseline";
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
      risk_level: "low",
      results: [],
      changed_files: [],
      rollback_available: opts.kind === "session_bound",
    },
  });
  return JSON.stringify(file);
}

/**
 * Write a valid ReportFile to its D26 storage location and return
 * the absolute path the test should assert against.
 */
async function writeReport(
  repoRoot: string,
  opts: { kind: "session_bound" | "ad_hoc"; id: string; writtenAt?: string },
): Promise<string> {
  const subdir = opts.kind === "session_bound" ? "sessions" : "reports";
  const dir = join(repoRoot, ".viberevert", subdir, opts.id);
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, "report.json");
  await writeFile(reportPath, makeReportFileJson(opts), "utf8");
  return reportPath;
}

/**
 * Write the M B active-session lock at the D11 canonical path so
 * `loadActiveSessionLock` (called inside resolveReportPaths) picks
 * it up. Schema-validity is not enforced here because
 * `ActiveSessionLockSchema` accepts nonBlankString for session_id —
 * the canonical-id check happens at use time inside
 * `resolveReportPaths` (per its own design lock).
 */
async function writeActiveLock(repoRoot: string, sessionId: string): Promise<void> {
  const lockPath = join(repoRoot, ".viberevert", "active-session.json");
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = {
    schema_version: "1.0",
    session_id: sessionId,
    checkpoint_id: CHECKPOINT_ID,
    started_at: FIXED_TIME,
  };
  await writeFile(lockPath, JSON.stringify(lock), "utf8");
}

/**
 * Create a fresh temp directory to serve as a repoRoot for a single
 * test. Caller is responsible for cleanup via the matching afterEach
 * helper below.
 */
function makeTempRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), "viberevert-prompt-fix-targets-"));
}

/**
 * Best-effort recursive cleanup with maxRetries to defend against
 * the Windows ENOTEMPTY flake (antivirus / Windows Search briefly
 * holding open handles on files just removed by the recursive walk).
 * `force: true` swallows ENOENT; `maxRetries` + `retryDelay` retries
 * the parent rmdir if a child is still locked.
 */
async function cleanupTempRepoRoot(repoRoot: string): Promise<void> {
  await rm(repoRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

/**
 * Per-mocking-discipline reset helper (mirrors the pattern used in
 * packages/cli/test/prompt-fix.test.ts for the broader fs surface).
 * Combines `mockReset()` (clears BOTH call history AND any queued
 * one-shot behaviors that a failed test might have left behind)
 * with `mockImplementation(actual)` (re-installs the delegating
 * default so the bare mock returns real `resolveReportPaths`
 * behavior again). Plain `vi.clearAllMocks()` was NOT strong
 * enough — it would preserve a queued `mockResolvedValueOnce`
 * across test boundaries, so a Section 3 test that failed mid-flow
 * before consuming a queued bad-path value would poison the next
 * test.
 *
 * Called from BOTH `beforeEach` AND `afterEach` in every section
 * for belt + suspenders: clean state guaranteed regardless of which
 * hook ran last or whether a prior test crashed unexpectedly.
 */
async function resetDelegatingResolveReportPathsMock(): Promise<void> {
  const actual =
    await vi.importActual<typeof import("../src/report-paths.js")>("../src/report-paths.js");
  vi.mocked(resolveReportPaths).mockReset();
  vi.mocked(resolveReportPaths).mockImplementation(actual.resolveReportPaths);
}

// =============================================================================
// SECTION 1: happy paths (real resolveReportPaths via temp-dir fixtures)
// =============================================================================

describe("resolvePromptFixReportTarget — happy paths (delegates to real resolveReportPaths)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    await resetDelegatingResolveReportPathsMock();
    repoRoot = makeTempRepoRoot();
  });

  afterEach(async () => {
    await cleanupTempRepoRoot(repoRoot);
    await resetDelegatingResolveReportPathsMock();
  });

  it("explicit --session resolves a session-bound target AND calls through to the real resolveReportPaths", async () => {
    await writeReport(repoRoot, { kind: "session_bound", id: SESS_ID_A });

    const target: PromptFixReportTarget = await resolvePromptFixReportTarget(repoRoot, {
      session: SESS_ID_A,
    });

    expect(target.reportPath).toBe(
      join(repoRoot, ".viberevert", "sessions", SESS_ID_A, "report.json"),
    );
    expect(target.fixPromptPath).toBe(
      join(repoRoot, ".viberevert", "sessions", SESS_ID_A, "fix-prompt.txt"),
    );
    expect(target.sourceKind).toBe("session_bound");
    expect(target.sourceId).toBe(SESS_ID_A);

    // Delegation lock — wrapper MUST call resolveReportPaths with the
    // exact options object (no extra keys, no missing keys). Catches
    // a regression where the wrapper computes paths locally and
    // bypasses the M C resolver entirely.
    expect(resolveReportPaths).toHaveBeenCalledWith({
      repoRoot,
      sessionId: SESS_ID_A,
    });
  });

  it("explicit --report resolves an ad-hoc target AND calls through to the real resolveReportPaths", async () => {
    await writeReport(repoRoot, { kind: "ad_hoc", id: RPT_ID_A });

    const target = await resolvePromptFixReportTarget(repoRoot, { report: RPT_ID_A });

    expect(target.reportPath).toBe(
      join(repoRoot, ".viberevert", "reports", RPT_ID_A, "report.json"),
    );
    expect(target.fixPromptPath).toBe(
      join(repoRoot, ".viberevert", "reports", RPT_ID_A, "fix-prompt.txt"),
    );
    expect(target.sourceKind).toBe("ad_hoc");
    expect(target.sourceId).toBe(RPT_ID_A);

    // Delegation lock — same rationale as the --session case above.
    expect(resolveReportPaths).toHaveBeenCalledWith({
      repoRoot,
      reportId: RPT_ID_A,
    });
  });

  it("default resolution prefers the active-session report even when a newer ad-hoc report exists", async () => {
    // Setup: session-bound report (early written_at) + active session
    // lock pointing to it + newer ad-hoc report (later written_at).
    // The active-session report should win even though the ad-hoc is
    // newer — D47 step 4a checks active-session report BEFORE the
    // latest-report scan.
    await writeReport(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
      writtenAt: "2026-01-01T00:00:00Z",
    });
    await writeReport(repoRoot, {
      kind: "ad_hoc",
      id: RPT_ID_B,
      writtenAt: "2026-06-01T00:00:00Z",
    });
    await writeActiveLock(repoRoot, SESS_ID_A);

    const target = await resolvePromptFixReportTarget(repoRoot, {});

    expect(target.reportPath).toBe(
      join(repoRoot, ".viberevert", "sessions", SESS_ID_A, "report.json"),
    );
    expect(target.fixPromptPath).toBe(
      join(repoRoot, ".viberevert", "sessions", SESS_ID_A, "fix-prompt.txt"),
    );
    expect(target.sourceKind).toBe("session_bound");
    expect(target.sourceId).toBe(SESS_ID_A);
  });

  it("default resolution falls back to the latest report (by written_at DESC) when no active-session report exists", async () => {
    // Setup: session-bound report (early) + ad-hoc report (later).
    // No active lock. D47 step 4b should pick the later report.
    await writeReport(repoRoot, {
      kind: "session_bound",
      id: SESS_ID_A,
      writtenAt: "2026-01-01T00:00:00Z",
    });
    await writeReport(repoRoot, {
      kind: "ad_hoc",
      id: RPT_ID_B,
      writtenAt: "2026-06-01T00:00:00Z",
    });

    const target = await resolvePromptFixReportTarget(repoRoot, {});

    expect(target.reportPath).toBe(
      join(repoRoot, ".viberevert", "reports", RPT_ID_B, "report.json"),
    );
    expect(target.fixPromptPath).toBe(
      join(repoRoot, ".viberevert", "reports", RPT_ID_B, "fix-prompt.txt"),
    );
    expect(target.sourceKind).toBe("ad_hoc");
    expect(target.sourceId).toBe(RPT_ID_B);
  });
});

// =============================================================================
// SECTION 2: error passthrough (verifies M C refusal classes propagate
// unchanged through the prompt-fix wrapper seam)
// =============================================================================

describe("resolvePromptFixReportTarget — error passthrough (M C refusal classes propagate unchanged)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    await resetDelegatingResolveReportPathsMock();
    repoRoot = makeTempRepoRoot();
  });

  afterEach(async () => {
    await cleanupTempRepoRoot(repoRoot);
    await resetDelegatingResolveReportPathsMock();
  });

  it("--session + --report passed together throws AmbiguousReportSelectionError (from the prompt-fix-targets re-export)", async () => {
    await expect(
      resolvePromptFixReportTarget(repoRoot, { session: SESS_ID_A, report: RPT_ID_A }),
    ).rejects.toBeInstanceOf(AmbiguousReportSelectionError);
  });

  it("invalid --session shape throws InvalidReportSelectionError", async () => {
    await expect(
      resolvePromptFixReportTarget(repoRoot, { session: "not-a-session" }),
    ).rejects.toBeInstanceOf(InvalidReportSelectionError);
  });

  it("invalid --report shape throws InvalidReportSelectionError", async () => {
    await expect(
      resolvePromptFixReportTarget(repoRoot, { report: "not-a-report" }),
    ).rejects.toBeInstanceOf(InvalidReportSelectionError);
  });

  it("missing explicit-session report throws ReportNotFoundError", async () => {
    // Valid sess_<ULID> id but no file on disk.
    await expect(
      resolvePromptFixReportTarget(repoRoot, { session: SESS_ID_A }),
    ).rejects.toBeInstanceOf(ReportNotFoundError);
  });

  it("missing explicit-ad-hoc report throws ReportNotFoundError", async () => {
    // Valid rpt_<ULID> id but no file on disk.
    await expect(
      resolvePromptFixReportTarget(repoRoot, { report: RPT_ID_A }),
    ).rejects.toBeInstanceOf(ReportNotFoundError);
  });

  it("no default-resolution candidate throws ReportNotFoundError", async () => {
    // Initialized .viberevert/ dir but zero report candidates and no
    // active lock — D47 step 4c should fire.
    await mkdir(join(repoRoot, ".viberevert"), { recursive: true });
    await expect(resolvePromptFixReportTarget(repoRoot, {})).rejects.toBeInstanceOf(
      ReportNotFoundError,
    );
  });
});

// =============================================================================
// SECTION 3: defensive structural checks (mockResolvedValueOnce overrides
// the resolver per-test to exercise branches unreachable via real fixtures)
// =============================================================================

describe("resolvePromptFixReportTarget — defensive structural checks (refactor-regression guards)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    await resetDelegatingResolveReportPathsMock();
    repoRoot = makeTempRepoRoot();
  });

  afterEach(async () => {
    await cleanupTempRepoRoot(repoRoot);
    await resetDelegatingResolveReportPathsMock();
  });

  it("throws when resolveReportPaths returns a path whose basename is not report.json (filename check)", async () => {
    const badPath = join(repoRoot, ".viberevert", "sessions", SESS_ID_A, "wrong-file.json");
    vi.mocked(resolveReportPaths).mockResolvedValueOnce(badPath);

    await expect(resolvePromptFixReportTarget(repoRoot, {})).rejects.toThrow(
      /unexpected report filename/,
    );
  });

  it("throws when resolveReportPaths returns a path outside the sessions/reports storage roots (layout check)", async () => {
    const badPath = join(repoRoot, ".viberevert", "other-storage", SESS_ID_A, "report.json");
    vi.mocked(resolveReportPaths).mockResolvedValueOnce(badPath);

    await expect(resolvePromptFixReportTarget(repoRoot, {})).rejects.toThrow(
      /unexpected path layout/,
    );
  });

  it("throws when the parent container under sessions/ is not a canonical sess_<ULID> id (layout check)", async () => {
    // sessions root, but the id-dir name doesn't match SESSION_ID_RE.
    const badPath = join(repoRoot, ".viberevert", "sessions", "not-a-session", "report.json");
    vi.mocked(resolveReportPaths).mockResolvedValueOnce(badPath);

    await expect(resolvePromptFixReportTarget(repoRoot, {})).rejects.toThrow(
      /unexpected path layout/,
    );
  });

  it("throws when the parent container under reports/ is not a canonical rpt_<ULID> id (layout check)", async () => {
    // reports root, but the id-dir name doesn't match REPORT_ID_RE.
    const badPath = join(repoRoot, ".viberevert", "reports", "not-a-report", "report.json");
    vi.mocked(resolveReportPaths).mockResolvedValueOnce(badPath);

    await expect(resolvePromptFixReportTarget(repoRoot, {})).rejects.toThrow(
      /unexpected path layout/,
    );
  });
});

// =============================================================================
// SECTION 4: re-export class identity (locks the file-1 design call —
// the command imports the resolver + its expected errors from ONE seam)
// =============================================================================

describe("re-export lock — error classes preserve class identity across the prompt-fix-targets seam", () => {
  // Each `expect(A).toBe(B)` here asserts that the class re-exported
  // from prompt-fix-targets.js is the EXACT SAME constructor object
  // as the one exported from report-paths.js. instanceof checks
  // against either import work identically. If a future refactor
  // accidentally re-wraps the class (e.g., `class extends ...`), this
  // test fires immediately with a clear per-class name in the
  // failure message.

  it("AmbiguousReportSelectionError class identity preserved", () => {
    expect(AmbiguousReportSelectionError).toBe(RawAmbiguousReportSelectionError);
  });

  it("InvalidReportSelectionError class identity preserved", () => {
    expect(InvalidReportSelectionError).toBe(RawInvalidReportSelectionError);
  });

  it("ReportNotFoundError class identity preserved", () => {
    expect(ReportNotFoundError).toBe(RawReportNotFoundError);
  });
});

// =============================================================================
// SECTION 5: resolver purity (D95 / D90.6 boundary — no fs surface in
// prompt-fix-targets.ts itself; all filesystem resolution lives inside
// the delegated resolveReportPaths call)
// =============================================================================

describe("resolver purity — prompt-fix-targets.ts adds zero filesystem surface (D95 / D90.6 boundary)", () => {
  it("source file does not import node:fs / node:fs/promises and does not call readFile/writeFile/rm/lstat/readdir/writeFileAtomic", async () => {
    // Read the resolver source file from disk.
    const sourcePath = fileURLToPath(new URL("../src/prompt-fix-targets.ts", import.meta.url));
    const source = await readFile(sourcePath, "utf8");

    // Strip block comments (/* ... */) THEN line comments (// ...).
    // The resolver's own docblock legitimately discusses these
    // patterns ("this wrapper itself adds zero new I/O on top",
    // "no readFile / writeFileAtomic / rm / lstat / readdir here",
    // etc.) — without the strip those mentions would trip the
    // forbidden-token regexes below and produce false-positive
    // failures.
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // Forbidden imports.
    expect(stripped, "must not import from 'node:fs'").not.toMatch(/from\s+["']node:fs["']/);
    expect(stripped, "must not import from 'node:fs/promises'").not.toMatch(
      /from\s+["']node:fs\/promises["']/,
    );

    // Forbidden call tokens. `\b` word boundary prevents matches
    // inside larger identifiers (e.g., `myReadFile(` would not match
    // `readFile(` because the `r` is preceded by `y`, which is a
    // word character, so no boundary). All checks are case-sensitive
    // — the Node API surface is lowercase-canonical.
    expect(stripped, "must not call readFile(...)").not.toMatch(/\breadFile\(/);
    expect(stripped, "must not call writeFile(...)").not.toMatch(/\bwriteFile\(/);
    expect(stripped, "must not call rm(...)").not.toMatch(/\brm\(/);
    expect(stripped, "must not call lstat(...)").not.toMatch(/\blstat\(/);
    expect(stripped, "must not call readdir(...)").not.toMatch(/\breaddir\(/);
    expect(
      stripped,
      "must not call writeFileAtomic(...) — that helper belongs in the command, not the resolver",
    ).not.toMatch(/\bwriteFileAtomic\(/);
  });
});
