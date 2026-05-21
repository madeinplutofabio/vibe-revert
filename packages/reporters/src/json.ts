// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// renderJson: schema-verbatim JSON rendering of a ReportFile with
// optional D38 threshold filtering.
//
// =============================================================================
// CONTRACT (D45 + D38 + D54)
// =============================================================================
//
// Returns a value that JSON.stringify can serialize. The value is:
//   - When threshold is undefined OR "low": the input ReportFile,
//     unchanged (same reference per applyThreshold's no-op
//     short-circuit). This is the schema-verbatim view — optional
//     fields that are ABSENT in the input remain absent (NOT
//     rewritten to null).
//   - When threshold is set: a NEW ReportFile-shaped value with
//     report.results filtered, report.risk_level + report.summary
//     recomputed, report.changed_files preserved. The persisted
//     on-disk ReportFile is NEVER mutated.
//
// The return type is declared `unknown` per the D45 lock — the
// caller (CLI) treats this as opaque JSON-stringifiable data and
// passes it directly to JSON.stringify. Internally the runtime
// shape is always ReportFile, but the signature decouples consumers
// from that detail (room to evolve the rendered view in the future
// without a public-API breaking change).
//
// =============================================================================
// M C JSON EXCEPTION TO D20 (locked, schema-verbatim semantics)
// =============================================================================
//
// Per D38's locked exception to D20's "null for missing fields"
// rule: persisted-artifact JSON is schema-verbatim, with optional
// fields (e.g., staged_only, report.checkpoint_id, report.task,
// report.summary, report.ended_at, report.agent_command) OMITTED
// when absent — NOT rewritten to null. JSON.stringify's default
// `undefined`-omitting behavior produces this naturally for objects
// constructed via the conditional-spread pattern (applyThreshold
// uses this for the recomputed summary; the input ReportFile from
// session-format's strict schema already conforms).
//
// D20's "null for missing fields" rule continues to apply UNCHANGED
// to CLI projection outputs (e.g., `viberevert sessions --json`'s
// `task: null`), which are CLI-synthesized display objects, not
// persisted-artifact JSON.

import { applyThreshold } from "./threshold.js";
import type { RenderInput } from "./types.js";

/**
 * Render a ReportFile as a JSON-stringifiable value, applying
 * `input.threshold` per D38's output-filter semantics.
 *
 * Returns the input ReportFile reference unchanged when no threshold
 * is set (the no-op short-circuit path of applyThreshold). Otherwise
 * returns a new ReportFile-shaped value with results filtered and
 * derived fields (risk_level, summary) recomputed.
 *
 * Pure synchronous: no I/O, no Date.now(), no allocations beyond
 * what applyThreshold needs for the filtering case.
 *
 * The caller (CLI) is responsible for serialization
 * (`JSON.stringify(value, null, 2) + "\n"`) and stdout emission per
 * the D29 boundary — reporters never write to terminal streams.
 */
export function renderJson(input: RenderInput): unknown {
  return applyThreshold(input.file, input.threshold);
}
