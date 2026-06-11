// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// report-paths.ts — C.4 targeted tests for resolveReportPaths and the
// three error classes.
//
// 20 tests across 5 describe blocks.
//
// Covers all D26/D47 resolution paths plus the two hardening paths
// added in C.3:
//   - corrupted active-session.json with non-canonical session_id →
//     InvalidReportSelectionError (proves the resolver's own ULID-regex
//     defense fires even though ActiveSessionLockSchema accepts the
//     value as nonBlankString);
//   - stray .viberevert/reports/anything-else/ container with a
//     schema-valid report.json → ignored by default scan (proves the
//     canonical-name filter prevents shadowing).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportFile, ReportFileKind, SinceKind } from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  ReportNotFoundError,
  resolveReportPaths,
} from "../src/report-paths.js";

// =============================================================================
// Test fixture ids (all canonical: Crockford base32, alphabet excludes I/L/O/U)
// =============================================================================

const VALID_SESSION_ID_A = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const VALID_REPORT_ID_A = "rpt_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const VALID_REPORT_ID_B = "rpt_01JV9Z8X3N8BBCDEFGHJKMNPRT";
const VALID_CHECKPOINT_ID = "cp_01JV8Y7W2M7AABCDEFGHJKMNPQ";

// =============================================================================
// Per-test temp repo
// =============================================================================

