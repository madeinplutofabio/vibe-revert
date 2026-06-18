// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// check_repo MCP tool: command-harness backend over CheckCommand.
//
// Per D99.E + D99.Q.1 + D99.W + D99.U.
//
// REFACTORED in Slice 3.4 onto the shared runJsonCommandHarness
// helper. Mechanics common to all four command-backed tools
// (isAbsolute guard, runCommandInProcess call, stdoutTruncated
// gate, exit-code mapping, decode + JSON.parse + schema validate,
// stderr sanitization) now live in command-harness.ts. This file
// retains only check_repo-specific concerns:
//
//   - input schema (Zod) + safeParse (D99.Z)
//   - argv construction (--json, --since, --staged, --threshold, --task)
//   - data projection: exit-code -> {report | report_summary, blocked, ...}
//   - D99.U 1 MiB cap discriminated-union switch with fixed-point bytes_omitted
//
// Schema source-of-truth: definition.inputSchema is derived from
// checkRepoInputSchema via z.toJSONSchema({target:"draft-7"}) so
// the two stay in lockstep.
//
// SDK-free: no @modelcontextprotocol/sdk import.

import { CheckCommand } from "@viberevert/cli-commands";
import { type CheckResult, type ReportFile, ReportFileSchema } from "@viberevert/session-format";
import { z } from "zod";

import { runJsonCommandHarness } from "../command-harness.js";
import { type ToolEnvelope, toInvalidToolInputEnvelope } from "../envelope.js";
import type { JsonSchemaObject, ToolDefinition, ToolHandler } from "../tools.js";

// ============================================================================
// Input schema
// ============================================================================

const checkRepoInputSchema = z
  .object({
    since: z.string().optional(),
    staged: z.boolean().optional(),
    threshold: z.enum(["low", "medium", "high", "critical"]).optional(),
    task: z.string().optional(),
  })
  .strict();

type CheckRepoInput = z.infer<typeof checkRepoInputSchema>;

// ============================================================================
// Output data shape (D99.Q.1 discriminated union)
// ============================================================================

export type CheckRepoData =
  | {
      readonly report: ReportFile;
      readonly exit_code: 0 | 2;
      readonly blocked: boolean;
      readonly truncated?: false;
    }
  | {
      readonly report_summary: {
        readonly report_id?: string;
        readonly finding_count: number;
        readonly severity_counts: {
          readonly critical: number;
          readonly high: number;
          readonly medium: number;
          readonly low: number;
        };
        readonly findings_omitted: number;
      };
      readonly exit_code: 0 | 2;
      readonly blocked: boolean;
      readonly truncated: true;
      readonly bytes_omitted: number;
    };

// ============================================================================
// D99.U cap (1 MiB on serialized data payload)
// ============================================================================

const REPORT_RESPONSE_CAP_BYTES = 1_048_576;

// ============================================================================
// Helpers (module-private)
// ============================================================================

function countBySeverity(results: readonly CheckResult[]): {
  critical: number;
  high: number;
  medium: number;
  low: number;
} {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of results) {
    counts[r.level] += 1;
  }
  return counts;
}

function buildCheckArgv(input: CheckRepoInput): readonly string[] {
  const argv: string[] = ["check", "--json"];
  if (input.since !== undefined) argv.push("--since", input.since);
  if (input.staged === true) argv.push("--staged");
  if (input.threshold !== undefined) argv.push("--threshold", input.threshold);
  if (input.task !== undefined) argv.push("--task", input.task);
  return argv;
}

/**
 * Map exit 0/2 to a CheckRepoData payload, applying the D99.U
 * 1 MiB cap discriminated-union switch when the serialized FULL
 * data payload exceeds the cap.
 *
 * bytes_omitted is computed via a fixed-point loop because the
 * numeric value itself contributes to the serialized summary
 * payload's byte length. Converges in 2-3 iterations.
 */
function buildSuccessData(report: ReportFile, exitCode: 0 | 2): CheckRepoData {
  const blocked = exitCode === 2;
  const fullDataJson = JSON.stringify({ report, exit_code: exitCode, blocked });
  const fullDataBytes = Buffer.byteLength(fullDataJson, "utf8");
  if (fullDataBytes <= REPORT_RESPONSE_CAP_BYTES) {
    return { report, exit_code: exitCode, blocked };
  }
  const severityCounts = countBySeverity(report.report.results);
  const findingCount = report.report.results.length;
  const summary = {
    report_id: report.report_id,
    finding_count: findingCount,
    severity_counts: severityCounts,
    findings_omitted: findingCount,
  } as const;

  let bytesOmitted = 0;
  for (let i = 0; i < 10; i += 1) {
    const candidateJson = JSON.stringify({
      report_summary: summary,
      exit_code: exitCode,
      blocked,
      truncated: true as const,
      bytes_omitted: bytesOmitted,
    });
    const candidateBytes = Buffer.byteLength(candidateJson, "utf8");
    const next = Math.max(0, fullDataBytes - candidateBytes);
    if (next === bytesOmitted) break;
    bytesOmitted = next;
  }

  return {
    report_summary: summary,
    exit_code: exitCode,
    blocked,
    truncated: true,
    bytes_omitted: bytesOmitted,
  };
}

// ============================================================================
// Public surface (D99.G: exactly `definition` + `handler`)
// ============================================================================

export const definition: ToolDefinition<"check_repo"> = {
  name: "check_repo",
  description:
    "Run safety checks against the working tree or staged diff and return the resulting ReportFile (or summary when large). " +
    "Side-effecting (class B per D99.V): always persists the ReportFile under .viberevert/.",
  inputSchema: z.toJSONSchema(checkRepoInputSchema, { target: "draft-7" }) as JsonSchemaObject,
};

export const handler: ToolHandler<CheckRepoData> = async (
  input,
  context,
): Promise<ToolEnvelope<CheckRepoData>> => {
  const parsedInput = checkRepoInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return toInvalidToolInputEnvelope("check_repo", parsedInput.error);
  }

  const harness = await runJsonCommandHarness({
    command: CheckCommand,
    toolName: "check_repo",
    argv: buildCheckArgv(parsedInput.data),
    repoRoot: context.repoRoot,
    successExitCodes: [0, 2],
    parser: ReportFileSchema,
    schemaName: "ReportFileSchema",
  });
  if (harness.kind === "error") return harness.envelope;

  // harness.exitCode is GUARANTEED to be 0 or 2 (in successExitCodes).
  const exitCode = harness.exitCode === 2 ? 2 : 0;
  const data = buildSuccessData(harness.parsed, exitCode);
  return { ok: true, data };
};
