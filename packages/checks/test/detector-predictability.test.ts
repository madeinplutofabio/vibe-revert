// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.9.0 step 13 preparation: detector predictability, as an invariant over the
// WHOLE registry rather than per-detector good intentions.
//
// =============================================================================
// Why this file, when every detector already has its own test suite
// =============================================================================
//
// Those suites are thorough, and none of them can answer two questions that
// only exist across the registry:
//
//   1. Can every registered detector actually emit? A detector that has become
//      permanently silent still passes every "does not fire on X" assertion it
//      owns. That is the exact failure shape the step 2 defect taught: a test
//      that cannot distinguish "correctly silent" from "broken" proves nothing.
//      So each detector here gets a POSITIVE control, and the file exists mainly
//      to hold them in one place where their absence is visible.
//
//   2. Is a finding's rule id derivable from its detector's identity? Step 13
//      requires machine output to identify the detector. `CheckResultBaseSchema`
//      carries `id` and no detector field, so `id` is the only provenance there
//      is, and it is provenance ONLY IF the namespacing rule holds.
//
// That rule is already documented, in `types.ts` on `Check.id`: single-rule
// checks use a static id, multi-rule checks namespace per matched rule under it.
// Nothing enforced it, and one detector violated it: `migrationsCheck` declared
// `migrations` while emitting `migration.missing-down` and
// `migration.danger-term.*`, so a consumer mapping a finding back to its
// detector would look for a detector named `migration` and find none. Fixed by
// correcting the check id, which is safe because nothing reads it: the engine
// uses `finding.id` throughout, and `deriveFindingId` hashes the EMITTED id, so
// renaming the emitted ids was never an option.
//
// =============================================================================
// The anti-rot property
// =============================================================================
//
// The trigger table below is asserted to cover `BUILTIN_CHECKS` EXACTLY, in both
// directions. Registering a detector without giving it a positive control fails
// this file, which is the only way a coverage claim stays true as detectors are
// added. Same shape as the support-manifest validator's bidirectional coverage.

import type { ChangedFileInput, CheckContext } from "@viberevert/checks";
import { BUILTIN_CHECKS, type Check, runChecks } from "@viberevert/checks";
import { describe, expect, it } from "vitest";

// Secret-shaped literals are CONSTRUCTED by interpolation, never written whole.
// A literal secret in a committed fixture trips GitHub Push Protection while
// being functionally identical to the detector. See the secrets suite, which
// established this.
const STRIPE_FIXTURE = `sk${"_live_"}TESTFIXTUREONLY`;

function changed(
  path: string,
  addedLines: readonly { line: number; text: string }[] = [],
): ChangedFileInput {
  return { path, status: "modified", addedLines, removedLines: [], isBinary: false };
}

/** Every toggle on, so no finding is filtered before it can be counted. */
const ALL_CATEGORIES_ENABLED = {
  secrets: true,
  dependencies: true,
  migrations: true,
  auth: true,
  payments: true,
  infra: true,
  tests: true,
  scope_expansion: true,
} as const;

function ctx(
  changedFiles: readonly ChangedFileInput[],
  extra: { readonly task?: string; readonly detectedFrameworks?: readonly string[] } = {},
): CheckContext {
  return {
    changedFiles,
    detectedFrameworks: extra.detectedFrameworks ?? [],
    configChecks: ALL_CATEGORIES_ENABLED,
    ...(extra.task !== undefined ? { task: extra.task } : {}),
  };
}

/**
 * One minimal input per registered detector that MUST make it emit.
 *
 * Minimal on purpose: a trigger carrying more than it needs stops being a
 * control, because a later change can break the detector while some incidental
 * part of the fixture keeps the assertion green.
 */
