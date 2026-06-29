// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Per-adapter implementations -- the SINGLE SOURCE OF TRUTH for the
// adapter implementation list. Step 3 of M G1b lands cursor +
// direct-hook; Steps 4 and 5 add husky/lefthook and claude/
// github-action HERE.
//
// Each adapter is a const conforming to the Adapter contract defined
// in ../types.ts (name + detect + plan). The package root barrel
// (../index.ts) re-exports from THIS module so consumers see one
// canonical adapter list; the root barrel stays stable as new
// adapters land in Steps 4 and 5.

export { cursorAdapter } from "./cursor.js";
export { directHookAdapter } from "./direct-hook.js";
