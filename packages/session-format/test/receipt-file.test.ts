// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Test file for all M D-specific @viberevert/session-format contracts.
//
// Companion to schemas.test.ts (M A / M B surface) and report-file.test.ts
// (M C surface). The split follows the same precedent: M D adds enough new
// surface — the ReceiptFile wrapper with 10 cross-field refines, two new
// enums (RollbackMode, RollbackFileOutcome, DirtyTreeCheckOutcome), the
// RollbackFailure schema, the ROLLBACK_OUT_OF_SCOPE_NOTICE literal, the
// sorted-unique path-array enforcement on two fields, and the additive
// SessionStateSchema.after_status_z_path → ended one-way coupling refine —
// that a dedicated file keeps each test file focused on one milestone's
// surface.
//
// What lives here:
//   - RECEIPT_FILE_SCHEMA_VERSION constant + type-level lock.
//   - ROLLBACK_OUT_OF_SCOPE_NOTICE literal value lock.
//   - RollbackModeSchema, DirtyTreeCheckOutcomeSchema, RollbackFileOutcomeSchema
//     enum coverage (minimal — round-trip + reject-unknown-value).
//   - RollbackFileResultSchema, RollbackFailureSchema strict-object coverage
//     (including sorted-unique on affected_paths).
//   - ReceiptFileSchema's 10 refines (D69 + Blockers 1, 2 from Step 2 review):
//       (1-3)  ULID format on rollback_id / session_id / checkpoint_id
//       (4)    mode ↔ pre_rollback_checkpoint_id coupling
//       (5)    active_session_warning valid only in dry_run
//       (6)    D61b: un_ended_session_warning ↔ dirty_tree_check coupling
//       (7)    forced_unrelated_dirty_paths audit refine
//       (8)    skipped_unrelated_dirt results valid only in dry_run
//       (9)    pre_rollback_checkpoint_id ULID format when non-null
//       (10)   forced=true valid only in apply mode
//   - sorted-unique enforcement on forced_unrelated_dirty_paths and
//     failures[].affected_paths.
//   - Locked corner case: active-session + un-ended dry-run carries BOTH
//     warnings simultaneously and validates.
//   - ReceiptFileJsonSchema export sanity (D21 invariant for the new wrapper).
//   - SessionStateSchema's M D additive after_status_z_path → ended refine.

import { describe, expect, it } from "vitest";

import type { ReceiptFile, ReceiptFileSchemaVersion } from "../src/index.js";
import {
  RECEIPT_FILE_SCHEMA_VERSION,
  ReceiptFileJsonSchema,
  ReceiptFileSchema,
  ROLLBACK_OUT_OF_SCOPE_NOTICE,
  SessionStateSchema,
} from "../src/index.js";

// Type-level assertion: locks that ReceiptFileSchemaVersion is exported and
// equals the literal "1.0". If the type alias is removed from the barrel or
// changes value, this fails to compile (caught by `pnpm typecheck`).
const _RECEIPT_FILE_SCHEMA_VERSION_TYPE_CHECK: ReceiptFileSchemaVersion = "1.0";
void _RECEIPT_FILE_SCHEMA_VERSION_TYPE_CHECK;

// =============================================================================
// Reusable test data
//
// 26-char Crockford base32 bodies. Crockford alphabet = 0-9 + A-Z minus
// I, L, O, U. The regexes used by the ReceiptFileSchema refines are
// /^rb_[0-9A-HJKMNP-TV-Z]{26}$/, /^sess_[...]/, /^cp_[...]/.
// =============================================================================

const ULID_BODY_A = "01JV8Y7W2M7AABCDEFGHJKMNPQ"; // 26 chars, all valid Crockford
const ULID_BODY_B = "01JV8Y7W2M7AABCDEFGHJKMNPR"; // 26 chars, different last char
const VALID_RB_ID = `rb_${ULID_BODY_A}`;
const VALID_SESS_ID = `sess_${ULID_BODY_A}`;
const VALID_CP_ID = `cp_${ULID_BODY_A}`;
const OTHER_CP_ID = `cp_${ULID_BODY_B}`;

/** Minimal valid dry-run receipt; tests clone-and-mutate this. */
const VALID_DRY_RUN: ReceiptFile = {
  schema_version: "1.0",
  rollback_id: VALID_RB_ID,
  session_id: VALID_SESS_ID,
  checkpoint_id: VALID_CP_ID,
  mode: "dry_run",
  forced: false,
  written_at: "2026-01-01T00:00:00Z",
  pre_rollback_checkpoint_id: null,
  results: [],
  failures: [],
  forced_unrelated_dirty_paths: [],
  dirty_tree_check: "performed",
  out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
};

