// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/reporters/src/receipt-render.ts (M D
// Step 5 file 5.7d — receipt dispatcher + barrel surface coverage).
//
// 42 tests across three sections covering three distinct
// responsibilities:
//
//   1. DISPATCHER CORRECTNESS (4) — `renderReceipt(input, format)`
//      delegates EXACTLY to the per-format function for each of
//      "terminal", "markdown", "json"; invalid format throws.
//      Imports reach into the per-format modules directly so a
//      wiring bug (dispatcher returning the wrong renderer's
//      output) surfaces as a non-equal comparison, not as a
//      passing-but-wrong test.
//
//   2. BARREL SMOKE (5) — receipt symbols are reachable through
//      `../src/index.js` (the package's public barrel) and are
//      callable. Catches missing barrel exports before CLI
//      integration tries to import. Separate from #1 because
//      #1 imports from internal module paths; this test imports
//      from the barrel specifically.
//
//   3. HELPER-LEAKAGE LOCK (33) — internal helpers
//      (inlineMarkdown / inlineCode / schemaToken / bracketToken /
//      receipt section builders / M C report internals) MUST NOT be
//      re-exported from the barrel. The lock catches accidental
//      promotion of file-local helpers to the public surface;
//      generated one-per-name so each failure names the leaked
//      helper directly.
//
// Fixture-validity discipline: every fixture flows through
// ReceiptFileSchema.parse via makeReceiptFile (same as 5.7a-c).

