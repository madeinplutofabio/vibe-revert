// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Finding identity: the shape validator and the normative derivation.
//
// M 0.8.0 step 0. A finding's rule id (`CheckResult.id`, e.g.
// `dependencies.install-script`) names a RULE, not an occurrence: one detector
// can emit the same rule against several different path sets. That is why
// `--finding` cannot select on the rule id alone, and why findings need an
// identity of their own.
//
// Kept in its own leaf module so both `CheckResult.finding_id` and the rollback
// selector set can validate the same shape without either importing the other.
// Depends on ./atoms.js only.
//
// =============================================================================
// What identity means here
// =============================================================================
//
// A finding is "this rule, about these paths". Three attributes are DELIBERATELY
// excluded from the payload:
//
//   message   presentation. Contains counts and wording; the path set already
//             carries that information, and hashing prose would churn ids on a
//             copy edit.
//   level     classification. A severity retune would silently invalidate every
//             saved id, yet it is the same finding.
//   category  redundant, because rule ids are namespaced and two rules in
//             different categories cannot share one. This relies on
//             `CheckResult.id` remaining the globally meaningful rule
//             identifier, which is an invariant worth stating rather than
//             leaving implicit in a parameter name.
//
// =============================================================================
// When the id is assigned
// =============================================================================
//
// AFTER clustering, on the final persisted finding, once its complete
// `affected_paths` set exists. Never derived from detector evidence and carried
// through clustering: clustering unions member paths, so an id minted earlier
// would survive a change to the very thing it identifies.
//
// Detectors therefore never see report identity. Assignment belongs to the
// post-processing layer that already owns clustering.
//
// =============================================================================
// Uniqueness
// =============================================================================
//
// `--finding` is ambiguous if two findings in one report share an id, so the
// report schema enforces uniqueness among findings that carry one. A derivation
// collision then fails validation loudly instead of silently making a selector
// ambiguous. Two advisory findings sharing a rule id and both having empty
// `affected_paths` are the residual case, and post-clustering they should have
// been merged: a collision means an engine bug, which is exactly how this
// package already treats an exceeded noise-budget cap.

import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizePathArray } from "./atoms.js";

/**
 * The single NUL separator byte used for domain/field separation in the finding
 * payload. Built programmatically so no literal U+0000 appears in this source
 * file -- a raw 0x00 byte would make git treat the file as binary.
 */
const NUL_SEPARATOR = new Uint8Array([0]);

/**
 * Shape of a `finding_id`. The VALUE is produced exclusively by
 * `deriveFindingId`; this validator pins only the format.
 *
 * Exported so `CheckResult.finding_id` and the rollback `--finding` selector
 * set validate against one definition rather than two copies of the regex.
 */
export const FindingIdSchema = z.string().regex(/^fnd_[0-9a-f]{64}$/, {
  message: "must be fnd_<64 lowercase hex SHA-256>",
});

/**
 * Derive a `finding_id` (v1). THIS FUNCTION IS THE CONTRACT, implemented once
 * here in the package `@viberevert/checks` already depends on.
 *
 * ```text
 * paths   = sorted, unique, canonical affected_paths
 * payload = UTF-8( "viberevert-finding-v1"
 *                  + \0 + report_id
 *                  + \0 + rule_id
 *                  + \0 + JSON.stringify(paths) )
 * id      = "fnd_" + lowercase_hex( SHA-256(payload) )
 * ```
 *
 * where `\0` denotes a single U+0000 byte.
 *
 * **Scoped by `report_id`.** For a session-bound report that is the session id,
 * so ids are stable across re-runs of the same session, which is what
 * `--finding` needs. Ad-hoc reports get a fresh `rpt_<ULID>` per run and their
 * ids therefore churn; harmless, because `--finding` is authoritative only
 * against a contribution-bound session report, and the fixture harness pins the
 * ULID seed so goldens stay stable.
 *
 * **Domain-separated** by the `viberevert-finding-v1` prefix, so this digest can
 * never be confused with a change-group id or an object-store content digest,
 * both of which are also bare SHA-256 values. The `v1` is what a future
 * derivation change increments.
 *
 * @param reportId The owning report's id: `sess_<ULID>` for a session-bound
 *   report, `rpt_<ULID>` for an ad-hoc one. The prefix and coupling rules are
 *   owned by the report schema; this helper assumes an already-validated
 *   identity and guards only against nonsensical raw input.
 * @param ruleId The finding's existing `CheckResult.id`. This is the RULE
 *   identifier, not a new persisted field.
 * @param affectedPaths The finding's complete machine path set, expressed as
 *   changed-file identities. Canonicalized, deduped, and sorted internally.
 *   MAY be empty: an advisory finding has an identity but is non-selectable.
 * @throws If `reportId` or `ruleId` is blank. Either is a producer bug, and a
 *   blank input would otherwise mint a plausible-looking id from nothing.
 */
export function deriveFindingId(
  reportId: string,
  ruleId: string,
  affectedPaths: readonly string[],
): string {
  if (reportId.trim().length === 0) {
    throw new Error("deriveFindingId: reportId must not be blank");
  }
  if (ruleId.trim().length === 0) {
    throw new Error("deriveFindingId: ruleId must not be blank");
  }
  const paths = normalizePathArray(affectedPaths);
  const hash = createHash("sha256");
  hash.update("viberevert-finding-v1", "utf8");
  hash.update(NUL_SEPARATOR);
  hash.update(reportId, "utf8");
  hash.update(NUL_SEPARATOR);
  hash.update(ruleId, "utf8");
  hash.update(NUL_SEPARATOR);
  hash.update(JSON.stringify(paths), "utf8");
  return `fnd_${hash.digest("hex")}`;
}
