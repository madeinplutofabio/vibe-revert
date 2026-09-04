// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.8.0 step 0 -- the derived JSON Schema exports for the new persisted
// artifacts.
//
// A separate file rather than an addition to schemas.test.ts, following the
// receipt-file.test.ts and report-file.test.ts precedent: an artifact family
// keeps its assertions next to its own concerns.
//
// The point of these tests is NOT to restate that conversion succeeded. It is to
// pin the BOUNDARY the json-schema.ts header claims: representable zod
// constraints survive into JSON Schema, custom .refine() semantics do not. Both
// halves are asserted, because a consumer who validates only against the derived
// schema needs to know precisely which guarantees they did and did not get.

import { describe, expect, it } from "vitest";

import {
  RollbackAttemptJsonSchema,
  SelectiveRollbackReceiptJsonSchema,
  SessionContributionFileJsonSchema,
  SessionStateJsonSchema,
} from "../src/index.js";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/**
 * A JSON Schema node, typed loosely enough to navigate and strictly enough to
 * catch a misspelled keyword.
 *
 * The declared members are the JSON Schema KEYWORDS this file reads, so they can
 * be dot-accessed and a typo like `minItem` fails to compile. The index
 * signature admits probing an arbitrary keyword by name, which the negative
 * tests need in order to rule out encodings they do not expect.
 */
interface SchemaNode {
  readonly $schema?: string;
  readonly $ref?: string;
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly oneOf?: readonly SchemaNode[];
  readonly items?: SchemaNode;
  readonly minItems?: number;
  readonly minProperties?: number;
  readonly [keyword: string]: unknown;
}

const node = (value: unknown): SchemaNode => value as SchemaNode;
const props = (schema: unknown): Record<string, SchemaNode> => node(schema).properties ?? {};
const required = (schema: unknown): readonly string[] => node(schema).required ?? [];

/**
 * One named JSON property of a schema node.
 *
 * A function rather than a bracket expression at each call site, for a reason
 * beyond taste: `props()` returns a pure index-signature type, so TypeScript's
 * `noPropertyAccessFromIndexSignature` forbids `props(x).selection`, while
 * Biome's `useLiteralKeys` objects to `props(x)["selection"]`. Passing the name
 * as an argument satisfies both, and says plainly that these are data keys
 * rather than fields.
 *
 * Returns `undefined` on a miss rather than an empty node, so a navigation
 * mistake surfaces instead of quietly passing an existence check.
 */
const prop = (schema: unknown, name: string): SchemaNode | undefined => props(schema)[name];

/** The `selectors` node inside the attempt marker's selection. */
const SELECTORS = node(prop(prop(RollbackAttemptJsonSchema, "selection"), "selectors"));

/** The receipt roots as a union; find a branch by its `mode` const. */
function branchFor(mode: string): SchemaNode {
  const branches = node(SelectiveRollbackReceiptJsonSchema).oneOf ?? [];
  const found = branches.find((b) => prop(b, "mode")?.const === mode);
  if (found === undefined) throw new Error(`no oneOf branch with mode "${mode}"`);
  return found;
}

// =============================================================================
// Root shape
// =============================================================================

