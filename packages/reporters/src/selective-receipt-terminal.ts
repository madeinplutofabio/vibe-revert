// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// renderSelectiveReceiptTerminal: ANSI-free plain text for a selective
// rollback receipt.
//
// =============================================================================
// Contract
// =============================================================================
//
//   - PURE STRING. The CLI writes it; reporters never touch a stream.
//   - ANSI-FREE and ASCII-only in everything this renderer emits, so the
//     output is byte-stable across platforms and locales and safe to commit as
//     a golden. The single exception is `out_of_scope_notice`, rendered
//     verbatim from the schema literal, which is ASCII today.
//   - FIXED 80 COLUMNS. No terminal probing. Long paths are not truncated or
//     wrapped; the terminal wraps them visually.
//   - NEWLINE-TERMINATED.
//
// Layout matches `receipt-terminal.ts` deliberately: same rule characters,
// same `Label:` column, same bracketed uppercase tokens, same `(none)`
// placeholder. A user who has read one rollback receipt can read the other
// without relearning where anything is.
//
// =============================================================================
// Exhaustiveness is the point of this renderer
// =============================================================================
//
// Every union in the receipt is switched on with a `never` binding in the
// default branch, so a schema arm added later fails to COMPILE here rather
// than rendering as `undefined` or vanishing. That matters more for this
// artifact than for the legacy one, because several of its arms exist
// precisely to say "we could not determine this":
//
//     results[].outcome = indeterminate       the mutation was authorized and
//                                             no per-path claim can be made
//     first_verification.state = not_run      no gate result exists at all
//     post_command_integrity.observation_*    the comparison could not be made
//
// Rendering any of those as a blank, or omitting the section, would turn "we
// do not know" into "nothing happened", which is the one misreading a recovery
// tool must never invite. So each has explicit copy and each says what it
// means for the reader's next action.
//
// =============================================================================
// Layout
// =============================================================================
//
//   ================================================================================
//   VibeRevert Selective Rollback Receipt          [or "... Receipt (DRY-RUN)"]
//   ================================================================================
//
//   Rollback ID:      <rb_id>
//   Session ID:       <sess_id>
//   Checkpoint ID:    <cp_id>
//   Contribution:     <sha256>
//   Mode:             <dry_run | apply>
//   Pre-rollback CP:  <cp_id>                      [apply only]
//   Outcome:          <succeeded | failed>         [apply only]
//   Eligibility:      <eligible | ...>             [dry-run only]
//   Written at:       <iso>
//
//   --------------------------------------------------------------------------------
//   Selectors
//   --------------------------------------------------------------------------------
//
//   --only <glob>                                  [one line per supplied value]
//   --risk <level>
//
//   --------------------------------------------------------------------------------
//   Resolved Change Groups (<N>)
//   --------------------------------------------------------------------------------
//
//   <cg_id>
//
//   --------------------------------------------------------------------------------
//   Results (<N>)
//   --------------------------------------------------------------------------------
//
//   [<OUTCOME>]  <path>
//     Change group: <cg_id>
//     Reason: <reason>                             [iff present]
//
//   --------------------------------------------------------------------------------
//   First Verification                             [apply only]
//   --------------------------------------------------------------------------------
//   ...
//   --------------------------------------------------------------------------------
//   Project Verification                           [apply only]
//   --------------------------------------------------------------------------------
//   ...
//   --------------------------------------------------------------------------------
//   Post-Command Integrity                         [apply only]
//   --------------------------------------------------------------------------------
//   ...
//   --------------------------------------------------------------------------------
//   Out of Scope
//   --------------------------------------------------------------------------------
//
//   <file.out_of_scope_notice>

import type {
  ApplyPathResult,
  DryRunPathResult,
  FailureSummary,
  FirstVerification,
  PostCommandIntegrity,
  ProjectVerification,
  RollbackSelectors,
  SelectiveRollbackReceipt,
  VerifyCommandRecord,
} from "@viberevert/session-format";

import type { SelectiveReceiptRenderInput } from "./selective-receipt-types.js";

const RULE_HEAVY = "=".repeat(80);
const RULE_LIGHT = "-".repeat(80);
const LABEL_WIDTH = 18;

