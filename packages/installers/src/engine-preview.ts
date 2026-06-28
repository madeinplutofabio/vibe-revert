// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Engine preview for @viberevert/installers.
//
// === ENTRY ===
// preview(plan, ctx) -> PreviewOutcome
//   Pure read-only orchestration. Models what apply WOULD do without
//   mutating anything. Delegates per-op classification, reason
//   codes, force-reinstall scope, per-kind SHA discipline, and plan-
//   level uniqueness rules to the shared classifier core in
//   ./engine-classify.js -- preview and apply must agree byte-for-
//   byte on those.
//
// === OUTCOMES ===
//   - PreviewOutcome.refused: adapter-plan refused upstream
//     (passed through verbatim) OR engine-classified refusal.
//     When multiple ops refuse, outcome.reasonCode is the FIRST
//     refusal's code (plan.ops order) and outcome.message
//     enumerates all refusals' [reasonCode]-prefixed detail lines.
//   - PreviewOutcome.noop: integrations record exists, current
//     bytes match recorded SHA, desired SHA matches recorded SHA
//     for EVERY op.
//   - PreviewOutcome.applicable: transaction would run. PreviewDiff
//     carries per-file unified diffs in plan.ops order. Adoption
//     case (per-op currents already match desired for all ops with
//     at least one adopt) returns applicable with diff.perFile = []
//     and the locked adoption humanSummary; non-adoption applicable
//     carries plan.humanSummary.
//
// === BOUNDARY (locked by 2H.1 scope) ===
//
// NO writeFileAtomic, writeIntegrationsFile, writeJournal,
// updateJournal, deleteJournal, acquireLock, mkdir, unlink, chmod.
// Apply-only concerns NOT touched here.
//
// May read filesystem: assertSafeTarget (lstat / stat) on each
// target; readFile on each target's current bytes (UTF-8 decode --
// installer targets are TEXT CONFIG FILES; binary targets are out
// of scope by design); readIntegrationsFile.
//
// === ERROR PROPAGATION ===
//
// NOT wrapped in 2H.1 (propagated to caller):
//   - SymlinkTargetRefusal, IntegrationTargetTooLargeError,
//     TargetOutsideRepoRootError,
//     IntegrationTargetParentNotDirectoryError,
//     IntegrationTargetNotFileError -- from assertSafeTarget
//   - IntegrationsCorruptedError, IntegrationsSchemaVersionError --
//     from readIntegrationsFile
//   - SyntaxError -- from JSON.parse of an invalid json-key-merge
//     existing outer file (decision 3b in the 2H.1 design block;
//     classifier throws via parseJsonObjectOrEmpty). 2J debt: this
//     should eventually become a typed installer error / preview
//     refusal for better public UX; raw SyntaxError is acceptable
//     for 2H.1 internal development.
//   - I/O errors (ENOENT mapped internally to "absent"; other
//     errno values propagate)
//
// === LINE-ENDING FIDELITY ===
//
// Delegated to ./engine-classify.js. chooseTargetLineEnding +
// computeDesiredFullFileBytes inside classifyOp drive line-ending
// normalization for both diff display AND fullFileSha256AfterWrite
// drift comparison. Missing file or mixed/unknown bytes default to
// LF; CRLF host file -> CRLF desired. Mirrors what apply will do at
// write time so preview's drift check uses the same convention
// apply will record.
//
// === PREVIEW TOP-LEVEL ORDER ===
//
//   1. If plan.status === "refused" -> passthrough.
//   2. Empty-plan check -> if plan.ops.length === 0, return
//      refused-whole-plan (EMPTY_PLAN_REASON_CODE). Defense at the
//      engine boundary even though adapters shouldn't emit empty
//      applicable plans -- prevents the every()-returns-true-for-
//      empty-array vacuous truth from collapsing into "noop".
//   3. Plan-level duplicate-path check -> if >1 op share a
//      pathRelative, return refused-whole-plan
//      (DUPLICATE_PLAN_PATH_REASON_CODE).
//   4. Resolve + preflight every target (assertSafeTarget).
//   5. Read integrations record (if any).
//   6. Read each target's current bytes (or null on ENOENT).
//   7. Per-op classification with record-duplicate guard:
//        - matchingRecordOps.length > 1 -> refuseAssessment
//          (DUPLICATE_RECORD_PATH_REASON_CODE)
//        - else classifyOp(op, ctx, recordOp-or-null, currentBytes).
//   8. Aggregate into PreviewOutcome.
//
// (The per-op classification order inside classifyOp lives in
// ./engine-classify.js's top comment.)
//
// === PLAN-LEVEL AGGREGATION ===
//
// (first-match-wins precedence):
//   ANY would-refuse                 -> refused (reasonCode = first
//                                       refusal's, in plan.ops
//                                       order; message lists all
//                                       detail lines)
//   ALL would-noop                   -> noop
//   ONLY would-noop/would-adopt AND  -> applicable + empty diff +
//   AT LEAST ONE would-adopt            adoption summary
//                                       (covers pure-all-adopt as a
//                                       subcase; covers mixed
//                                       noop+adopt -- apply will
//                                       still write the record, so
//                                       this is NOT a noop)
//   else                             -> applicable + per-op diffs
//                                       (in plan.ops order) +
//                                       plan.humanSummary
//
// PreviewDiff.perFile ordering is plan.ops order, NOT path-sorted.
// CLI tools that need a different order can re-sort downstream.
//
// === DEFERRED TO 2H.2 APPLY ===
//
//   - Lock acquisition + concurrent install detection
//   - Pending journal scan + refusal
//   - Backup writes + collision detection
//   - Journal entries
//   - chmod (POSIX) / no-op (Windows)
//   - .gitignore warning emission

