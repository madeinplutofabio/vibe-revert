// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the selective rollback receipt renderers (M 0.8.0 rung 8).
//
// THE POINT OF THIS FILE is the arms a golden fixture cannot reach. An
// end-to-end fixture drives a real repository through a real transplant, so it
// produces the outcomes a healthy run produces: `restored`, a completed
// verification, no configured commands. It cannot produce a verification that
// threw, an observation taken while the tree moved underneath it, or a path
// whose fate is genuinely unknown.
//
// Those are exactly the arms that matter most. Each of them exists to say the
// result could NOT be determined, and the failure mode a renderer invites is
// rendering "we do not know" as a blank line, which reads as "nothing
// happened". A user with a half-restored working tree acting on that reading
// is the worst outcome this tool has. So every one is constructed here and
// asserted to say something.
//
// FIXTURES ARE SCHEMA-PARSED, not cast. `SelectiveRollbackReceiptSchema` is
// the authority on what a receipt may contain, and several of its refinements
// are biconditionals -- `indeterminate` results are coupled to a
// non-completed `first_verification`, `empty_selection` to empty results and
// groups. A cast fixture could assert rendering for a receipt that cannot
// exist, which would be worse than no test.

import {
  type SelectiveRollbackReceipt,
  SelectiveRollbackReceiptSchema,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { renderSelectiveReceipt } from "../src/selective-receipt-render.js";
import type { SelectiveReceiptRenderInput } from "../src/selective-receipt-types.js";

const SESSION_ID = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ROLLBACK_ID = "rb_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const CHECKPOINT_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RECOVERY_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FA2";
const DIGEST = "a".repeat(64);
const GROUP = `cg_${"0".repeat(63)}1`;
const NOTICE =
  "Vibe-revert restores tracked file content, untracked file content, and the git index. It does NOT restore: database schemas/data, deployed artifacts, package registry publishes (npm/pypi/etc.), external API state, environment variable mutations in the parent shell, OS-level state outside the repo, or any process-side effects. Recover those manually.";

const PRODUCT_VERSION = "0.8.0";

/** Parsed, never cast: the schema decides what a receipt may say. */
function receipt(candidate: unknown): SelectiveRollbackReceipt {
  return SelectiveRollbackReceiptSchema.parse(candidate);
}

const applyReceipt = (overrides: Record<string, unknown>): SelectiveRollbackReceipt =>
  receipt({
    schema_version: "1.0",
    mode: "apply",
    rollback_id: ROLLBACK_ID,
    session_id: SESSION_ID,
    checkpoint_id: CHECKPOINT_ID,
    contribution_sha256: DIGEST,
    pre_rollback_checkpoint_id: RECOVERY_ID,
    selectors: { only: ["src/**"] },
    resolved_change_group_ids: [GROUP],
    results: [{ path: "src/a.ts", change_group_id: GROUP, outcome: "restored" }],
    outcome: "succeeded",
    first_verification: {
      state: "completed",
      assessment: {
        selected_verified: true,
        unselected_checked_count: 3,
        unselected_violations: [],
        head_unchanged: true,
      },
    },
    project_verification: { state: "not_configured" },
    post_command_integrity: { state: "not_run", reason: "commands_not_configured" },
    written_at: "2026-03-04T05:06:07Z",
    out_of_scope_notice: NOTICE,
    ...overrides,
  });

const dryRunReceipt = (overrides: Record<string, unknown>): SelectiveRollbackReceipt =>
  receipt({
    schema_version: "1.0",
    mode: "dry_run",
    rollback_id: ROLLBACK_ID,
    session_id: SESSION_ID,
    checkpoint_id: CHECKPOINT_ID,
    contribution_sha256: DIGEST,
    selectors: { only: ["src/**"] },
    resolved_change_group_ids: [GROUP],
    results: [{ path: "src/a.ts", change_group_id: GROUP, outcome: "restored" }],
    eligibility: "eligible",
    written_at: "2026-03-04T05:06:07Z",
    out_of_scope_notice: NOTICE,
    ...overrides,
  });

const input = (file: SelectiveRollbackReceipt): SelectiveReceiptRenderInput => ({
  file,
  productVersion: PRODUCT_VERSION,
});

/** Both human formats, so an arm cannot be covered in one and blank in the other. */
const humanFormats = ["terminal", "markdown"] as const;

const renderHuman = (file: SelectiveRollbackReceipt, format: "terminal" | "markdown"): string =>
  format === "terminal"
    ? renderSelectiveReceipt(input(file), "terminal")
    : renderSelectiveReceipt(input(file), "markdown");

// =============================================================================
// The dispatcher and the verbatim contract
// =============================================================================

describe("renderSelectiveReceipt: dispatch", () => {
  it("json returns the receipt REFERENCE, unchanged", () => {
    const file = applyReceipt({});
    // Identity, not deep equality: a copy could diverge from the persisted
    // bytes the CLI asserts it matches.
    expect(renderSelectiveReceipt(input(file), "json")).toBe(file);
  });

  it("json never leaks productVersion into the artifact shape", () => {
    const rendered = renderSelectiveReceipt(input(applyReceipt({})), "json");
    expect(Object.keys(rendered as object)).not.toContain("productVersion");
  });

  it.each(humanFormats)("%s output is newline-terminated", (format) => {
    expect(renderHuman(applyReceipt({}), format).endsWith("\n")).toBe(true);
  });

  it("terminal output is ASCII only, so goldens are byte-stable everywhere", () => {
    const text = renderSelectiveReceipt(input(applyReceipt({})), "terminal");
    // The notice is schema-owned and rendered verbatim; everything else is
    // this renderer's own bytes.
    expect(/^[\x20-\x7E\n]*$/.test(text)).toBe(true);
  });

  it("markdown ends with the locked version footer", () => {
    const text = renderSelectiveReceipt(input(applyReceipt({})), "markdown");
    expect(text.trimEnd().endsWith(`Generated by VibeRevert v${PRODUCT_VERSION}`)).toBe(true);
  });

  it("rejects an unknown format rather than returning undefined", () => {
    expect(() =>
      // A value only untyped JS could supply. The `never` binding covers the
      // typed path; this covers the untyped one.
      renderSelectiveReceipt(input(applyReceipt({})), "yaml" as "json"),
    ).toThrow(/Unknown reporter format/);
  });
});

// =============================================================================
// The arms a fixture cannot produce
// =============================================================================

describe("indeterminate results are never rendered as nothing", () => {
  /**
   * The schema's biconditional: `indeterminate` results require a
   * `first_verification` that did not complete. Both halves are set together,
   * because setting one alone does not parse.
   */
  const indeterminate = applyReceipt({
    results: [{ path: "src/a.ts", change_group_id: GROUP, outcome: "indeterminate" }],
    outcome: "failed",
    first_verification: { state: "not_run", reason: "gate_result_unavailable" },
    project_verification: { state: "skipped", reason: "gate_result_unavailable" },
    post_command_integrity: { state: "not_run", reason: "gate_result_unavailable" },
  });

  it.each(humanFormats)("%s names the outcome for the path", (format) => {
    const text = renderHuman(indeterminate, format);
    expect(text).toContain("INDETERMINATE");
    expect(text).toContain("src/a.ts");
  });

  it.each(humanFormats)("%s explains that no verification exists", (format) => {
    const text = renderHuman(indeterminate, format);
    expect(text).toContain("not_run");
    expect(text).toContain("gate_result_unavailable");
    // The instruction is the whole point: a reader must not conclude that
    // nothing happened.
    expect(text).toContain("recover from the pre-rollback checkpoint");
  });

  it.each(humanFormats)("%s still reports the recovery handle", (format) => {
    expect(renderHuman(indeterminate, format)).toContain(RECOVERY_ID);
  });
});

describe("a first verification that threw", () => {
  const failed = applyReceipt({
    results: [{ path: "src/a.ts", change_group_id: GROUP, outcome: "indeterminate" }],
    outcome: "failed",
    first_verification: {
      state: "failed",
      failure: { error_code: "io", message: "EACCES: permission denied, scandir" },
    },
    project_verification: { state: "skipped", reason: "first_verification_failed" },
    post_command_integrity: { state: "not_run", reason: "first_verification_failed" },
  });

  it.each(humanFormats)("%s surfaces the failure summary", (format) => {
    const text = renderHuman(failed, format);
    expect(text).toContain("IO");
    expect(text).toContain("permission denied");
  });

  it.each(humanFormats)("%s distinguishes it from a verification that never ran", (format) => {
    const text = renderHuman(failed, format);
    expect(text).toContain("started and threw");
    expect(text).not.toContain("gate_result_unavailable");
  });
});

describe("a verification command that mutated the project", () => {
  // `outcome: "failed"` is not a choice here: the schema couples a succeeded
  // receipt to CLEAN post-command integrity, so a mutated project cannot be
  // recorded as a success. The coupling is the reason this fixture is worth
  // having.
  const mutated = applyReceipt({
    outcome: "failed",
    project_verification: {
      state: "completed",
      commands: [{ command: "npm", args: ["test"], result: { outcome: "exited", exit_code: 0 } }],
    },
    post_command_integrity: {
      state: "project_mutated",
      added_paths: ["build/out.js"],
      removed_paths: [],
      changed_paths: ["src/a.ts"],
      topology_changed_roots: [],
      head_moved: true,
    },
  });

  it.each(humanFormats)("%s names every mutated path and the moved HEAD", (format) => {
    const text = renderHuman(mutated, format);
    expect(text).toContain("project_mutated");
    expect(text).toContain("build/out.js");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("HEAD moved");
  });

  it.each(humanFormats)("%s shows the command that ran, with its argv", (format) => {
    expect(renderHuman(mutated, format)).toContain("npm test");
  });
});

describe("the remaining post-command integrity states each say something", () => {
  /**
   * Each integrity state is paired with the command phase that could have
   * produced it, because the schema couples them: a comparison can only report
   * anything other than `not_run` once commands were actually reached, and a
   * `before_commands` observation record means the PRE-command observation was
   * unusable, which is a distinct skip reason.
   *
   * Getting that pairing wrong is not a fixture inconvenience, it is the
   * schema refusing to let a receipt describe a sequence that cannot happen.
   */
  const ran = {
    state: "completed",
    commands: [{ command: "npm", args: ["test"], result: { outcome: "exited", exit_code: 0 } }],
  } as const;
  const preCommandUnusable = {
    state: "skipped",
    reason: "pre_command_observation_unusable",
  } as const;

  const cases = [
    { name: "clean", project: ran, integrity: { state: "clean" }, succeeded: true },
    {
      name: "basis_changed",
      project: ran,
      integrity: { state: "basis_changed" },
      succeeded: false,
    },
    {
      name: "observation_failed",
      project: ran,
      integrity: {
        state: "observation_failed",
        side: "after_commands",
        failure: { error_code: "internal", message: "observer exploded" },
      },
      succeeded: false,
    },
    {
      name: "observation_torn",
      project: preCommandUnusable,
      integrity: {
        state: "observation_torn",
        side: "before_commands",
        basis_moved: true,
        head_moved: false,
        domain_status: "not_comparable",
      },
      succeeded: false,
    },
    {
      name: "classification_failed",
      project: ran,
      integrity: {
        state: "classification_failed",
        failure: { error_code: "internal", message: "comparison exploded" },
      },
      succeeded: false,
    },
  ] as const;

  it.each(
    cases.map((c) => [c.name, c] as const),
  )("%s renders in both formats with its state token", (stateName, testCase) => {
    // Only a CLEAN second pass may sit on a succeeded receipt; the schema
    // couples the two, so every other state carries `failed`.
    const file = applyReceipt({
      ...(testCase.succeeded ? {} : { outcome: "failed" }),
      project_verification: testCase.project,
      post_command_integrity: testCase.integrity,
    });
    for (const format of humanFormats) {
      const text = renderHuman(file, format);
      expect(text).toContain(stateName);
      // No arm may render as an empty section.
      expect(text).toContain("Post-Command Integrity");
    }
  });
});

describe("every verify-command result shape renders", () => {
  const results = [
    { outcome: "exited", exit_code: 1 },
    { outcome: "signalled", signal: "SIGKILL" },
    { outcome: "unresolved" },
    { outcome: "unsupported_target", resolved_target: "C:\\bin\\npm.cmd", kind: "cmd-shim" },
  ] as const;

  it.each(results.map((r) => [r.outcome, r] as const))("%s", (_name, result) => {
    // A non-passing command must be followed only by not_run records, which is
    // the runner's fail-fast contract the schema enforces.
    const file = applyReceipt({
      outcome: "failed",
      project_verification: {
        state: "completed",
        commands: [
          { command: "npm", args: ["test"], result },
          {
            command: "npm",
            args: ["run", "lint"],
            result: { outcome: "not_run", reason: "earlier_command_did_not_pass" },
          },
        ],
      },
      post_command_integrity: { state: "clean" },
    });
    for (const format of humanFormats) {
      const text = renderHuman(file, format);
      expect(text).toContain("npm test");
      expect(text).toContain("NOT_RUN");
    }
  });

  it("a runner that faulted is not reported as a failing command", () => {
    const file = applyReceipt({
      outcome: "failed",
      project_verification: {
        state: "runner_failed",
        failure: { error_code: "internal", message: "spawn failed" },
      },
      post_command_integrity: { state: "clean" },
    });
    for (const format of humanFormats) {
      const text = renderHuman(file, format);
      expect(text).toContain("runner_failed");
      expect(text).toContain("not a command reporting failure");
    }
  });
});

// =============================================================================
// Dry-run specifics
// =============================================================================

describe("dry-run rendering", () => {
  it.each(humanFormats)("%s marks an empty selection as such rather than blank", (format) => {
    const text = renderHuman(
      dryRunReceipt({ results: [], resolved_change_group_ids: [], eligibility: "empty_selection" }),
      format,
    );
    expect(text).toContain("empty_selection");
    expect(text).toContain("(none)");
  });

  it.each(humanFormats)("%s renders every ineligible per-path outcome", (format) => {
    const file = dryRunReceipt({
      results: [
        { path: "src/a.ts", change_group_id: GROUP, outcome: "missing_evidence", reason: "gone" },
        { path: "src/b.ts", change_group_id: GROUP, outcome: "modified_since" },
        { path: "src/c.ts", change_group_id: GROUP, outcome: "unsupported_state" },
      ],
      eligibility: "ineligible",
    });
    const text = renderHuman(file, format);
    for (const token of ["MISSING_EVIDENCE", "MODIFIED_SINCE", "UNSUPPORTED_STATE"]) {
      expect(text).toContain(token);
    }
    expect(text).toContain("gone");
    // Eligibility is a HEADER field, so it renders plain rather than bracketed.
    expect(text).toContain("ineligible");
  });

  it.each(humanFormats)("%s shows the dry-run banner, not the apply one", (format) => {
    const text = renderHuman(dryRunReceipt({}), format);
    expect(text.toLowerCase()).toContain("dry-run");
  });

  it("a dry-run receipt renders no apply-only section", () => {
    const text = renderSelectiveReceipt(input(dryRunReceipt({})), "terminal");
    expect(text).not.toContain("First Verification");
    expect(text).not.toContain("Project Verification");
    expect(text).not.toContain("Post-Command Integrity");
  });
});

// =============================================================================
// Selectors and injection safety
// =============================================================================

describe("selectors", () => {
  it.each(humanFormats)("%s renders every supplied family in flag form", (format) => {
    const file = dryRunReceipt({
      selectors: {
        only: ["src/**"],
        except: ["tests/**"],
        risk: "high",
        finding: [`fnd_${"b".repeat(64)}`],
      },
    });
    const text = renderHuman(file, format);
    for (const flag of ["--only", "--except", "--risk", "--finding"]) {
      expect(text).toContain(flag);
    }
    expect(text).toContain("high");
  });

  it("markdown neutralizes a glob that would otherwise be markdown syntax", () => {
    // `*` and `_` are emphasis characters, and a glob is full of them. The
    // code-span helper is what keeps `src/**` from becoming italics.
    const text = renderSelectiveReceipt(
      input(dryRunReceipt({ selectors: { only: ["src/**/_x_*.ts"] } })),
      "markdown",
    );
    expect(text).toContain("`src/**/_x_*.ts`");
  });

  it("markdown fences a reason containing a backtick run", () => {
    const text = renderSelectiveReceipt(
      input(
        dryRunReceipt({
          results: [
            {
              path: "src/a.ts",
              change_group_id: GROUP,
              outcome: "missing_evidence",
              reason: "object ``abc`` is absent",
            },
          ],
          eligibility: "ineligible",
        }),
      ),
      "markdown",
    );
    // Escaped as prose, so the backticks cannot open a code span.
    expect(text).toContain("\\`\\`abc\\`\\`");
  });
});
