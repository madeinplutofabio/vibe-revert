// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// renderSelectiveReceipt: per-format dispatcher for the selective rollback
// receipt, parallel to `renderReceipt`.
//
// A THIRD dispatcher rather than a branch inside an existing one, for the
// reason the second one already gives: the input shapes differ. `RenderInput`
// carries a report and a threshold, `ReceiptRenderInput` a whole-session
// receipt, and `SelectiveReceiptRenderInput` a selective receipt. Merging any
// two would need a discriminated input or a runtime shape probe, which puts a
// check into every renderer to recover what the call site already knew.
//
// The literal-format overloads exist so a caller gets a narrowed return type.
// A single `string | unknown` signature collapses to `unknown`, which would
// force an `as string` at every terminal and markdown call site.

import { renderSelectiveReceiptJson } from "./selective-receipt-json.js";
import { renderSelectiveReceiptMarkdown } from "./selective-receipt-markdown.js";
import { renderSelectiveReceiptTerminal } from "./selective-receipt-terminal.js";
import type { SelectiveReceiptRenderInput } from "./selective-receipt-types.js";
import type { ReporterFormat } from "./types.js";

/**
 * Dispatch to the per-format selective receipt renderer.
 *
 *   - "terminal" gives an ANSI-free plain-text string, newline-terminated
 *   - "markdown" gives CommonMark with the locked footer, newline-terminated
 *   - "json" gives the schema-verbatim receipt value, unchanged
 *
 * Pure and synchronous. The caller serializes the json value and owns every
 * stream write.
 */
export function renderSelectiveReceipt(
  input: SelectiveReceiptRenderInput,
  format: "terminal",
): string;
export function renderSelectiveReceipt(
  input: SelectiveReceiptRenderInput,
  format: "markdown",
): string;
export function renderSelectiveReceipt(input: SelectiveReceiptRenderInput, format: "json"): unknown;
export function renderSelectiveReceipt(
  input: SelectiveReceiptRenderInput,
  format: ReporterFormat,
): unknown;
export function renderSelectiveReceipt(
  input: SelectiveReceiptRenderInput,
  format: ReporterFormat,
): unknown {
  switch (format) {
    case "json":
      return renderSelectiveReceiptJson(input);
    case "terminal":
      return renderSelectiveReceiptTerminal(input);
    case "markdown":
      return renderSelectiveReceiptMarkdown(input);
    default: {
      // A new ReporterFormat without a case here fails to compile. The throw
      // covers an invalid value arriving from untyped JS.
      const exhaustive: never = format;
      throw new Error(`Unknown reporter format: ${String(exhaustive)}`);
    }
  }
}