import { readFile } from "node:fs/promises";

import type { AdapterContext, AdapterPlan, ApplicablePlan } from "@viberevert/adapters";

import {
  ADOPTION_HUMAN_SUMMARY,
  classifyOp,
  DRIFT_REASON_CODE,
  DUPLICATE_PLAN_PATH_REASON_CODE,
  DUPLICATE_RECORD_PATH_REASON_CODE,
  EMPTY_PLAN_REASON_CODE,
  findDuplicatePlanPaths,
  type PerOpAssessment,
  refuseAssessment,
} from "./engine-classify.js";
import type { PreviewDiff, PreviewOutcome, RecordKey } from "./engine-types.js";
import { readIntegrationsFile } from "./integrations-store.js";
import { resolvePath } from "./path-resolve.js";
import { assertSafeTarget } from "./preflight-target.js";

// ---------------------------------------------------------------------------
// Plan-level aggregation (preview-specific output shape).
// ---------------------------------------------------------------------------

function aggregatePlan(
  plan: ApplicablePlan,
  assessments: ReadonlyArray<PerOpAssessment>,
): PreviewOutcome {
  const refusals = assessments.filter(
    (a): a is Extract<PerOpAssessment, { kind: "would-refuse" }> => a.kind === "would-refuse",
  );
  if (refusals.length > 0) {
    const first = refusals[0];
    if (first === undefined) {
      throw new Error("unreachable: refusals.length > 0 but refusals[0] undefined");
    }
    return {
      status: "refused",
      adapterName: plan.adapterName,
      reasonCode: first.reasonCode,
      message: composeRefusalMessage(plan.recordKey, refusals),
    };
  }

  // ALL would-noop -> noop. Reached only with non-empty assessments
  // (empty plans are refused upstream in preview()), so every()
  // returning true here implies a genuine pure-noop transaction.
  if (assessments.every((a) => a.kind === "would-noop")) {
    return {
      status: "noop",
      recordKey: plan.recordKey,
      adapterName: plan.adapterName,
      reason: "already installed; current state matches recorded SHA",
    };
  }

  // ONLY noop/adopt with AT LEAST ONE adopt -> applicable adoption-
  // style. Subsumes pure-all-adopt as a subcase, and handles mixed
  // noop+adopt correctly (apply will still write the integrations
  // record for the adopted ops, so this is NOT a noop; it's an
  // applied transaction with zero file mutations).
  const onlyNoopOrAdopt = assessments.every(
    (a) => a.kind === "would-noop" || a.kind === "would-adopt",
  );
  const hasAdopt = assessments.some((a) => a.kind === "would-adopt");
  if (onlyNoopOrAdopt && hasAdopt) {
    return {
      status: "applicable",
      recordKey: plan.recordKey,
      adapterName: plan.adapterName,
      diff: { perFile: [] },
      humanSummary: ADOPTION_HUMAN_SUMMARY,
    };
  }

  // Else: applicable with per-op diffs for would-apply +
  // would-safe-update ops. (would-noop / would-adopt ops contribute
  // no diff entry -- they're real file-state matches even within a
  // larger applicable plan.)
  const perFile: Array<PreviewDiff["perFile"][number]> = [];
  for (const a of assessments) {
    if (a.kind === "would-apply" || a.kind === "would-safe-update") {
      perFile.push({
        pathRelative: a.pathRelative,
        opKind: a.opKind,
        unifiedDiff: a.unifiedDiff,
      });
    }
  }

  return {
    status: "applicable",
    recordKey: plan.recordKey,
    adapterName: plan.adapterName,
    diff: { perFile },
    humanSummary: plan.humanSummary,
  };
}

