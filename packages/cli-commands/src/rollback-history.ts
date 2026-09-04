// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The selective rollback history scan.
//
// Reads every invocation directory under a session's `rollbacks/` and says what
// each one proves. The question it answers is narrow and load-bearing: may
// another apply begin, and if not, which emergency checkpoint does the user
// recover from?
//
// FAIL CLOSED. A malformed, unreadable, or self-contradictory artifact is never
// reported as absent. "I could not read the history" and "there is no history"
// lead to opposite decisions, and only one of them is safe to guess.
//
// FINALIZATION IS A BINDING, NOT A FILE COUNT. `rollback-attempt.ts` defines a
// marker with a sibling receipt as finalized, but presence alone is forgeable:
// a receipt copied from another invocation would launder an unfinalized attempt
// into a finalized one and silently unblock an apply over a partly mutated
// tree. So the two artifacts must agree on every field they share, and both
// must agree with the directory they live in and the session being scanned.
// The receipt's own schema docblock names this correspondence and states
// plainly that it is not schema-enforceable across files. This is where it is
// enforced.
//
// The LEGACY full-rollback receipt is deliberately NOT read here.
// `rollback-orchestration.ts` already owns that reader and produces the
// `already_applied` refusal from it; a second reader would reconstruct a path
// convention and could drift from the first.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  rollbackInvocationDir,
  rollbackInvocationPaths,
  sessionRollbacksDir,
} from "@viberevert/core";
import {
  type RollbackAttempt,
  RollbackAttemptSchema,
  type RollbackSelection,
  type SelectiveRollbackReceipt,
  SelectiveRollbackReceiptSchema,
} from "@viberevert/session-format";

/** `rb_` followed by a 26-character Crockford ULID. */
const ROLLBACK_DIR_NAME_RE = /^rb_[0-9A-HJKMNP-TV-Z]{26}$/;

export type ScannedInvocation =
  | {
      /**
       * A directory with no valid marker. NOT a blocker, and that follows from
       * the marker rule rather than from leniency: the marker is published
       * before the first mutation, so its absence means nothing was ever
       * authorized to mutate. Publication debris lands here too.
       */
      readonly kind: "never_authorized";
      readonly rollbackId: string;
      readonly rollbackDir: string;
    }
  | {
      /** A marker with no sibling receipt: mutation MAY have started. */
      readonly kind: "unfinalized";
      readonly rollbackId: string;
      readonly rollbackDir: string;
      readonly writtenAt: string;
      readonly preRollbackCheckpointId: string;
    }
  | {
      readonly kind: "finalized";
      readonly rollbackId: string;
      readonly rollbackDir: string;
      readonly writtenAt: string;
      readonly preRollbackCheckpointId: string;
      readonly outcome: "succeeded" | "failed";
    };

/** An invocation that forbids another apply until the user recovers. */
export interface BlockingInvocation {
  readonly rollbackId: string;
  readonly rollbackDir: string;
  readonly writtenAt: string;
  readonly preRollbackCheckpointId: string;
  readonly reason: "unfinalized" | "apply_failed";
}

export interface RollbackHistoryReport {
  /** Every invocation directory, sorted by rollback id. */
  readonly invocations: readonly ScannedInvocation[];
  /**
   * Every blocker, sorted by the marker's persisted timestamp and then by
   * rollback id.
   *
   * ALL of them are carried, not just the first found: filesystem traversal
   * order must never decide which recovery handle a user is told about.
   */
  readonly blocking: readonly BlockingInvocation[];
}

export type RollbackHistoryScan =
  | { readonly outcome: "readable"; readonly report: RollbackHistoryReport }
  /** An artifact could not be read or parsed. */
  | { readonly outcome: "unreadable"; readonly path: string; readonly detail: string }
  /** Artifacts were read but contradict each other or their location. */
  | { readonly outcome: "inconsistent"; readonly path: string; readonly detail: string };

