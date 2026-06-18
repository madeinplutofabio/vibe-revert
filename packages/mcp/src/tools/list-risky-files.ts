// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// list_risky_files MCP tool: command-harness backend over
// ReportCommand --json (handler projects to per-file list).
//
// Per D99.E + D99.Q row 4 + D99.U:
//
//   - Single argv: ["report", "--json", ...session/report].
//   - Output: ReportFile (canonical, validated by ReportFileSchema).
//
//   - Projection (Option B per locked Slice 3.4 direction):
//     Source = ChangedFile[] UNION evidence[].file paths.
//     Per-path:
//       max_severity = max(ChangedFile.risk_level if present,
//                          all finding.level values touching this path)
//       finding_count = number of DISTINCT findings touching this
//                       path (count a finding ONCE per path even if
//                       it has multiple evidence entries for the
//                       same file -- do NOT count evidence rows).
//
//   - Sort: max_severity DESC, finding_count DESC, path ASC
//     (severity rank: critical > high > medium > low).
//
//   - D99.U cap: files.length > 500 -> slice(0, 500) +
//     truncated:true + omitted_count: <full_length - 500>.
//
//   - Side-effect class: A (ReportCommand is read-only per D47).
//
// SDK-free: no @modelcontextprotocol/sdk import.

import { ReportCommand } from "@viberevert/cli-commands";
import {
  type CheckResult,
  compareLevel,
  type ReportFile,
  ReportFileSchema,
  type RiskLevel,
} from "@viberevert/session-format";
import { z } from "zod";

import { runJsonCommandHarness } from "../command-harness.js";
import { type ToolEnvelope, toInvalidToolInputEnvelope } from "../envelope.js";
import type { JsonSchemaObject, ToolDefinition, ToolHandler } from "../tools.js";

// ============================================================================
// Input schema
// ============================================================================

const listRiskyFilesInputSchema = z
  .object({
    session: z.string().min(1).optional(),
    report: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => !(v.session !== undefined && v.report !== undefined), {
    message: "session and report are mutually exclusive",
    path: ["session"],
  });

type ListRiskyFilesInput = z.infer<typeof listRiskyFilesInputSchema>;

// ============================================================================
// Output data shape (D99.Q row 4)
// ============================================================================

export type RiskyFileEntry = {
  readonly path: string;
  readonly max_severity: RiskLevel;
  readonly finding_count: number;
};

export type ListRiskyFilesData = {
  readonly files: readonly RiskyFileEntry[];
  readonly truncated?: true;
  readonly omitted_count?: number;
};

// ============================================================================
// D99.U cap
// ============================================================================

const FILES_CAP = 500;

// ============================================================================
// Helpers (module-private)
// ============================================================================

function buildArgv(input: ListRiskyFilesInput): readonly string[] {
  const argv: string[] = ["report", "--json"];
  if (input.session !== undefined) argv.push("--session", input.session);
  if (input.report !== undefined) argv.push("--report", input.report);
  return argv;
}

/**
 * Take max of two RiskLevel values via compareLevel.
 */
function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return compareLevel(a, b) >= 0 ? a : b;
}

/**
 * Project ChangedFile[] + findings to the per-file risky-file
 * list per Option B locked direction.
 *
 * Algorithm:
 *
 *   Pass 1: seed the map from ChangedFile[]. Each entry contributes
 *           its own engine-classified risk_level (a per-file
 *           classification independent of findings).
 *
 *   Pass 2: walk findings. For each finding:
 *     a. Collect the SET of distinct files in this finding's
 *        evidence (deduped within the finding so a finding
 *        contributes at most 1 to finding_count per path).
 *     b. For each path in the set: add the path to the map (or
 *        merge into existing entry) and add this finding to the
 *        path's findings set.
 *
 *   Pass 3: build per-file entries. max_severity is max of
 *           (ChangedFile.risk_level if present, all finding levels
 *           in the path's findings set). finding_count is the
 *           size of the findings set.
 *
 *   Pass 4: sort by [max_severity DESC, finding_count DESC, path ASC].
 *
 *   Pass 5: apply D99.U cap (500 entries) with truncated +
 *           omitted_count when exceeded.
 *
 * Finding identity: we use the finding OBJECT as a Set member
 * (object identity). Each CheckResult in the ReportFile.results
 * array is a distinct object, so identity-based dedup gives the
 * "count a finding ONCE per path" semantic the locked direction
 * specifies, even when two evidence entries point at the same
 * file inside the same finding.
 */
