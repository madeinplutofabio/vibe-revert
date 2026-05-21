// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public types for @viberevert/reporters. The package surface is
// intentionally small: ONE format-discriminator string union + ONE
// input-shape interface. Function signatures live in their
// respective implementation files (json.ts, terminal.ts, markdown.ts,
// render.ts).
//
// All types come from @viberevert/session-format — reporters owns NO
// schema definitions of its own and NEVER reaches into deeper
// session-format modules (per the locked public-API rule of
// session-format).

import type { ReportFile, RiskLevel } from "@viberevert/session-format";

// =============================================================================
// ReporterFormat
// =============================================================================

/**
 * The set of output formats the reporters package supports. Locked
 * per D45 — adding a new format (e.g., "html", "sarif", "junit")
 * requires touching the render() dispatcher AND adding a per-format
 * renderer module. Not deprecating any of these without a major
 * version bump.
 *
 *   - "terminal": ANSI-free plain text, fixed 80-col layout, used
 *     by the CLI's default human-facing output. No color in M C
 *     (D55); the CLI may wrap with a color helper later.
 *   - "json": schema-verbatim ReportFile value (or a filtered
 *     view when input.threshold is set). The CLI's `--json` mode.
 *   - "markdown": CommonMark only, no HTML, no GFM extensions.
 *     The CLI's `--markdown` mode.
 */
export type ReporterFormat = "terminal" | "json" | "markdown";

// =============================================================================
// RenderInput
// =============================================================================

/**
 * Single argument shape for every renderer. Locked per D45.
 *
 * `file` is the on-disk `ReportFile` wrapper (NOT the bare
 * `SessionReport`). Reporters operate on the wrapper because some
 * file-level metadata (e.g., `kind`, `since_kind`, `since_ref`,
 * `since_resolved_sha`, `written_at`, `staged_only`) is relevant to
 * the rendered output's header — these fields don't exist on the
 * bare `SessionReport`. The bare report is reachable as
 * `file.report`.
 *
 * `threshold` is the OUTPUT-FILTER per D38. Findings with `level`
 * STRICTLY LESS than `threshold` are removed from `report.results`
 * in the rendered output (and `report.risk_level` + `report.summary`
 * are recomputed against the filtered set). `report.changed_files`
 * is NEVER filtered by `threshold` — it's the diff inventory and
 * must remain complete regardless of view.
 *
 * When `threshold` is omitted (or equal to `"low"` — the floor of
 * the RiskLevel enum), no threshold filtering occurs. JSON rendering
 * returns a schema-verbatim view of the original `ReportFile`;
 * terminal and markdown render the same unfiltered report content in
 * their respective text formats.
 *
 * `productVersion` is REQUIRED. Reporters MUST NOT reach back into
 * the CLI's `package.json` to discover the running version — that
 * would invert the D29 package-boundary rule (reporters depend
 * ONLY on session-format). The CLI resolves the version (via
 * `resolveProductVersionForReport` per Step 9) and passes the
 * string in. Markdown uses it for the locked footer ("Generated
 * by VibeRevert v<version>"). Other renderers may accept the same
 * input shape without reaching across package boundaries.
 */
export interface RenderInput {
  readonly file: ReportFile;
  readonly threshold?: RiskLevel;
  readonly productVersion: string;
}
