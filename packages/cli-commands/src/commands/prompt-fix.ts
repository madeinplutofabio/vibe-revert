// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert prompt-fix [--session <s>] [--report <r>] [--llm]` —
// render a deterministic, agent-safe fix-prompt from a persisted
// risk report per M E D80-D97.
//
// =============================================================================
// Post-extraction architecture (M G1a Step 1, Option D — Slice 3)
// =============================================================================
//
// Domain logic lives in `../operations/generate-fix-prompt.ts`. This
// Command is now a thin presentation shell:
//   1. --llm pre-resolve refusal (D84 lock #1 — fires BEFORE operation
//      invocation so the reserved flag NEVER reaches domain code that
//      could mutate fix-prompt.txt).
//   2. Call generateFixPromptOperation(...).
//   3. Map typed errors to existing human stderr copy via
//      handleKnownError — every line byte-identical to the
//      pre-extraction implementation.
//   4. Write result.promptText to stdout AS-IS (no trailing-newline
//      append) — D81 second sink, completes the three-sink chain
//      (renderer → persisted file → stdout).
//
// All 13 architectural locks (D84/D88/D86/D81/D90.6/D90.7/D90.1-3/
// D29/D17c/D19/D92/D93/version-deferral/explicit-error-wrapping)
// previously documented in this file's header are now owned by the
// operation. See `operations/generate-fix-prompt.ts` for the
// canonical documentation.
//
// =============================================================================
// Command-side locks (preserved from pre-extraction PromptFixCommand)
// =============================================================================
//
// 1. **D84 --llm pre-resolve precedence.** The --llm check fires
//    BEFORE the operation call, so invoking
//    `viberevert prompt-fix --llm` outside a repo OR with a malformed
//    id OR against a missing report still surfaces the locked
//    deferred-feature copy from D93, NOT a repo-not-found /
//    invalid-id / no-report error. The flag is declared with
//    `hidden: true` per D90.4; the architectural-invariants test in
//    substep 11 grep-asserts the literal `hidden: true` near the
//    declaration.
//
// 2. **D81 stdout sink: raw write.** `this.context.stdout.write(
//    result.promptText)` writes the operation's returned promptText
//    AS-IS. NO trailing-newline append, NO formatting, NO wrapper.
//    The operation already persisted the SAME bytes to the sibling
//    fix-prompt.txt (D81 first sink); writing wrapped/normalized
//    text here would break the three-sink byte-identity contract.
//
// 3. **D92 + D93 exit codes + refusal copy.** Exit 0 ONLY when the
//    operation succeeds AND the stdout write completes. Exit 1 for
//    every refusal and every error. NEVER exit 2 — prompt-fix is a
//    renderer, not a gate. Stderr copy for each refusal class
//    matches D93 verbatim. `InvalidReportSelectionError`'s message
//    from `report-paths.ts` differs slightly from D93's locked
//    wording for the CLI surface, so `handleKnownError` OVERRIDES
//    that class's message with the D93 form ("Invalid <kind> id
//    <quoted>. Expected the form <kind>_<26-character Crockford
//    ULID>.") — the other two M C refusal classes
//    (AmbiguousReportSelectionError, ReportNotFoundError) carry
//    D93-compatible messages already and are surfaced verbatim. The
//    override uses explicit `if (subjectKind === "session")` and
//    `if (subjectKind === "report")` branches with a terminating
//    `throw err` so a future widening of the union is caught loudly
//    instead of silently misclassified.
//
// 4. **handleKnownError exhaustive mapping pattern.** Every typed
//    error class this command can encounter is EXPLICITLY mapped —
//    never relies on a catch-all. Unknown errors are re-thrown so
//    Clipanion surfaces them as a crash with stack trace (loud
//    failure is correct for genuinely-unexpected exceptions). The
//    exhaustive mapping covers:
//       - RepoRootNotFoundError (M B repo discovery)
//       - AmbiguousReportSelectionError (D93 verbatim)
//       - InvalidReportSelectionError (D93 OVERRIDE)
//       - ReportNotFoundError (D93 verbatim)
//       - RuntimeEnvInvalidError (test-only env override path)
//       - PromptFixTargetResolutionError (operation-public wrap of
//         unexpected resolver throws)
//       - PromptFixReadFailureError (operation-public read failure,
//         carries phase: "initial_read" | "drift_guard_read")
//       - PromptFixReportParseError (operation-public JSON / schema)
//       - PromptFixDriftDetectedError (operation-public D93 drift)
//       - PromptFixStaleRemovalFailureError (operation-public D93)
//       - PromptFixIoFailureError (operation-public D93 write failure,
//         carries phase: "persist_fix_prompt")
//       - PromptFixEmptyFindingsError (operation-public D86 — the
//         only typed error whose D93 stderr is rendered from a
//         carried field [err.reportId] rather than from err.message)

