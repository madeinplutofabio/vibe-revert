// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4f: an ALWAYS-ON preflight for the real pty-loader contract that the
// live smoke depends on. It calls the REAL loadPtyModule() (no injected importer)
// and asserts the fail-closed contract: it resolves to either a module exposing
// `spawn` (node-pty available) or `null` (node-pty absent / failed to load), and
// never throws. This runs in EVERY environment -- including this box, where
// node-pty may be absent and the full live smoke skips -- so the loader contract
// is exercised even when the round-trip cannot run.
//
// Note: `null` is a valid loader outcome ONLY for this preflight contract. The
// public live smoke treats `null` as a failed prerequisite (skip before launch),
// never as a successful product path.

import { describe, expect, it } from "vitest";

import { loadPtyModule } from "../src/commands/pty-loader.js";

describe("loadPtyModule -- real loader preflight (M G4 Step 4f)", () => {
  it("resolves to a spawn-exposing module object or to null, and never throws", async () => {
    const mod = await loadPtyModule();
    if (mod !== null) {
      expect(typeof mod).toBe("object");
      expect(typeof mod.spawn).toBe("function");
    } else {
      expect(mod).toBeNull();
    }
  });
});
