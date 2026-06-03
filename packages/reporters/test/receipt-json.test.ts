// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/reporters/src/receipt-json.ts (M D Step 5
// file 5.7a — receipt JSON-rendering coverage).
//
// renderReceiptJson is a one-line passthrough (`return input.file`),
// so the tests focus on the contract guarantees the passthrough
// embodies:
//
//   1. REFERENCE EQUALITY — renderReceiptJson(input) === input.file.
//      No copy, no transformation. The caller (CLI) owns
//      JSON.stringify; reporters never mutate the persisted shape.
//
//   2. JSON-STRINGIFY-ABLE — the returned ReceiptFile round-trips
//      cleanly through JSON.stringify/parse (no circular refs, no
//      unrepresentable values). Includes the `null` preservation
//      check for pre_rollback_checkpoint_id in dry-run mode —
//      null is distinct from undefined and MUST survive as `null`
//      in JSON, not be omitted.
//
//   3. SCHEMA-VERBATIM OPTIONAL OMISSION (D38 exception to D20) —
//      optional ReceiptFile fields ABSENT in input remain absent
//      in the JSON output (active_session_warning,
//      un_ended_session_warning are the two optional-presence
//      fields per ReceiptFileSchema).
//
//   4. productVersion IGNORED — renderReceiptJson does not consume
//      `input.productVersion`. Two inputs differing only by
//      productVersion produce structurally-identical output, AND
//      the productVersion string never appears anywhere in the
//      rendered JSON (regression gate against a future interpolation
//      bug).
//
// Fixture-validity discipline: `makeReceiptFile` returns
// `ReceiptFileSchema.parse(receipt)`, so every fixture in this file
// is GUARANTEED schema-valid before it reaches the renderer.
// Renderer tests do not re-test the schema, but they MUST NOT pass
// against impossible artifacts (a fixture violating a D69 refine
// would let a renderer-output bug masquerade as test "success").

import {
  RECEIPT_FILE_SCHEMA_VERSION,
  type ReceiptFile,
  ReceiptFileSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { renderReceiptJson } from "../src/receipt-json.js";
import type { ReceiptRenderInput } from "../src/receipt-types.js";

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
  // Per D69 refine: apply mode requires non-null
  // pre_rollback_checkpoint_id; dry-run mode requires null. The
  // helper picks a default matching the mode; callers can override
  // explicitly for negative-test cases (none used in this file).
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
  // Schema-parse the constructed fixture so every test artifact is
  // guaranteed schema-valid before it reaches the renderer. Catches
  // accidental invalid outcome/error_code/refine combinations
  // immediately rather than letting renderer tests pass against
  // impossible artifacts.
  return ReceiptFileSchema.parse(receipt);
}

function makeRenderInput(opts: { file: ReceiptFile; productVersion?: string }): ReceiptRenderInput {
  return {
    file: opts.file,
    productVersion: opts.productVersion ?? "0.7.0-beta",
  };
}

// =============================================================================
// SECTION 1: reference equality
// =============================================================================

describe("renderReceiptJson — reference equality", () => {
  it("returns the input file reference (no copy)", () => {
    const file = makeReceiptFile();
    const output = renderReceiptJson(makeRenderInput({ file }));
    expect(output).toBe(file);
  });

  it("returns the input reference even when results / failures are populated", () => {
    const file = makeReceiptFile({
      results: [{ path: "src/foo.ts", outcome: "tracked_restored" }],
      failures: [
        {
          error_code: "extraction_conflict",
          message: "test failure",
          affected_paths: ["src/bar.ts"],
        },
      ],
    });
    const output = renderReceiptJson(makeRenderInput({ file }));
    expect(output).toBe(file);
  });

  it("returns the input reference for dry-run mode (pre_rollback_checkpoint_id = null)", () => {
    const file = makeReceiptFile({ mode: "dry_run" });
    const output = renderReceiptJson(makeRenderInput({ file }));
    expect(output).toBe(file);
  });
});

// =============================================================================
// SECTION 2: JSON-stringify-able
// =============================================================================