import {
  RECEIPT_FILE_SCHEMA_VERSION,
  type ReceiptFile,
  ReceiptFileSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import * as ReportersBarrel from "../src/index.js";
import { renderReceiptJson } from "../src/receipt-json.js";
import { renderReceiptMarkdown } from "../src/receipt-markdown.js";
import { renderReceipt } from "../src/receipt-render.js";
import { renderReceiptTerminal } from "../src/receipt-terminal.js";
import type { ReceiptRenderInput } from "../src/receipt-types.js";
import type { ReporterFormat } from "../src/types.js";

// =============================================================================
// Test fixtures (per-file duplication intentional, matching the
// existing reporter test convention)
// =============================================================================

const VALID_ULID = "01ABCDEFGHJKMNPQRSTVWXYZ23";
const ROLLBACK_ID = `rb_${VALID_ULID}`;
const SESSION_ID = `sess_${VALID_ULID}`;
const CHECKPOINT_ID = `cp_${VALID_ULID}`;

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
// SECTION 1: dispatcher correctness
// =============================================================================

describe("renderReceipt — dispatcher correctness", () => {
  it("format='terminal' returns exactly renderReceiptTerminal(input) (byte-equal string)", () => {
    const file = makeReceiptFile({
      results: [{ path: "src/foo.ts", outcome: "tracked_restored" }],
    });
    const input = makeRenderInput({ file });
    const fromDispatcher = renderReceipt(input, "terminal");
    const fromDirect = renderReceiptTerminal(input);
    expect(fromDispatcher).toBe(fromDirect);
  });

  it("format='markdown' returns exactly renderReceiptMarkdown(input) (byte-equal string)", () => {
    const file = makeReceiptFile({
      results: [{ path: "src/foo.ts", outcome: "tracked_restored" }],
    });
    const input = makeRenderInput({ file });
    const fromDispatcher = renderReceipt(input, "markdown");
    const fromDirect = renderReceiptMarkdown(input);
    expect(fromDispatcher).toBe(fromDirect);
  });

  it("format='json' returns the SAME REFERENCE as renderReceiptJson(input) (reference equality, not just deep equality)", () => {
    // renderReceiptJson is `return input.file`. The dispatcher must
    // also pass the input through by reference — a regression that
    // cloned the input (e.g., via JSON.parse(JSON.stringify(...)))
    // would still produce a deep-equal value but break reference
    // identity. The reference-equality assertion catches that.
    const file = makeReceiptFile({
      results: [{ path: "src/foo.ts", outcome: "tracked_restored" }],
    });
    const input = makeRenderInput({ file });
    const fromDispatcher = renderReceipt(input, "json");
    const fromDirect = renderReceiptJson(input);
    expect(fromDispatcher).toBe(fromDirect);
    // Also pin reference to the input file itself, mirroring the
    // 5.7a reference-equality test.
    expect(fromDispatcher).toBe(file);
  });

  it("invalid format throws 'Unknown reporter format: <value>'", () => {
    // The `never` exhaustiveness branch in receipt-render.ts also
    // guards at runtime via `throw new Error(...)`. Untyped JS
    // callers (or a test like this one using `as ReporterFormat`
    // to bypass the type check) hit this branch and get a clean
    // error rather than `undefined`. Locks the runtime defense.
    const file = makeReceiptFile();
    const input = makeRenderInput({ file });
    expect(() => renderReceipt(input, "html" as ReporterFormat)).toThrow(/Unknown reporter format/);
  });
});

// =============================================================================
// SECTION 2: barrel smoke (M D Step 5 — receipt surface integration)
// =============================================================================

describe("@viberevert/reporters barrel — receipt surface smoke", () => {
  it("renderReceipt is exported and callable from ../src/index.js", () => {
    const file = makeReceiptFile();
    const input = makeRenderInput({ file });
    expect(typeof ReportersBarrel.renderReceipt).toBe("function");
    // Smoke-call to verify the export wires through to a working
    // renderer (not a stub or undefined). The "terminal" overload
    // returns a non-empty string.
    const output = ReportersBarrel.renderReceipt(input, "terminal");
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  it("renderReceiptJson is exported and callable from ../src/index.js", () => {
    const file = makeReceiptFile();
    const input = makeRenderInput({ file });
    expect(typeof ReportersBarrel.renderReceiptJson).toBe("function");
    expect(ReportersBarrel.renderReceiptJson(input)).toBe(file);
  });

  it("renderReceiptMarkdown is exported and callable from ../src/index.js", () => {
    const file = makeReceiptFile();
    const input = makeRenderInput({ file });
    expect(typeof ReportersBarrel.renderReceiptMarkdown).toBe("function");
    const output = ReportersBarrel.renderReceiptMarkdown(input);
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  it("renderReceiptTerminal is exported and callable from ../src/index.js", () => {
    const file = makeReceiptFile();
    const input = makeRenderInput({ file });
    expect(typeof ReportersBarrel.renderReceiptTerminal).toBe("function");
    const output = ReportersBarrel.renderReceiptTerminal(input);
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  it("M C report symbols also remain callable through the barrel (regression gate against accidental removal)", () => {
    // Defensive: ensure the M D additions didn't accidentally
    // displace the M C exports during the 5.6 barrel update.
    expect(typeof ReportersBarrel.render).toBe("function");
    expect(typeof ReportersBarrel.renderJson).toBe("function");
    expect(typeof ReportersBarrel.renderMarkdown).toBe("function");
    expect(typeof ReportersBarrel.renderTerminal).toBe("function");
    expect(typeof ReportersBarrel.applyThreshold).toBe("function");
  });
});

// =============================================================================
// SECTION 3: helper-leakage lock
// =============================================================================

describe("@viberevert/reporters barrel — helper-leakage lock", () => {
  // The per-format renderer modules define file-local escape
  // helpers (inlineMarkdown, inlineCode, schemaToken, bracketToken)
  // and section-builder helpers (buildBanner, buildSummaryBullets,
  // buildHeader, buildWarnings, buildForcedUnrelatedDirtyPathsSection,
  // buildResult, buildResultsSection, buildFailure, buildFailuresSection,
  // buildOutOfScopeSection). These MUST stay internal so the public
  // API surface describes the DOMAIN (rendering a receipt), not the
  // implementation details. A regression that accidentally promoted
  // a helper to the barrel would be caught here.

  const FORBIDDEN_HELPER_NAMES = [
    // Escape helpers (defined in receipt-markdown.ts; inlineMarkdown
    // is duplicated there byte-for-byte from markdown.ts):
    "inlineMarkdown",
    "inlineCode",
    "schemaToken",
    "bracketToken",
    // Receipt section builders:
    "buildBanner",
    "buildHeader",
    "buildSummaryBullets",
    "buildWarnings",
    "buildForcedUnrelatedDirtyPathsSection",
    "buildResult",
    "buildResultsSection",
    "buildFailure",
    "buildFailuresSection",
    "buildOutOfScopeSection",
    // Layout constants from receipt-terminal.ts:
    "TERMINAL_WIDTH",
    "RULE_DOUBLE",
    "RULE_SINGLE",
    "HEADER_LABEL_WIDTH",
    "padRight",
    "headerLine",
    // M C report internals (also internal in the M C barrel; lock
    // here to catch a regression that swept too widely while
    // editing the barrel):
    "buildFinding",
    "buildFindingsSection",
    "buildChangedFile",
    "buildChangedFilesSection",
    "buildChangedFileBullet",
    "buildEvidenceLines",
    "buildFencedBlock",
    "maxBacktickRun",
    "groupByCategory",
    "statusCode",
    "evidenceLine",
    "levelToken",
    "STATUS_CODES",
  ];

  for (const helperName of FORBIDDEN_HELPER_NAMES) {
    it(`${helperName} is NOT exported from the barrel`, () => {
      expect(ReportersBarrel).not.toHaveProperty(helperName);
    });
  }
});
