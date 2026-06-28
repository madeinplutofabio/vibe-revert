// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Shared classifier core for @viberevert/installers.
//
// === PURPOSE ===
//
// This module is the SINGLE SOURCE OF TRUTH for D101.B's per-op
// classification logic, reason-code taxonomy, force-reinstall
// scope, per-kind managed-region SHA discipline, and plan-level
// uniqueness rules. Two consumers:
//
//   - engine-preview.ts (read-only orchestration): aggregates
//     PerOpAssessment[] into PreviewOutcome for dry-run display.
//   - engine-apply.ts (mutating orchestration; 2H.2b): aggregates
//     PerOpAssessment[] into InstallOutcome and dispatches lock /
//     journal / backup / mutate / store-write per the assessments.
//
// Both consumers MUST share classifyOp + its helpers so preview
// and apply agree byte-for-byte on:
//   - which op counts as adoption vs apply vs refuse
//   - which managed-region SHA to compute per op kind
//   - which reason code each refusal carries
//   - line-ending fidelity for full-file SHAs
//   - what counts as a duplicate-path or cross-kind violation
//
// Why a separate module instead of inline duplication: classifyOp
// + helpers = ~350 lines of pure logic. Duplicating across preview
// and apply would invite silent drift; the integrations-record
// drift table is the most security-critical part of the engine and
// parity must be enforced by the type system, not by tests.
//
// === PURITY CONTRACT ===
//
// PURE: NO file I/O (no node:fs of any kind), NO process state, NO
// clocks. The caller (preview or apply) reads the filesystem and
// the integrations record, then feeds the results into classifyOp.
//
// The `diff` package dependency lives here because classifyOp
// pre-renders the unified-diff string on would-apply /
// would-safe-update assessments. Apply consumers receive these
// strings even though apply does not display diffs; the cost is
// one createPatch call per applicable op (microseconds) and the
// benefit is that both preview and apply use the byte-identical
// classifier without an injected renderer.
//
// === REFUSAL TAXONOMY ===
//
// Reason codes (distinct semantics; CLI maps to user messages
// without parsing text):
//
//   integrations-content-drift            - ordinary SHA-mismatch
//                                           drift between current
//                                           bytes and recorded
//                                           managed-region SHA.
//                                           OVERRIDEABLE with
//                                           --force-reinstall.
//   integrations-record-kind-mismatch     - recordOp exists for the
//                                           path but recordOp.kind !==
//                                           op.kind. Structural
//                                           model mismatch; NOT
//                                           overrideable.
//   empty-applicable-plan                 - applicable plan with
//                                           zero ops. Orchestrator
//                                           emits this before
//                                           consulting the
//                                           classifier; classifier
//                                           assumes non-empty
//                                           plans.
//   duplicate-target-path-in-plan         - same pathRelative
//                                           appears in >1 plan op.
//                                           Detected via
//                                           findDuplicatePlanPaths;
//                                           orchestrator emits at
//                                           plan level before
//                                           per-op classification.
//   integrations-record-duplicate-target  - >1 record op for the
//                                           same pathRelative.
//                                           Orchestrator detects
//                                           this and emits a per-op
//                                           refuseAssessment with
//                                           this reasonCode; the
//                                           classifier itself
//                                           assumes one record op
//                                           per path.
//   target-exists-not-managed             - write-new + no record +
//                                           target file present
//                                           with content that
//                                           differs from adapter's
//                                           desired bytes. Emitted
//                                           by classifyOp.
//   target-missing-for-backup-and-write   - backup-and-write + no
//                                           record + current target
//                                           absent. Emitted by
//                                           classifyOp.
//   sentinel-block-missing-for-replace    - sentinel-block-replace +
//                                           no record + sentinel
//                                           block absent in current
//                                           bytes. Emitted by
//                                           classifyOp.
//
// === FORCE-REINSTALL SCOPE ===
//
// ctx.options.forceReinstall ONLY overrides ordinary content drift
// (reasonCode === DRIFT_REASON_CODE). It does NOT override:
//   - empty-applicable-plan
//   - cross-kind record-vs-plan mismatch
//   - duplicate target paths (plan or record)
//   - target-exists-not-managed (write-new)
//   - target-missing-for-backup-and-write
//   - sentinel-block-missing-for-replace
//
// Enforcement: force is checked exactly once in classifyOp, in the
// "current differs from recorded" branch that emits
// DRIFT_REASON_CODE. All other refusals are returned without
// consulting force; the scope is enforced by code path, not by a
// string check.
//
// === PER-OP CLASSIFICATION ORDER ===
//
// classifyOp(per op), in order:
//
//   Step 1: extract currentManagedSha (cheap; only needs
//           currentBytes).
//   Step 2: cross-kind refusal (recordOp exists, kind mismatch).
//   Step 3: structural refusals that don't need desired bytes:
//             backup-and-write + currentBytes === null
//             sentinel-block-replace + currentManagedSha === null
//           Both only when recordOp === null.
//   Step 4: compute desired full-file bytes + desired managed SHA.
//   Step 5: structural refusal that needs desired SHA:
//             write-new + currentBytes !== null
//                       + currentManagedSha !== desiredManagedSha
//           Only when recordOp === null.
//   Step 6: record-aware classification:
//             no record op + current matches desired   -> would-adopt
//             no record op + current differs           -> would-apply
//             record op exists (same kind):
//               current matches recorded:
//                 desired matches recorded             -> would-noop
//                 desired differs from recorded        -> would-safe-update
//               current differs from recorded:
//                 ctx.options.forceReinstall === true  -> would-apply
//                 else                                 -> would-refuse (drift)
//
// Reordering rationale: Steps 2 and 3 must NOT trigger desired-
// bytes computation, because for sentinel-block-replace the
// replaceOrAppendSentinelBlock helper would silently append (the
// block is missing). The guarantee "missing managed block under
// sentinel-block-replace never becomes a silent append" is
// preserved by code path: append-fallback is computed only AFTER
// the structural refusal would have already returned.
//
// === PER-KIND MANAGED-REGION SHA DISCIPLINE (D101.C) ===
//
//   write-new / backup-and-write -> SHA of full would-be file
//     bytes AFTER line-ending normalization (matches what apply
//     writes; matches recorded fullFileSha256AfterWrite).
//   sentinel-block-insert / sentinel-block-replace -> SHA of
//     op.content (block-content is portable; NOT line-ending-
//     normalized; matches recorded managedBlockSha256).
//   json-key-merge -> sha256OfCanonical(op.value) (matches
//     recorded managedValueSha256).
//
// === ORCHESTRATOR EXPECTATIONS ===
//
// classifyOp assumes:
//   - plan.ops is non-empty (orchestrator emits empty-applicable-
//     plan refusal before calling classifyOp)
//   - plan.ops has no duplicate pathRelative values (orchestrator
//     uses findDuplicatePlanPaths to detect; emits
//     duplicate-target-path-in-plan refusal before calling
//     classifyOp)
//   - recordOp (when non-null) is the SINGLE matching record op for
//     the path (orchestrator filters by pathRelative; if it finds
//     >1 matches, the orchestrator emits a per-op refuseAssessment
//     with integrations-record-duplicate-target before calling
//     classifyOp)
//
// === DOCUMENTED CORRECT-BUT-UNUSUAL BEHAVIORS ===
//
//   - sentinel-block-replace with no record + block present + content
//     differs from desired -> would-apply (NOT would-adopt).
//     Adapter intentionally takes over an unmanaged block with the
//     same blockId. Apply records this as applied with an op
//     record (NOT adoption with opsApplied: 0).
//
//   - json-key-merge with no record + keyPath value differs from
//     desired -> would-apply. The keyPath is namespaced (e.g.
//     mcpServers.viberevert); overwrite is the locked semantic.
//
//   - sentinel-block-replace with record exists + block missing ->
//     would-refuse via drift (currentManagedSha is null, recordedSha
//     is non-null; SHA mismatch in Step 6). The helper's append-
//     fallback never appears in this path -- the drift refusal
//     fires first.
//
//   - Mixed noop + adopt across ops in a single plan -- aggregation
//     concern, handled by the orchestrator (preview's aggregator
//     returns applicable+empty-diff+adoption-summary; apply's
//     aggregator returns applied+opsApplied:0+adoption-summary).
//     classifyOp returns the per-op assessment honestly; aggregator
//     reconciles.
//
// === ERROR PROPAGATION ===
//
// Pure helpers throw on input violations that should never occur in
// practice (root-replacement with non-object value in setAtKeyPath;
// invalid JSON in parseJsonObjectOrEmpty). Orchestrators propagate
// these as SyntaxError or generic Error -- no engine-classify-level
// wrapping. See engine-preview.ts top comment for the full
// orchestrator-side propagation policy.