/** `Label:` padded to a fixed column, matching the legacy receipt's table. */
const field = (label: string, value: string): string =>
  `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;

const section = (title: string): readonly string[] => [RULE_LIGHT, title, RULE_LIGHT, ""];

/** Schema tokens are shown uppercased in brackets, as in the legacy receipt. */
const token = (value: string): string => `[${value.toUpperCase()}]`;

const failureLine = (failure: FailureSummary): string =>
  `${token(failure.error_code)} ${failure.message}`;

/**
 * The selectors, one per supplied value, in the flag form the user typed.
 *
 * Absent families are omitted rather than shown empty: the schema forbids an
 * empty family precisely so absence is the only spelling of "not used", and
 * printing `--only (none)` would contradict that.
 */
function selectorLines(selectors: RollbackSelectors): readonly string[] {
  const lines: string[] = [];
  for (const value of selectors.only ?? []) lines.push(`--only ${value}`);
  for (const value of selectors.except ?? []) lines.push(`--except ${value}`);
  for (const value of selectors.finding ?? []) lines.push(`--finding ${value}`);
  if (selectors.risk !== undefined) lines.push(`--risk ${selectors.risk}`);
  return lines;
}

function resultLines(results: readonly (DryRunPathResult | ApplyPathResult)[]): readonly string[] {
  if (results.length === 0) return ["(none)", ""];
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${token(result.outcome)}  ${result.path}`);
    lines.push(`  Change group: ${result.change_group_id}`);
    if (result.reason !== undefined) lines.push(`  Reason: ${result.reason}`);
    lines.push("");
  }
  return lines;
}

/**
 * What the first integrity pass found, or why there is nothing to report.
 *
 * `not_run` gets a sentence rather than a token, because its one cause is that
 * the gate result was unavailable, which means the mutation may have been
 * authorized and no verification exists to describe it.
 */
function firstVerificationLines(verification: FirstVerification): readonly string[] {
  switch (verification.state) {
    case "completed": {
      const a = verification.assessment;
      return [
        field("State", "completed"),
        field("Selected verified", String(a.selected_verified)),
        field("Unselected checked", String(a.unselected_checked_count)),
        field("HEAD unchanged", String(a.head_unchanged)),
        "",
        ...(a.unselected_violations.length === 0
          ? ["Unselected violations: (none)", ""]
          : [
              `Unselected violations (${a.unselected_violations.length}):`,
              ...a.unselected_violations.map((path) => `  - ${path}`),
              "",
            ]),
      ];
    }
    case "failed":
      return [
        field("State", "failed"),
        "",
        "The verification started and threw, so no per-path facts exist.",
        failureLine(verification.failure),
        "",
      ];
    case "not_run":
      return [
        field("State", "not_run"),
        field("Reason", verification.reason),
        "",
        "No gate result exists, so the transplant was never verified. The",
        "mutation may still have been authorized; treat every result as",
        "indeterminate and recover from the pre-rollback checkpoint.",
        "",
      ];
    default: {
      const unhandled: never = verification;
      return unhandled;
    }
  }
}