let tmpRoot: string;
let repoRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-reportpathstest-"));
  repoRoot = join(tmpRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(join(repoRoot, ".viberevert"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build a schema-valid ReportFile payload. The identity-consistency
 * refine requires `report.session_id === report_id`, so both fields
 * use `opts.reportId`. SessionReportSchema accepts the `rpt_` prefix
 * (it's just nonBlankString for the inner session_id field), so ad-hoc
 * reports satisfy the refine the same way.
 */
function makeReportFile(opts: {
  reportId: string;
  kind: ReportFileKind;
  sinceKind: SinceKind;
  writtenAt?: string;
}): ReportFile {
  const writtenAt = opts.writtenAt ?? "2026-01-01T00:00:00Z";
  return {
    schema_version: "1.0",
    kind: opts.kind,
    report_id: opts.reportId,
    since_kind: opts.sinceKind,
    since_ref: opts.reportId,
    since_resolved_sha: "0000000000000000000000000000000000000000",
    written_at: writtenAt,
    report: {
      schema_version: "1.0",
      session_id: opts.reportId,
      started_at: writtenAt,
      detected_frameworks: [],
      risk_level: "low",
      results: [],
      changed_files: [],
      rollback_available: true,
    },
  };
}

async function writeSessionReport(
  sessionId: string,
  opts?: { writtenAt?: string },
): Promise<string> {
  const dir = join(repoRoot, ".viberevert", "sessions", sessionId);
  await mkdir(dir, { recursive: true });
  const file = makeReportFile({
    reportId: sessionId,
    kind: "session_bound",
    sinceKind: "session_id",
    ...(opts?.writtenAt !== undefined ? { writtenAt: opts.writtenAt } : {}),
  });
  const absPath = join(dir, "report.json");
  await writeFile(absPath, JSON.stringify(file, null, 2), "utf8");
  return absPath;
}

async function writeAdHocReport(reportId: string, opts?: { writtenAt?: string }): Promise<string> {
  const dir = join(repoRoot, ".viberevert", "reports", reportId);
  await mkdir(dir, { recursive: true });
  const file = makeReportFile({
    reportId,
    kind: "ad_hoc",
    sinceKind: "git_ref",
    ...(opts?.writtenAt !== undefined ? { writtenAt: opts.writtenAt } : {}),
  });
  const absPath = join(dir, "report.json");
  await writeFile(absPath, JSON.stringify(file, null, 2), "utf8");
  return absPath;
}

async function writeActiveSessionLock(sessionId: string): Promise<void> {
  const lock = {
    schema_version: "1.0",
    session_id: sessionId,
    checkpoint_id: VALID_CHECKPOINT_ID,
    started_at: "2026-01-01T00:00:00Z",
  };
  await writeFile(
    join(repoRoot, ".viberevert", "active-session.json"),
    JSON.stringify(lock, null, 2),
    "utf8",
  );
}

/**
 * Writes an active-session.json carrying a NON-CANONICAL session_id
 * (e.g. "../.."). ActiveSessionLockSchema accepts it (only enforces
 * nonBlankString), so loadActiveSessionLock returns successfully — but
 * resolveReportPaths's own validation MUST reject it before building
 * any path. This proves the C.3 hardening is the real defense.
 */
async function writeCorruptedActiveSessionLock(sessionIdValue: string): Promise<void> {
  const lock = {
    schema_version: "1.0",
    session_id: sessionIdValue,
    checkpoint_id: VALID_CHECKPOINT_ID,
    started_at: "2026-01-01T00:00:00Z",
  };
  await writeFile(
    join(repoRoot, ".viberevert", "active-session.json"),
    JSON.stringify(lock, null, 2),
    "utf8",
  );
}

// =============================================================================
// Tests
// =============================================================================

describe("resolveReportPaths — mutual exclusion", () => {
  it("both --session and --report set → AmbiguousReportSelectionError", async () => {
    let caught: unknown;
    try {
      await resolveReportPaths({
        repoRoot,
        sessionId: VALID_SESSION_ID_A,
        reportId: VALID_REPORT_ID_A,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AmbiguousReportSelectionError);
    const err = caught as AmbiguousReportSelectionError;
    expect(err.sessionId).toBe(VALID_SESSION_ID_A);
    expect(err.reportId).toBe(VALID_REPORT_ID_A);
  });
});

describe("resolveReportPaths — --report flag", () => {
  it("valid id + existing report → returns absolute path", async () => {
    const abs = await writeAdHocReport(VALID_REPORT_ID_A);
    const result = await resolveReportPaths({ repoRoot, reportId: VALID_REPORT_ID_A });
    expect(result).toBe(abs);
  });

  it("valid id + missing report → ReportNotFoundError ('Report X not found.')", async () => {
    let caught: unknown;
    try {
      await resolveReportPaths({ repoRoot, reportId: VALID_REPORT_ID_A });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReportNotFoundError);
    const err = caught as ReportNotFoundError;
    expect(err.subjectKind).toBe("report");
    expect(err.subject).toBe(VALID_REPORT_ID_A);
    expect(err.message).toBe(`Report ${VALID_REPORT_ID_A} not found.`);
  });

  it("invalid id format → InvalidReportSelectionError BEFORE path construction", async () => {
    let caught: unknown;
    try {
      await resolveReportPaths({ repoRoot, reportId: "not-a-rpt-id" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidReportSelectionError);
    const err = caught as InvalidReportSelectionError;
    expect(err.subjectKind).toBe("report");
    expect(err.value).toBe("not-a-rpt-id");
  });

  it("path-traversal attempt (../..) → InvalidReportSelectionError (defense)", async () => {
    let caught: unknown;
    try {
      await resolveReportPaths({ repoRoot, reportId: "../.." });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidReportSelectionError);
    expect((caught as InvalidReportSelectionError).value).toBe("../..");
  });
});

describe("resolveReportPaths — --session flag", () => {
  it("valid id + existing report → returns absolute path", async () => {
    const abs = await writeSessionReport(VALID_SESSION_ID_A);
    const result = await resolveReportPaths({ repoRoot, sessionId: VALID_SESSION_ID_A });
    expect(result).toBe(abs);
  });

  it("valid id + missing report → ReportNotFoundError with D47-locked message", async () => {
    let caught: unknown;
    try {
      await resolveReportPaths({ repoRoot, sessionId: VALID_SESSION_ID_A });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReportNotFoundError);
    const err = caught as ReportNotFoundError;
    expect(err.subjectKind).toBe("session");
    expect(err.subject).toBe(VALID_SESSION_ID_A);
    // D47-locked message format.
    expect(err.message).toContain(`No report found for session ${VALID_SESSION_ID_A}`);
    expect(err.message).toContain(`viberevert check --since ${VALID_SESSION_ID_A}`);
  });

  it("invalid id format → InvalidReportSelectionError BEFORE path construction", async () => {
    let caught: unknown;
    try {
      await resolveReportPaths({ repoRoot, sessionId: "garbage" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidReportSelectionError);
    const err = caught as InvalidReportSelectionError;
    expect(err.subjectKind).toBe("session");
  });

  it("path-traversal attempt (../..) → InvalidReportSelectionError (defense)", async () => {
    await expect(resolveReportPaths({ repoRoot, sessionId: "../.." })).rejects.toThrow(
      InvalidReportSelectionError,
    );
  });
});

describe("resolveReportPaths — default resolution: active session", () => {
  it("active session + has report → returns active session's report path", async () => {
    const abs = await writeSessionReport(VALID_SESSION_ID_A);
    await writeActiveSessionLock(VALID_SESSION_ID_A);
    const result = await resolveReportPaths({ repoRoot });
    expect(result).toBe(abs);
  });

  it("active session + NO report → falls through to latest scan (ad-hoc wins)", async () => {
    await writeActiveSessionLock(VALID_SESSION_ID_A);
    // No session report. But an ad-hoc report exists.
    const adHocAbs = await writeAdHocReport(VALID_REPORT_ID_A);
    const result = await resolveReportPaths({ repoRoot });
    expect(result).toBe(adHocAbs);
  });

  it("HARDENING: corrupted active-session.json (session_id='../..') → InvalidReportSelectionError", async () => {
    await writeCorruptedActiveSessionLock("../..");
    let caught: unknown;
    try {
      await resolveReportPaths({ repoRoot });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidReportSelectionError);
    const err = caught as InvalidReportSelectionError;
    expect(err.subjectKind).toBe("session");
    expect(err.value).toBe("../..");
  });
});

describe("resolveReportPaths — default resolution: latest scan", () => {
  it("no reports anywhere → ReportNotFoundError ('No reports found.')", async () => {
    let caught: unknown;
    try {
      await resolveReportPaths({ repoRoot });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReportNotFoundError);
    const err = caught as ReportNotFoundError;
    expect(err.subjectKind).toBe("default");
    expect(err.message).toBe("No reports found. Run `viberevert check` first.");
  });

  it("single ad-hoc report (no active session) → returns it", async () => {
    const abs = await writeAdHocReport(VALID_REPORT_ID_A);
    const result = await resolveReportPaths({ repoRoot });
    expect(result).toBe(abs);
  });

  it("single session-bound report (no active session) → returns it", async () => {
    const abs = await writeSessionReport(VALID_SESSION_ID_A);
    const result = await resolveReportPaths({ repoRoot });
    expect(result).toBe(abs);
  });

  it("multiple reports → picks latest by written_at DESC", async () => {
    const olderAbs = await writeAdHocReport(VALID_REPORT_ID_A, {
      writtenAt: "2026-01-01T00:00:00Z",
    });
    const newerAbs = await writeSessionReport(VALID_SESSION_ID_A, {
      writtenAt: "2026-06-15T12:00:00Z",
    });
    const result = await resolveReportPaths({ repoRoot });
    expect(result).toBe(newerAbs);
    expect(result).not.toBe(olderAbs);
  });

  it("tiebreaker: same written_at → picks higher report_id DESC", async () => {
    // VALID_REPORT_ID_B sorts lex AFTER VALID_REPORT_ID_A, so DESC picks _B.
    const aAbs = await writeAdHocReport(VALID_REPORT_ID_A, {
      writtenAt: "2026-01-01T00:00:00Z",
    });
    const bAbs = await writeAdHocReport(VALID_REPORT_ID_B, {
      writtenAt: "2026-01-01T00:00:00Z",
    });
    const result = await resolveReportPaths({ repoRoot });
    expect(result).toBe(bAbs);
    expect(result).not.toBe(aAbs);
  });

  it("HARDENING: non-canonical container name ignored by default scan", async () => {
    // Stray dir under .viberevert/reports/ with a schema-valid report.json
    // but a name that does NOT match REPORT_ID_RE. The scan must skip it
    // entirely — without the canonical-name filter, this dir could shadow
    // legitimate winners.
    const strayDir = join(repoRoot, ".viberevert", "reports", "anything-else");
    await mkdir(strayDir, { recursive: true });
    const strayFile = makeReportFile({
      reportId: VALID_REPORT_ID_A,
      kind: "ad_hoc",
      sinceKind: "git_ref",
    });
    await writeFile(join(strayDir, "report.json"), JSON.stringify(strayFile, null, 2), "utf8");
    // No legitimate reports anywhere else. Scan finds nothing.
    await expect(resolveReportPaths({ repoRoot })).rejects.toThrow(ReportNotFoundError);
  });

  it("HARDENING: stray .tmp-* container ignored by default scan", async () => {
    const tmpDir = join(repoRoot, ".viberevert", "reports", ".tmp-rpt-stale");
    await mkdir(tmpDir, { recursive: true });
    const file = makeReportFile({
      reportId: VALID_REPORT_ID_A,
      kind: "ad_hoc",
      sinceKind: "git_ref",
    });
    await writeFile(join(tmpDir, "report.json"), JSON.stringify(file, null, 2), "utf8");
    await expect(resolveReportPaths({ repoRoot })).rejects.toThrow(ReportNotFoundError);
  });

  it("corrupt JSON in one report.json is silently skipped (valid one wins)", async () => {
    // Canonical-named container, but the report.json inside is malformed JSON.
    const corruptDir = join(repoRoot, ".viberevert", "reports", VALID_REPORT_ID_A);
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, "report.json"), "{not valid json", "utf8");
    // A valid session-bound report exists elsewhere.
    const validAbs = await writeSessionReport(VALID_SESSION_ID_A);

    const result = await resolveReportPaths({ repoRoot });
    expect(result).toBe(validAbs);
  });
});