import { createHash } from "node:crypto";

import {
  type AdapterContext,
  type ApplicablePlan,
  type FileEditOp,
  findSentinelBlock,
  type JsonObject,
  type JsonValue,
  replaceOrAppendSentinelBlock,
} from "@viberevert/adapters";
import { createPatch } from "diff";

import { prettyJson, sha256OfCanonical } from "./canonical-json.js";
import type { IntegrationFileEditRecord } from "./integrations-schema.js";
import { detectLineEnding, normalizeToWriteFormat } from "./line-endings.js";

// ---------------------------------------------------------------------------
// Reason codes (exported; the CLI maps these to user messages).
// ---------------------------------------------------------------------------

export const DRIFT_REASON_CODE = "integrations-content-drift";
export const KIND_MISMATCH_REASON_CODE = "integrations-record-kind-mismatch";
export const EMPTY_PLAN_REASON_CODE = "empty-applicable-plan";
export const DUPLICATE_PLAN_PATH_REASON_CODE = "duplicate-target-path-in-plan";
export const DUPLICATE_RECORD_PATH_REASON_CODE = "integrations-record-duplicate-target";
export const TARGET_EXISTS_REASON_CODE = "target-exists-not-managed";
export const TARGET_MISSING_REASON_CODE = "target-missing-for-backup-and-write";
export const SENTINEL_BLOCK_MISSING_REASON_CODE = "sentinel-block-missing-for-replace";

