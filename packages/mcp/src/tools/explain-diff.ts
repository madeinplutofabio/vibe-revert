// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// explain_diff MCP tool: command-harness backend over ReportCommand
// (2-call: --json metadata extraction + --markdown body).
//
// Per D99.E + D99.Q row 2 + D99.U:
//
//   - 2 invocations per call: JSON FIRST to resolve which report
//     to render (the active session/active report may shift
//     between calls), then markdown SECOND with an EXPLICIT
//     identifier from the JSON result to prevent a TOCTOU
//     mismatch where metadata and body come from different
//     reports.
//
//   - JSON call argv: ["report", "--json", ...session/report,
//     ...threshold]. Output: ReportFile.
//   - Markdown call argv: ["report", "--markdown",
//     "--session" | "--report", <id from JSON>, ...threshold].
//     Output: CommonMark string.
//
//   - Threshold (when supplied) is passed to BOTH calls so the
//     filtered findings + recomputed risk_level + recomputed
//     summary in the metadata MATCH the filtered findings shown
//     in the markdown body.
//
//   - D99.U: markdown cap at 256 KiB. Truncation respects UTF-8
//     character boundaries via truncateUtf8Text.
//
//   - Side-effect class: A (ReportCommand is read-only per D47).
//
// Schema source-of-truth: definition.inputSchema is derived from
// explainDiffInputSchema via z.toJSONSchema. ReportFile is
// validated via ReportFileSchema (canonical, from session-format).
//
// SDK-free: no @modelcontextprotocol/sdk import.

import { ReportCommand } from "@viberevert/cli-commands";
import {
  type ReportFile,
  ReportFileSchema,
  type RiskLevel,
  type SinceKind,
} from "@viberevert/session-format";
import { z } from "zod";

import {
  runJsonCommandHarness,
  runRawCommandHarness,
  truncateUtf8Text,
} from "../command-harness.js";
import { type ToolEnvelope, toInvalidToolInputEnvelope } from "../envelope.js";
import type { JsonSchemaObject, ToolDefinition, ToolHandler } from "../tools.js";

// ============================================================================
// Input schema
// ============================================================================

const explainDiffInputSchema = z
  .object({
    session: z.string().min(1).optional(),
    report: z.string().min(1).optional(),
    threshold: z.enum(["low", "medium", "high", "critical"]).optional(),
  })
  .strict()
  .refine((v) => !(v.session !== undefined && v.report !== undefined), {
    message: "session and report are mutually exclusive",
    path: ["session"],
  });

type ExplainDiffInput = z.infer<typeof explainDiffInputSchema>;

// ============================================================================
// Output data shape (D99.Q row 2)
// ============================================================================

export type ExplainDiffData = {
  readonly markdown: string;
  readonly report_id: string;
  readonly report_metadata: {
    readonly kind: "session_bound" | "ad_hoc";
    readonly since_kind: SinceKind;
    readonly since_ref: string;
    readonly since_resolved_sha: string;
    readonly written_at: string;
    readonly risk_level: RiskLevel;
    readonly finding_count: number;
    readonly changed_file_count: number;
  };
  readonly truncated?: true;
  readonly bytes_omitted?: number;
};

// ============================================================================
// D99.U markdown cap (256 KiB)
// ============================================================================

const MARKDOWN_CAP_BYTES = 256 * 1024;

// ============================================================================
// Helpers (module-private)
// ============================================================================

function buildJsonArgv(input: ExplainDiffInput): readonly string[] {
  const argv: string[] = ["report", "--json"];
  if (input.session !== undefined) argv.push("--session", input.session);
  if (input.report !== undefined) argv.push("--report", input.report);
  if (input.threshold !== undefined) argv.push("--threshold", input.threshold);
  return argv;
}

/**
 * Build the markdown-call argv using the EXPLICIT identifier
 * resolved from the JSON call's parsed ReportFile. Avoids the
 * TOCTOU race where active session/report could shift between
 * the two calls (e.g., another `viberevert check` writes a new
 * report between our calls).
 *
 * Kind discriminator picks --session vs --report:
 *   - session_bound -> --session <report_id>
 *   - ad_hoc        -> --report <report_id>
 *
 * Threshold is forwarded so the markdown body's filtering matches
 * the metadata's recomputed risk_level / finding_count.
 */
function buildMarkdownArgv(resolvedReport: ReportFile, input: ExplainDiffInput): readonly string[] {
  const argv: string[] = ["report", "--markdown"];
  if (resolvedReport.kind === "session_bound") {
    argv.push("--session", resolvedReport.report_id);
  } else {
    argv.push("--report", resolvedReport.report_id);
  }
  if (input.threshold !== undefined) argv.push("--threshold", input.threshold);
  return argv;
}

function buildMetadata(report: ReportFile): ExplainDiffData["report_metadata"] {
  return {
    kind: report.kind,
    since_kind: report.since_kind,
    since_ref: report.since_ref,
    since_resolved_sha: report.since_resolved_sha,
    written_at: report.written_at,
    risk_level: report.report.risk_level,
    finding_count: report.report.results.length,
    changed_file_count: report.report.changed_files.length,
  };
}

// ============================================================================
// Public surface (D99.G: exactly `definition` + `handler`)
// ============================================================================

export const definition: ToolDefinition<"explain_diff"> = {
  name: "explain_diff",
  description:
    "Render a CommonMark explanation of a check report alongside the report's metadata. " +
    "Reads an existing ReportFile (read-only, class A per D99.V); does not run new checks.",
  inputSchema: z.toJSONSchema(explainDiffInputSchema, { target: "draft-7" }) as JsonSchemaObject,
};

export const handler: ToolHandler<ExplainDiffData> = async (
  input,
  context,
): Promise<ToolEnvelope<ExplainDiffData>> => {
  const parsedInput = explainDiffInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return toInvalidToolInputEnvelope("explain_diff", parsedInput.error);
  }

  // Call 1: JSON for metadata + identifier resolution.
  const jsonHarness = await runJsonCommandHarness({
    command: ReportCommand,
    toolName: "explain_diff",
    argv: buildJsonArgv(parsedInput.data),
    repoRoot: context.repoRoot,
    successExitCodes: [0],
    parser: ReportFileSchema,
    schemaName: "ReportFileSchema",
  });
  if (jsonHarness.kind === "error") return jsonHarness.envelope;

  // Call 2: markdown with EXPLICIT identifier from the parsed
  // ReportFile to avoid TOCTOU mismatch.
  const mdHarness = await runRawCommandHarness({
    command: ReportCommand,
    toolName: "explain_diff",
    argv: buildMarkdownArgv(jsonHarness.parsed, parsedInput.data),
    repoRoot: context.repoRoot,
    successExitCodes: [0],
  });
  if (mdHarness.kind === "error") return mdHarness.envelope;

  // D99.U cap: truncate markdown at 256 KiB UTF-8 char boundary.
  const capped = truncateUtf8Text(mdHarness.stdoutText, MARKDOWN_CAP_BYTES);

  const metadata = buildMetadata(jsonHarness.parsed);
  const base = {
    markdown: capped.text,
    report_id: jsonHarness.parsed.report_id,
    report_metadata: metadata,
  } as const;
  const data: ExplainDiffData = capped.truncated
    ? { ...base, truncated: true, bytes_omitted: capped.bytesOmitted }
    : base;
  return { ok: true, data };
};
