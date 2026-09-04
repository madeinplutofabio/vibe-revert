// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Receipt finalization: the ONE serialization boundary.
//
// The mapped receipt is serialized exactly once, and those same bytes are what
// gets written AND what a rejection is reconciled against. Serializing twice
// would let a second render disagree with the first, and then "identical" would
// be a claim about a value rather than about the file.
//
// Formatting matches the legacy apply receipt: two-space JSON with a trailing
// newline. That is a persisted format, not a style choice, so it is stated here
// rather than inherited by accident.
//
// The receipt path comes from core's semantic helpers. This layer asks for an
// invocation's artifacts and never joins a directory with a filename, because
// the storage filenames are deliberately private to core.
//
// =============================================================================
// Reconciliation runs only after the writer REJECTS
// =============================================================================
//
// `writeFileExclusiveAtomic` suppresses a post-link cleanup failure and
// resolves, because at that point the receipt IS published. So arriving here
// means the destination was not created by this call, and the question is what
// is there instead:
//
//   already_identical  byte-identical AND schema-valid; another writer, or a
//                      retry of this one, already published this exact receipt
//   not_written        nothing is there (ENOENT)
//   conflicting        something else is there, or what is there will not parse
//   indeterminate      the destination could not be read at all
//
// `already_identical` requires BOTH byte identity and a successful parse. Byte
// identity alone would be enough today, since the bytes came from a receipt
// this process just validated. The parse guards the case where a future schema
// no longer accepts what an older writer stored, which is exactly when
// "identical" would otherwise be the most misleading answer available.

import { readFile } from "node:fs/promises";
import { rollbackInvocationDir, rollbackInvocationPaths } from "@viberevert/core";
import { SelectiveRollbackReceiptSchema } from "@viberevert/session-format";
import { writeFileExclusiveAtomic } from "./atomic.js";
import type { SelectiveApplyOutcome } from "./selective-apply-result.js";
import {
  type MapSelectiveReceiptArgs,
  mapSelectiveRollbackReceipt,
} from "./selective-receipt-mapper.js";
import type { VerifyCommandsResult } from "./verify-commands.js";

type Outcome = SelectiveApplyOutcome<VerifyCommandsResult>;

/** The two terminal arms finalization can reach. */
export type FinalizationOutcome = Extract<
  Outcome,
  { readonly kind: "finalized" | "finalization_failed" }
>;

export interface FinalizeSelectiveReceiptArgs extends MapSelectiveReceiptArgs {
  readonly repoRoot: string;
  /**
   * The PREALLOCATED invocation this apply is authorized to write into.
   *
   * Taken from the caller rather than from the attempt marker: the path is
   * where this invocation was authorized to write, which is a fact about the
   * allocation, while the marker's identities are facts about the operation.
   * The mapper separately binds the receipt's contents to the marker.
   */
  readonly sessionId: string;
  readonly rollbackId: string;
}

/** Two-space JSON with a trailing newline, matching the legacy apply receipt. */
const serialize = (receipt: unknown): string => `${JSON.stringify(receipt, null, 2)}\n`;

const isEnoent = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** Parses and validates, without letting a malformed file throw. */
function readsBackAsReceipt(text: string): boolean {
  try {
    return SelectiveRollbackReceiptSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/**
 * Map the receipt and publish it, returning the terminal outcome.
 *
 * A MAPPING failure touches the filesystem not at all: there is no intended
 * receipt to write, and creating nothing is the correct result.
 */
export async function finalizeSelectiveReceipt(
  args: FinalizeSelectiveReceiptArgs,
): Promise<FinalizationOutcome> {
  const { repoRoot, sessionId, rollbackId, source, recovery } = args;

  const mapping = mapSelectiveRollbackReceipt(args);
  if (mapping.outcome === "failed") {
    return {
      kind: "finalization_failed",
      source,
      recovery,
      failure: { phase: "map_receipt", cause: mapping.cause },
    };
  }

  const receipt = mapping.receipt;
  // ONE render. Reused for the write and for the comparison.
  const bytes = serialize(receipt);
  const { receiptPath } = rollbackInvocationPaths(
    rollbackInvocationDir(repoRoot, sessionId, rollbackId),
  );

  try {
    await writeFileExclusiveAtomic(receiptPath, bytes);
    return { kind: "finalized", source, recovery, receipt, how: "written" };
  } catch (cause) {
    /**
     * `cause` stays the WRITE rejection on every branch below, because that is
     * what stopped the finalization. A read failure on the `indeterminate`
     * branch explains why we could not tell what happened, but the failure
     * shape carries one cause and the write rejection is the primary one.
     */
    const failed = (
      reason: "not_written" | "conflicting" | "indeterminate",
    ): FinalizationOutcome => ({
      kind: "finalization_failed",
      source,
      recovery,
      failure: { phase: "write_receipt", reason, intendedReceipt: receipt, cause },
    });

    let onDisk: string;
    try {
      onDisk = await readFile(receiptPath, "utf8");
    } catch (readError) {
      return failed(isEnoent(readError) ? "not_written" : "indeterminate");
    }

    if (onDisk !== bytes) return failed("conflicting");
    // Identical bytes that will not parse are not a receipt, whatever they
    // match. Reporting `already_identical` would call unusable evidence
    // finalized.
    return readsBackAsReceipt(onDisk)
      ? { kind: "finalized", source, recovery, receipt, how: "already_identical" }
      : failed("conflicting");
  }
}