describe("root shape", () => {
  it.each([
    ["SessionContributionFileJsonSchema", SessionContributionFileJsonSchema],
    ["RollbackAttemptJsonSchema", RollbackAttemptJsonSchema],
  ])("%s roots as a closed object", (_name, schema) => {
    expect(node(schema).$schema).toBe(DRAFT);
    expect(node(schema).type).toBe("object");
    expect(node(schema).properties).toBeTypeOf("object");
    expect(node(schema).additionalProperties).toBe(false);
  });

  it("SelectiveRollbackReceiptJsonSchema roots as a union, NOT an object", () => {
    // Documented in the json-schema.ts header: the first export here whose root
    // is a `oneOf`. Tooling that assumes `type === "object"` across the module
    // breaks on this one, which is why it cannot join the it.each block in
    // schemas.test.ts.
    const root = node(SelectiveRollbackReceiptJsonSchema);
    expect(root.$schema).toBe(DRAFT);
    expect(root.type).toBeUndefined();
    expect(Array.isArray(root.oneOf)).toBe(true);
    expect(root.oneOf?.length).toBe(2);
  });

  it("both receipt branches are closed objects discriminated by a mode const", () => {
    for (const mode of ["dry_run", "apply"]) {
      const branch = branchFor(mode);
      expect(branch.type).toBe("object");
      expect(branch.additionalProperties).toBe(false);
      expect(prop(branch, "mode")).toEqual({ type: "string", const: mode });
    }
  });

  it("the two branches carry their full required sets", () => {
    // The exact sets, not their cardinality: a count would stay green if one
    // required field vanished and a wrong one took its place. `apply` omits
    // `post_command_integrity`, its one optional member.
    expect([...required(branchFor("dry_run"))].sort()).toEqual(
      [
        "checkpoint_id",
        "contribution_sha256",
        "eligibility",
        "mode",
        "out_of_scope_notice",
        "resolved_change_group_ids",
        "results",
        "rollback_id",
        "schema_version",
        "selectors",
        "session_id",
        "written_at",
      ].sort(),
    );

    expect([...required(branchFor("apply"))].sort()).toEqual(
      [
        "checkpoint_id",
        "contribution_sha256",
        "integrity",
        "mode",
        "out_of_scope_notice",
        "outcome",
        "post_command_integrity",
        "pre_rollback_checkpoint_id",
        "project_verification",
        "resolved_change_group_ids",
        "results",
        "rollback_id",
        "schema_version",
        "selectors",
        "session_id",
        "written_at",
      ].sort(),
    );
  });
});

// =============================================================================
// What SURVIVES conversion
// =============================================================================

describe("representable constraints survive", () => {
  it.each(["only", "except", "finding"])("%s keeps minItems: 1", (family) => {
    // `.min(1)` is representable, so the non-empty-family rule DOES reach a
    // JSON Schema consumer. This is the half of the boundary that holds.
    const array = node(prop(SELECTORS, family));
    expect(array.minItems).toBe(1);
    expect(array.type).toBe("array");
  });

  it("keeps the finding-id pattern", () => {
    expect(node(prop(SELECTORS, "finding")).items?.pattern).toBe("^fnd_[0-9a-f]{64}$");
  });

  it("keeps the change-group pattern and minItems on the resolved selection", () => {
    const selection = prop(RollbackAttemptJsonSchema, "selection");
    const resolved = node(prop(selection, "resolved_change_group_ids"));
    expect(resolved.minItems).toBe(1);
    expect(resolved.items?.pattern).toBe("^cg_[0-9a-f]{64}$");
  });

  it("keeps the risk threshold as a scalar enum, not an array", () => {
    const risk = node(prop(SELECTORS, "risk"));
    expect(risk.type).toBe("string");
    expect(risk.enum).toEqual(["low", "medium", "high", "critical"]);
  });

  it("keeps closure at every nesting level", () => {
    expect(node(prop(RollbackAttemptJsonSchema, "selection")).additionalProperties).toBe(false);
    expect(SELECTORS.additionalProperties).toBe(false);
  });

  it("marks the contribution's optional field optional and the rest required", () => {
    const req = required(SessionContributionFileJsonSchema);
    expect(req).not.toContain("detected_frameworks_at_end");
    expect([...req].sort()).toEqual(
      [
        "after_head_sha",
        "before_head_sha",
        "captured_at",
        "checkpoint_id",
        "ended_at",
        "entries",
        "schema_version",
        "session_id",
      ].sort(),
    );
  });

  it("marks every attempt-marker field required", () => {
    // The marker has no optional fields: a partially populated marker would be
    // exactly the ambiguity it exists to remove.
    expect([...required(RollbackAttemptJsonSchema)].sort()).toEqual(
      Object.keys(props(RollbackAttemptJsonSchema)).sort(),
    );
  });
});

