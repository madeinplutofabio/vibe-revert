// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/reporters/src/receipt-terminal.ts (M D
// Step 5 file 5.7b — receipt terminal-rendering coverage).
//
// Seven test sections covering the receipt-terminal contract:
//
//   1. BANNER + HEADER — mode-suffixed banner (apply vs DRY-RUN),
//      8 header fields in locked order with 18-char label column,
//      pre-rollback CP placeholder text for dry-run.
//   2. WARNINGS — inline [WARNING] lines after the header; both
//      warnings independently present-or-absent; ordering when
//      both fire.
//   3. FORCED UNRELATED DIRTY PATHS — section ENTIRELY ABSENT when
//      empty; populated section has rule + count header + path list.
//   4. RESULTS — section always present; "(none)" placeholder when
//      empty; "[OUTCOME]  path" lines with optional indented Reason;
//      blank-line separators between consecutive entries; outcome
//      casing locks uppercase + underscore preservation.
//   5. FAILURES — section always present; "(none)" when empty;
//      "[ERROR_CODE] message" lines with optional "Affected paths:"
//      sub-bullets; blank-line separators between entries.
//   6. OUT OF SCOPE — section always present even on minimal
//      receipt; body is file.out_of_scope_notice verbatim
//      (byte-equal to ROLLBACK_OUT_OF_SCOPE_NOTICE per schema
//      literal).
//   7. LOCKED GUARANTEES — newline-terminated; ASCII-only emit;
//      80-col rules; no version footer; productVersion ignored.
//
// Fixture-validity discipline: every fixture flows through
// ReceiptFileSchema.parse via makeReceiptFile, so refine violations
// fail at fixture-construction time (D69 active_session_warning ↔
// dry_run, un_ended_session_warning ↔ skipped_no_after_state,
// pre_rollback_checkpoint_id null/non-null per mode,
// forced_unrelated_dirty_paths audit-field guard).

