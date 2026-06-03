// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// renderReceiptJson: schema-verbatim JSON rendering of a ReceiptFile.
//
// =============================================================================
// CONTRACT (D45 + D38 + D54 + receipt-types.ts header lock)
// =============================================================================
//
// Returns the input `ReceiptFile` value untouched as a
// JSON-stringifiable shape. The schema's strict-object construction
// (per `ReceiptFileSchema`) guarantees the value is already
// serializable; `JSON.stringify`'s default `undefined`-omitting
// behavior produces the schema-verbatim view naturally (optional
// fields like `active_session_warning` / `un_ended_session_warning`
// remain absent rather than being rewritten to null per D38's
// persisted-artifact JSON exception).
//
// Unlike the M C report's `renderJson`, this function has no
// threshold-filter equivalent (per receipt-types.ts header lock #2 —
// receipts are exhaustive transactional records, not filterable
// finding sets). The signature accepts the full `ReceiptRenderInput`
// for symmetry with the other renderers, but `productVersion` is
// intentionally NOT included in the serialized output — adding
// rendering metadata to JSON would break the schema-verbatim
// contract and silently mutate the wire shape away from what
// `ReceiptFileSchema.parse` accepts.
//
// =============================================================================
// M C JSON EXCEPTION TO D20 carries forward (locked, schema-verbatim)
// =============================================================================
//
// Per D38's locked exception to D20's "null for missing fields" rule:
// persisted-artifact JSON is schema-verbatim, with optional fields
// OMITTED when absent — NOT rewritten to null. This applies to
// `ReceiptFile` JSON identically to `ReportFile` JSON. The CLI's
// projection outputs (e.g., `viberevert sessions --json`'s
// `task: null`) remain on D20's null-fill rule because those are
// CLI-synthesized display objects, not persisted-artifact JSON.

import type { ReceiptRenderInput } from "./receipt-types.js";

/**
 * Render a `ReceiptFile` as a JSON-stringifiable value, returning the
 * input `file` reference unchanged.
 *
 * The return type is declared `unknown` per the D45 lock — the caller
 * (CLI) treats this as opaque JSON-stringifiable data and passes it
 * directly to `JSON.stringify`. Internally the runtime shape is
 * always `ReceiptFile`, but the signature decouples consumers from
 * that detail (room to evolve the rendered view in the future
 * without a public-API breaking change).
 *
 * Pure synchronous: no I/O, no allocations, no Date.now(), no
 * Math.random(). Returns by reference; callers MUST NOT mutate the
 * returned value (the persisted on-disk ReceiptFile is the source
 * of truth and reporters never own a copy).
 *
 * The caller (CLI) is responsible for serialization
 * (`JSON.stringify(value, null, 2) + "\n"`) and stdout emission per
 * the D29 boundary — reporters never write to terminal streams.
 */
export function renderReceiptJson(input: ReceiptRenderInput): unknown {
  return input.file;
}