export const ADOPTION_HUMAN_SUMMARY = "would adopt existing managed state without file changes";

// ---------------------------------------------------------------------------
// Tiny helpers.
// ---------------------------------------------------------------------------

export function sha256OfUtf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function chooseTargetLineEnding(currentBytes: string | null): "LF" | "CRLF" {
  if (currentBytes === null) return "LF";
  return detectLineEnding(currentBytes) === "CRLF" ? "CRLF" : "LF";
}

export function renderUnifiedDiff(args: {
  pathRelative: string;
  currentBytes: string;
  desiredBytes: string;
}): string {
  return createPatch(args.pathRelative, args.currentBytes, args.desiredBytes, "current", "desired");
}

// ---------------------------------------------------------------------------
// JSON keyPath helpers (private; pure; never mutate inputs).
// ---------------------------------------------------------------------------

function jsonValueAtKeyPath(
  root: JsonValue,
  keyPath: ReadonlyArray<string>,
): JsonValue | undefined {
  let cur: JsonValue = root;
  for (const segment of keyPath) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    const obj = cur as JsonObject;
    if (!(segment in obj)) return undefined;
    cur = obj[segment] as JsonValue;
  }
  return cur;
}

function setAtKeyPath(
  root: JsonObject,
  keyPath: ReadonlyArray<string>,
  value: JsonValue,
): JsonObject {
  if (keyPath.length === 0) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("setAtKeyPath: cannot replace root with non-object value");
    }
    return value as JsonObject;
  }
  const head = keyPath[0];
  if (head === undefined) {
    throw new Error("setAtKeyPath: empty key segment");
  }
  const tail = keyPath.slice(1);
  const existing = root[head];
  let nextChild: JsonValue;
  if (tail.length === 0) {
    nextChild = value;
  } else {
    const childAsObject =
      existing !== undefined &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
        ? (existing as JsonObject)
        : ({} as JsonObject);
    nextChild = setAtKeyPath(childAsObject, tail, value);
  }
  return { ...root, [head]: nextChild };
}

/**
 * Parse currentBytes as a JSON OBJECT, returning {} if absent.
 * Throws SyntaxError on invalid JSON OR non-object root.
 */
function parseJsonObjectOrEmpty(currentBytes: string | null): JsonObject {
  if (currentBytes === null) return {};
  const parsed: unknown = JSON.parse(currentBytes);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError(
      "json-key-merge target's existing content is valid JSON but its root is not an object",
    );
  }
  return parsed as JsonObject;
}

// ---------------------------------------------------------------------------
// Per-op desired bytes / managed-region SHA computation.
// ---------------------------------------------------------------------------

