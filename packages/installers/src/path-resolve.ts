// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Resolve a POSIX-style relative path under a repo root to an absolute
// path on the current platform per D101.D.
//
// Adapter PathSpecs persist `pathRelative` in POSIX form (always
// forward slashes) so integrations.json is portable across platforms.
// `path.join` on Windows JOINS with backslashes but PRESERVES forward
// slashes within passed-in segments, so we must split on "/" and pass
// the resulting segments as separate args to get platform-normalized
// output (e.g. ".cursor/mcp.json" → ".cursor\\mcp.json" on Windows).
// PathSpecSchema owns validation: POSIX separators only, repo-relative,
// no absolute paths, and no traversal. This helper assumes validated
// internal input and only performs platform path joining; no defensive
// runtime check is needed here.
//
// Structurally typed: accepts any `{ pathRelative }` and any
// `{ repoRoot }` so this module stays dep-free. The canonical PathSpec
// type lives in @viberevert/adapters/src/types.ts; consumers (engine
// etc.) import it from there and pass PathSpec values into resolvePath
// where the structural shape holds.

import { join } from "node:path";

/**
 * Resolve a POSIX `pathRelative` (forward slashes) under `repoRoot` to
 * an absolute path on the current platform.
 */
export function resolvePath(
  spec: { readonly pathRelative: string },
  ctx: { readonly repoRoot: string },
): string {
  return join(ctx.repoRoot, ...spec.pathRelative.split("/"));
}