const TRIGGERS: ReadonlyArray<{ readonly checkId: string; readonly context: CheckContext }> = [
  {
    // A deployment path, matched by the code-owned PATH_RULES table.
    checkId: "path-classifier",
    context: ctx([changed(".github/workflows/deploy.yml")]),
  },
  {
    // A new dependency key, present on an added line and absent from removed
    // lines, which is the step 2 per-file key comparison.
    checkId: "dependencies",
    context: ctx([changed("package.json", [{ line: 5, text: `    "lodash": "^4.0.0",` }])]),
  },
  {
    // A Rails migration dropping a table with no `def down`.
    checkId: "migration",
    context: ctx(
      [
        changed("db/migrate/20260101000000_drop.rb", [
          { line: 1, text: "class DropUsers < ActiveRecord::Migration[7.1]" },
          { line: 2, text: "  def up" },
          { line: 3, text: "    drop_table :users" },
          { line: 4, text: "  end" },
          { line: 5, text: "end" },
        ]),
      ],
      { detectedFrameworks: ["rails"] },
    ),
  },
  {
    checkId: "secrets.regex",
    context: ctx([changed("src/config.ts", [{ line: 1, text: `const k = "${STRIPE_FIXTURE}";` }])]),
  },
  {
    // A Laravel middleware changed with no accompanying test.
    checkId: "test-gap",
    context: ctx([changed("app/Http/Middleware/AuthMiddleware.php")], {
      detectedFrameworks: ["laravel"],
    }),
  },
  {
    // A risky deployment path with near-zero token overlap against the task.
    checkId: "scope-expansion",
    context: ctx([changed(".github/workflows/deploy.yml")], {
      task: "rename a tooltip label in the settings sidebar",
    }),
  },
];

const checkById = (id: string): Check => {
  const found = BUILTIN_CHECKS.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no registered check with id ${JSON.stringify(id)}`);
  return found;
};

// =============================================================================
// Coverage, both directions
// =============================================================================

describe("the trigger table covers the registry exactly", () => {
  it("every registered check has a trigger", () => {
    const triggered = new Set(TRIGGERS.map((t) => t.checkId));
    const missing = BUILTIN_CHECKS.map((c) => c.id).filter((id) => !triggered.has(id));
    // The anti-rot assertion: registering a detector without a positive control
    // fails here, rather than silently reducing what "every detector" means.
    expect(missing).toEqual([]);
  });

  it("every trigger names a registered check", () => {
    const registered = new Set(BUILTIN_CHECKS.map((c) => c.id));
    expect(TRIGGERS.map((t) => t.checkId).filter((id) => !registered.has(id))).toEqual([]);
  });

  it("no trigger is listed twice", () => {
    const ids = TRIGGERS.map((t) => t.checkId);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

// =============================================================================
// Positive controls
// =============================================================================

describe("every registered detector can emit", () => {
  it.each(
    TRIGGERS.map((t) => [t.checkId, t] as const),
  )("%s emits at least one finding for its trigger", (_label, trigger) => {
    const result = runChecks([checkById(trigger.checkId)], trigger.context);
    // A detector that cannot emit makes every negative assertion it owns
    // vacuous. This is the control that keeps them meaningful.
    expect(result.results.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// The namespacing rule that makes `finding.id` usable as provenance
// =============================================================================

describe("every emitted rule id is namespaced under its detector id", () => {
  it.each(
    TRIGGERS.map((t) => [t.checkId, t] as const),
  )("%s emits only ids equal to or prefixed by its check id", (_label, trigger) => {
    const check = checkById(trigger.checkId);
    const result = runChecks([check], trigger.context);
    const offenders = result.results
      .map((r) => r.id)
      .filter((id) => id !== check.id && !id.startsWith(`${check.id}.`));
    // The documented rule on `Check.id`, enforced. Without it a consumer
    // cannot map a finding back to the detector that produced it, and `id` is
    // the only provenance a finding carries.
    expect(offenders).toEqual([]);
  });

  it("no check id is a dot-prefix of another, so the mapping is unambiguous", () => {
    // If `a` and `a.b` were both check ids, a finding `a.b.c` would be
    // attributable to either, and provenance would stop being a function.
    const ids = BUILTIN_CHECKS.map((c) => c.id);
    const ambiguous = ids.filter((outer) =>
      ids.some((inner) => inner !== outer && inner.startsWith(`${outer}.`)),
    );
    expect(ambiguous).toEqual([]);
  });
});
