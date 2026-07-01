// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Per-adapter implementations -- the SINGLE SOURCE OF TRUTH for the
// adapter implementation list. Step 3 of M G1b landed cursor +
// direct-hook; Step 4 lands husky + lefthook; Step 5 adds claude /
// github-action HERE.
//
// Each adapter is a const conforming to the Adapter contract defined
// in ../types.ts (name + detect + plan). The package root barrel
// (../index.ts) re-exports from THIS module so consumers see one
// canonical adapter list; the root barrel's re-export line grows to
// match as new adapters land here, but the sub-barrel structure stays
// stable.

export { cursorAdapter } from "./cursor.js";
export { directHookAdapter } from "./direct-hook.js";
export { huskyAdapter } from "./husky.js";
export { lefthookAdapter } from "./lefthook.js";
