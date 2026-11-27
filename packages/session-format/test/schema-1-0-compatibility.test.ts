// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.9.0 step 3: the 1.0 -> 1.1 normalization for both rollback artifacts.
//
// =============================================================================
// Why the fixtures are REAL output and not hand-built
// =============================================================================
//
// `test/fixtures/schema-1-0/attempt.json` and `receipt.json` were produced by
// running the PUBLISHED `viberevert@0.8.0-beta.2` from npm against a throwaway
// repository: install, init, start, edit two files, end, then
// `rollback <session> --only 'src/a.ts' --apply`. They are byte-for-byte what a
// user has on disk today, including field order.
//
// This matters more than it looks. The 0.8.0-beta.0/beta.1 defect that forced
// the beta.2 release was exactly this shape of mistake: the consumer of
// `source_contribution_sha256` was proven against a synthetic `ReportFile` the
// test built itself, with the field present, so the guard passed forever while
// no producer ever wrote it. A hand-built "1.0" fixture here would reproduce
// that error precisely, because it would be built from this file's idea of 1.0
// rather than from the released writer's.
//
// If these fixtures are ever regenerated, they must come from a published
// release, never from this repository's working tree.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  RollbackAttemptAnyVersionSchema,
  RollbackAttemptSchema,
  SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION,
  SelectiveRollbackReceiptAnyVersionSchema,
  SelectiveRollbackReceiptSchema,
} from "../src/index.js";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/schema-1-0/${name}`, import.meta.url), "utf8"));

const ATTEMPT_1_0 = read("attempt.json");
const RECEIPT_1_0 = read("receipt.json");

// Narrow views of the raw 1.0 JSON. Declared as explicit interfaces rather than
// `Record<string, unknown>` because an index signature makes dot access a
// `noPropertyAccessFromIndexSignature` error while Biome's `useLiteralKeys`
// simultaneously rejects bracket access: the two tools cannot both be satisfied
// through an index signature.
interface Raw1_0Attempt {
  readonly schema_version: string;
  readonly rollback_id: string;
  readonly session_id: string;
  readonly contribution_sha256: string;
  readonly pre_rollback_checkpoint_id: string;
  readonly written_at: string;
  readonly selection: { readonly resolved_change_group_ids: readonly string[] };
}
const RAW_ATTEMPT = ATTEMPT_1_0 as Raw1_0Attempt;

// =============================================================================
// The fixtures really are 1.0
// =============================================================================

describe("the committed fixtures are genuine 1.0 artifacts", () => {
  // Without this, every assertion below could be passing against something that
  // is already 1.1, and the normalization would be untested.
  it("attempt.json declares 1.0 and carries selectors WITHOUT a discriminant", () => {
    expect(RAW_ATTEMPT.schema_version).toBe("1.0");
    expect(RAW_ATTEMPT.selection).toHaveProperty("selectors");
    expect(RAW_ATTEMPT.selection).not.toHaveProperty("source");
  });

  it("receipt.json declares 1.0 and carries top-level selectors", () => {
    expect((RECEIPT_1_0 as { readonly schema_version: string }).schema_version).toBe("1.0");
    expect(RECEIPT_1_0).toHaveProperty("selectors");
    expect(RECEIPT_1_0).not.toHaveProperty("selection_source");
  });
});

// =============================================================================
// The writer schema refuses them, which is the substance of the bump
// =============================================================================

describe("the current writer schemas reject 1.0", () => {
  // Not pedantry. Every schema here is `z.strictObject`, so accepting 1.0 in
  // the writer path would let a producer silently emit the superseded shape and
  // nothing would notice until a reader somewhere else broke.
  it("RollbackAttemptSchema rejects a 1.0 marker", () => {
    expect(RollbackAttemptSchema.safeParse(ATTEMPT_1_0).success).toBe(false);
  });

  it("SelectiveRollbackReceiptSchema rejects a 1.0 receipt", () => {
    expect(SelectiveRollbackReceiptSchema.safeParse(RECEIPT_1_0).success).toBe(false);
  });
});

// =============================================================================
// The any-version readers accept and normalize them
// =============================================================================

describe("the any-version readers normalize 1.0 upward", () => {
  it("lifts a 1.0 attempt marker's selectors into the selectors arm", () => {
    const attempt = RollbackAttemptAnyVersionSchema.parse(ATTEMPT_1_0);
    expect(attempt.schema_version).toBe(ROLLBACK_ATTEMPT_SCHEMA_VERSION);
    expect(attempt.selection.source).toEqual({
      kind: "selectors",
      selectors: { only: ["src/a.ts"] },
    });
  });

  it("preserves every other 1.0 attempt field verbatim", () => {
    // The lift must touch the selection and the version, and nothing else. A
    // normalization that quietly dropped the recovery handle would turn a
    // readable stranded marker into an unrecoverable one.
    const attempt = RollbackAttemptAnyVersionSchema.parse(ATTEMPT_1_0);
    expect(attempt.rollback_id).toBe(RAW_ATTEMPT.rollback_id);
    expect(attempt.session_id).toBe(RAW_ATTEMPT.session_id);
    expect(attempt.contribution_sha256).toBe(RAW_ATTEMPT.contribution_sha256);
    expect(attempt.pre_rollback_checkpoint_id).toBe(RAW_ATTEMPT.pre_rollback_checkpoint_id);
    expect(attempt.written_at).toBe(RAW_ATTEMPT.written_at);
    expect(attempt.selection.resolved_change_group_ids).toEqual(
      RAW_ATTEMPT.selection.resolved_change_group_ids,
    );
  });

  it("lifts a 1.0 receipt's selectors into selection_source", () => {
    const receipt = SelectiveRollbackReceiptAnyVersionSchema.parse(RECEIPT_1_0);
    expect(receipt.schema_version).toBe(SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION);
    expect(receipt.selection_source).toEqual({
      kind: "selectors",
      selectors: { only: ["src/a.ts"] },
    });
    expect(receipt).not.toHaveProperty("selectors");
  });

  it("normalization is idempotent: a 1.1 artifact passes through unchanged", () => {
    // The union tries 1.1 first. If that ordering ever regressed, a valid 1.1
    // artifact could be reported as a malformed 1.0 one.
    const lifted = RollbackAttemptAnyVersionSchema.parse(ATTEMPT_1_0);
    expect(RollbackAttemptAnyVersionSchema.parse(lifted)).toEqual(lifted);

    const liftedReceipt = SelectiveRollbackReceiptAnyVersionSchema.parse(RECEIPT_1_0);
    expect(SelectiveRollbackReceiptAnyVersionSchema.parse(liftedReceipt)).toEqual(liftedReceipt);
  });

  it("a malformed artifact is still refused by the any-version reader", () => {
    // Version tolerance must not become general leniency.
    const broken = { ...RAW_ATTEMPT, rollback_id: "not-a-ulid" };
    expect(RollbackAttemptAnyVersionSchema.safeParse(broken).success).toBe(false);

    const unknownVersion = { ...RAW_ATTEMPT, schema_version: "0.9" };
    expect(RollbackAttemptAnyVersionSchema.safeParse(unknownVersion).success).toBe(false);
  });
});