/** Minimal valid apply receipt. */
const VALID_APPLY: ReceiptFile = {
  ...VALID_DRY_RUN,
  mode: "apply",
  pre_rollback_checkpoint_id: OTHER_CP_ID,
};

// =============================================================================
// Constants + literal lock
// =============================================================================

describe("RECEIPT_FILE_SCHEMA_VERSION (M D)", () => {
  it('equals the literal "1.0"', () => {
    expect(RECEIPT_FILE_SCHEMA_VERSION).toBe("1.0");
  });
});

describe("ROLLBACK_OUT_OF_SCOPE_NOTICE (M D D62)", () => {
  it("starts with the locked sentence about what is restored", () => {
    expect(
      ROLLBACK_OUT_OF_SCOPE_NOTICE.startsWith(
        "Vibe-revert restores tracked file content, untracked file content, and the git index.",
      ),
    ).toBe(true);
  });
  it("ends with the locked recovery directive", () => {
    expect(ROLLBACK_OUT_OF_SCOPE_NOTICE.endsWith("Recover those manually.")).toBe(true);
  });
  it("mentions all locked out-of-scope categories", () => {
    expect(ROLLBACK_OUT_OF_SCOPE_NOTICE).toContain("database schemas/data");
    expect(ROLLBACK_OUT_OF_SCOPE_NOTICE).toContain("deployed artifacts");
    expect(ROLLBACK_OUT_OF_SCOPE_NOTICE).toContain("package registry publishes");
    expect(ROLLBACK_OUT_OF_SCOPE_NOTICE).toContain("external API state");
    expect(ROLLBACK_OUT_OF_SCOPE_NOTICE).toContain("environment variable mutations");
    expect(ROLLBACK_OUT_OF_SCOPE_NOTICE).toContain("OS-level state outside the repo");
    expect(ROLLBACK_OUT_OF_SCOPE_NOTICE).toContain("process-side effects");
  });
});

// =============================================================================
// ReceiptFileSchema — round-trip + refines
// =============================================================================

describe("ReceiptFileSchema (M D) — round-trip", () => {
  it("round-trips a minimal dry-run receipt", () => {
    expect(ReceiptFileSchema.parse(VALID_DRY_RUN)).toEqual(VALID_DRY_RUN);
  });
  it("round-trips a minimal apply receipt", () => {
    expect(ReceiptFileSchema.parse(VALID_APPLY)).toEqual(VALID_APPLY);
  });
  it("rejects unknown top-level fields (strictObject)", () => {
    expect(() => ReceiptFileSchema.parse({ ...VALID_DRY_RUN, unknown_field: "value" })).toThrow();
  });
});

describe("ReceiptFileSchema refine (1) rollback_id ULID format", () => {
  it("rejects rollback_id without rb_ prefix", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, rollback_id: `rpt_${ULID_BODY_A}` }),
    ).toThrow();
  });
  it("rejects rollback_id with wrong-length body", () => {
    expect(() => ReceiptFileSchema.parse({ ...VALID_DRY_RUN, rollback_id: "rb_short" })).toThrow();
  });
  it("rejects rollback_id with forbidden Crockford char (L)", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_DRY_RUN,
        rollback_id: "rb_01JV8Y7W2M7AABCDEFGHJKMNPL",
      }),
    ).toThrow();
  });
});

describe("ReceiptFileSchema refine (2) session_id ULID format", () => {
  it("rejects session_id without sess_ prefix", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, session_id: `rb_${ULID_BODY_A}` }),
    ).toThrow();
  });
});

describe("ReceiptFileSchema refine (3) checkpoint_id ULID format", () => {
  it("rejects checkpoint_id without cp_ prefix", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, checkpoint_id: `sess_${ULID_BODY_A}` }),
    ).toThrow();
  });
});

describe("ReceiptFileSchema refine (4) mode ↔ pre_rollback_checkpoint_id coupling", () => {
  it("rejects apply mode with null pre_rollback_checkpoint_id", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_APPLY, pre_rollback_checkpoint_id: null }),
    ).toThrow();
  });
  it("rejects dry_run mode with non-null pre_rollback_checkpoint_id", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, pre_rollback_checkpoint_id: OTHER_CP_ID }),
    ).toThrow();
  });
});

