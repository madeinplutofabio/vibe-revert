// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Operation-layer tests for generateFixPromptOperation. 21 tests
// across 6 describe blocks; covers EVERY operation-public typed
// error class at least once, plus all 5 passthrough errors the
// operation propagates unchanged.
//
// Test responsibilities (distinguishes operation boundary from
// Command boundary):
//
//   1. Typed result shape (GenerateFixPromptOperationResult) +
//      D81 byte-identity (persisted file === result.promptText).
//   2. sourceReportId is sourced from ReportFile.report_id (the
//      semantic source of truth per D86), NOT from the path-derived
//      target.sourceId. Adversarial fixture: path id A, JSON id B.
//   3. session-bound success path (separate from ad_hoc — proves
//      both kinds work and the fixture-model split is correct).
//   4. D99.M.21 cwd-binding — opts.cwd, never process.cwd().
//   5. Resolver passthrough — RepoRootNotFoundError,
//      ReportNotFoundError, AmbiguousReportSelectionError (both
//      flags supplied), InvalidReportSelectionError (BOTH --session
//      and --report shapes) — propagate UNCHANGED.
//   6. Resolver-unknown wrap — PromptFixTargetResolutionError
//      wraps ONLY unexpected resolver throws; cause identity + message
//      preserved.
//   7. Operation-public typed errors with real fixtures —
//      PromptFixEmptyFindingsError 2-part (carried reportId from JSON
//      field + stale removed); PromptFixReportParseError for both
//      malformed JSON (SyntaxError path) and schema-invalid JSON
//      (ZodError path with preserved compact wording);
//      BOM-preservation (leading U+FEFF stripped before JSON.parse).
//   8. D88 drift detection — PromptFixDriftDetectedError fires +
//      fix-prompt.txt is NOT created.
//   9. Phase field — PromptFixReadFailureError.phase disambiguates
//      "initial_read" vs "drift_guard_read"; cause identity + message
//      preserved on both.
//  10. D86 drift-first ordering — drift detected during empty-findings
//      flow MUST NOT remove the stale sibling.
//  11. PromptFixStaleRemovalFailureError — rm on stale sibling fails;
//      stale survives + cause identity + message preserved.
//  12. PromptFixIoFailureError — atomic write fails; fix-prompt.txt
//      does not exist + phase="persist_fix_prompt" + cause identity +
//      message preserved.
//  13. RuntimeEnvInvalidError passthrough — `resolveProductVersionForReport`
//      throw propagates unchanged (NOT wrapped); fix-prompt.txt NOT
//      written (operation throws before persist).
//
// Mock pattern (per slice-1/2 + the (f) approval): vi.resetModules()
// + vi.doMock(...) + dynamic import + try/finally cleanup. All
// dynamically-imported tests narrow errors by `.name` (NOT instanceof
// against top-level static imports — different constructor identity
// after module reset). Mock filters use EXACT-PATH equality
// (`String(path) === expectedReportPath`) — not `endsWith` — to avoid
// intercepting resolver-internal fs calls.
//
// CLI-level coverage (--llm refusal, stderr copy, exit codes, harness
// wiring, stdout byte-identity) stays in prompt-fix.test.ts as
// drift-detection layer 1 — that file MUST continue to pass against
// the refactored PromptFixCommand.

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { RepoRootNotFoundError } from "@viberevert/core";
import { REPORT_FILE_SCHEMA_VERSION, ReportFileSchema } from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GenerateFixPromptOperationResult,
  generateFixPromptOperation,
  PromptFixEmptyFindingsError,
  PromptFixReportParseError,
} from "../../src/operations/generate-fix-prompt.js";
import {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  ReportNotFoundError,
} from "../../src/prompt-fix-targets.js";

const execFileAsync = promisify(execFile);

const FIXED_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const FIXED_TIME = "2026-01-01T00:00:00Z";

