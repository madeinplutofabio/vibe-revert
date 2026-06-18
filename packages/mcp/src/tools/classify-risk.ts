// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// classify_risk MCP tool: command-harness backend over ReportCommand
// --json (handler projects to severity counts).
//
// Per D99.E + D99.Q row 3:
//
//   - Single argv: ["report", "--json", ...session/report].
//   - Output: ReportFile (canonical, validated by ReportFileSchema).
//   - Projection: count CheckResult entries by level
//     -> { critical, high, medium, low }.
//
// No threshold input: classify_risk reports the full per-level
// histogram; the consumer can interpret thresholds themselves
// from the returned counts. Threshold filtering would lose
// information (e.g., "only 0 critical found" vs "20 medium
// found and 0 critical" are very different signals).
//
// No D99.U cap: the response is exactly four numbers; well under
// any reasonable cap.
//
// Side-effect class: A (ReportCommand is read-only per D47).
//
// SDK-free: no @modelcontextprotocol/sdk import.

import { ReportCommand } from "@viberevert/cli-commands";
import { type CheckResult, type ReportFile, ReportFileSchema } from "@viberevert/session-format";
import { z } from "zod";

import { runJsonCommandHarness } from "../command-harness.js";
import { type ToolEnvelope, toInvalidToolInputEnvelope } from "../envelope.js";
import type { JsonSchemaObject, ToolDefinition, ToolHandler } from "../tools.js";

// ============================================================================
// Input schema
// ============================================================================

const classifyRiskInputSchema = z
  .object({
    session: z.string().min(1).optional(),
    report: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => !(v.session !== undefined && v.report !== undefined), {
    message: "session and report are mutually exclusive",
    path: ["session"],
  });

type ClassifyRiskInput = z.infer<typeof classifyRiskInputSchema>;

// ============================================================================
// Output data shape (D99.Q row 3)
// ============================================================================

export type ClassifyRiskData = {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
};

// ============================================================================
// Helpers (module-private)
// ============================================================================

function buildArgv(input: ClassifyRiskInput): readonly string[] {
  const argv: string[] = ["report", "--json"];
  if (input.session !== undefined) argv.push("--session", input.session);
  if (input.report !== undefined) argv.push("--report", input.report);
  return argv;
}

function countBySeverity(results: readonly CheckResult[]): ClassifyRiskData {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of results) {
    counts[r.level] += 1;
  }
  return counts;
}

// ============================================================================
// Public surface (D99.G: exactly `definition` + `handler`)
// ============================================================================

export const definition: ToolDefinition<"classify_risk"> = {
  name: "classify_risk",
  description:
    "Project a check report's findings into per-severity counts (critical, high, medium, low). " +
    "Read-only (class A per D99.V); no threshold input -- returns the full per-level histogram.",
  inputSchema: z.toJSONSchema(classifyRiskInputSchema, { target: "draft-7" }) as JsonSchemaObject,
};

export const handler: ToolHandler<ClassifyRiskData> = async (
  input,
  context,
): Promise<ToolEnvelope<ClassifyRiskData>> => {
  const parsedInput = classifyRiskInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return toInvalidToolInputEnvelope("classify_risk", parsedInput.error);
  }

  const harness = await runJsonCommandHarness<ReportFile>({
    command: ReportCommand,
    toolName: "classify_risk",
    argv: buildArgv(parsedInput.data),
    repoRoot: context.repoRoot,
    successExitCodes: [0],
    parser: ReportFileSchema,
    schemaName: "ReportFileSchema",
  });
  if (harness.kind === "error") return harness.envelope;

  return { ok: true, data: countBySeverity(harness.parsed.report.results) };
};