// =============================================================================
// What does NOT survive conversion
// =============================================================================
//
// These are the assertions that make the json-schema.ts header verifiable rather
// than merely stated. Each one describes a guarantee a JSON-Schema-only consumer
// does not receive.

describe("Zod-only refinements do not survive", () => {
  it("loses the at-least-one-selector rule entirely", () => {
    // Every selector family is optional in the emitted object. Zod rejects `{}`,
    // but the derived schema loses the rule requiring at least one selector
    // family. The marker still carries its non-empty resolved_change_group_ids;
    // what is lost is the selector-side constraint that explains how that
    // resolution was requested.
    //
    // Checking only for an absent `required` would not establish that: the same
    // rule could survive as `minProperties: 1`, or as a conditional keyword, and
    // this test would stay green while nothing was actually lost. So every
    // encoding that could express it is checked.
    expect(SELECTORS.required).toBeUndefined();
    expect(SELECTORS.minProperties).toBeUndefined();

    for (const keyword of ["allOf", "anyOf", "oneOf", "not", "if", "then", "else"]) {
      expect(SELECTORS[keyword]).toBeUndefined();
    }
  });

  it("loses the ULID prefix shapes on all three identifier fields", () => {
    // `rollback_id`, `session_id`, and `pre_rollback_checkpoint_id` are
    // `nonBlankString` in the object body; their rb_/sess_/cp_ shapes are
    // file-level .refine() calls. The derived schema sees plain strings.
    for (const field of ["rollback_id", "session_id", "pre_rollback_checkpoint_id"]) {
      const p = node(prop(RollbackAttemptJsonSchema, field));
      expect(p.type).toBe("string");
      expect(p.pattern).toBeUndefined();
    }
  });

  it("expresses no conditional coupling on either receipt branch", () => {
    // The fourteen file-level refines -- result/group correspondence, dry-run
    // eligibility, the post-command-integrity iff, both pipeline-order rules,
    // the succeeded-conjunction -- would each need a conditional keyword to be
    // expressible. None is emitted, so a structurally valid receipt can still be
    // internally contradictory.
    const conditionals = [
      "if",
      "then",
      "else",
      "allOf",
      "anyOf",
      "not",
      "dependentSchemas",
      "dependentRequired",
    ];
    for (const mode of ["dry_run", "apply"]) {
      const branch = branchFor(mode);
      for (const keyword of conditionals) {
        expect(branch[keyword], `${mode} branch must not emit "${keyword}"`).toBeUndefined();
      }
    }
  });
});

// =============================================================================
// Nested components reach tooling without standalone exports
// =============================================================================

describe("nested components are reachable through their parents", () => {
  it("inlines the evaluation snapshot inside SessionStateJsonSchema", () => {
    // This is what justifies EvaluationSnapshot having no export of its own: it
    // is embedded in session.json, and tooling reaches it here. If a future zod
    // change emitted a $ref instead, this test fails and the decision gets
    // revisited rather than silently degrading.
    const snapshot = prop(SessionStateJsonSchema, "evaluation_snapshot");
    expect(snapshot).toBeTypeOf("object");
    expect(node(snapshot).$ref).toBeUndefined();
    expect(Object.keys(props(snapshot)).sort()).toEqual(
      [
        "checks",
        "frameworks",
        "risk_block_on",
        "risk_warn_on",
        "rollback_exclude",
        "verify_commands",
      ].sort(),
    );
  });

  it("exposes the contribution binding fields on SessionStateJsonSchema", () => {
    expect(props(SessionStateJsonSchema)).toHaveProperty("contribution_path");
    expect(props(SessionStateJsonSchema)).toHaveProperty("contribution_sha256");
  });
});