/**
 * The blocker whose emergency checkpoint the user should recover from.
 *
 * The EARLIEST, not the most recent, and the difference matters. The earliest
 * blocker's checkpoint is the last state before any damage; a later one only
 * restores to a state an earlier failure may already have corrupted.
 */
export function primaryBlocker(report: RollbackHistoryReport): BlockingInvocation | null {
  return report.blocking[0] ?? null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `null` when absent; throws the original error for anything but ENOENT. */
async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function selectionsEqual(a: RollbackSelection, b: RollbackSelection): boolean {
  const left = a.resolved_change_group_ids;
  const right = b.resolved_change_group_ids;
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return JSON.stringify(a.selectors) === JSON.stringify(b.selectors);
}

function selectionMatches(attempt: RollbackAttempt, receipt: SelectiveRollbackReceipt): boolean {
  if (receipt.mode !== "apply") {
    return false;
  }
  return selectionsEqual(attempt.selection, {
    selectors: receipt.selectors,
    resolved_change_group_ids: receipt.resolved_change_group_ids,
  });
}

/**
 * Every field the marker and the receipt share, plus their agreement with the
 * directory and the session being scanned. Returns a human detail on the FIRST
 * disagreement, or `null` when they bind.
 */
function bindingFault(
  attempt: RollbackAttempt,
  receipt: SelectiveRollbackReceipt,
  rollbackId: string,
  sessionId: string,
): string | null {
  if (receipt.mode !== "apply") {
    return `receipt mode is ${JSON.stringify(receipt.mode)}, expected "apply"`;
  }
  if (attempt.rollback_id !== rollbackId || receipt.rollback_id !== rollbackId) {
    return `rollback_id disagrees with the directory name ${JSON.stringify(rollbackId)}`;
  }
  if (attempt.session_id !== sessionId || receipt.session_id !== sessionId) {
    return `session_id disagrees with the scanned session ${JSON.stringify(sessionId)}`;
  }
  if (attempt.contribution_sha256 !== receipt.contribution_sha256) {
    return "contribution_sha256 disagrees between the marker and the receipt";
  }
  if (attempt.pre_rollback_checkpoint_id !== receipt.pre_rollback_checkpoint_id) {
    return "pre_rollback_checkpoint_id disagrees between the marker and the receipt";
  }
  if (!selectionMatches(attempt, receipt)) {
    return "the resolved selection disagrees between the marker and the receipt";
  }
  return null;
}

async function scanOne(
  rollbackDir: string,
  rollbackId: string,
  sessionId: string,
): Promise<
  ScannedInvocation | Extract<RollbackHistoryScan, { outcome: "unreadable" | "inconsistent" }>
> {
  const { attemptPath, receiptPath } = rollbackInvocationPaths(rollbackDir);

  let attemptRaw: string | null;
  let receiptRaw: string | null;
  try {
    attemptRaw = await readOptional(attemptPath);
    receiptRaw = await readOptional(receiptPath);
  } catch (err) {
    return { outcome: "unreadable", path: rollbackDir, detail: messageOf(err) };
  }

  if (attemptRaw === null) {
    if (receiptRaw !== null) {
      // A receipt with no authorizing marker. The marker is written first and
      // is never removed, so this cannot have been produced by a normal run.
      return {
        outcome: "inconsistent",
        path: receiptPath,
        detail: "a receipt exists with no authorizing attempt marker",
      };
    }
    return { kind: "never_authorized", rollbackId, rollbackDir };
  }

  let attempt: RollbackAttempt;
  try {
    attempt = RollbackAttemptSchema.parse(JSON.parse(attemptRaw));
  } catch (err) {
    return { outcome: "unreadable", path: attemptPath, detail: messageOf(err) };
  }
  if (attempt.rollback_id !== rollbackId) {
    return {
      outcome: "inconsistent",
      path: attemptPath,
      detail: `marker rollback_id disagrees with the directory name ${JSON.stringify(rollbackId)}`,
    };
  }
  if (attempt.session_id !== sessionId) {
    return {
      outcome: "inconsistent",
      path: attemptPath,
      detail: `marker session_id disagrees with the scanned session ${JSON.stringify(sessionId)}`,
    };
  }

  if (receiptRaw === null) {
    return {
      kind: "unfinalized",
      rollbackId,
      rollbackDir,
      writtenAt: attempt.written_at,
      preRollbackCheckpointId: attempt.pre_rollback_checkpoint_id,
    };
  }

  let receipt: SelectiveRollbackReceipt;
  try {
    receipt = SelectiveRollbackReceiptSchema.parse(JSON.parse(receiptRaw));
  } catch (err) {
    return { outcome: "unreadable", path: receiptPath, detail: messageOf(err) };
  }

  const fault = bindingFault(attempt, receipt, rollbackId, sessionId);
  if (fault !== null) {
    return { outcome: "inconsistent", path: receiptPath, detail: fault };
  }
  if (receipt.mode !== "apply") {
    // Unreachable: `bindingFault` rejects a non-apply receipt first. Narrowing
    // for the compiler rather than a second check.
    return { outcome: "inconsistent", path: receiptPath, detail: "receipt is not an apply" };
  }

  return {
    kind: "finalized",
    rollbackId,
    rollbackDir,
    writtenAt: attempt.written_at,
    preRollbackCheckpointId: attempt.pre_rollback_checkpoint_id,
    outcome: receipt.outcome,
  };
}

/**
 * Scan one session's selective rollback history.
 *
 * Runs UNDER the rollback lock, so its verdict cannot go stale between reading
 * and mutating.
 */
export async function scanSelectiveRollbackHistory(
  repoRoot: string,
  sessionId: string,
): Promise<RollbackHistoryScan> {
  const rollbacksDir = sessionRollbacksDir(repoRoot, sessionId);

  let entries: string[];
  try {
    entries = (await readdir(rollbacksDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No rollbacks directory means no selective apply has ever been
      // authorized for this session. That is genuine absence, not a read
      // failure, and it is the only absence this scan accepts.
      return { outcome: "readable", report: { invocations: [], blocking: [] } };
    }
    return { outcome: "unreadable", path: rollbacksDir, detail: messageOf(err) };
  }

  const invocations: ScannedInvocation[] = [];
  for (const name of [...entries].sort()) {
    if (!ROLLBACK_DIR_NAME_RE.test(name)) {
      return {
        outcome: "inconsistent",
        path: join(rollbacksDir, name),
        detail: "a directory under rollbacks/ is not a valid rb_<ULID> name",
      };
    }
    const scanned = await scanOne(join(rollbacksDir, name), name, sessionId);
    // Discriminated on `kind`, NOT on `outcome`: the finalized arm carries its
    // own `outcome` ("succeeded" | "failed"), so an `"outcome" in scanned`
    // check would classify a finalized invocation as a scan fault.
    if (!("kind" in scanned)) {
      return scanned;
    }
    invocations.push(scanned);
  }

  const blocking: BlockingInvocation[] = [];
  for (const invocation of invocations) {
    if (invocation.kind === "unfinalized") {
      blocking.push({ ...invocation, reason: "unfinalized" });
    } else if (invocation.kind === "finalized" && invocation.outcome === "failed") {
      const { outcome: _outcome, ...rest } = invocation;
      blocking.push({ ...rest, reason: "apply_failed" });
    }
  }
  // Persisted timestamp first, rollback id as the tie-break. ULIDs are ordered
  // only to the millisecond, so id order alone cannot support the claim that
  // the first blocker is the earliest.
  blocking.sort((a, b) =>
    a.writtenAt === b.writtenAt
      ? a.rollbackId.localeCompare(b.rollbackId)
      : a.writtenAt.localeCompare(b.writtenAt),
  );

  return { outcome: "readable", report: { invocations, blocking } };
}

// =============================================================================
// Publication outcome after a throw
// =============================================================================

/**
 * Exactly what was handed to `publishRollbackAttempt`.
 *
 * The inspection compares against THIS, not merely against a well-formed
 * marker. A rollback id collision or an artifact left by an earlier run could
 * otherwise be mistaken for the attempt that just threw, and "someone else's
 * marker" would be read as "mine, published".
 */
export interface PublicationBinding {
  readonly sessionId: string;
  readonly contributionSha256: string;
  readonly preRollbackCheckpointId: string;
  readonly selection: RollbackSelection;
}

export type PublicationInspection =
  /** A marker exists and describes exactly this attempt. */
  | {
      readonly outcome: "published";
      readonly rollbackDir: string;
      readonly attempt: RollbackAttempt;
    }
  /** No marker, so nothing was ever authorized to mutate. */
  | { readonly outcome: "not_published"; readonly rollbackDir: string }
  /** Something is there, and it cannot be shown to be this attempt's. */
  | {
      readonly outcome: "indeterminate";
      readonly rollbackDir: string;
      readonly path: string;
      readonly detail: string;
    };

/**
 * Decide whether a publication that THREW actually published.
 *
 * Runs under the same lock as the publication attempt, and inspects ONLY the
 * preallocated invocation. That is why the id is allocated by the caller: a
 * publication that throws before returning would otherwise leave nothing to
 * name, and "possibly published somewhere" is not a state a recovery tool can
 * act on.
 *
 * Fails closed in the same shape as the history scan. An unreadable or
 * unmatched marker is never read as absence, because "no mutation was
 * authorized" and "a mutation may have started" call for opposite responses.
 */
export async function inspectPublication(
  repoRoot: string,
  rollbackId: string,
  binding: PublicationBinding,
): Promise<PublicationInspection> {
  const rollbackDir = rollbackInvocationDir(repoRoot, binding.sessionId, rollbackId);
  const { attemptPath, receiptPath } = rollbackInvocationPaths(rollbackDir);

  let attemptRaw: string | null;
  let receiptRaw: string | null;
  try {
    attemptRaw = await readOptional(attemptPath);
    receiptRaw = await readOptional(receiptPath);
  } catch (err) {
    return { outcome: "indeterminate", rollbackDir, path: rollbackDir, detail: messageOf(err) };
  }

  if (receiptRaw !== null) {
    // Publication writes no receipt, so one here belongs to something else.
    // Reusing the directory would overwrite another invocation's record.
    return {
      outcome: "indeterminate",
      rollbackDir,
      path: receiptPath,
      detail: "a receipt already exists in the invocation this attempt was publishing",
    };
  }

  if (attemptRaw === null) {
    // An empty directory is still `never_authorized`: the marker precedes any
    // mutation, so without it nothing was authorized to run.
    return { outcome: "not_published", rollbackDir };
  }

  let attempt: RollbackAttempt;
  try {
    attempt = RollbackAttemptSchema.parse(JSON.parse(attemptRaw));
  } catch (err) {
    return { outcome: "indeterminate", rollbackDir, path: attemptPath, detail: messageOf(err) };
  }

  const mismatch = ((): string | null => {
    if (attempt.rollback_id !== rollbackId) return "rollback_id";
    if (attempt.session_id !== binding.sessionId) return "session_id";
    if (attempt.contribution_sha256 !== binding.contributionSha256) return "contribution_sha256";
    if (attempt.pre_rollback_checkpoint_id !== binding.preRollbackCheckpointId) {
      return "pre_rollback_checkpoint_id";
    }
    if (!selectionsEqual(attempt.selection, binding.selection)) return "selection";
    return null;
  })();
  if (mismatch !== null) {
    return {
      outcome: "indeterminate",
      rollbackDir,
      path: attemptPath,
      detail: `the marker's ${mismatch} does not match the attempt that was being published`,
    };
  }

  return { outcome: "published", rollbackDir, attempt };
}