function composeRefusalMessage(
  recordKey: RecordKey,
  refusals: ReadonlyArray<Extract<PerOpAssessment, { kind: "would-refuse" }>>,
): string {
  const lines = refusals.map((r) => `  - [${r.reasonCode}] ${r.detailLine}`).join("\n");
  return (
    `Refusing to apply ${recordKey}: preview detected the following issues:\n${lines}\n` +
    `Only ordinary content-drift refusals ("${DRIFT_REASON_CODE}") are overrideable ` +
    `with --force-reinstall. All other refusals require a manual fix.`
  );
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------

/**
 * Read-only orchestration that models what apply WOULD do. Returns
 * a PreviewOutcome reflecting the per-op classification aggregated
 * via the locked precedence. See top comment for full discipline;
 * see ./engine-classify.js for the per-op classifier discipline.
 *
 * Inputs: an AdapterPlan (either ApplicablePlan or RefusedPlan from
 * an adapter's plan() result) and the AdapterContext used to build
 * it. Refused plans pass through verbatim. Applicable plans are
 * empty-checked, plan-level-deduplicated, preflight-checked,
 * compared against the integrations record + on-disk bytes, and
 * classified.
 *
 * Errors propagate per the top-comment error-propagation policy.
 */
export async function preview(plan: AdapterPlan, ctx: AdapterContext): Promise<PreviewOutcome> {
  if (plan.status === "refused") {
    return {
      status: "refused",
      adapterName: plan.adapterName,
      reasonCode: plan.reasonCode,
      message: plan.message,
      ...(plan.manualSnippet !== undefined ? { manualSnippet: plan.manualSnippet } : {}),
    };
  }

  // Empty-plan defense at the engine boundary. Without this, the
  // aggregator's `assessments.every(...)` branches return true on
  // an empty array (vacuous truth) and would silently classify a
  // zero-op applicable plan as a noop. Adapters shouldn't emit
  // these, but the engine boundary doesn't assume.
  if (plan.ops.length === 0) {
    return {
      status: "refused",
      adapterName: plan.adapterName,
      reasonCode: EMPTY_PLAN_REASON_CODE,
      message:
        `Refusing to apply ${plan.recordKey}: applicable plan contains no file operations. ` +
        `An adapter that has nothing to do should return RefusedPlan or detect{detected: false}, ` +
        `not ApplicablePlan with empty ops.`,
    };
  }

  // Plan-level duplicate-target-path check: refuse the whole plan
  // before any per-op work.
  const duplicatePaths = findDuplicatePlanPaths(plan);
  if (duplicatePaths.length > 0) {
    const lines = duplicatePaths.map((p) => `  - ${p}`).join("\n");
    return {
      status: "refused",
      adapterName: plan.adapterName,
      reasonCode: DUPLICATE_PLAN_PATH_REASON_CODE,
      message:
        `Refusing to apply ${plan.recordKey}: plan has duplicate target paths:\n${lines}\n` +
        `v1 installer supports one managed op per target file per record. ` +
        `Adapter authors should consolidate multiple edits to the same file ` +
        `into a single op (e.g. one json-key-merge with a parent keyPath).`,
    };
  }

  const resolvedTargets = plan.ops.map((op) => ({
    op,
    absolutePath: resolvePath(op.target, { repoRoot: ctx.repoRoot }),
  }));
  for (const { op, absolutePath } of resolvedTargets) {
    const preflightOp: "write" | "merge" =
      op.kind === "write-new" || op.kind === "backup-and-write" ? "write" : "merge";
    await assertSafeTarget({
      repoRoot: ctx.repoRoot,
      targetPath: absolutePath,
      op: preflightOp,
    });
  }

  const integrationsFile = await readIntegrationsFile(ctx.repoRoot);
  const record = integrationsFile?.records[plan.recordKey] ?? null;

  const currentBytesByPath = new Map<string, string | null>();
  for (const { op, absolutePath } of resolvedTargets) {
    try {
      const bytes = await readFile(absolutePath, "utf8");
      currentBytesByPath.set(op.target.pathRelative, bytes);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        currentBytesByPath.set(op.target.pathRelative, null);
      } else {
        throw err;
      }
    }
  }

  const assessments: PerOpAssessment[] = plan.ops.map((op) => {
    const matchingRecordOps =
      record === null
        ? []
        : record.ops.filter((r) => r.target.pathRelative === op.target.pathRelative);
    if (matchingRecordOps.length > 1) {
      return refuseAssessment(
        op.target.pathRelative,
        op.kind,
        DUPLICATE_RECORD_PATH_REASON_CODE,
        `${op.target.pathRelative}: integrations record has ${matchingRecordOps.length} entries for this path; expected at most 1 (durable-schema invariant for v1)`,
      );
    }
    const recordOp = matchingRecordOps[0] ?? null;
    const currentBytes = currentBytesByPath.get(op.target.pathRelative) ?? null;
    return classifyOp({ op, ctx, recordOp, currentBytes });
  });

  return aggregatePlan(plan, assessments);
}