const SESSION_ID_A = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const REPORT_ID_A = "rpt_01JV8Y7W2M7ABCDEFGHJKMNPQR";
// Adversarial id: same shape as REPORT_ID_A but distinct ULID.
// Used by the sourceReportId test AND the empty-findings test to
// prove the operation returns ReportFile.report_id (JSON field),
// NOT the path-derived target.sourceId.
const REPORT_ID_B = "rpt_01JV8Y7W2M7ABCDEFGHJKMNPQS";

const STALE_FIX_PROMPT_MARKER = "STALE_FIX_PROMPT_FROM_PRIOR_RUN\n";
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let tmpRoot: string;
let originalCwd: string;

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
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\nchecks:\n  secrets: true\n");
}

/**
 * Build a valid ReportFile JSON string. Mirrors the existing
 * prompt-fix.test.ts pattern (lines 166-208) but with `reportId`
 * decoupled from any path-id concept — the JSON's `report_id` field
 * is purely set by this helper; the path id is set by `writeReport`
 * separately. Schema-parses on construction so any drift in
 * ReportFileSchema fails the test setup loudly.
 *
 * Schema refine #5 requires `report.session_id === report_id`, so
 * the nested `session_id` is also set to `reportId`.
 */
function makeReportFileJson(opts: {
  kind: "session_bound" | "ad_hoc";
  reportId: string;
  withFindings?: boolean;
  writtenAt?: string;
}): string {
  const sinceKind = opts.kind === "session_bound" ? "session_id" : "checkpoint_name";
  const sinceRef = opts.kind === "session_bound" ? opts.reportId : "baseline";
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
    report_id: opts.reportId,
    since_kind: sinceKind,
    since_ref: sinceRef,
    since_resolved_sha: FIXED_SHA,
    written_at: opts.writtenAt ?? FIXED_TIME,
    report: {
      schema_version: "1.0",
      session_id: opts.reportId,
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

/**
 * Plant a `report.json` at the canonical D26 storage path. The
 * `sourceId` determines the FOLDER NAME (path id); the `reportId`
 * (passed through to `makeReportFileJson` when `bytes` is not
 * supplied) determines the JSON `report_id` field. They can be
 * different — the adversarial sourceReportId test exploits this.
 */
async function writeReport(opts: {
  kind: "session_bound" | "ad_hoc";
  sourceId: string;
  reportId: string;
  withFindings?: boolean;
  bytes?: Buffer | string;
}): Promise<string> {
  const subdir = opts.kind === "session_bound" ? "sessions" : "reports";
  const dir = join(tmpRoot, ".viberevert", subdir, opts.sourceId);
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, "report.json");
  const content =
    opts.bytes ??
    makeReportFileJson({
      kind: opts.kind,
      reportId: opts.reportId,
      ...(opts.withFindings !== undefined ? { withFindings: opts.withFindings } : {}),
    });
  await writeFile(reportPath, content);
  return reportPath;
}

async function writeStaleFixPrompt(opts: {
  kind: "session_bound" | "ad_hoc";
  sourceId: string;
}): Promise<string> {
  const subdir = opts.kind === "session_bound" ? "sessions" : "reports";
  const fixPromptPath = join(tmpRoot, ".viberevert", subdir, opts.sourceId, "fix-prompt.txt");
  await mkdir(dirname(fixPromptPath), { recursive: true });
  await writeFile(fixPromptPath, STALE_FIX_PROMPT_MARKER);
  return fixPromptPath;
}

function reportPathFor(opts: { kind: "session_bound" | "ad_hoc"; sourceId: string }): string {
  const subdir = opts.kind === "session_bound" ? "sessions" : "reports";
  return join(tmpRoot, ".viberevert", subdir, opts.sourceId, "report.json");
}

function fixPromptPathFor(opts: { kind: "session_bound" | "ad_hoc"; sourceId: string }): string {
  const subdir = opts.kind === "session_bound" ? "sessions" : "reports";
  return join(tmpRoot, ".viberevert", subdir, opts.sourceId, "fix-prompt.txt");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-gfp-op-"));
  originalCwd = process.cwd();
  await setupRepo();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("generateFixPromptOperation — typed result shape + D81 byte-identity + sourceReportId source-of-truth", () => {
  it("ad_hoc success: returns typed result; persisted file is byte-identical to result.promptText (D81)", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: true,
    });

    const result: GenerateFixPromptOperationResult = await generateFixPromptOperation({
      cwd: tmpRoot,
      report: REPORT_ID_A,
    });

    expect(typeof result.promptText).toBe("string");
    expect(result.promptText.length).toBeGreaterThan(0);
    expect(result.fixPromptPath).toBe(fixPromptPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A }));
    expect(result.sourceReportId).toBe(REPORT_ID_A);

    const persistedText = await readFile(result.fixPromptPath, "utf8");
    expect(persistedText).toBe(result.promptText);
    expect(persistedText.length).toBe(result.promptText.length);
  });

  it("session_bound success: --session <id> resolves to .viberevert/sessions/<id>/; sourceReportId is sess_*", async () => {
    await writeReport({
      kind: "session_bound",
      sourceId: SESSION_ID_A,
      reportId: SESSION_ID_A,
      withFindings: true,
    });

    const result = await generateFixPromptOperation({
      cwd: tmpRoot,
      session: SESSION_ID_A,
    });

    expect(result.fixPromptPath).toBe(
      fixPromptPathFor({ kind: "session_bound", sourceId: SESSION_ID_A }),
    );
    // For session_bound, ReportFile.report_id is sess_<ULID> per
    // schema refine #1 — sourceReportId returns the sess_ id, not
    // the rpt_ form.
    expect(result.sourceReportId).toBe(SESSION_ID_A);

    const persistedText = await readFile(result.fixPromptPath, "utf8");
    expect(persistedText).toBe(result.promptText);
  });

  it("sourceReportId is read from ReportFile.report_id (JSON field), NOT from target.sourceId (path) — adversarial fixture: path id A, JSON report_id B", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_B,
      withFindings: true,
    });

    const result = await generateFixPromptOperation({
      cwd: tmpRoot,
      report: REPORT_ID_A,
    });

    // fixPromptPath comes from the resolver (path-derived) → REPORT_ID_A.
    expect(result.fixPromptPath).toBe(fixPromptPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A }));
    // sourceReportId comes from file.report_id (JSON-derived) → REPORT_ID_B.
    // Adversarial: if the operation used target.sourceId (path), this
    // would equal REPORT_ID_A and the test would fail.
    expect(result.sourceReportId).toBe(REPORT_ID_B);
  });
});

