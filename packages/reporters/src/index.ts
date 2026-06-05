// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/reporters.
//
// Per-format renderers for two artifact surfaces plus a text-only
// renderer for the M E fix-prompt:
//   - M C reports: renderJson / renderMarkdown / renderTerminal,
//     unified by the `render` dispatcher. `applyThreshold` is the
//     output-filter helper that the three report renderers share.
//   - M D rollback receipts: renderReceiptJson /
//     renderReceiptMarkdown / renderReceiptTerminal, unified by
//     the `renderReceipt` dispatcher. No threshold helper —
//     receipts are exhaustive transactional records, not filterable
//     finding sets (per receipt-types.ts header lock #2).
//   - M E fix-prompts: `renderFixPrompt` — text-only, single
//     function, no dispatcher. The prompt is meant to be pasted
//     into a coding agent; format wrappers are deferred until a
//     real consumer (likely MCP `generate_fix_prompt`) needs them.
//
// Plus the `RenderInput` / `ReceiptRenderInput` / `FixPromptRenderInput`
// input shapes and the SHARED `ReporterFormat` union (one set of
// three format literals covers both the report and receipt
// dispatchers; the fix-prompt surface has no format dispatcher and
// does NOT participate in the union).
//
// Internal modules are not re-exported and may reorganize without
// a major version bump as long as this surface stays stable.
//
// Re-exports below are sorted purely alphabetically by SOURCE
// FILENAME (not value-vs-type), matching the M C barrel
// convention.

export { renderFixPrompt } from "./fix-prompt-render.js";
export type { FixPromptRenderInput } from "./fix-prompt-types.js";
export { renderJson } from "./json.js";
export { renderMarkdown } from "./markdown.js";
export { renderReceiptJson } from "./receipt-json.js";
export { renderReceiptMarkdown } from "./receipt-markdown.js";
export { renderReceipt } from "./receipt-render.js";
export { renderReceiptTerminal } from "./receipt-terminal.js";
export type { ReceiptRenderInput } from "./receipt-types.js";
export { render } from "./render.js";
export { renderTerminal } from "./terminal.js";
export { applyThreshold } from "./threshold.js";
export type { RenderInput, ReporterFormat } from "./types.js";