function projectRiskyFiles(report: ReportFile): ListRiskyFilesData {
  type Entry = {
    readonly findings: Set<CheckResult>;
    changedFileLevel: RiskLevel | null;
  };
  const map = new Map<string, Entry>();

  // Pass 1: seed from ChangedFile[].
  for (const cf of report.report.changed_files) {
    map.set(cf.path, { findings: new Set(), changedFileLevel: cf.risk_level });
  }

  // Pass 2: walk findings.
  for (const finding of report.report.results) {
    const pathsForThisFinding = new Set<string>();
    for (const ev of finding.evidence) {
      if (ev.file !== undefined) pathsForThisFinding.add(ev.file);
    }
    for (const path of pathsForThisFinding) {
      let entry = map.get(path);
      if (entry === undefined) {
        entry = { findings: new Set(), changedFileLevel: null };
        map.set(path, entry);
      }
      entry.findings.add(finding);
    }
  }

  // Pass 3: build per-file entries. Skip any path that ended up
  // with neither a ChangedFile classification nor any findings
  // (shouldn't happen given Pass 1+2 always set one of them).
  const entries: RiskyFileEntry[] = [];
  for (const [path, entry] of map) {
    let severity: RiskLevel | undefined;
    if (entry.changedFileLevel !== null) severity = entry.changedFileLevel;
    for (const f of entry.findings) {
      severity = severity === undefined ? f.level : maxLevel(severity, f.level);
    }
    if (severity === undefined) continue;
    entries.push({
      path,
      max_severity: severity,
      finding_count: entry.findings.size,
    });
  }

  // Pass 4: sort.
  entries.sort((a, b) => {
    const lvlCmp = compareLevel(b.max_severity, a.max_severity); // DESC
    if (lvlCmp !== 0) return lvlCmp;
    if (b.finding_count !== a.finding_count) return b.finding_count - a.finding_count; // DESC
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });

  // Pass 5: D99.U cap.
  if (entries.length > FILES_CAP) {
    return {
      files: entries.slice(0, FILES_CAP),
      truncated: true,
      omitted_count: entries.length - FILES_CAP,
    };
  }
  return { files: entries };
}

// ============================================================================
// Public surface (D99.G: exactly `definition` + `handler`)
// ============================================================================

export const definition: ToolDefinition<"list_risky_files"> = {
  name: "list_risky_files",
  description:
    "Project a check report into a per-file risky-files list (path, max_severity, finding_count) " +
    "sorted by [max_severity DESC, finding_count DESC, path ASC]. Read-only (class A per D99.V). " +
    "Capped at 500 entries per D99.U.",
  inputSchema: z.toJSONSchema(listRiskyFilesInputSchema, { target: "draft-7" }) as JsonSchemaObject,
};

export const handler: ToolHandler<ListRiskyFilesData> = async (
  input,
  context,
): Promise<ToolEnvelope<ListRiskyFilesData>> => {
  const parsedInput = listRiskyFilesInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return toInvalidToolInputEnvelope("list_risky_files", parsedInput.error);
  }

  const harness = await runJsonCommandHarness<ReportFile>({
    command: ReportCommand,
    toolName: "list_risky_files",
    argv: buildArgv(parsedInput.data),
    repoRoot: context.repoRoot,
    successExitCodes: [0],
    parser: ReportFileSchema,
    schemaName: "ReportFileSchema",
  });
  if (harness.kind === "error") return harness.envelope;

  return { ok: true, data: projectRiskyFiles(harness.parsed) };
};