describe("generateFixPromptOperation — D99.M.21 cwd binding", () => {
  it("uses opts.cwd, NOT process.cwd(): persisted fix-prompt.txt lands at the exact opts.cwd path", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: true,
    });

    const unrelatedDir = await mkdtemp(join(tmpdir(), "viberevert-gfp-op-unrelated-"));
    try {
      process.chdir(unrelatedDir);

      const result = await generateFixPromptOperation({
        cwd: tmpRoot,
        report: REPORT_ID_A,
      });

      expect(result.fixPromptPath).toBe(
        fixPromptPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A }),
      );
      expect(await fileExists(result.fixPromptPath)).toBe(true);

      expect(
        await fileExists(
          join(unrelatedDir, ".viberevert", "reports", REPORT_ID_A, "fix-prompt.txt"),
        ),
      ).toBe(false);
    } finally {
      process.chdir(originalCwd);
      await rm(unrelatedDir, { recursive: true, force: true });
    }
  });
});

describe("generateFixPromptOperation — resolver passthrough errors (UNCHANGED, NOT wrapped)", () => {
  it("throws RepoRootNotFoundError when opts.cwd is not a git/viberevert project", async () => {
    const nonRepoDir = await mkdtemp(join(tmpdir(), "viberevert-gfp-op-norepo-"));
    try {
      await expect(generateFixPromptOperation({ cwd: nonRepoDir })).rejects.toBeInstanceOf(
        RepoRootNotFoundError,
      );
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true });
    }
  });

  it("throws ReportNotFoundError when no report exists in the repo", async () => {
    await expect(generateFixPromptOperation({ cwd: tmpRoot })).rejects.toBeInstanceOf(
      ReportNotFoundError,
    );
  });

  it("throws AmbiguousReportSelectionError when BOTH --session and --report are supplied", async () => {
    await expect(
      generateFixPromptOperation({
        cwd: tmpRoot,
        session: SESSION_ID_A,
        report: REPORT_ID_A,
      }),
    ).rejects.toBeInstanceOf(AmbiguousReportSelectionError);
  });

  it("--session with invalid id shape throws InvalidReportSelectionError (subjectKind='session')", async () => {
    let caught: unknown;
    try {
      await generateFixPromptOperation({ cwd: tmpRoot, session: "not-a-valid-ulid" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidReportSelectionError);
    expect((caught as InvalidReportSelectionError).subjectKind).toBe("session");
  });

  it("--report with invalid id shape throws InvalidReportSelectionError (subjectKind='report')", async () => {
    let caught: unknown;
    try {
      await generateFixPromptOperation({ cwd: tmpRoot, report: "not-a-valid-ulid" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidReportSelectionError);
    expect((caught as InvalidReportSelectionError).subjectKind).toBe("report");
  });
});

describe("generateFixPromptOperation — resolver-unknown wrap (PromptFixTargetResolutionError)", () => {
  it("wraps unexpected resolver throws as PromptFixTargetResolutionError; cause identity + message preserved (formatCause)", async () => {
    vi.resetModules();
    const syntheticCause = new Error("synthetic resolver crash for wrap test");
    vi.doMock("../../src/prompt-fix-targets.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/prompt-fix-targets.js")>();
      return {
        ...actual,
        resolvePromptFixReportTarget: async () => {
          throw syntheticCause;
        },
      };
    });
    try {
      const { generateFixPromptOperation: opUnderTest } = await import(
        "../../src/operations/generate-fix-prompt.js"
      );
      let caught: unknown;
      try {
        await opUnderTest({ cwd: tmpRoot });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("PromptFixTargetResolutionError");
      // formatCause(cause) preserved: wrapper's .message === underlying cause's .message.
      expect((caught as Error).message).toBe("synthetic resolver crash for wrap test");
      expect((caught as Error & { cause: unknown }).cause).toBe(syntheticCause);
    } finally {
      vi.doUnmock("../../src/prompt-fix-targets.js");
      vi.resetModules();
    }
  });
});

describe("generateFixPromptOperation — operation-public typed errors (real fixtures)", () => {
  it("PromptFixEmptyFindingsError: carried reportId comes from JSON file.report_id (NOT path), AND stale sibling is removed (no fix-prompt.txt remains) — adversarial sourceId=A, reportId=B", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_B,
      withFindings: false,
    });
    const staleFixPromptPath = await writeStaleFixPrompt({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
    });
    // Pre-check: stale exists AND carries the marker content.
    expect(await fileExists(staleFixPromptPath)).toBe(true);
    expect(await readFile(staleFixPromptPath, "utf8")).toBe(STALE_FIX_PROMPT_MARKER);

    let caught: unknown;
    try {
      await generateFixPromptOperation({ cwd: tmpRoot, report: REPORT_ID_A });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PromptFixEmptyFindingsError);
    // Adversarial: err.reportId is REPORT_ID_B (JSON field), NOT
    // REPORT_ID_A (path). Proves PromptFixEmptyFindingsError uses
    // file.report_id, not target.sourceId.
    expect((caught as PromptFixEmptyFindingsError).reportId).toBe(REPORT_ID_B);

    // Stale removed: single fileExists check proves both removal
    // AND no-replacement (file is GONE, not partial).
    expect(await fileExists(staleFixPromptPath)).toBe(false);
  });

  it("PromptFixReportParseError on malformed JSON (SyntaxError path); message + cause preserved", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      bytes: "{ this is not valid json",
    });

    let caught: unknown;
    try {
      await generateFixPromptOperation({ cwd: tmpRoot, report: REPORT_ID_A });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PromptFixReportParseError);
    expect((caught as PromptFixReportParseError).path).toBe(
      reportPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A }),
    );
    expect((caught as Error).message).toContain("Failed to parse source report");
    expect((caught as PromptFixReportParseError).cause).toBeInstanceOf(SyntaxError);
  });

  it("PromptFixReportParseError on schema-invalid JSON (ZodError path); message compacted to 'report does not match ReportFile schema' (preserved from old PromptFixCommand)", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      bytes: "{}",
    });

    let caught: unknown;
    try {
      await generateFixPromptOperation({ cwd: tmpRoot, report: REPORT_ID_A });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PromptFixReportParseError);
    expect((caught as Error).message).toContain("report does not match ReportFile schema");
    expect((caught as Error & { cause: unknown }).cause).toBeInstanceOf(Error);
  });

  it("BOM-preservation: leading U+FEFF in report.json is stripped before JSON.parse (preserved behavior from old PromptFixCommand)", async () => {
    const reportJsonString = makeReportFileJson({
      kind: "ad_hoc",
      reportId: REPORT_ID_A,
      withFindings: true,
    });
    const bytesWithBom = Buffer.concat([UTF8_BOM, Buffer.from(reportJsonString, "utf8")]);
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      bytes: bytesWithBom,
    });

    const result = await generateFixPromptOperation({ cwd: tmpRoot, report: REPORT_ID_A });
    expect(result.promptText.length).toBeGreaterThan(0);
    expect(result.sourceReportId).toBe(REPORT_ID_A);
    expect(await readFile(result.fixPromptPath, "utf8")).toBe(result.promptText);
  });
});