export function computeDesiredFullFileBytes(args: {
  op: FileEditOp;
  currentBytes: string | null;
  targetLineEnding: "LF" | "CRLF";
}): string {
  const { op, currentBytes, targetLineEnding } = args;
  let raw: string;
  switch (op.kind) {
    case "write-new":
    case "backup-and-write":
      raw = op.content;
      break;
    case "sentinel-block-insert":
    case "sentinel-block-replace": {
      const base = currentBytes ?? "";
      const anchor = op.kind === "sentinel-block-insert" ? op.anchor : { mode: "append" as const };
      raw = replaceOrAppendSentinelBlock(base, op.blockId, op.content, anchor);
      break;
    }
    case "json-key-merge": {
      const baseObject = parseJsonObjectOrEmpty(currentBytes);
      const merged = setAtKeyPath(baseObject, op.keyPath, op.value);
      // Outer file rendered with prettyJson per D101.N + trailing
      // newline (same convention writeIntegrationsFile uses for
      // integrations.json; minimises re-render diff noise).
      raw = `${prettyJson(merged)}\n`;
      break;
    }
  }
  return normalizeToWriteFormat(raw, targetLineEnding);
}

export function computeDesiredManagedRegionSha(args: {
  op: FileEditOp;
  desiredFullFileBytes: string;
}): string {
  const { op, desiredFullFileBytes } = args;
  switch (op.kind) {
    case "write-new":
    case "backup-and-write":
      return sha256OfUtf8(desiredFullFileBytes);
    case "sentinel-block-insert":
    case "sentinel-block-replace":
      return sha256OfUtf8(op.content);
    case "json-key-merge":
      return sha256OfCanonical(op.value);
  }
}

export function extractCurrentManagedRegionSha(
  op: FileEditOp,
  currentBytes: string | null,
): string | null {
  switch (op.kind) {
    case "write-new":
    case "backup-and-write":
      return currentBytes === null ? null : sha256OfUtf8(currentBytes);
    case "sentinel-block-insert":
    case "sentinel-block-replace": {
      if (currentBytes === null) return null;
      const found = findSentinelBlock(currentBytes, op.blockId);
      return found === null ? null : sha256OfUtf8(found.content);
    }
    case "json-key-merge": {
      if (currentBytes === null) return null;
      const parsed = JSON.parse(currentBytes) as JsonValue;
      const v = jsonValueAtKeyPath(parsed, op.keyPath);
      return v === undefined ? null : sha256OfCanonical(v);
    }
  }
}

export function extractRecordedSha(
  op: FileEditOp,
  recordOp: IntegrationFileEditRecord,
): string | null {
  switch (op.kind) {
    case "write-new":
    case "backup-and-write":
      return recordOp.fullFileSha256AfterWrite;
    case "sentinel-block-insert":
    case "sentinel-block-replace":
      return recordOp.managedBlockSha256;
    case "json-key-merge":
      return recordOp.managedValueSha256;
  }
}

// ---------------------------------------------------------------------------
// Plan-level helpers.
// ---------------------------------------------------------------------------

/**
 * Return the list of pathRelative values that appear more than once
 * in the plan's ops. The orchestrator uses this to refuse the whole
 * plan at its top level before any per-op processing -- v1 supports
 * one managed op per target file per record.
 */