function commandLines(record: VerifyCommandRecord): readonly string[] {
  const argv = [record.command, ...record.args].join(" ");
  const result = record.result;
  switch (result.outcome) {
    case "exited":
      return [
        `${token(result.exit_code === 0 ? "passed" : "failed")}  ${argv}`,
        `  Exit code: ${result.exit_code}`,
      ];
    case "signalled":
      return [`${token("signalled")}  ${argv}`, `  Signal: ${result.signal}`];
    case "unresolved":
      return [`${token("unresolved")}  ${argv}`, "  The command name resolved to nothing on PATH."];
    case "unsupported_target":
      return [
        `${token("unsupported_target")}  ${argv}`,
        `  Resolved to: ${result.resolved_target}`,
        `  Kind: ${result.kind}`,
      ];
    case "not_run":
      return [`${token("not_run")}  ${argv}`, `  Reason: ${result.reason}`];
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

function projectVerificationLines(verification: ProjectVerification): readonly string[] {
  switch (verification.state) {
    case "not_configured":
      return [
        field("State", "not_configured"),
        "",
        "The session configured no verification commands.",
        "",
      ];
    case "skipped":
      return [field("State", "skipped"), field("Reason", verification.reason), ""];
    case "completed":
      return verification.commands.length === 0
        ? [field("State", "completed"), "", "(none)", ""]
        : [
            field("State", "completed"),
            "",
            ...verification.commands.flatMap((record) => [...commandLines(record), ""]),
          ];
    case "runner_failed":
      return [
        field("State", "runner_failed"),
        "",
        "The runner itself faulted. This is not a command reporting failure.",
        failureLine(verification.failure),
        "",
      ];
    default: {
      const unhandled: never = verification;
      return unhandled;
    }
  }
}

/**
 * The second integrity pass, which is what catches a verification command that
 * modified the project it was asked to check.
 */
function postCommandIntegrityLines(integrity: PostCommandIntegrity): readonly string[] {
  switch (integrity.state) {
    case "not_run":
      return [field("State", "not_run"), field("Reason", integrity.reason), ""];
    case "clean":
      return [
        field("State", "clean"),
        "",
        "The project is byte-for-byte what the transplant left behind.",
        "",
      ];
    case "project_mutated": {
      const group = (title: string, paths: readonly string[]): readonly string[] =>
        paths.length === 0
          ? []
          : [`${title} (${paths.length}):`, ...paths.map((p) => `  - ${p}`), ""];
      return [
        field("State", "project_mutated"),
        field("HEAD moved", String(integrity.head_moved)),
        "",
        "A verification command changed the project after the transplant.",
        "",
        ...group("Added", integrity.added_paths),
        ...group("Removed", integrity.removed_paths),
        ...group("Changed", integrity.changed_paths),
        ...group("Topology changed roots", integrity.topology_changed_roots),
      ];
    }
    case "basis_changed":
      return [
        field("State", "basis_changed"),
        "",
        "The ignore rules moved during the run, so the two observations",
        "cover different domains and cannot be compared.",
        "",
      ];
    case "observation_failed":
      return [
        field("State", "observation_failed"),
        field("Side", integrity.side),
        "",
        failureLine(integrity.failure),
        "",
      ];
    case "observation_torn":
      return [
        field("State", "observation_torn"),
        field("Side", integrity.side),
        field("Basis moved", String(integrity.basis_moved)),
        field("HEAD moved", String(integrity.head_moved)),
        field("Domain", integrity.domain_status),
        "",
        "The observation changed while it was being taken, so it describes",
        "no single moment and cannot support a comparison.",
        "",
      ];
    case "classification_failed":
      return [
        field("State", "classification_failed"),
        "",
        "Both observations were coherent; comparing them faulted.",
        failureLine(integrity.failure),
        "",
      ];
    default: {
      const unhandled: never = integrity;
      return unhandled;
    }
  }
}

/** Header lines that differ between the two branches. */
function identityLines(file: SelectiveRollbackReceipt): readonly string[] {
  const shared = [
    field("Rollback ID", file.rollback_id),
    field("Session ID", file.session_id),
    field("Checkpoint ID", file.checkpoint_id),
    field("Contribution", file.contribution_sha256),
    field("Mode", file.mode),
  ];
  return file.mode === "apply"
    ? [
        ...shared,
        field("Pre-rollback CP", file.pre_rollback_checkpoint_id),
        field("Outcome", file.outcome),
        field("Written at", file.written_at),
      ]
    : [...shared, field("Eligibility", file.eligibility), field("Written at", file.written_at)];
}

/**
 * Render a selective rollback receipt as plain text.
 *
 * Pure and synchronous: no I/O, no clock, no randomness, no stream writes.
 */
export function renderSelectiveReceiptTerminal(input: SelectiveReceiptRenderInput): string {
  const file = input.file;
  const selectors = selectorLines(file.selectors);

  const lines: string[] = [
    RULE_HEAVY,
    file.mode === "dry_run"
      ? "VibeRevert Selective Rollback Receipt (DRY-RUN)"
      : "VibeRevert Selective Rollback Receipt",
    RULE_HEAVY,
    "",
    ...identityLines(file),
    "",
    ...section("Selectors"),
    ...(selectors.length === 0 ? ["(none)"] : selectors),
    "",
    ...section(`Resolved Change Groups (${file.resolved_change_group_ids.length})`),
    ...(file.resolved_change_group_ids.length === 0
      ? ["(none)"]
      : [...file.resolved_change_group_ids]),
    "",
    ...section(`Results (${file.results.length})`),
    ...resultLines(file.results),
  ];

  if (file.mode === "apply") {
    lines.push(
      ...section("First Verification"),
      ...firstVerificationLines(file.first_verification),
      ...section("Project Verification"),
      ...projectVerificationLines(file.project_verification),
      ...section("Post-Command Integrity"),
      ...postCommandIntegrityLines(file.post_command_integrity),
    );
  }

  lines.push(...section("Out of Scope"), file.out_of_scope_notice, "");

  return `${lines.join("\n")}\n`;
}