import { RepoRootNotFoundError } from "@viberevert/core";
import { Command, Option } from "clipanion";
import {
  type GenerateFixPromptOperationResult,
  generateFixPromptOperation,
  PromptFixDriftDetectedError,
  PromptFixEmptyFindingsError,
  PromptFixIoFailureError,
  PromptFixReadFailureError,
  PromptFixReportParseError,
  PromptFixStaleRemovalFailureError,
  PromptFixTargetResolutionError,
} from "../operations/generate-fix-prompt.js";
import {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  ReportNotFoundError,
} from "../prompt-fix-targets.js";
import { RuntimeEnvInvalidError } from "../runtime-env.js";

// =============================================================================
// Centralized typed-error → stderr mapping (Command-side lock #4)
// =============================================================================

/**
 * Map every typed error class this command can encounter to clean
 * stderr + exit 1. Returns 1 for known errors; re-throws for unknown
 * errors so Clipanion surfaces them as a crash with stack trace
 * (loud failure is correct for genuinely-unexpected exceptions).
 *
 * Special-case: `InvalidReportSelectionError` from `report-paths.ts`
 * carries a message format that differs slightly from D93's locked
 * wording for the prompt-fix CLI surface. Per D93, the prompt-fix
 * stderr copy is "Invalid <kind> id <quoted>. Expected the form
 * <kind>_<26-character Crockford ULID>." — this handler OVERRIDES
 * the class's `.message` with the D93 form, branching EXPLICITLY on
 * `err.subjectKind` ("session" vs "report") with a terminating
 * `throw err` for any unrecognized value (so a future widening of
 * the union is caught loudly instead of silently misclassified).
 *
 * Special-case: `PromptFixEmptyFindingsError` renders the D93 stderr
 * template from `err.reportId` (NOT from `err.message`). The
 * operation's error carries a brief diagnostic message; the locked
 * D93 user-facing copy lives here.
 */