describe("renderReceiptJson — JSON-stringify-able", () => {
  it("returned value round-trips cleanly through JSON.stringify/parse", () => {
    const file = makeReceiptFile({
      mode: "apply",
      forced: true,
      results: [
        { path: "src/foo.ts", outcome: "tracked_restored" },
        { path: "src/bar.ts", outcome: "skipped_excluded", reason: "matches rollback.exclude" },
      ],
      failures: [
        {
          error_code: "verification",
          message: "post-restore hash mismatch",
          affected_paths: ["src/baz.ts"],
        },
      ],
      forcedUnrelatedDirtyPaths: ["src/quux.ts"],
      dirtyTreeCheck: "performed",
    });
    const output = renderReceiptJson(makeRenderInput({ file }));
    const parsed = JSON.parse(JSON.stringify(output)) as ReceiptFile;
    expect(parsed).toEqual(file);
  });

  it("dry-run receipt with null pre_rollback_checkpoint_id round-trips with null preserved (NOT omitted)", () => {
    // pre_rollback_checkpoint_id is a REQUIRED field that can be
    // null per the schema; null is distinct from undefined and MUST
    // survive JSON round-trip as `null`, not be omitted. This locks
    // the wire shape that a downstream re-parser (e.g., a future
    // analyzer reading rollback-dry-run-receipt.json) depends on.
    const file = makeReceiptFile({ mode: "dry_run" });
    const output = renderReceiptJson(makeRenderInput({ file }));
    // Typed-property cast (NOT Record<string, unknown>) so dot access
    // satisfies both TS4111 (no index signature) and Biome's
    // useLiteralKeys (no bracket access on a static-string key).
    const parsed = JSON.parse(JSON.stringify(output)) as {
      pre_rollback_checkpoint_id?: unknown;
    };
    expect("pre_rollback_checkpoint_id" in parsed).toBe(true);
    expect(parsed.pre_rollback_checkpoint_id).toBeNull();
  });
});

// =============================================================================
// SECTION 3: schema-verbatim optional omission (D38 exception to D20)
// =============================================================================

describe("renderReceiptJson — schema-verbatim optional omission", () => {
  it("optional warning fields ABSENT in input remain absent after JSON.stringify (no null rewrites)", () => {
    // ReceiptFileSchema's two optional-presence fields are
    // active_session_warning and un_ended_session_warning. Building
    // a fixture without either, JSON.stringify must omit both keys
    // rather than rewriting to null (per D38 exception to D20).
    const file = makeReceiptFile();
    const output = renderReceiptJson(makeRenderInput({ file }));
    const parsed = JSON.parse(JSON.stringify(output)) as Record<string, unknown>;
    expect("active_session_warning" in parsed).toBe(false);
    expect("un_ended_session_warning" in parsed).toBe(false);
  });

  it("optional warning fields PRESENT in input survive JSON round-trip as `true`", () => {
    // Build a dry-run receipt with both warnings set (the only
    // schema-valid combination for both fields true simultaneously
    // per D69 refines — apply mode forbids active_session_warning).
    // Also set dirty_tree_check: "skipped_no_after_state" to
    // satisfy the un_ended_session_warning coupling refine.
    const file = makeReceiptFile({
      mode: "dry_run",
      dirtyTreeCheck: "skipped_no_after_state",
      activeSessionWarning: true,
      unEndedSessionWarning: true,
    });
    const output = renderReceiptJson(makeRenderInput({ file }));
    // Typed-property cast (see "null preservation" test above for the
    // TS4111-vs-useLiteralKeys rationale).
    const parsed = JSON.parse(JSON.stringify(output)) as {
      active_session_warning?: unknown;
      un_ended_session_warning?: unknown;
    };
    expect(parsed.active_session_warning).toBe(true);
    expect(parsed.un_ended_session_warning).toBe(true);
  });
});

// =============================================================================
// SECTION 4: productVersion ignored
// =============================================================================

describe("renderReceiptJson — productVersion ignored", () => {
  it("two inputs differing only by productVersion produce structurally-identical output", () => {
    const file = makeReceiptFile({
      results: [{ path: "src/foo.ts", outcome: "tracked_restored" }],
    });
    const a = renderReceiptJson(makeRenderInput({ file, productVersion: "0.7.0-beta" }));
    const b = renderReceiptJson(makeRenderInput({ file, productVersion: "999.999.999-fake" }));
    // Both are reference-equal returns of `file` so reference
    // equality also holds — but the locked invariant is STRUCTURAL
    // identity (productVersion not consumed by renderReceiptJson).
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("productVersion does NOT appear anywhere in the JSON output (defensive)", () => {
    // A future regression that accidentally interpolated
    // productVersion into the output would be caught here as long
    // as the substring is distinctive enough not to collide with
    // any legitimate field value.
    const file = makeReceiptFile();
    const output = renderReceiptJson(
      makeRenderInput({ file, productVersion: "FENCEPOST-DO-NOT-LEAK" }),
    );
    expect(JSON.stringify(output)).not.toContain("FENCEPOST-DO-NOT-LEAK");
  });
});