describe("generateFixPromptOperation — D88 drift + phase field + D86 ordering + write/rm/runtime-env failures (mocked node:fs/promises, ../atomic.js, and ../runtime-env.js boundaries)", () => {
  it("PromptFixDriftDetectedError on byte-level mid-render drift: NO fix-prompt.txt is written (D88 + lock #1)", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: true,
    });
    const expectedReportPath = reportPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A });
    const expectedFixPromptPath = fixPromptPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A });
    expect(await fileExists(expectedFixPromptPath)).toBe(false);

    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      let reportReadCount = 0;
      return {
        ...actual,
        readFile: async (
          path: Parameters<typeof actual.readFile>[0],
          ...args: unknown[]
        ): Promise<Buffer | string> => {
          if (String(path) === expectedReportPath) {
            reportReadCount += 1;
            if (reportReadCount === 1) {
              // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves the union.
              return actual.readFile(path, ...(args as any));
            }
            return Buffer.from("DRIFTED_BYTES_DIFFERENT_FROM_READ_A");
          }
          // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves the union.
          return actual.readFile(path, ...(args as any));
        },
      };
    });
    try {
      const { generateFixPromptOperation: opUnderTest } = await import(
        "../../src/operations/generate-fix-prompt.js"
      );
      let caught: unknown;
      try {
        await opUnderTest({ cwd: tmpRoot, report: REPORT_ID_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("PromptFixDriftDetectedError");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(await fileExists(expectedFixPromptPath)).toBe(false);
  });

  it("PromptFixReadFailureError.phase === 'initial_read' when the first readFile fails; cause identity + message preserved", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: true,
    });
    const expectedReportPath = reportPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A });
    const syntheticInitialReadCause = Object.assign(new Error("synthetic EACCES on initial read"), {
      code: "EACCES",
    });

    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      let reportReadCount = 0;
      return {
        ...actual,
        readFile: async (
          path: Parameters<typeof actual.readFile>[0],
          ...args: unknown[]
        ): Promise<Buffer | string> => {
          if (String(path) === expectedReportPath) {
            reportReadCount += 1;
            if (reportReadCount === 1) {
              throw syntheticInitialReadCause;
            }
          }
          // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves the union.
          return actual.readFile(path, ...(args as any));
        },
      };
    });
    try {
      const { generateFixPromptOperation: opUnderTest } = await import(
        "../../src/operations/generate-fix-prompt.js"
      );
      let caught: unknown;
      try {
        await opUnderTest({ cwd: tmpRoot, report: REPORT_ID_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("PromptFixReadFailureError");
      const readErr = caught as Error & {
        phase: "initial_read" | "drift_guard_read";
        path: string;
        cause: unknown;
      };
      expect(readErr.phase).toBe("initial_read");
      expect(readErr.path).toBe(expectedReportPath);
      expect(readErr.cause).toBe(syntheticInitialReadCause);
      expect((caught as Error).message).toContain("synthetic EACCES on initial read");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("PromptFixReadFailureError.phase === 'drift_guard_read' when the second readFile fails; cause identity + message preserved", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: true,
    });
    const expectedReportPath = reportPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A });
    const syntheticDriftReadCause = Object.assign(
      new Error("synthetic ENOENT on drift-guard read"),
      { code: "ENOENT" },
    );

    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      let reportReadCount = 0;
      return {
        ...actual,
        readFile: async (
          path: Parameters<typeof actual.readFile>[0],
          ...args: unknown[]
        ): Promise<Buffer | string> => {
          if (String(path) === expectedReportPath) {
            reportReadCount += 1;
            if (reportReadCount === 1) {
              // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves the union.
              return actual.readFile(path, ...(args as any));
            }
            throw syntheticDriftReadCause;
          }
          // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves the union.
          return actual.readFile(path, ...(args as any));
        },
      };
    });
    try {
      const { generateFixPromptOperation: opUnderTest } = await import(
        "../../src/operations/generate-fix-prompt.js"
      );
      let caught: unknown;
      try {
        await opUnderTest({ cwd: tmpRoot, report: REPORT_ID_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("PromptFixReadFailureError");
      const readErr = caught as Error & {
        phase: "initial_read" | "drift_guard_read";
        path: string;
        cause: unknown;
      };
      expect(readErr.phase).toBe("drift_guard_read");
      expect(readErr.path).toBe(expectedReportPath);
      expect(readErr.cause).toBe(syntheticDriftReadCause);
      expect((caught as Error).message).toContain("synthetic ENOENT on drift-guard read");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("D86 drift-first ordering: drift detected during empty-findings flow MUST NOT remove the stale sibling (drift check runs BEFORE rm)", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: false,
    });
    const staleFixPromptPath = await writeStaleFixPrompt({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
    });
    expect(await fileExists(staleFixPromptPath)).toBe(true);
    const expectedReportPath = reportPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A });

    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      let reportReadCount = 0;
      return {
        ...actual,
        readFile: async (
          path: Parameters<typeof actual.readFile>[0],
          ...args: unknown[]
        ): Promise<Buffer | string> => {
          if (String(path) === expectedReportPath) {
            reportReadCount += 1;
            if (reportReadCount === 1) {
              // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves the union.
              return actual.readFile(path, ...(args as any));
            }
            return Buffer.from("DRIFTED_TO_NON_EMPTY_REPORT_BYTES");
          }
          // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves the union.
          return actual.readFile(path, ...(args as any));
        },
      };
    });
    try {
      const { generateFixPromptOperation: opUnderTest } = await import(
        "../../src/operations/generate-fix-prompt.js"
      );
      let caught: unknown;
      try {
        await opUnderTest({ cwd: tmpRoot, report: REPORT_ID_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("PromptFixDriftDetectedError");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(await fileExists(staleFixPromptPath)).toBe(true);
    expect(await readFile(staleFixPromptPath, "utf8")).toBe(STALE_FIX_PROMPT_MARKER);
  });

  it("PromptFixStaleRemovalFailureError when rm of stale sibling fails: stale survives, cause identity + message preserved", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: false,
    });
    const staleFixPromptPath = await writeStaleFixPrompt({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
    });
    expect(await fileExists(staleFixPromptPath)).toBe(true);
    const expectedFixPromptPath = fixPromptPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A });

    vi.resetModules();
    const syntheticRmCause = Object.assign(new Error("synthetic EACCES on stale rm"), {
      code: "EACCES",
    });
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rm: async (path: Parameters<typeof actual.rm>[0], ...args: unknown[]): Promise<void> => {
          if (String(path) === expectedFixPromptPath) {
            throw syntheticRmCause;
          }
          // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves the union.
          return actual.rm(path, ...(args as any));
        },
      };
    });
    try {
      const { generateFixPromptOperation: opUnderTest } = await import(
        "../../src/operations/generate-fix-prompt.js"
      );
      let caught: unknown;
      try {
        await opUnderTest({ cwd: tmpRoot, report: REPORT_ID_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("PromptFixStaleRemovalFailureError");
      const rmErr = caught as Error & { path: string; cause: unknown };
      expect(rmErr.path).toBe(expectedFixPromptPath);
      expect(rmErr.cause).toBe(syntheticRmCause);
      expect((caught as Error).message).toContain("synthetic EACCES on stale rm");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(await fileExists(staleFixPromptPath)).toBe(true);
  });

  it("PromptFixIoFailureError when writeFileAtomic fails: phase='persist_fix_prompt', cause identity + message preserved, fix-prompt.txt does NOT exist", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: true,
    });
    const expectedFixPromptPath = fixPromptPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A });
    expect(await fileExists(expectedFixPromptPath)).toBe(false);

    vi.resetModules();
    const syntheticWriteCause = Object.assign(new Error("synthetic ENOSPC on persist"), {
      code: "ENOSPC",
    });
    vi.doMock("../../src/atomic.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/atomic.js")>();
      return {
        ...actual,
        writeFileAtomic: async (path: string, _data: string | Buffer): Promise<void> => {
          if (path === expectedFixPromptPath) {
            throw syntheticWriteCause;
          }
          return actual.writeFileAtomic(path, _data);
        },
      };
    });
    try {
      const { generateFixPromptOperation: opUnderTest } = await import(
        "../../src/operations/generate-fix-prompt.js"
      );
      let caught: unknown;
      try {
        await opUnderTest({ cwd: tmpRoot, report: REPORT_ID_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("PromptFixIoFailureError");
      const ioErr = caught as Error & {
        phase: "persist_fix_prompt";
        path: string;
        cause: unknown;
      };
      expect(ioErr.phase).toBe("persist_fix_prompt");
      expect(ioErr.path).toBe(expectedFixPromptPath);
      expect(ioErr.cause).toBe(syntheticWriteCause);
      expect((caught as Error).message).toContain("synthetic ENOSPC on persist");
    } finally {
      vi.doUnmock("../../src/atomic.js");
      vi.resetModules();
    }

    expect(await fileExists(expectedFixPromptPath)).toBe(false);
  });

  it("RuntimeEnvInvalidError passthrough: resolveProductVersionForReport throw propagates UNCHANGED; fix-prompt.txt NOT written (operation throws before persist)", async () => {
    await writeReport({
      kind: "ad_hoc",
      sourceId: REPORT_ID_A,
      reportId: REPORT_ID_A,
      withFindings: true,
    });
    const expectedFixPromptPath = fixPromptPathFor({ kind: "ad_hoc", sourceId: REPORT_ID_A });
    expect(await fileExists(expectedFixPromptPath)).toBe(false);

    vi.resetModules();
    const syntheticRuntimeError = Object.assign(new Error("synthetic runtime env invalid"), {
      name: "RuntimeEnvInvalidError",
    });
    vi.doMock("../../src/runtime-env.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/runtime-env.js")>();
      return {
        ...actual,
        resolveProductVersionForReport: (): string => {
          throw syntheticRuntimeError;
        },
      };
    });
    try {
      const { generateFixPromptOperation: opUnderTest } = await import(
        "../../src/operations/generate-fix-prompt.js"
      );
      let caught: unknown;
      try {
        await opUnderTest({ cwd: tmpRoot, report: REPORT_ID_A });
      } catch (err) {
        caught = err;
      }
      // Passthrough: the operation re-throws the EXACT object — not
      // wrapped, not transformed. Object-identity assertion proves
      // it's the original Error, not a re-thrown copy.
      expect(caught).toBe(syntheticRuntimeError);
    } finally {
      vi.doUnmock("../../src/runtime-env.js");
      vi.resetModules();
    }

    expect(await fileExists(expectedFixPromptPath)).toBe(false);
  });
});