export function findDuplicatePlanPaths(plan: ApplicablePlan): string[] {
  const counts = new Map<string, number>();
  for (const op of plan.ops) {
    counts.set(op.target.pathRelative, (counts.get(op.target.pathRelative) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c > 1)
    .map(([p]) => p);
}

// ---------------------------------------------------------------------------
// Per-op classification.
// ---------------------------------------------------------------------------

export type PerOpAssessment =
  | {
      readonly kind: "would-noop";
      readonly pathRelative: string;
      readonly opKind: FileEditOp["kind"];
    }
  | {
      readonly kind: "would-adopt";
      readonly pathRelative: string;
      readonly opKind: FileEditOp["kind"];
    }
  | {
      readonly kind: "would-apply";
      readonly pathRelative: string;
      readonly opKind: FileEditOp["kind"];
      readonly unifiedDiff: string;
    }
  | {
      readonly kind: "would-safe-update";
      readonly pathRelative: string;
      readonly opKind: FileEditOp["kind"];
      readonly unifiedDiff: string;
    }
  | {
      readonly kind: "would-refuse";
      readonly pathRelative: string;
      readonly opKind: FileEditOp["kind"];
      readonly reasonCode: string;
      readonly detailLine: string;
    };

export function refuseAssessment(
  pathRelative: string,
  opKind: FileEditOp["kind"],
  reasonCode: string,
  detailLine: string,
): PerOpAssessment {
  return { kind: "would-refuse", pathRelative, opKind, reasonCode, detailLine };
}

export function classifyOp(args: {
  op: FileEditOp;
  ctx: AdapterContext;
  recordOp: IntegrationFileEditRecord | null;
  currentBytes: string | null;
}): PerOpAssessment {
  const { op, ctx, recordOp, currentBytes } = args;
  const pathRelative = op.target.pathRelative;

  // Step 1: extract currentManagedSha (cheap; only needs currentBytes).
  const currentManagedSha = extractCurrentManagedRegionSha(op, currentBytes);

  // Step 2: cross-kind refusal (recordOp exists, kind mismatch).
  if (recordOp !== null && recordOp.kind !== op.kind) {
    return refuseAssessment(
      pathRelative,
      op.kind,
      KIND_MISMATCH_REASON_CODE,
      `${pathRelative}: recorded as ${recordOp.kind}, plan wants ${op.kind} (cross-kind record-vs-plan mismatch)`,
    );
  }

  // Step 3: structural refusals that don't need desired bytes
  // (only when no record op; record-aware path's drift refusal in
  // Step 6 covers the same cases via SHA mismatch).
  if (recordOp === null) {
    if (op.kind === "backup-and-write" && currentBytes === null) {
      return refuseAssessment(
        pathRelative,
        op.kind,
        TARGET_MISSING_REASON_CODE,
        `${pathRelative}: backup-and-write requires an existing target file (none present)`,
      );
    }
    if (op.kind === "sentinel-block-replace" && currentManagedSha === null) {
      return refuseAssessment(
        pathRelative,
        op.kind,
        SENTINEL_BLOCK_MISSING_REASON_CODE,
        `${pathRelative}: sentinel-block-replace requires an existing block with id ${op.blockId} (none present)`,
      );
    }
  }

  // Step 4: compute desired full-file bytes + desired managed SHA.
  // Reached only after structural refusals would have already
  // returned; for sentinel-block-replace this guarantees the
  // helper's append-fallback is never computed when the block is
  // missing.
  const targetLineEnding = chooseTargetLineEnding(currentBytes);
  const desiredFullFileBytes = computeDesiredFullFileBytes({
    op,
    currentBytes,
    targetLineEnding,
  });
  const desiredManagedSha = computeDesiredManagedRegionSha({ op, desiredFullFileBytes });

  // Step 5: structural refusal that needs desired SHA
  // (only when no record op).
  if (
    recordOp === null &&
    op.kind === "write-new" &&
    currentBytes !== null &&
    currentManagedSha !== desiredManagedSha
  ) {
    return refuseAssessment(
      pathRelative,
      op.kind,
      TARGET_EXISTS_REASON_CODE,
      `${pathRelative}: write-new target already exists and content does not match the adapter's desired bytes`,
    );
  }

  // Step 6: record-aware classification.
  if (recordOp === null) {
    if (currentManagedSha !== null && currentManagedSha === desiredManagedSha) {
      return { kind: "would-adopt", pathRelative, opKind: op.kind };
    }
    return {
      kind: "would-apply",
      pathRelative,
      opKind: op.kind,
      unifiedDiff: renderUnifiedDiff({
        pathRelative,
        currentBytes: currentBytes ?? "",
        desiredBytes: desiredFullFileBytes,
      }),
    };
  }

  // recordOp !== null AND recordOp.kind === op.kind.
  const recordedSha = extractRecordedSha(op, recordOp);

  if (currentManagedSha !== null && currentManagedSha === recordedSha) {
    if (desiredManagedSha === recordedSha) {
      return { kind: "would-noop", pathRelative, opKind: op.kind };
    }
    return {
      kind: "would-safe-update",
      pathRelative,
      opKind: op.kind,
      unifiedDiff: renderUnifiedDiff({
        pathRelative,
        currentBytes: currentBytes ?? "",
        desiredBytes: desiredFullFileBytes,
      }),
    };
  }

  // current differs from recorded -> user drift. ONLY overrideable
  // refusal: ctx.options.forceReinstall === true. Force is checked
  // exactly here; structural and cross-kind refusals above this
  // point never see it.
  if (ctx.options.forceReinstall) {
    return {
      kind: "would-apply",
      pathRelative,
      opKind: op.kind,
      unifiedDiff: renderUnifiedDiff({
        pathRelative,
        currentBytes: currentBytes ?? "",
        desiredBytes: desiredFullFileBytes,
      }),
    };
  }
  return refuseAssessment(
    pathRelative,
    op.kind,
    DRIFT_REASON_CODE,
    `${pathRelative}: current bytes drift from recorded managed-region SHA`,
  );
}