describe("ReceiptFileSchema refine (9) pre_rollback_checkpoint_id ULID format", () => {
  it("rejects non-null pre_rollback_checkpoint_id without cp_ shape", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_APPLY, pre_rollback_checkpoint_id: "bad" }),
    ).toThrow();
  });
  it("rejects non-null pre_rollback_checkpoint_id with wrong prefix", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_APPLY, pre_rollback_checkpoint_id: VALID_RB_ID }),
    ).toThrow();
  });
  it("accepts a valid cp_ pre_rollback_checkpoint_id", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_APPLY, pre_rollback_checkpoint_id: OTHER_CP_ID }),
    ).not.toThrow();
  });
  it("accepts null pre_rollback_checkpoint_id in dry_run mode", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, pre_rollback_checkpoint_id: null }),
    ).not.toThrow();
  });
});

describe("ReceiptFileSchema refine (5) active_session_warning only in dry-run", () => {
  it("accepts active_session_warning in dry_run mode", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, active_session_warning: true }),
    ).not.toThrow();
  });
  it("rejects active_session_warning in apply mode", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_APPLY, active_session_warning: true }),
    ).toThrow();
  });
});

describe("ReceiptFileSchema refine (6) revised D61b coupling", () => {
  it("rejects dirty_tree_check='skipped_no_after_state' without un_ended_session_warning", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_DRY_RUN,
        dirty_tree_check: "skipped_no_after_state",
      }),
    ).toThrow();
  });
  it("rejects un_ended_session_warning without skipped_no_after_state", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, un_ended_session_warning: true }),
    ).toThrow();
  });
  it("rejects apply + un_ended_session_warning + forced=false", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        forced: false,
        un_ended_session_warning: true,
        dirty_tree_check: "skipped_no_after_state",
      }),
    ).toThrow();
  });
  it("accepts dry_run + un_ended_session_warning + forced=false (informational case)", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_DRY_RUN,
        un_ended_session_warning: true,
        dirty_tree_check: "skipped_no_after_state",
      }),
    ).not.toThrow();
  });
  it("accepts apply + un_ended_session_warning + forced=true (escape hatch)", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        forced: true,
        un_ended_session_warning: true,
        dirty_tree_check: "skipped_no_after_state",
      }),
    ).not.toThrow();
  });
});

describe("ReceiptFileSchema refine (7) forced_unrelated_dirty_paths audit", () => {
  it("rejects non-empty + dry_run", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, forced_unrelated_dirty_paths: ["foo.ts"] }),
    ).toThrow();
  });
  it("rejects non-empty + forced=false", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        forced: false,
        forced_unrelated_dirty_paths: ["foo.ts"],
      }),
    ).toThrow();
  });
  it("rejects non-empty + dirty_tree_check='skipped_no_after_state'", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        forced: true,
        un_ended_session_warning: true,
        dirty_tree_check: "skipped_no_after_state",
        forced_unrelated_dirty_paths: ["foo.ts"],
      }),
    ).toThrow();
  });
  it("accepts non-empty + apply + forced=true + dirty_tree_check='performed'", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        forced: true,
        forced_unrelated_dirty_paths: ["bar.md", "foo.ts"],
      }),
    ).not.toThrow();
  });
  it("accepts empty (default) in any valid configuration", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_APPLY, forced_unrelated_dirty_paths: [] }),
    ).not.toThrow();
  });
});

describe("ReceiptFileSchema refine (8) skipped_unrelated_dirt dry-run-only", () => {
  it("rejects results[].outcome='skipped_unrelated_dirt' in apply mode", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        results: [{ path: "foo.ts", outcome: "skipped_unrelated_dirt" }],
      }),
    ).toThrow();
  });
  it("accepts results[].outcome='skipped_unrelated_dirt' in dry_run mode", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_DRY_RUN,
        results: [{ path: "foo.ts", outcome: "skipped_unrelated_dirt" }],
      }),
    ).not.toThrow();
  });
  it("accepts results[] without any skipped_unrelated_dirt entries in any mode", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        results: [{ path: "foo.ts", outcome: "tracked_restored" }],
      }),
    ).not.toThrow();
  });
});

describe("ReceiptFileSchema refine (10) forced=true only in apply mode", () => {
  it("rejects dry_run + forced=true", () => {
    expect(() => ReceiptFileSchema.parse({ ...VALID_DRY_RUN, forced: true })).toThrow();
  });
  it("accepts apply + forced=true", () => {
    expect(() => ReceiptFileSchema.parse({ ...VALID_APPLY, forced: true })).not.toThrow();
  });
  it("accepts dry_run + forced=false (default)", () => {
    expect(() => ReceiptFileSchema.parse({ ...VALID_DRY_RUN, forced: false })).not.toThrow();
  });
});