import {
  RECEIPT_FILE_SCHEMA_VERSION,
  type ReceiptFile,
  ReceiptFileSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { renderReceiptTerminal } from "../src/receipt-terminal.js";
import type { ReceiptRenderInput } from "../src/receipt-types.js";

// =============================================================================
// Test fixtures (per-file duplication intentional, matching the
// existing reporter test convention)
// =============================================================================

const VALID_ULID = "01ABCDEFGHJKMNPQRSTVWXYZ23";
const ROLLBACK_ID = `rb_${VALID_ULID}`;
const SESSION_ID = `sess_${VALID_ULID}`;
const CHECKPOINT_ID = `cp_${VALID_ULID}`;

const RULE_DOUBLE = "=".repeat(80);
const RULE_SINGLE = "-".repeat(80);

function makeReceiptFile(
  opts: {
    mode?: "dry_run" | "apply";
    forced?: boolean;
    preRollbackCheckpointId?: string | null;
    results?: ReceiptFile["results"];
    failures?: ReceiptFile["failures"];
    forcedUnrelatedDirtyPaths?: readonly string[];
    dirtyTreeCheck?: ReceiptFile["dirty_tree_check"];
    activeSessionWarning?: true;
    unEndedSessionWarning?: true;
  } = {},
): ReceiptFile {
  const mode = opts.mode ?? "apply";
  const preRollbackCp =
    opts.preRollbackCheckpointId !== undefined
      ? opts.preRollbackCheckpointId
      : mode === "apply"
        ? CHECKPOINT_ID
        : null;
  const base = {
    schema_version: RECEIPT_FILE_SCHEMA_VERSION,
    rollback_id: ROLLBACK_ID,
    session_id: SESSION_ID,
    checkpoint_id: CHECKPOINT_ID,
    mode,
    forced: opts.forced ?? false,
    written_at: "2026-01-01T00:00:00Z",
    pre_rollback_checkpoint_id: preRollbackCp,
    results: opts.results ?? [],
    failures: opts.failures ?? [],
    forced_unrelated_dirty_paths: opts.forcedUnrelatedDirtyPaths ?? [],
    dirty_tree_check: opts.dirtyTreeCheck ?? "performed",
    out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
  };
  const receipt = {
    ...base,
    ...(opts.activeSessionWarning === true ? { active_session_warning: true as const } : {}),
    ...(opts.unEndedSessionWarning === true ? { un_ended_session_warning: true as const } : {}),
  };
  return ReceiptFileSchema.parse(receipt);
}

function makeRenderInput(opts: { file: ReceiptFile; productVersion?: string }): ReceiptRenderInput {
  return {
    file: opts.file,
    productVersion: opts.productVersion ?? "0.7.0-beta",
  };
}

// =============================================================================
// SECTION 1: banner + header
// =============================================================================

describe("renderReceiptTerminal — banner + header", () => {
  it("apply mode: banner is 'VibeRevert Rollback Receipt' (no suffix) between double rules", () => {
    const file = makeReceiptFile({ mode: "apply" });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(`${RULE_DOUBLE}\nVibeRevert Rollback Receipt\n${RULE_DOUBLE}`);
    expect(output).not.toContain("DRY-RUN");
  });

  it("dry-run mode: banner is 'VibeRevert Rollback Receipt (DRY-RUN)' between double rules", () => {
    const file = makeReceiptFile({ mode: "dry_run" });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(
      `${RULE_DOUBLE}\nVibeRevert Rollback Receipt (DRY-RUN)\n${RULE_DOUBLE}`,
    );
  });

  it("header includes all 8 fields with 18-char label column (1 space after widest 'Dirty-tree check:')", () => {
    // Widest label "Dirty-tree check:" = 17 chars; padded to 18
    // means 1 trailing space. Other labels get more padding so the
    // values align in a single column. Each assertion locks the
    // EXACT spacing the code produces.
    const file = makeReceiptFile({ mode: "apply" });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(`Rollback ID:      ${ROLLBACK_ID}`); // 12 + 6 spaces
    expect(output).toContain(`Session ID:       ${SESSION_ID}`); // 11 + 7 spaces
    expect(output).toContain(`Checkpoint ID:    ${CHECKPOINT_ID}`); // 14 + 4 spaces
    expect(output).toContain("Mode:             apply"); // 5 + 13 spaces
    expect(output).toContain("Forced:           false"); // 7 + 11 spaces
    expect(output).toContain(`Pre-rollback CP:  ${CHECKPOINT_ID}`); // 16 + 2 spaces
    expect(output).toContain("Dirty-tree check: performed"); // 17 + 1 space
    expect(output).toContain("Written at:       2026-01-01T00:00:00Z"); // 11 + 7 spaces
  });

  it("dry-run pre-rollback CP renders as '(none - dry-run)' placeholder", () => {
    const file = makeReceiptFile({ mode: "dry_run" });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("Pre-rollback CP:  (none - dry-run)");
    expect(output).not.toContain(`Pre-rollback CP:  ${CHECKPOINT_ID}`);
  });

  it("header field order is locked (indexOf monotonicity check)", () => {
    const file = makeReceiptFile({ mode: "apply" });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    const labels = [
      "Rollback ID:",
      "Session ID:",
      "Checkpoint ID:",
      "Mode:",
      "Forced:",
      "Pre-rollback CP:",
      "Dirty-tree check:",
      "Written at:",
    ];
    let lastIdx = -1;
    for (const label of labels) {
      const idx = output.indexOf(label);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});

// =============================================================================
// SECTION 2: warnings
// =============================================================================

describe("renderReceiptTerminal — warnings", () => {
  it("both warnings absent: no [WARNING] lines emitted", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).not.toContain("[WARNING]");
  });

  it("only active_session_warning set: only the active-session line is emitted", () => {
    // active_session_warning REQUIRES mode === "dry_run" per D69 refine.
    const file = makeReceiptFile({ mode: "dry_run", activeSessionWarning: true });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("[WARNING] Active session - apply mode would refuse on this session.");
    expect(output).not.toContain("[WARNING] No machine-readable after-status snapshot");
  });

  it("only un_ended_session_warning set: only the un-ended line is emitted", () => {
    // un_ended_session_warning REQUIRES
    // dirty_tree_check === "skipped_no_after_state" per D69 refine.
    // Dry-run mode + forced=false is a valid combination.
    const file = makeReceiptFile({
      mode: "dry_run",
      dirtyTreeCheck: "skipped_no_after_state",
      unEndedSessionWarning: true,
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(
      "[WARNING] No machine-readable after-status snapshot for this session.",
    );
    expect(output).not.toContain("[WARNING] Active session");
  });

  it("both warnings set: both lines emitted in order (active first, un-ended second)", () => {
    // Only valid in dry_run mode + skipped_no_after_state per the
    // intersection of D69 refines.
    const file = makeReceiptFile({
      mode: "dry_run",
      dirtyTreeCheck: "skipped_no_after_state",
      activeSessionWarning: true,
      unEndedSessionWarning: true,
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    const activeIdx = output.indexOf(
      "[WARNING] Active session - apply mode would refuse on this session.",
    );
    const unEndedIdx = output.indexOf(
      "[WARNING] No machine-readable after-status snapshot for this session.",
    );
    expect(activeIdx).toBeGreaterThan(-1);
    expect(unEndedIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeLessThan(unEndedIdx);
  });
});

// =============================================================================
// SECTION 3: forced unrelated dirty paths
// =============================================================================

describe("renderReceiptTerminal — forced unrelated dirty paths section", () => {
  it("empty: section is ENTIRELY ABSENT (no header, no rule)", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).not.toContain("Forced Unrelated Dirty Paths");
  });

  it("populated: single rule + 'Forced Unrelated Dirty Paths (N)' header + paths one per line", () => {
    // forced_unrelated_dirty_paths is only schema-valid when
    // mode: "apply" + forced: true + dirty_tree_check: "performed"
    // per D69 audit-field refine.
    const file = makeReceiptFile({
      mode: "apply",
      forced: true,
      dirtyTreeCheck: "performed",
      forcedUnrelatedDirtyPaths: ["src/dirty-a.ts", "src/dirty-b.ts"],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(`${RULE_SINGLE}\nForced Unrelated Dirty Paths (2)\n${RULE_SINGLE}`);
    expect(output).toContain("src/dirty-a.ts");
    expect(output).toContain("src/dirty-b.ts");
  });

  it("single path: count header shows (1)", () => {
    const file = makeReceiptFile({
      mode: "apply",
      forced: true,
      dirtyTreeCheck: "performed",
      forcedUnrelatedDirtyPaths: ["src/only.ts"],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("Forced Unrelated Dirty Paths (1)");
  });
});

// =============================================================================
// SECTION 4: results
// =============================================================================

describe("renderReceiptTerminal — results section", () => {
  it("empty results: section renders '(none)' placeholder", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(`${RULE_SINGLE}\nResults (0)\n${RULE_SINGLE}\n\n(none)`);
  });

  it("single result without reason: '[OUTCOME]  path' line, no Reason sub-line", () => {
    const file = makeReceiptFile({
      results: [{ path: "src/foo.ts", outcome: "tracked_restored" }],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("[TRACKED_RESTORED]  src/foo.ts");
    expect(output).not.toContain("Reason:");
  });

  it("single result with reason: '[OUTCOME]  path' + indented 'Reason: ...' line", () => {
    const file = makeReceiptFile({
      results: [
        {
          path: "src/foo.ts",
          outcome: "skipped_excluded",
          reason: "matches rollback.exclude pattern *.test.ts",
        },
      ],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("[SKIPPED_EXCLUDED]  src/foo.ts");
    expect(output).toContain("  Reason: matches rollback.exclude pattern *.test.ts");
  });

  it("multiple results: consecutive entries separated by a single blank line", () => {
    const file = makeReceiptFile({
      results: [
        { path: "src/a.ts", outcome: "tracked_restored" },
        { path: "src/b.ts", outcome: "untracked_restored" },
      ],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    // Blank line between entries manifests as "\n\n" between the
    // two outcome lines.
    expect(output).toContain("[TRACKED_RESTORED]  src/a.ts\n\n[UNTRACKED_RESTORED]  src/b.ts");
  });

  it("outcome token preserves schema's snake_case form uppercased in brackets ('[UNTRACKED_DELETED]', NOT '[UNTRACKED DELETED]' or '[UNTRACKEDDELETED]')", () => {
    const file = makeReceiptFile({
      results: [{ path: "src/foo.ts", outcome: "untracked_deleted" }],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("[UNTRACKED_DELETED]  src/foo.ts");
  });
});

// =============================================================================
// SECTION 5: failures
// =============================================================================

describe("renderReceiptTerminal — failures section", () => {
  it("empty failures: section renders '(none)' placeholder", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(`${RULE_SINGLE}\nFailures (0)\n${RULE_SINGLE}\n\n(none)`);
  });

  it("single failure without affected_paths: '[ERROR_CODE] message' line, no 'Affected paths:' block", () => {
    const file = makeReceiptFile({
      failures: [
        {
          error_code: "internal",
          message: "unexpected null in restore plan",
          affected_paths: [],
        },
      ],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("[INTERNAL] unexpected null in restore plan");
    expect(output).not.toContain("Affected paths:");
  });

  it("single failure with affected_paths: '[ERROR_CODE] message' + 'Affected paths:' sub-block with indented bullets", () => {
    const file = makeReceiptFile({
      failures: [
        {
          error_code: "extraction_conflict",
          message: "tarball entry would overwrite tracked file",
          affected_paths: ["src/conflict-a.ts", "src/conflict-b.ts"],
        },
      ],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("[EXTRACTION_CONFLICT] tarball entry would overwrite tracked file");
    expect(output).toContain("  Affected paths:");
    expect(output).toContain("    - src/conflict-a.ts");
    expect(output).toContain("    - src/conflict-b.ts");
  });

  it("multiple failures: consecutive entries separated by a single blank line", () => {
    const file = makeReceiptFile({
      failures: [
        {
          error_code: "verification",
          message: "post-restore hash mismatch",
          affected_paths: [],
        },
        {
          error_code: "tracked_dirty_parity",
          message: "tracked dirty paths do not match manifest",
          affected_paths: [],
        },
      ],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(
      "[VERIFICATION] post-restore hash mismatch\n\n[TRACKED_DIRTY_PARITY] tracked dirty paths do not match manifest",
    );
  });
});

// =============================================================================
// SECTION 6: out of scope
// =============================================================================

describe("renderReceiptTerminal — out of scope section", () => {
  it("section is always present even on minimal receipt", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(`${RULE_SINGLE}\nOut of Scope\n${RULE_SINGLE}`);
  });

  it("body is file.out_of_scope_notice verbatim (byte-equal to ROLLBACK_OUT_OF_SCOPE_NOTICE)", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain(ROLLBACK_OUT_OF_SCOPE_NOTICE);
  });
});

// =============================================================================
// SECTION 7: locked guarantees
// =============================================================================

describe("renderReceiptTerminal — locked guarantees", () => {
  it("output is newline-terminated", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output.endsWith("\n")).toBe(true);
  });

  it("output is ASCII-only (no non-ASCII bytes in any emitted character)", () => {
    // The locked ASCII guarantee covers every byte the renderer
    // emits. The one EXCEPTION documented in receipt-terminal.ts is
    // file.out_of_scope_notice, which is rendered verbatim from
    // the schema literal; today's ROLLBACK_OUT_OF_SCOPE_NOTICE is
    // pure ASCII so the contract holds across the full buffer.
    // A future schema-literal change introducing non-ASCII would
    // scope the contract to "everything THIS renderer emits"
    // rather than "the entire buffer" — for today, asserting
    // pure-ASCII on the full output is the right lock.
    const file = makeReceiptFile({
      mode: "dry_run",
      dirtyTreeCheck: "skipped_no_after_state",
      activeSessionWarning: true,
      unEndedSessionWarning: true,
      results: [
        { path: "src/foo.ts", outcome: "tracked_restored" },
        { path: "src/bar.ts", outcome: "skipped_excluded", reason: "matches exclude" },
      ],
      failures: [
        {
          error_code: "verification",
          message: "test failure",
          affected_paths: ["src/baz.ts"],
        },
      ],
    });
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: locking the ASCII range
    expect(output).toMatch(/^[\x00-\x7F]*$/);
  });

  it("section dividers are exactly 80-character rules (== and --)", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(makeRenderInput({ file }));
    expect(output).toContain("=".repeat(80));
    expect(output).toContain("-".repeat(80));
    // Line-anchored off-by-one defense: any line composed entirely
    // of '=' or '-' MUST be exactly 80 chars long. A naive substring
    // check for shorter rules (e.g., 79-char) would be trivially
    // false because longer rules contain shorter runs as substrings;
    // splitting into lines is the only way to assert both
    // directions (≤79 and ≥81) correctly.
    for (const line of output.split("\n")) {
      if (/^=+$/.test(line)) {
        expect(line.length).toBe(80);
      }
      if (/^-+$/.test(line)) {
        expect(line.length).toBe(80);
      }
    }
  });

  it("NO version footer in terminal output (markdown-only per D45)", () => {
    const file = makeReceiptFile();
    const output = renderReceiptTerminal(
      makeRenderInput({ file, productVersion: "FENCEPOST-DO-NOT-LEAK" }),
    );
    expect(output).not.toContain("Generated by");
    expect(output).not.toContain("FENCEPOST-DO-NOT-LEAK");
  });

  it("two inputs differing only by productVersion produce byte-identical output", () => {
    const file = makeReceiptFile();
    const a = renderReceiptTerminal(makeRenderInput({ file, productVersion: "0.7.0-beta" }));
    const b = renderReceiptTerminal(makeRenderInput({ file, productVersion: "999.999.999-fake" }));
    expect(a).toBe(b);
  });
});
