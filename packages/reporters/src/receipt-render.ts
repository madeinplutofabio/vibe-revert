// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// renderReceipt: per-format dispatcher for @viberevert/reporters'
// receipt-rendering surface (M D Step 5).
//
// Single entry point that selects between renderReceiptJson,
// renderReceiptTerminal, and renderReceiptMarkdown based on the
// requested format. Parallel to the M C report `render` dispatcher;
// the two coexist in the package because the input shapes differ
// (RenderInput vs ReceiptRenderInput) and forcing them through one
// dispatcher would require runtime input-shape discrimination that
// the TypeScript layer can't enforce.
//
// =============================================================================
// CONTRACT (D45)
// =============================================================================
//
// Public API: literal-format overloads give callers format-specific
// return-type narrowing:
//   - renderReceipt(input, "terminal") -> string
//   - renderReceipt(input, "markdown") -> string
//   - renderReceipt(input, "json")     -> unknown
//
// A union-typed `ReporterFormat` variable is also accepted and
// returns `unknown`; callers that need a string should narrow
// `format` before calling or switch on the format value.
//
// Why overloads instead of a single `string | unknown` signature:
// TypeScript collapses `string | unknown` to `unknown` (unknown
// absorbs all other types in a union), so a single union signature
// would give callers ZERO narrowing — `renderReceipt(input, "terminal")`
// would type as `unknown` and require a non-null `as string` cast.
// The literal overloads let TS pick the right return type per
// format literal at the call site, and the union overload makes
// the dispatcher usable with a variable-typed format.
//
// The IMPLEMENTATION signature is `unknown` (not D45's literal
// `string | unknown` wording) because TypeScript collapses those
// to the same type. Both `string` and `unknown` are assignable to
// `unknown`, so the implementation is structurally compatible with
// all four overloads.
//
// Exhaustiveness is enforced by TypeScript via the `never` default
// branch — if a new `ReporterFormat` variant is added without a
// corresponding case, TS errors at compile time. At runtime, the
// branch throws cleanly if reached via an invalid format value
// passed from untyped JS (defense-in-depth; should be unreachable
// in typed callers).
//
// All work delegates to the per-format receipt renderers; this
// module owns no formatting logic of its own. The three renderers
// share `ReceiptRenderInput` (file + productVersion); each consumes
// `productVersion` per its own contract (markdown uses it for the
// locked footer; terminal and json ignore it).
//
// =============================================================================
// Why a SEPARATE dispatcher (not extending the M C `render`)
// =============================================================================
//
// Reasons (per the receipt-types.ts header lock #A): the M C
// `render(input: RenderInput, format)` and this
// `renderReceipt(input: ReceiptRenderInput, format)` take
// DIFFERENT input shapes (RenderInput carries a `threshold` field
// + a `ReportFile` payload; ReceiptRenderInput omits threshold +
// carries a `ReceiptFile` payload). Merging into one dispatcher
// would require either a discriminated-union input or runtime
// shape-detection — both add complexity without removing call
// sites. The CLI's rollback command knows it has a receipt; the
// CLI's check command knows it has a report. The dispatchers
// stay parallel and explicit.

import { renderReceiptJson } from "./receipt-json.js";
import { renderReceiptMarkdown } from "./receipt-markdown.js";
import { renderReceiptTerminal } from "./receipt-terminal.js";
import type { ReceiptRenderInput } from "./receipt-types.js";
import type { ReporterFormat } from "./types.js";

/**
 * Dispatch to the per-format receipt renderer.
 *
 * Returns (per overload):
 *   - "terminal" → ANSI-free plain-text string (newline-terminated)
 *   - "markdown" → CommonMark string with locked footer
 *     (newline-terminated)
 *   - "json" → schema-verbatim `ReceiptFile` value (the input
 *     reference, returned unchanged)
 *   - ReporterFormat (variable) → unknown; caller narrows by
 *     switching on format or by narrowing before the call.
 *
 * Pure synchronous: no I/O, no Date.now(), no Math.random(),
 * no terminal writes.
 *
 * The caller (CLI) is responsible for serialization (for "json":
 * `JSON.stringify(value, null, 2) + "\n"`) and stdout emission per
 * the D29 boundary — reporters never write to terminal streams.
 */
export function renderReceipt(input: ReceiptRenderInput, format: "terminal"): string;
export function renderReceipt(input: ReceiptRenderInput, format: "markdown"): string;
export function renderReceipt(input: ReceiptRenderInput, format: "json"): unknown;
export function renderReceipt(input: ReceiptRenderInput, format: ReporterFormat): unknown;
export function renderReceipt(input: ReceiptRenderInput, format: ReporterFormat): unknown {
  switch (format) {
    case "json":
      return renderReceiptJson(input);
    case "terminal":
      return renderReceiptTerminal(input);
    case "markdown":
      return renderReceiptMarkdown(input);
    default: {
      // Compile-time exhaustiveness: TS narrows `format` to `never`
      // here when every ReporterFormat variant has a case. Adding a
      // new variant without a case fails to compile. The `String(...)`
      // call also handles the runtime case where an invalid value is
      // passed via untyped JS — gives a useful error message instead
      // of falling off the end and returning undefined.
      const exhaustive: never = format;
      throw new Error(`Unknown reporter format: ${String(exhaustive)}`);
    }
  }
}
