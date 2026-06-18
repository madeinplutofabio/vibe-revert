// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Malformed-stdout failure modes for check_repo.
//
// Two distinct failure paths must return clean envelope errors
// (NEVER raw SyntaxError / ZodError):
//
//   1. INVALID JSON -- JSON.parse rejects the stdout bytes.
//   2. INVALID SHAPE -- JSON parses but ReportFileSchema.parse
//      rejects (missing required fields, wrong types, refinement
//      failures, etc.).
//
// Both must surface as INTERNAL_ERROR with a sanitized message.
// Neither must throw, leak stack traces, or expose raw input bytes.

import type { RunCommandInProcessResult } from "@viberevert/cli-commands";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@viberevert/cli-commands", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/cli-commands")>(
    "@viberevert/cli-commands",
  );
  return {
    ...actual,
    runCommandInProcess: vi.fn(),
  };
});

const { handler } = await import("../src/tools/check-repo.js");
const cliCommands = await import("@viberevert/cli-commands");
const mockedRun = vi.mocked(cliCommands.runCommandInProcess);

const ABS_REPO_ROOT = "/abs/repo";

function makeResult(stdoutText: string, exitCode: 0 | 2 = 0): RunCommandInProcessResult {
  return {
    exitCode,
    stdoutBytes: Buffer.from(stdoutText, "utf8"),
    stderrText: "",
    stdoutTruncated: false,
    stdoutBytesOmitted: 0,
    stderrTruncated: false,
    stderrBytesOmitted: 0,
  };
}

beforeEach(() => {
  mockedRun.mockReset();
});

describe("check_repo: malformed stdout (invalid JSON)", () => {
  it("returns INTERNAL_ERROR envelope when stdout is not valid JSON", async () => {
    mockedRun.mockResolvedValueOnce(makeResult("not json at all"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
      expect(env.error.message).toMatch(/not valid JSON/);
    }
  });

  it("returns INTERNAL_ERROR envelope for truncated mid-object JSON", async () => {
    mockedRun.mockResolvedValueOnce(makeResult('{"schema_version":"1.0",'));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("does NOT throw on invalid JSON (handler always returns envelope)", async () => {
    mockedRun.mockResolvedValueOnce(makeResult("}{"));
    await expect(handler({}, { repoRoot: ABS_REPO_ROOT })).resolves.toBeDefined();
  });
});

describe("check_repo: malformed stdout (schema-invalid ReportFile)", () => {
  it("returns INTERNAL_ERROR envelope when JSON parses but is empty {}", async () => {
    mockedRun.mockResolvedValueOnce(makeResult("{}"));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
      expect(env.error.message).toMatch(/ReportFileSchema/);
    }
  });

  it("returns INTERNAL_ERROR envelope when ReportFile has wrong shape (missing required fields)", async () => {
    mockedRun.mockResolvedValueOnce(makeResult('{"schema_version":"1.0","kind":"ad_hoc"}'));
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("returns INTERNAL_ERROR envelope when ReportFile has wrong kind discriminator", async () => {
    mockedRun.mockResolvedValueOnce(
      makeResult(
        JSON.stringify({
          schema_version: "1.0",
          kind: "made_up_kind",
          report_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
          since_kind: "git_ref",
          since_ref: "HEAD",
          since_resolved_sha: "x".repeat(40),
          written_at: "2026-06-01T00:00:00Z",
          report: {
            schema_version: "1.0",
            session_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
            started_at: "2026-06-01T00:00:00Z",
            detected_frameworks: [],
            risk_level: "low",
            changed_files: [],
            results: [],
            rollback_available: false,
          },
        }),
      ),
    );
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("does NOT throw on schema-invalid JSON", async () => {
    mockedRun.mockResolvedValueOnce(makeResult("{}"));
    await expect(handler({}, { repoRoot: ABS_REPO_ROOT })).resolves.toBeDefined();
  });
});
