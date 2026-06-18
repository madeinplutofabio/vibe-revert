// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// D99.Q.1 dedicated test: exit code 2 from CheckCommand means
// "blocker findings detected" and MUST surface as a SUCCESSFUL
// envelope (ok:true) with blocked:true. Finding risk is a result,
// not a tool failure.

import type { RunCommandInProcessResult } from "@viberevert/cli-commands";
import type { ReportFile } from "@viberevert/session-format";
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

function makeBlockerReport(): ReportFile {
  return {
    schema_version: "1.0",
    kind: "ad_hoc",
    report_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
    since_kind: "git_ref",
    since_ref: "HEAD~1",
    since_resolved_sha: "abc1234567890abc1234567890abc1234567890",
    written_at: "2026-06-01T00:00:00Z",
    report: {
      schema_version: "1.0",
      session_id: "rpt_01ABCDEFGHJKMNPQRSTVWXYZ12",
      started_at: "2026-06-01T00:00:00Z",
      detected_frameworks: [],
      risk_level: "critical",
      changed_files: [],
      results: [
        {
          id: "secrets.regex.aws-key",
          title: "Possible AWS key leaked",
          level: "critical",
          confidence: "high",
          category: "secrets",
          message: "Pattern matches an AWS access key",
          evidence: [{ detail: "match in src/config.ts" }],
          recommendation: "Rotate the key and remove it from the diff.",
        },
      ],
      rollback_available: false,
    },
  };
}

beforeEach(() => {
  mockedRun.mockReset();
});

describe("check_repo D99.Q.1: exit 2 = blocker (ok:true, blocked:true)", () => {
  it("returns ok:true with exit_code:2 and blocked:true", async () => {
    const report = makeBlockerReport();
    const result: RunCommandInProcessResult = {
      exitCode: 2,
      stdoutBytes: Buffer.from(JSON.stringify(report), "utf8"),
      stderrText: "",
      stdoutTruncated: false,
      stdoutBytesOmitted: 0,
      stderrTruncated: false,
      stderrBytesOmitted: 0,
    };
    mockedRun.mockResolvedValueOnce(result);
    const env = await handler({}, { repoRoot: ABS_REPO_ROOT });
    expect(env.ok).toBe(true);
    if (env.ok === true && "report" in env.data) {
      expect(env.data.exit_code).toBe(2);
      expect(env.data.blocked).toBe(true);
      expect(env.data.report.report.results.length).toBe(1);
      expect(env.data.report.report.results[0]?.level).toBe("critical");
    } else {
      throw new Error("expected report branch with exit_code 2");
    }
  });

  it("blocked status comes from exit code, NOT from --threshold (D38)", async () => {
    // CheckCommand's exit-code gate uses risk.block_on (default
    // critical), NOT --threshold. So even when the client passes
    // threshold:"low", the blocker status follows the actual exit
    // code surfaced by CheckCommand.
    const report = makeBlockerReport();
    mockedRun.mockResolvedValueOnce({
      exitCode: 2,
      stdoutBytes: Buffer.from(JSON.stringify(report), "utf8"),
      stderrText: "",
      stdoutTruncated: false,
      stdoutBytesOmitted: 0,
      stderrTruncated: false,
      stderrBytesOmitted: 0,
    });
    const env = await handler({ threshold: "low" }, { repoRoot: ABS_REPO_ROOT });
    if (env.ok === true && "report" in env.data) {
      expect(env.data.blocked).toBe(true);
    } else {
      throw new Error("expected blocked:true regardless of threshold");
    }
  });
});
