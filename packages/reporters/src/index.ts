// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/reporters.
//
// Per-format renderers (renderJson / renderMarkdown / renderTerminal),
// the unified `render` dispatcher, the `applyThreshold` filter
// helper, and the `RenderInput` / `ReporterFormat` types. Internal
// modules are not re-exported and may reorganize without a major
// version bump as long as this surface stays stable.

export { renderJson } from "./json.js";
export { renderMarkdown } from "./markdown.js";
export { render } from "./render.js";
export { renderTerminal } from "./terminal.js";
export { applyThreshold } from "./threshold.js";
export type { RenderInput, ReporterFormat } from "./types.js";