function handleKnownError(stderr: { write(s: string): unknown }, err: unknown): number {
  if (err instanceof RepoRootNotFoundError) {
    stderr.write(
      "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
    );
    stderr.write("Run `viberevert init` to create a project here.\n");
    return 1;
  }
  if (err instanceof AmbiguousReportSelectionError) {
    // D93 reuse verbatim — M C error class carries the locked copy.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  if (err instanceof InvalidReportSelectionError) {
    // D93 OVERRIDE — M C error class's wording differs from the
    // locked prompt-fix surface copy. Explicit subjectKind branching
    // with a terminating throw for unrecognized values.
    if (err.subjectKind === "session") {
      stderr.write(
        `Invalid session id ${JSON.stringify(err.value)}. ` +
          "Expected the form sess_<26-character Crockford ULID>.\n",
      );
      return 1;
    }
    if (err.subjectKind === "report") {
      stderr.write(
        `Invalid report id ${JSON.stringify(err.value)}. ` +
          "Expected the form rpt_<26-character Crockford ULID>.\n",
      );
      return 1;
    }
    // A future widening of subjectKind would land here. Fail loud
    // rather than silently misclassify as one of the existing kinds.
    throw err;
  }
  if (err instanceof ReportNotFoundError) {
    // D93 reuse verbatim — M C error class carries the locked copy.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  if (err instanceof PromptFixEmptyFindingsError) {
    // D86 / D93 — locked stderr template, sourced from err.reportId
    // (which is ReportFile.report_id per the operation contract; the
    // semantic source of truth, NOT the path-derived target.sourceId).
    // Preserved byte-identical from pre-extraction PromptFixCommand
    // (old lines 697-700) — only the data source changes (was
    // `file.report_id` in execute(), now `err.reportId` in this
    // catch). Same runtime value.
    stderr.write(
      `Report ${err.reportId} contains no findings; nothing to prompt-fix. ` +
        "Run `viberevert check ...` against fresh changes to generate a report with findings.\n",
    );
    return 1;
  }
  if (
    err instanceof RuntimeEnvInvalidError ||
    err instanceof PromptFixTargetResolutionError ||
    err instanceof PromptFixReadFailureError ||
    err instanceof PromptFixReportParseError ||
    err instanceof PromptFixDriftDetectedError ||
    err instanceof PromptFixStaleRemovalFailureError ||
    err instanceof PromptFixIoFailureError
  ) {
    // Each class carries a locked or fully-formatted message per
    // D93. Surface verbatim. The operation preserved every message
    // template byte-identical to the pre-extraction file-local
    // classes — see `operations/generate-fix-prompt.ts` per-class
    // docstrings for the preservation references.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  // Unknown error — re-throw so Clipanion surfaces it.
  throw err;
}

// =============================================================================
// Command class
// =============================================================================

export class PromptFixCommand extends Command {
  static override paths = [["prompt-fix"]];

  static override usage = Command.Usage({
    description: "Render a deterministic, agent-safe fix-prompt from a persisted risk report",
    details: `
Reads the most recent risk report (or the one specified via --session / --report)
and renders a text-only prompt suitable for pasting into a coding agent. The
prompt is also persisted as a sibling 'fix-prompt.txt' next to the source
'report.json'. Stdout and the persisted file are byte-identical.

Resolution order matches 'viberevert report':
  1. --session <sess> and --report <rpt> are mutually exclusive.
  2. --report <rpt>  → .viberevert/reports/<rpt>/report.json
  3. --session <sess> → .viberevert/sessions/<sess>/report.json
  4. Otherwise: the active session's report if present, else the latest
     report across both stores.

Refusals (exit 1, no fix-prompt.txt emitted):
  - --llm is reserved for a future release (not available in v0.7.0).
  - No matching report found.
  - Source report contains no findings (empty findings; stale
    fix-prompt.txt is removed if present).
  - Source report changed during rendering (drift guard).
  - Failed to write the prompt or remove a stale sibling.
    `,
    examples: [
      ["Render the latest report's fix-prompt", "$0 prompt-fix"],
      [
        "Render a specific session's prompt",
        "$0 prompt-fix --session sess_01JV8Z0N6E7ABCDEFGHJKMNPQR",
      ],
      [
        "Render a specific ad-hoc report's prompt",
        "$0 prompt-fix --report rpt_01JV8Z0N6E7ABCDEFGHJKMNPQR",
      ],
    ],
  });

  // --session and --report are validated by the operation's underlying
  // resolver (single source of truth). The command does NOT pre-validate
  // id shape — it catches InvalidReportSelectionError / Ambiguous /
  // NotFound from the operation and maps to D93 copy.
  session = Option.String("--session", {
    description:
      "Load .viberevert/sessions/<sess>/report.json explicitly. Mutually exclusive with --report.",
  });

  report = Option.String("--report", {
    description:
      "Load .viberevert/reports/<rpt>/report.json explicitly. Mutually exclusive with --session.",
  });

  // D84 + D90.4: --llm is the reserved hidden seam for v0.8.x+. The
  // `hidden: true` literal MUST stay verbatim near this declaration
  // — the architectural-invariants test in substep 11 grep-asserts
  // the paired tokens within a small window.
  llm = Option.Boolean("--llm", false, {
    hidden: true,
    description: "[reserved] LLM-backed prompt rendering. Not available in v0.7.0; see roadmap.",
  });

  override async execute(): Promise<number> {
    // -------------------------------------------------------------------------
    // STEP 1: --llm pre-resolve check (Command-side lock #1 / D84).
    // Fires BEFORE the operation call so the deferred-feature copy
    // is deterministic regardless of repo state, AND so the reserved
    // flag NEVER reaches domain code that could mutate fix-prompt.txt.
    // -------------------------------------------------------------------------

    if (this.llm) {
      this.context.stderr.write(
        "--llm is reserved for a future release. Not available in v0.7.0; see roadmap.\n",
      );
      return 1;
    }

    // -------------------------------------------------------------------------
    // STEP 2: call the typed operation. All domain logic lives in
    // `operations/generate-fix-prompt.ts`. Every typed-error class
    // the operation throws is mapped to D93 stderr in
    // handleKnownError. Unknown errors re-throw via handleKnownError's
    // terminal `throw err` so Clipanion surfaces them as a crash.
    // -------------------------------------------------------------------------

    let result: GenerateFixPromptOperationResult;
    try {
      result = await generateFixPromptOperation({
        cwd: process.cwd(),
        ...(this.session !== undefined ? { session: this.session } : {}),
        ...(this.report !== undefined ? { report: this.report } : {}),
      });
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }

    // -------------------------------------------------------------------------
    // STEP 3: D81 second sink — write result.promptText to stdout
    // AS-IS. NO trailing-newline, NO formatting, NO wrapper.
    //
    // The operation already persisted the SAME promptText bytes to
    // the sibling fix-prompt.txt (D81 first sink, byte-identical
    // via writeFileAtomic). This write completes the three-sink
    // chain: renderer → persisted file → stdout. Wrapping the text
    // here (e.g., `${result.promptText}\n`) would break the
    // byte-identity contract — stdout would have an extra newline
    // vs the persisted file.
    // -------------------------------------------------------------------------

    this.context.stdout.write(result.promptText);
    return 0;
  }
}