describe("ReceiptFileSchema — sorted-unique path-array enforcement (A9 protection)", () => {
  it("rejects out-of-order forced_unrelated_dirty_paths", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        forced: true,
        forced_unrelated_dirty_paths: ["zeta.ts", "alpha.ts"],
      }),
    ).toThrow();
  });
  it("rejects duplicate forced_unrelated_dirty_paths", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        forced: true,
        forced_unrelated_dirty_paths: ["foo.ts", "foo.ts"],
      }),
    ).toThrow();
  });
  it("accepts sorted-unique forced_unrelated_dirty_paths", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        forced: true,
        forced_unrelated_dirty_paths: ["alpha.ts", "beta.ts", "zeta.ts"],
      }),
    ).not.toThrow();
  });
  it("rejects out-of-order failures[].affected_paths", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        failures: [
          {
            error_code: "verification",
            message: "boom",
            affected_paths: ["zeta.ts", "alpha.ts"],
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects duplicate failures[].affected_paths", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        failures: [
          {
            error_code: "verification",
            message: "boom",
            affected_paths: ["foo.ts", "foo.ts"],
          },
        ],
      }),
    ).toThrow();
  });
  it("accepts sorted-unique failures[].affected_paths", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_APPLY,
        failures: [
          {
            error_code: "verification",
            message: "boom",
            affected_paths: ["alpha.ts", "beta.ts", "zeta.ts"],
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("ReceiptFileSchema — corner case: active-session + un-ended dry-run", () => {
  it("accepts the combination (legitimately co-occurs on dry-run against an active session)", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_DRY_RUN,
        active_session_warning: true,
        un_ended_session_warning: true,
        dirty_tree_check: "skipped_no_after_state",
      }),
    ).not.toThrow();
  });
});

describe("ReceiptFileSchema — out_of_scope_notice literal", () => {
  it("rejects any string other than ROLLBACK_OUT_OF_SCOPE_NOTICE", () => {
    expect(() =>
      ReceiptFileSchema.parse({ ...VALID_DRY_RUN, out_of_scope_notice: "wrong text" }),
    ).toThrow();
  });
  it("accepts the exact ROLLBACK_OUT_OF_SCOPE_NOTICE string", () => {
    expect(() =>
      ReceiptFileSchema.parse({
        ...VALID_DRY_RUN,
        out_of_scope_notice: ROLLBACK_OUT_OF_SCOPE_NOTICE,
      }),
    ).not.toThrow();
  });
});

// =============================================================================
// ReceiptFileJsonSchema sanity (D21 invariant for the new wrapper)
// =============================================================================

describe("ReceiptFileJsonSchema (M D)", () => {
  it("exports a JSON Schema referencing the M D field names", () => {
    const serialized = JSON.stringify(ReceiptFileJsonSchema);
    expect(serialized).toContain("rollback_id");
    expect(serialized).toContain("forced_unrelated_dirty_paths");
    expect(serialized).toContain("dirty_tree_check");
    expect(serialized).toContain("out_of_scope_notice");
  });
});

// =============================================================================
// SessionStateSchema — M D additive after_status_z_path field + refine
// =============================================================================

describe("SessionStateSchema (M D additive after_status_z_path)", () => {
  const LEGACY_ENDED_SESSION = {
    schema_version: "1.0",
    session_id: VALID_SESS_ID,
    checkpoint_id: VALID_CP_ID,
    started_at: "2026-01-01T00:00:00Z",
    ended_at: "2026-01-01T00:01:00Z",
    before_status_path: ".viberevert/sessions/sess_X/before-status.txt",
    after_status_path: ".viberevert/sessions/sess_X/after-status.txt",
    commands_log_path: ".viberevert/sessions/sess_X/commands.log",
    // NOTE: no after_status_z_path (legacy M B/M C session).
  };

  it("accepts a legacy ended session WITHOUT after_status_z_path (M B/M C compat)", () => {
    expect(() => SessionStateSchema.parse(LEGACY_ENDED_SESSION)).not.toThrow();
  });

  it("accepts an M D-aware ended session WITH after_status_z_path", () => {
    expect(() =>
      SessionStateSchema.parse({
        ...LEGACY_ENDED_SESSION,
        after_status_z_path: ".viberevert/sessions/sess_X/after-status.z",
      }),
    ).not.toThrow();
  });

  it("rejects after_status_z_path on an active session (no ended_at, no after_status_path)", () => {
    expect(() =>
      SessionStateSchema.parse({
        schema_version: "1.0",
        session_id: VALID_SESS_ID,
        checkpoint_id: VALID_CP_ID,
        started_at: "2026-01-01T00:00:00Z",
        before_status_path: ".viberevert/sessions/sess_X/before-status.txt",
        after_status_z_path: ".viberevert/sessions/sess_X/after-status.z",
        commands_log_path: ".viberevert/sessions/sess_X/commands.log",
      }),
    ).toThrow();
  });
});
