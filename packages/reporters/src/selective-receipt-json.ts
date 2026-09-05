// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// renderSelectiveReceiptJson: the receipt, verbatim.
//
// Returns the `SelectiveRollbackReceipt` REFERENCE unchanged. No copy, no
// reordering, no added fields, and specifically NOT `productVersion`, which is
// rendering metadata for the markdown footer rather than a schema field.
//
// The verbatim rule is what lets the CLI assert that its rendered stdout and
// the persisted artifact are byte-identical, which the golden harness checks
// for every json-format fixture. A renderer that reshaped anything here would
// make the artifact and the wire output two different things that merely
// usually agree.
//
// Serialization belongs to the caller: reporters never writes to a stream, and
// the two-space-plus-newline form is the CLI's boundary concern.

import type { SelectiveReceiptRenderInput } from "./selective-receipt-types.js";

/**
 * Return the receipt as-is for the caller to serialize.
 *
 * Typed `unknown` rather than `SelectiveRollbackReceipt` to match the legacy
 * receipt's json renderer and the dispatcher's overloads: the value crosses
 * into `JSON.stringify` at the CLI seam, and narrowing it here would invite a
 * caller to read fields off a value whose only contract is "this is the
 * artifact".
 */
export function renderSelectiveReceiptJson(input: SelectiveReceiptRenderInput): unknown {
  return input.file;
}
