// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// render: per-format dispatcher for @viberevert/reporters.
//
// Single entry point that selects between renderJson, renderTerminal,
// and renderMarkdown based on the requested format.
//
// =============================================================================
// CONTRACT (D45)
// =============================================================================
//
// Public API: literal-format overloads give callers format-specific
// return-type narrowing:
//   - render(input, "terminal") -> string
//   - render(input, "markdown") -> string
//   - render(input, "json")     -> unknown
//
// A union-typed ReporterFormat variable is also accepted and returns
// unknown; callers that need a string should narrow format before
// calling or switch on the format.
//
// Why overloads instead of a single `string | unknown` signature:
// TypeScript collapses `string | unknown` to `unknown` (unknown
// absorbs all other types in a union), so a single union signature
// would give callers ZERO narrowing — `render(input, "terminal")`
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
// branch — if a new ReporterFormat variant is added without a
// corresponding case, TS errors at compile time. At runtime, the
// branch throws cleanly if reached via an invalid format value
// passed from untyped JS (defense-in-depth; should be unreachable
// in typed callers).
//
// All work delegates to the per-format renderers; this module owns
// no formatting logic of its own. Threshold filtering happens
// inside each renderer (each calls `applyThreshold` per D38).

import { renderJson } from "./json.js";
import { renderMarkdown } from "./markdown.js";
import { renderTerminal } from "./terminal.js";
import type { RenderInput, ReporterFormat } from "./types.js";

/**
 * Dispatch to the per-format renderer. Locked per D45.
 *
 * Returns (per overload):
 *   - "terminal" → ANSI-free plain-text string (newline-terminated)
 *   - "markdown" → CommonMark string with locked footer
 *     (newline-terminated)
 *   - "json" → schema-verbatim JSON-stringifiable value (or
 *     filtered view when input.threshold is set)
 *   - ReporterFormat (variable) → unknown; caller narrows by
 *     switching on format or by narrowing before the call.
 *
 * Pure synchronous: no I/O, no Date.now(), no Math.random().
 *
 * The caller (CLI) is responsible for serialization (for "json":
 * `JSON.stringify(value, null, 2) + "\n"`) and stdout emission per
 * the D29 boundary — reporters never write to terminal streams.
 */
export function render(input: RenderInput, format: "terminal"): string;
export function render(input: RenderInput, format: "markdown"): string;
export function render(input: RenderInput, format: "json"): unknown;
export function render(input: RenderInput, format: ReporterFormat): unknown;
export function render(input: RenderInput, format: ReporterFormat): unknown {
  switch (format) {
    case "json":
      return renderJson(input);
    case "terminal":
      return renderTerminal(input);
    case "markdown":
      return renderMarkdown(input);
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
